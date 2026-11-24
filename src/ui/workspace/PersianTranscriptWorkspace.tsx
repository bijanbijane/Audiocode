import React, { useMemo, useState } from 'react';
import { AlertTriangle, Volume2 } from 'lucide-react';
import { AIRecommendationRecord, RecommendationId } from '../../contracts/project-schema.contract';
import { TimedPersianToken } from '../../ai-engine/PersianTextNormalizer';
import { Flicks, TimeMath, TimeRange } from '../../contracts/timebase.contract';
import { ProsodicWarningType } from '../../contracts/persian-editing.contract';

interface WorkspaceProps {
  tokens: TimedPersianToken[];
  recommendations: AIRecommendationRecord[];
  playheadFlicks: Flicks;
  onSeek: (targetFlicks: Flicks) => void;
  /** Previews 1.5s before and after the splice with Pre-Roll and Room Tone */
  onPreviewSplice: (recId: RecommendationId, previewWindow: TimeRange) => void;
  onAcceptRecommendation: (recId: RecommendationId) => void;
  onRejectRecommendation: (recId: RecommendationId, reason?: string) => void;
  /** Edits display text without mutating underlying audio or original ASR provenance (Sections 26-27) */
  onUpdateDisplayTranscript: (tokenId: string, newDisplayText: string) => void;
}

const WARNING_LABELS: Record<ProsodicWarningType, string> = {
  TRAILING_EZAFE_RISK: 'هشدار کسره اضافه («ـِ» معلق در انتهای کلمه قبلی)',
  COMPOUND_VERB_SPLIT: 'هشدار برش در میانه فعل مرکب فارسی',
  CROSSTALK_BLEED_ACTIVE: 'گفتار هم‌زمان در ترک دیگر (جایگزینی درجا با صدای محیط برای حفظ سینک)',
};

