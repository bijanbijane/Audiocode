import http from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { PlatformControlPlaneService } from '../../platform/PlatformControlPlaneEngine';
import type { ApiCredentialScope, OrganizationRole } from '../../platform/PlatformContractsAndSchemas';
import { SpeechDataFactoryService } from '../../data-factory/SpeechDataFactoryService';
import { SpeechModelFactoryService } from '../../model-factory/SpeechModelFactoryService';
import { SpeechSecurityService } from '../SpeechSecurityService';
import { SpeechSecurityGateway } from '../SpeechSecurityGateway';
import { createSpeechSecurityHttpRouter } from '../SpeechSecurityHttpRouter';
import {
  PLATFORM_AUTHORIZATION_POLICIES,
  VALID_ORGANIZATION_ROLES,
  type SecurityOperationId,
} from '../AuthorizationPolicyEngine';

const ALL_SECURITY_SCOPES: ApiCredentialScope[] = [
  'audio:transcribe',
  'transcripts:read',
  'models:read',
  'security:read',
  'security:write',
  'security:audit',
  'security:admin',
  'privacy:write',
];

async function withHttpServer<T>(
  gw: SpeechSecurityGateway,
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(createSpeechSecurityHttpRouter(gw));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function createMemberBearer(params: {
  cp: PlatformControlPlaneService;
  orgId: string;
  projectId: string;
  userId: string;
  role: OrganizationRole;
  scopes?: ApiCredentialScope[];
  expiresAtIso?: string | null;
}): { bearer: string; credentialId: string; userId: string } {
  if (!params.cp.getUser(params.userId)) {
    params.cp.createUser({
      id: params.userId,
      email: `${params.userId}@avapardaz.local`,
      displayName: params.userId,
    });
  }
  params.cp.setOrganizationMembership({
    organizationId: params.orgId,
    userId: params.userId,
    role: params.role,
    membershipStatus: 'ACTIVE',
  });
  const issued = params.cp.issueApiKey({
    organizationId: params.orgId,
    projectId: params.projectId,
    principalId: params.userId,
    name: `key-${params.userId}-${params.role}`,
    scopes: params.scopes ?? ALL_SECURITY_SCOPES,
    expiresAtIso: params.expiresAtIso,
  });
  return {
    bearer: `Bearer ${issued.plaintextSecretOnce}`,
    credentialId: issued.credential.id,
    userId: params.userId,
  };
}

describe('Phase 14 Security Hardening — Adversarial Authorization, RBAC, Tenant Isolation & HTTP Routes', () => {
  it('1. Eliminates fail-open OWNER fallback & blocks role escalation across all roles and spoofed inputs', async () => {
    const cp = new PlatformControlPlaneService();
    const df = new SpeechDataFactoryService(cp);
    const mf = new SpeechModelFactoryService(cp, df);
    await mf.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
    const sec = new SpeechSecurityService(cp, df, mf);
    const gw = new SpeechSecurityGateway(sec);
    const orgId = 'org_avapardaz_sandbox';
    const projectId = cp.listProjects(orgId)[0].id;

    const viewer = createMemberBearer({ cp, orgId, projectId, userId: 'usr_viewer_1', role: 'VIEWER' });
    const analyst = createMemberBearer({ cp, orgId, projectId, userId: 'usr_analyst_1', role: 'ANALYST' });
    const billing = createMemberBearer({ cp, orgId, projectId, userId: 'usr_billing_1', role: 'BILLING_ADMIN' });
    const owner = createMemberBearer({ cp, orgId, projectId, userId: 'usr_studio_owner_01', role: 'OWNER' });

    // Missing role, invalid role, or client-spoofed OWNER/ADMIN must NEVER elevate VIEWER
    for (const spoof of [undefined, '', 'INVALID_ROLE', 'OWNER', 'ADMIN', 'SUPERADMIN']) {
      expect(
        gw.executeDeletion({ bearerToken: viewer.bearer, actorRole: spoof, recordingId: 'rec_1' }).status
      ).toBe(403);
      expect(
        gw.updateRetentionPolicy({
          bearerToken: viewer.bearer,
          actorRole: spoof,
          body: { rawAudioTtlDays: 10 },
        }).status
      ).toBe(403);
      expect(gw.runRedTeamSuite({ bearerToken: viewer.bearer, actorRole: spoof }).status).toBe(403);
      expect(gw.runRobustnessSuite({ bearerToken: viewer.bearer, actorRole: spoof }).status).toBe(403);
    }

    // ANALYST and BILLING_ADMIN cannot escalate by spoofing DEVELOPER/ADMIN/OWNER
    expect(gw.runRedTeamSuite({ bearerToken: analyst.bearer, actorRole: 'DEVELOPER' }).status).toBe(403);
    expect(gw.getAuditEvents(analyst.bearer).status).toBe(403);
    expect(gw.getThreatModel(billing.bearer).status).toBe(403);
    expect(gw.executeDeletion({ bearerToken: billing.bearer, actorRole: 'OWNER', recordingId: 'rec_1' }).status).toBe(403);

    // Real server-side OWNER succeeds even when omitting actorRole or passing a bogus actorRole
    const rtRes = gw.runRedTeamSuite({ bearerToken: owner.bearer });
    expect(rtRes.status).toBe(200);
    const groups = (rtRes.body as { groups: Array<{ status: string }> }).groups;
    expect(groups.length).toBe(7);
    expect(groups.every((g) => g.status === 'PASS')).toBe(true);
  });

  it('2. Table-driven RBAC enforcement across all 7 OrganizationRoles x all 10 security operations', async () => {
    const cp = new PlatformControlPlaneService();
    const df = new SpeechDataFactoryService(cp);
    const mf = new SpeechModelFactoryService(cp, df);
    const sec = new SpeechSecurityService(cp, df, mf);
    sec.maxHeavySecurityRunsPerMinutePerTenant = 100;
    const gw = new SpeechSecurityGateway(sec);
    const orgId = 'org_avapardaz_sandbox';
    const projectId = cp.listProjects(orgId)[0].id;

    const validWav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    ]).toString('base64');

    const invokeOp = (op: SecurityOperationId, bearer: string, idx: number): number => {
      switch (op) {
        case 'SECURITY_READ_THREAT_MODEL':
          return gw.getThreatModel(bearer).status;
        case 'SECURITY_INSPECT_AUDIO_UPLOAD':
          return gw.inspectUpload({
            bearerToken: bearer,
            body: { filename: 'ok.wav', base64Bytes: validWav, sampleRateHz: 16000, channels: 1, durationSeconds: 1 },
          }).status;
        case 'SECURITY_VALIDATE_REMOTE_URL':
          return gw.validateRemoteUrl({ bearerToken: bearer, url: 'https://media.avapardaz.ir/a.wav' }).status;
        case 'SECURITY_RUN_ROBUSTNESS_EVALUATION':
          return gw.runRobustnessSuite({ bearerToken: bearer, actorRole: 'OWNER' }).status;
        case 'SECURITY_EVALUATE_TRANSCRIPT_BOUNDARY':
          return gw.evaluateTranscriptBoundary({
            bearerToken: bearer,
            recordingId: `rec_tb_${idx}`,
            transcriptText: 'سلام دنیا',
          }).status;
        case 'SECURITY_CREATE_REDACTED_DERIVATIVE':
          return gw.createRedactedDerivative({
            bearerToken: bearer,
            body: { recordingId: `rec_red_${idx}`, originalTranscript: 'تماس 09123456789' },
          }).status;
        case 'SECURITY_UPDATE_RETENTION_POLICY':
          return gw.updateRetentionPolicy({
            bearerToken: bearer,
            actorRole: 'OWNER',
            body: { rawAudioTtlDays: 14 },
          }).status;
        case 'SECURITY_EXECUTE_DELETION_CASCADE':
          return gw.executeDeletion({
            bearerToken: bearer,
            actorRole: 'OWNER',
            recordingId: `rec_del_${idx}`,
          }).status;
        case 'SECURITY_RUN_RED_TEAM_SUITE':
          return gw.runRedTeamSuite({ bearerToken: bearer, actorRole: 'OWNER' }).status;
        case 'SECURITY_READ_AUDIT_EVENTS':
          return gw.getAuditEvents(bearer).status;
      }
    };

    const securityOps: SecurityOperationId[] = [
      'SECURITY_READ_THREAT_MODEL',
      'SECURITY_INSPECT_AUDIO_UPLOAD',
      'SECURITY_VALIDATE_REMOTE_URL',
      'SECURITY_RUN_ROBUSTNESS_EVALUATION',
      'SECURITY_EVALUATE_TRANSCRIPT_BOUNDARY',
      'SECURITY_CREATE_REDACTED_DERIVATIVE',
      'SECURITY_UPDATE_RETENTION_POLICY',
      'SECURITY_EXECUTE_DELETION_CASCADE',
      'SECURITY_RUN_RED_TEAM_SUITE',
      'SECURITY_READ_AUDIT_EVENTS',
    ];

    let idx = 0;
    for (const role of VALID_ORGANIZATION_ROLES) {
      const member = createMemberBearer({
        cp,
        orgId,
        projectId,
        userId: `usr_matrix_${role.toLowerCase()}`,
        role,
      });

      for (const op of securityOps) {
        idx++;
        const expectedAllowed = PLATFORM_AUTHORIZATION_POLICIES[op].allowedRoles.includes(role);
        const status = invokeOp(op, member.bearer, idx);
        if (expectedAllowed) {
          // validateRemoteUrl legitimately returns 403 from SSRF policy when remoteFetchEnabled=false;
          // distinguish SSRF decision body (`blockedReasonCode`) from RBAC error envelope (`error.code`)
          if (op === 'SECURITY_VALIDATE_REMOTE_URL' && status === 403) {
            const res = gw.validateRemoteUrl({ bearerToken: member.bearer, url: 'https://media.avapardaz.ir/a.wav' });
            expect((res.body as { blockedReasonCode?: string }).blockedReasonCode).toBe('REMOTE_FETCH_DISABLED');
          } else {
            expect([200, 201, 422]).toContain(status);
          }
        } else {
          expect(status).toBe(403);
        }
      }
    }
  });

  it('3. Enforces least-privilege credential scopes and authentication integrity (expired, revoked, disabled, ambiguous)', () => {
    const cp = new PlatformControlPlaneService();
    const sec = new SpeechSecurityService(cp);
    const gw = new SpeechSecurityGateway(sec);
    const orgId = 'org_avapardaz_sandbox';
    const projectId = cp.listProjects(orgId)[0].id;

    // OWNER credential with read-only scope CANNOT execute destructive/admin security ops
    const readOnlyOwner = createMemberBearer({
      cp,
      orgId,
      projectId,
      userId: 'usr_studio_owner_01',
      role: 'OWNER',
      scopes: ['models:read'],
    });
    expect(gw.getThreatModel(readOnlyOwner.bearer).status).toBe(200);
    expect(
      gw.updateRetentionPolicy({ bearerToken: readOnlyOwner.bearer, body: { rawAudioTtlDays: 5 } }).status
    ).toBe(403);
    expect(gw.executeDeletion({ bearerToken: readOnlyOwner.bearer, recordingId: 'rec_1' }).status).toBe(403);
    expect(gw.runRedTeamSuite({ bearerToken: readOnlyOwner.bearer }).status).toBe(403);
    expect(gw.getAuditEvents(readOnlyOwner.bearer).status).toBe(403);

    // Uniform existence-hiding 401 across missing, malformed, unknown ID, wrong secret, expired, revoked
    const missing = gw.getThreatModel('');
    const unknown = gw.getThreatModel('Bearer asr_test_deadbeef1234_wrongsecret');
    const expired = createMemberBearer({
      cp,
      orgId,
      projectId,
      userId: 'usr_exp_1',
      role: 'OWNER',
      expiresAtIso: new Date(Date.now() - 10_000).toISOString(),
    });
    const revoked = createMemberBearer({ cp, orgId, projectId, userId: 'usr_rev_1', role: 'OWNER' });
    cp.revokeApiKey({ credentialId: revoked.credentialId, organizationId: orgId });

    for (const resp of [missing, unknown, gw.getThreatModel(expired.bearer), gw.getThreatModel(revoked.bearer)]) {
      expect(resp.status).toBe(401);
      expect((resp.body as { error: { message: string } }).error.message).toBe('Authentication failed.');
    }

    // Disabled user, revoked membership, ambiguous duplicate active membership, suspended org -> fail closed 403
    const disabledMember = createMemberBearer({ cp, orgId, projectId, userId: 'usr_dis_1', role: 'OWNER' });
    cp.setUserAccountStatus('usr_dis_1', 'SUSPENDED');
    expect(gw.getThreatModel(disabledMember.bearer).status).toBe(403);

    const revokedMem = createMemberBearer({ cp, orgId, projectId, userId: 'usr_revmem_1', role: 'OWNER' });
    cp.revokeOrganizationMembership(orgId, 'usr_revmem_1');
    expect(gw.getThreatModel(revokedMem.bearer).status).toBe(403);

    const ambigMem = createMemberBearer({ cp, orgId, projectId, userId: 'usr_ambig_1', role: 'OWNER' });
    cp.appendOrganizationMembershipRecord({
      organizationId: orgId,
      userId: 'usr_ambig_1',
      role: 'VIEWER',
      membershipStatus: 'ACTIVE',
      createdAtIso: new Date().toISOString(),
    });
    expect(gw.getThreatModel(ambigMem.bearer).status).toBe(403);
  });

  it('4. Protects tenant boundaries, resource ownership, retention validation, and zero partial mutations over real HTTP', async () => {
    const cp = new PlatformControlPlaneService();
    const df = new SpeechDataFactoryService(cp);
    const mf = new SpeechModelFactoryService(cp, df);
    const sec = new SpeechSecurityService(cp, df, mf);
    const gw = new SpeechSecurityGateway(sec);

    const orgA = 'org_avapardaz_sandbox';
    const prjA = cp.listProjects(orgA)[0].id;
    const ownerA = createMemberBearer({ cp, orgId: orgA, projectId: prjA, userId: 'usr_studio_owner_01', role: 'OWNER' });
    const viewerA = createMemberBearer({ cp, orgId: orgA, projectId: prjA, userId: 'usr_viewer_http', role: 'VIEWER' });

    const orgB = cp.createOrganization({ name: 'Tenant B Corp', ownerUserId: 'usr_owner_b' });
    const prjB = cp.createProject({ organizationId: orgB.id, projectName: 'Tenant B Project', environment: 'DEVELOPMENT' });
    const ownerB = createMemberBearer({ cp, orgId: orgB.id, projectId: prjB.id, userId: 'usr_owner_b', role: 'OWNER' });

    await withHttpServer(gw, async (baseUrl) => {
      // Tenant A creates a redacted derivative for rec_tenant_a_secret
      const createA = await fetch(`${baseUrl}/v1/security/privacy/redact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: ownerA.bearer },
        body: JSON.stringify({
          recordingId: 'rec_tenant_a_secret',
          originalTranscript: 'شماره موبایل 09123456789 محرمانه',
        }),
      });
      expect(createA.status).toBe(201);
      expect(sec.privacyEngine.listRedactedDerivatives(orgA).length).toBe(1);

      // Tenant B tries to delete Tenant A's recording -> 403 & ZERO mutation to Tenant A derivatives
      const crossDel = await fetch(`${baseUrl}/v1/security/privacy/recordings/rec_tenant_a_secret`, {
        method: 'DELETE',
        headers: {
          authorization: ownerB.bearer,
          'x-avapardaz-role': 'OWNER',
        },
      });
      expect(crossDel.status).toBe(403);
      expect(sec.privacyEngine.listRedactedDerivatives(orgA).length).toBe(1);
      expect(sec.privacyEngine.listDeletionHistory(orgA).length).toBe(0);
      expect(sec.privacyEngine.listDeletionHistory(orgB.id).length).toBe(0);

      // Tenant B tries to spoof X-Tenant-Id: orgA on retention update -> 403 & Tenant A retention unchanged
      const beforePolicyA = sec.getRetentionPolicy(orgA);
      const crossRet = await fetch(`${baseUrl}/v1/security/privacy/retention`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: ownerB.bearer,
          'x-tenant-id': orgA,
          'x-avapardaz-role': 'OWNER',
        },
        body: JSON.stringify({ rawAudioTtlDays: 1 }),
      });
      expect(crossRet.status).toBe(403);
      expect(sec.getRetentionPolicy(orgA).rawAudioTtlDays).toBe(beforePolicyA.rawAudioTtlDays);

      // VIEWER sends spoofed X-Avapardaz-Role: OWNER over HTTP -> 403 & zero mutation
      const viewerSpoof = await fetch(`${baseUrl}/v1/security/privacy/retention`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: viewerA.bearer,
          'x-avapardaz-role': 'OWNER',
        },
        body: JSON.stringify({ rawAudioTtlDays: 2 }),
      });
      expect(viewerSpoof.status).toBe(403);
      expect(sec.getRetentionPolicy(orgA).rawAudioTtlDays).toBe(beforePolicyA.rawAudioTtlDays);

      // Retention hardening: reject unknown field, out-of-bounds number, float, and immutable author/timestamp override
      for (const badPayload of [
        { rawAudioTtlDays: 10, unknownField: true },
        { rawAudioTtlDays: -5 },
        { rawAudioTtlDays: 99999 },
        { rawAudioTtlDays: 12.5 },
        { securityLogsTtlDays: 3 },
        { rawAudioTtlDays: 10, updatedBy: 'spoofed_actor' },
        { rawAudioTtlDays: 10, updatedAtIso: '1999-01-01T00:00:00.000Z' },
      ]) {
        const res = await fetch(`${baseUrl}/v1/security/privacy/retention`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: ownerA.bearer },
          body: JSON.stringify(badPayload),
        });
        expect(res.status).toBe(400);
        expect(sec.getRetentionPolicy(orgA).rawAudioTtlDays).toBe(beforePolicyA.rawAudioTtlDays);
      }

      // Valid retention update by OWNER succeeds and records server-side principalId
      const okRet = await fetch(`${baseUrl}/v1/security/privacy/retention`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: ownerA.bearer },
        body: JSON.stringify({ rawAudioTtlDays: 21, securityLogsTtlDays: 90 }),
      });
      expect(okRet.status).toBe(200);
      const updatedPol = (await okRet.json()) as { tenantId: string; updatedBy: string; rawAudioTtlDays: number };
      expect(updatedPol.tenantId).toBe(orgA);
      expect(updatedPol.updatedBy).toBe('usr_studio_owner_01');
      expect(updatedPol.rawAudioTtlDays).toBe(21);

      // Audit events are strictly tenant-scoped and never contain bearer tokens
      const auditA = await fetch(`${baseUrl}/v1/security/audit-events`, {
        headers: { authorization: ownerA.bearer },
      });
      expect(auditA.status).toBe(200);
      const auditJsonA = JSON.stringify(await auditA.json());
      expect(auditJsonA).not.toContain(ownerA.bearer.replace('Bearer ', ''));
      expect(auditJsonA).not.toContain(orgB.id);

      // Robustness invalid modelVersionId path traversal rejected 400
      const badRob = await fetch(`${baseUrl}/v1/security/robustness/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: ownerA.bearer },
        body: JSON.stringify({ modelVersionId: '../../etc/passwd' }),
      });
      expect(badRob.status).toBe(400);
    });
  });
});
