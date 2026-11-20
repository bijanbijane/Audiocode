import { SampleRate } from '../contracts/timebase.contract';
import { PersianWordToken } from '../contracts/v1_2';
import {
  SpeechEvent,
  SpeechEventAnalysisResult,
  SpeechEventEngine,
  convertWordTokensToTimedTokens,
} from '../ai-engine/speech-events';
import {
  EditDecisionEngine,
  EditDecisionListSnapshot,
  EditProposal,
  EditValidationFailure,
  deterministicHexHash,
  serializeEdlSnapshot,
} from '../ai-engine/edit-decision';
import {
  AudioRenderConfig,
  AudioRenderEngine,
  AudioRenderResult,
  ChunkedPcmSource,
  CommittedRenderOutputArtifact,
  RenderCheckpoint,
  RenderLifecycleState,
  RenderOutputArtifact,
  RenderProgressSnapshot,
  createPlanarArrayPcmSource,
} from '../audio-renderer';
import {
  getSharedMemoryBudgetManager,
  MemoryBudgetManager,
  MemoryPressureLevel,
} from '../runtime/memory/MemoryBudgetManager';
import { sanitizeExportFilename } from '../security/LocalPrivacyPolicy';
import { flicksToSeconds } from '../engine/timebase';

export type LocalAsrLifecycleState =
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_AVAILABLE'
  | 'MODEL_INTEGRITY_FAILURE'
  | 'RUNTIME_UNAVAILABLE'
  | 'MODEL_LOADING'
  | 'MODEL_READY'
  | 'INFERENCE_RUNNING'
  | 'INFERENCE_FAILED'
  | 'NO_SPEECH_DETECTED'
  | 'TRANSCRIPTION_COMPLETED'
  | 'TRANSCRIPTION_CANCELLED';

export type WorkflowLocale = 'fa' | 'en';

export type TranscriptDisplayLayer = 'raw' | 'user_corrected' | 'normalized';

export type ProjectPersistenceState =
  | 'PERSISTED_LOCAL'
  | 'IN_MEMORY_ONLY'
  | 'PERSISTENCE_UNAVAILABLE';

export type ExportArtifactStatus =
  | 'IDLE'
  | 'RENDERED_UNVALIDATED'
  | 'VALIDATED_READY'
  | 'SAVED_OR_DOWNLOADED'
  | 'FAILED';

export interface SourceAudioMetadataSummary {
  readonly sourceAudioId: string;
  readonly sourceAudioHash: string;
  readonly fileName: string;
  readonly format: string;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly bitDepth: number | null;
  readonly totalSamples: number;
  readonly durationSec: number;
  readonly fileSizeBytes: number;
  readonly importStatus: 'VALIDATED' | 'SYNTHETIC_FIXTURE' | 'ERROR';
  readonly importError?: string;
  readonly isDemoFixture: boolean;
}

export interface TranscriptSegmentRecord {
  readonly segmentId: string;
  readonly trackId: string;
  readonly speakerLabel: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly rawText: string;
  readonly editedText: string;
  readonly normalizedText: string;
  readonly tokenIds: readonly string[];
  readonly alignmentQuality: 'FORCED_ALIGNED' | 'ASR_TIMESTAMP' | 'ESTIMATED' | 'MISSING';
  readonly alignmentConfidence: number | null;
}

export interface TranscriptVersionRecord {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly kind: 'RAW_ASR_IMMUTABLE' | 'USER_CORRECTED';
  readonly createdAtMs: number;
  readonly changeSummary: string;
  readonly segments: readonly TranscriptSegmentRecord[];
}

export interface LocalRecentProjectSummary {
  readonly projectId: string;
  readonly projectName: string;
  readonly updatedAtMs: number;
  readonly durationSec: number;
  readonly sourceFileName: string;
  readonly persistenceState: ProjectPersistenceState;
}

export interface OfflineReadinessSnapshot {
  readonly offlineReadyForEditing: boolean;
  readonly offlineReadyForLocalAsr: boolean;
  readonly localModelInstalled: boolean;
  readonly runtimeAvailable: boolean;
  readonly storageAvailable: boolean;
  readonly summaryFa: string;
  readonly summaryEn: string;
}

export interface StudioWorkflowState {
  readonly sessionGeneration: number;
  readonly projectId: string;
  readonly projectName: string;
  readonly locale: WorkflowLocale;
  readonly theme: 'dark' | 'light';
  readonly persistenceState: ProjectPersistenceState;
  readonly persistenceNote: string;
  readonly sourceAudio: SourceAudioMetadataSummary | null;
  readonly asrState: LocalAsrLifecycleState;
  readonly asrModelId: string | null;
  readonly asrModelVersion: string | null;
  readonly asrProgressPct: number | null;
  readonly asrCurrentSegment: string | null;
  readonly asrStatusMessage: string;
  readonly rawTranscriptVersion: TranscriptVersionRecord | null;
  readonly transcriptVersions: readonly TranscriptVersionRecord[];
  readonly activeTranscriptVersionId: string | null;
  readonly transcriptDisplayLayer: TranscriptDisplayLayer;
  readonly speechEventResult: SpeechEventAnalysisResult | null;
  readonly isAnalyzingEvents: boolean;
  readonly edlSnapshot: EditDecisionListSnapshot | null;
  readonly edlUndoStack: readonly EditDecisionListSnapshot[];
  readonly edlRedoStack: readonly EditDecisionListSnapshot[];
  readonly renderState: RenderLifecycleState | 'IDLE';
  readonly renderProgress: RenderProgressSnapshot | null;
  readonly lastRenderResult: AudioRenderResult | null;
  readonly recoverableCheckpoint: RenderCheckpoint | null;
  readonly exportStatus: ExportArtifactStatus;
  readonly exportSavedFileName: string | null;
  readonly exportError: string | null;
  readonly recentProjects: readonly LocalRecentProjectSummary[];
  readonly memoryPressure: MemoryPressureLevel;
  readonly memoryAccountedBytes: number;
  readonly memoryHardLimitBytes: number;
}