export const PersianTranscriptWorkspace: React.FC<WorkspaceProps> = ({
  tokens,
  recommendations,
  playheadFlicks,
  onSeek,
  onPreviewSplice,
  onAcceptRecommendation,
  onRejectRecommendation,
  onUpdateDisplayTranscript,
}) => {
  const [showLowConfidence, setShowLowConfidence] = useState(false);
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [draftDisplayText, setDraftDisplayText] = useState('');

  const { highConfidenceRecs, lowConfidenceRecs } = useMemo(() => {
    const pending = recommendations.filter((r) => r.status === 'PENDING');
    return {
      highConfidenceRecs: pending.filter((r) => r.spliceDescriptor.confidence >= 0.75),
      lowConfidenceRecs: pending.filter((r) => r.spliceDescriptor.confidence < 0.75),
    };
  }, [recommendations]);

  const visibleRecs = showLowConfidence
    ? [...highConfidenceRecs, ...lowConfidenceRecs]
    : highConfidenceRecs;

  const handlePreviewClick = (rec: AIRecommendationRecord) => {
    const cutRange = rec.spliceDescriptor.snappedAcousticRange;
    const margin = TimeMath.secondsToFlicks(1.5);
    onPreviewSplice(rec.id, {
      start: Math.max(0, cutRange.start - margin),
      end: cutRange.end + margin,
    });
  };

  return (
    <div dir="rtl" className="grid grid-cols-1 lg:grid-cols-12 gap-4 bg-[var(--avp-bg)] text-[var(--avp-text)] p-4 rounded-xl">
      {/* Transcript Panel */}
      <div className="lg:col-span-7 bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-lg p-4 max-h-[65vh] overflow-y-auto leading-9">
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-[var(--avp-border)]">
          <h2 className="font-bold text-base text-[var(--avp-text)]">متن گفتار فارسی (همگام با نمونه صوتی)</h2>
          <span className="text-xs text-[var(--avp-text-secondary)]">
            زمان جاری:{' '}
            <span dir="ltr" className="inline-block font-mono">
              {TimeMath.flicksToSeconds(playheadFlicks).toFixed(2)}s
            </span>
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {tokens.map((token) => {
            const isActive =
              playheadFlicks >= token.range.start && playheadFlicks < token.range.end;
            const linkedRec = recommendations.find(
              (r) =>
                r.status === 'PENDING' &&
                r.spliceDescriptor.snappedAcousticRange.start < token.range.end &&
                r.spliceDescriptor.snappedAcousticRange.end > token.range.start,
            );

            if (editingTokenId === token.tokenId) {
              return (
                <input
                  key={token.tokenId}
                  type="text"
                  value={draftDisplayText}
                  autoFocus
                  aria-label={`ویرایش متن نمایشی ${token.originalText}`}
                  onChange={(e) => setDraftDisplayText(e.target.value)}
                  onBlur={() => {
                    if (draftDisplayText.trim()) {
                      onUpdateDisplayTranscript(token.tokenId, draftDisplayText.trim());
                    }
                    setEditingTokenId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (draftDisplayText.trim()) {
                        onUpdateDisplayTranscript(token.tokenId, draftDisplayText.trim());
                      }
                      setEditingTokenId(null);
                    } else if (e.key === 'Escape') {
                      setEditingTokenId(null);
                    }
                  }}
                  className="avp-input px-2 py-0.5 text-sm"
                />
              );
            }

            return (
              <button
                key={token.tokenId}
                type="button"
                onClick={() => onSeek(token.range.start)}
                onDoubleClick={() => {
                  setEditingTokenId(token.tokenId);
                  setDraftDisplayText(token.displayText);
                }}
                title={`اطمینان تشخیص: ${Math.round(token.confidence * 100)}% | متن خام: ${token.originalText}`}
                className={`cursor-pointer px-1.5 py-0.5 rounded transition-colors select-text ${
                  isActive
                    ? 'bg-[var(--avp-brand-solid)] text-[var(--avp-on-brand)] font-semibold'
                    : linkedRec
                      ? 'bg-[var(--avp-danger-soft)] text-[var(--avp-danger-text)] underline decoration-wavy decoration-[var(--avp-danger)]'
                      : token.confidence < 0.65
                        ? 'border-b border-dashed border-[var(--avp-warning)] text-[var(--avp-warning-text)]'
                        : 'hover:bg-[var(--avp-surface-hover)]'
                }`}
              >
                {token.displayText}
              </button>
            );
          })}
        </div>
      </div>

      {/* Smart Suggestions Panel */}
      <div className="lg:col-span-5 bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-lg p-4 max-h-[65vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-[var(--avp-border)]">
          <h2 className="font-bold text-base text-[var(--avp-text)]">
            پیشنهادهای اصلاح هوشمند ({highConfidenceRecs.length})
          </h2>
          {lowConfidenceRecs.length > 0 && (
            <button
              type="button"
              onClick={() => setShowLowConfidence((prev) => !prev)}
              className="avp-btn avp-btn-sm avp-btn-warning-tonal"
            >
              {showLowConfidence
                ? 'پنهان‌کردن پیشنهادهای کم‌اطمینان'
                : `نمایش ${lowConfidenceRecs.length} پیشنهاد کم‌اطمینان`}
            </button>
          )}
        </div>

        <div className="space-y-3">
          {visibleRecs.map((rec) => {
            const startSec = TimeMath.flicksToSeconds(
              rec.spliceDescriptor.snappedAcousticRange.start,
            ).toFixed(2);
            const endSec = TimeMath.flicksToSeconds(
              rec.spliceDescriptor.snappedAcousticRange.end,
            ).toFixed(2);

            return (
              <div
                key={rec.id}
                className="p-3 rounded-lg bg-[var(--avp-surface-secondary)] border border-[var(--avp-border)] flex flex-col gap-2"
              >
                <div className="flex items-center justify-between text-xs">
                  <span dir="ltr" className="font-semibold font-mono text-[var(--avp-danger-text)]">
                    {rec.disfluencyType}
                  </span>
                  <span className="text-[var(--avp-text-secondary)]">
                    بازه:{' '}
                    <span dir="ltr" className="inline-block font-mono">
                      {startSec}s - {endSec}s
                    </span>{' '}
                    | اطمینان:{' '}
                    <span dir="ltr" className="inline-block font-mono">
                      {Math.round(rec.spliceDescriptor.confidence * 100)}%
                    </span>
                  </span>
                </div>

                <div className="text-sm bg-[var(--avp-surface)] px-2.5 py-1.5 rounded text-[var(--avp-text)]">
                  «{rec.associatedText}»
                </div>

                {rec.spliceDescriptor.prosodicWarnings.map((w) => (
                  <div
                    key={w}
                    className="flex items-center gap-1.5 text-xs bg-[var(--avp-warning-soft)] border border-[var(--avp-warning)]/40 text-[var(--avp-warning-text)] px-2 py-1 rounded"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{WARNING_LABELS[w]}</span>
                  </div>
                ))}

                <div className="flex items-center gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => handlePreviewClick(rec)}
                    className="avp-btn avp-btn-sm avp-btn-tonal flex-1"
                  >
                    <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>شنیدن پیش‌نمایش اتصال</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onAcceptRecommendation(rec.id)}
                    className="avp-btn avp-btn-sm avp-btn-secondary"
                  >
                    تأیید و اعمال
                  </button>
                  <button
                    type="button"
                    onClick={() => onRejectRecommendation(rec.id)}
                    className="avp-btn avp-btn-sm avp-btn-outline"
                  >
                    رد کردن
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
