import type { LocalNeuralTranscriptionResult } from '../../asr-core/LocalSherpaNeuralEngine';

export type CompanionJobState =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export interface CompanionSourceIdentity {
  readonly documentId?: string;
  readonly displayName?: string;
  readonly filePath?: string;
  readonly fileSizeBytes?: number;
  readonly fileModifiedMs?: number;
  readonly audioSha256?: string;
}

export interface CompanionJobRecord {
  readonly jobId: string;
  readonly status: CompanionJobState;
  readonly modelId: string | null;
  readonly languageHint: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly sourceName: string;
  readonly sourceIdentity?: CompanionSourceIdentity;
  readonly progressPct: number;
  readonly currentChunk: number;
  readonly totalChunks: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly elapsedMs: number;
  readonly partialText: string;
  readonly result: LocalNeuralTranscriptionResult | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}
