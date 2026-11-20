/**
 * AVAPARDAZ — SHARED SUBTITLE & TRANSCRIPT EXPORTER (TXT / SRT / VTT / JSON)
 *
 * Used identically by:
 * - Local Companion Service (for Adobe Audition CEP Plugin & Desktop CLI)
 * - Web Application (client-side download & clipboard copy)
 *
 * Guarantees:
 * - UTF-8 safe Persian/English mixed-direction text preservation
 * - Exact millisecond SRT (`HH:MM:SS,mmm`) and VTT (`HH:MM:SS.mmm`) formatting
 * - Strict timestamp monotonicity & non-zero cue duration clamping
 * - NEVER fabricates word-level timestamps when only segment-level timestamps exist
 */

export type TranscriptExportFormat = 'txt' | 'srt' | 'vtt' | 'json';

export interface ExportableWordTiming {
  readonly word: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface ExportableTranscriptSegment {
  readonly id: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly language?: string;
  readonly speaker?: string;
  readonly timestampGranularity?: 'WORD' | 'SEGMENT' | 'RECORDING' | 'UNAVAILABLE';
  readonly words?: readonly ExportableWordTiming[];
}

export interface TranscriptExportOptions {
  readonly format: TranscriptExportFormat;
  readonly segments: readonly ExportableTranscriptSegment[];
  readonly selectedIds?: readonly string[];
  readonly timelineOffsetSec?: number;
  readonly includeSpeakerLabels?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TranscriptExportResult {
  readonly format: TranscriptExportFormat;
  readonly mimeType: string;
  readonly fileExtension: string;
  readonly content: string;
  readonly segmentCount: number;
}

function clampNonNegative(sec: number): number {
  if (!Number.isFinite(sec) || sec < 0) return 0;
  return sec;
}

export function formatSrtTimestamp(seconds: number): string {
  const safe = clampNonNegative(seconds);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function formatVttTimestamp(seconds: number): string {
  return formatSrtTimestamp(seconds).replace(',', '.');
}

function normalizeSegmentsForExport(
  segments: readonly ExportableTranscriptSegment[],
  selectedIds?: readonly string[],
  timelineOffsetSec = 0,
): ExportableTranscriptSegment[] {
  const offset = Number.isFinite(timelineOffsetSec) && timelineOffsetSec >= 0 ? timelineOffsetSec : 0;
  const filterSet =
    selectedIds && selectedIds.length > 0 ? new Set(selectedIds) : null;

  const filtered = segments.filter((seg) => {
    if (!seg || typeof seg.text !== 'string') return false;
    if (filterSet && !filterSet.has(seg.id)) return false;
    return seg.text.trim().length > 0;
  });

  const sorted = [...filtered].sort((a, b) => a.startSec - b.startSec);
  let lastEnd = 0;

  return sorted.map((seg) => {
    const rawStart = clampNonNegative(seg.startSec) + offset;
    const startSec = Math.max(lastEnd, rawStart);
    const rawEnd = clampNonNegative(seg.endSec) + offset;
    const endSec = Math.max(startSec + 0.05, rawEnd);
    lastEnd = endSec;

    // Preserve genuine word timestamps ONLY when present; never fabricate them.
    const words =
      Array.isArray(seg.words) && seg.words.length > 0
        ? seg.words.map((w) => {
            const ws = clampNonNegative(w.startSec) + offset;
            const we = Math.max(ws + 0.02, clampNonNegative(w.endSec) + offset);
            return { word: w.word, startSec: Number(ws.toFixed(3)), endSec: Number(we.toFixed(3)) };
          })
        : [];

    return {
      id: seg.id,
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      text: seg.text.trim(),
      language: seg.language,
      speaker: seg.speaker,
      timestampGranularity:
        words.length > 0
          ? 'WORD'
          : seg.timestampGranularity ?? 'SEGMENT',
      words,
    };
  });
}

function formatLineText(seg: ExportableTranscriptSegment, includeSpeaker: boolean): string {
  if (includeSpeaker && seg.speaker && seg.speaker.trim().length > 0) {
    return `[${seg.speaker.trim()}] ${seg.text}`;
  }
  return seg.text;
}

export function exportTranscript(options: TranscriptExportOptions): TranscriptExportResult {
  const includeSpeaker = Boolean(options.includeSpeakerLabels);
  const normalized = normalizeSegmentsForExport(
    options.segments,
    options.selectedIds,
    options.timelineOffsetSec ?? 0,
  );

  switch (options.format) {
    case 'txt': {
      const content = normalized
        .map((seg) => formatLineText(seg, includeSpeaker))
        .join('\n');
      return {
        format: 'txt',
        mimeType: 'text/plain; charset=utf-8',
        fileExtension: 'txt',
        content,
        segmentCount: normalized.length,
      };
    }

    case 'srt': {
      const blocks = normalized.map((seg, idx) => {
        const start = formatSrtTimestamp(seg.startSec);
        const end = formatSrtTimestamp(seg.endSec);
        return `${idx + 1}\n${start} --> ${end}\n${formatLineText(seg, includeSpeaker)}`;
      });
      return {
        format: 'srt',
        mimeType: 'application/x-subrip; charset=utf-8',
        fileExtension: 'srt',
        content: blocks.join('\n\n') + (blocks.length > 0 ? '\n' : ''),
        segmentCount: normalized.length,
      };
    }

    case 'vtt': {
      const blocks = normalized.map((seg) => {
        const start = formatVttTimestamp(seg.startSec);
        const end = formatVttTimestamp(seg.endSec);
        return `${start} --> ${end}\n${formatLineText(seg, includeSpeaker)}`;
      });
      const content =
        blocks.length > 0
          ? `WEBVTT\n\n${blocks.join('\n\n')}\n`
          : 'WEBVTT\n';
      return {
        format: 'vtt',
        mimeType: 'text/vtt; charset=utf-8',
        fileExtension: 'vtt',
        content,
        segmentCount: normalized.length,
      };
    }

    case 'json': {
      const payload = {
        schema: 'avapardaz.transcript.export.v1',
        exportedAtIso: new Date().toISOString(),
        timelineOffsetSec: options.timelineOffsetSec ?? 0,
        segmentCount: normalized.length,
        metadata: options.metadata ?? {},
        segments: normalized.map((seg) => ({
          id: seg.id,
          startSec: seg.startSec,
          endSec: seg.endSec,
          text: seg.text,
          language: seg.language ?? 'unknown',
          speaker: seg.speaker ?? null,
          timestampGranularity: seg.timestampGranularity ?? 'SEGMENT',
          words: seg.words ?? [],
        })),
      };
      return {
        format: 'json',
        mimeType: 'application/json; charset=utf-8',
        fileExtension: 'json',
        content: JSON.stringify(payload, null, 2),
        segmentCount: normalized.length,
      };
    }
  }
}
