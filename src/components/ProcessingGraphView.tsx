import React from 'react';
import { GitMerge, Activity, CheckCircle2, AlertCircle } from 'lucide-react';
import { ProcessingGraphEdge, ProcessingNodeDescriptor } from '../contracts/v1_2';
import { planProcessingGraphPdc } from '../engine/processingGraph';

interface ProcessingGraphViewProps {
  nodes: ProcessingNodeDescriptor[];
  edges: ProcessingGraphEdge[];
  sampleRate: number;
  resamplerStats: {
    inputSampleRate: number;
    outputSampleRate: number;
    cutoffHz: number;
    filterTaps: number;
    aliasingAttenuationDb: number;
    downsampledLength: number;
  };
  onToggleNodeBypass: (nodeId: string) => void;
}

export const ProcessingGraphView: React.FC<ProcessingGraphViewProps> = ({
  nodes,
  edges,
  sampleRate,
  resamplerStats,
  onToggleNodeBypass,
}) => {
  const pdcPlan = planProcessingGraphPdc(nodes, edges);
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48_000;

  return (
    <div dir="rtl" className="space-y-6 text-[var(--avp-text)]">
      {/* Top KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-4">
          <div className="text-xs text-[var(--avp-text-secondary)]">اعتبارسنجی گراف (DAG)</div>
          <div className="mt-1.5 flex items-center gap-2 text-base font-semibold text-[var(--avp-success-text)]">
            {pdcPlan.isValidDag ? (
              <>
                <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                <span>بدون چرخه (Valid DAG)</span>
              </>
            ) : (
              <>
                <AlertCircle className="w-4 h-4 text-[var(--avp-danger)]" aria-hidden="true" />
                <span className="text-[var(--avp-danger)]">خطای چرخه</span>
              </>
            )}
          </div>
        </div>

        <div className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-4">
          <div className="text-xs text-[var(--avp-text-secondary)]">تأخیر کل گراف (Total PDC)</div>
          <div dir="ltr" className="mt-1.5 text-base font-semibold font-mono text-[var(--avp-text)] text-right">
            {pdcPlan.totalGraphLatencySamples} samples{' '}
            <span className="text-xs text-[var(--avp-text-muted)]">
              ({((pdcPlan.totalGraphLatencySamples / safeSampleRate) * 1000).toFixed(2)} ms)
            </span>
          </div>
        </div>

        <div className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-4">
          <div className="text-xs text-[var(--avp-text-secondary)]">بافر پیش‌تغذیه (Pre-Roll Priming)</div>
          <div dir="ltr" className="mt-1.5 text-base font-semibold font-mono text-[var(--avp-warning-text)] text-right">
            {pdcPlan.totalPreRollSamples} samples{' '}
            <span className="text-xs text-[var(--avp-text-muted)]">
              ({((pdcPlan.totalPreRollSamples / safeSampleRate) * 1000).toFixed(0)} ms)
            </span>
          </div>
        </div>

        <div className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-4">
          <div className="text-xs text-[var(--avp-text-secondary)]">تضعیف Aliasing مسیر ۱۶kHz</div>
          <div dir="ltr" className="mt-1.5 text-base font-semibold font-mono text-[var(--avp-accent-text)] text-right">
            -{resamplerStats.aliasingAttenuationDb} dB
          </div>
        </div>
      </div>

      {/* Interactive Processing Graph & Automatic PDC Table */}
      <section className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
          <div className="flex items-center gap-2">
            <GitMerge className="w-4 h-4 text-[var(--avp-accent-text)]" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-[var(--avp-text)]">
              گراف پردازش موازی، جبران تأخیر خودکار (PDC) و Pre-Roll
            </h2>
          </div>
          <span className="text-xs text-[var(--avp-text-secondary)]">
            برای مشاهده محاسبه مجدد خط تأخیر PDC، گره‌های مسیر اصلی را Bypass کنید
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-[var(--avp-surface-secondary)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
              <tr>
                <th className="py-2.5 px-4 font-medium">گره پردازشی</th>
                <th className="py-2.5 px-4 font-medium">نوع</th>
                <th className="py-2.5 px-4 font-medium">تأخیر (Latency)</th>
                <th className="py-2.5 px-4 font-medium">پیش‌تغذیه (Pre-Roll)</th>
                <th className="py-2.5 px-4 font-medium">دنباله (Tail)</th>
                <th className="py-2.5 px-4 font-medium">وضعیت</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--avp-border-subtle)]">
              {nodes.map((node) => (
                <tr key={node.id} className="hover:bg-[var(--avp-surface-hover)]/60">
                  <td className="py-3 px-4">
                    <div className="font-semibold text-[var(--avp-text)]">{node.labelFa}</div>
                    <div dir="ltr" className="text-[11px] font-mono text-[var(--avp-text-muted)] text-right">{node.id}</div>
                  </td>
                  <td className="py-3 px-4 text-[var(--avp-text-secondary)] font-mono">
                    <span dir="ltr" className="inline-block">{node.kind}</span>
                  </td>
                  <td className="py-3 px-4 font-mono text-[var(--avp-text)]">
                    <span dir="ltr" className="inline-block">
                      {node.bypassed ? 0 : node.latencySamples} smp
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono text-[var(--avp-warning-text)]">
                    <span dir="ltr" className="inline-block">
                      {node.bypassed ? 0 : node.preRollSamples} smp
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono text-[var(--avp-text-secondary)]">
                    <span dir="ltr" className="inline-block">
                      {node.bypassed ? 0 : node.tailSamples} smp
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    {node.kind === 'source' || node.kind === 'limiter' ? (
                      <span className="text-[var(--avp-success-text)] font-medium">فعال دائمی</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onToggleNodeBypass(node.id)}
                        className={`avp-btn avp-btn-sm ${
                          node.bypassed
                            ? 'avp-btn-outline'
                            : 'avp-btn-tonal'
                        }`}
                      >
                        {node.bypassed ? 'Bypass شده (کلیک برای فعال‌سازی)' : 'فعال (کلیک برای Bypass)'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Automatic PDC Compensations Computed */}
        <div className="p-4 border-t border-[var(--avp-border)] bg-[var(--avp-surface-shell)] space-y-2">
          <h3 className="text-xs font-semibold text-[var(--avp-text)]">
            خطوط تأخیر خودکارِ درج‌شده پیش از Master Bus (جلوگیری از خطای فاز Comb Filtering):
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {pdcPlan.branchCompensations.map((bc, idx) => (
              <div
                key={`${bc.branchRootNodeId}-${idx}`}
                className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] flex items-center justify-between text-xs"
              >
                <div>
                  <span dir="ltr" className="text-[var(--avp-text)] font-mono inline-block">
                    {bc.branchRootNodeId}
                  </span>
                  <div className="text-[11px] text-[var(--avp-text-secondary)] mt-0.5">
                    تأخیر مسیر:{' '}
                    <span dir="ltr" className="inline-block font-mono">
                      {bc.pathLatencySamples} smp
                    </span>{' '}
                    · مرجع باس:{' '}
                    <span dir="ltr" className="inline-block font-mono">
                      {bc.maxBusLatencySamples} smp
                    </span>
                  </div>
                </div>
                <div className="font-mono text-sm font-semibold text-[var(--avp-warning-text)] flex items-center gap-1.5">
                  <span dir="ltr" className="inline-block">+{bc.insertedDelaySamples} smp</span>
                  <span className="font-sans text-xs">تأخیر</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Anti-Aliased 16kHz Resampler Panel */}
      <section className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-[var(--avp-accent-text)]" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-[var(--avp-text)]">
            مبدل ضد Aliasing برای تغذیه موتور هوش مصنوعی (Windowed-Sinc FIR)
          </h2>
        </div>
        <p className="text-xs text-[var(--avp-text-secondary)] leading-relaxed mb-4">
          برای جلوگیری از برگشت فرکانس‌های بالای ۸ کیلوهرتز (Aliasing) روی حروف سایشی فارسی (س، ش، ز، ف) هنگام کاهش نرخ نمونه به ۱۶kHz Mono، صوت تایم‌لاین از فیلتر پایین‌گذر Kaiser-Sinc عبور داده شده و بدون خطای رانش (از طریق Timebase با پایه ۷۰۵,۶۰۰,۰۰۰ Flicks) به مدل تحویل داده می‌شود.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">نرخ ورودی</div>
            <div dir="ltr" className="font-mono text-[var(--avp-text)] mt-1 text-right">
              {resamplerStats.inputSampleRate} Hz
            </div>
          </div>
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">نرخ خروجی AI</div>
            <div dir="ltr" className="font-mono text-[var(--avp-success-text)] mt-1 text-right">
              {resamplerStats.outputSampleRate} Hz Mono
            </div>
          </div>
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">فرکانس قطع (Cutoff)</div>
            <div dir="ltr" className="font-mono text-[var(--avp-text)] mt-1 text-right">
              {resamplerStats.cutoffHz} Hz
            </div>
          </div>
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">طول فیلتر FIR</div>
            <div dir="ltr" className="font-mono text-[var(--avp-text)] mt-1 text-right">
              {resamplerStats.filterTaps} taps
            </div>
          </div>
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">نمونه‌های خروجی</div>
            <div dir="ltr" className="font-mono text-[var(--avp-accent-text)] mt-1 text-right">
              {resamplerStats.downsampledLength.toLocaleString()}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
