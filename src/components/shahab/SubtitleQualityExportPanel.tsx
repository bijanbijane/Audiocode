import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  FileText,
  Play,
  Subtitles,
} from 'lucide-react';

interface SubtitleQualityExportPanelProps {
  subtitleState: Record<string, any> | null;
}

const PROFILE_OPTIONS = [
  { id: 'PODCAST', label: 'PODCAST — پادکست' },
  { id: 'EDUCATIONAL', label: 'EDUCATIONAL — آموزشی' },
  { id: 'INTERVIEW', label: 'INTERVIEW — مصاحبه' },
  { id: 'DOCUMENTARY', label: 'DOCUMENTARY — مستند' },
  { id: 'FAST_SOCIAL', label: 'FAST_SOCIAL — شبکه اجتماعی' },
  { id: 'LECTURE', label: 'LECTURE — سخنرانی دانشگاهی' },
  { id: 'ACCESSIBILITY_FIRST', label: 'ACCESSIBILITY_FIRST — دسترس‌پذیری (SDH)' },
  { id: 'VERBATIM_ARCHIVAL', label: 'VERBATIM_ARCHIVAL — آرشیوی عین‌به‌عین' },
] as const;

type ExportFormatKey = 'srt' | 'webvtt' | 'ttml' | 'jsonSidecar';

function SubtitleBadge({ value }: { value: string }) {
  const upper = String(value || 'UNKNOWN').toUpperCase();
  let cls = 'border-slate-600/80 bg-slate-800/70 text-slate-200';
  if (upper.includes('ERROR') || upper.includes('FAIL') || upper.includes('NOT_TESTED')) {
    cls = 'border-rose-500/60 bg-rose-950/60 text-rose-200';
  } else if (upper.includes('WARN') || upper.includes('PARTIAL') || upper.includes('OVERLAP')) {
    cls = 'border-amber-500/60 bg-amber-950/50 text-amber-200';
  } else if (upper === 'PASSED' || upper === 'PASS' || upper === 'VERIFIED' || upper === 'TRUE') {
    cls = 'border-emerald-500/50 bg-emerald-950/40 text-emerald-200';
  }
  return (
    <span
      className={`inline-block px-2 py-0.5 text-[11px] font-mono font-semibold tracking-tight border rounded-sm ${cls}`}
    >
      {upper}
    </span>
  );
}

