import {
  ProjectDocument,
  TimelineClip,
} from '../../../src/contracts/project-schema.contract';
import {
  Flicks,
  SampleIndex,
  SampleRate,
  TimeMath,
} from '../../../src/contracts/timebase.contract';
import { CTRL_STATE, SharedAudioRingBuffer } from '../../../src/audio-engine/SharedRingBuffer';
import {
  AutomationLane,
  TimelineAutomationEngine,
} from '../../../src/project-core/TimelineAutomationEngine';

export interface PcmSourceBlockReader {
  /** خواندن یک پنجره از فایل مبدأ بر حسب نمونه از کش چرخشی OPFS یا دیکدر Seek-Table */
  readAssetSourceSamples(
    assetId: string,
    sourceStartSample: SampleIndex,
    frameCount: number,
  ): Promise<Float32Array[]>; // [left, right] یا [mono]
}

export class StreamingPlaybackPumpController {
  private projectDoc: ProjectDocument;
  private automationLanes = new Map<string, AutomationLane>();
  private currentTimelineCursorSample: SampleIndex = 0;
  private isPumpRunning = false;
  private readonly chunkSizeFrames = 4096; // بلوک‌های ~85ms در 48kHz برای تغذیه نرم Ring Buffer
  private readonly ctrlView: Int32Array;

  constructor(
    initialDoc: ProjectDocument,
    private readonly ringBuffer: SharedAudioRingBuffer,
    private readonly sourceReader: PcmSourceBlockReader,
  ) {
    this.projectDoc = initialDoc;
    this.ctrlView = new Int32Array(this.ringBuffer.controlBuffer);
  }

  /**
   * به‌روزرسانی لحظه‌ای نقشه تایم‌لاین در حین پخش (مثلاً پس از اعمال یک برش یا Undo)
   */
  public updateActiveTimelineSnapshot(
    updatedDoc: ProjectDocument,
    lanes?: AutomationLane[],
  ): void {
    this.projectDoc = updatedDoc;
    if (lanes) {
      this.automationLanes.clear();
      for (const l of lanes) {
        this.automationLanes.set(l.targetNodeOrTrackId, l);
      }
    }
  }

  /**
   * پرش آنی (Seek) بدون کلیک صوتی و بازپرکردن فوری بافر حلقوی از موقعیت جدید
   */
  public async seekAndPrimeRingBuffer(targetSample: SampleIndex): Promise<void> {
    const wasPlaying = Atomics.load(this.ctrlView, CTRL_STATE.IS_PLAYING) === 1;

    // ۱. توقف موقت خواندن توسط AudioWorklet و ریست اتمیک ایندکس‌های بافر حلقوی
    Atomics.store(this.ctrlView, CTRL_STATE.IS_PLAYING, 0);
    Atomics.store(this.ctrlView, CTRL_STATE.READ_INDEX, 0);
    Atomics.store(this.ctrlView, CTRL_STATE.WRITE_INDEX, 0);

    this.currentTimelineCursorSample = Math.max(0, targetSample);

    // ۲. پیش‌پرکردن ۱.۵ ثانیه از صدای موقعیت جدید پیش از شروع دوباره پخش
    const targetPrimeFrames = Math.floor(this.projectDoc.canonicalSampleRate * 1.5);
    let primed = 0;
    while (
      primed < targetPrimeFrames &&
      this.ringBuffer.availableWrite() >= this.chunkSizeFrames
    ) {
      await this.pumpSingleChunk();
      primed += this.chunkSizeFrames;
    }

    if (wasPlaying) {
      Atomics.store(this.ctrlView, CTRL_STATE.IS_PLAYING, 1);
    }
  }

  /**
   * شروع حلقه تغذیه پیوسته بافر حلقوی در Web Worker
   */
  public startPumpLoop(): void {
    if (this.isPumpRunning) return;
    this.isPumpRunning = true;

    const tick = async () => {
      while (this.isPumpRunning) {
        // تا زمانی که کمتر از ۶۰٪ بافر حلقوی پر است، بلوک‌های بعدی را از OPFS و تایم‌لاین میکس کن
        const freeSpace = this.ringBuffer.availableWrite();
        if (freeSpace >= this.chunkSizeFrames * 2) {
          await this.pumpSingleChunk();
        } else {
          // تنفس کوتاه برای جلوگیری از اشغال 100% CPU در Worker
          await new Promise((r) => setTimeout(r, 15));
        }
      }
    };

    void tick();
  }

  public stopPumpLoop(): void {
    this.isPumpRunning = false;
  }

