import React, { useState } from 'react';
import { Activity, Play, ShieldCheck } from 'lucide-react';

interface AcousticIntelligencePanelProps {
  audioIntelligenceState: Record<string, any> | null;
}

function Badge({ value }: { value: string }) {
  const upper = String(value || 'UNKNOWN').toUpperCase();
  let cls = 'border-slate-600/80 bg-slate-800/70 text-slate-200';
  if (upper.includes('UNSUPPORTED') || upper.includes('FAIL') || upper.includes('CLIPPING') || upper.includes('DROPOUT')) {
    cls = 'border-rose-500/60 bg-rose-950/60 text-rose-200';
  } else if (upper.includes('PARTIAL') || upper.includes('HEURISTIC') || upper.includes('OVERLAP') || upper.includes('LOW_ENERGY')) {
    cls = 'border-amber-500/60 bg-amber-950/50 text-amber-200';
  } else if (upper.includes('VERIFIED') || upper.includes('CONSISTENT') || upper.includes('DIRECT_SIGNAL')) {
    cls = 'border-emerald-500/50 bg-emerald-950/40 text-emerald-200';
  }
  return (
    <span className={`inline-block px-2 py-0.5 text-[11px] font-mono font-semibold border rounded-sm ${cls}`}>
      {upper}
    </span>
  );
}

