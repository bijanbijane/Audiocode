import { describe, expect, it } from 'vitest';
import { PlatformControlPlaneService } from '../../platform/PlatformControlPlaneEngine';
import { SpeechDataFactoryService } from '../../data-factory/SpeechDataFactoryService';
import { SpeechModelFactoryService } from '../../model-factory/SpeechModelFactoryService';
import { SpeechSecurityService } from '../SpeechSecurityService';
import { SpeechSecurityGateway } from '../SpeechSecurityGateway';

describe('Phase 14 SpeechSecurityGateway HTTP & RBAC Enforcement', () => {
  it('enforces Bearer 401, VIEWER RBAC blocking on red-team/deletion/retention, and Red Team Groups A–G pass', async () => {
    const cp = new PlatformControlPlaneService();
    const df = new SpeechDataFactoryService(cp);
    const mf = new SpeechModelFactoryService(cp, df);
    await mf.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
    const sec = new SpeechSecurityService(cp, df, mf);
    const gw = new SpeechSecurityGateway(sec);

    const overview = cp.getPortalOverview('org_avapardaz_sandbox');
    const issued = cp.issueApiKey({
      organizationId: 'org_avapardaz_sandbox',
      projectId: overview.projects[0].id,
      name: 'phase14-sec-test',
      scopes: ['audio:transcribe', 'models:read'],
      actorUserId: 'usr_studio_owner_01',
    });
    const authHeader = `Bearer ${issued.plaintextSecretOnce}`;

    // Unauthenticated rejected 401
    expect(gw.getThreatModel('').status).toBe(401);

    // VIEWER role blocked on destructive deletion & retention & red-team
    expect(
      gw.executeDeletion({ bearerToken: authHeader, actorRole: 'VIEWER', recordingId: 'rec_1' }).status
    ).toBe(403);
    expect(
      gw.updateRetentionPolicy({ bearerToken: authHeader, actorRole: 'VIEWER', body: { rawAudioTtlDays: 7 } }).status
    ).toBe(403);
    expect(gw.runRedTeamSuite({ bearerToken: authHeader, actorRole: 'VIEWER' }).status).toBe(403);

    // Authenticated OWNER executes Red Team suite cleanly
    const rtRes = gw.runRedTeamSuite({ bearerToken: authHeader, actorRole: 'OWNER' });
    expect(rtRes.status).toBe(200);
    const body = rtRes.body as { groups: Array<{ status: string }> };
    expect(body.groups.length).toBe(7);
    expect(body.groups.every((g) => g.status === 'PASS')).toBe(true);

    // Malformed WAV upload blocked 422
    const badWav = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\x00\x00').toString('base64');
    expect(
      gw.inspectUpload({
        bearerToken: authHeader,
        body: { filename: '../../evil.wav', base64Bytes: badWav, sampleRateHz: 16000, channels: 1, durationSeconds: 2 },
      }).status
    ).toBe(422);

    // SSRF metadata blocked 403
    expect(gw.validateRemoteUrl({ bearerToken: authHeader, url: 'http://169.254.169.254/latest/meta-data/' }).status).toBe(
      403
    );
  });
});
