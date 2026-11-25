import React, { useState } from 'react';
import { Check, FileEdit, Lock, Play, X } from 'lucide-react';

interface EditorialPlannerPanelProps {
  editDecisionState: Record<string, any> | null;
}

const PROFILE_OPTIONS = [
  'VERBATIM_PRESERVATION',
  'LIGHT_CLEANUP',
  'CONVERSATIONAL_CLEANUP',
  'PODCAST_EDITING',
  'INTERVIEW_EDITING',
  'LECTURE_EDITING',
  'PRESENTATION_EDITING',
  'ARCHIVAL_PRESERVATION',
  'CUSTOM_USER_POLICY',
] as const;

function Tag({ value }: { value: string }) {
  const upper = String(value || 'UNKNOWN').toUpperCase();
  let cls = 'border-slate-600/80 bg-slate-800/70 text-slate-200';
  if (upper.includes('REJECTED') || upper.includes('HIGH_RISK') || upper.includes('CRITICAL') || upper.includes('NEVER_AUTO') || upper.includes('STALE')) {
    cls = 'border-rose-500/60 bg-rose-950/60 text-rose-200';
  } else if (upper.includes('PENDING') || upper.includes('MEDIUM') || upper.includes('HUMAN_REVIEW') || upper.includes('PARTIAL')) {
    cls = 'border-amber-500/60 bg-amber-950/50 text-amber-200';
  } else if (upper.includes('APPROVED') || upper.includes('LOW_RISK') || upper.includes('PROTECTED') || upper.includes('VALID') || upper.includes('CONSISTENT')) {
    cls = 'border-emerald-500/50 bg-emerald-950/40 text-emerald-200';
  }
  return (
    <span className={`inline-block px-2 py-0.5 text-[11px] font-mono font-semibold border rounded-sm ${cls}`}>
      {upper}
    </span>
  );
}

