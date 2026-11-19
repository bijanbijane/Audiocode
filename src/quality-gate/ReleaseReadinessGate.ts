import { parseWaveContainerBytes } from '../audio-renderer/AudioRenderValidator';
import { AUDIO_RENDERER_VERSION } from '../audio-renderer/AudioRenderTypes';
import { EDIT_DECISION_ENGINE_VERSION } from '../ai-engine/edit-decision/EditDecisionTypes';
import { SPEECH_EVENT_ENGINE_VERSION } from '../ai-engine/speech-events/SpeechEventContracts';
import { AVAPARDAZ_MEMORY_POLICY } from '../runtime/memory/MemoryPolicy';
import { LOCAL_PRIVACY_POLICY_VERSION } from '../security/LocalPrivacyPolicy';

export type ReleaseGateStatus =
  | 'PASS'
  | 'FAIL'
  | 'NOT_EVALUATED'
  | 'INSUFFICIENT_DATA'
  | 'BLOCKED';

export type MandatoryReleaseGateKey =
  | 'BUILD_INTEGRITY'
  | 'TEST_INTEGRITY'
  | 'REAL_LOCAL_ASR_AVAILABILITY'
  | 'MODEL_INTEGRITY'
  | 'OFFLINE_OPERATION'
  | 'PRIVACY_GUARANTEES'
  | 'PERSIAN_TRANSCRIPT_INTEGRITY'
  | 'ALIGNMENT_INTEGRITY'
  | 'SPEECH_EVENT_DETECTION'
  | 'EDL_CORRECTNESS'
  | 'RENDERING_CORRECTNESS'
  | 'EXPORT_CORRECTNESS'
  | 'MEMORY_POLICY'
  | 'CRASH_RECOVERY'
  | 'SECURITY'
  | 'ACCESSIBILITY'
  | 'PERFORMANCE_QUALIFICATION';

export interface ReleaseGateEvidence {
  readonly gate: MandatoryReleaseGateKey;
  readonly mandatory: boolean;
  readonly status: ReleaseGateStatus;
  readonly summary: string;
  readonly details: readonly string[];
  readonly blockerReason?: string;
}

export interface HardwareAndRuntimeRecord {
  readonly runtime: string;
  readonly platform: string;
  readonly cpuCores: number | null;
  readonly totalSystemMemoryBytes: number | null;
  readonly softwareVersions: {
    readonly speechEventEngine: string;
    readonly editDecisionEngine: string;
    readonly audioRenderer: string;
    readonly privacyPolicy: string;
  };
}

export interface ReleaseReadinessReport {
  readonly reportId: string;
  readonly generatedAtIso: string;
  readonly technicallyBuildable: boolean;
  readonly productionReady: boolean;
  readonly overallDecision: 'APPROVED_FOR_RELEASE' | 'NOT_READY_BLOCKED' | 'NOT_READY_FAILED';
  readonly passedGateCount: number;
  readonly failedGateCount: number;
  readonly notEvaluatedGateCount: number;
  readonly blockedGateCount: number;
  readonly environment: HardwareAndRuntimeRecord;
  readonly memoryPolicySnapshot: typeof AVAPARDAZ_MEMORY_POLICY;
  readonly gates: readonly ReleaseGateEvidence[];
  readonly productionBlockers: readonly string[];
}

export interface ObjectiveAudioSignalReport {
  readonly valid: boolean;
  readonly container: 'wav' | 'rf64' | null;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly sampleCountPerChannel: number;
  readonly durationSec: number;
  readonly peakAmplitude: number;
  readonly dcOffset: number;
  readonly maxSampleDelta: number;
  readonly abruptDiscontinuityCount: number;
  readonly clippedSampleCount: number;
  readonly nonFiniteSampleCount: number;
  readonly allZeroSilence: boolean;
  readonly issues: readonly string[];
  readonly subjectiveNaturalnessEvaluated: false;
  readonly note: string;
}

/**
 * Independently evaluates rendered WAV/RF64 audio bytes for objective signal quality
 * (AVP-P08-001 Section 7). Never claims subjective naturalness from waveform metrics.
 */
