import { TrackId } from '../../../src/contracts/project-schema.contract';
import { SampleRate } from '../../../src/contracts/timebase.contract';
import { LoudnessAndMasteringEngine } from '../../../src/audio-engine/LoudnessAndMasteringEngine';
import { MidSideVocalSpaceCarverEngine } from './MidSideVocalSpaceCarverEngine';

export type SubmixBusRole =
  | 'DIALOGUE_VOICE_BUS'
  | 'MUSIC_BED_BUS'
  | 'SFX_AMBIENCE_BUS'
  | 'AUX_REVERB_BUS'
  | 'MASTER_BROADCAST_BUS';

export interface TrackRoutingAssignment {
  readonly trackId: TrackId;
  readonly targetSubmixBus: Exclude<SubmixBusRole, 'MASTER_BROADCAST_BUS'>;
  readonly gainDb: number;
  readonly pan: number; // -1.0 (Left) to +1.0 (Right)
  readonly auxSendLevelDb?: number;
}

export class AudioBusAndRoutingMatrixEngine {
  /**
   * اجرای کامل ماتریس مسیریابی و میکس چندمسیره همراه با Sidechain خودکار از اتوبوس گفتار به اتوبوس موسیقی
   * و حفاظت از Headroom در Master Bus (بخش ۳۳ سند معماری)
   */
  public static mixMultiTrackThroughSubmixBuses(params: {
    trackBuffersMono: ReadonlyMap<TrackId, Float32Array>;
    routingTable: TrackRoutingAssignment[];
    sampleRate: SampleRate;
    frameCount: number;
    enableSidechainVocalCarvingOnMusic: boolean;
    masterTargetLufs?: number;
  }): {
    dialogueBusStereo: [Float32Array, Float32Array];
    musicBusStereo: [Float32Array, Float32Array];
    sfxBusStereo: [Float32Array, Float32Array];
    masterOutputStereo: [Float32Array, Float32Array];
  } {
    const safeFrameCount =
      Number.isFinite(params.frameCount) && params.frameCount > 0
        ? Math.floor(params.frameCount)
        : 0;
    const safeSampleRate = (
      Number.isFinite(params.sampleRate) && params.sampleRate > 0 ? params.sampleRate : 48000
    ) as SampleRate;

    const dialogueL = new Float32Array(safeFrameCount);
    const dialogueR = new Float32Array(safeFrameCount);
    const dialogueMonoKey = new Float32Array(safeFrameCount);

    let musicL = new Float32Array(safeFrameCount);
    let musicR = new Float32Array(safeFrameCount);

    const sfxL = new Float32Array(safeFrameCount);
    const sfxR = new Float32Array(safeFrameCount);

    if (safeFrameCount === 0) {
      return {
        dialogueBusStereo: [dialogueL, dialogueR],
        musicBusStereo: [musicL, musicR],
        sfxBusStereo: [sfxL, sfxR],
        masterOutputStereo: [new Float32Array(0), new Float32Array(0)],
      };
    }

    // ۱. مسیریابی هر ترک به اتوبوس فرعی مربوطه با اعمال Gain Staging و Equal-Power Pan Law (-3dB)
    for (const route of params.routingTable) {
      const srcMono = params.trackBuffersMono.get(route.trackId);
      if (!srcMono || srcMono.length === 0) continue;

      const safeGainDb = Number.isFinite(route.gainDb) ? route.gainDb : 0;
      const safePan = Number.isFinite(route.pan) ? route.pan : 0;
      const linearGain = Math.pow(10, safeGainDb / 20.0);
      const [pannedL, pannedR] = LoudnessAndMasteringEngine.applyEqualPowerPan(
        srcMono,
        safePan,
      );

      const len = Math.min(safeFrameCount, srcMono.length);

      if (route.targetSubmixBus === 'DIALOGUE_VOICE_BUS') {
        for (let i = 0; i < len; i++) {
          const pL = Number.isFinite(pannedL[i]) ? pannedL[i] : 0;
          const pR = Number.isFinite(pannedR[i]) ? pannedR[i] : 0;
          const m = Number.isFinite(srcMono[i]) ? srcMono[i] : 0;
          dialogueL[i] += pL * linearGain;
          dialogueR[i] += pR * linearGain;
          dialogueMonoKey[i] += m * linearGain;
        }
      } else if (route.targetSubmixBus === 'MUSIC_BED_BUS') {
        for (let i = 0; i < len; i++) {
          const pL = Number.isFinite(pannedL[i]) ? pannedL[i] : 0;
          const pR = Number.isFinite(pannedR[i]) ? pannedR[i] : 0;
          musicL[i] += pL * linearGain;
          musicR[i] += pR * linearGain;
        }
      } else if (route.targetSubmixBus === 'SFX_AMBIENCE_BUS') {
        for (let i = 0; i < len; i++) {
          const pL = Number.isFinite(pannedL[i]) ? pannedL[i] : 0;
          const pR = Number.isFinite(pannedR[i]) ? pannedR[i] : 0;
          sfxL[i] += pL * linearGain;
          sfxR[i] += pR * linearGain;
        }
      }
    }

    // ۲. اعمال Sidechain هوشمند از اتوبوس گفتار (DIALOGUE_VOICE_BUS) روی اتوبوس موسیقی (MUSIC_BED_BUS)
    if (params.enableSidechainVocalCarvingOnMusic) {
      const [carvedMusicL, carvedMusicR] =
        MidSideVocalSpaceCarverEngine.carveMidChannelSpaceForPersianVoice(
          musicL,
          musicR,
          dialogueMonoKey,
          safeSampleRate,
          6.5,
        );
      musicL.set(carvedMusicL);
      musicR.set(carvedMusicR);
    }

    // ۳. جمع شدن اتوبوس‌های فرعی در Master Bus همراه با حفظ Headroom و محدودکننده True Peak (-1.0 dBTP)
    const rawMasterL = new Float32Array(safeFrameCount);
    const rawMasterR = new Float32Array(safeFrameCount);

    for (let i = 0; i < safeFrameCount; i++) {
      rawMasterL[i] = dialogueL[i] + musicL[i] + sfxL[i];
      rawMasterR[i] = dialogueR[i] + musicR[i] + sfxR[i];
    }

    const safeTargetLufs =
      params.masterTargetLufs !== undefined && Number.isFinite(params.masterTargetLufs)
        ? params.masterTargetLufs
        : -16.0;

    const { normalizedChannels } =
      LoudnessAndMasteringEngine.normalizeToTargetLufsWithTruePeakLimiter(
        [rawMasterL, rawMasterR],
        safeSampleRate,
        safeTargetLufs,
        -1.0,
      );

    return {
      dialogueBusStereo: [dialogueL, dialogueR],
      musicBusStereo: [musicL, musicR],
      sfxBusStereo: [sfxL, sfxR],
      masterOutputStereo: [normalizedChannels[0], normalizedChannels[1]],
    };
  }
}
