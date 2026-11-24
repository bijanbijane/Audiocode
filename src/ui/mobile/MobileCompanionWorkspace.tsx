import React, { useEffect, useRef, useState } from 'react';
import {
  BatteryWarning,
  Check,
  ChevronLeft,
  ChevronRight,
  Headphones,
  Undo2,
  Volume2,
  X,
} from 'lucide-react';
import {
  AIRecommendationRecord,
  RecommendationId,
} from '../../contracts/project-schema.contract';
import { TimeMath } from '../../contracts/timebase.contract';
import { PreviewAuditionMode } from '../../../packages/audio-runtime/src/SmartSplicePreviewEngine';

export interface MobileCompanionProps {
  projectName: string;
  pendingRecommendations: AIRecommendationRecord[];
  estimatedMemoryUsageMb: number;
  maxSafeMemoryMb: number; // e.g. 384 MB ceiling for iOS Safari
  onAuditionPreview: (recId: RecommendationId, mode: PreviewAuditionMode) => void;
  onNudgeCutBoundary: (
    recId: RecommendationId,
    edge: 'START' | 'END',
    deltaMs: number,
  ) => void;
  onAccept: (recId: RecommendationId) => void;
  onReject: (recId: RecommendationId) => void;
  onUndo: () => void;
}

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
}

export function clampMobileRecommendationIndex(index: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return Math.max(0, Math.min(index, totalCount - 1));
}

/**
 * Adaptive Mobile & Tablet Studio Companion (Sections 14 & 50)
 * Focused on one-thumb A/B auditioning, ±10ms boundary nudging,
 * battery-saver detection, and strict iOS/Android RAM budget monitoring.
 */