export function evaluateRenderedAudioSignalQuality(params: {
  readonly bytes: Uint8Array;
  readonly expectedSampleRate: number;
  readonly expectedChannelCount: number;
  readonly expectedSamplesPerChannel: number;
  readonly sampleTolerance?: number;
}): ObjectiveAudioSignalReport {
  const parsed = parseWaveContainerBytes(params.bytes);
  const issues: string[] = [];

  if (!parsed.valid || !parsed.encoding) {
    return {
      valid: false,
      container: parsed.container,
      sampleRate: parsed.sampleRate,
      channelCount: parsed.channelCount,
      sampleCountPerChannel: parsed.sampleCountPerChannel,
      durationSec: 0,
      peakAmplitude: 0,
      dcOffset: 0,
      maxSampleDelta: 0,
      abruptDiscontinuityCount: 0,
      clippedSampleCount: 0,
      nonFiniteSampleCount: 0,
      allZeroSilence: true,
      issues: [parsed.error ?? 'Container header invalid.'],
      subjectiveNaturalnessEvaluated: false,
      note: 'Objective signal check only; human listening validation is tracked separately.',
    };
  }

  if (parsed.sampleRate !== params.expectedSampleRate) {
    issues.push(`Sample rate mismatch: actual=${parsed.sampleRate}, expected=${params.expectedSampleRate}.`);
  }
  if (parsed.channelCount !== params.expectedChannelCount) {
    issues.push(`Channel count mismatch: actual=${parsed.channelCount}, expected=${params.expectedChannelCount}.`);
  }
  const tol = params.sampleTolerance ?? 0;
  if (Math.abs(parsed.sampleCountPerChannel - params.expectedSamplesPerChannel) > tol) {
    issues.push(
      `Sample count mismatch: actual=${parsed.sampleCountPerChannel}, expected=${params.expectedSamplesPerChannel}.`,
    );
  }

  const view = new DataView(
    params.bytes.buffer,
    params.bytes.byteOffset + parsed.dataOffsetBytes,
    parsed.dataByteLength,
  );
  const bytesPerSample = parsed.bitsPerSample / 8;
  const totalFrames = parsed.sampleCountPerChannel;

  let peakAmplitude = 0;
  let sumCh0 = 0;
  let prevCh0 = 0;
  let maxSampleDelta = 0;
  let abruptDiscontinuityCount = 0;
  let clippedSampleCount = 0;
  let nonFiniteSampleCount = 0;
  let nonZeroCount = 0;

  for (let frame = 0; frame < totalFrames; frame++) {
    for (let ch = 0; ch < parsed.channelCount; ch++) {
      const byteOff = (frame * parsed.channelCount + ch) * bytesPerSample;
      let sample = 0;
      if (parsed.encoding === 'pcm16') {
        sample = view.getInt16(byteOff, true) / 32768;
      } else if (parsed.encoding === 'pcm24') {
        const b0 = params.bytes[parsed.dataOffsetBytes + byteOff];
        const b1 = params.bytes[parsed.dataOffsetBytes + byteOff + 1];
        const b2 = params.bytes[parsed.dataOffsetBytes + byteOff + 2];
        let val = b0 | (b1 << 8) | (b2 << 16);
        if (val & 0x800000) val |= ~0xffffff;
        sample = val / 8388608;
      } else {
        sample = view.getFloat32(byteOff, true);
      }

      if (!Number.isFinite(sample)) {
        nonFiniteSampleCount++;
        continue;
      }
      const abs = Math.abs(sample);
      if (abs > peakAmplitude) peakAmplitude = abs;
      if (abs > 1.0) clippedSampleCount++;
      if (abs > 1e-6) nonZeroCount++;

      if (ch === 0) {
        sumCh0 += sample;
        if (frame > 0) {
          const delta = Math.abs(sample - prevCh0);
          if (delta > maxSampleDelta) maxSampleDelta = delta;
          if (delta > 0.75) abruptDiscontinuityCount++;
        }
        prevCh0 = sample;
      }
    }
  }

  const dcOffset = totalFrames > 0 ? Math.abs(sumCh0 / totalFrames) : 0;
  const allZeroSilence = nonZeroCount === 0;

  if (nonFiniteSampleCount > 0) {
    issues.push(`Detected ${nonFiniteSampleCount} non-finite PCM sample(s).`);
  }
  if (clippedSampleCount > 0) {
    issues.push(`Detected ${clippedSampleCount} clipped sample(s) exceeding full scale.`);
  }
  if (dcOffset > 0.05) {
    issues.push(`Excessive DC offset detected (${dcOffset.toFixed(4)}).`);
  }
  if (abruptDiscontinuityCount > 0) {
    issues.push(`Detected ${abruptDiscontinuityCount} abrupt sample discontinuity spike(s) > 0.75.`);
  }

  return {
    valid: issues.length === 0,
    container: parsed.container,
    sampleRate: parsed.sampleRate,
    channelCount: parsed.channelCount,
    sampleCountPerChannel: parsed.sampleCountPerChannel,
    durationSec:
      parsed.sampleRate > 0 ? Number((parsed.sampleCountPerChannel / parsed.sampleRate).toFixed(6)) : 0,
    peakAmplitude: Number(peakAmplitude.toFixed(6)),
    dcOffset: Number(dcOffset.toFixed(6)),
    maxSampleDelta: Number(maxSampleDelta.toFixed(6)),
    abruptDiscontinuityCount,
    clippedSampleCount,
    nonFiniteSampleCount,
    allZeroSilence,
    issues,
    subjectiveNaturalnessEvaluated: false,
    note: 'Objective signal integrity metrics only; subjective listening naturalness requires separate human evaluation.',
  };
}

