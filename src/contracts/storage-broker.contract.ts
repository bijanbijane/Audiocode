import { Flicks, SampleIndex, SampleRate, TimeRange } from './timebase.contract';

export type AssetId = string;
export type BlockKey = `${AssetId}:${number}`; // e.g., 5-second rolling cache blocks

/** Sample-Accurate Frame Seek Table inside original compressed asset */
export interface SeekTableEntry {
  readonly sampleOffset: SampleIndex;
  readonly byteOffset: number;
  readonly frameByteLength: number;
}

/** Multi-Resolution Waveform Peak Pyramid (LOD) for instant Canvas rendering */
export interface WaveformPeakPyramid {
  readonly assetId: AssetId;
  readonly levels: {
    readonly samplesPerPixel: 64 | 256 | 1024 | 4096;
    /** Compact Int8 [min, max, min, max, ...] offset in OPFS */
    readonly peaksInt8OffsetInOPFS: number;
    readonly byteLength: number;
  }[];
}

/** Group A Acoustic Profile extracted at Cold Start (0s) */
export interface AcousticProfile {
  readonly noiseFloorDb: number;
  /** 500ms natural ambient slice for Room Tone injection */
  readonly roomToneSourceRange: TimeRange;
  readonly integratedLoudnessLufs?: number;
}

/** Centralized OPFS I/O Broker Worker request union */
export type StorageBrokerRequest =
  | { type: 'INIT_STORAGE'; requestId: string }
  | { type: 'INGEST_STREAM_CHUNK'; requestId: string; assetId: AssetId; chunk: Uint8Array; isLast: boolean }
  | {
      type: 'READ_PCM_WINDOW';
      requestId: string;
      assetId: AssetId;
      startSample: SampleIndex;
      frameCount: number;
      targetRate: SampleRate;
    }
  | { type: 'EVICT_LRU_CACHE'; requestId: string; maxBytesAllowed: number }
  | { type: 'WRITE_PCM_BLOCK'; requestId: string; blockKey: BlockKey; pcmData: Float32Array; durationFlicks?: Flicks };
