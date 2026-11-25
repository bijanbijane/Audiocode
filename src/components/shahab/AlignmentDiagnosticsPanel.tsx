import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Layers,
  Play,
  ShieldAlert,
} from 'lucide-react';

interface AlignmentDiagnosticsPanelProps {
  alignmentState: Record<string, any> | null;
}

type AlignmentScenario =
  | 'PODCAST_SEGMENT_HONEST'
  | 'SYNTHETIC_CTC_WORD'
  | 'SILENT_MISMATCH_PROBE';

const TRANSCRIPT_LAYERS = [
  'USER_EDITED',
  'VERBATIM',
  'NORMALIZED',
  'RAW_ACOUSTIC',
  'CONTEXT_ASSISTED',
  'AUTHORIZED_FINAL',
] as const;

function AlignmentBadge({ value }: { value: string }) {
  const upper = String(value || 'UNKNOWN').toUpperCase();
  let cls = 'border-slate-600/80 bg-slate-800/70 text-slate-200';
  if (
    upper.includes('FAIL') ||
    upper.includes('UNALIGNED') ||
    upper.includes('MISMATCH') ||
    upper.includes('REJECTED') ||
    upper.includes('UNAVAILABLE')
  ) {
    cls = 'border-rose-500/60 bg-rose-950/60 text-rose-200';
  } else if (
    upper.includes('PARTIAL') ||
    upper.includes('SEGMENT') ||
    upper.includes('SEPARATE') ||
    upper.includes('REQUIRED') ||
    upper.includes('UNCALIBRATED')
  ) {
    cls = 'border-amber-500/60 bg-amber-950/50 text-amber-200';
  } else if (
    upper === 'ALIGNED' ||
    upper === 'WORD_LEVEL' ||
    upper === 'VERIFIED' ||
    upper === 'PASSED'
  ) {
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

export const AlignmentDiagnosticsPanel: React.FC<AlignmentDiagnosticsPanelProps> = ({
  alignmentState,
}) => {
  const [scenario, setScenario] = useState<AlignmentScenario>('PODCAST_SEGMENT_HONEST');
  const [transcriptLayer, setTranscriptLayer] = useState<string>('USER_EDITED');
  const [transcriptText, setTranscriptText] = useState<string>(
    'سلام و وقت بخیر، امروز در استودیو آواپرداز می‌خواهیم موتور SHAHAB نسخه ۲.۰ را بررسی کنیم. بله، دقیقاً هم‌زمان درباره کیفیت زیرنویس فارسی صحبت می‌کنیم.',
  );
  const [running, setRunning] = useState<boolean>(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<Record<string, any> | null>(null);
  const [liveCacheSize, setLiveCacheSize] = useState<number | null>(null);

  const caps = alignmentState?.capabilities ?? null;
  const sampleRuns = alignmentState?.sampleRuns ?? null;

  const handleRunAlignment = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch('/api/shahab/alignment/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario,
          transcriptLayer,
          transcriptText,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setRunError(json?.message || 'Alignment execution failed.');
        return;
      }
      setLiveResult(json.result ?? null);
      setLiveCacheSize(typeof json.cacheSize === 'number' ? json.cacheSize : null);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="alignment-diagnostics-panel">
      {/* Header / Capability Reality Banner */}
      <section className="bg-[#0F1522] border border-[#232D42] rounded-md overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#1E2738] bg-[#121A2B]">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-300" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 tracking-tight">
                SHAHAB-025 — Acoustic Forced Alignment &amp; Word-Level Timing Diagnostics
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Strict granularity honesty · Integer half-open sample intervals [startSample, endSample) · Zero fabricated proportional word splits
              </p>
            </div>
          </div>
          <AlignmentBadge value={alignmentState?.finalStatus ?? 'PARTIALLY_VERIFIED'} />
        </div>

        <div className="p-4 space-y-4">
          {/* KPI Strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Capability Status
              </div>
              <div className="text-xs font-mono font-semibold text-amber-300 mt-1 break-words">
                {caps?.capabilityStatus ?? 'SEPARATE_ALIGNER_REQUIRED'}
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Active ASR Core
              </div>
              <div className="text-xs font-mono text-slate-100 mt-1 truncate" title={caps?.activeAsrArchitecture}>
                {caps?.activeAsrArchitecture ?? 'RNN-T (40ms stride)'}
              </div>
              <div className="text-[11px] font-mono text-slate-400 mt-0.5 tabular-nums">
                Frame: {caps?.activeAsrFrameStrideMs ?? 40} ms · ONNX on disk:{' '}
                {String(Boolean(caps?.activeModelOnnxWeightsPresentOnDisk))}
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Gold Persian Corpus MAE
              </div>
              <div className="text-xs font-mono font-semibold text-rose-300 mt-1">
                NOT_MEASURED
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                No gold Persian corpus on disk
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Proportional Word Fabrication
              </div>
              <div className="text-xs font-mono font-semibold text-emerald-300 mt-1">
                PERMANENTLY_BLOCKED
              </div>
              <div className="text-[11px] font-mono text-slate-400 mt-0.5 tabular-nums">
                Cache invalidations: {alignmentState?.cacheInvalidationEventsCount ?? 0}
              </div>
            </div>
          </div>

          {/* Persisted Baseline Verification Summary */}
          {sampleRuns && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
              <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-100">
                    1. Honest Acoustic VAD Segment Fallback (Real PCM)
                  </span>
                  <AlignmentBadge
                    value={sampleRuns.honestSegmentAnchoredRun?.effectiveGranularity ?? 'SEGMENT_LEVEL'}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2 font-mono tabular-nums text-[11px]">
                  <div>
                    <div className="text-slate-400">Segments</div>
                    <div className="text-slate-100">
                      {sampleRuns.honestSegmentAnchoredRun?.alignedSegments ?? 0}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Word Timestamps</div>
                    <div className="text-amber-300">
                      {sampleRuns.honestSegmentAnchoredRun?.alignedWords ?? 0} aligned /{' '}
                      {sampleRuns.honestSegmentAnchoredRun?.unalignedWords ?? 0} unaligned
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Repeat Cache Hit</div>
                    <div className="text-emerald-300">
                      {String(Boolean(sampleRuns.honestSegmentAnchoredRun?.cacheHitOnRepeat))}
                    </div>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">
                  Refuses to fabricate uniform word boundaries when only segment-level energy/VAD evidence exists.
                </p>
              </div>

              <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-100">
                    2. Controlled CTC Viterbi Harness (Synthetic Log-Probs)
                  </span>
                  <AlignmentBadge
                    value={sampleRuns.controlledCtcViterbiRun?.effectiveGranularity ?? 'WORD_LEVEL'}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2 font-mono tabular-nums text-[11px]">
                  <div>
                    <div className="text-slate-400">Aligned Words</div>
                    <div className="text-emerald-300">
                      {sampleRuns.controlledCtcViterbiRun?.alignedWords ?? 0}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Boundary MAE</div>
                    <div className="text-slate-100">
                      {sampleRuns.controlledCtcViterbiRun?.evaluationMetrics?.boundaryMaeMs != null
                        ? `${Number(sampleRuns.controlledCtcViterbiRun.evaluationMetrics.boundaryMaeMs).toFixed(2)} ms`
                        : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Invariants</div>
                    <div className="text-emerald-300">
                      {sampleRuns.controlledCtcViterbiRun?.invariantsPassed ? 'PASSED' : 'FAILED'}
                    </div>
                  </div>
                </div>
                <p className="text-[11px] text-amber-200/80">
                  Synthetic CTC posteriors verify algorithm invariants only — NOT real-world Persian neural accuracy.
                </p>
              </div>
            </div>
          )}

          {/* Method Evaluation Matrix */}
          {Array.isArray(caps?.methodEvaluationMatrix) && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#232D42] text-[10px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-3">Method</th>
                    <th className="py-2 pr-3">Granularity</th>
                    <th className="py-2 pr-3">Disk Asset</th>
                    <th className="py-2">Selection Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1A2233]">
                  {caps.methodEvaluationMatrix.map((m: any) => (
                    <tr key={m.methodId}>
                      <td className="py-2 pr-3 font-mono text-slate-100">{m.name ?? m.label}</td>
                      <td className="py-2 pr-3 font-mono text-slate-300">{m.supportedGranularity ?? m.honestGranularity}</td>
                      <td className="py-2 pr-3 font-mono">
                        <span className={m.diskAssetAvailable ? 'text-emerald-300' : 'text-rose-300'}>
                          {m.diskAssetAvailable ? 'AVAILABLE' : 'ABSENT'}
                        </span>
                      </td>
                      <td className="py-2">
                        <AlignmentBadge value={m.selectionStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Interactive Alignment Runner */}
      <section className="bg-[#0F1522] border border-[#232D42] rounded-md overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#1E2738] bg-[#121A2B]">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-sky-300" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 tracking-tight">
                Interactive Persian Forced Alignment Probe
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Execute live alignment against backend engine (`POST /api/shahab/alignment/run`) — inspect segments, words, ZWNJ prep, and mismatch warnings
              </p>
            </div>
          </div>
          {liveCacheSize !== null && (
            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
              Cache Entries: {liveCacheSize}
            </span>
          )}
        </div>

        <div className="p-4 space-y-3 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="block space-y-1">
              <span className="text-[11px] text-slate-400 uppercase tracking-wider">Scenario</span>
              <select
                data-testid="alignment-scenario-select"
                value={scenario}
                onChange={(e) => setScenario(e.target.value as AlignmentScenario)}
                className="w-full bg-[#0B0F17] border border-[#2C3B57] text-slate-100 rounded-sm px-2.5 py-2 text-xs font-mono"
              >
                <option value="PODCAST_SEGMENT_HONEST">PODCAST_SEGMENT_HONEST (VAD Segment Only)</option>
                <option value="SYNTHETIC_CTC_WORD">SYNTHETIC_CTC_WORD (CTC Viterbi Word-Level)</option>
                <option value="SILENT_MISMATCH_PROBE">SILENT_MISMATCH_PROBE (Mismatch Detector)</option>
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] text-slate-400 uppercase tracking-wider">Transcript Layer</span>
              <select
                data-testid="alignment-layer-select"
                value={transcriptLayer}
                onChange={(e) => setTranscriptLayer(e.target.value)}
                className="w-full bg-[#0B0F17] border border-[#2C3B57] text-slate-100 rounded-sm px-2.5 py-2 text-xs font-mono"
              >
                {TRANSCRIPT_LAYERS.map((layer) => (
                  <option key={layer} value={layer}>
                    {layer}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end">
              <button
                type="button"
                data-testid="alignment-run-btn"
                disabled={running}
                onClick={() => void handleRunAlignment()}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/60 text-amber-200 rounded-sm cursor-pointer disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{running ? 'Running Alignment…' : 'Run Alignment'}</span>
              </button>
            </div>
          </div>

          {scenario !== 'SYNTHETIC_CTC_WORD' && (
            <label className="block space-y-1">
              <span className="text-[11px] text-slate-400 uppercase tracking-wider">
                Persian Transcript Input (Preserved Verbatim — Never Mutated by Aligner)
              </span>
              <textarea
                dir="rtl"
                rows={2}
                data-testid="alignment-transcript-input"
                value={transcriptText}
                onChange={(e) => setTranscriptText(e.target.value)}
                className="w-full bg-[#0B0F17] border border-[#2C3B57] text-slate-100 rounded-sm px-3 py-2 text-sm leading-relaxed"
              />
            </label>
          )}

          {runError && (
            <div className="flex items-center gap-2 px-3 py-2 bg-rose-950/60 border border-rose-500/50 text-rose-200 rounded-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{runError}</span>
            </div>
          )}

          {liveResult && (
            <div className="space-y-3 pt-2 border-t border-[#1E2738]" data-testid="alignment-live-result">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <AlignmentBadge value={liveResult.overallStatus} />
                  <AlignmentBadge value={liveResult.effectiveGranularity} />
                  <span className="font-mono text-[11px] text-slate-300">
                    Backend: {liveResult.backendMode}
                  </span>
                </div>
                <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                  Latency: {Number(liveResult.latencyMs ?? 0).toFixed(2)} ms · Invariants:{' '}
                  {liveResult.invariantCheck?.passed ? 'PASSED' : 'FAILED'}
                </span>
              </div>

              {/* Coverage vs Accuracy Explicit Honesty Notice */}
              <div className="bg-amber-950/30 border border-amber-500/40 rounded-sm px-3 py-2 text-[11px] text-amber-200 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Coverage ≠ Accuracy: </span>
                  {liveResult.coverage?.coverageIsNotAccuracyNotice} (Word coverage:{' '}
                  <span className="font-mono tabular-nums">
                    {liveResult.coverage?.alignedWordCount ?? 0}/{liveResult.coverage?.alignableWordCount ?? 0}
                  </span>
                  , Segment coverage:{' '}
                  <span className="font-mono tabular-nums">
                    {liveResult.coverage?.alignedSegmentCount ?? 0}/{liveResult.coverage?.totalSegmentCount ?? 0}
                  </span>
                  )
                </div>
              </div>

              {liveResult.mismatchSuspected && (
                <div
                  className="bg-rose-950/40 border border-rose-500/50 rounded-sm px-3 py-2 text-[11px] text-rose-200 space-y-1"
                  data-testid="alignment-mismatch-warning"
                >
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Audio-Transcript Mismatch Suspected</span>
                  </div>
                  {(liveResult.mismatchReasons ?? []).map((r: string, i: number) => (
                    <div key={i}>• {r}</div>
                  ))}
                </div>
              )}

              {/* Resampling & Sample-Accurate Lineage */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 font-mono tabular-nums text-[11px]">
                <div className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                  <div className="text-slate-400">Source / Processing SR</div>
                  <div className="text-slate-100 mt-0.5">
                    {liveResult.resamplingLineage?.originalSampleRateHz} Hz →{' '}
                    {liveResult.resamplingLineage?.processingSampleRateHz} Hz
                  </div>
                </div>
                <div className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                  <div className="text-slate-400">Source Offset Sample</div>
                  <div className="text-slate-100 mt-0.5">
                    {liveResult.resamplingLineage?.sourceOffsetSample ?? 0} samples
                  </div>
                </div>
                <div className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                  <div className="text-slate-400">Persian Text Prep</div>
                  <div className="text-slate-100 mt-0.5">
                    ZWNJ compounds: {liveResult.preparedText?.zwnjCompoundCount ?? 0} · Reversible:{' '}
                    {String(Boolean(liveResult.preparedText?.reversibleVerified))}
                  </div>
                </div>
              </div>

              {/* Segments Table */}
              {Array.isArray(liveResult.segments) && liveResult.segments.length > 0 && (
                <div className="overflow-x-auto">
                  <div className="text-[11px] font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-sky-300" />
                    <span>Aligned Segments ({liveResult.segments.length})</span>
                  </div>
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-[#232D42] text-[10px] uppercase tracking-wider text-slate-400">
                        <th className="py-1.5 pr-2">Segment</th>
                        <th className="py-1.5 pr-2">Status</th>
                        <th className="py-1.5 pr-2">Acoustic Samples [start, end)</th>
                        <th className="py-1.5 pr-2">Time (s)</th>
                        <th className="py-1.5">Persian Surface Text</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1A2233]">
                      {liveResult.segments.map((seg: any) => (
                        <tr key={seg.segmentId}>
                          <td className="py-1.5 pr-2 font-mono text-slate-300">{seg.segmentId}</td>
                          <td className="py-1.5 pr-2">
                            <AlignmentBadge value={seg.status} />
                          </td>
                          <td className="py-1.5 pr-2 font-mono tabular-nums text-slate-300">
                            {seg.acousticRange
                              ? `[${seg.acousticRange.startSample}, ${seg.acousticRange.endSample})`
                              : 'NULL'}
                          </td>
                          <td className="py-1.5 pr-2 font-mono tabular-nums text-slate-200">
                            {seg.acousticRange
                              ? `${Number(seg.acousticRange.startSec).toFixed(3)}–${Number(seg.acousticRange.endSec).toFixed(3)}`
                              : '—'}
                          </td>
                          <td dir="rtl" className="py-1.5 text-slate-100 text-right">
                            {seg.text}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Word-level detail (only populated when genuinely word-aligned, e.g. CTC) */}
              {Array.isArray(liveResult.words) && liveResult.words.length > 0 && (
                <div className="overflow-x-auto">
                  <div className="text-[11px] font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" />
                    <span>
                      Word Records ({liveResult.words.length}) — Showing Honest Granularity &amp; Raw Uncalibrated Scores
                    </span>
                  </div>
                  <div className="max-h-56 overflow-y-auto border border-[#1E2738] rounded-sm">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="sticky top-0 bg-[#121A2B]">
                        <tr className="border-b border-[#232D42] text-[10px] uppercase tracking-wider text-slate-400">
                          <th className="py-1.5 px-2">Surface (FA)</th>
                          <th className="py-1.5 px-2">Kind</th>
                          <th className="py-1.5 px-2">Status</th>
                          <th className="py-1.5 px-2">Acoustic Time (s)</th>
                          <th className="py-1.5 px-2">Raw Score (Uncalibrated)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1A2233]">
                        {liveResult.words.slice(0, 24).map((w: any) => (
                          <tr key={w.wordId}>
                            <td dir="rtl" className="py-1.5 px-2 text-slate-100 font-medium">
                              {w.originalSurface}
                            </td>
                            <td className="py-1.5 px-2 font-mono text-[10px] text-slate-400">
                              {w.tokenKind}
                            </td>
                            <td className="py-1.5 px-2">
                              <AlignmentBadge value={w.status} />
                            </td>
                            <td className="py-1.5 px-2 font-mono tabular-nums text-slate-200">
                              {w.acousticRange
                                ? `${Number(w.acousticRange.startSec).toFixed(3)}–${Number(w.acousticRange.endSec).toFixed(3)}`
                                : 'NOT_AVAILABLE'}
                            </td>
                            <td className="py-1.5 px-2 font-mono tabular-nums text-slate-400">
                              {w.rawAcousticScore != null
                                ? `${Number(w.rawAcousticScore).toFixed(3)} (raw)`
                                : 'N/A'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Known Limitations */}
      {Array.isArray(alignmentState?.knownLimitations) && alignmentState.knownLimitations.length > 0 && (
        <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 text-xs space-y-1.5">
          <div className="font-semibold text-amber-200">
            Explicit Engineering Limitations (SHAHAB-025)
          </div>
          {alignmentState.knownLimitations.map((lim: string, idx: number) => (
            <div key={idx} className="text-slate-300">
              • {lim}
            </div>
          ))}
        </section>
      )}
    </div>
  );
};
