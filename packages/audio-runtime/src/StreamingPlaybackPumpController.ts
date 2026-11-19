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
  private isSeeking = false;
  private seekEpoch = 0;
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
    this.isSeeking = true;
    const myEpoch = ++this.seekEpoch;

    try {
      // ۱. توقف موقت خواندن توسط AudioWorklet و ریست اتمیک ایندکس‌های بافر حلقوی
      Atomics.store(this.ctrlView, CTRL_STATE.IS_PLAYING, 0);
      Atomics.store(this.ctrlView, CTRL_STATE.READ_INDEX, 0);
      Atomics.store(this.ctrlView, CTRL_STATE.WRITE_INDEX, 0);

      const safeTarget =
        Number.isFinite(targetSample) && targetSample > 0 ? Math.floor(targetSample) : 0;
      this.currentTimelineCursorSample = safeTarget;

      // ۲. پیش‌پرکردن ۱.۵ ثانیه از صدای موقعیت جدید پیش از شروع دوباره پخش
      const sr =
        Number.isFinite(this.projectDoc.canonicalSampleRate) &&
        this.projectDoc.canonicalSampleRate > 0
          ? this.projectDoc.canonicalSampleRate
          : 48000;
      const targetPrimeFrames = Math.floor(sr * 1.5);
      let primed = 0;
      while (
        this.seekEpoch === myEpoch &&
        primed < targetPrimeFrames &&
        this.ringBuffer.availableWrite() >= this.chunkSizeFrames
      ) {
        await this.pumpSingleChunk(myEpoch);
        primed += this.chunkSizeFrames;
      }

      if (wasPlaying && this.seekEpoch === myEpoch) {
        Atomics.store(this.ctrlView, CTRL_STATE.IS_PLAYING, 1);
      }
    } finally {
      if (this.seekEpoch === myEpoch) {
        this.isSeeking = false;
      }
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
        if (this.isSeeking) {
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        // تا زمانی که کمتر از ۶۰٪ بافر حلقوی پر است، بلوک‌های بعدی را از OPFS و تایم‌لاین میکس کن
        const freeSpace = this.ringBuffer.availableWrite();
        if (freeSpace >= this.chunkSizeFrames * 2) {
          await this.pumpSingleChunk(this.seekEpoch);
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
   * رندر بلادرنگ یک قطعه 4096 نمونه‌ای از روی کلیپ‌های غیرمخرب تایم‌لاین (همراه با Micro-Fade، Solo/Mute و ایزوله‌سازی اتومیشن هر ترک)
   */
  public async pumpSingleChunk(expectedEpoch: number = this.seekEpoch): Promise<void> {
    const doc = this.projectDoc;
    const sr: SampleRate = doc.canonicalSampleRate;
    if (!Number.isFinite(sr) || sr <= 0) return;

    const winStartSample = this.currentTimelineCursorSample;
    const winEndSample = winStartSample + this.chunkSizeFrames;

    const winStartFlicks: Flicks = TimeMath.samplesToFlicks(winStartSample, sr);
    const winEndFlicks: Flicks = TimeMath.samplesToFlicks(winEndSample, sr);

    const mixLeft = new Float32Array(this.chunkSizeFrames);
    const mixRight = new Float32Array(this.chunkSizeFrames);

    const anyTrackSoloed = doc.tracks.some((t) => t.solo);

    for (const track of doc.tracks) {
      if (track.muted) continue;
      if (anyTrackSoloed && !track.solo) continue;

      // یافتن کلیپ‌هایی که با پنجره زمانی فعلی هم‌پوشانی دارند
      const intersectingClips = track.clips.filter(
        (c) =>
          Number.isFinite(c.timelineRange.start) &&
          Number.isFinite(c.timelineRange.end) &&
          c.timelineRange.end > winStartFlicks &&
          c.timelineRange.start < winEndFlicks,
      );
      if (intersectingClips.length === 0) continue;

      // ایزوله‌سازی بافر هر ترک پیش از اعمال اتومیشن تا اتومیشن ترک دوم روی ترک‌های قبلی اثر نگذارد
      const trackLeft = new Float32Array(this.chunkSizeFrames);
      const trackRight = new Float32Array(this.chunkSizeFrames);

      for (const clip of intersectingClips) {
        await this.renderClipSliceIntoMixBuffer(
          clip,
          winStartSample,
          winEndSample,
          sr,
          trackLeft,
          trackRight,
        );
      }

      // اعمال اتومیشن ترک (مانند Auto-Ducking یا Speaker Leveler) صرفاً روی بافر همان ترک
      const lane = this.automationLanes.get(track.id);
      if (lane && lane.parameterName === 'GAIN_DB') {
        TimelineAutomationEngine.applyGainAutomationToChunkInPlace(
          lane,
          [trackLeft, trackRight],
          winStartFlicks,
          sr,
        );
      }

      for (let i = 0; i < this.chunkSizeFrames; i++) {
        mixLeft[i] += trackLeft[i];
        mixRight[i] += trackRight[i];
      }
    }

    // اگر حین خواندن ناهمگام از دیسک، کاربر Seek انجام داده باشد، این بلوک کهنه را دور می‌ریزیم
    if (expectedEpoch !== this.seekEpoch) {
      return;
    }

    const written = this.ringBuffer.push([mixLeft, mixRight], this.chunkSizeFrames);
    this.currentTimelineCursorSample += written;
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

    const sourceReadOffset = Math.max(0, clipSrcStartSample + (overlapStart - clipTlStartSample));
    const srcChannels = await this.sourceReader.readAssetSourceSamples(
      clip.assetId,
      sourceReadOffset,
      overlapFrames,
    );

    if (!srcChannels || srcChannels.length === 0 || !srcChannels[0]) return;
    const srcL = srcChannels[0];
    const srcR = srcChannels.length > 1 && srcChannels[1] ? srcChannels[1] : srcL;

    const safeGainDb = Number.isFinite(clip.gainDb) ? clip.gainDb : 0;
    const clipLinearGain = Math.pow(10, safeGainDb / 20.0);
    const safeFadeInFlicks =
      Number.isFinite(clip.fadeInFlicks) && clip.fadeInFlicks > 0 ? clip.fadeInFlicks : 0;
    const safeFadeOutFlicks =
      Number.isFinite(clip.fadeOutFlicks) && clip.fadeOutFlicks > 0 ? clip.fadeOutFlicks : 0;
    const fadeInSamples = TimeMath.flicksToSamplesFloor(safeFadeInFlicks, sampleRate);
    const fadeOutSamples = TimeMath.flicksToSamplesFloor(safeFadeOutFlicks, sampleRate);
    const clipTotalSamples = clipTlEndSample - clipTlStartSample;

    const dstOffset = overlapStart - winStartSample;
    const readableFrames = Math.min(
      overlapFrames,
      srcL.length,
      srcR.length,
      mixLeft.length - dstOffset,
      mixRight.length - dstOffset,
    );
    if (readableFrames <= 0) return;

    for (let i = 0; i < readableFrames; i++) {
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
      const sampleL = Number.isFinite(srcL[i]) ? srcL[i] : 0;
      const sampleR = Number.isFinite(srcR[i]) ? srcR[i] : 0;
      mixLeft[dstOffset + i] += sampleL * totalGain;
      mixRight[dstOffset + i] += sampleR * totalGain;
    }
  }
}