export const AcousticIntelligencePanel: React.FC<AcousticIntelligencePanelProps> = ({
  audioIntelligenceState,
}) => {
  const [liveResult, setLiveResult] = useState<Record<string, any> | null>(null);
  const [liveEval, setLiveEval] = useState<Record<string, any> | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analysis = liveResult ?? audioIntelligenceState?.sampleAnalysis ?? null;
  const evaluation = liveEval ?? audioIntelligenceState?.referenceEvaluation ?? null;
  const capabilities = audioIntelligenceState?.capabilities ?? null;
  const diag = analysis?.qualityDiagnostics ?? null;
  const events: Array<Record<string, any>> = Array.isArray(analysis?.events) ? analysis.events : [];

  const handleRunLiveAnalysis = async () => {
    setRunning(true);
    setError(null);
    try {
      const resp = await fetch('/api/shahab/audio-intel/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeTranscriptCoverage: true, includeOverlapMetadata: true }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.message || `HTTP ${resp.status}`);
      setLiveResult(json.result);
      setLiveEval(json.evaluation);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run acoustic scene analysis.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4 text-xs" data-testid="shahab-audio-intel-panel">
      {/* Stage Separation & Controls */}
      <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Activity className="w-4 h-4 text-sky-400" />
              <h2 className="text-sm font-semibold text-slate-100">
                SHAHAB-028 — Acoustic Scene Intelligence &amp; Temporal Audio Structure
              </h2>
              <Badge value={audioIntelligenceState?.finalStatus ?? 'PARTIALLY_VERIFIED'} />
            </div>
            <p className="text-slate-400 mt-1">
              Stage 1 of 3 (<span className="font-mono text-sky-300">DETECT ONLY</span>): Multi-label acoustic events,
              low-energy speech/breath protection, clipping/dropout/imbalance diagnostics &amp; speech-vs-transcript coverage.
              Never deletes audio or infers emotion/psychology/identity.
            </p>
          </div>
          <button
            type="button"
            data-testid="btn-run-audio-intel"
            onClick={() => void handleRunLiveAnalysis()}
            disabled={running}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/60 text-sky-200 font-medium rounded-sm cursor-pointer disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{running ? 'Analyzing Audio Scene…' : 'Run Live Acoustic Analysis'}</span>
          </button>
        </div>

        {error && (
          <div className="p-2.5 bg-rose-950/50 border border-rose-500/50 text-rose-200 rounded-sm">
            {error}
          </div>
        )}

        {/* Red-line invariants */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-2 border-t border-[#1E2738]">
          {[
            ['Streaming Mode', analysis?.streamingMode ?? 'INCREMENTAL_WINDOW_ANALYSIS'],
            ['Neural SED Model', 'UNSUPPORTED (DSP Heuristics Disclosed)'],
            ['Overall Quality Score', 'FORBIDDEN (Metrics Separated)'],
            ['Ref Event Eval (F1)', evaluation ? `F1=${evaluation.f1} (P=${evaluation.precision} / R=${evaluation.recall})` : 'NOT_MEASURED'],
          ].map(([label, val]) => (
            <div key={String(label)} className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
              <div className="text-[10px] uppercase text-slate-400">{label}</div>
              <div className="font-mono text-slate-100 mt-1 break-words">{String(val)}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Technical Audio Quality Diagnostics */}
      {diag && (
        <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              Technical Signal Diagnostics (Window={diag.analysisWindowMs}ms / Hop={diag.analysisHopMs}ms)
            </h3>
            <span className="text-[11px] font-mono text-amber-300">universalQualityScoreFabricated=false</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
            {[
              ['Overall RMS', `${diag.overallRmsDbfs} dBFS`],
              ['Peak Level', `${diag.peakDbfs} dBFS`],
              ['Noise Floor (P15)', `${diag.estimatedNoiseFloorDbfs} dBFS`],
              ['SNR Proxy', diag.snrProxyDb != null ? `${diag.snrProxyDb} dB` : 'N/A'],
              ['Flat-Top Clipping', `${diag.flatTopEventCount} runs (${diag.clippedSampleCount} smp)`],
              ['Signal Dropouts', `${diag.signalDropoutCount} zero-runs`],
              ['Discontinuities', `${diag.discontinuityCount} jumps`],
              ['Channel Imbalance', diag.channelImbalanceDb != null ? `${diag.channelImbalanceDb} dB` : 'Mono'],
              ['Speech Activity', `${(Number(diag.speechActivityRatio ?? 0) * 100).toFixed(1)}%`],
              ['Quiet Speech Protected', `${diag.lowEnergySpeechProtectedCount} intervals`],
              ['Overlapping Event Pairs', `${analysis?.overlappingEventPairsCount ?? 0}`],
              ['Coverage Status', analysis?.coverageCrossCheck?.status ?? 'NOT_SUPPLIED'],
            ].map(([k, v]) => (
              <div key={String(k)} className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                <div className="text-[10px] uppercase text-slate-400">{k}</div>
                <div className="font-mono text-slate-100 mt-1 break-words">{String(v)}</div>
              </div>
            ))}
          </div>
          {Array.isArray(diag.diagnosticFlags) && (
            <div className="flex flex-wrap gap-1.5">
              {diag.diagnosticFlags.map((flag: string, idx: number) => (
                <Badge key={idx} value={flag} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Multi-Label Simultaneous Acoustic Timeline */}
      <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Multi-Label Simultaneous Acoustic Event Timeline ({events.length} events)
            </h3>
            <p className="text-slate-400 text-[11px]">
              Half-open integer sample coordinates <code className="font-mono">[startSample, endSample)</code> — calibrated probabilities explicitly unavailable.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#232D42] text-slate-400 text-[11px]">
                <th className="py-2 pr-3">Event Type</th>
                <th className="py-2 pr-3">Range (sec)</th>
                <th className="py-2 pr-3">Samples [s, e)</th>
                <th className="py-2 pr-3">RMS dBFS</th>
                <th className="py-2 pr-3">Evidence Class</th>
                <th className="py-2">Protection / Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1A2233]">
              {events.map((ev) => (
                <tr key={ev.eventId}>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <Badge value={ev.eventType} />
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-200 whitespace-nowrap">
                    {Number(ev.range?.startSec ?? 0).toFixed(2)}s – {Number(ev.range?.endSec ?? 0).toFixed(2)}s
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-400 whitespace-nowrap">
                    [{ev.range?.startSample}, {ev.range?.endSample})
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-200 whitespace-nowrap">
                    {ev.measuredMetrics?.rmsDbfs ?? '—'}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <Badge value={ev.evidenceClass} />
                  </td>
                  <td className="py-2 text-slate-300">
                    {ev.breathOrQuietSpeechProtected && (
                      <span className="inline-flex items-center gap-1 text-emerald-300 font-mono mr-2">
                        <ShieldCheck className="w-3 h-3" /> PROTECTED
                      </span>
                    )}
                    {ev.ambiguityReason || 'Direct deterministic observation'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Capability Inventory */}
      {Array.isArray(capabilities?.workspaceInventory) && (
        <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-2">
          <h3 className="text-sm font-semibold text-slate-100">Workspace Capability Inventory (Entry Gate)</h3>
          <div className="space-y-1.5">
            {capabilities.workspaceInventory.map((item: any) => (
              <div
                key={item.capabilityId}
                className="flex flex-wrap items-center justify-between gap-2 bg-[#0B0F17] border border-[#1E2738] px-3 py-2 rounded-sm"
              >
                <div>
                  <span className="font-mono font-semibold text-slate-100 mr-2">{item.capabilityId}</span>
                  <span className="text-slate-200">{item.name}</span>
                  <div className="text-[11px] text-slate-400 mt-0.5">{item.evidenceNote}</div>
                </div>
                <Badge value={item.status} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
