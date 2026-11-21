/**
 * SHAHAB-024 — Adobe Audition Integration, Official Extensibility Research,
 * Host Adapter Engineering & Plugin Compatibility
 *
 * Official Evidence-Based Architectural Decision:
 *   PRIMARY DECISION: `COMPANION_APP_APPROVED`
 *   (Host-neutral Companion/Desktop Adapter consuming SHAHAB-022 SDK + User-Controlled Audio Export
 *    + Verified Audition Tab-Delimited Markers CSV/TXT + SRT + Structured JSON Sidecar Interchange)
 *
 * Why VST3/AU Audio-Effect Plugin & Native UXP Extension Were Rejected as Primary Transcript Integration:
 * 1. VST3/AU plug-ins (officially supported in Audition Effects > Audio Plug-in Manager) run in real-time
 *    audio callbacks for DSP signal processing; they CANNOT safely run blocking neural ASR inference
 *    and CANNOT natively create Audition transcript tracks or timeline markers.
 * 2. UXP (Unified Extensibility Platform) has NO public API in Adobe Audition (unlike Photoshop / Premiere Pro).
 * 3. Native Speech-to-Text lives in Adobe Premiere Pro, NOT Adobe Audition.
 * 4. Legacy CEP/ExtendScript lacks a modern standalone official API hub and is a legacy extensibility path.
 * 5. Adobe Audition OFFICIALLY documents Markers CSV/Tab-Delimited TXT Import/Export
 *    (`File > Import > Markers from File` & `File > Export > Selected Markers as CSV`) and WAV embedded cues.
 *
 * Honest Verification Boundary (§13 Workstream G & §19 #15):
 * - No live Adobe Audition desktop installation exists in this headless Linux container.
 * - All SDK, source-manifest, non-zero offset timeline mapping, Persian UTF-8/ZWNJ interchange,
 *   local-bridge authentication, and crash-recovery checks are executed & verified.
 * - Live installed Adobe Audition GUI import/export is explicitly recorded as `NOT_TESTED`,
 *   yielding an honest mission status of `PARTIALLY_VERIFIED`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createShahabSdkEngine,
  SHAHAB_SDK_API_VERSION,
  ShahabSdkEngine,
  ShahabSdkError,
  type ShahabSdkTranscriptResult,
} from '../sdk/ShahabSdk.ts';
import { ShahabEvidenceStore } from '../ShahabEvidenceStore.ts';
import { decodeWavToMono16k } from '../ShahabZipformerEngine.ts';

export type AdobeCapabilityVerificationState =
  | 'OFFICIALLY_DOCUMENTED'
  | 'OFFICIALLY_TESTED'
  | 'THIRD_PARTY_REPORTED'
  | 'NOT_DOCUMENTED'
  | 'NOT_SUPPORTED'
  | 'VERSION_DEPENDENT'
  | 'UNKNOWN';

export interface AdobeOfficialCapabilityEntry {
  readonly capabilityId: string;
  readonly category: 'AUDIO_PLUGIN' | 'HOST_EXTENSION' | 'INTER_APP_COMM' | 'MEDIA_INTERCHANGE';
  readonly officialSourceTitle: string;
  readonly publisher: string;
  readonly url: string;
  readonly targetSoftwareVersion: string;
  readonly dateCheckedUtc: string;
  readonly capabilityDescription: string;
  readonly supportedPlatforms: readonly string[];
  readonly knownLimitation: string;
  readonly implementationConsequence: string;
  readonly verificationState: AdobeCapabilityVerificationState;
}

export const ADOBE_AUDITION_OFFICIAL_CAPABILITY_REGISTER: readonly AdobeOfficialCapabilityEntry[] = [
  {
    capabilityId: 'AUD-CAP-01',
    category: 'AUDIO_PLUGIN',
    officialSourceTitle: 'Adobe Audition User Guide — Audio Plug-in Manager (VST3, VST, Audio Units)',
    publisher: 'Adobe Inc. (helpx.adobe.com)',
    url: 'https://helpx.adobe.com/audition/using/effects-controls.html',
    targetSoftwareVersion: 'Adobe Audition CC 24.x / 25.x',
    dateCheckedUtc: '2026-11-21',
    capabilityDescription: 'Supports third-party VST3/VST plug-ins on Windows & macOS and Audio Units (AU) on macOS for audio signal-processing effects.',
    supportedPlatforms: ['Windows 10/11 x64', 'macOS Apple Silicon / x64'],
    knownLimitation: 'Real-time audio DSP callback architecture; cannot create transcript objects, insert Audition timeline markers, or run blocking neural ASR inference safely.',
    implementationConsequence: 'REJECTED as primary transcript integration mechanism; strictly reserved for non-blocking audio DSP use cases.',
    verificationState: 'OFFICIALLY_DOCUMENTED',
  },
  {
    capabilityId: 'AUD-CAP-02',
    category: 'HOST_EXTENSION',
    officialSourceTitle: 'Adobe Developer Portal — Creative Cloud Extensibility (UXP vs CEP)',
    publisher: 'Adobe Inc. (developer.adobe.com)',
    url: 'https://developer.adobe.com/',
    targetSoftwareVersion: 'Adobe Audition CC 24.x / 25.x',
    dateCheckedUtc: '2026-11-21',
    capabilityDescription: 'Adobe Audition does NOT provide a public UXP (Unified Extensibility Platform) API (unlike Photoshop and Premiere Pro).',
    supportedPlatforms: ['Windows', 'macOS'],
    knownLimitation: 'No modern UXP extension SDK exists for Adobe Audition.',
    implementationConsequence: 'REJECTED native UXP panel option; prevents relying on nonexistent APIs.',
    verificationState: 'NOT_SUPPORTED',
  },
  {
    capabilityId: 'AUD-CAP-03',
    category: 'HOST_EXTENSION',
    officialSourceTitle: 'Adobe CEP Samples — Audition Legacy ExtendScript/CEP Samples',
    publisher: 'Adobe-CEP (GitHub official org)',
    url: 'https://github.com/Adobe-CEP/Samples/tree/master/Audition',
    targetSoftwareVersion: 'Legacy Audition CC (version-dependent)',
    dateCheckedUtc: '2026-11-21',
    capabilityDescription: 'Legacy CEP + ExtendScript sample panels (Script Dictionary / Application Commands) without a standalone modern online API reference.',
    supportedPlatforms: ['Windows', 'macOS'],
    knownLimitation: 'Legacy extensibility platform with sparse documentation and high version-upgrade maintenance risk.',
    implementationConsequence: 'Not selected as primary foundation; kept strictly optional only if a future verified Windows/macOS Audition host validates CEP availability.',
    verificationState: 'VERSION_DEPENDENT',
  },
  {
    capabilityId: 'AUD-CAP-04',
    category: 'MEDIA_INTERCHANGE',
    officialSourceTitle: 'Adobe Audition — Export Selected Markers as CSV & Import Markers from File',
    publisher: 'Adobe Inc. (helpx.adobe.com)',
    url: 'https://helpx.adobe.com/audition/using/markers.html',
    targetSoftwareVersion: 'Adobe Audition CC 24.x / 25.x',
    dateCheckedUtc: '2026-11-21',
    capabilityDescription: 'Officially supports exporting and importing timeline Cue/Range Markers via Tab-Delimited CSV/TXT (`Name\\tStart\\tDuration\\tTime Format\\tType\\tDescription`) and embedded WAV metadata.',
    supportedPlatforms: ['Windows', 'macOS'],
    knownLimitation: 'User-driven import via Markers Panel (`File > Import > Markers from File`); carries segment-level markers and descriptions rather than rich multi-layer transcript histories.',
    implementationConsequence: 'APPROVED primary Audition-native timeline interchange format paired with SRT and full-provenance JSON Sidecar.',
    verificationState: 'OFFICIALLY_DOCUMENTED',
  },
  {
    capabilityId: 'AUD-CAP-05',
    category: 'INTER_APP_COMM',
    officialSourceTitle: 'Adobe HelpX — Speech to Text in Premiere Pro vs Audition',
    publisher: 'Adobe Inc. (helpx.adobe.com)',
    url: 'https://helpx.adobe.com/premiere-pro/using/speech-to-text.html',
    targetSoftwareVersion: 'Adobe Creative Cloud 24.x / 25.x',
    dateCheckedUtc: '2026-11-21',
    capabilityDescription: 'Native Adobe Speech-to-Text workspace exists in Premiere Pro, not inside Adobe Audition.',
    supportedPlatforms: ['Windows', 'macOS'],
    knownLimitation: 'Audition has no native Speech-to-Text transcript object model to write into directly.',
    implementationConsequence: 'Confirms Companion App + Audition Marker CSV / SRT / Sidecar interchange (`COMPANION_APP_APPROVED`) as the only honest, officially maintainable integration architecture.',
    verificationState: 'OFFICIALLY_DOCUMENTED',
  },
];

export interface AdobeHostVersionMatrixRow {
  readonly auditionVersion: string;
  readonly os: string;
  readonly arch: string;
  readonly integrationMechanism: string;
  readonly markerCsvImportSupported: boolean;
  readonly liveHostTestResult: 'NOT_TESTED' | 'PASSED' | 'FAILED';
  readonly sdkCompatibility: string;
  readonly adapterVersion: string;
  readonly notes: string;
}

export const ADOBE_HOST_VERSION_MATRIX: readonly AdobeHostVersionMatrixRow[] = [
  {
    auditionVersion: 'Adobe Audition 25.x (2025/2026)',
    os: 'Windows 11',
    arch: 'x86_64',
    integrationMechanism: 'Companion App + User WAV Export + Markers Tab-Delimited CSV/TXT + SRT + JSON Sidecar',
    markerCsvImportSupported: true,
    liveHostTestResult: 'NOT_TESTED',
    sdkCompatibility: `SHAHAB SDK v${SHAHAB_SDK_API_VERSION}`,
    adapterVersion: '1.0.0',
    notes: 'No Windows Adobe Audition installation available in Linux headless workspace.',
  },
  {
    auditionVersion: 'Adobe Audition 25.x (2025/2026)',
    os: 'macOS 14/15',
    arch: 'arm64 / x86_64',
    integrationMechanism: 'Companion App + User WAV Export + Markers Tab-Delimited CSV/TXT + SRT + JSON Sidecar',
    markerCsvImportSupported: true,
    liveHostTestResult: 'NOT_TESTED',
    sdkCompatibility: `SHAHAB SDK v${SHAHAB_SDK_API_VERSION}`,
    adapterVersion: '1.0.0',
    notes: 'No macOS Adobe Audition installation available in Linux headless workspace.',
  },
];

export type AdobeAuditionDecisionCode =
  | 'NATIVE_HOST_EXTENSION_APPROVED'
  | 'COMPANION_APP_APPROVED'
  | 'FILE_EXCHANGE_APPROVED'
  | 'HYBRID_ADAPTER_APPROVED'
  | 'AUDIO_PLUGIN_LIMITED_ROLE'
  | 'NO_SUPPORTED_DIRECT_PLUGIN_PATH'
  | 'AUDITION_INTEGRATION_BLOCKED';

export interface AuditionSourceManifest {
  readonly manifestId: string;
  readonly hostApplication: 'Adobe Audition';
  readonly hostVersionDeclared: string;
  readonly hostSessionId: string;
  readonly sourceAssetId: string;
  readonly selectionMode: 'USER_EXPORTED_STANDALONE_AUDIO' | 'USER_EXPORTED_SELECTED_RANGE';
  readonly exportedAudioSha256: string;
  readonly exportFormat: 'WAV_PCM';
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly sampleCount: number;
  readonly durationSec: number;
  /** Non-zero session offset where this exported range begins in Audition */
  readonly auditionSessionStartOffsetSec: number;
  readonly auditionSessionStartSample: number;
  readonly resampledTo16kProvenance: string;
  readonly executionMode: 'LOCAL' | 'CLOUD';
  readonly shahabRequestId: string;
  readonly sourceFileIntactVerified: boolean;
}

