/**
 * @file backend/src/delivery/BackendTranscriptFormatterAndWebhookService.ts
 * @description Section 136: Persian SubRip (.srt) & Speaker-Annotated Transcript Formatter
 *              + HMAC-SHA256 Anti-Replay Webhook Signing & Verification Service.
 */

import * as crypto from 'node:crypto';

export interface DeliverableWordToken {
  word: string;
  startSec: number;
  endSec: number;
  speakerId?: string;
}

export interface SignedWebhookHeaders {
  'X-PAudio-Timestamp': string;
  'X-PAudio-Signature-256': string;
  'Content-Type': 'application/json; charset=utf-8';
}

export class BackendTranscriptFormatterAndWebhookService {
  /**
   * Formats seconds as SRT timestamp `HH:MM:SS,mmm`.
   */
  public static formatSrtTimestamp(seconds: number): string {
    const clampedMs = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(clampedMs / 3_600_000);
    const minutes = Math.floor((clampedMs % 3_600_000) / 60_000);
    const secs = Math.floor((clampedMs % 60_000) / 1000);
    const millis = clampedMs % 1000;

    return (
      String(hours).padStart(2, '0') +
      ':' +
      String(minutes).padStart(2, '0') +
      ':' +
      String(secs).padStart(2, '0') +
      ',' +
      String(millis).padStart(3, '0')
    );
  }

  /**
   * Formats seconds as bracketed clock timestamp `[HH:MM:SS]`.
   */
  public static formatClockTimestamp(seconds: number): string {
    const totalSecs = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;

    return `[${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}]`;
  }

  /**
   * Wraps Persian words into at most 2 balanced subtitle lines without ever splitting
   * inside a ZWNJ (\u200C) compound word.
   */
  private static wrapSubtitleLines(words: string[], maxLineChars: number): string {
    const fullText = words.join(' ');
    if (fullText.length <= maxLineChars || words.length <= 1) {
      return fullText;
    }

    const line1: string[] = [];
    const line2: string[] = [];
    let currentLine1Len = 0;

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const nextLen = currentLine1Len === 0 ? w.length : currentLine1Len + 1 + w.length;
      if (line2.length === 0 && (nextLen <= maxLineChars || line1.length === 0)) {
        line1.push(w);
        currentLine1Len = nextLen;
      } else {
        line2.push(w);
      }
    }

