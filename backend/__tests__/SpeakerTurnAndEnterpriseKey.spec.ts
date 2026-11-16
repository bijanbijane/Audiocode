/**
 * @file backend/__tests__/SpeakerTurnAndEnterpriseKey.spec.ts
 * @description Section 139: Automated Verification for SpeakerTurnBoundaryWordAligner,
 *              EnterpriseApiKeyAndQuotaManager, and AsrWorkerSupervisorAndWatchdog.
 */

import { describe, it, expect } from 'vitest';
import { SpeakerTurnBoundaryWordAligner } from '../../src/ai-engine/asr/SpeakerTurnBoundaryWordAligner';
import { EnterpriseApiKeyAndQuotaManager } from '../src/auth/EnterpriseApiKeyAndQuotaManager';
import { AsrWorkerSupervisorAndWatchdog } from '../src/asr-worker/AsrWorkerSupervisorAndWatchdog';
import { PersianTextNormalizer } from '../../src/ai-engine/PersianTextNormalizer';
import { SpeakerTimelineSegment } from '../../src/ai-engine/MultiSpeakerDiarizationAndCrosstalkEngine';
import { PgPoolLike } from '../src/PlatformBackendServices';
import { TimeMath } from '../../src/contracts/timebase.contract';

describe('Speaker Turn Alignment, Enterprise API Quota & Watchdog Supervisor Suite (Sections 137–139)', () => {
  it('1. SpeakerTurnBoundaryWordAligner splits speaker turns cleanly by overlap ratio and ignores crosstalk bleed', () => {
    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      {
        id: '1',
        text: 'سلام',
        range: { start: 0, end: TimeMath.secondsToFlicks(0.4) },
        confidence: 0.95,
      },
      // Word "بفرمایید" overlaps 75% with SPEAKER_1 and 25% with SPEAKER_2 -> stays in SPEAKER_1's turn!
      {
        id: '2',
        text: 'بفرمایید',
        range: {
          start: TimeMath.secondsToFlicks(0.5),
          end: TimeMath.secondsToFlicks(0.9),
        },
        confidence: 0.93,
      },
      {
        id: '3',
        text: 'ممنونم',
        range: {
          start: TimeMath.secondsToFlicks(1.0),
          end: TimeMath.secondsToFlicks(1.5),
        },
        confidence: 0.96,
      },
    ]);

    const diarizationSegments: SpeakerTimelineSegment[] = [
      {
        segmentId: 's1',
        trackId: 'trk1',
        speakerId: 'SPEAKER_1',
        classification: 'PRIMARY_SPEECH',
        range: { start: 0, end: TimeMath.secondsToFlicks(0.8) },
        confidence: 0.95,
        manuallyVerifiedByUser: false,
      },
      // Microphone bleed that must never hijack word attribution
      {
        segmentId: 'bleed_ignore',
        trackId: 'trk2',
        speakerId: 'SPEAKER_2',
        classification: 'CROSSTALK_MIC_BLEED',
        range: { start: 0, end: TimeMath.secondsToFlicks(0.8) },
        confidence: 0.9,
        manuallyVerifiedByUser: false,
      },
      {
        segmentId: 's2',
        trackId: 'trk1',
        speakerId: 'SPEAKER_2',
        classification: 'PRIMARY_SPEECH',
        range: {
          start: TimeMath.secondsToFlicks(0.8),
          end: TimeMath.secondsToFlicks(1.6),
        },
        confidence: 0.95,
        manuallyVerifiedByUser: false,
      },
    ];

    const { turns } = SpeakerTurnBoundaryWordAligner.alignTokensToSpeakerTurns(
      tokens,
      diarizationSegments,
    );

    expect(turns).toHaveLength(2);
    expect(turns[0].speakerId).toBe('SPEAKER_1');
    expect(turns[0].turnDisplayTextFa).toBe('سلام بفرمایید');
    expect(turns[1].speakerId).toBe('SPEAKER_2');
    expect(turns[1].turnDisplayTextFa).toBe('ممنونم');
  });

  it('2. EnterpriseApiKeyAndQuotaManager hashes keys with SHA-256, checks scopes, and enforces atomic PostgreSQL quota', async () => {
    let storedHash = '';
    let usedSec = 0;
    const limitSec = 100;

    const mockDb: PgPoolLike = {
      async query(sql, params = []) {
        if (sql.includes('INSERT INTO enterprise_api_keys')) {
          storedHash = params[2] as string;
          return { rows: [{ key_id: 'key_uuid_1' }] as any, rowCount: 1 };
        }
        if (sql.includes('SELECT key_id, organization_id')) {
          if (params[0] !== storedHash) return { rows: [], rowCount: 0 };
          return {
            rows: [
              {
                key_id: 'key_uuid_1',
                organization_id: 'org_1',
                scopes: ['MODELS_READ', 'EXTERNAL_GATEWAY'],
                monthly_audio_seconds_limit: String(limitSec),
                monthly_audio_seconds_used: String(usedSec),
                revoked: false,
                expires_at: null,
              },
            ] as any,
            rowCount: 1,
          };
        }
        if (sql.includes('UPDATE enterprise_api_keys')) {
          const delta = params[1] as number;
          if (usedSec + delta > limitSec) return { rows: [], rowCount: 0 };
          usedSec += delta;
          return {
            rows: [
              {
                monthly_audio_seconds_used: String(usedSec),
                monthly_audio_seconds_limit: String(limitSec),
              },
            ] as any,
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const mgr = new EnterpriseApiKeyAndQuotaManager(mockDb);
    const issued = await mgr.issueNewEnterpriseApiKey({
      organizationId: 'org_1',
      scopes: ['MODELS_READ', 'EXTERNAL_GATEWAY'],
      monthlyAudioSecondsLimit: 100,
    });

    expect(issued.plaintextApiKeyOnce.startsWith('paudio_live_')).toBe(true);
    expect(storedHash).toHaveLength(64); // SHA-256 hex stored in DB, never plaintext

    const verified = await mgr.authenticateAndAuthorizeScope(
      issued.plaintextApiKeyOnce,
      'EXTERNAL_GATEWAY',
    );
    expect(verified.remainingAudioSeconds).toBe(100);

    // Unauthorized scope check
    await expect(
      mgr.authenticateAndAuthorizeScope(
        issued.plaintextApiKeyOnce,
        'CLOUD_ASR_ENTERPRISE',
      ),
    ).rejects.toThrow('ENTERPRISE_KEY_FORBIDDEN_SCOPE');

    // Atomic quota consumption: 60s succeeds, subsequent 50s (total 110 > 100) is rejected
    const q1 = await mgr.consumeAudioQuotaAtomically('key_uuid_1', 60);
    expect(q1.approved).toBe(true);
    expect(q1.remainingSeconds).toBe(40);

    const q2 = await mgr.consumeAudioQuotaAtomically('key_uuid_1', 50);
    expect(q2.approved).toBe(false);
  });

  it('3. AsrWorkerSupervisorAndWatchdog aborts hung inference jobs exceeding heartbeat or RSS memory limits', async () => {
    const supervisor = new AsrWorkerSupervisorAndWatchdog({
      maxExecutionTimeoutMs: 5000,
      heartbeatIntervalMs: 120,
      maxWorkerRssMb: 512,
    });

    await expect(
      supervisor.runSupervisedInferenceJob({
        jobId: 'hung_job_1',
        executeFn: async ({ abortSignal }) => {
          await new Promise((_resolve, reject) => {
            abortSignal.addEventListener('abort', () =>
              reject(new Error('ABORTED')),
            );
          });
        },
        readCurrentRssMbFn: () => 200,
      }),
    ).rejects.toThrow('WATCHDOG_HEARTBEAT_LOST');
  });
});