export const MobileCompanionWorkspace: React.FC<MobileCompanionProps> = ({
  projectName,
  pendingRecommendations,
  estimatedMemoryUsageMb,
  maxSafeMemoryMb,
  onAuditionPreview,
  onNudgeCutBoundary,
  onAccept,
  onReject,
  onUndo,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeAuditionMode, setActiveAuditionMode] =
    useState<PreviewAuditionMode>('AFTER_SPLICED');
  const [batteryPowerSaver, setBatteryPowerSaver] = useState(false);
  const touchStartXRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    let batteryObj: BatteryManagerLike | null = null;

    const updateBatteryState = (bat: BatteryManagerLike) => {
      if (mounted) {
        setBatteryPowerSaver(!bat.charging && bat.level <= 0.2);
      }
    };

    const onBatteryChange = () => {
      if (batteryObj) updateBatteryState(batteryObj);
    };

    const nav = navigator as unknown as {
      getBattery?: () => Promise<BatteryManagerLike>;
    };

    if (nav.getBattery) {
      nav
        .getBattery()
        .then((bat) => {
          if (!mounted) return;
          batteryObj = bat;
          updateBatteryState(bat);
          bat.addEventListener?.('levelchange', onBatteryChange);
          bat.addEventListener?.('chargingchange', onBatteryChange);
        })
        .catch(() => {});
    }

    return () => {
      mounted = false;
      if (batteryObj) {
        batteryObj.removeEventListener?.('levelchange', onBatteryChange);
        batteryObj.removeEventListener?.('chargingchange', onBatteryChange);
      }
    };
  }, []);

  const safeIndex = clampMobileRecommendationIndex(currentIndex, pendingRecommendations.length);
  const currentRec = pendingRecommendations[safeIndex];
  const safeMaxMb = Math.max(1, maxSafeMemoryMb);
  const memoryPercent = Math.min(100, Math.round((estimatedMemoryUsageMb / safeMaxMb) * 100));
  const memoryCritical = memoryPercent >= 85;

  if (!currentRec) {
    return (
      <div
        dir="rtl"
        className="min-h-screen bg-[var(--avp-bg)] text-[var(--avp-text)] p-5 flex flex-col justify-center items-center text-center"
      >
        <div className="w-16 h-16 rounded-full bg-[var(--avp-success-soft)] border border-[var(--avp-success)]/50 flex items-center justify-center mb-4">
          <Check className="w-7 h-7 text-[var(--avp-success-text)]" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-bold mb-2">تمام پیشنهادهای هوشمند بررسی شدند</h1>
        <p className="text-xs text-[var(--avp-text-secondary)] mb-6">
          پروژه «{projectName}» آماده خروجی گرفتن یا ادامه میکس پیشرفته در نسخه دسکتاپ است.
        </p>
        <button
          type="button"
          onClick={onUndo}
          className="avp-btn avp-btn-outline min-h-[44px] px-4 text-xs"
        >
          <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
          <span>بازگشت به آخرین تصمیم (Undo)</span>
        </button>
      </div>
    );
  }

  const range = currentRec.spliceDescriptor.snappedAcousticRange;
  const startSec = TimeMath.flicksToSeconds(range.start).toFixed(2);
  const endSec = TimeMath.flicksToSeconds(range.end).toFixed(2);
  const cutDurationMs = Math.round(TimeMath.flicksToSeconds(range.end - range.start) * 1000);

  return (
    <div
      dir="rtl"
      onTouchStart={(e) => {
        touchStartXRef.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        if (touchStartXRef.current === null) return;
        const endX = e.changedTouches[0]?.clientX ?? touchStartXRef.current;
        const deltaX = endX - touchStartXRef.current;
        touchStartXRef.current = null;
        if (Math.abs(deltaX) >= 72) {
          if (deltaX > 0) {
            onAccept(currentRec.id);
          } else {
            onReject(currentRec.id);
          }
        }
      }}
      className="min-h-screen bg-[var(--avp-bg)] text-[var(--avp-text)] flex flex-col justify-between p-4 select-none"
    >
      {/* Resource Budget & Review Progress Header */}
      <header className="flex flex-col gap-2 bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-xl p-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="font-bold text-sm truncate">{projectName} (حالت همراه موبایل)</h1>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              aria-label="پیشنهاد قبلی"
              disabled={safeIndex === 0}
              onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              className="avp-touch-icon rounded bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] text-[var(--avp-text)] disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </button>
            <span className="text-xs bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] px-2.5 py-1 rounded text-[var(--avp-accent-text)] font-mono">
              {safeIndex + 1} / {pendingRecommendations.length}
            </span>
            <button
              type="button"
              aria-label="پیشنهاد بعدی"
              disabled={safeIndex >= pendingRecommendations.length - 1}
              onClick={() =>
                setCurrentIndex((i) => Math.min(pendingRecommendations.length - 1, i + 1))
              }
              className="avp-touch-icon rounded bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] text-[var(--avp-text)] disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px] text-[var(--avp-text-secondary)]">
          <span className={memoryCritical ? 'text-[var(--avp-danger-text)] font-medium' : ''}>
            بودجه حافظه:{' '}
            <span dir="ltr" className="inline-block font-mono">
              {estimatedMemoryUsageMb}MB / {maxSafeMemoryMb}MB ({memoryPercent}%)
            </span>
          </span>
          {batteryPowerSaver && (
            <span className="inline-flex items-center gap-1 text-[var(--avp-warning-text)] font-medium">
              <BatteryWarning className="w-3.5 h-3.5" aria-hidden="true" />
              <span>ذخیره باتری فعال</span>
            </span>
          )}
        </div>
      </header>

      {/* Center Review Card & A/B Audition Controls */}
      <main className="my-4 bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-2xl p-4 flex flex-col gap-4 shadow-lg">
        <div className="flex items-center justify-between text-xs">
          <span dir="ltr" className="px-2.5 py-1 rounded-md bg-[var(--avp-danger-soft)] text-[var(--avp-danger-text)] border border-[var(--avp-danger)]/40 font-mono font-semibold">
            {currentRec.disfluencyType}
          </span>
          <span className="text-[var(--avp-text-secondary)]">
            <span dir="ltr" className="inline-block font-mono">
              {startSec}s - {endSec}s ({cutDurationMs} ms)
            </span>
          </span>
        </div>

        <div className="bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] rounded-xl p-4 text-center">
          <p className="text-base font-medium text-[var(--avp-text)] leading-8">
            «{currentRec.associatedText}»
          </p>
          <p className="text-xs text-[var(--avp-text-secondary)] mt-1">
            اطمینان تشخیص:{' '}
            <span dir="ltr" className="inline-block font-mono">
              {Math.round(currentRec.spliceDescriptor.confidence * 100)}%
            </span>
          </p>
        </div>

        {/* A/B Audition Preview Buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              setActiveAuditionMode('AFTER_SPLICED');
              onAuditionPreview(currentRec.id, 'AFTER_SPLICED');
            }}
            className={`inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-xl text-xs font-semibold border transition cursor-pointer ${
              activeAuditionMode === 'AFTER_SPLICED'
                ? 'bg-[var(--avp-brand)] border-[var(--avp-brand)] text-[var(--avp-on-brand)]'
                : 'bg-[var(--avp-bg-subtle)] border-[var(--avp-border)] text-[var(--avp-text-secondary)]'
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>شنیدن پس از اصلاح (B)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveAuditionMode('BEFORE_ORIGINAL');
              onAuditionPreview(currentRec.id, 'BEFORE_ORIGINAL');
            }}
            className={`inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-xl text-xs font-semibold border transition cursor-pointer ${
              activeAuditionMode === 'BEFORE_ORIGINAL'
                ? 'bg-[var(--avp-warning)] border-[var(--avp-warning)] text-[var(--avp-on-brand)]'
                : 'bg-[var(--avp-bg-subtle)] border-[var(--avp-border)] text-[var(--avp-text-secondary)]'
            }`}
          >
            <Headphones className="w-3.5 h-3.5" aria-hidden="true" />
            <span>شنیدن صدای اصلی (A)</span>
          </button>
        </div>

        {/* Fine-Grained ±10ms Boundary Nudging */}
        <div className="bg-[var(--avp-bg-subtle)] rounded-xl p-3 border border-[var(--avp-border)] flex flex-col gap-2">
          <span className="text-[11px] text-[var(--avp-text-secondary)] text-center">
            اصلاح دستی مرز برش (با حفظ خودکار Zero-Crossing)
          </span>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="flex items-center justify-between bg-[var(--avp-surface)] rounded-lg p-1.5 border border-[var(--avp-border-subtle)]">
              <button
                type="button"
                dir="ltr"
                aria-label="کاهش شروع برش ۱۰ میلی‌ثانیه"
                onClick={() => onNudgeCutBoundary(currentRec.id, 'START', -10)}
                className="min-h-[44px] min-w-[44px] px-2 py-1 bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] rounded font-mono cursor-pointer text-[var(--avp-text)]"
              >
                -10ms
              </button>
              <span className="text-[11px] text-[var(--avp-text-secondary)]">شروع</span>
              <button
                type="button"
                dir="ltr"
                aria-label="افزایش شروع برش ۱۰ میلی‌ثانیه"
                onClick={() => onNudgeCutBoundary(currentRec.id, 'START', 10)}
                className="min-h-[44px] min-w-[44px] px-2 py-1 bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] rounded font-mono cursor-pointer text-[var(--avp-text)]"
              >
                +10ms
              </button>
            </div>

            <div className="flex items-center justify-between bg-[var(--avp-surface)] rounded-lg p-1.5 border border-[var(--avp-border-subtle)]">
              <button
                type="button"
                dir="ltr"
                aria-label="کاهش پایان برش ۱۰ میلی‌ثانیه"
                onClick={() => onNudgeCutBoundary(currentRec.id, 'END', -10)}
                className="min-h-[44px] min-w-[44px] px-2 py-1 bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] rounded font-mono cursor-pointer text-[var(--avp-text)]"
              >
                -10ms
              </button>
              <span className="text-[11px] text-[var(--avp-text-secondary)]">پایان</span>
              <button
                type="button"
                dir="ltr"
                aria-label="افزایش پایان برش ۱۰ میلی‌ثانیه"
                onClick={() => onNudgeCutBoundary(currentRec.id, 'END', 10)}
                className="min-h-[44px] min-w-[44px] px-2 py-1 bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)] rounded font-mono cursor-pointer text-[var(--avp-text)]"
              >
                +10ms
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* One-Thumb Bottom Decision Footer */}
      <footer className="grid grid-cols-3 gap-2.5">
        <button
          type="button"
          onClick={() => onReject(currentRec.id)}
          className="avp-btn avp-btn-outline min-h-[48px] rounded-xl font-semibold text-sm"
        >
          <X className="w-4 h-4" aria-hidden="true" />
          <span>رد پیشنهاد</span>
        </button>
        <button
          type="button"
          onClick={onUndo}
          className="avp-btn avp-btn-tonal min-h-[48px] rounded-xl text-xs font-medium"
        >
          <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
          <span>واگرد</span>
        </button>
        <button
          type="button"
          onClick={() => onAccept(currentRec.id)}
          className="avp-btn min-h-[48px] rounded-xl bg-[var(--avp-success)] text-[var(--avp-on-brand)] font-bold text-sm shadow-md"
        >
          <Check className="w-4 h-4" aria-hidden="true" />
          <span>تأیید و برش</span>
        </button>
      </footer>
    </div>
  );
};
