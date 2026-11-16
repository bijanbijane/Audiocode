import { SampleRate } from '../../../src/contracts/timebase.contract';

export interface StudioRecordingSessionMeta {
  readonly recordingSessionId: string;
  readonly sampleRate: SampleRate;
  readonly channelCount: number;
  readonly flushedBlocksCount: number;
  readonly totalRecordedSeconds: number;
}

export interface OpfsWritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsFileHandleLike {
  createWritable(): Promise<OpfsWritableLike>;
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}

export interface OpfsDirectoryLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
}

export interface DirectRecorderEnv {
  readonly getStorageRoot?: () => Promise<OpfsDirectoryLike>;
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createAudioContext?: (options: AudioContextOptions) => AudioContext;
}

/**
 * Crash-Resilient Direct OPFS Studio Recorder (Sections 2.6, 11 & 12)
 * Disables destructive browser telephony DSP (echoCancellation, noiseSuppression, autoGainControl)
 * and atomically flushes 5-second raw studio PCM blocks to OPFS for zero-loss crash safety.
 */
export class DirectStudioOpfsRecorder {
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private isRecording = false;
  private flushedBlocksCount = 0;
  private totalSamplesFlushed = 0;
  private activeSampleRate: SampleRate = 48000;
  private readonly env: DirectRecorderEnv;

  constructor(env: DirectRecorderEnv = {}) {
    this.env = env;
  }

  public getIsRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Requests raw studio microphone access with browser telephony processing explicitly disabled.
   */
  public async requestRawStudioMicrophone(
    preferredDeviceId?: string,
    targetSampleRate: SampleRate = 48000,
  ): Promise<{ stream: MediaStream; actualSampleRate: number }> {
    const getUserMediaFn =
      this.env.getUserMedia ??
      ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));

    const stream = await getUserMediaFn({
      audio: {
        deviceId: preferredDeviceId ? { exact: preferredDeviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: targetSampleRate },
        channelCount: { ideal: 1 },
      },
      video: false,
    });

    this.mediaStream = stream;
    this.audioCtx = this.env.createAudioContext
      ? this.env.createAudioContext({ sampleRate: targetSampleRate, latencyHint: 'interactive' })
      : new AudioContext({ sampleRate: targetSampleRate, latencyHint: 'interactive' });

    this.isRecording = true;
    this.activeSampleRate = (this.audioCtx.sampleRate || targetSampleRate) as SampleRate;

    return {
      stream,
      actualSampleRate: this.activeSampleRate,
    };
  }

  /**
   * Atomically writes a 5-second recorded PCM block to OPFS so prior minutes survive tab crash/power loss.
   */
  public async flush5SecondRecordedBlockToOpfs(
    recordingSessionId: string,
    blockIndex: number,
    pcmChunk: Float32Array,
  ): Promise<StudioRecordingSessionMeta> {
    const root = this.env.getStorageRoot
      ? await this.env.getStorageRoot()
      : ((await navigator.storage.getDirectory()) as unknown as OpfsDirectoryLike);

    const recDir = await root.getDirectoryHandle('live-studio-recordings', { create: true });
    const sessionDir = await recDir.getDirectoryHandle(recordingSessionId, { create: true });

    const blockFileName = `rec_block_${String(blockIndex).padStart(6, '0')}.pcm`;
    const fileHandle = await sessionDir.getFileHandle(blockFileName, { create: true });
    const writable = await fileHandle.createWritable();

    try {
      await writable.write(
        new Uint8Array(pcmChunk.buffer, pcmChunk.byteOffset, pcmChunk.byteLength),
      );
    } finally {
      await writable.close();
    }

    this.flushedBlocksCount = Math.max(this.flushedBlocksCount, blockIndex + 1);
    this.totalSamplesFlushed += pcmChunk.length;

    const sr = (this.audioCtx?.sampleRate ?? this.activeSampleRate) as SampleRate;
    return {
      recordingSessionId,
      sampleRate: sr,
      channelCount: 1,
      flushedBlocksCount: this.flushedBlocksCount,
      totalRecordedSeconds: Number((this.totalSamplesFlushed / sr).toFixed(2)),
    };
  }

  /**
   * Recovers sequentially flushed PCM blocks from OPFS after a crash or unexpected tab close.
   */
  public async recoverSessionBlocksFromOpfs(
    recordingSessionId: string,
    maxBlocksToScan = 4096,
  ): Promise<Float32Array> {
    const root = this.env.getStorageRoot
      ? await this.env.getStorageRoot()
      : ((await navigator.storage.getDirectory()) as unknown as OpfsDirectoryLike);

    const recDir = await root.getDirectoryHandle('live-studio-recordings', { create: false });
    const sessionDir = await recDir.getDirectoryHandle(recordingSessionId, { create: false });

    const chunks: Float32Array[] = [];
    let totalSamples = 0;

    for (let idx = 0; idx < maxBlocksToScan; idx++) {
      const blockFileName = `rec_block_${String(idx).padStart(6, '0')}.pcm`;
      try {
        const handle = await sessionDir.getFileHandle(blockFileName, { create: false });
        const file = await handle.getFile();
        const buf = await file.arrayBuffer();
        const floats = new Float32Array(buf);
        chunks.push(floats);
        totalSamples += floats.length;
      } catch {
        break;
      }
    }

    const combined = new Float32Array(totalSamples);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.length;
    }
    return combined;
  }

  /**
   * Safely stops microphone tracks and closes AudioContext.
   */
  public async stopStudioRecording(): Promise<void> {
    this.isRecording = false;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      await this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}
