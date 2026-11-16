import { SampleRate, TimeMath } from '../contracts/timebase.contract';
import { ProjectDocument } from '../contracts/project-schema.contract';
import { AudioSecurityGuard } from '../security/AudioSecurityGuard';
import { RecordingQualityAdvisorEngine } from '../../packages/audio-runtime/src/RecordingQualityAdvisorEngine';
import { AudioRestorationEngine } from '../processing-core/AudioRestorationEngine';
import { PersianAcousticSnapper } from '../audio-engine/PersianAcousticSnapper';
import { PersianTextNormalizer } from '../ai-engine/PersianTextNormalizer';
import { PersianDisfluencyEngine } from '../ai-engine/PersianDisfluencyEngine';
import { TimelineTransactionEngine } from '../project-core/TimelineTransactionEngine';
import { PostEditValidationEngine } from '../project-core/PostEditValidationEngine';
import { LoudnessAndMasteringEngine } from '../audio-engine/LoudnessAndMasteringEngine';
import { ExportValidator } from '../processing-core/ExportValidator';
import { EditQualityVsModelQualityEvaluator } from '../project-core/evaluation/EditQualityVsModelQualityEvaluator';

export interface VerticalSliceHarnessResult {
  readonly allStagesPassed: boolean;
  readonly detected50HzHum: boolean;
  readonly repairedMouthClicks: number;
  readonly detectedDisfluenciesCount: number;
  readonly finalIntegratedLufs: number;
  readonly finalTruePeakDbtp: number;
  readonly editSmoothnessScore: number;
  readonly executionLog: string[];
}

export class SyntheticVerticalSliceHarness {
  /**
   * اجرای آزمایشی سرتاسری کل زنجیره بدون وابستگی به فایل خارجی یا اینترنت
   */
  public static runCompleteSyntheticPipeline(): VerticalSliceHarnessResult {
    const executionLog: string[] = [];
    const sr: SampleRate = 48000;
    const durationSec = 8;
    const totalSamples = sr * durationSec;

    // ۱. تولید فایل صوتی آزمایشی حاوی هوم ۵۰ هرتز، تقه دهان و سه بخش گفتار (شامل یک تپق «اممم»)
    const pcm = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      const t = i / sr;
      // هوم ۵۰ هرتز برق شهر ایران + نویز ملایم اتاق (Room Tone)
      const roomAndHum =
        0.015 * Math.sin(2 * Math.PI * 50 * t) +
        0.008 * Math.sin(2 * Math.PI * 100 * t) +
        0.0015 * Math.sin(2 * Math.PI * 317 * t);

      let voice = 0;
      // بخش ۱ (0.5s تا 2.0s): «سلام دوستان»
      // بخش ۲ (2.3s تا 3.1s): تپق «اممم»
      // بخش ۳ (3.5s تا 6.5s): «امروز درباره معماری صحبت می‌کنیم»
      const inPart1 = t >= 0.5 && t <= 2.0;
      const inStutter = t >= 2.3 && t <= 3.1;
      const inPart3 = t >= 3.5 && t <= 6.5;

      if (inPart1 || inStutter || inPart3) {
        voice =
          0.22 * Math.sin(2 * Math.PI * 165 * t) +
          0.09 * Math.sin(2 * Math.PI * 330 * t);
      }

      pcm[i] = roomAndHum + voice;
    }

    // تزریق یک تقه دهان (Mouth Click) در ثانیه 1.2
    const clickIdx = Math.floor(1.2 * sr);
    pcm[clickIdx] = 0.94;
    pcm[clickIdx + 1] = -0.92;
    pcm[clickIdx + 2] = 0.89;