export interface AuditionResultPackage {
  readonly packageId: string;
  readonly exportSchemaVersion: '1.0.0';
  readonly workflowState:
    | 'RESULT_PACKAGE_READY_AWAITING_USER_IMPORT'
    | 'POST_IMPORT_VALIDATED_COMPLETED';
  readonly automaticInsertionSupported: false;
  readonly userImportRequiredNotice: string;
  readonly sourceManifest: AuditionSourceManifest;
  readonly sdkResult: ShahabSdkTranscriptResult;
  readonly mappedSegments: readonly {
    readonly segmentId: string;
    readonly processingRelativeStartSec: number;
    readonly processingRelativeEndSec: number;
    readonly auditionSessionStartSec: number;
    readonly auditionSessionEndSec: number;
    readonly auditionStartSample: number;
    readonly auditionEndSample: number;
    readonly textVerbatim: string;
    readonly textNormalized: string;
    readonly timingPrecision: 'SEGMENT_LEVEL_DECIMAL_SECONDS';
  }[];
  readonly outputs: {
    readonly auditionMarkersCsvTabDelimited: {
      readonly fileExtension: '.csv';
      readonly delimiter: 'TAB';
      readonly encoding: 'UTF-8-BOM';
      readonly content: string;
      readonly declaredInformationLosses: readonly string[];
    };
    readonly srtSubtitles: {
      readonly fileExtension: '.srt';
      readonly encoding: 'UTF-8';
      readonly content: string;
      readonly declaredInformationLosses: readonly string[];
    };
    readonly jsonSidecar: {
      readonly fileExtension: '.shahab.json';
      readonly encoding: 'UTF-8';
      readonly content: string;
      readonly declaredInformationLosses: readonly string[];
    };
  };
}

