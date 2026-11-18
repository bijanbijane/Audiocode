import React, { useEffect, useState } from 'react';
import {
  Activity,
  Award,
  Box,
  Cpu,
  FlaskConical,
  GitBranch,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  MlExperimentRecord,
  ModelApprovalRecord,
  ModelDeploymentEventRecord,
  ModelDeploymentRecord,
  ModelEvaluationReport,
  ModelMonitoringSnapshot,
  ModelPackageRecord,
  ModelVersionRecord,
  OptimizationExperimentRecord,
  TrainingCheckpointRecord,
  TrainingRunRecord,
} from '../model-factory/ModelFactoryContracts';

interface ModelFactoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ModelFactoryTab = 'experiments' | 'training' | 'evaluation' | 'registry' | 'deployment_router';

interface SandboxMlOpsSummary {
  experiments: MlExperimentRecord[];
  trainingRuns: TrainingRunRecord[];
  checkpoints: TrainingCheckpointRecord[];
  models: ModelVersionRecord[];
  evaluations: ModelEvaluationReport[];
  packages: ModelPackageRecord[];
  approvals: ModelApprovalRecord[];
  deployments: ModelDeploymentRecord[];
  deploymentEvents: ModelDeploymentEventRecord[];
  monitoring: ModelMonitoringSnapshot[];
  optimizations: OptimizationExperimentRecord[];
  routableEngines: Array<{
    engine_id: string;
    engine_name: string;
    model_identifier: string;
    model_revision: string;
    lifecycle_state: string;
  }>;
}

