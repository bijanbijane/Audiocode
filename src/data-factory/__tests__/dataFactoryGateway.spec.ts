import { describe, expect, it } from 'vitest';
import { PlatformControlPlaneService } from '../../platform/PlatformControlPlaneEngine';
import { DataFactoryGateway } from '../DataFactoryGateway';
import { encodePcm16WavBuffer } from '../AudioIngestionAndProfilingEngine';

function buildToneWavBase64(freq = 200): string {
  const sr = 16000;
  const pcm = new Float32Array(sr).map((_, i) => 0.25 * Math.sin((2 * Math.PI * freq * i) / sr));
  return encodePcm16WavBuffer([pcm], sr).toString('base64');
}

describe('Phase 12 DataFactoryGateway HTTP Contracts', () => {
  it('enforces Bearer authentication (401) and cross-tenant isolation (403)', async () => {
    const cp = new PlatformControlPlaneService();
    const gw = new DataFactoryGateway(cp);
    const issuedA = cp.issueApiKey({
      organizationId: 'org_avapardaz_sandbox',
      projectId: 'prj_avapardaz_dev_01',
      name: 'df-key-a',
      scopes: ['audio:transcribe', 'models:read'],
    });
    const orgB = cp.createOrganization({ name: 'Tenant B DF', defaultRegionId: 'ir-thr-01' });
    const prjB = cp.createProject({ organizationId: orgB.id, projectName: 'Proj B', environment: 'DEVELOPMENT' });
    const issuedB = cp.issueApiKey({
      organizationId: orgB.id,
      projectId: prjB.id,
      name: 'df-key-b',
      scopes: ['audio:transcribe', 'models:read'],
    });

    const unauth = gw.listDataSources('Bearer invalid');
    expect(unauth.status).toBe(401);

    const srcA = gw.createDataSource({
      bearerToken: `Bearer ${issuedA.plaintextSecretOnce}`,
      body: { sourceType: 'ORGANIZATION_CONTROLLED_RECORDING', sourceName: 'gw_src', verified: true },
    });
    expect(srcA.status).toBe(201);
    const sourceId = (srcA.body as { sourceId: string }).sourceId;

    const ing = await gw.ingestRecording({
      bearerToken: `Bearer ${issuedA.plaintextSecretOnce}`,
      body: {
        sourceId,
        filename: 'gw_test.wav',
        audioBase64: buildToneWavBase64(220),
        speakerRef: 'SPK_GW_1',
        sessionRef: 'SES_GW_1',
        rightsVerified: true,
        permissions: { transcribe: true, storeAudio: true, retainTranscripts: true, research: true, trainModels: true },
        evaluationAllowed: true,
      },
    });
    expect(ing.status).toBe(201);
    const recId = (ing.body as { recording: { recordingId: string } }).recording.recordingId;

    // Cross-tenant access denied (403)
    const crossRead = gw.getRecording(`Bearer ${issuedB.plaintextSecretOnce}`, recId);
    expect(crossRead.status).toBe(403);

    const dash = gw.getDashboard(`Bearer ${issuedA.plaintextSecretOnce}`);
    expect(dash.status).toBe(200);
  });
});