/** Groups word tokens into coherent sentence/speaker transcript segments while preserving raw text */
export function buildTranscriptSegmentsFromTokens(
  tokens: readonly PersianWordToken[],
  speakerByTrackId: Readonly<Record<string, string>>,
): TranscriptSegmentRecord[] {
  const validTokens = tokens.filter(
    (t) => Number.isFinite(t.range?.startFlicks) && Number.isFinite(t.range?.endFlicks),
  );
  if (validTokens.length === 0) return [];
  const sorted = [...validTokens].sort((a, b) => a.range.startFlicks - b.range.startFlicks);
  const segments: TranscriptSegmentRecord[] = [];
  let bucket: PersianWordToken[] = [];

  const flushBucket = () => {
    if (bucket.length === 0) return;
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    const rawText = bucket.map((t) => t.originalText).join(' ');
    const normalizedText = bucket.map((t) => t.displayText).join(' ');
    const alignSources = new Set(bucket.map((t) => t.alignmentSource));
    let alignmentQuality: TranscriptSegmentRecord['alignmentQuality'] = 'ESTIMATED';
    if (alignSources.has('ForcedAlignment')) alignmentQuality = 'FORCED_ALIGNED';
    else if (alignSources.has('ASR')) alignmentQuality = 'ASR_TIMESTAMP';
    else if (alignSources.size === 0) alignmentQuality = 'MISSING';

    const confs = bucket.map((t) => t.confidence).filter((c) => Number.isFinite(c));
    const avgConf =
      confs.length > 0
        ? Number((confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(3))
        : null;

    segments.push({
      segmentId: `seg_${segments.length + 1}_${first.id}`,
      trackId: first.trackId,
      speakerLabel: speakerByTrackId[first.trackId] ?? first.trackId,
      startSec: Number(flicksToSeconds(first.range.startFlicks).toFixed(3)),
      endSec: Number(flicksToSeconds(last.range.endFlicks).toFixed(3)),
      rawText,
      editedText: normalizedText,
      normalizedText,
      tokenIds: bucket.map((t) => t.id),
      alignmentQuality,
      alignmentConfidence: avgConf,
    });
    bucket = [];
  };

  for (const tok of sorted) {
    if (bucket.length > 0) {
      const prev = bucket[bucket.length - 1];
      const gapSec = flicksToSeconds(tok.range.startFlicks - prev.range.endFlicks);
      if (tok.trackId !== prev.trackId || gapSec > 0.75 || bucket.length >= 12) {
        flushBucket();
      }
    }
    bucket.push(tok);
  }
  flushBucket();
  return segments;
}

/** Computes honest offline readiness from actual local runtime & installed model availability */
export function computeOfflineReadiness(params: {
  readonly asrState: LocalAsrLifecycleState;
  readonly runtimeAvailable: boolean;
  readonly storageAvailable: boolean;
}): OfflineReadinessSnapshot {
  const localModelInstalled =
    params.asrState === 'MODEL_AVAILABLE' ||
    params.asrState === 'MODEL_READY' ||
    params.asrState === 'INFERENCE_RUNNING' ||
    params.asrState === 'TRANSCRIPTION_COMPLETED' ||
    params.asrState === 'NO_SPEECH_DETECTED' ||
    params.asrState === 'TRANSCRIPTION_CANCELLED';

  const localRuntimeReady =
    params.asrState === 'MODEL_READY' ||
    params.asrState === 'INFERENCE_RUNNING' ||
    params.asrState === 'TRANSCRIPTION_COMPLETED' ||
    params.asrState === 'NO_SPEECH_DETECTED' ||
    params.asrState === 'TRANSCRIPTION_CANCELLED';

  const offlineReadyForEditing = params.runtimeAvailable;
  const offlineReadyForLocalAsr = params.runtimeAvailable && localRuntimeReady;

  let summaryFa = 'تدوین و رندر آفلاین آماده است؛ مدل محلی ASR نصب نشده است.';
  let summaryEn = 'Offline editing & rendering ready; local ASR model not installed.';

  if (!params.runtimeAvailable) {
    summaryFa = 'محیط اجرای محلی (WebAudio/WASM) در دسترس نیست.';
    summaryEn = 'Local runtime (WebAudio/WASM) is unavailable.';
  } else if (offlineReadyForLocalAsr) {
    summaryFa = 'کاملاً آماده اجرای آفلاین (تدوین، مدل محلی ASR و رندر).';
    summaryEn = 'Fully offline-ready (editing, local ASR model, and rendering).';
  } else if (localModelInstalled) {
    summaryFa = 'مدل محلی در OPFS ذخیره و تأیید شده است؛ موتور استنتاج هنوز بارگذاری نشده است.';
    summaryEn = 'Local model stored & verified in OPFS; inference runtime not yet initialized.';
  }

  return {
    offlineReadyForEditing,
    offlineReadyForLocalAsr,
    localModelInstalled,
    runtimeAvailable: params.runtimeAvailable,
    storageAvailable: params.storageAvailable,
    summaryFa,
    summaryEn,
  };
}

function formatSrtTimestamp(sec: number): string {
  const totalMs = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function exportTranscriptContent(params: {
  readonly version: TranscriptVersionRecord;
  readonly layer: TranscriptDisplayLayer;
  readonly format: 'txt' | 'srt' | 'json';
  readonly projectName: string;
}): { readonly fileName: string; readonly mimeType: string; readonly content: string } {
  const pickText = (seg: TranscriptSegmentRecord): string => {
    if (params.layer === 'raw') return seg.rawText;
    if (params.layer === 'normalized') return seg.normalizedText;
    return seg.editedText;
  };

  if (params.format === 'txt') {
    const lines = params.version.segments.map((s) => {
      const st = Number.isFinite(s.startSec) ? Math.max(0, s.startSec) : 0;
      const en = Number.isFinite(s.endSec) ? Math.max(st, s.endSec) : st;
      return `[${st.toFixed(2)}s - ${en.toFixed(2)}s] ${s.speakerLabel}: ${pickText(s)}`;
    });
    return {
      fileName: sanitizeExportFilename(`${params.projectName}-transcript-${params.version.versionId}`, 'txt'),
      mimeType: 'text/plain;charset=utf-8',
      content: lines.join('\n'),
    };
  }

  if (params.format === 'srt') {
    const blocks = params.version.segments.map(
      (s, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(s.startSec)} --> ${formatSrtTimestamp(s.endSec)}\n${pickText(s)}\n`,
    );
    return {
      fileName: sanitizeExportFilename(`${params.projectName}-subtitles-${params.version.versionId}`, 'srt'),
      mimeType: 'application/x-subrip;charset=utf-8',
      content: blocks.join('\n'),
    };
  }

  return {
    fileName: sanitizeExportFilename(`${params.projectName}-transcript-${params.version.versionId}`, 'json'),
    mimeType: 'application/json;charset=utf-8',
    content: JSON.stringify(
      {
        versionId: params.version.versionId,
        versionNumber: params.version.versionNumber,
        kind: params.version.kind,
        layer: params.layer,
        createdAtMs: params.version.createdAtMs,
        segments: params.version.segments,
      },
      null,
      2,
    ),
  };
}

export function exportEdlJsonContent(
  edl: EditDecisionListSnapshot,
  projectName: string,
): { readonly fileName: string; readonly mimeType: string; readonly content: string } {
  return {
    fileName: sanitizeExportFilename(`${projectName}-edl-v${edl.edlVersion}`, 'json'),
    mimeType: 'application/json;charset=utf-8',
    content: serializeEdlSnapshot(edl),
  };
}

export interface LocalProjectIndexStore {
  loadRecent(): LocalRecentProjectSummary[];
  saveRecent(items: readonly LocalRecentProjectSummary[]): boolean;
}

export function createBrowserLocalProjectStore(
  storageKey = 'avapardaz_recent_projects_v1',
): LocalProjectIndexStore {
  return {
    loadRecent(): LocalRecentProjectSummary[] {
      try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(storageKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
          (p): p is LocalRecentProjectSummary =>
            p &&
            typeof p === 'object' &&
            typeof p.projectId === 'string' &&
            typeof p.projectName === 'string' &&
            typeof p.updatedAtMs === 'number' &&
            Number.isFinite(p.updatedAtMs),
        );
      } catch {
        return [];
      }
    },
    saveRecent(items: readonly LocalRecentProjectSummary[]): boolean {
      try {
        if (typeof localStorage === 'undefined') return false;
        localStorage.setItem(storageKey, JSON.stringify(items.slice(0, 12)));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Pure & Deterministic Studio Workflow Controller (AVP-P07-001)
 *
 * Centralizes state ownership for project lifecycle, transcript versioning,
 * honest local ASR state transitions, Mission 04 speech events, Mission 05 EDL
 * human review, and Mission 06 non-destructive rendering & export.
 * Guards against stale async callbacks, duplicate renders, and cross-project leakage.
 */
export class StudioWorkflowController {
  private state: StudioWorkflowState;
  private readonly budget: MemoryBudgetManager;
  private readonly renderEngine: AudioRenderEngine;
  private readonly projectStore: LocalProjectIndexStore | null;
  private readonly listeners = new Set<(next: StudioWorkflowState) => void>();

  private activeEventAbort: AbortController | null = null;
  private activeRenderAbort: AbortController | null = null;
  private activeAsrAbort: AbortController | null = null;
  private activeRenderArtifact: RenderOutputArtifact | null = null;
  private pauseRenderRequested = false;
  private disposed = false;

  constructor(options?: {
    readonly memoryBudgetManager?: MemoryBudgetManager;
    readonly renderEngine?: AudioRenderEngine;
    readonly projectStore?: LocalProjectIndexStore | null;
    readonly initialLocale?: WorkflowLocale;
    readonly initialTheme?: 'dark' | 'light';
  }) {
    this.budget = options?.memoryBudgetManager ?? getSharedMemoryBudgetManager();
    this.renderEngine =
      options?.renderEngine ?? new AudioRenderEngine({ memoryBudgetManager: this.budget });
    this.projectStore = options?.projectStore ?? null;

    const memSnap = this.budget.getSnapshot();
    const recentProjects = this.projectStore?.loadRecent() ?? [];

    this.state = {
      sessionGeneration: 1,
      projectId: 'proj_empty',
      projectName: 'پروژه بدون عنوان',
      locale: options?.initialLocale ?? 'fa',
      theme: options?.initialTheme ?? 'dark',
      persistenceState: this.projectStore ? 'IN_MEMORY_ONLY' : 'PERSISTENCE_UNAVAILABLE',
      persistenceNote: 'ذخیره‌سازی محلی تا زمان ثبت پروژه در حافظه فعال است.',
      sourceAudio: null,
      asrState: 'MODEL_NOT_INSTALLED',
      asrModelId: null,
      asrModelVersion: null,
      asrProgressPct: null,
      asrCurrentSegment: null,
      asrStatusMessage:
        'مدل محلی ASR هنوز بارگذاری نشده است. برای رونویسی واقعی، فایل وزن‌های مدل محلی (.onnx) را انتخاب کنید.',
      rawTranscriptVersion: null,
      transcriptVersions: [],
      activeTranscriptVersionId: null,
      transcriptDisplayLayer: 'raw',
      speechEventResult: null,
      isAnalyzingEvents: false,
      edlSnapshot: null,
      edlUndoStack: [],
      edlRedoStack: [],
      renderState: 'IDLE',
      renderProgress: null,
      lastRenderResult: null,
      recoverableCheckpoint: null,
      exportStatus: 'IDLE',
      exportSavedFileName: null,
      exportError: null,
      recentProjects,
      memoryPressure: memSnap.pressureLevel,
      memoryAccountedBytes: memSnap.accountedBytes,
      memoryHardLimitBytes: memSnap.hardLimitBytes,
    };
  }

  public getState(): StudioWorkflowState {
    return this.state;
  }

  public subscribe(listener: (state: StudioWorkflowState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(partial: Partial<StudioWorkflowState>): void {
    const memSnap = this.budget.getSnapshot();
    this.state = {
      ...this.state,
      ...partial,
      memoryPressure: memSnap.pressureLevel,
      memoryAccountedBytes: memSnap.accountedBytes,
      memoryHardLimitBytes: memSnap.hardLimitBytes,
    };
    for (const l of this.listeners) {
      l(this.state);
    }
  }

  private async disposeArtifactSafely(
    artifact: RenderOutputArtifact | null | undefined,
  ): Promise<void> {
    if (!artifact) return;
    try {
      await artifact.dispose();
    } catch {
      // Artifact.dispose() guarantees all remaining owned resources were released before throwing.
    }
  }

  /**
   * Centralized replacement helper ensuring no path can overwrite or clear
   * `lastRenderResult` without deterministically disposing the previous artifact.
   * For in-memory artifacts, reservation release executes synchronously before returning.
   */
  private replaceOwnedRenderArtifact(nextArtifact: RenderOutputArtifact | null): Promise<void> {
    const previousArtifact = this.activeRenderArtifact;
    if (nextArtifact && !nextArtifact.disposed) {
      if (nextArtifact instanceof CommittedRenderOutputArtifact) {
        nextArtifact.markActiveInWorkflow();
      }
      this.activeRenderArtifact = nextArtifact;
    } else {
      this.activeRenderArtifact = null;
    }

    if (previousArtifact && previousArtifact !== nextArtifact) {
      return this.disposeArtifactSafely(previousArtifact);
    }
    return Promise.resolve();
  }

  public setLocale(locale: WorkflowLocale): void {
    this.setState({ locale });
  }

  public setTheme(theme: 'dark' | 'light'): void {
    this.setState({ theme });
  }

  public setTranscriptDisplayLayer(layer: TranscriptDisplayLayer): void {
    this.setState({ transcriptDisplayLayer: layer });
  }

  /**
   * Switches or opens a project cleanly: aborts in-flight jobs, bumps sessionGeneration
   * to drop stale async callbacks, clears cross-project EDL/events/render state.
   */
  public openProject(params: {
    readonly projectId: string;
    readonly projectName: string;
    readonly sourceAudio: SourceAudioMetadataSummary | null;
    readonly initialSegments?: readonly TranscriptSegmentRecord[];
    readonly nowMs?: number;
  }): void {
    this.cancelAllInFlightOperations();
    void this.replaceOwnedRenderArtifact(null);
    const nextGen = this.state.sessionGeneration + 1;
    const nowMs =
      typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) && params.nowMs >= 0
        ? Math.trunc(params.nowMs)
        : Date.now();

    const rawVersion: TranscriptVersionRecord | null =
      params.initialSegments && params.initialSegments.length > 0
        ? Object.freeze({
            versionId: `tr_raw_${deterministicHexHash(`${params.projectId}:${nowMs}`)}`,
            versionNumber: 0,
            kind: 'RAW_ASR_IMMUTABLE' as const,
            createdAtMs: nowMs,
            changeSummary: 'نسخه خام اولیه (غیرقابل بازنویسی)',
            segments: Object.freeze(params.initialSegments.map((s) => Object.freeze({ ...s }))),
          })
        : null;

    let persistenceState: ProjectPersistenceState = 'IN_MEMORY_ONLY';
    let persistenceNote = 'پروژه در حافظه محلی باز است.';
    let recentProjects = this.state.recentProjects;

    if (this.projectStore && params.sourceAudio && !params.sourceAudio.isDemoFixture) {
      const entry: LocalRecentProjectSummary = {
        projectId: params.projectId,
        projectName: params.projectName,
        updatedAtMs: nowMs,
        durationSec: params.sourceAudio.durationSec,
        sourceFileName: params.sourceAudio.fileName,
        persistenceState: 'PERSISTED_LOCAL',
      };
      const updatedRecent = [
        entry,
        ...this.state.recentProjects.filter((r) => r.projectId !== params.projectId),
      ].slice(0, 12);
      const saved = this.projectStore.saveRecent(updatedRecent);
      if (saved) {
        persistenceState = 'PERSISTED_LOCAL';
        persistenceNote = 'فراداده پروژه در حافظه محلی مرورگر ذخیره شد.';
        recentProjects = updatedRecent;
      } else {
        persistenceState = 'PERSISTENCE_UNAVAILABLE';
        persistenceNote = 'خطا در ذخیره‌سازی محلی؛ پروژه فقط در حافظه موقت نگهداری می‌شود.';
      }
    }

    this.setState({
      sessionGeneration: nextGen,
      projectId: params.projectId,
      projectName: params.projectName,
      persistenceState,
      persistenceNote,
      sourceAudio: params.sourceAudio,
      rawTranscriptVersion: rawVersion,
      transcriptVersions: rawVersion ? [rawVersion] : [],
      activeTranscriptVersionId: rawVersion?.versionId ?? null,
      speechEventResult: null,
      isAnalyzingEvents: false,
      edlSnapshot: null,
      edlUndoStack: [],
      edlRedoStack: [],
      renderState: 'IDLE',
      renderProgress: null,
      lastRenderResult: null,
      recoverableCheckpoint: null,
      exportStatus: 'IDLE',
      exportSavedFileName: null,
      exportError: null,
      recentProjects,
    });
  }

  /** Updates honest local ASR lifecycle state without ever faking inference */
  public setAsrState(params: {
    readonly state: LocalAsrLifecycleState;
    readonly modelId?: string | null;
    readonly modelVersion?: string | null;
    readonly progressPct?: number | null;
    readonly currentSegment?: string | null;
    readonly message: string;
  }): void {
    const safeProgressPct =
      typeof params.progressPct === 'number' && Number.isFinite(params.progressPct)
        ? Math.max(0, Math.min(100, params.progressPct))
        : null;
    this.setState({
      asrState: params.state,
      asrModelId: params.modelId !== undefined ? params.modelId : this.state.asrModelId,
      asrModelVersion:
        params.modelVersion !== undefined ? params.modelVersion : this.state.asrModelVersion,
      asrProgressPct: safeProgressPct,
      asrCurrentSegment: params.currentSegment ?? null,
      asrStatusMessage: params.message,
    });
  }

  public cancelAsr(): void {
    if (this.activeAsrAbort) {
      this.activeAsrAbort.abort();
      this.activeAsrAbort = null;
    }
    if (this.state.asrState === 'INFERENCE_RUNNING' || this.state.asrState === 'MODEL_LOADING') {
      this.setAsrState({
        state: 'TRANSCRIPTION_CANCELLED',
        message: 'فرایند رونویسی محلی توسط کاربر لغو شد.',
      });
    }
  }

  /**
   * Explicit manual transcript edit: ALWAYS creates a new TranscriptVersionRecord,
   * NEVER mutates rawTranscriptVersion, and automatically marks existing EDL proposals STALE!
   */
  public editTranscriptSegment(params: {
    readonly segmentId: string;
    readonly newText: string;
    readonly nowMs?: number;
  }): { readonly ok: boolean; readonly newVersion: TranscriptVersionRecord | null } {
    const active = this.getActiveTranscriptVersion();
    if (!active) return { ok: false, newVersion: null };
    const idx = active.segments.findIndex((s) => s.segmentId === params.segmentId);
    if (idx < 0) return { ok: false, newVersion: null };

    const nowMs =
      typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) && params.nowMs >= 0
        ? Math.trunc(params.nowMs)
        : Date.now();
    const nextVersionNumber = this.state.transcriptVersions.length;
    const nextSegments = active.segments.map((seg) =>
      seg.segmentId === params.segmentId
        ? Object.freeze({
            ...seg,
            editedText: params.newText,
          })
        : seg,
    );

    const newVersion: TranscriptVersionRecord = Object.freeze({
      versionId: `tr_v${nextVersionNumber}_${deterministicHexHash(`${this.state.projectId}:${params.segmentId}:${params.newText}:${nowMs}`)}`,
      versionNumber: nextVersionNumber,
      kind: 'USER_CORRECTED',
      createdAtMs: nowMs,
      changeSummary: `ویرایش دستی قطعه ${params.segmentId}`,
      segments: Object.freeze(nextSegments),
    });

    // Revalidate existing EDL against the new transcript version so outdated proposals become STALE
    let updatedEdl = this.state.edlSnapshot;
    if (updatedEdl && this.state.sourceAudio) {
      updatedEdl = EditDecisionEngine.revalidateAndMarkStale(updatedEdl, {
        sourceAudioHash: this.state.sourceAudio.sourceAudioHash,
        transcriptVersion: newVersion.versionId,
        nowMs,
      });
    }

    this.setState({
      transcriptVersions: [...this.state.transcriptVersions, newVersion],
      activeTranscriptVersionId: newVersion.versionId,
      transcriptDisplayLayer: 'user_corrected',
      edlSnapshot: updatedEdl,
    });

    return { ok: true, newVersion };
  }

  /**
   * Synchronizes updated transcript segments from ASR, forced alignment, linguistic edits,
   * or Undo/Redo into the versioned transcript registry without mutating rawTranscriptVersion.
   */
  public syncTranscriptFromSegments(params: {
    readonly segments: readonly TranscriptSegmentRecord[];
    readonly changeSummary: string;
    readonly establishRawIfEmpty?: boolean;
    readonly invalidateEdl?: boolean;
    readonly nowMs?: number;
  }): TranscriptVersionRecord | null {
    const nowMs =
      typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) && params.nowMs >= 0
        ? Math.trunc(params.nowMs)
        : Date.now();
    const frozenSegments = Object.freeze(
      params.segments.map((s) => Object.freeze({ ...s })),
    );

    if (!this.state.rawTranscriptVersion && params.establishRawIfEmpty) {
      if (frozenSegments.length === 0) return null;
      const rawVersion: TranscriptVersionRecord = Object.freeze({
        versionId: `tr_raw_${deterministicHexHash(`${this.state.projectId}:${nowMs}:${frozenSegments.length}`)}`,
        versionNumber: 0,
        kind: 'RAW_ASR_IMMUTABLE' as const,
        createdAtMs: nowMs,
        changeSummary: params.changeSummary || 'نسخه خام اولیه ASR (غیرقابل بازنویسی)',
        segments: frozenSegments,
      });

      let updatedEdl = this.state.edlSnapshot;
      if (updatedEdl && this.state.sourceAudio && params.invalidateEdl) {
        updatedEdl = EditDecisionEngine.revalidateAndMarkStale(updatedEdl, {
          sourceAudioHash: this.state.sourceAudio.sourceAudioHash,
          transcriptVersion: rawVersion.versionId,
          nowMs,
        });
      }

      this.setState({
        rawTranscriptVersion: rawVersion,
        transcriptVersions: [rawVersion],
        activeTranscriptVersionId:
          this.state.edlSnapshot && !params.invalidateEdl
            ? this.state.activeTranscriptVersionId
            : rawVersion.versionId,
        edlSnapshot: updatedEdl,
      });
      return rawVersion;
    }

    if (frozenSegments.length === 0 && this.state.transcriptVersions.length === 0) {
      return null;
    }

    const nextVersionNumber = this.state.transcriptVersions.length;
    const contentSig = frozenSegments
      .map((s) => `${s.segmentId}:${s.editedText}:${s.normalizedText}`)
      .join('|');
    const newVersion: TranscriptVersionRecord = Object.freeze({
      versionId: `tr_v${nextVersionNumber}_${deterministicHexHash(`${this.state.projectId}:${nowMs}:${contentSig}`)}`,
      versionNumber: nextVersionNumber,
      kind: 'USER_CORRECTED',
      createdAtMs: nowMs,
      changeSummary: params.changeSummary,
      segments: frozenSegments,
    });

    const hasExistingEdl = this.state.edlSnapshot !== null;
    let updatedEdl = this.state.edlSnapshot;
    if (updatedEdl && this.state.sourceAudio && params.invalidateEdl) {
      updatedEdl = EditDecisionEngine.revalidateAndMarkStale(updatedEdl, {
        sourceAudioHash: this.state.sourceAudio.sourceAudioHash,
        transcriptVersion: newVersion.versionId,
        nowMs,
      });
    }

    this.setState({
      transcriptVersions: [...this.state.transcriptVersions, newVersion],
      activeTranscriptVersionId:
        hasExistingEdl && !params.invalidateEdl
          ? this.state.activeTranscriptVersionId
          : newVersion.versionId,
      edlSnapshot: updatedEdl,
    });
    return newVersion;
  }

  public getActiveTranscriptVersion(): TranscriptVersionRecord | null {
    if (!this.state.activeTranscriptVersionId) return this.state.rawTranscriptVersion;
    return (
      this.state.transcriptVersions.find(
        (v) => v.versionId === this.state.activeTranscriptVersionId,
      ) ?? this.state.rawTranscriptVersion
    );
  }

  /**
   * Runs real Mission 04 SpeechEventEngine + Mission 05 EditDecisionEngine locally,
   * guarded by sessionGeneration so stale async completions are safely ignored.
   */
  public async analyzeSpeechEventsAndBuildEdl(params: {
    readonly trackId: string;
    readonly pcmMono: Float32Array;
    readonly sampleRate: SampleRate;
    readonly wordTokens: readonly PersianWordToken[];
    readonly nowMs?: number;
  }): Promise<{
    readonly ok: boolean;
    readonly eventResult: SpeechEventAnalysisResult | null;
    readonly edl: EditDecisionListSnapshot | null;
  }> {
    if (!this.state.sourceAudio) {
      return { ok: false, eventResult: null, edl: null };
    }
    const gen = this.state.sessionGeneration;
    this.activeEventAbort?.abort();
    const abortCtrl = new AbortController();
    this.activeEventAbort = abortCtrl;

    this.setState({ isAnalyzingEvents: true });

    try {
      const timedTokens = convertWordTokensToTimedTokens(params.wordTokens, params.trackId);
      const eventResult = await SpeechEventEngine.analyzeRecording({
        trackId: params.trackId,
        sampleRate: params.sampleRate,
        totalSamples: params.pcmMono.length,
        pcmMono: params.pcmMono,
        tokens: timedTokens,
        memoryBudgetManager: this.budget,
        signal: abortCtrl.signal,
      });

      // Drop stale completion if project switched or aborted
      if (gen !== this.state.sessionGeneration || abortCtrl.signal.aborted) {
        return { ok: false, eventResult: null, edl: null };
      }

      const latestRecordedVersion =
        this.state.transcriptVersions.length > 0
          ? this.state.transcriptVersions[this.state.transcriptVersions.length - 1]
          : this.getActiveTranscriptVersion();
      const activeTrVersion =
        latestRecordedVersion?.versionId ?? `tr_v0_${this.state.projectId}`;

      const edl = await EditDecisionEngine.generateEdl(
        {
          context: {
            projectId: this.state.projectId,
            sourceAudioId: this.state.sourceAudio.sourceAudioId,
            sourceAudioHash: this.state.sourceAudio.sourceAudioHash,
            transcriptVersion: activeTrVersion,
            eventDetectorVersion: eventResult.engineVersion,
            sampleRate: params.sampleRate,
            totalSourceSamples: params.pcmMono.length,
          },
          events: eventResult.events,
          tokens: timedTokens,
          nowMs: params.nowMs,
          signal: abortCtrl.signal,
        },
        this.budget,
      );

      if (gen !== this.state.sessionGeneration || abortCtrl.signal.aborted) {
        return { ok: false, eventResult: null, edl: null };
      }

      this.setState({
        activeTranscriptVersionId: latestRecordedVersion?.versionId ?? this.state.activeTranscriptVersionId,
        speechEventResult: eventResult,
        edlSnapshot: edl,
        edlUndoStack: [],
        edlRedoStack: [],
        isAnalyzingEvents: false,
      });

      return { ok: true, eventResult, edl };
    } finally {
      if (this.activeEventAbort === abortCtrl) {
        this.activeEventAbort = null;
      }
      if (gen === this.state.sessionGeneration && this.state.isAnalyzingEvents) {
        this.setState({ isAnalyzingEvents: false });
      }
    }
  }

  /** Explicit human EDL decision actions (never implicit on click/preview/seek) */
  public applyHumanDecision(params: {
    readonly action: 'APPROVE' | 'REJECT' | 'REQUEST_REVIEW';
    readonly proposalId: string;
    readonly reason?: string;
    readonly nowMs?: number;
  }): { readonly ok: boolean; readonly failure: EditValidationFailure | null } {
    const edl = this.state.edlSnapshot;
    const src = this.state.sourceAudio;
    if (!edl || !src) return { ok: false, failure: null };

    const result =
      params.action === 'APPROVE'
        ? EditDecisionEngine.approveProposal(edl, params.proposalId, {
            reason: params.reason,
            nowMs: params.nowMs,
          })
        : params.action === 'REJECT'
          ? EditDecisionEngine.rejectProposal(edl, params.proposalId, {
              reason: params.reason,
              nowMs: params.nowMs,
            })
          : EditDecisionEngine.requestReview(edl, params.proposalId, {
              reason: params.reason,
              nowMs: params.nowMs,
            });

    if (!result.ok) {
      return { ok: false, failure: result.failure };
    }

    this.setState({
      edlSnapshot: result.snapshot,
      edlUndoStack: [...this.state.edlUndoStack, edl].slice(-50),
      edlRedoStack: [],
    });
    return { ok: true, failure: null };
  }

  public reviseProposalBoundaries(params: {
    readonly proposalId: string;
    readonly newStartSample: number;
    readonly newEndSample: number;
    readonly reason?: string;
    readonly nowMs?: number;
  }): {
    readonly ok: boolean;
    readonly updatedProposal: EditProposal | null;
    readonly failure: EditValidationFailure | null;
  } {
    const edl = this.state.edlSnapshot;
    if (!edl) return { ok: false, updatedProposal: null, failure: null };

    const result = EditDecisionEngine.reviseProposalBoundaries(
      edl,
      params.proposalId,
      {
        startSample: params.newStartSample,
        endSample: params.newEndSample,
      },
      {
        reason: params.reason,
        nowMs: params.nowMs,
      },
    );

    if (!result.ok) {
      return { ok: false, updatedProposal: null, failure: result.failure };
    }

    this.setState({
      edlSnapshot: result.snapshot,
      edlUndoStack: [...this.state.edlUndoStack, edl].slice(-50),
      edlRedoStack: [],
    });
    return { ok: true, updatedProposal: result.updatedProposal, failure: null };
  }

  public undoEdlDecision(): boolean {
    if (this.state.edlUndoStack.length === 0 || !this.state.edlSnapshot) return false;
    const prev = this.state.edlUndoStack[this.state.edlUndoStack.length - 1];
    this.setState({
      edlSnapshot: prev,
      edlUndoStack: this.state.edlUndoStack.slice(0, -1),
      edlRedoStack: [...this.state.edlRedoStack, this.state.edlSnapshot],
    });
    return true;
  }

  public redoEdlDecision(): boolean {
    if (this.state.edlRedoStack.length === 0 || !this.state.edlSnapshot) return false;
    const next = this.state.edlRedoStack[this.state.edlRedoStack.length - 1];
    this.setState({
      edlSnapshot: next,
      edlUndoStack: [...this.state.edlUndoStack, this.state.edlSnapshot],
      edlRedoStack: this.state.edlRedoStack.slice(0, -1),
    });
    return true;
  }

  /**
   * Executes Mission 06 non-destructive render with duplicate-render protection,
   * real engine progress, pause/cancel/checkpoint support, and post-render validation gate.
   */
  public async startRender(params: {
    readonly pcmChannels?: readonly Float32Array[];
    readonly source?: ChunkedPcmSource;
    readonly config: AudioRenderConfig;
    readonly resumeCheckpoint?: RenderCheckpoint | null;
    readonly nowMs?: number;
  }): Promise<AudioRenderResult | null> {
    if (this.disposed) {
      return null;
    }
    if (
      this.state.renderState === 'QUEUED' ||
      this.state.renderState === 'RENDERING' ||
      this.state.renderState === 'VALIDATING' ||
      this.state.renderState === 'PLANNING' ||
      this.state.renderState === 'FINALIZING' ||
      this.state.renderState === 'VALIDATING_OUTPUT'
    ) {
      // Duplicate-render prevention guard
      return null;
    }

    const edl = this.state.edlSnapshot;
    const srcMeta = this.state.sourceAudio;
    if (!edl || !srcMeta) return null;

    const gen = this.state.sessionGeneration;
    const abortCtrl = new AbortController();
    this.activeRenderAbort = abortCtrl;
    this.pauseRenderRequested = false;

    const source: ChunkedPcmSource =
      params.source ??
      createPlanarArrayPcmSource({
        sourceAudioId: srcMeta.sourceAudioId,
        sourceAudioHash: srcMeta.sourceAudioHash,
        sampleRate: srcMeta.sampleRate,
        channels: params.pcmChannels ?? [new Float32Array(0)],
      });

    const activeTr = this.getActiveTranscriptVersion()?.versionId ?? edl.transcriptVersion;

    // Dispose any previously retained render artifact and clear lastRenderResult before starting.
    const previousDisposal = this.replaceOwnedRenderArtifact(null);

    this.setState({
      renderState: 'QUEUED',
      lastRenderResult: null,
      exportStatus: 'IDLE',
      exportError: null,
      exportSavedFileName: null,
    });

    await previousDisposal;

    if (gen !== this.state.sessionGeneration || this.disposed || abortCtrl.signal.aborted) {
      if (this.activeRenderAbort === abortCtrl) {
        this.activeRenderAbort = null;
      }
      return null;
    }

    let lastProgressEmitState: RenderLifecycleState | null = null;
    let lastProgressEmitPct: number | null = null;
    let lastProgressEmitWallMs = 0;

    const request = {
      edl,
      source,
      expectedSourceAudioHash: srcMeta.sourceAudioHash,
      expectedTranscriptVersion: activeTr,
      expectedEdlVersion: edl.edlVersion,
      config: params.config,
      abortSignal: abortCtrl.signal,
      shouldPauseUser: () => this.pauseRenderRequested,
      nowMs: params.nowMs,
      onProgress: (snap: RenderProgressSnapshot) => {
        if (gen !== this.state.sessionGeneration || this.disposed) return;
        const nowWall = Date.now();
        const isSameRenderingState =
          snap.state === 'RENDERING' && lastProgressEmitState === 'RENDERING';
        const pctDelta =
          snap.progressPercent !== null && lastProgressEmitPct !== null
            ? Math.abs(snap.progressPercent - lastProgressEmitPct)
            : 100;
        if (isSameRenderingState && pctDelta < 2 && nowWall - lastProgressEmitWallMs < 50) {
          return;
        }
        lastProgressEmitState = snap.state;
        lastProgressEmitPct = snap.progressPercent;
        lastProgressEmitWallMs = nowWall;
        this.setState({
          renderState: snap.state,
          renderProgress: snap,
        });
      },
    };

    try {
      const result = params.resumeCheckpoint
        ? await this.renderEngine.resumeFromCheckpoint(request, params.resumeCheckpoint)
        : await this.renderEngine.render(request);

      if (gen !== this.state.sessionGeneration || this.disposed) {
        await this.disposeArtifactSafely(result.outputArtifact);
        return null;
      }

      const nextExportStatus: ExportArtifactStatus =
        result.ok && result.postValidation?.passed
          ? 'VALIDATED_READY'
          : result.state === 'FAILED' || result.state === 'FAILED_VALIDATION'
            ? 'FAILED'
            : 'IDLE';

      const nextArtifact =
        result.ok && result.postValidation?.passed ? result.outputArtifact : null;
      if (!nextArtifact && result.outputArtifact) {
        await this.disposeArtifactSafely(result.outputArtifact);
      }

      await this.replaceOwnedRenderArtifact(nextArtifact);

      this.setState({
        renderState: result.state,
        lastRenderResult: result,
        recoverableCheckpoint: result.checkpoint,
        exportStatus: nextExportStatus,
        exportError: result.ok ? null : (result.failureReason ?? null),
      });

      return result;
    } catch (err) {
      if (gen === this.state.sessionGeneration && !this.disposed) {
        await this.replaceOwnedRenderArtifact(null);
        const message = err instanceof Error ? err.message : String(err);
        this.setState({
          renderState: 'FAILED',
          lastRenderResult: null,
          exportStatus: 'FAILED',
          exportError: message,
        });
      }
      return null;
    } finally {
      if (this.activeRenderAbort === abortCtrl) {
        this.activeRenderAbort = null;
      }
      this.pauseRenderRequested = false;
    }
  }

  public requestPauseRender(): void {
    if (this.state.renderState === 'RENDERING') {
      this.pauseRenderRequested = true;
    }
  }

  public cancelRender(): void {
    if (this.activeRenderAbort) {
      this.activeRenderAbort.abort();
      this.activeRenderAbort = null;
    }
  }

  public markExportSaved(fileName: string): void {
    if (this.state.exportStatus !== 'VALIDATED_READY' && this.state.exportStatus !== 'SAVED_OR_DOWNLOADED') {
      return;
    }
    this.setState({
      exportStatus: 'SAVED_OR_DOWNLOADED',
      exportSavedFileName: sanitizeExportFilename(fileName),
      exportError: null,
    });
  }

  public markExportFailed(reason: string): void {
    this.setState({
      exportStatus: 'FAILED',
      exportError: reason,
    });
  }

  public cancelAllInFlightOperations(): void {
    this.activeEventAbort?.abort();
    this.activeEventAbort = null;
    this.activeRenderAbort?.abort();
    this.activeRenderAbort = null;
    this.activeAsrAbort?.abort();
    this.activeAsrAbort = null;
    this.pauseRenderRequested = false;
  }

  public dispose(): void {
    if (this.disposed) {
      this.listeners.clear();
      return;
    }
    this.disposed = true;
    this.cancelAllInFlightOperations();
    void this.replaceOwnedRenderArtifact(null);
    const memSnap = this.budget.getSnapshot();
    this.state = {
      ...this.state,
      sessionGeneration: this.state.sessionGeneration + 1,
      renderProgress: null,
      lastRenderResult: null,
      recoverableCheckpoint: null,
      exportStatus: 'IDLE',
      memoryPressure: memSnap.pressureLevel,
      memoryAccountedBytes: memSnap.accountedBytes,
      memoryHardLimitBytes: memSnap.hardLimitBytes,
    };
    this.listeners.clear();
  }
}

export function getSpeechEventsForSegment(
  events: readonly SpeechEvent[],
  startSec: number,
  endSec: number,
): SpeechEvent[] {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return [];
  }
  return events.filter(
    (ev) =>
      Number.isFinite(ev.startSec) &&
      Number.isFinite(ev.endSec) &&
      ev.endSec > startSec &&
      ev.startSec < endSec,
  );
}
