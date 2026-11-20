import type {
  AudioAsset,
  PersianWordToken,
  SmartRecommendation,
  Track,
} from '../contracts/v1_2';

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
}
