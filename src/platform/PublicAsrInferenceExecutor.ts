/**
 * AVP-PUBLIC-DATAPLANE-REAL-AUDIO-010
 * Authoritative Inference Executor Contract for the Public ASR Data Plane (`/v1/*`).
 *
 * Enforces strict separation between:
 * - Genuine model inference (`MODEL_INFERENCE`) over verified canonical 16 kHz PCM files.
 * - Honest model readiness probing (`MODEL_NOT_INSTALLED`, `MODEL_NOT_READY`,
 *   `MODEL_INTEGRITY_FAILURE`, `REQUIRES_GPU_WORKER`, `WORKER_UNAVAILABLE`, `AVAILABLE_NOW`).
 */

import type { DomainProfileName } from '../ai-engine/asr/IndependentAsrModelDevelopmentEngine';
import type { PublicModelAvailability } from './PlatformContractsAndSchemas';
import type { PublicAudioArtifact } from './PublicAudioArtifactIngest';

export interface PublicAsrModelReadiness {
  modelId: string;
  modelVersion: string;
  availability: PublicModelAvailability;
  ready: boolean;
  reason: string;
  timestampsSupported: boolean;
  diarizationSupported: boolean;
  modelDigestSha256: string | null;
  backendEngine: string;
}

export interface PublicAsrTranscriptionRequest {
  modelId: string;
  language: 'auto' | 'fa' | 'en' | 'fa-en';
  domainProfile: DomainProfileName;
  timestamps: boolean;
  diarization: boolean;
  abortSignal?: AbortSignal;
}

export interface PublicAsrSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface PublicAsrInferenceResult {
  rawText: string;
  normalizedText: string;
  language: string;
  segments?: PublicAsrSegment[];
  processedSamples16k: number;
  modelId: string;
  modelVersion: string;
  modelDigestSha256: string;
  provenance: 'MODEL_INFERENCE';
  backendEngine: string;
  timestampsAvailable: boolean;
  diarizationAvailable: boolean;
}

export interface PublicAsrInferenceExecutor {
  getModelReadiness(modelId: string): Promise<PublicAsrModelReadiness>;
  transcribe(
    audio: PublicAudioArtifact,
    request: PublicAsrTranscriptionRequest
  ): Promise<PublicAsrInferenceResult>;
}