export const SubtitleQualityExportPanel: React.FC<SubtitleQualityExportPanelProps> = ({
  subtitleState,
}) => {
  const [profileId, setProfileId] = useState<string>('PODCAST');
  const [mode, setMode] = useState<string>('CLEANED');
  const [bidiPolicy, setBidiPolicy] = useState<string>('RLM_ANCHORED');
  const [numeralPolicy, setNumeralPolicy] = useState<string>('PRESERVE_ORIGINAL');
  const [includeSpeakers, setIncludeSpeakers] = useState<boolean>(true);
  const [transcriptText, setTranscriptText] = useState<string>(
    'سلام و وقت بخیر، امروز در استودیو آواپرداز می‌خواهیم موتور SHAHAB نسخه 2.0 را بررسی کنیم. بله، دقیقاً هم‌زمان درباره کیفیت زیرنویس فارسی و استانداردهای SDK صحبت می‌کنیم. متشکرم، بیایید از زمان‌بندی دقیق و نیم‌فاصله‌ها شروع کنیم.',
  );
  const [exportTab, setExportTab] = useState<ExportFormatKey>('srt');
  const [generating, setGenerating] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [liveDoc, setLiveDoc] = useState<Record<string, any> | null>(null);
  const [liveExports, setLiveExports] = useState<Record<string, any> | null>(null);

  const activeDoc = liveDoc ?? subtitleState?.sampleDocument ?? null;
  const activeExports = liveExports ?? subtitleState?.exports ?? null;

  const handleGenerate = async () => {
    setGenerating(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/shahab/subtitles/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId,
          mode,
          bidiPolicy,
          numeralPolicy,
          includeSpeakers,
          transcriptText,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json?.message || 'Subtitle generation failed.');
        return;
      }
      setLiveDoc(json.document ?? null);
      setLiveExports(json.exports ?? null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const cues: Array<Record<string, any>> = Array.isArray(activeDoc?.cues) ? activeDoc.cues : [];
  const qaReport = activeDoc?.qaReport ?? null;
  const currentExport = activeExports?.[exportTab] ?? null;
  const exportPreviewText: string =
    currentExport?.content ?? currentExport?.preview ?? '(Generate live subtitles to inspect full serialized payload)';

  return (
    <div className="space-y-4" data-testid="subtitle-quality-export-panel">
      {/* Header & Honest Status */}
      <section className="bg-[#0F1522] border border-[#232D42] rounded-md overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#1E2738] bg-[#121A2B]">
          <div className="flex items-center gap-2">
            <Subtitles className="w-4 h-4 text-amber-300" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 tracking-tight">
                SHAHAB-027 — Professional Persian Subtitle &amp; Caption Engineering
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                5 separated timing domains · Grapheme-cluster CPS &amp; Persian WPM · RTL/ZWNJ/mixed-script bidi · Validated SRT / WebVTT / TTML / JSON Sidecar
              </p>
            </div>
          </div>
          <SubtitleBadge value={subtitleState?.finalStatus ?? 'PARTIALLY_VERIFIED'} />
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Editorial Profiles
              </div>
              <div className="text-sm font-mono font-semibold text-slate-100 mt-1 tabular-nums">
                {subtitleState?.availableProfiles?.length ?? 8} Persian Profiles
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                QA Gate Status
              </div>
              <div className="text-xs font-mono font-semibold mt-1">
                {qaReport ? (
                  <span className={qaReport.passedWithoutErrors ? 'text-emerald-300' : 'text-rose-300'}>
                    {qaReport.errorCount} Errors · {qaReport.warningCount} Warnings
                  </span>
                ) : (
                  <span className="text-slate-400">N/A</span>
                )}
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Human Editorial Review
              </div>
              <div className="text-xs font-mono font-semibold text-amber-300 mt-1">
                NOT_TESTED
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">No human review panel run</div>
            </div>
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Live Audition Import
              </div>
              <div className="text-xs font-mono font-semibold text-rose-300 mt-1">
                NOT_TESTED (false)
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">Spec-validated files only</div>
            </div>
          </div>

          {/* Interactive Generator Controls */}
          <div className="bg-[#0B0F17] border border-[#232D42] rounded-sm p-3.5 space-y-3 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 items-end">
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">Profile</span>
                <select
                  data-testid="subtitle-profile-select"
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  className="w-full bg-[#0F1522] border border-[#2C3B57] text-slate-100 rounded-sm px-2 py-1.5 text-xs"
                >
                  {PROFILE_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">Mode</span>
                <select
                  data-testid="subtitle-mode-select"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  className="w-full bg-[#0F1522] border border-[#2C3B57] text-slate-100 rounded-sm px-2 py-1.5 font-mono text-xs"
                >
                  <option value="VERBATIM">VERBATIM</option>
                  <option value="CLEANED">CLEANED (Reversible)</option>
                  <option value="ACCESSIBILITY">ACCESSIBILITY (SDH)</option>
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">RTL Bidi Policy</span>
                <select
                  data-testid="subtitle-bidi-select"
                  value={bidiPolicy}
                  onChange={(e) => setBidiPolicy(e.target.value)}
                  className="w-full bg-[#0F1522] border border-[#2C3B57] text-slate-100 rounded-sm px-2 py-1.5 font-mono text-xs"
                >
                  <option value="RLM_ANCHORED">RLM_ANCHORED</option>
                  <option value="ISOLATE_FSI_PDI">ISOLATE_FSI_PDI</option>
                  <option value="PLAIN_UNICODE_LOGICAL">PLAIN_UNICODE_LOGICAL</option>
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">Numerals</span>
                <select
                  value={numeralPolicy}
                  onChange={(e) => setNumeralPolicy(e.target.value)}
                  className="w-full bg-[#0F1522] border border-[#2C3B57] text-slate-100 rounded-sm px-2 py-1.5 font-mono text-xs"
                >
                  <option value="PRESERVE_ORIGINAL">PRESERVE_ORIGINAL</option>
                  <option value="PERSIAN_DIGITS">PERSIAN_DIGITS (۰-۹)</option>
                  <option value="LATIN_DIGITS">LATIN_DIGITS (0-9)</option>
                </select>
              </label>

              <button
                type="button"
                data-testid="subtitle-generate-btn"
                disabled={generating}
                onClick={() => void handleGenerate()}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/60 text-amber-200 rounded-sm cursor-pointer disabled:opacity-50 h-[32px]"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{generating ? 'Generating…' : 'Generate Subtitles'}</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeSpeakers}
                  onChange={(e) => setIncludeSpeakers(e.target.checked)}
                  className="accent-amber-400"
                />
                <span className="text-slate-300">Attach Speaker Diarization &amp; Overlap Markers</span>
              </label>
              {activeDoc?.profile && (
                <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                  Limits: max {activeDoc.profile.maxLines} lines · {activeDoc.profile.maxCharsPerLine}{' '}
                  chars/line · {activeDoc.profile.maxCps} CPS
                </span>
              )}
            </div>

            <textarea
              dir="rtl"
              rows={2}
              value={transcriptText}
              onChange={(e) => setTranscriptText(e.target.value)}
              className="w-full bg-[#0F1522] border border-[#2C3B57] text-slate-100 rounded-sm px-3 py-2 text-sm leading-relaxed"
            />

            {errorMsg && (
              <div className="flex items-center gap-2 px-3 py-2 bg-rose-950/60 border border-rose-500/50 text-rose-200 rounded-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Live Persian RTL Cue Preview & Separated Timing Domains */}
      {activeDoc && (
        <section
          className="bg-[#0F1522] border border-[#232D42] rounded-md overflow-hidden"
          data-testid="subtitle-cues-preview"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#1E2738] bg-[#121A2B]">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-sky-300" />
              <div>
                <h3 className="text-sm font-semibold text-slate-100 tracking-tight">
                  Persian RTL Cues &amp; Readability Inspection ({cues.length} Cues)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Acoustic range preserved separately from readability-adjusted display &amp; export ranges
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 font-mono text-[11px] text-slate-300 tabular-nums">
              <span>Max CPS: {Number(qaReport?.summaryMetrics?.maxCpsObserved ?? 0).toFixed(1)}</span>
              <span>·</span>
              <span>Mean CPS: {Number(qaReport?.summaryMetrics?.meanCpsObserved ?? 0).toFixed(1)}</span>
            </div>
          </div>

          <div className="p-4 space-y-2.5">
            {cues.map((cue) => (
              <div
                key={cue.cueId}
                className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-3 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-amber-300 font-semibold">#{cue.index}</span>
                    <span className="text-slate-300">
                      Display: {(cue.displayRange.startMs / 1000).toFixed(3)}s →{' '}
                      {(cue.displayRange.endMs / 1000).toFixed(3)}s ({cue.displayRange.durationMs} ms)
                    </span>
                    {cue.acousticRange && (
                      <span className="text-slate-500">
                        Acoustic: {Number(cue.acousticRange.startSec).toFixed(3)}s →{' '}
                        {Number(cue.acousticRange.endSec).toFixed(3)}s
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {cue.overlapFlag && <SubtitleBadge value="OVERLAP" />}
                    {cue.speakerDisplayLabel && (
                      <span className="px-1.5 py-0.5 bg-[#121A2B] border border-[#232D42] text-sky-200 rounded-sm">
                        {cue.speakerDisplayLabel}
                      </span>
                    )}
                    <span className="text-slate-300">
                      {Number(cue.readingMetrics?.cpsIncludingSpaces ?? 0).toFixed(1)} CPS ·{' '}
                      {Number(cue.readingMetrics?.wpm ?? 0).toFixed(0)} WPM
                    </span>
                  </div>
                </div>

                {/* Rendered RTL Caption Box */}
                <div
                  dir="rtl"
                  className="bg-[#06090F] border border-[#1B2436] rounded-sm px-4 py-2.5 text-center text-sm text-slate-50 leading-7 whitespace-pre-line"
                >
                  {cue.renderedText}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-400">
                  <span>
                    Bidi: {cue.rtlLayout?.bidiPolicy} · ZWNJ: {cue.rtlLayout?.zwnjCount ?? 0} · Mixed
                    Script: {String(Boolean(cue.rtlLayout?.mixedScriptDetected))} · Reversible:{' '}
                    {String(Boolean(cue.rtlLayout?.reversibleCleanTextVerified))}
                  </span>
                  <span>
                    Lines: {(cue.readingMetrics?.lineGraphemeCounts ?? []).join(' / ')} graphemes ·
                    Provenance: {cue.timingProvenance}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Multi-Format Validated Export Preview & Loss Accounting */}
      {activeExports && (
        <section
          className="bg-[#0F1522] border border-[#232D42] rounded-md overflow-hidden"
          data-testid="subtitle-export-preview"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#1E2738] bg-[#121A2B]">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-emerald-300" />
              <div>
                <h3 className="text-sm font-semibold text-slate-100 tracking-tight">
                  Validated Subtitle Exports &amp; Explicit Loss Accounting
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Round-trip parsed after serialization · ZWNJ preservation verified · Format limitations declared explicitly
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  { id: 'srt', label: 'SRT (UTF-8)' },
                  { id: 'webvtt', label: 'WebVTT' },
                  { id: 'ttml', label: 'TTML XML' },
                  { id: 'jsonSidecar', label: 'JSON Sidecar' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`subtitle-export-tab-${tab.id}`}
                  onClick={() => setExportTab(tab.id)}
                  className={`px-2.5 py-1 text-[11px] font-mono rounded-sm border cursor-pointer ${
                    exportTab === tab.id
                      ? 'bg-amber-400/15 border-amber-400/70 text-amber-200'
                      : 'bg-[#0B0F17] border-[#1E2738] text-slate-300 hover:bg-[#172033]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-4 space-y-3 text-xs">
            {currentExport && (
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Round-Trip:{' '}
                    {String(
                      currentExport.roundTripValidation?.passed ??
                        currentExport.roundTripPassed ??
                        false,
                    )}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-200">
                    ZWNJ Preserved:{' '}
                    {String(
                      currentExport.roundTripValidation?.zwnjPreserved ??
                        currentExport.zwnjPreserved ??
                        false,
                    )}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-400">
                    SHA-256: {String(currentExport.sha256 ?? '').slice(0, 16)}…
                  </span>
                </div>
              </div>
            )}

            {Array.isArray(currentExport?.declaredInformationLosses) &&
              currentExport.declaredInformationLosses.length > 0 && (
                <div className="bg-amber-950/25 border border-amber-500/40 rounded-sm p-2.5 text-[11px] text-amber-200 space-y-1">
                  <div className="font-semibold">Declared Format Information Losses:</div>
                  {currentExport.declaredInformationLosses.map((loss: string, i: number) => (
                    <div key={i}>• {loss}</div>
                  ))}
                </div>
              )}

            <pre className="bg-[#06090F] border border-[#1E2738] rounded-sm p-3 text-[11px] font-mono text-slate-200 overflow-x-auto max-h-60 whitespace-pre-wrap">
              {exportPreviewText}
            </pre>
          </div>
        </section>
      )}

      {/* QA Findings */}
      {qaReport && Array.isArray(qaReport.issues) && (
        <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 text-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-100">
              Automated 4-Category Subtitle QA Findings ({qaReport.issues.length})
            </span>
            <SubtitleBadge value={qaReport.passedWithoutErrors ? 'PASSED' : 'ERRORS_FOUND'} />
          </div>
          {qaReport.issues.length === 0 ? (
            <div className="text-emerald-300">
              No structural, timing, readability, or Persian linguistic issues detected.
            </div>
          ) : (
            <div className="space-y-1.5">
              {qaReport.issues.map((issue: any) => (
                <div
                  key={issue.issueId}
                  className="flex flex-wrap items-center justify-between gap-2 bg-[#0B0F17] border border-[#1E2738] px-3 py-2 rounded-sm"
                >
                  <div className="flex items-center gap-2">
                    <SubtitleBadge value={issue.severity} />
                    <span className="font-mono text-slate-300">{issue.category}</span>
                    <span className="text-slate-100">{issue.message}</span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-500">{issue.code}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