export const ModelFactoryModal: React.FC<ModelFactoryModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<ModelFactoryTab>('experiments');
  const [data, setData] = useState<SandboxMlOpsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSummary = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/model-factory/sandbox/overview');
      if (res.ok) {
        setData((await res.json()) as SandboxMlOpsSummary);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadSummary();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleRunOptimization = async (modelVersionId: string) => {
    setNotice(null);
    const res = await fetch(`/api/v1/model-factory/sandbox/models/${modelVersionId}/optimize`, {
      method: 'POST',
    });
    if (res.ok) {
      setNotice('نسخه بهینه‌شده (Dynamic INT8 Quantization) به‌صورت نسخه مستقل و بدون دست‌کاری مدل والد ثبت شد.');
      await loadSummary();
    }
  };

  const handleRollback = async (deploymentId: string) => {
    setNotice(null);
    const res = await fetch(`/api/v1/model-factory/sandbox/deployments/${deploymentId}/rollback`, {
      method: 'POST',
    });
    if (res.ok) {
      setNotice('بازگشت اضطراری (Rollback) اجرا شد، نسخه قبلی بازیابی شد و شواهد نسخه خطادار حفظ گردید.');
      await loadSummary();
    } else {
      const err = (await res.json()) as { message?: string };
      setNotice(`خطای بازگشت: ${err.message ?? 'نامشخص'}`);
    }
  };

  const tabs: Array<{ id: ModelFactoryTab; label: string; icon: React.ReactNode }> = [
    { id: 'experiments', label: 'آزمایش‌ها و محیط تکرارپذیر', icon: <FlaskConical className="w-3.5 h-3.5" /> },
    { id: 'training', label: 'اجرای آموزش و چک‌پوینت', icon: <Cpu className="w-3.5 h-3.5" /> },
    { id: 'evaluation', label: 'ارزیابی برشی و بوت‌استرپ', icon: <Award className="w-3.5 h-3.5" /> },
    { id: 'registry', label: 'رجیستری تغییرناپذیر و بسته‌بندی', icon: <Box className="w-3.5 h-3.5" /> },
    { id: 'deployment_router', label: 'استقرار، بازگشت و مسیریاب', icon: <Activity className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="کارخانه توسعه مدل و MLOps (فاز ۱۳)"
      data-testid="modal-model-factory"
    >
      <div className="w-full max-w-6xl max-h-[90vh] flex flex-col rounded-xl border border-[#252F42] bg-[#0B0F17] text-slate-100 shadow-2xl overflow-hidden">
        <header className="flex items-center justify-between px-5 py-4 border-b border-[#252F42] bg-[#131924]">
          <div className="flex items-center gap-3">
            <GitBranch className="w-5 h-5 text-violet-400" aria-hidden="true" />
            <div>
              <h2 className="text-base font-bold text-slate-100">
                کارخانه توسعه مدل و چرخه عمر MLOps (فاز ۱۳)
              </h2>
              <p className="text-xs text-slate-400">
                آموزش قابل بازتولید • چک‌پوینت اتمیک • گیت کیفیت بوت‌استرپ • رجیستری تغییرناپذیر • استقرار کنترل‌شده و بازگشت
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن کارخانه مدل"
            className="p-1.5 rounded-md border border-[#252F42] text-slate-300 hover:bg-[#1E2738] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <nav className="flex flex-wrap gap-1.5 px-5 py-2.5 border-b border-[#252F42] bg-[#0E131D]" aria-label="بخش‌های MLOps">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              data-testid={`mf-tab-${t.id}`}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                activeTab === t.id
                  ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40'
                  : 'text-slate-400 border border-transparent hover:text-slate-200 hover:bg-[#161D2B]'
              }`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        {notice && (
          <div className="mx-5 mt-3 px-3.5 py-2 rounded-md border border-violet-500/30 bg-violet-500/10 text-xs text-violet-200">
            {notice}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading || !data ? (
            <div className="text-xs text-slate-400 py-8 text-center">در حال بارگذاری چرخه عمر MLOps...</div>
          ) : (
            <>
              {activeTab === 'experiments' && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
                    <strong>صداقت سخت‌افزاری کانتینر:</strong> کانتینر فعلی فاقد GPU CUDA است (<span dir="ltr">G0_CPU_ONLY</span>). آزمایش‌های آداپتور CPU به‌صورت واقعی اجرا و بازتولید می‌شوند، اما درخواست‌های <span dir="ltr">GPU_MEDIUM</span> در گیت پیش‌پرواز صادقانه <span dir="ltr">BLOCKED</span> می‌شوند.
                  </div>
                  {data.experiments.map((exp) => (
                    <div key={exp.experimentId} className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-mono text-violet-300" dir="ltr">
                          {exp.experimentId} • {exp.experimentName}
                        </div>
                        <div className="flex gap-2 font-mono text-[11px]" dir="ltr">
                          <span className="px-2 py-0.5 rounded bg-sky-500/20 text-sky-200">{exp.requestedResourceClass}</span>
                          <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-200">{exp.reproducibilityLevel}</span>
                        </div>
                      </div>
                      <div className="text-slate-300">
                        <span className="text-slate-400">فرضیه: </span>
                        {exp.hypothesis.proposedChange} → <span className="text-emerald-300">{exp.hypothesis.acceptanceCriterion}</span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400" dir="ltr">
                        ConfigHash: {exp.configurationHash.slice(0, 20)}... | Method: {exp.initializationType} | Datasets: {exp.datasetReleaseIds.join(', ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'training' && (
                <div className="space-y-4">
                  {data.trainingRuns.map((run) => (
                    <div key={run.trainingRunId} className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-slate-200" dir="ltr">
                          {run.trainingRunId} (Exp: {run.experimentId})
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded font-mono text-[11px] ${
                            run.status === 'COMPLETED'
                              ? 'bg-emerald-500/20 text-emerald-200'
                              : run.status === 'BLOCKED'
                                ? 'bg-amber-500/20 text-amber-200'
                                : 'bg-rose-500/20 text-rose-200'
                          }`}
                          dir="ltr"
                        >
                          {run.status} • {run.resourceClass}
                        </span>
                      </div>
                      {run.failureReason && (
                        <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200 font-mono" dir="ltr">
                          [{run.failureCategory}] {run.failureReason}
                        </div>
                      )}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px] text-slate-300" dir="ltr">
                        <div>Steps: {run.currentStep} / {run.maxSteps}</div>
                        <div>CPU: {run.telemetry.cpuSeconds}s</div>
                        <div>CostType: {run.telemetry.costCategory}</div>
                        <div>EstCost: ${run.telemetry.estimatedCostUsd}</div>
                      </div>
                      {run.lossHistory.length > 0 && (
                        <div className="text-[11px] text-slate-400 font-mono" dir="ltr">
                          Loss trajectory: {run.lossHistory.slice(-4).map((l) => `s${l.step}=${l.trainLoss}`).join(' -> ')}
                        </div>
                      )}
                    </div>
                  ))}

                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-slate-200">چک‌پوینت‌های اتمیک ثبت‌شده</h3>
                    {data.checkpoints.map((c) => (
                      <div key={c.checkpointId} className="p-3 rounded-lg border border-[#252F42] bg-[#0E131D] flex flex-wrap justify-between gap-2 text-xs font-mono" dir="ltr">
                        <span className="text-violet-300">{c.checkpointId} (step={c.globalStep}, {c.checkpointType})</span>
                        <span className="text-slate-400">
                          status={c.integrityStatus} • valCER={c.validationMetrics.valCerPercent}% • sha={c.artifactHash.slice(0, 12)}...
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'evaluation' && (
                <div className="space-y-4">
                  {data.evaluations.map((ev) => (
                    <div key={ev.evaluationId} className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-violet-300" dir="ltr">
                          {ev.evaluationId} • Model {ev.modelVersionId} ({ev.datasetSplit})
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded font-mono text-[11px] ${
                            ev.overallPromotionGatePassed
                              ? 'bg-emerald-500/20 text-emerald-200'
                              : 'bg-rose-500/20 text-rose-200'
                          }`}
                          dir="ltr"
                        >
                          PromotionGate={ev.overallPromotionGatePassed ? 'PASSED' : 'FAILED'}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {ev.coreSlices.slice(0, 4).map((sl) => (
                          <div key={sl.sliceName} className="p-2.5 rounded bg-[#0B0F17] border border-[#1E2738] font-mono text-[11px]" dir="ltr">
                            <div className="text-slate-400">{sl.sliceName}</div>
                            {sl.status === 'EVALUATED' ? (
                              <div className="text-emerald-300">CER={sl.normalizedCerPercent}% | n={sl.sampleCount}</div>
                            ) : (
                              <div className="text-amber-300">NO_EVIDENCE</div>
                            )}
                          </div>
                        ))}
                      </div>

                      {ev.pairedComparisons.map((pc) => (
                        <div key={pc.metricName} className="p-2.5 rounded bg-[#0E131D] border border-[#252F42] font-mono text-[11px] text-slate-300" dir="ltr">
                          Paired Bootstrap ({pc.bootstrapIterations} iters): baseline={pc.baselineMean}% vs candidate={pc.candidateMean}% | delta={pc.meanDeltaCandidateMinusBaseline} | CI95=[{pc.ci95Lower}, {pc.ci95Upper}] | p={pc.pValueTwoSided}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'registry' && (
                <div className="space-y-4">
                  {data.models.map((mv) => (
                    <div key={mv.modelVersionId} className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-mono text-violet-300" dir="ltr">
                          {mv.modelId}@{mv.version} ({mv.modelVersionId})
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-200 font-mono text-[11px]" dir="ltr">
                            {mv.lifecycleStatus}
                          </span>
                          {mv.lifecycleStatus !== 'RESEARCH' && (
                            <button
                              type="button"
                              onClick={() => void handleRunOptimization(mv.modelVersionId)}
                              data-testid={`btn-optimize-${mv.modelVersionId}`}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 cursor-pointer"
                            >
                              <Sparkles className="w-3 h-3" />
                              <span>کوانتایز (نسخه جدید)</span>
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-slate-300">{mv.modelCard.intendedUse}</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono text-slate-400" dir="ltr">
                        <div>WeightsSHA: {mv.weightsArtifactHash.slice(0, 24)}...</div>
                        <div>License: {mv.licenseMetadata.licenseStatus}</div>
                        <div>NativeStream: {String(mv.declaredCapabilities.nativeStreamingSupported)}</div>
                        <div>Tags: [{mv.tags.join(', ')}]</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'deployment_router' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-slate-200">استقرارهای فعال و کنترل بازگشت (Session-Pinned Rollback)</h3>
                    {data.deployments.map((dep) => (
                      <div key={dep.deploymentId} className="p-4 rounded-lg border border-[#252F42] bg-[#131924] space-y-2 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-violet-300" dir="ltr">
                            {dep.deploymentId} • {dep.environment} ({dep.strategy}, {dep.trafficPercentage}%)
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-200 font-mono text-[11px]" dir="ltr">
                              {dep.status} / {dep.servingHealth}
                            </span>
                            {dep.status === 'ACTIVE' && dep.previousModelVersionId && (
                              <button
                                type="button"
                                onClick={() => void handleRollback(dep.deploymentId)}
                                data-testid={`btn-rollback-${dep.deploymentId}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 cursor-pointer"
                              >
                                <RotateCcw className="w-3 h-3" />
                                <span>بازگشت اضطراری (Rollback)</span>
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="text-[11px] font-mono text-slate-400" dir="ltr">
                          Model={dep.modelVersionId} | PrevRollbackTarget={dep.previousModelVersionId ?? 'none'} | PinnedSessions={dep.activePinnedSessions}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 space-y-2 text-xs">
                    <div className="flex items-center gap-2 font-semibold text-emerald-200">
                      <ShieldCheck className="w-4 h-4" />
                      <span>مدل‌های مجاز برای Adaptive ASR Router (فاز ۶)</span>
                    </div>
                    <p className="text-slate-300 text-[11px]">
                      فقط مدل‌های تأییدشده، بسته‌بندی‌شده و دارای تست سلامت <span dir="ltr">HEALTHY</span> به مسیریاب معرفی می‌شوند. مدل‌های <span dir="ltr">RESEARCH</span> و <span dir="ltr">BLOCKED</span> مسدودند.
                    </p>
                    <div className="space-y-1 font-mono text-[11px]" dir="ltr">
                      {data.routableEngines.map((re) => (
                        <div key={re.engine_id} className="text-emerald-300">
                          [ROUTABLE] {re.engine_id} -&gt; {re.model_identifier}@{re.model_revision} ({re.lifecycle_state})
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
