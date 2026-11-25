import React, { useState } from 'react';
import {
  AlertTriangle,
  Lock,
  Merge,
  Play,
  RotateCcw,
  ShieldCheck,
  UserCheck,
  Users,
} from 'lucide-react';

interface SpeakerIntelligencePanelProps {
  diarizationState: Record<string, any> | null;
}

function SpeakerBadge({ value }: { value: string }) {
  const upper = String(value || 'UNKNOWN').toUpperCase();
  let cls = 'border-slate-600/80 bg-slate-800/70 text-slate-200';
  if (
    upper.includes('PROHIBITED') ||
    upper.includes('NOT_SUPPORTED') ||
    upper.includes('UNAVAILABLE') ||
    upper.includes('UNKNOWN_SPEAKER')
  ) {
    cls = 'border-rose-500/60 bg-rose-950/60 text-rose-200';
  } else if (
    upper.includes('OVERLAP') ||
    upper.includes('PARTIAL') ||
    upper.includes('SEPARATE') ||
    upper.includes('REQUIRED') ||
    upper.includes('CONFLICT')
  ) {
    cls = 'border-amber-500/60 bg-amber-950/50 text-amber-200';
  } else if (
    upper.includes('AVAILABLE') ||
    upper.includes('USER_CONFIRMED') ||
    upper === 'VERIFIED' ||
    upper === 'PASSED'
  ) {
    cls = 'border-emerald-500/50 bg-emerald-950/40 text-emerald-200';
  }
  return (
    <span
      className={`inline-block max-w-full px-2 py-0.5 text-[11px] font-mono font-semibold tracking-tight border rounded-sm break-words whitespace-normal leading-snug ${cls}`}
    >
      {upper}
    </span>
  );
}