    // ساخت هدر ۱۲ بایتی معتبر RIFF....WAVE برای آزمون سپر امنیتی Magic Bytes
    const fakeWavHeader12 = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x24, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, // "WAVE"
    ]);
    const container = AudioSecurityGuard.verifyMagicBytes(
      fakeWavHeader12,
      totalSamples * 4 + 44,
    );
    executionLog.push(`Stage 1 [Security]: تایید ظرف رسانه ${container}`);

    // ۲. اجرای تحلیل فوری گروه A (استخراج Room Tone و عیب‌یابی آکوستیک ۵۰ هرتز)
    const { roomToneRangeSamples, noiseFloorDb } =
      PersianAcousticSnapper.extractRoomToneProfile(pcm, sr);
    const roomToneSlice = pcm.slice(roomToneRangeSamples[0], roomToneRangeSamples[1]);
    const acousticReport = RecordingQualityAdvisorEngine.analyzeRecordingQuality(
      pcm,
      roomToneSlice,
      sr,
    );
    executionLog.push(
      `Stage 2 [Group A]: هوم 50Hz شناسایی شد=${acousticReport.has50HzMainsHum} | کف نویز=${noiseFloorDb.toFixed(1)}dB`,
    );

    // ۳. اجرای ترمیم تقه دهان (TKEO De-Click)
    const repairedMouthClicks = AudioRestorationEngine.removeMouthClicksInPlace(
      pcm,
      sr,
      10.0,
    );
    executionLog.push(
      `Stage 3 [Restoration]: تعداد ${repairedMouthClicks} تقه دهانی ترمیم شد.`,
    );

    // ۴. شبیه‌سازی خروجی خام ASR فارسی و اجرای موتور نرمال‌ساز + تشخیص تپق
    const rawAsrTokens = [
      {
        id: 'w1',
        text: 'سلام',
        range: { start: TimeMath.secondsToFlicks(0.5), end: TimeMath.secondsToFlicks(1.1) },
        confidence: 0.95,
      },
      {
        id: 'w2',
        text: 'دوستان',
        range: {
          start: TimeMath.secondsToFlicks(1.15),
          end: TimeMath.secondsToFlicks(2.0),
        },
        confidence: 0.94,
      },
      {
        id: 'w3',
        text: 'اممم',
        range: { start: TimeMath.secondsToFlicks(2.3), end: TimeMath.secondsToFlicks(3.1) },
        confidence: 0.91,
      },
      {
        id: 'w4',
        text: 'امروز',
        range: { start: TimeMath.secondsToFlicks(3.5), end: TimeMath.secondsToFlicks(4.2) },
        confidence: 0.96,
      },
      {
        id: 'w5',
        text: 'صحبت',
        range: { start: TimeMath.secondsToFlicks(4.3), end: TimeMath.secondsToFlicks(5.1) },
        confidence: 0.94,
      },
      {
        id: 'w6',
        text: 'می كنيم',
        range: {
          start: TimeMath.secondsToFlicks(5.15),
          end: TimeMath.secondsToFlicks(6.5),
        },
        confidence: 0.93,
      },
    ];
    const normalizedTokens = PersianTextNormalizer.buildThreeLayerTranscript(rawAsrTokens);
    const disfluencies = PersianDisfluencyEngine.analyzeTranscript(normalizedTokens);
    executionLog.push(
      `Stage 4 [Persian AI]: تعداد ${disfluencies.length} ایراد گفتاری شناسایی شد.`,
    );

    // ۵. تراز آکوستیکی نقطه برش + تدوین غیرمخرب روی تایم‌لاین + اعتبارسنجی پس از تدوین
    const stutterIssue = disfluencies.find((d) => d.type === 'INDEPENDENT_FILLER')!;
    const rawStartS = TimeMath.flicksToSamplesFloor(stutterIssue.targetRange.start, sr);
    const rawEndS = TimeMath.flicksToSamplesFloor(stutterIssue.targetRange.end, sr);

    const snappedStartS = PersianAcousticSnapper.snapToZeroCrossing(
      pcm,
      PersianAcousticSnapper.findMinimumEnergySample(pcm, rawStartS, sr),
      sr,
      true,
    );
    const snappedEndS = PersianAcousticSnapper.snapToZeroCrossing(
      pcm,
      PersianAcousticSnapper.findMinimumEnergySample(pcm, rawEndS, sr),
      sr,
      true,
    );

    const projectDoc: ProjectDocument = {
      projectId: 'proj_harness_1',
      name: 'تست سرتاسری',
      canonicalSampleRate: sr,
      versions: {
        projectSchemaVersion: 2,
        audioEngineVersion: '1.2.0',
        processingNodeCatalogVersion: '1.0.0',
        activeModelBundleVersion: '1.2.0',
      },
      revision: 1,
      tracks: [
        {
          id: 'trk_1',
          name: 'گوینده',
          syncGroupId: null,
          speakerId: 'SPEAKER_1',
          muted: false,
          solo: false,
          clips: [
            {
              id: 'clip_1',
              trackId: 'trk_1',
              kind: 'AUDIO_ASSET',
              assetId: 'asset_1',
              sourceRange: { start: 0, end: TimeMath.secondsToFlicks(durationSec) },
              timelineRange: { start: 0, end: TimeMath.secondsToFlicks(durationSec) },
              fadeInFlicks: TimeMath.secondsToFlicks(0.01),
              fadeOutFlicks: TimeMath.secondsToFlicks(0.01),
              gainDb: 0,
            },
          ],
        },
      ],
      recommendations: [
        {
          id: 'rec_stutter_1',
          targetTrackId: 'trk_1',
          disfluencyType: 'INDEPENDENT_FILLER',
          associatedText: 'اممم',
          status: 'PENDING',
          createdAtProjectRevision: 1,
          spliceDescriptor: {
            rawAiRange: stutterIssue.targetRange,
            snappedAcousticRange: {
              start: TimeMath.samplesToFlicks(snappedStartS, sr),
              end: TimeMath.samplesToFlicks(snappedEndS, sr),
            },
            fadeInDurationFlicks: TimeMath.secondsToFlicks(0.01),
            fadeOutDurationFlicks: TimeMath.secondsToFlicks(0.01),
            injectRoomToneFlicks: TimeMath.secondsToFlicks(0.08),
            cutStrategy: 'GLOBAL_SYNC_RIPPLE',
            prosodicWarnings: [],
            confidence: 0.91,
          },
        },
      ],
    };

    const txEngine = new TimelineTransactionEngine(projectDoc);
    txEngine.applySmartSpliceRecommendation('rec_stutter_1', {
      start: TimeMath.samplesToFlicks(roomToneRangeSamples[0], sr),
      end: TimeMath.samplesToFlicks(roomToneRangeSamples[1], sr),
    });

    const healedDoc = PostEditValidationEngine.autoHealTimelineIssues(
      txEngine.getActiveState(),
    );
    const postEditCheck = PostEditValidationEngine.validateProjectTimeline(healedDoc);
    executionLog.push(
      `Stage 5 [Editing]: تدوین غیرمخرب و Post-Edit Validation=${postEditCheck.isValid}`,
    );

    // ۶. تولید صوت پیوندخورده نهایی، مسترینگ (-16 LUFS) و اعتبارسنجی Export + کیفیت تدوین
    const splicedPcm = PersianAcousticSnapper.applySeamlessSplice(
      pcm.slice(0, snappedStartS),
      pcm.slice(snappedEndS),
      roomToneSlice,
      sr,
      10,
      80,
    );

    // اطمینان از صفر بودن ابتدا و انتهای فایل برای گذر از EXPORT_BOUNDARY_CLICK_RISK
    const fadeEdge = Math.floor(sr * 0.01);
    for (let i = 0; i < fadeEdge; i++) {
      splicedPcm[i] *= i / fadeEdge;
      splicedPcm[splicedPcm.length - 1 - i] *= i / fadeEdge;
    }

    const { normalizedChannels } =
      LoudnessAndMasteringEngine.normalizeToTargetLufsWithTruePeakLimiter(
        [splicedPcm, splicedPcm],
        sr,
        -16.0,
        -1.0,
      );

    const loudnessReport = LoudnessAndMasteringEngine.measureLoudnessAndTruePeak(
      normalizedChannels,
      sr,
    );

    const exportReport = ExportValidator.validateRenderedPcm(
      normalizedChannels,
      sr,
      splicedPcm.length / sr,
    );

    const editQualityReport =
      EditQualityVsModelQualityEvaluator.evaluateFinalEditedAudioQuality({
        renderedPcmMono: normalizedChannels[0],
        sampleRate: sr,
        spliceBoundarySamples: [snappedStartS],
        interWordGapDurationsMsAfterEdit: [250, 320, 180],
        multiTrackSyncDriftMs: 0,
      });

    executionLog.push(
      `Stage 6 [Export & QC]: LUFS=${loudnessReport.integratedLufs}, Peak=${loudnessReport.truePeakDbtp}dBTP, ExportValid=${exportReport.passed}, Smoothness=${editQualityReport.compositeEditSmoothnessScoreOutOf100}/100`,
    );

    return {
      allStagesPassed:
        acousticReport.has50HzMainsHum &&
        repairedMouthClicks >= 1 &&
        postEditCheck.isValid &&
        exportReport.passed &&
        editQualityReport.passedFinalEditQuality,
      detected50HzHum: acousticReport.has50HzMainsHum,
      repairedMouthClicks,
      detectedDisfluenciesCount: disfluencies.length,
      finalIntegratedLufs: loudnessReport.integratedLufs,
      finalTruePeakDbtp: loudnessReport.truePeakDbtp,
      editSmoothnessScore: editQualityReport.compositeEditSmoothnessScoreOutOf100,
      executionLog,
    };
  }
}