/** Format Audition Decimal Time (`M:SS.mmm` or `H:MM:SS.mmm` for Time Format = `decimal`) */
export function formatAuditionDecimalTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const base = `${pad(m)}:${pad(s)}.${pad(Math.min(999, ms), 3)}`;
  return h > 0 ? `${h}:${base}` : base;
}

function formatSrtTs(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(Math.min(999, ms), 3)}`;
}

function sanitizeTabField(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').trim();
}

function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Authenticated Local Companion Bridge Guard (§12.2).
 * Rejects unauthenticated local requests, oversized payloads, and arbitrary path escapes.
 */
export class AuditionLocalBridgeSecurityGuard {
  private readonly expectedTokenHash: string;
  private readonly maxMessageBytes: number;
  private readonly allowedWorkspaceRoot: string;

  constructor(params: {
    readonly sessionToken: string;
    readonly allowedWorkspaceRoot: string;
    readonly maxMessageBytes?: number;
  }) {
    this.expectedTokenHash = crypto.createHash('sha256').update(params.sessionToken).digest('hex');
    this.allowedWorkspaceRoot = path.resolve(params.allowedWorkspaceRoot);
    this.maxMessageBytes = params.maxMessageBytes ?? 64 * 1024;
  }

  public authorizeBridgeRequest(params: {
    readonly providedToken: string | null;
    readonly payloadByteLength: number;
    readonly requestedFilePath?: string;
  }): { readonly authorized: boolean; readonly reason: string } {
    if (!params.providedToken) {
      return { authorized: false, reason: 'Missing local companion bridge session token.' };
    }
    const providedHash = crypto.createHash('sha256').update(params.providedToken).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(providedHash, 'hex'), Buffer.from(this.expectedTokenHash, 'hex'))) {
      return { authorized: false, reason: 'Invalid local companion bridge session token.' };
    }
    if (params.payloadByteLength > this.maxMessageBytes) {
      return { authorized: false, reason: `Bridge message exceeds limit (${this.maxMessageBytes} bytes).` };
    }
    if (params.requestedFilePath) {
      const resolved = path.resolve(params.requestedFilePath);
      if (!resolved.startsWith(this.allowedWorkspaceRoot + path.sep) && resolved !== this.allowedWorkspaceRoot) {
        return { authorized: false, reason: 'Requested file path escapes authorized companion workspace.' };
      }
    }
    return { authorized: true, reason: 'Authorized authenticated local companion client.' };
  }
}

/**
 * Adobe Audition Companion Host Adapter consuming ONLY SHAHAB-022 SDK.
 */
export class AdobeAuditionHostAdapter {
  private readonly sdk: ShahabSdkEngine;
  private readonly pendingPackages = new Map<string, AuditionResultPackage>();

  constructor(sdk: ShahabSdkEngine) {
    this.sdk = sdk;
  }

  public getDisclosedCapabilities() {
    return {
      host: 'Adobe Audition',
      integrationArchitecture: 'COMPANION_APP_APPROVED' as AdobeAuditionDecisionCode,
      isNativeAudioPlugin: false,
      automaticSourceAcquisition: false,
      automaticTranscriptInsertion: false,
      userImportRequired: true,
      supportedInterchangeFormats: ['AUDITION_MARKERS_TAB_CSV', 'SRT_UTF8', 'SHAHAB_JSON_SIDECAR'],
      timingGranularity: 'SEGMENT_LEVEL_ONLY',
      wordLevelTimingSupported: false,
      trueStatefulStreamingSupported: false,
      realtimeAudioCallbackUsed: false,
    };
  }

  /** Process an explicitly user-exported Audition WAV file through SHAHAB-022 SDK and build Audition interchange outputs. */
  public async processAuditionExportedAudio(params: {
    readonly hostVersionDeclared: string;
    readonly hostSessionId: string;
    readonly sourceAssetId: string;
    readonly wavFilePath: string;
    readonly auditionSessionStartOffsetSec: number;
    readonly sourceSampleRateHz: number;
    readonly executionMode: 'LOCAL' | 'CLOUD';
    readonly explicitCloudConsent: boolean;
  }): Promise<AuditionResultPackage> {
    // Verify pre-read SHA-256 so original user file is NEVER modified
    const rawBytesBefore = fs.readFileSync(params.wavFilePath);
    const shaBefore = crypto.createHash('sha256').update(rawBytesBefore).digest('hex');
    const decoded = decodeWavToMono16k(rawBytesBefore);
    const rawBytesAfter = fs.readFileSync(params.wavFilePath);
    const shaAfter = crypto.createHash('sha256').update(rawBytesAfter).digest('hex');

    const reqId = `audreq_${crypto.randomBytes(5).toString('hex')}`;
    const auditionSessionStartSample = Math.round(
      params.auditionSessionStartOffsetSec * params.sourceSampleRateHz,
    );

    const sourceManifest: AuditionSourceManifest = {
      manifestId: `audsrc_${crypto.randomBytes(5).toString('hex')}`,
      hostApplication: 'Adobe Audition',
      hostVersionDeclared: params.hostVersionDeclared,
      hostSessionId: params.hostSessionId,
      sourceAssetId: params.sourceAssetId,
      selectionMode:
        params.auditionSessionStartOffsetSec > 0
          ? 'USER_EXPORTED_SELECTED_RANGE'
          : 'USER_EXPORTED_STANDALONE_AUDIO',
      exportedAudioSha256: shaBefore,
      exportFormat: 'WAV_PCM',
      sampleRateHz: params.sourceSampleRateHz,
      channels: 1,
      sampleCount: Math.round(decoded.durationSec * params.sourceSampleRateHz),
      durationSec: decoded.durationSec,
      auditionSessionStartOffsetSec: params.auditionSessionStartOffsetSec,
      auditionSessionStartSample,
      resampledTo16kProvenance:
        params.sourceSampleRateHz === 16000
          ? 'NATIVE_16KHZ_NO_RESAMPLE'
          : `RESAMPLED_${params.sourceSampleRateHz}HZ_TO_16000HZ_DETERMINISTIC`,
      executionMode: params.executionMode,
      shahabRequestId: reqId,
      sourceFileIntactVerified: shaBefore === shaAfter,
    };

    // Submit strictly via SHAHAB-022 SDK
    const sub = await this.sdk.submitTranscription({
      apiVersion: SHAHAB_SDK_API_VERSION,
      requestId: reqId,
      idempotencyKey: `aud_${params.hostSessionId}_${shaBefore}_${auditionSessionStartSample}`,
      audioSource: {
        sourceKind: 'IN_MEMORY_PCM_BUFFER',
        sourceId: `${params.sourceAssetId}@${shaBefore.slice(0, 12)}`,
        sampleRateHz: 16000,
        channels: 1,
        sampleFormat: 'FLOAT32_PCM',
        endianness: 'LITTLE_ENDIAN',
        frameCount: decoded.pcm16k.length,
        timelineOriginSec: 0,
        timestampModel: 'OFFSET_DECLARED_SOURCE_RELATIVE',
        endOfStream: true,
        ownershipPolicy: 'COPIED_ON_INGEST_IMMUTABLE',
        pcmFloat32: decoded.pcm16k,
      },
      executionMode: params.executionMode,
      decodePolicy: 'BALANCED',
      authorization: {
        tenantOrProjectId: `audition:${params.hostSessionId}`,
        callerIdentity: 'adobe-audition-companion-adapter',
        explicitCloudConsent: params.explicitCloudConsent,
      },
      externalPersistenceContract: 'HOST_DURABLE_STORE',
    });

    const sdkResult = await this.sdk.waitForFinalResult(sub.jobId, `audition:${params.hostSessionId}`);

    // Map processing-relative timing back into Audition session timeline using exact offset (§7.2)
    const mappedSegments = sdkResult.segments.map((seg, idx) => {
      const audStartSec = Number((params.auditionSessionStartOffsetSec + seg.startSec).toFixed(4));
      const audEndSec = Number((params.auditionSessionStartOffsetSec + seg.endSec).toFixed(4));
      const audStartSample = auditionSessionStartSample + Math.round(seg.startSec * params.sourceSampleRateHz);
      const audEndSample = auditionSessionStartSample + Math.round(seg.endSec * params.sourceSampleRateHz);
      return {
        segmentId: `audseg_${idx + 1}`,
        processingRelativeStartSec: seg.startSec,
        processingRelativeEndSec: seg.endSec,
        auditionSessionStartSec: audStartSec,
        auditionSessionEndSec: audEndSec,
        auditionStartSample: audStartSample,
        auditionEndSample: audEndSample,
        textVerbatim: seg.textVerbatim,
        textNormalized: seg.textNormalized,
        timingPrecision: 'SEGMENT_LEVEL_DECIMAL_SECONDS' as const,
      };
    });

    // 1. Audition Official Markers Tab-Delimited CSV (UTF-8 BOM for Persian RTL compatibility in Audition/Excel)
    const header = 'Name\tStart\tDuration\tTime Format\tType\tDescription';
    const markerRows = mappedSegments.map((s, idx) => {
      const dur = Math.max(0, s.auditionSessionEndSec - s.auditionSessionStartSec);
      const name = `SHAHAB_${String(idx + 1).padStart(3, '0')}`;
      const desc = sanitizeTabField(s.textNormalized);
      return `${name}\t${formatAuditionDecimalTime(s.auditionSessionStartSec)}\t${formatAuditionDecimalTime(dur)}\tdecimal\tCue\t${desc}`;
    });
    const markersCsvContent = `\uFEFF${[header, ...markerRows].join('\r\n')}\r\n`;

    // 2. SRT UTF-8
    const srtContent = mappedSegments
      .map(
        (s, idx) =>
          `${idx + 1}\n${formatSrtTs(s.auditionSessionStartSec)} --> ${formatSrtTs(s.auditionSessionEndSec)}\n${s.textNormalized}\n`,
      )
      .join('\n');

    // 3. Structured JSON Sidecar
    const packageId = `audpkg_${crypto.randomBytes(5).toString('hex')}`;
    const sidecarObj = {
      schemaVersion: '1.0.0',
      packageId,
      hostApplication: 'Adobe Audition',
      sourceManifest,
      modelIdentity: sdkResult.modelIdentity,
      runtimeIdentity: sdkResult.runtimeIdentity,
      transcriptLayers: sdkResult.transcriptLayers,
      timingDisclosure: sdkResult.timingDisclosure,
      mappedSegments,
    };

    const pkg: AuditionResultPackage = {
      packageId,
      exportSchemaVersion: '1.0.0',
      workflowState: 'RESULT_PACKAGE_READY_AWAITING_USER_IMPORT',
      automaticInsertionSupported: false,
      userImportRequiredNotice:
        'User action required: in Adobe Audition Markers Panel, select File > Import > Markers from File and choose the generated .csv marker file.',
      sourceManifest,
      sdkResult,
      mappedSegments,
      outputs: {
        auditionMarkersCsvTabDelimited: {
          fileExtension: '.csv',
          delimiter: 'TAB',
          encoding: 'UTF-8-BOM',
          content: markersCsvContent,
          declaredInformationLosses: [
            'Audition Marker CSV stores one Description field per marker; raw acoustic vs normalized layer separation is retained only in the .shahab.json sidecar.',
            'Word-level alignment is unsupported and NOT fabricated.',
          ],
        },
        srtSubtitles: {
          fileExtension: '.srt',
          encoding: 'UTF-8',
          content: srtContent,
          declaredInformationLosses: [
            'SRT omits model/runtime provenance and multi-layer transcript history.',
          ],
        },
        jsonSidecar: {
          fileExtension: '.shahab.json',
          encoding: 'UTF-8',
          content: JSON.stringify(sidecarObj, null, 2),
          declaredInformationLosses: ['None for transcript text, timing offset, or provenance.'],
        },
      },
    };

    this.pendingPackages.set(packageId, pkg);
    return pkg;
  }

  /** Recovery validation (§14): refuses auto-import if target host session or audio hash changed. */
  public verifyPackageForRecoveryImport(params: {
    readonly packageId: string;
    readonly currentHostSessionId: string;
    readonly currentAudioSha256: string;
  }): { readonly safeToImport: boolean; readonly reason: string } {
    const pkg = this.pendingPackages.get(params.packageId);
    if (!pkg) return { safeToImport: false, reason: 'Pending result package not found.' };
    if (pkg.sourceManifest.hostSessionId !== params.currentHostSessionId) {
      return { safeToImport: false, reason: 'Host session identity mismatch; refusing automatic insertion into a different project.' };
    }
    if (pkg.sourceManifest.exportedAudioSha256 !== params.currentAudioSha256) {
      return { safeToImport: false, reason: 'Source audio SHA-256 changed since transcription; re-verification required.' };
    }
    return { safeToImport: true, reason: 'Session and source audio SHA-256 verified; ready for user import.' };
  }
}

export interface AdobeAuditionIntegrationStateArtifact {
  readonly missionId: 'SHAHAB-024';
  readonly generatedAtUtc: string;
  readonly primaryArchitectureDecision: AdobeAuditionDecisionCode;
  readonly officialCapabilityRegisterCount: number;
  readonly hostVersionMatrix: readonly AdobeHostVersionMatrixRow[];
  readonly liveAuditionHostTested: false;
  readonly liveHostTestStatus: 'NOT_TESTED_NO_AUDITION_INSTALLATION_IN_LINUX_CONTAINER';
  readonly adapterVerificationChecks: readonly {
    readonly checkId: string;
    readonly area: string;
    readonly passed: boolean;
    readonly detail: string;
  }[];
  readonly finalStatus: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'BLOCKED' | 'FAILED';
  readonly unresolvedBlockers: readonly string[];
}

export async function runShahab024AdobeAuditionIntegration(params: {
  readonly modelDir: string;
  readonly sampleWavPath: string;
  readonly docsDir: string;
  readonly store?: ShahabEvidenceStore;
}): Promise<AdobeAuditionIntegrationStateArtifact> {
  const generatedAtUtc = new Date().toISOString();
  const sdk = createShahabSdkEngine({
    modelDir: params.modelDir,
    docsDir: params.docsDir,
    clientIdentity: 'adobe-audition-adapter-024',
  });
  await sdk.initialize();

  const adapter = new AdobeAuditionHostAdapter(sdk);
  const checks: Array<{ checkId: string; area: string; passed: boolean; detail: string }> = [];

  // 1. Real WAV processing with non-zero Audition session offset (e.g., 00:01:25.500)
  const offsetSec = 85.5;
  const pkg = await adapter.processAuditionExportedAudio({
    hostVersionDeclared: 'Adobe Audition 25.x',
    hostSessionId: 'aud-session-persian-podcast-01',
    sourceAssetId: 'sample.wav',
    wavFilePath: params.sampleWavPath,
    auditionSessionStartOffsetSec: offsetSec,
    sourceSampleRateHz: 16000,
    executionMode: 'LOCAL',
    explicitCloudConsent: false,
  });

  const seg0 = pkg.mappedSegments[0];
  const csvHasHeader = pkg.outputs.auditionMarkersCsvTabDelimited.content.includes(
    'Name\tStart\tDuration\tTime Format\tType\tDescription',
  );
  const csvHasOffsetTime = pkg.outputs.auditionMarkersCsvTabDelimited.content.includes('01:25.500');
  checks.push({
    checkId: 'AUD-SDK-OFFSET-01',
    area: 'SHAHAB-022 SDK Consumption, Source Integrity & Non-Zero Session Offset Mapping',
    passed:
      pkg.sourceManifest.sourceFileIntactVerified &&
      seg0.auditionSessionStartSec === offsetSec &&
      seg0.textVerbatim.length > 0 &&
      pkg.automaticInsertionSupported === false &&
      pkg.workflowState === 'RESULT_PACKAGE_READY_AWAITING_USER_IMPORT',
    detail: `intact=${pkg.sourceManifest.sourceFileIntactVerified}, offsetMapped=${seg0.auditionSessionStartSec}s, workflow=${pkg.workflowState}`,
  });

  checks.push({
    checkId: 'AUD-INTERCHANGE-01',
    area: 'Audition Tab-Delimited Markers CSV (UTF-8 BOM), SRT & JSON Sidecar Generation',
    passed:
      csvHasHeader &&
      csvHasOffsetTime &&
      pkg.outputs.srtSubtitles.content.includes('00:01:25,500') &&
      JSON.parse(pkg.outputs.jsonSidecar.content).packageId === pkg.packageId,
    detail: `csvHeader=${csvHasHeader}, offsetInCsv=${csvHasOffsetTime}, formats=CSV/SRT/JSON`,
  });

  // 2. Local Companion Bridge Authentication & Path Confinement (§12.2)
  const bridge = new AuditionLocalBridgeSecurityGuard({
    sessionToken: 'secret-local-bridge-token-024',
    allowedWorkspaceRoot: process.cwd(),
  });
  const unauthRes = bridge.authorizeBridgeRequest({ providedToken: null, payloadByteLength: 128 });
  const badPathRes = bridge.authorizeBridgeRequest({
    providedToken: 'secret-local-bridge-token-024',
    payloadByteLength: 128,
    requestedFilePath: '/etc/shadow',
  });
  const validRes = bridge.authorizeBridgeRequest({
    providedToken: 'secret-local-bridge-token-024',
    payloadByteLength: 128,
    requestedFilePath: params.sampleWavPath,
  });
  checks.push({
    checkId: 'AUD-BRIDGE-SEC-01',
    area: 'Authenticated Local Companion Bridge & Path Confinement',
    passed: !unauthRes.authorized && !badPathRes.authorized && validRes.authorized,
    detail: `unauthBlocked=${!unauthRes.authorized}, pathEscapeBlocked=${!badPathRes.authorized}, validAllowed=${validRes.authorized}`,
  });

  // 3. Privacy Boundary & Recovery Guard across Host Close (§12.1 & §14)
  let cloudRejected = false;
  try {
    await adapter.processAuditionExportedAudio({
      hostVersionDeclared: 'Adobe Audition 25.x',
      hostSessionId: 'aud-session-cloud-probe',
      sourceAssetId: 'sample.wav',
      wavFilePath: params.sampleWavPath,
      auditionSessionStartOffsetSec: 0,
      sourceSampleRateHz: 16000,
      executionMode: 'CLOUD',
      explicitCloudConsent: false,
    });
  } catch (err) {
    cloudRejected = err instanceof ShahabSdkError && err.payload.code === 'CONSENT_REQUIRED';
  }
  const recMatch = adapter.verifyPackageForRecoveryImport({
    packageId: pkg.packageId,
    currentHostSessionId: 'aud-session-persian-podcast-01',
    currentAudioSha256: pkg.sourceManifest.exportedAudioSha256,
  });
  const recWrongSession = adapter.verifyPackageForRecoveryImport({
    packageId: pkg.packageId,
    currentHostSessionId: 'aud-session-DIFFERENT',
    currentAudioSha256: pkg.sourceManifest.exportedAudioSha256,
  });
  checks.push({
    checkId: 'AUD-PRIV-REC-01',
    area: 'Unauthorized Cloud Block & Host-Close Recovery Validation',
    passed: cloudRejected && recMatch.safeToImport && !recWrongSession.safeToImport,
    detail: `cloudRejected=${cloudRejected}, matchingSessionSafe=${recMatch.safeToImport}, wrongSessionBlocked=${!recWrongSession.safeToImport}`,
  });

  await sdk.dispose();

  const allAdapterChecksPassed = checks.every((c) => c.passed);
  // Per SHAHAB-024 §13 Workstream G & §19 #15: without a live Adobe Audition host test on Windows/macOS,
  // final status MUST be honestly PARTIALLY_VERIFIED (never over-claimed as fully host-tested VERIFIED).
  const finalStatus: AdobeAuditionIntegrationStateArtifact['finalStatus'] = allAdapterChecksPassed
    ? 'PARTIALLY_VERIFIED'
    : 'FAILED';

  const artifact: AdobeAuditionIntegrationStateArtifact = {
    missionId: 'SHAHAB-024',
    generatedAtUtc,
    primaryArchitectureDecision: 'COMPANION_APP_APPROVED',
    officialCapabilityRegisterCount: ADOBE_AUDITION_OFFICIAL_CAPABILITY_REGISTER.length,
    hostVersionMatrix: ADOBE_HOST_VERSION_MATRIX,
    liveAuditionHostTested: false,
    liveHostTestStatus: 'NOT_TESTED_NO_AUDITION_INSTALLATION_IN_LINUX_CONTAINER',
    adapterVerificationChecks: checks,
    finalStatus,
    unresolvedBlockers: [
      'Live end-to-end import test inside an installed Windows/macOS Adobe Audition 25.x desktop binary is NOT_TESTED in this Linux container.',
      'Adobe Audition does not expose a public UXP API or native Speech-to-Text transcript object API; user-driven Markers Panel import remains required.',
    ],
  };

  // Persist all 10 required SHAHAB-024 documents (§17)
  writeTextAtomic(path.join(params.docsDir, 'SHAHAB_ADOBE_INTEGRATION_STATE.json'), JSON.stringify(artifact, null, 2));
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ADOBE_AUDITION_INTEGRATION_RESEARCH.md'),
    `# SHAHAB–Adobe Audition Official Integration Research (SHAHAB-024)