  /**
   * رندر بلادرنگ یک قطعه 4096 نمونه‌ای از روی کلیپ‌های غیرمخرب تایم‌لاین (همراه با Micro-Fade و Solo/Mute)
   */
  public async pumpSingleChunk(): Promise<void> {
    const sr: SampleRate = this.projectDoc.canonicalSampleRate;
    const winStartSample = this.currentTimelineCursorSample;
    const winEndSample = winStartSample + this.chunkSizeFrames;

    const winStartFlicks: Flicks = TimeMath.samplesToFlicks(winStartSample, sr);
    const winEndFlicks: Flicks = TimeMath.samplesToFlicks(winEndSample, sr);

    const mixLeft = new Float32Array(this.chunkSizeFrames);
    const mixRight = new Float32Array(this.chunkSizeFrames);

    const anyTrackSoloed = this.projectDoc.tracks.some((t) => t.solo);

    for (const track of this.projectDoc.tracks) {
      if (track.muted) continue;
      if (anyTrackSoloed && !track.solo) continue;

      // یافتن کلیپ‌هایی که با پنجره زمانی فعلی هم‌پوشانی دارند
      const intersectingClips = track.clips.filter(
        (c) =>
          c.timelineRange.end > winStartFlicks &&
          c.timelineRange.start < winEndFlicks,
      );

      for (const clip of intersectingClips) {
        await this.renderClipSliceIntoMixBuffer(
          clip,
          winStartSample,
          winEndSample,
          sr,
          mixLeft,
          mixRight,
        );
      }

      // اعمال اتومیشن ترک (مانند Auto-Ducking یا Speaker Leveler) در صورت وجود
      const lane = this.automationLanes.get(track.id);
      if (lane && lane.parameterName === 'GAIN_DB') {
        TimelineAutomationEngine.applyGainAutomationToChunkInPlace(
          lane,
          [mixLeft, mixRight],
          winStartFlicks,
          sr,
        );
      }
    }

    this.ringBuffer.push([mixLeft, mixRight], this.chunkSizeFrames);
    this.currentTimelineCursorSample += this.chunkSizeFrames;
  }

  private async renderClipSliceIntoMixBuffer(
    clip: TimelineClip,
    winStartSample: SampleIndex,
    winEndSample: SampleIndex,
    sampleRate: SampleRate,
    mixLeft: Float32Array,
    mixRight: Float32Array,
  ): Promise<void> {
    const clipTlStartSample = TimeMath.flicksToSamplesFloor(
      clip.timelineRange.start,
      sampleRate,
    );
    const clipTlEndSample = TimeMath.flicksToSamplesFloor(
      clip.timelineRange.end,
      sampleRate,
    );
    const clipSrcStartSample = TimeMath.flicksToSamplesFloor(
      clip.sourceRange.start,
      sampleRate,
    );

    const overlapStart = Math.max(winStartSample, clipTlStartSample);
    const overlapEnd = Math.min(winEndSample, clipTlEndSample);
    const overlapFrames = overlapEnd - overlapStart;
    if (overlapFrames <= 0) return;

    const sourceReadOffset = clipSrcStartSample + (overlapStart - clipTlStartSample);
    const srcChannels = await this.sourceReader.readAssetSourceSamples(
      clip.assetId,
      sourceReadOffset,
      overlapFrames,
    );

    const srcL = srcChannels[0];
    const srcR = srcChannels.length > 1 ? srcChannels[1] : srcChannels[0];

    const clipLinearGain = Math.pow(10, clip.gainDb / 20.0);
    const fadeInSamples = TimeMath.flicksToSamplesFloor(clip.fadeInFlicks, sampleRate);
    const fadeOutSamples = TimeMath.flicksToSamplesFloor(clip.fadeOutFlicks, sampleRate);
    const clipTotalSamples = clipTlEndSample - clipTlStartSample;

    const dstOffset = overlapStart - winStartSample;

    for (let i = 0; i < overlapFrames; i++) {
      const posInClip = overlapStart - clipTlStartSample + i;
      let fadeGain = 1.0;

      // اعمال منحنی Equal-Power (sin / cos) در ابتدای کلیپ
      if (fadeInSamples > 0 && posInClip < fadeInSamples) {
        const phase = (posInClip / fadeInSamples) * (Math.PI / 2);
        fadeGain *= Math.sin(phase);
      }

      // اعمال منحنی Equal-Power در انتهای کلیپ
      const distFromEnd = clipTotalSamples - 1 - posInClip;
      if (fadeOutSamples > 0 && distFromEnd < fadeOutSamples) {
        const phase = (distFromEnd / fadeOutSamples) * (Math.PI / 2);
        fadeGain *= Math.sin(phase);
      }

      const totalGain = clipLinearGain * fadeGain;
      mixLeft[dstOffset + i] += srcL[i] * totalGain;
      mixRight[dstOffset + i] += srcR[i] * totalGain;
    }
  }
}
