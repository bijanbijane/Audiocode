import React from 'react';
import { GitMerge, Activity, CheckCircle2, AlertCircle } from 'lucide-react';
import { ProcessingGraphEdge, ProcessingNodeDescriptor } from '../contracts/v1_2';
import { planProcessingGraphPdc } from '../engine/processingGraph';
import { formatNumberForLocale } from '../utils/formatters';

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
  locale?: 'fa' | 'en';
  persianDigits?: boolean;
}

export const ProcessingGraphView: React.FC<ProcessingGraphViewProps> = ({
  nodes,
  edges,
  sampleRate,
  resamplerStats,
  onToggleNodeBypass,
  locale = 'fa',
  persianDigits = false,
}) => {
  const isFa = locale === 'fa';
  const fmt = (n: number | string) => formatNumberForLocale(n, { persianDigits });
  const pdcPlan = planProcessingGraphPdc(nodes, edges);
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48_000;

  return (
    <div dir={isFa ? 'rtl' : 'ltr'} className="space-y-6 text-[var(--avp-text)]">
      <div className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-4 sm:p-5">
        <h1 className="text-lg font-bold tracking-tight text-[var(--avp-text)]">
          {isFa
            ? 'گراف پردازش صدا، جبران تأخیر خودکار (PDC) و بازنمونه‌بردار'
            : 'Audio Processing Graph, Automatic PDC & Resampler'}
        </h1>
        <p className="text-xs text-[var(--avp-text-secondary)] mt-1">
          {isFa
            ? 'بازرسی توپولوژی DAG، بافرهای Pre-Roll و خطوط تأخیر خودکار پیش از Master Bus'
            : 'Live inspection of acyclic DAG routing, pre-roll priming buffers, and Master Bus phase alignment'}
        </p>
      </div>

      {/* Top KPI Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-4">
          <div className="text-xs text-[var(--avp-text-secondary)]">
            {isFa ? 'اعتبارسنجی گراف (DAG)' : 'Graph Validation (DAG)'}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-base font-semibold text-[var(--avp-success-text)]">
            {pdcPlan.isValidDag ? (
              <>
                <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                <span>{isFa ? 'بدون چرخه (Valid DAG)' : 'Valid Acyclic DAG'}</span>
              </>
            ) : (
              <>
                <AlertCircle className="w-4 h-4 text-[var(--avp-danger)]" aria-hidden="true" />
                <span className="text-[var(--avp-danger)]">{isFa ? 'خطای چرخه' : 'Cycle Error'}</span>
              </>
            )}
          </div>
        </div>

        <div className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-4">
          <div className="text-xs text-[var(--avp-text-secondary)]">
            {isFa ? 'تأخیر کل گراف (Total PDC)' : 'Total Graph PDC'}
          </div>
          <div dir="ltr" className="mt-1.5 text-base font-semibold font-mono text-[var(--avp-text)] text-start">
            {fmt(pdcPlan.totalGraphLatencySamples)} samples{' '}
            <span className="text-xs text-[var(--avp-text-muted)]">
              ({fmt(((pdcPlan.totalGraphLatencySamples / safeSampleRate) * 1000).toFixed(2))} ms)
            </span>
          </div>
        </div>

        <div className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-4">
          <div className="text-xs text-[var(--avp-text-secondary)]">
            {isFa ? 'بافر پیش‌تغذیه (Pre-Roll Priming)' : 'Pre-Roll Priming Buffer'}
          </div>
          <div dir="ltr" className="mt-1.5 text-base font-semibold font-mono text-[var(--avp-warning-text)] text-start">
            {fmt(pdcPlan.totalPreRollSamples)} samples{' '}
            <span className="text-xs text-[var(--avp-text-muted)]">
              ({fmt(((pdcPlan.totalPreRollSamples / safeSampleRate) * 1000).toFixed(0))} ms)
            </span>
          </div>
        </div>

        <div className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-4">
          <div className="text-xs text-[var(--avp-text-secondary)]">
            {isFa ? 'تضعیف Aliasing مسیر ۱۶kHz' : '16kHz Anti-Aliasing Attenuation'}
          </div>
          <div dir="ltr" className="mt-1.5 text-base font-semibold font-mono text-[var(--avp-accent-text)] text-start">
            -{fmt(resamplerStats.aliasingAttenuationDb)} dB
          </div>
        </div>
      </div>

      {/* Interactive Processing Graph & Automatic PDC Table */}
      <section className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
          <div className="flex items-center gap-2">
            <GitMerge className="w-4 h-4 text-[var(--avp-accent-text)]" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-[var(--avp-text)]">
              {isFa
                ? 'گراف پردازش موازی، جبران تأخیر خودکار (PDC) و Pre-Roll'
                : 'Parallel Processing Graph, Automatic PDC & Pre-Roll'}
            </h2>
          </div>
          <span className="text-xs text-[var(--avp-text-secondary)]">
            {isFa
              ? 'برای مشاهده محاسبه مجدد خط تأخیر PDC، گره‌های مسیر اصلی را Bypass کنید'
              : 'Toggle Bypass on primary path nodes to inspect live PDC delay recalculation'}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="bg-[var(--avp-surface-secondary)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
              <tr>
                <th className="py-2.5 px-4 font-medium">{isFa ? 'گره پردازشی' : 'Node'}</th>
                <th className="py-2.5 px-4 font-medium">{isFa ? 'نوع' : 'Kind'}</th>
                <th className="py-2.5 px-4 font-medium">{isFa ? 'تأخیر (Latency)' : 'Latency'}</th>
                <th className="py-2.5 px-4 font-medium">{isFa ? 'پیش‌تغذیه (Pre-Roll)' : 'Pre-Roll'}</th>
                <th className="py-2.5 px-4 font-medium">{isFa ? 'دنباله (Tail)' : 'Tail'}</th>
                <th className="py-2.5 px-4 font-medium">{isFa ? 'وضعیت' : 'State'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--avp-border-subtle)]">
              {nodes.map((node) => (
                <tr key={node.id} className="hover:bg-[var(--avp-surface-hover)]/60">
                  <td className="py-3 px-4">
                    <div className="font-semibold text-[var(--avp-text)]">{isFa ? node.labelFa : node.id}</div>
                    <div dir="ltr" className="text-[11px] font-mono text-[var(--avp-text-muted)] text-start">{node.id}</div>
                  </td>
                  <td className="py-3 px-4 text-[var(--avp-text-secondary)] font-mono">
                    <span dir="ltr" className="inline-block">{node.kind}</span>
                  </td>
                  <td className="py-3 px-4 font-mono text-[var(--avp-text)]">
                    <span dir="ltr" className="inline-block">
                      {fmt(node.bypassed ? 0 : node.latencySamples)} smp
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono text-[var(--avp-warning-text)]">
                    <span dir="ltr" className="inline-block">
                      {fmt(node.bypassed ? 0 : node.preRollSamples)} smp
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono text-[var(--avp-text-secondary)]">
                    <span dir="ltr" className="inline-block">
                      {fmt(node.bypassed ? 0 : node.tailSamples)} smp
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    {node.kind === 'source' || node.kind === 'limiter' ? (
                      <span className="text-[var(--avp-success-text)] font-medium">
                        {isFa ? 'فعال دائمی' : 'Always Active'}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onToggleNodeBypass(node.id)}
                        className={`avp-btn avp-btn-sm min-h-[44px] sm:min-h-[30px] ${
                          node.bypassed
                            ? 'avp-btn-outline'
                            : 'avp-btn-tonal'
                        }`}
                      >
                        {node.bypassed
                          ? isFa
                            ? 'Bypass شده (کلیک برای فعال‌سازی)'
                            : 'Bypassed (Enable)'
                          : isFa
                            ? 'فعال (کلیک برای Bypass)'
                            : 'Active (Bypass)'}
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
            {isFa
              ? 'خطوط تأخیر خودکارِ درج‌شده پیش از Master Bus (جلوگیری از خطای فاز Comb Filtering):'
              : 'Automatic Delay Lines Inserted Before Master Bus (Comb-Filtering Prevention):'}
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
                    {isFa ? 'تأخیر مسیر:' : 'Branch Latency:'}{' '}
                    <span dir="ltr" className="inline-block font-mono">
                      {bc.pathLatencySamples} smp
                    </span>{' '}
                    · {isFa ? 'مرجع باس:' : 'Bus Ref:'}{' '}
                    <span dir="ltr" className="inline-block font-mono">
                      {bc.maxBusLatencySamples} smp
                    </span>
                  </div>
                </div>
                <div className="font-mono text-sm font-semibold text-[var(--avp-warning-text)] flex items-center gap-1.5">
                  <span dir="ltr" className="inline-block">+{bc.insertedDelaySamples} smp</span>
                  <span className="font-sans text-xs">{isFa ? 'تأخیر' : 'delay'}</span>
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
            {isFa
              ? 'مبدل ضد Aliasing برای تغذیه موتور هوش مصنوعی (Windowed-Sinc FIR)'
              : 'Anti-Aliased AI Engine Resampler (Windowed-Sinc FIR)'}
          </h2>
        </div>
        <p className="text-xs text-[var(--avp-text-secondary)] leading-relaxed mb-4">
          {isFa
            ? 'برای جلوگیری از برگشت فرکانس‌های بالای ۸ کیلوهرتز (Aliasing) روی حروف سایشی فارسی (س، ش، ز، ف) هنگام کاهش نرخ نمونه به ۱۶kHz Mono، صوت تایم‌لاین از فیلتر پایین‌گذر Kaiser-Sinc عبور داده شده و بدون خطای رانش (از طریق Timebase با پایه ۷۰۵,۶۰۰,۰۰۰ Flicks) به مدل تحویل داده می‌شود.'
            : 'Audio is filtered through a Kaiser-Sinc low-pass FIR before 16kHz mono downsampling to prevent high-frequency sibilant aliasing while keeping sample-exact alignment on a 705,600,000 Flicks/s timebase.'}
        </p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">{isFa ? 'نرخ ورودی' : 'Input Rate'}</div>
            <div dir="ltr" className="font-mono text-[var(--avp-text)] mt-1 text-start">
              {resamplerStats.inputSampleRate} Hz
            </div>
          </div>
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">{isFa ? 'نرخ خروجی AI' : 'AI Output Rate'}</div>
            <div dir="ltr" className="font-mono text-[var(--avp-success-text)] mt-1 text-start">
              {resamplerStats.outputSampleRate} Hz Mono
            </div>
          </div>
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">{isFa ? 'فرکانس قطع (Cutoff)' : 'Cutoff Freq'}</div>
            <div dir="ltr" className="font-mono text-[var(--avp-text)] mt-1 text-start">
              {resamplerStats.cutoffHz} Hz
            </div>
          </div>
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">{isFa ? 'طول فیلتر FIR' : 'FIR Filter Taps'}</div>
            <div dir="ltr" className="font-mono text-[var(--avp-text)] mt-1 text-start">
              {resamplerStats.filterTaps} taps
            </div>
          </div>
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
            <div className="text-[var(--avp-text-secondary)]">{isFa ? 'نمونه‌های خروجی' : 'Output Samples'}</div>
            <div dir="ltr" className="font-mono text-[var(--avp-accent-text)] mt-1 text-start">
              {resamplerStats.downsampledLength.toLocaleString()}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