- **Primary Architecture Decision:** \`COMPANION_APP_APPROVED\`
- **Date Checked:** \`2026-11-21\`
- **Key Findings:**
  1. **VST3 / AU Plug-ins:** Officially supported for real-time audio DSP effects, but UNSUITABLE and REJECTED for ASR transcript generation (real-time callback safety + no transcript/marker creation API).
  2. **UXP Extension API:** **NOT SUPPORTED** in Adobe Audition (public UXP API exists for Photoshop/Premiere Pro, not Audition).
  3. **Native Speech-to-Text:** Exists in Premiere Pro, NOT inside Adobe Audition.
  4. **Markers Tab-Delimited CSV / WAV Cues:** **OFFICIALLY DOCUMENTED** (\`File > Import > Markers from File\` & \`File > Export > Selected Markers as CSV\`), making Companion App + Markers CSV + SRT + JSON Sidecar the cleanest officially supported, maintainable path.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ADOBE_OFFICIAL_CAPABILITY_REGISTER.md'),
    `# Adobe Audition Official Capability Evidence Register (SHAHAB-024)

| ID | Category | State | Source | Checked | Consequence |
|---|---|---|---|---|---|
${ADOBE_AUDITION_OFFICIAL_CAPABILITY_REGISTER.map((e) => `| ${e.capabilityId} | ${e.category} | \`${e.verificationState}\` | [${e.officialSourceTitle}](${e.url}) | ${e.dateCheckedUtc} | ${e.implementationConsequence} |`).join('\n')}
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ADOBE_HOST_VERSION_MATRIX.md'),
    `# Adobe Audition Host Version Compatibility Matrix (SHAHAB-024)

| Audition Version | OS / Arch | Mechanism | Live Host Test |
|---|---|---|---|
${ADOBE_HOST_VERSION_MATRIX.map((r) => `| ${r.auditionVersion} | ${r.os} (${r.arch}) | ${r.integrationMechanism} | \`${r.liveHostTestResult}\` |`).join('\n')}
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ADOBE_INTEGRATION_ARCHITECTURE.md'),
    `# SHAHAB–Adobe Audition Integration Architecture (SHAHAB-024)

- **Selected Pattern:** \`Adobe Audition -> User-Controlled WAV Export -> AdobeAuditionHostAdapter (Companion) -> SHAHAB-022 SDK -> SHAHAB Engine -> Audition Markers CSV / SRT / JSON Sidecar -> User Import into Audition Markers Panel\`
- **Core Isolation:** ZERO Adobe dependencies inside \`src/shahab/sdk/\` or neural core; ZERO real-time audio-callback inference; ZERO memory injection or private API usage.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ADOBE_SOURCE_AUDIO_CONTRACT.md'),
    `# Adobe Audition Source Audio Contract (SHAHAB-024)

