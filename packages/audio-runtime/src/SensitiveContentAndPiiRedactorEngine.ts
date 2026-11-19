import { SampleRate, TimeRange } from '../../../src/contracts/timebase.contract';
import { TimedPersianToken } from '../../../src/ai-engine/PersianTextNormalizer';

export type AudioRedactionMaskMode =
  | 'BROADCAST_BLEEP_1KHZ'     // Standard 1000Hz broadcast bleep at -18dBFS with 15ms cosine fades
  | 'LOW_PASS_VOICE_MUFFLE'    // 2-stage low-pass muffle below 210Hz (preserves prosody, hides words)
  | 'ROOM_TONE_SILENT_MASK';   // Seamless replacement with ambient room tone

export interface DetectedSensitiveSpan {
  readonly redactionId: string;
  readonly category: 'PHONE_NUMBER' | 'NATIONAL_ID_OR_CARD' | 'CUSTOM_BLACKLIST_WORD';
  readonly range: TimeRange;
  readonly tokenIds: string[];
  readonly redactedDisplayPreview: string;
}

/**
 * Sensitive Personal Information (PII) & Confidential Content Audio/Transcript Redactor
 * (Section 81 — Architecture Doc Sections 2.6 & 42)
 * Automatically detects Persian phone numbers, national IDs, bank card numbers (spoken or digits),
 * and custom user blacklist words, and generates non-destructive audio masks (1kHz Broadcast Bleep,
 * 210Hz Low-Pass Voice Muffle, or Room Tone mask).
 */
export class SensitiveContentAndPiiRedactorEngine {
  private static readonly PII_CONTEXT_TRIGGERS = new Set([
    'موبایل', 'تلفن', 'شماره', 'کدملی', 'کارت', 'حساب', 'شبا', 'رمز', 'پلاک',
  ]);

  /**
   * 1. Scans timed Persian transcript tokens for PII sequences and custom confidential words.
   */
  public static scanTranscriptForSensitiveContent(
    tokens: readonly TimedPersianToken[],
    customConfidentialWords: readonly string[] = [],
  ): DetectedSensitiveSpan[] {
    const customSet = new Set(customConfidentialWords.map((w) => w.trim()));
    const findings: DetectedSensitiveSpan[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      if (customSet.has(tok.normalizedText) || customSet.has(tok.displayText)) {
        findings.push({
          redactionId: `red_custom_${tok.tokenId}`,
          category: 'CUSTOM_BLACKLIST_WORD',
          range: tok.range,
          tokenIds: [tok.tokenId],
          redactedDisplayPreview: '[حذف‌شده به دستور کاربر]',
        });
        continue;
      }

      if (this.PII_CONTEXT_TRIGGERS.has(tok.normalizedText) && i + 1 < tokens.length) {
        let triggerTok = tok;
        while (
          i + 1 < tokens.length &&
          this.PII_CONTEXT_TRIGGERS.has(tokens[i + 1].normalizedText)
        ) {
          i++;
          triggerTok = tokens[i];
        }

        const spanTokens: TimedPersianToken[] = [];
        let k = i + 1;
        while (
          k < tokens.length &&
          k <= i + 12 &&
          (/[0-9\u06F0-\u06F9]/.test(tokens[k].displayText) ||
            /^(صفر|یک|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|پونزده|شانزده|شونزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|صد|دویست|سیصد|چهارصد|پانصد|پونصد|ششصد|شیصد|هفتصد|هشتصد|نهصد|هزار|و)$/.test(
              tokens[k].normalizedText,
            ))
        ) {
          spanTokens.push(tokens[k]);
          k++;
        }

        if (spanTokens.length >= 2) {
          findings.push({
            redactionId: `red_pii_${triggerTok.tokenId}`,
            category:
              triggerTok.normalizedText === 'موبایل' || triggerTok.normalizedText === 'تلفن'
                ? 'PHONE_NUMBER'
                : 'NATIONAL_ID_OR_CARD',
            range: {
              start: spanTokens[0].range.start,
              end: spanTokens[spanTokens.length - 1].range.end,
            },
            tokenIds: spanTokens.map((t) => t.tokenId),
            redactedDisplayPreview: `${triggerTok.displayText} [اطلاعات شخصی پوشانده شد]`,
          });
          i = k - 1;
        }
      }
    }

    return findings;
  }

  /**
   * 2. Generates a redacted audio buffer (1kHz Broadcast Bleep, 210Hz Low-Pass Muffle, or Room Tone)
   * with 15ms cosine fades to prevent clicks.
   */
  public static generateRedactedAudioSegment(
    originalSegmentPcm: Float32Array,
    roomToneBuffer: Float32Array,
    sampleRate: SampleRate,
    mode: AudioRedactionMaskMode,
  ): Float32Array {
    const len = originalSegmentPcm.length;
    const out = new Float32Array(len);
    if (len === 0) return out;
    const fadeSamples = Math.min(
      Math.floor(len / 3),
      Math.floor((sampleRate * 15) / 1000),
    );

    const blendWithOriginalEdges = (masked: Float32Array) => {
      if (fadeSamples <= 0) return;
      for (let i = 0; i < fadeSamples; i++) {
        const alpha = 0.5 * (1.0 - Math.cos((Math.PI * i) / fadeSamples));
        const origHead = Number.isFinite(originalSegmentPcm[i]) ? originalSegmentPcm[i] : 0;
        masked[i] = origHead * (1.0 - alpha) + masked[i] * alpha;

        const tailIdx = len - 1 - i;
        const origTail = Number.isFinite(originalSegmentPcm[tailIdx])
          ? originalSegmentPcm[tailIdx]
          : 0;
        masked[tailIdx] = origTail * (1.0 - alpha) + masked[tailIdx] * alpha;
      }
    };

    if (mode === 'ROOM_TONE_SILENT_MASK') {
      const rtLen = roomToneBuffer.length;
      const cycle = rtLen * 2;
      for (let i = 0; i < len; i++) {
        if (rtLen > 0) {
          const pos = i % cycle;
          const idx = pos < rtLen ? pos : cycle - pos - 1;
          const rtSample = roomToneBuffer[idx];
          out[i] = Number.isFinite(rtSample) ? rtSample : 0;
        } else {
          out[i] = 0;
        }
      }
      blendWithOriginalEdges(out);
      return out;
    }

    if (mode === 'LOW_PASS_VOICE_MUFFLE') {
      const alpha = Math.exp((-2.0 * Math.PI * 210.0) / sampleRate);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < len; i++) {
        const raw = originalSegmentPcm[i];
        const x = Number.isFinite(raw) ? raw : 0;
        s1 = (1.0 - alpha) * x + alpha * s1;
        s2 = (1.0 - alpha) * s1 + alpha * s2;
        out[i] = s2 * 0.6;
      }
      blendWithOriginalEdges(out);
      return out;
    }

    // BROADCAST_BLEEP_1KHZ at -18 dBFS
    const bleepAmp = Math.pow(10, -18.0 / 20.0);
    for (let i = 0; i < len; i++) {
      let env = 1.0;
      if (fadeSamples > 0 && i < fadeSamples) {
        env = 0.5 * (1.0 - Math.cos((Math.PI * i) / fadeSamples));
      } else if (fadeSamples > 0 && i >= len - fadeSamples) {
        const rem = len - 1 - i;
        env = 0.5 * (1.0 - Math.cos((Math.PI * rem) / fadeSamples));
      }
      out[i] = Math.sin((2.0 * Math.PI * 1000.0 * i) / sampleRate) * bleepAmp * env;
    }

    return out;
  }
}
