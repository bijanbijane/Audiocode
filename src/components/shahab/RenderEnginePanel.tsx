import React, { useState } from 'react';
import { Cpu, Download, Play, ShieldCheck, XCircle } from 'lucide-react';

interface RenderEnginePanelProps {
  renderState: Record<string, any> | null;
}

function StatusBadge({ value }: { value: string }) {
  const upper = String(value || 'UNKNOWN').toUpperCase();
  let cls = 'border-slate-600/80 bg-slate-800/70 text-slate-200';
  if (upper.includes('FAIL') || upper.includes('UNSUPPORTED') || upper.includes('REJECTED')) {
    cls = 'border-rose-500/60 bg-rose-950/60 text-rose-200';
  } else if (upper.includes('WARNING') || upper.includes('PARTIAL')) {
    cls = 'border-amber-500/60 bg-amber-950/50 text-amber-200';
  } else if (upper.includes('VALIDATED') || upper.includes('SUPPORTED_VERIFIED') || upper === 'COMPLETED') {
    cls = 'border-emerald-500/50 bg-emerald-950/40 text-emerald-200';
  }
  return (
    <span className={`inline-block px-2 py-0.5 text-[11px] font-mono font-semibold border rounded-sm ${cls}`}>
      {upper}
    </span>
  );
}