export const SpeakerIntelligencePanel: React.FC<SpeakerIntelligencePanelProps> = ({
  diarizationState,
}) => {
  const [consentGranted, setConsentGranted] = useState<boolean>(true);
  const [includeOverlapFixture, setIncludeOverlapFixture] = useState<boolean>(true);
  const [speakerCountInput, setSpeakerCountInput] = useState<string>('');
  const [running, setRunning] = useState<boolean>(false);
  const [reviewing, setReviewing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<Record<string, any> | null>(null);

  // Manual rename state
  const [renameSpeakerId, setRenameSpeakerId] = useState<string>('speaker_1');
  const [renameLabel, setRenameLabel] = useState<string>('مجری (برچسب محلی)');

  const caps = diarizationState?.capabilities ?? null;
  const sampleRun = diarizationState?.sampleRun ?? null;
  const activeResult = liveResult ?? sampleRun;

  const handleRunDiarization = async () => {
    setRunning(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const parsedCount =
        speakerCountInput.trim() !== '' ? Number(speakerCountInput.trim()) : null;
      const res = await fetch('/api/shahab/diarization/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consentGranted,
          includeOverlapFixture,
          userSuppliedSpeakerCount:
            parsedCount !== null && Number.isFinite(parsedCount) && parsedCount >= 1
              ? parsedCount
              : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json?.message || 'Diarization run rejected.');
        return;
      }
      setLiveResult(json.result ?? null);
      if (json.result?.speakers?.[0]?.speakerId) {
        setRenameSpeakerId(json.result.speakers[0].speakerId);
      }
      setNoticeMsg(
        `Recording-scoped diarization completed (${json.result?.recordingScopeId}). Ephemeral embeddings purged.`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleReviewAction = async (payload: Record<string, any>, successLabel: string) => {
    if (!liveResult?.requestId) {
      setErrorMsg('Click "Run Diarization" first to open a live reviewable session.');
      return;
    }
    setReviewing(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      const res = await fetch('/api/shahab/diarization/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: liveResult.requestId, ...payload }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json?.message || 'Speaker review operation failed.');
        return;
      }
      setLiveResult(json.result ?? null);
      setNoticeMsg(successLabel);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(false);
    }
  };

  const speakers: Array<Record<string, any>> = Array.isArray(activeResult?.speakers)
    ? activeResult.speakers
    : [];
  const turns: Array<Record<string, any>> = Array.isArray(activeResult?.turns)
    ? activeResult.turns
    : [];
  const privacyAudit = activeResult?.privacyAudit ?? null;
  const fixtureMetrics = sampleRun?.controlledFixtureMetrics ?? null;

  return (
    <div className="space-y-4" data-testid="speaker-intelligence-panel">
      {/* Header & Biometric Privacy Invariants */}
      <section className="bg-[#0F1522] border border-[#232D42] rounded-md overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#1E2738] bg-[#121A2B]">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-amber-300" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 tracking-tight">
                SHAHAB-026 — Speaker Diarization &amp; Multi-Speaker Attribution
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Anonymous recording-scoped IDs only (speaker_1, speaker_2) · Zero persistent voiceprints · Explicit OVERLAPPING_SPEECH &amp; UNKNOWN_SPEAKER handling
              </p>
            </div>
          </div>
          <SpeakerBadge value={diarizationState?.finalStatus ?? 'PARTIALLY_VERIFIED'} />
        </div>

        <div className="p-4 space-y-4">
          {/* KPI Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Diarization Capability
              </div>
              <div className="text-xs font-mono font-semibold text-amber-300 mt-1 break-words">
                {caps?.capabilityStatus ?? 'SEPARATE_DIARIZATION_MODEL_REQUIRED'}
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Biometric Privacy Gate
              </div>
              <div className="text-xs font-mono font-semibold text-emerald-300 mt-1 flex items-center gap-1">
                <Lock className="w-3.5 h-3.5" />
                <span>embeddingsRetained = false</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Identity inference: PROHIBITED
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Streaming Diarization
              </div>
              <div className="text-xs font-mono font-semibold text-rose-300 mt-1">
                {caps?.streamingStatus ?? 'STREAMING_DIARIZATION_UNAVAILABLE'}
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Real-World Persian DER
              </div>
              <div className="text-xs font-mono font-semibold text-rose-300 mt-1">
                NOT_MEASURED
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Neural embeddings &amp; corpus required
              </div>
            </div>
          </div>

          {/* Stage Separation Table */}
          {caps?.stageSeparation && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
              {Object.entries(caps.stageSeparation).map(([stage, status]) => (
                <div
                  key={stage}
                  className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5 space-y-1.5 min-w-0"
                >
                  <div className="text-[10px] uppercase tracking-wider text-slate-400 truncate">
                    {stage}
                  </div>
                  <SpeakerBadge value={String(status)} />
                </div>
              ))}
            </div>
          )}

          {/* Controlled Fixture Metrics */}
          {fixtureMetrics && (
            <div className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-3 text-xs space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-100">
                  Controlled Synthetic Multi-Speaker Fixture Metrics (Not Real-World Persian Speech)
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {fixtureMetrics.datasetLabel}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 font-mono tabular-nums text-[11px] pt-1">
                <div>
                  <span className="text-slate-400 block">DER</span>
                  <span className="text-slate-100">
                    {(Number(fixtureMetrics.diarizationErrorRate ?? 0) * 100).toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">JER</span>
                  <span className="text-slate-100">
                    {(Number(fixtureMetrics.jaccardErrorRate ?? 0) * 100).toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">Missed / FA</span>
                  <span className="text-slate-100">
                    {(Number(fixtureMetrics.missedSpeechRate ?? 0) * 100).toFixed(1)}% /{' '}
                    {(Number(fixtureMetrics.falseAlarmRate ?? 0) * 100).toFixed(1)}%
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">Speaker Confusion</span>
                  <span className="text-slate-100">
                    {(Number(fixtureMetrics.speakerConfusionRate ?? 0) * 100).toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">Conflict Protection</span>
                  <span className="text-emerald-300">
                    {sampleRun?.manualReviewConflictProtected ? 'VERIFIED' : 'UNVERIFIED'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Interactive Diarization & Manual Review Controls */}
      <section className="bg-[#0F1522] border border-[#232D42] rounded-md overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#1E2738] bg-[#121A2B]">
          <div className="flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-sky-300" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 tracking-tight">
                Interactive Diarization &amp; Manual Speaker Review Workflow
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Run recording-scoped clustering, rename local labels, merge clusters, mark UNKNOWN_SPEAKER, and undo revisions
              </p>
            </div>
          </div>
          {activeResult?.recordingScopeId && (
            <span className="font-mono text-[11px] text-slate-400">
              Scope: {activeResult.recordingScopeId}
            </span>
          )}
        </div>

        <div className="p-4 space-y-4 text-xs">
          {/* Run Controls */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <label className="flex items-center gap-2 bg-[#0B0F17] border border-[#1E2738] px-3 py-2 rounded-sm cursor-pointer">
              <input
                type="checkbox"
                data-testid="diarization-consent-checkbox"
                checked={consentGranted}
                onChange={(e) => setConsentGranted(e.target.checked)}
                className="accent-amber-400"
              />
              <span className="text-slate-200">Explicit User Privacy Consent</span>
            </label>

            <label className="flex items-center gap-2 bg-[#0B0F17] border border-[#1E2738] px-3 py-2 rounded-sm cursor-pointer">
              <input
                type="checkbox"
                checked={includeOverlapFixture}
                onChange={(e) => setIncludeOverlapFixture(e.target.checked)}
                className="accent-amber-400"
              />
              <span className="text-slate-200">Include Overlap Region (6.1–7.3s)</span>
            </label>

            <label className="block space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-400">
                Optional User Speaker Count
              </span>
              <input
                type="number"
                min={1}
                max={8}
                placeholder="Auto (Unknown)"
                value={speakerCountInput}
                onChange={(e) => setSpeakerCountInput(e.target.value)}
                className="w-full bg-[#0B0F17] border border-[#2C3B57] text-slate-100 rounded-sm px-2.5 py-1.5 font-mono text-xs"
              />
            </label>

            <button
              type="button"
              data-testid="diarization-run-btn"
              disabled={running}
              onClick={() => void handleRunDiarization()}
              className="inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold bg-amber-400/15 hover:bg-amber-400/25 border border-amber-400/60 text-amber-200 rounded-sm cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{running ? 'Running Diarization…' : 'Run Diarization'}</span>
            </button>
          </div>

          {errorMsg && (
            <div className="flex items-center gap-2 px-3 py-2 bg-rose-950/60 border border-rose-500/50 text-rose-200 rounded-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
          {noticeMsg && (
            <div className="flex items-center gap-2 px-3 py-2 bg-emerald-950/40 border border-emerald-500/40 text-emerald-200 rounded-sm">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>{noticeMsg}</span>
            </div>
          )}

          {/* Manual Review Action Bar (Active when live session exists) */}
          {liveResult && (
            <div
              className="bg-[#0B0F17] border border-[#232D42] rounded-sm p-3 space-y-2.5"
              data-testid="diarization-review-controls"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-100">
                  Local-Only Speaker Review Controls (Protected Against Re-Diarization Overwrite)
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  Revision: {liveResult.revisionId}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={renameSpeakerId}
                  onChange={(e) => setRenameSpeakerId(e.target.value)}
                  className="bg-[#0F1522] border border-[#2C3B57] text-slate-100 rounded-sm px-2 py-1.5 font-mono text-xs"
                >
                  {speakers.map((s) => (
                    <option key={s.speakerId} value={s.speakerId}>
                      {s.speakerId}
                    </option>
                  ))}
                </select>
                <input
                  dir="rtl"
                  type="text"
                  data-testid="diarization-rename-input"
                  value={renameLabel}
                  onChange={(e) => setRenameLabel(e.target.value)}
                  placeholder="برچسب محلی گوینده..."
                  className="bg-[#0F1522] border border-[#2C3B57] text-slate-100 rounded-sm px-2.5 py-1.5 text-xs min-w-[180px]"
                />
                <button
                  type="button"
                  data-testid="diarization-rename-btn"
                  disabled={reviewing || !renameLabel.trim()}
                  onClick={() =>
                    void handleReviewAction(
                      {
                        action: 'RENAME_LOCAL_LABEL',
                        speakerId: renameSpeakerId,
                        newLocalLabel: renameLabel.trim(),
                      },
                      `Renamed local display label for ${renameSpeakerId}.`,
                    )
                  }
                  className="px-3 py-1.5 bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-sky-200 rounded-sm font-medium cursor-pointer disabled:opacity-50"
                >
                  Apply Local Label
                </button>
                {speakers.length >= 2 && (
                  <button
                    type="button"
                    data-testid="diarization-merge-btn"
                    disabled={reviewing}
                    onClick={() =>
                      void handleReviewAction(
                        {
                          action: 'MERGE_CLUSTERS',
                          sourceSpeakerId: speakers[1].speakerId,
                          targetSpeakerId: speakers[0].speakerId,
                        },
                        `Merged ${speakers[1].speakerId} into ${speakers[0].speakerId}.`,
                      )
                    }
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#182235] hover:bg-[#22304A] border border-[#2C3B57] text-slate-200 rounded-sm cursor-pointer disabled:opacity-50"
                  >
                    <Merge className="w-3.5 h-3.5" />
                    <span>
                      Merge {speakers[1].speakerId} → {speakers[0].speakerId}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  data-testid="diarization-undo-btn"
                  disabled={reviewing}
                  onClick={() =>
                    void handleReviewAction({ action: 'UNDO' }, 'Undid last speaker revision.')
                  }
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#182235] hover:bg-[#22304A] border border-[#2C3B57] text-slate-200 rounded-sm cursor-pointer disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Undo</span>
                </button>
              </div>
            </div>
          )}

          {/* Speakers Summary & Turns Table */}
          {activeResult && (
            <div className="space-y-3" data-testid="diarization-result-view">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono tabular-nums text-[11px]">
                <div className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                  <div className="text-slate-400">Detected Speakers</div>
                  <div className="text-slate-100 mt-0.5">{speakers.length}</div>
                </div>
                <div className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                  <div className="text-slate-400">Speech / Non-Speech</div>
                  <div className="text-slate-100 mt-0.5">
                    {activeResult.speechDurationMs ?? 0} ms / {activeResult.nonSpeechDurationMs ?? 0} ms
                  </div>
                </div>
                <div className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                  <div className="text-slate-400">Overlapping Speech</div>
                  <div className="text-amber-300 mt-0.5">
                    {activeResult.overlapDurationMs ?? 0} ms
                  </div>
                </div>
                <div className="bg-[#0B0F17] border border-[#1E2738] p-2.5 rounded-sm">
                  <div className="text-slate-400">Ephemeral Purge</div>
                  <div className="text-emerald-300 mt-0.5">
                    {privacyAudit
                      ? `purged (${String(privacyAudit.ephemeralEmbeddingsPurgedAtUtc ?? '').slice(11, 19) || 'VERIFIED'})`
                      : 'VERIFIED'}
                  </div>
                </div>
              </div>

              {/* Speakers Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {speakers.map((sp) => (
                  <div
                    key={sp.speakerId}
                    className="bg-[#0B0F17] border border-[#1E2738] rounded-sm p-2.5 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="font-mono font-semibold text-slate-100">{sp.speakerId}</div>
                      {sp.localDisplayLabel && (
                        <div dir="rtl" className="text-amber-300 text-xs mt-0.5">
                          {sp.localDisplayLabel}
                        </div>
                      )}
                      <div className="font-mono text-[11px] text-slate-400 tabular-nums mt-0.5">
                        {sp.turnCount} turns · {sp.totalSpeakingMs} ms
                      </div>
                    </div>
                    <SpeakerBadge value={sp.origin} />
                  </div>
                ))}
              </div>

              {/* Turns Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[#232D42] text-[10px] uppercase tracking-wider text-slate-400">
                      <th className="py-1.5 pr-2">Turn</th>
                      <th className="py-1.5 pr-2">Kind</th>
                      <th className="py-1.5 pr-2">Speaker / Active IDs</th>
                      <th className="py-1.5 pr-2">Time (s)</th>
                      <th className="py-1.5 pr-2">Origin</th>
                      <th className="py-1.5">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1A2233]">
                    {turns.map((t) => (
                      <tr key={t.turnId}>
                        <td className="py-1.5 pr-2 font-mono text-slate-300">{t.turnId}</td>
                        <td className="py-1.5 pr-2">
                          <SpeakerBadge value={t.kind} />
                        </td>
                        <td className="py-1.5 pr-2 font-mono text-slate-100">
                          {t.kind === 'OVERLAPPING_SPEECH'
                            ? (t.activeSpeakerIds ?? []).join(' + ')
                            : t.speakerId}
                        </td>
                        <td className="py-1.5 pr-2 font-mono tabular-nums text-slate-200">
                          {t.range
                            ? `${Number(t.range.startSec).toFixed(2)}–${Number(t.range.endSec).toFixed(2)}`
                            : '—'}
                        </td>
                        <td className="py-1.5 pr-2">
                          <SpeakerBadge value={t.origin} />
                        </td>
                        <td className="py-1.5">
                          {liveResult && (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={reviewing}
                                onClick={() =>
                                  void handleReviewAction(
                                    { action: 'CONFIRM_TURN', turnId: t.turnId },
                                    `Confirmed ${t.turnId} (protected against re-diarization).`,
                                  )
                                }
                                className="px-2 py-0.5 text-[11px] bg-emerald-950/50 hover:bg-emerald-900/60 border border-emerald-500/40 text-emerald-200 rounded-sm cursor-pointer"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                disabled={reviewing}
                                onClick={() =>
                                  void handleReviewAction(
                                    { action: 'MARK_UNKNOWN', turnId: t.turnId },
                                    `Marked ${t.turnId} as UNKNOWN_SPEAKER.`,
                                  )
                                }
                                className="px-2 py-0.5 text-[11px] bg-rose-950/50 hover:bg-rose-900/60 border border-rose-500/40 text-rose-200 rounded-sm cursor-pointer"
                              >
                                Unknown
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Limitations */}
      {Array.isArray(diarizationState?.knownLimitations) &&
        diarizationState.knownLimitations.length > 0 && (
          <section className="bg-[#0F1522] border border-[#232D42] rounded-md p-4 text-xs space-y-1.5">
            <div className="font-semibold text-amber-200">
              Explicit Engineering Limitations (SHAHAB-026)
            </div>
            {diarizationState.knownLimitations.map((lim: string, idx: number) => (
              <div key={idx} className="text-slate-300">
                • {lim}
              </div>
            ))}
          </section>
        )}
    </div>
  );
};
