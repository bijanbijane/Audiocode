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
    const { frameCount, sampleRate } = params;

    const dialogueL = new Float32Array(frameCount);
    const dialogueR = new Float32Array(frameCount);
    const dialogueMonoKey = new Float32Array(frameCount);

    let musicL = new Float32Array(frameCount);
    let musicR = new Float32Array(frameCount);

    const sfxL = new Float32Array(frameCount);
    const sfxR = new Float32Array(frameCount);

    // ۱. مسیریابی هر ترک به اتوبوس فرعی مربوطه با اعمال Gain Staging و Equal-Power Pan Law (-3dB)
    for (const route of params.routingTable) {
      const srcMono = params.trackBuffersMono.get(route.trackId);
      if (!srcMono) continue;

      const linearGain = Math.pow(10, route.gainDb / 20.0);
      const [pannedL, pannedR] = LoudnessAndMasteringEngine.applyEqualPowerPan(
        srcMono,
        route.pan,
      );

      const len = Math.min(frameCount, srcMono.length);

      if (route.targetSubmixBus === 'DIALOGUE_VOICE_BUS') {
        for (let i = 0; i < len; i++) {
          dialogueL[i] += pannedL[i] * linearGain;
          dialogueR[i] += pannedR[i] * linearGain;
          dialogueMonoKey[i] += srcMono[i] * linearGain;
        }
      } else if (route.targetSubmixBus === 'MUSIC_BED_BUS') {
        for (let i = 0; i < len; i++) {
          musicL[i] += pannedL[i] * linearGain;
          musicR[i] += pannedR[i] * linearGain;
        }
      } else if (route.targetSubmixBus === 'SFX_AMBIENCE_BUS') {
        for (let i = 0; i < len; i++) {
          sfxL[i] += pannedL[i] * linearGain;
          sfxR[i] += pannedR[i] * linearGain;
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
          sampleRate,
          6.5,
        );
      musicL.set(carvedMusicL);
      musicR.set(carvedMusicR);
    }

    // ۳. جمع شدن اتوبوس‌های فرعی در Master Bus همراه با حفظ Headroom و محدودکننده True Peak (-1.0 dBTP)
    const rawMasterL = new Float32Array(frameCount);
    const rawMasterR = new Float32Array(frameCount);

    for (let i = 0; i < frameCount; i++) {
      rawMasterL[i] = dialogueL[i] + musicL[i] + sfxL[i];
      rawMasterR[i] = dialogueR[i] + musicR[i] + sfxR[i];
    }

    const { normalizedChannels } =
      LoudnessAndMasteringEngine.normalizeToTargetLufsWithTruePeakLimiter(
        [rawMasterL, rawMasterR],
        sampleRate,
        params.masterTargetLufs ?? -16.0,
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