export const RenderEnginePanel: React.FC<RenderEnginePanelProps> = ({ renderState }) => {
  const [exportFormat, setExportFormat] = useState<'WAV_PCM_32F' | 'WAV_PCM_16' | 'MP3'>('WAV_PCM_32F');
  const [transitionCurve, setTransitionCurve] = useState<'EQUAL_POWER' | 'LINEAR' | 'NONE'>('EQUAL_POWER');
  const [liveRender, setLiveRender] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRender = liveRender ?? renderState?.finalRenderSummary ?? null;
  const validation = activeRender?.validation ?? null;
  const graphNodes: Array<Record<string, any>> = Array.isArray(activeRender?.renderGraph?.nodes)
    ? activeRender.renderGraph.nodes
    : [];
  const mappings: Array<Record<string, any>> = Array.isArray(activeRender?.sourceOutputMappings)
    ? activeRender.sourceOutputMappings
    : [];
  const removedRanges: Array<Record<string, any>> = Array.isArray(activeRender?.removedRanges)
    ? activeRender.removedRanges
    : [];
  const formats: Array<Record<string, any>> = Array.isArray(renderState?.capabilities?.supportedFormats)
    ? renderState.capabilities.supportedFormats
    : [];

  const runRender = async (mode: 'PREVIEW_RENDER' | 'FINAL_EXPORT_RENDER') => {
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch('/api/shahab/render/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          exportFormat,
          transitionCurve,
          defaultCrossfadeMs: 12,
        }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.message || `HTTP ${resp.status}`);
      setLiveRender(json.render);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Render execution failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-xs" data-testid="shahab-render-engine-panel">
      {/* Header & Render Controls */}
      <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-slate-100">
                SHAHAB-030 — Non-Destructive Audio Render Engine &amp; Precision Export
              </h2>
              <StatusBadge value={renderState?.finalStatus ?? 'PARTIALLY_VERIFIED'} />
            </div>
            <p className="text-slate-400 mt-1">
              Stage 3 of 3 (<span className="font-mono text-emerald-300">EXECUTE ONLY</span>): Sample-accurate
              half-open <code className="font-mono">[startSample, endSample)</code> reconstruction, deterministic Render
              Graph, equal-power/linear transitions, and independent WAV reopen validation. Original source PCM is never mutated.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#1E2738]">
          <select
            data-testid="select-render-format"
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value as 'WAV_PCM_32F' | 'WAV_PCM_16' | 'MP3')}
            className="bg-[#0B0F17] border border-[#2C3B57] text-slate-100 px-2.5 py-1.5 rounded-sm font-mono text-xs"
          >
            <option value="WAV_PCM_32F">WAV_PCM_32F (Lossless Bit-Exact)</option>
            <option value="WAV_PCM_16">WAV_PCM_16 (Lossless 16-bit)</option>
            <option value="MP3">MP3 (Unsupported Guard Probe)</option>
          </select>

          <select
            data-testid="select-transition-curve"
            value={transitionCurve}
            onChange={(e) => setTransitionCurve(e.target.value as 'EQUAL_POWER' | 'LINEAR' | 'NONE')}
            className="bg-[#0B0F17] border border-[#2C3B57] text-slate-100 px-2.5 py-1.5 rounded-sm font-mono text-xs"
          >
            <option value="EQUAL_POWER">EQUAL_POWER (cos/sin 12ms)</option>
            <option value="LINEAR">LINEAR (12ms)</option>
            <option value="NONE">NONE (Direct Sample Splice)</option>
          </select>

          <button
            type="button"
            data-testid="btn-preview-render"
            onClick={() => void runRender('PREVIEW_RENDER')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/60 text-sky-200 font-medium rounded-sm cursor-pointer disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Preview Render</span>
          </button>

          <button
            type="button"
            data-testid="btn-final-render"
            onClick={() => void runRender('FINAL_EXPORT_RENDER')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/60 text-emerald-200 font-medium rounded-sm cursor-pointer disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{busy ? 'Rendering…' : 'Execute Final Verified WAV Render'}</span>
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-2.5 bg-rose-950/60 border border-rose-500/50 text-rose-200 rounded-sm">
            <XCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </section>

      {/* Independent WAV Reopen Validation Report */}
      {activeRender && validation && (
        <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                Independent Output WAV Reopen Validation ({activeRender.renderId})
              </h3>
            </div>
            <StatusBadge value={validation.status} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
            {[
              ['Mode / Format', `${activeRender.renderMode ?? 'FINAL'} · ${activeRender.exportFormat}`],
              ['Channels / SR', `${validation.actualChannels}ch @ ${validation.actualSampleRateHz}Hz`],
              ['Source -> Output Frames', `${activeRender.sourceTotalFrames} -> ${activeRender.outputTotalFrames}`],
              ['Removed Audio', `${activeRender.totalRemovedMs}ms (${activeRender.totalRemovedSamples} smp)`],
              ['Unmodified Bit-Exact', `${String(validation.unmodifiedRegionBitExactVerified)} (err=${validation.unmodifiedRegionExactSampleMaxAbsError})`],
              ['Source Immutable', `${String(validation.sourceHashUnchangedVerified)}`],
              ['Peak / Clipped', `${validation.peakDbfs} dBFS · ${validation.clippedSampleCount} smp`],
              ['Wall Time', `${activeRender.wallTimeMs} ms`],
            ].map(([k, v]) => (
              <div key={String(k)} className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                <div className="text-[10px] uppercase text-slate-400">{k}</div>
                <div className="font-mono text-slate-100 mt-1 break-words">{String(v)}</div>
              </div>
            ))}
          </div>

          {validation.outputFileSha256 && (
            <div className="bg-[#0B0F17] border border-[#1E2738] px-3 py-2 rounded-sm font-mono text-[11px] text-slate-300 break-all">
              Output SHA-256: <span className="text-emerald-300">{validation.outputFileSha256}</span>
              {activeRender.outputFileRelativePath && (
                <span className="ml-3 text-slate-400">Path: {activeRender.outputFileRelativePath}</span>
              )}
            </div>
          )}
        </section>
      )}

      {/* Render Graph & Source-to-Output Mappings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-2">
          <h3 className="text-sm font-semibold text-slate-100">
            Declarative Deterministic Render Graph ({graphNodes.length} Stages)
          </h3>
          <div className="space-y-1.5">
            {graphNodes.map((n, idx) => (
              <div
                key={n.nodeId}
                className="flex items-center justify-between gap-2 bg-[#0B0F17] border border-[#1E2738] px-3 py-1.5 rounded-sm font-mono text-[11px]"
              >
                <span className="text-slate-100">
                  {idx + 1}. {n.nodeType}
                </span>
                <span className="text-slate-400 truncate max-w-xs">{JSON.stringify(n.config)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Source-to-Output Sample Mapping ({mappings.length}) &amp; Removed Ranges ({removedRanges.length})
            </h3>
          </div>
          <div className="space-y-1.5">
            {mappings.map((m) => (
              <div
                key={m.mappingId}
                className="bg-[#0B0F17] border border-[#1E2738] px-3 py-1.5 rounded-sm font-mono text-[11px] text-slate-200"
              >
                {m.mappingId}: src [{m.sourceStartSample}, {m.sourceEndSample}) → out [{m.outputStartSample},{' '}
                {m.outputEndSample})
              </div>
            ))}
          </div>
          {removedRanges.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-[#1E2738]">
              <div className="text-[11px] font-semibold text-amber-300">Auditable Removed Ranges</div>
              {removedRanges.map((r) => (
                <div key={r.operationId} className="font-mono text-[11px] text-slate-300">
                  {r.operationId} ({r.operationType}): [{r.sourceStartSample}, {r.sourceEndSample}) — {r.durationMs}ms
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Format Support Matrix */}
      {formats.length > 0 && (
        <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-2">
          <h3 className="text-sm font-semibold text-slate-100">Export Format Capability Matrix (No Silent Downgrade)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {formats.map((f) => (
              <div key={f.format} className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-slate-100">{f.format}</span>
                  <StatusBadge value={f.status} />
                </div>
                <p className="text-[11px] text-slate-400">{f.note}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