    return line2.length > 0 ? `${line1.join(' ')}\n${line2.join(' ')}` : line1.join(' ');
  }

  /**
   * Generates broadcast-compliant Persian SubRip (.srt) subtitles from word-level tokens.
   * Respects maxCharsPerLine (default 42), maxLinesPerCue (2), maxCueDurationSec (6.0s),
   * and splits cues cleanly on speaker changes or silence gaps >= 0.8s.
   */
  public static formatToPersianSrt(
    words: DeliverableWordToken[],
    maxCharsPerLine: number = 42,
    maxCueDurationSec: number = 6.0
  ): string {
    if (words.length === 0) return '';

    const cues: { startSec: number; endSec: number; text: string }[] = [];
    let currentWords: DeliverableWordToken[] = [];

    const flushCue = () => {
      if (currentWords.length === 0) return;
      const startSec = currentWords[0].startSec;
      const endSec = Math.max(startSec + 0.2, currentWords[currentWords.length - 1].endSec);
      const tokenStrings = currentWords.map((w) => w.word);
      cues.push({
        startSec,
        endSec,
        text: this.wrapSubtitleLines(tokenStrings, maxCharsPerLine),
      });
      currentWords = [];
    };

    for (const token of words) {
      if (currentWords.length === 0) {
        currentWords.push(token);
        continue;
      }

      const first = currentWords[0];
      const prev = currentWords[currentWords.length - 1];
      const candidateDuration = token.endSec - first.startSec;
      const silenceGap = token.startSec - prev.endSec;
      const speakerChanged = Boolean(token.speakerId && prev.speakerId && token.speakerId !== prev.speakerId);
      const candidateChars = currentWords.reduce((acc, w) => acc + w.word.length + 1, 0) + token.word.length;

      if (
        speakerChanged ||
        silenceGap >= 0.85 ||
        candidateDuration > maxCueDurationSec ||
        candidateChars > maxCharsPerLine * 2
      ) {
        flushCue();
      }

      currentWords.push(token);
    }

    flushCue();

    return cues
      .map(
        (cue, idx) =>
          `${idx + 1}\n${this.formatSrtTimestamp(cue.startSec)} --> ${this.formatSrtTimestamp(cue.endSec)}\n${cue.text}`
      )
      .join('\n\n') + '\n';
  }

  /**
   * Formats TimedPersianToken[] (Flicks timebase) into broadcast-compliant Persian SubRip (.srt).
   */
  public static formatTokensToPersianSrt(
    tokens: {
      displayText: string;
      range: { start: number; end: number };
      speakerId?: string;
    }[],
    maxCharsPerLine: number = 42,
    maxCueDurationSec: number = 6.0
  ): string {
    const deliverableWords: DeliverableWordToken[] = tokens.map((t) => ({
      word: t.displayText,
      startSec: t.range.start / 705_600_000,
      endSec: t.range.end / 705_600_000,
      speakerId: t.speakerId,
    }));
    return this.formatToPersianSrt(deliverableWords, maxCharsPerLine, maxCueDurationSec);
  }

  /**
   * Formats diarized word tokens into a human-readable speaker-annotated Persian transcript:
   *   [00:00:01] SPEAKER_1: درود بر شما...
   */
  public static formatSpeakerAnnotatedTranscript(words: DeliverableWordToken[]): string {
    if (words.length === 0) return '';

    const paragraphs: { startSec: number; speakerId: string; tokens: string[] }[] = [];

    for (const w of words) {
      const spk = w.speakerId ?? 'SPEAKER_1';
      const last = paragraphs[paragraphs.length - 1];

      if (!last || last.speakerId !== spk) {
        paragraphs.push({
          startSec: w.startSec,
          speakerId: spk,
          tokens: [w.word],
        });
      } else {
        last.tokens.push(w.word);
      }
    }

    return paragraphs
      .map((p) => `${this.formatClockTimestamp(p.startSec)} ${p.speakerId}: ${p.tokens.join(' ')}`)
      .join('\n');
  }

  /**
   * Computes an anti-replay HMAC-SHA256 webhook signature over `${timestampUnixSec}.${rawJsonBody}`.
   */
  public static signWebhookPayload(
    rawJsonBody: string,
    webhookSecret: string,
    timestampUnixSec: number = Math.floor(Date.now() / 1000)
  ): SignedWebhookHeaders {
    const canonicalString = `${timestampUnixSec}.${rawJsonBody}`;
    const hmacHex = crypto
      .createHmac('sha256', webhookSecret)
      .update(canonicalString, 'utf8')
      .digest('hex');

    return {
      'X-PAudio-Timestamp': String(timestampUnixSec),
      'X-PAudio-Signature-256': `sha256=${hmacHex}`,
      'Content-Type': 'application/json; charset=utf-8',
    };
  }

  /**
   * Verifies an incoming webhook signature using constant-time comparison (`crypto.timingSafeEqual`)
   * and enforces a strict timestamp freshness window (default 300 seconds) to block replay attacks.
   */
  public static verifyWebhookSignature(
    rawJsonBody: string,
    timestampHeader: string,
    signatureHeader: string,
    webhookSecret: string,
    nowUnixSec: number = Math.floor(Date.now() / 1000),
    maxClockSkewSec: number = 300
  ): { valid: boolean; reason?: 'INVALID_TIMESTAMP' | 'TIMESTAMP_EXPIRED_REPLAY_BLOCKED' | 'SIGNATURE_MISMATCH' } {
    const ts = Number(timestampHeader);
    if (!Number.isInteger(ts) || ts <= 0) {
      return { valid: false, reason: 'INVALID_TIMESTAMP' };
    }

    if (Math.abs(nowUnixSec - ts) > maxClockSkewSec) {
      return { valid: false, reason: 'TIMESTAMP_EXPIRED_REPLAY_BLOCKED' };
    }

    const expected = this.signWebhookPayload(rawJsonBody, webhookSecret, ts)['X-PAudio-Signature-256'];
    const actualBuf = Buffer.from(signatureHeader, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');

    if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
      return { valid: false, reason: 'SIGNATURE_MISMATCH' };
    }

    return { valid: true };
  }
}