/**
 * Compiles a truthful, machine-readable ReleaseReadinessReport (AVP-P08-001 Section 13 & 15).
 * Never reports productionReady=true if ANY mandatory gate is FAIL, BLOCKED, NOT_EVALUATED, or INSUFFICIENT_DATA.
 */
export function buildReleaseReadinessReport(params: {
  readonly gates: readonly ReleaseGateEvidence[];
  readonly environment?: Partial<HardwareAndRuntimeRecord>;
  readonly nowIso?: string;
}): ReleaseReadinessReport {
  const gates = params.gates;
  const passedGateCount = gates.filter((g) => g.status === 'PASS').length;
  const failedGateCount = gates.filter((g) => g.status === 'FAIL').length;
  const notEvaluatedGateCount = gates.filter(
    (g) => g.status === 'NOT_EVALUATED' || g.status === 'INSUFFICIENT_DATA',
  ).length;
  const blockedGateCount = gates.filter((g) => g.status === 'BLOCKED').length;

  const buildGate = gates.find((g) => g.gate === 'BUILD_INTEGRITY');
  const testGate = gates.find((g) => g.gate === 'TEST_INTEGRITY');
  const technicallyBuildable = buildGate?.status === 'PASS' && testGate?.status !== 'FAIL';

  const mandatoryFailed = gates.filter((g) => g.mandatory && g.status === 'FAIL');
  const mandatoryIncomplete = gates.filter(
    (g) => g.mandatory && g.status !== 'PASS' && g.status !== 'FAIL',
  );

  const productionReady = mandatoryFailed.length === 0 && mandatoryIncomplete.length === 0 && gates.length > 0;

  let overallDecision: ReleaseReadinessReport['overallDecision'] = 'APPROVED_FOR_RELEASE';
  if (mandatoryFailed.length > 0) {
    overallDecision = 'NOT_READY_FAILED';
  } else if (mandatoryIncomplete.length > 0 || gates.length === 0) {
    overallDecision = 'NOT_READY_BLOCKED';
  }

  const productionBlockers = gates
    .filter((g) => g.mandatory && g.status !== 'PASS')
    .map((g) => `[${g.gate}:${g.status}] ${g.blockerReason ?? g.summary}`);

  const generatedAtIso = params.nowIso ?? new Date().toISOString();

  return Object.freeze({
    reportId: `avp_release_${generatedAtIso.replace(/[^0-9]/g, '').slice(0, 14)}`,
    generatedAtIso,
    technicallyBuildable,
    productionReady,
    overallDecision,
    passedGateCount,
    failedGateCount,
    notEvaluatedGateCount,
    blockedGateCount,
    environment: {
      runtime:
        params.environment?.runtime ??
        (typeof process !== 'undefined' && process.version ? `Node ${process.version}` : 'Browser'),
      platform:
        params.environment?.platform ??
        (typeof process !== 'undefined' && process.platform ? process.platform : 'web'),
      cpuCores: params.environment?.cpuCores ?? null,
      totalSystemMemoryBytes: params.environment?.totalSystemMemoryBytes ?? null,
      softwareVersions: {
        speechEventEngine: SPEECH_EVENT_ENGINE_VERSION,
        editDecisionEngine: EDIT_DECISION_ENGINE_VERSION,
        audioRenderer: AUDIO_RENDERER_VERSION,
        privacyPolicy: LOCAL_PRIVACY_POLICY_VERSION,
      },
    },
    memoryPolicySnapshot: AVAPARDAZ_MEMORY_POLICY,
    gates: Object.freeze(gates.map((g) => Object.freeze({ ...g }))),
    productionBlockers: Object.freeze(productionBlockers),
  });
}
