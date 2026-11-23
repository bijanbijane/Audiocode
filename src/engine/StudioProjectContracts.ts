import type {
  AudioAsset,
  PersianWordToken,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';

/**
 * Runtime-only memory reservation ownership handle.
 * It must never be serialized into persistent project documents or manifests.
 */
export interface ProjectRuntimeResourceLease {
  readonly disposed: boolean;
  dispose(): void;
}

/** Stable project payload shared by audio fixtures and streaming ingestion. */
export interface LoadedStudioProject {
  projectName: string;
  sampleRate: number;
  assets: Record<string, AudioAsset>;
  pcmSources: Record<string, Float32Array>;
  tracks: Track[];
  tokens: PersianWordToken[];
  recommendations: SmartRecommendation[];
  resamplerStats: {
    inputSampleRate: number;
    outputSampleRate: number;
    cutoffHz: number;
    filterTaps: number;
    aliasingAttenuationDb: number;
    downsampledLength: number;
  };
  /** Runtime-only memory reservation ownership handle. */
  runtimeResourceLease?: ProjectRuntimeResourceLease;
}