export const EditorialPlannerPanel: React.FC<EditorialPlannerPanelProps> = ({
  editDecisionState,
}) => {
  const [selectedProfile, setSelectedProfile] = useState<string>('PODCAST_EDITING');
  const [livePlan, setLivePlan] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const plan = livePlan ?? editDecisionState?.samplePlan ?? null;
  const operations: Array<Record<string, any>> = Array.isArray(plan?.operations) ? plan.operations : [];
  const protectedRanges: Array<Record<string, any>> = Array.isArray(plan?.protectedRanges) ? plan.protectedRanges : [];

  const handleGeneratePlan = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const resp = await fetch('/api/shahab/editorial/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: selectedProfile }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.message || `HTTP ${resp.status}`);
      setLivePlan(json.plan);
      setNotice(`Generated immutable EDP ${json.plan.planId} (rev ${json.plan.planRevision}) under ${selectedProfile}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate Edit Decision Plan.');
    } finally {
      setBusy(false);
    }
  };

  const handleDecision = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const resp = await fetch('/api/shahab/editorial/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan?.planId, ...payload }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.message || `HTTP ${resp.status}`);
      setLivePlan(json.plan);
      setNotice(`Committed new EDP revision ${json.plan.planRevision} (${json.plan.planId}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply editorial decision.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-xs" data-testid="shahab-editorial-planner-panel">
      {/* Header & Profile Controls */}
      <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <FileEdit className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-slate-100">
                SHAHAB-029 — Transcript-Aware Editorial Intelligence &amp; Edit Decision Planner
              </h2>
              <Tag value={editDecisionState?.finalStatus ?? 'PARTIALLY_VERIFIED'} />
            </div>
            <p className="text-slate-400 mt-1">
              Stage 2 of 3 (<span className="font-mono text-amber-300">DECIDE / PLAN ONLY</span>): Produces immutable
              versioned Edit Decision Plans (EDP) in original source coordinates. Never mutates source audio or raw ASR transcripts.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#1E2738]">
          <label className="text-slate-300 font-medium" htmlFor="edp-profile-select">
            Editorial Profile (9 Versioned):
          </label>
          <select
            id="edp-profile-select"
            data-testid="select-editorial-profile"
            value={selectedProfile}
            onChange={(e) => setSelectedProfile(e.target.value)}
            className="bg-[#0B0F17] border border-[#2C3B57] text-slate-100 px-2.5 py-1.5 rounded-sm font-mono text-xs"
          >
            {PROFILE_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="btn-generate-edit-plan"
            onClick={() => void handleGeneratePlan()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/60 text-amber-200 font-medium rounded-sm cursor-pointer disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{busy ? 'Planning…' : 'Generate Edit Decision Plan'}</span>
          </button>
          {livePlan && (
            <button
              type="button"
              data-testid="btn-approve-safe-edits"
              onClick={() => void handleDecision({ action: 'APPROVE_ALL_LOW_MEDIUM' })}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/60 text-emerald-200 font-medium rounded-sm cursor-pointer disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Approve Low/Medium Candidates</span>
            </button>
          )}
        </div>

        {error && (
          <div className="p-2.5 bg-rose-950/50 border border-rose-500/50 text-rose-200 rounded-sm">{error}</div>
        )}
        {notice && (
          <div className="p-2.5 bg-sky-950/50 border border-sky-500/50 text-sky-200 rounded-sm">{notice}</div>
        )}

        {/* Plan Summary KPIs */}
        {plan && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {[
              ['EDP ID / Rev', `${plan.planId} · r${plan.planRevision}`],
              ['Profile', plan.profile?.profileId ?? '—'],
              ['Validity', plan.validityState],
              ['Approved Cuts', `${plan.summary?.approvedCutCount ?? 0} / ${plan.summary?.totalCandidates ?? 0}`],
              ['Protected Ranges', `${plan.summary?.protectedRangeCount ?? 0}`],
              ['Conflicts', `${Array.isArray(plan.conflicts) ? plan.conflicts.length : 0}`],
            ].map(([k, v]) => (
              <div key={String(k)} className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                <div className="text-[10px] uppercase text-slate-400">{k}</div>
                <div className="font-mono text-slate-100 mt-1 break-words">{String(v)}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Edit Candidates Table */}
      {plan && (
        <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Edit Decision Operations ({operations.length}) — Zero Fake Confidence %
              </h3>
              <p className="text-[11px] text-slate-400">
                Consistency: <span className="font-mono text-slate-200">{plan.consistencyReport?.status}</span> ·
                Persian emphasis reduplications (e.g. «خیلی خیلی») automatically shielded from stutter removal.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#232D42] text-slate-400 text-[11px]">
                  <th className="py-2 pr-3">Operation</th>
                  <th className="py-2 pr-3">Source Range</th>
                  <th className="py-2 pr-3">Text / Context</th>
                  <th className="py-2 pr-3">Risk &amp; Automation</th>
                  <th className="py-2 pr-3">State</th>
                  <th className="py-2">Review Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A2233]">
                {operations.map((op) => (
                  <tr key={op.operationId}>
                    <td className="py-2 pr-3 font-mono text-slate-100 whitespace-nowrap">
                      <div>{op.operationId}</div>
                      <div className="text-[10px] text-slate-400">{op.operationType}</div>
                    </td>
                    <td className="py-2 pr-3 font-mono text-slate-300 whitespace-nowrap">
                      {Number(op.sourceRange?.startSec ?? 0).toFixed(2)}s – {Number(op.sourceRange?.endSec ?? 0).toFixed(2)}s
                      <div className="text-[10px] text-slate-500">{op.sourceRange?.durationMs}ms</div>
                    </td>
                    <td className="py-2 pr-3 text-slate-200 max-w-xs">
                      {op.affectedText && (
                        <div className="font-semibold text-amber-200" dir="rtl">
                          «{op.affectedText}»
                        </div>
                      )}
                      <div className="text-[11px] text-slate-400">{op.rationale}</div>
                    </td>
                    <td className="py-2 pr-3 space-y-1">
                      <div><Tag value={op.riskLevel} /></div>
                      <div><Tag value={op.automationEligibility} /></div>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <Tag value={op.approvalState} />
                    </td>
                    <td className="py-2 whitespace-nowrap">
                      {livePlan ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busy || op.approvalState === 'USER_APPROVED' || op.approvalState === 'USER_PROTECTED_PRESERVE'}
                            onClick={() => void handleDecision({ action: 'APPROVE', operationId: op.operationId })}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-500/50 text-emerald-200 rounded-sm cursor-pointer disabled:opacity-40"
                          >
                            <Check className="w-3 h-3" /> Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy || op.approvalState === 'USER_REJECTED'}
                            onClick={() => void handleDecision({ action: 'REJECT', operationId: op.operationId })}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-rose-950/60 hover:bg-rose-900/60 border border-rose-500/50 text-rose-200 rounded-sm cursor-pointer disabled:opacity-40"
                          >
                            <X className="w-3 h-3" /> Reject
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void handleDecision({
                                action: 'PROTECT_RANGE',
                                startSample: op.sourceRange.startSample,
                                endSample: op.sourceRange.endSample,
                                reason: `User protected range of ${op.operationId}`,
                              })
                            }
                            className="inline-flex items-center gap-1 px-2 py-1 bg-sky-950/60 hover:bg-sky-900/60 border border-sky-500/50 text-sky-200 rounded-sm cursor-pointer disabled:opacity-40"
                          >
                            <Lock className="w-3 h-3" /> Protect
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-500">Click Generate Plan to review live</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {protectedRanges.length > 0 && (
            <div className="pt-2 border-t border-[#1E2738] space-y-1">
              <div className="text-[11px] font-semibold text-emerald-300">
                Protected Source Ranges ({protectedRanges.length})
              </div>
              {protectedRanges.map((pr) => (
                <div key={pr.protectionId} className="font-mono text-[11px] text-slate-300">
                  {pr.protectionId}: [{pr.startSample}, {pr.endSample}) — {pr.reason}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
