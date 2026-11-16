import { SampleRate, TimeMath } from '../../../src/contracts/timebase.contract';
import { SmartSpliceDescriptor } from '../../../src/contracts/persian-editing.contract';
import { PersianAcousticSnapper } from '../../../src/audio-engine/PersianAcousticSnapper';

export type PreviewAuditionMode = 'BEFORE_ORIGINAL' | 'AFTER_SPLICED';

export interface PreviewAuditionParams {
  readonly mode: PreviewAuditionMode;
  readonly fullTrackMonoPcm: Float32Array;
  readonly roomToneBuffer: Float32Array;
  readonly spliceDescriptor: SmartSpliceDescriptor;
  readonly sampleRate: SampleRate;
  /** Default 1500ms before and after the splice (~3s total audition window). */
  readonly contextPaddingMs?: number;
  /** Hidden Pre-Roll samples fed into stateful DSP nodes before trimming prefix. */
  readonly dspPreRollSamples?: number;
  readonly runDspChainWithPreRoll?: (rawInputWithPreRoll: Float32Array) => Float32Array;
}

export interface PreviewAuditionResult {
  readonly pcm: Float32Array;
  readonly mode: PreviewAuditionMode;
  readonly sampleRate: SampleRate;
  readonly previewStartSample: number;
  readonly spliceBoundaryOffsetSamples: number;
  readonly actualPreRollFedSamples: number;
  readonly durationMs: number;
  readonly buildTimeMs: number;
}

/**
 * Smart Splice A/B Audition Preview Engine with Stateful Pre-Roll (Sections 2.3, 25, 30 & 52)
 * Builds <= 10ms non-destructive 3s audition buffers comparing original audio (Mode A)
 * against zero-crossing snapped, Equal-Power crossfaded, Room-Tone-injected audio (Mode B).
 */
export class SmartSplicePreviewEngine {
  public static buildPreviewAuditionBuffer(params: PreviewAuditionParams): Float32Array {
    return this.buildPreviewAuditionSession(params).pcm;
  }

  public static buildPreviewAuditionSession(params: PreviewAuditionParams): PreviewAuditionResult {
    const startClock = performance.now();
    const {
      mode,
      fullTrackMonoPcm,
      roomToneBuffer,
      spliceDescriptor,
      sampleRate,
    } = params;

    const contextPaddingMs = Math.max(50, params.contextPaddingMs ?? 1500);
    const contextSamples = Math.floor((sampleRate * contextPaddingMs) / 1000);
    const requestedPreRoll = Math.max(0, Math.floor(params.dspPreRollSamples ?? 0));

    const cutStartSample = Math.max(
      0,
      Math.min(
        fullTrackMonoPcm.length,
        TimeMath.flicksToSamplesFloor(spliceDescriptor.snappedAcousticRange.start, sampleRate),
      ),
    );
    const cutEndSample = Math.max(
      cutStartSample,
      Math.min(
        fullTrackMonoPcm.length,
        TimeMath.flicksToSamplesFloor(spliceDescriptor.snappedAcousticRange.end, sampleRate),
      ),
    );

    const previewStartSample = Math.max(0, cutStartSample - contextSamples);
    const diskReadStartWithPreRoll = Math.max(0, previewStartSample - requestedPreRoll);
    const actualPreRollFedSamples = previewStartSample - diskReadStartWithPreRoll;
    const previewEndSample = Math.min(fullTrackMonoPcm.length, cutEndSample + contextSamples);

    const safeRoomTone =
      roomToneBuffer.length > 0
        ? roomToneBuffer
        : new Float32Array(Math.max(1, Math.floor(sampleRate * 0.05)));

    let rawPreviewWithPreRoll: Float32Array;

    if (mode === 'BEFORE_ORIGINAL') {
      rawPreviewWithPreRoll = fullTrackMonoPcm.slice(diskReadStartWithPreRoll, previewEndSample);
    } else {
      const leftSegmentWithPreRoll = fullTrackMonoPcm.slice(
        diskReadStartWithPreRoll,
        cutStartSample,
      );
      const rightSegment = fullTrackMonoPcm.slice(cutEndSample, previewEndSample);

      const crossfadeMs = Math.max(
        0,
        TimeMath.flicksToSeconds(spliceDescriptor.fadeInDurationFlicks) * 1000,
      );
      const roomTonePadMs = Math.max(
        0,
        TimeMath.flicksToSeconds(spliceDescriptor.injectRoomToneFlicks) * 1000,
      );

      rawPreviewWithPreRoll = PersianAcousticSnapper.applySeamlessSplice(
        leftSegmentWithPreRoll,
        rightSegment,
        safeRoomTone,
        sampleRate,
        crossfadeMs,
        roomTonePadMs,
      );
    }

    let finalPcm: Float32Array;
    if (params.runDspChainWithPreRoll) {
      const processed = params.runDspChainWithPreRoll(rawPreviewWithPreRoll);
      finalPcm =
        actualPreRollFedSamples > 0
          ? processed.slice(actualPreRollFedSamples)
          : processed;
    } else {
      finalPcm =
        actualPreRollFedSamples > 0
          ? rawPreviewWithPreRoll.slice(actualPreRollFedSamples)
          : rawPreviewWithPreRoll;
    }

    const buildTimeMs = Number((performance.now() - startClock).toFixed(3));

    return {
      pcm: finalPcm,
      mode,
      sampleRate,
      previewStartSample,
      spliceBoundaryOffsetSamples: cutStartSample - previewStartSample,
      actualPreRollFedSamples,
      durationMs: Number(((finalPcm.length / sampleRate) * 1000).toFixed(2)),
      buildTimeMs,
    };
  }
}
