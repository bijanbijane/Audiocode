import type { DiarizationResultPayload } from '../../intelligence/SpeechIntelligenceContracts';
import { runWeSpeakerDiarizationCapability } from '../../intelligence/DiarizationAlignmentEngine';
import { sha256Bytes } from '../../utils/StreamingSha256';
import { SileroVadOnnxRunner } from './SileroVadOnnxRunner';
import { SpeakerEmbeddingOnnxRunner } from './SpeakerEmbeddingOnnxRunner';
import type { OrtRuntimeProvider } from './UnifiedOnnxPersianAsrEngine';

export interface VerifiedOnnxModelAsset {
  readonly bytes: Uint8Array;
  readonly expectedByteLength: number;
  readonly expectedSha256Hex: string;
  readonly modelId: string;
  readonly modelVersion: string;
}

export interface LocalWeSpeakerDiarizationOptions {
  readonly vadStartThreshold?: number;
  readonly vadEndThreshold?: number;
  readonly vadMinSpeechMs?: number;
  readonly vadMinSilenceMs?: number;
  readonly vadSpeechPadMs?: number;
  readonly embeddingWindowDurationSec?: number;
  readonly embeddingHopDurationSec?: number;
  readonly similarityThreshold?: number;
}

export interface LocalDiarizationReadiness {
  readonly ready: boolean;
  readonly vadModelId: string | null;
  readonly speakerModelId: string | null;
  readonly executionProvider: 'local-onnx';
}

/**
 * Coordinates the two local ONNX models required for single-channel diarization.
 *
 * Model bytes must be read by the caller from an already-installed, locally
 * verified model store (for example, OPFS). This service performs a second
 * exact size/SHA-256 check before opening either ONNX session; it never downloads
 * model files and never sends PCM or embeddings to a remote service.
 */
export class LocalWeSpeakerDiarizationService {
  private readonly vadRunner: SileroVadOnnxRunner;
  private readonly speakerRunner: SpeakerEmbeddingOnnxRunner;
  private loaded = false;
  private vadModelId: string | null = null;
  private speakerModelId: string | null = null;
  private speakerModelVersion: string | null = null;

  constructor(
    ortProvider: OrtRuntimeProvider,
    private readonly executionProviders: ('wasm' | 'cpu')[] = ['wasm'],
    private readonly options: LocalWeSpeakerDiarizationOptions = {},
  ) {
    this.vadRunner = new SileroVadOnnxRunner(ortProvider);
    this.speakerRunner = new SpeakerEmbeddingOnnxRunner(
      ortProvider,
      'feats',
      'B_T_M',
      'KALDI_FBANK',
      'lens',
      'embs',
    );
  }

  public getReadiness(): LocalDiarizationReadiness {
    return {
      ready: this.loaded,
      vadModelId: this.vadModelId,
      speakerModelId: this.speakerModelId,
      executionProvider: 'local-onnx',
    };
  }

  public async loadModels(params: {
    readonly vadModel: VerifiedOnnxModelAsset;
    readonly speakerEmbeddingModel: VerifiedOnnxModelAsset;
  }): Promise<void> {
    if (this.loaded) {
      throw new Error('LOCAL_DIARIZATION_MODELS_ALREADY_LOADED');
    }

    this.verifyModelAsset(params.vadModel, 'SILERO_VAD');
    this.verifyModelAsset(params.speakerEmbeddingModel, 'WESPEAKER');

    let vadLoaded = false;
    try {
      await this.vadRunner.loadModel(params.vadModel.bytes, this.executionProviders);
      vadLoaded = true;
      await this.speakerRunner.loadModel(
        params.speakerEmbeddingModel.bytes,
        this.executionProviders,
      );
      this.vadModelId = params.vadModel.modelId;
      this.speakerModelId = params.speakerEmbeddingModel.modelId;
      this.speakerModelVersion = params.speakerEmbeddingModel.modelVersion;
      this.loaded = true;
    } catch (error) {
      if (vadLoaded) await this.vadRunner.unloadModel();
      await this.speakerRunner.unloadModel();
      this.vadModelId = null;
      this.speakerModelId = null;
      this.speakerModelVersion = null;
      this.loaded = false;
      throw error;
    }
  }

  public async diarize(params: {
    readonly recordingId: string;
    readonly pcm16kMono: Float32Array;
  }): Promise<DiarizationResultPayload> {
    if (!this.loaded || !this.speakerModelVersion) {
      throw new Error('LOCAL_DIARIZATION_MODELS_NOT_LOADED');
    }
    if (!(params.pcm16kMono instanceof Float32Array) || params.pcm16kMono.length === 0) {
      throw new TypeError('LOCAL_DIARIZATION_PCM16K_MONO_REQUIRED');
    }

    const vadSpeechSegments = await this.vadRunner.detectSpeechSegments(
      params.pcm16kMono,
      {
        startThreshold: this.options.vadStartThreshold,
        endThreshold: this.options.vadEndThreshold,
        minSpeechMs: this.options.vadMinSpeechMs,
        minSilenceMs: this.options.vadMinSilenceMs,
        speechPadMs: this.options.vadSpeechPadMs,
      },
    );

    return runWeSpeakerDiarizationCapability({
      recordingId: params.recordingId,
      pcm16kMono: params.pcm16kMono,
      vadSpeechSegments,
      runner: this.speakerRunner,
      similarityThreshold: this.options.similarityThreshold,
      modelVersion: this.speakerModelVersion,
      windowDurationSec: this.options.embeddingWindowDurationSec,
      hopDurationSec: this.options.embeddingHopDurationSec,
    });
  }

  public async dispose(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.speakerRunner.unloadModel();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.vadRunner.unloadModel();
    } catch (error) {
      errors.push(error);
    }
    this.loaded = false;
    this.vadModelId = null;
    this.speakerModelId = null;
    this.speakerModelVersion = null;
    if (errors.length > 0) {
      throw new AggregateError(errors, 'LOCAL_DIARIZATION_MODEL_DISPOSAL_FAILED');
    }
  }

  private verifyModelAsset(asset: VerifiedOnnxModelAsset, label: 'SILERO_VAD' | 'WESPEAKER'): void {
    if (!(asset.bytes instanceof Uint8Array) || asset.bytes.byteLength === 0) {
      throw new TypeError(`LOCAL_DIARIZATION_${label}_MODEL_BYTES_REQUIRED`);
    }
    if (
      !Number.isSafeInteger(asset.expectedByteLength) ||
      asset.expectedByteLength <= 0 ||
      asset.bytes.byteLength !== asset.expectedByteLength
    ) {
      throw new Error(`LOCAL_DIARIZATION_${label}_MODEL_SIZE_MISMATCH`);
    }
    if (!/^[a-f0-9]{64}$/i.test(asset.expectedSha256Hex)) {
      throw new TypeError(`LOCAL_DIARIZATION_${label}_MODEL_SHA256_INVALID`);
    }
    if (sha256Bytes(asset.bytes) !== asset.expectedSha256Hex.toLowerCase()) {
      throw new Error(`LOCAL_DIARIZATION_${label}_MODEL_SHA256_MISMATCH`);
    }
    if (!asset.modelId.trim() || !asset.modelVersion.trim()) {
      throw new TypeError(`LOCAL_DIARIZATION_${label}_MODEL_IDENTITY_REQUIRED`);
    }
  }
}