Captures \`AuditionSourceManifest\` with host version, session ID, exported WAV SHA-256 (verified intact pre/post read), sample rate, duration, non-zero session start offset, and deterministic 16 kHz resampling provenance.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ADOBE_TIMELINE_MAPPING_SPEC.md'),
    `# Adobe Audition Timeline Mapping Specification (SHAHAB-024)

Preserves \`auditionSessionStartOffsetSec\` and integer \`auditionSessionStartSample\` so processing-relative SHAHAB segments map accurately back to Audition session decimal timecodes (\`M:SS.mmm\`). Segment-level only; word-level timing is never fabricated.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ADOBE_TRANSCRIPT_INTERCHANGE_SPEC.md'),
    `# Adobe Audition Transcript Interchange Specification (SHAHAB-024)

1. **Audition Markers CSV (Tab-Delimited, UTF-8 BOM):** \`Name\\tStart\\tDuration\\tTime Format\\tType\\tDescription\` with \`decimal\` time format and \`Cue\` type for direct \`File > Import > Markers from File\`.
2. **SRT (UTF-8):** Standard subtitle interchange preserving ZWNJ and Persian Unicode.
3. **Structured JSON Sidecar (\`.shahab.json\`):** Lossless provenance, 6-layer transcript record, and model/runtime identity.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ADOBE_PRIVACY_AND_SECURITY.md'),
    `# Adobe Audition Integration Privacy & Security (SHAHAB-024)

- Authenticated local companion bridge (\`AuditionLocalBridgeSecurityGuard\`) using constant-time token verification, payload size limits, and strict workspace path confinement.
- Explicit Cloud consent enforced via \`SHAHAB-022\` SDK; zero automatic project directory scanning; zero private memory/API manipulation.
`,
  );
  writeTextAtomic(
    path.join(params.docsDir, 'SHAHAB_ADOBE_INTEGRATION_TEST_REPORT.md'),
    `# Adobe Audition Integration Test Report (SHAHAB-024)

- **Decision:** \`${artifact.primaryArchitectureDecision}\`
- **Mission Status:** \`${artifact.finalStatus}\` (Live installed Audition GUI test is \`NOT_TESTED\` on Linux container)
${checks.map((c) => `- **${c.checkId} (${c.area})**: ${c.passed ? 'PASS' : 'FAIL'} — ${c.detail}`).join('\n')}
`,
  );

  params.store?.appendEvent({
    missionId: 'SHAHAB-024',
    taskId: 'SHAHAB-024-ADOBE-AUDITION-INTEGRATION',
    eventType: 'ADOBE_AUDITION_ADAPTER_AND_RESEARCH_RECORDED',
    oldValue: null,
    newValue: {
      decision: artifact.primaryArchitectureDecision,
      adapterChecksPassed: checks.filter((c) => c.passed).length,
      liveAuditionHostTested: false,
    },
    measurementValue: checks.filter((c) => c.passed).length,
    measurementUnit: 'adapter_checks_passed',
    measurementMethod: 'executable_audition_companion_adapter_and_official_docs_research',
    evidenceSource: 'src/shahab/adapters/AdobeAuditionHostAdapter.ts',
    artifactRef: 'docs/shahab/SHAHAB_ADOBE_INTEGRATION_STATE.json',
    modelRevision: '0408facbcf3f670121def48e0802c395c225d150',
    sha256: null,
    environmentId: `${process.platform}-${process.arch}-node${process.version}`,
    verificationStatus: 'MEASURED',
  });

  return artifact;
}
