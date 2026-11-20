import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  FlaskConical,
  GitBranch,
  Layers,
  Mic,
  Radio,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import {
  AsrLabEngineId,
  AsrLabExperimentRecord,
  PHASE1_ENGINE_REGISTRY,
  runAsrLabExperiment,
  validateAndPreprocessAudioForLab,
} from '../ai-engine/asr/AsrExperimentationLabCore';
import type { LocalModelLifecycleManager } from '../lifecycle/LocalModelLifecycleManager';
import {
  assignZeroLeakageDatasetSplits,
  classifyTranscriptErrorsIntoTaxonomy,
  evaluateSampleQuality11Gates,
  evaluateWithNormalizationVersion,
  INITIAL_VERIFIED_STUDIO_CORPUS,
  runPairedBootstrapAndHolmBonferroni,
} from '../ai-engine/asr/AsrDatasetAndBehavioralBenchmarkEngine';
import {
  DomainProfileName,
  GLOBAL_PHASE4_CHECKPOINT_MANAGER,
  PHASE4_CANDIDATE_MODEL_REGISTRY,
  runIndependentAsrTranscription,
  runPhase4BaselineVsFineTunedEvaluation,
} from '../ai-engine/asr/IndependentAsrModelDevelopmentEngine';
import {
  ActiveStreamingSession,
  calculateQwenCumulativeAudioOverhead,
  PHASE5_STREAMING_BACKEND_REGISTRY,
  StatefulStreamingResampler16k,
  StreamingAudioPacketizer16k,
  StreamingBackendId,
  StreamingSessionGatewayManager,
} from '../ai-engine/asr/RealTimeStreamingAsrEngine';
import {
  AdaptiveRoutingRequest,
  makeAdaptiveRoutingDecision,
  PrivacyRoutingPolicy,
  RoutingStrategyName,
  runOfflineCounterfactualRegretEvaluation,
} from '../ai-engine/asr/AdaptiveAsrRouterEngine';
import {
  calculateArchitectureParameterBreakdown,
  computeHybridCtcRnntLoss,
  evaluateFromScratchGoNoGoDecision,
} from '../ai-engine/asr/AdvancedModelResearchAndArchitectureEngine';
import {
  buildArchitectureTruthSummary,
  PHASE8_SYSTEM_INVENTORY,
  runAdversarialSecurityAndReadinessAudit,
} from '../ai-engine/asr/IndustrialValidationAndSecurityEngine';
import {
  advanceOrRollbackCanaryRollout,
  computeCohortPsiDrift,
  evaluateChampionVsChallengerGate,
  GLOBAL_CONTINUOUS_LEARNING_HUB,
} from '../ai-engine/asr/ContinuousLearningAndEvolutionEngine';

export type LabTabId =
  | 'benchmark'
  | 'dataset'
  | 'model'
  | 'streaming'
  | 'router'
  | 'research_security';

interface AsrResearchLabModalProps {
  isOpen: boolean;
  onClose: () => void;
  studioPcm: Float32Array | null;
  studioSampleRate: number;
  referenceTranscript: string;
  modelManager?: LocalModelLifecycleManager;
}

export const AsrResearchLabModal: React.FC<AsrResearchLabModalProps> = ({
  isOpen,
  onClose,
  studioPcm,
  studioSampleRate,
  referenceTranscript,
  modelManager,
}) => {
  const [activeTab, setActiveTab] = useState<LabTabId>('benchmark');

  // ── Tab 1: Phase 1–3 Multi-Engine Benchmark & Error Taxonomy ──────────────
  const [selectedEngines, setSelectedEngines] = useState<AsrLabEngineId[]>([
    'avapardaz-local-ctc-dsp',
    'gemini-audio-asr',
    'elevenlabs-scribe-v3',
    'qwen3-asr-1.7b-worker',
  ]);
  const [normMode, setNormMode] = useState<'fa_strict_v1' | 'fa_relaxed_v1'>('fa_strict_v1');
  const [isRunningExp, setIsRunningExp] = useState(false);
  const [expResult, setExpResult] = useState<AsrLabExperimentRecord | null>(null);
  const benchmarkAbortRef = useRef<AbortController | null>(null);

  // ── Tab 3: Phase 4 Independent Model RC1 ──────────────────────────────────
  const [domainProfile, setDomainProfile] = useState<DomainProfileName>('technology');
  const [phase4RawInput, setPhase4RawInput] = useState(
    'امروز تایپ اسکریپت و بک اند پروژه آوا پرداز را با فست کانفورمر تست می کنیم'
  );
  const [phase4Output, setPhase4Output] = useState(() =>
    runIndependentAsrTranscription({
      sampleId: INITIAL_VERIFIED_STUDIO_CORPUS[0].sample_id,
      domainProfile: 'technology',
      enableNormalization: true,
      enableDomainAdaptation: true,
    })
  );
  const [checkpointTick, setCheckpointTick] = useState(0);

  // ── Tab 4: Phase 5 Real-Time Streaming ────────────────────────────────────
  const [selectedStreamBackend, setSelectedStreamBackend] = useState<StreamingBackendId>(
    'AVAPARDAZ_LOCAL_CTC_STREAMING'
  );
  const [streamSimState, setStreamSimState] = useState<{
    sessionId: string;
    modeDisclosure: string;
    framesSent: number;
    totalBytes: number;
    vadSpeechCount: number;
    partials: string[];
    finalTexts: string[];
    ttfpP95Ms: number;
    backpressure: string;
  } | null>(null);
  const [workletStatus, setWorkletStatus] = useState<'IDLE' | 'SUPPORTED' | 'UNAVAILABLE'>(() =>
    typeof window !== 'undefined' && 'AudioWorkletNode' in window ? 'SUPPORTED' : 'UNAVAILABLE'
  );

  // ── Tab 5: Phase 6 Adaptive Router ────────────────────────────────────────
  const [routerStrategy, setRouterStrategy] = useState<RoutingStrategyName>('balanced');
  const [routerPrivacy, setRouterPrivacy] = useState<PrivacyRoutingPolicy>('local_only');
  const [routerDecision, setRouterDecision] = useState(() =>
    makeAdaptiveRoutingDecision({
      request: {
        request_id: 'init-studio-route',
        tenant_id: 'tenant-avapardaz-lab',
        input: {
          audio_sha256: INITIAL_VERIFIED_STUDIO_CORPUS[0].audio_hash,
          duration_ms: 11200,
          sample_rate: 16000,
          channels: 1,
          format: 'wav',
          estimated_snr_db: 26,
          code_switch_probability: 0.42,
        },
        task: {
          mode: 'batch',
          language: 'auto',
          domain: 'technology',
          diarization: true,
          timestamps: true,
        },
        routing: {
          strategy: 'balanced',
          privacy: 'local_only',
          allow_external: false,
          allow_cascade: true,
          max_engines: 2,
        },
        constraints: {
          max_latency_ms: 3000,
          max_cost: 0.05,
          currency: 'USD',
          min_quality_level: 'MEDIUM',
        },
      },
    })
  );

  // ── Tab 6: Phases 7–9 Research, Security & Continuous Learning ────────────
  const [securityReport, setSecurityReport] = useState(() =>
    runAdversarialSecurityAndReadinessAudit()
  );
  const [fbText, setFbText] = useState(
    'امروز Backend سیستم را با TypeScript و FastConformer بهینه‌سازی می‌کنیم'
  );
  const [trainingConsent, setTrainingConsent] = useState(false);
  const [fbResultMsg, setFbResultMsg] = useState<string | null>(null);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
  const [canaryState, setCanaryState] = useState(() => ({
    ...GLOBAL_CONTINUOUS_LEARNING_HUB.canaryState,
  }));

  useEffect(() => {
    if (!isOpen) {
      benchmarkAbortRef.current?.abort();
      benchmarkAbortRef.current = null;
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      benchmarkAbortRef.current?.abort();
      benchmarkAbortRef.current = null;
    };
  }, [isOpen, onClose]);

  // Derived analytics
  const datasetAudit = useMemo(() => {
    const seen = new Set<string>();
    const qcRows = INITIAL_VERIFIED_STUDIO_CORPUS.map((sample) => {
      const res = evaluateSampleQuality11Gates(sample, seen);
      seen.add(sample.audio_hash);
      return { sample, qc: res };
    });
    const splits = assignZeroLeakageDatasetSplits(INITIAL_VERIFIED_STUDIO_CORPUS);
    return { qcRows, splits };
  }, []);

  const phase4Comparison = useMemo(() => runPhase4BaselineVsFineTunedEvaluation(), [checkpointTick]);
  const routerRegret = useMemo(() => runOfflineCounterfactualRegretEvaluation(), []);
  const truthSummary = useMemo(() => buildArchitectureTruthSummary(), []);

  const fromScratchReport = useMemo(
    () =>
      evaluateFromScratchGoNoGoDecision({
        verifiedLabeledHoursTotal: 0.0143,
        verifiedPersianHours: 0.0143,
        verifiedEnglishHours: 0,
        verifiedNaturalMixedHours: 0.006,
        verifiedConversationalHours: 0.0143,
        verifiedReadSpeechHours: 0,
        unlabeledApprovedHours: 0,
        distinctSpeakerCount: 4,
        distinctMixedLanguageSpeakerCount: 2,
        allLicensesVerifiedForTraining: true,
        speakerDisjointHoldoutAvailable: true,
        availableGpuCount: 0,
        availableGpuVramGbPerDevice: 0,
        approvedTrainingBudgetUsd: 0,
      }),
    []
  );

  const archPrototypes = useMemo(() => {
    const ctcS1 = calculateArchitectureParameterBreakdown({
      prototypeId: 'FC-CTC-S1',
      vocabularySize: 2048,
    });
    const rnntS1 = calculateArchitectureParameterBreakdown({
      prototypeId: 'FC-RNNT-S1',
      vocabularySize: 2048,
    });
    const hybridS1 = calculateArchitectureParameterBreakdown({
      prototypeId: 'HYBRID-CTC-RNNT-S1',
      vocabularySize: 2048,
    });
    const lossH01 = computeHybridCtcRnntLoss({
      experimentProfile: 'H01',
      unweightedCtcLoss: 1.84,
      unweightedRnntLoss: 2.12,
    });
    return { ctcS1, rnntS1, hybridS1, lossH01 };
  }, []);

  const championGate = useMemo(
    () =>
      evaluateChampionVsChallengerGate([
        {
          cohortName: 'persian_conversational',
          sampleCount: 120,
          championCerPercent: 4.8,
          challengerCerPercent: 4.1,
          championP95LatencyMs: 220,
          challengerP95LatencyMs: 228,
        },
        {
          cohortName: 'persian_english_mixed',
          sampleCount: 80,
          championCerPercent: 7.5,
          challengerCerPercent: 5.9,
          championP95LatencyMs: 240,
          challengerP95LatencyMs: 245,
        },
      ]),
    []
  );

  const psiLowSampleDemo = useMemo(
    () =>
      computeCohortPsiDrift({
        cohortName: 'noisy_mobile_fa',
        currentSampleCount: 14,
        baselineHistogram: [0.3, 0.4, 0.3],
        currentHistogram: [0.1, 0.2, 0.7],
      }),
    []
  );

  if (!isOpen) return null;

  const handleRunBenchmark = async () => {
    benchmarkAbortRef.current?.abort();
    const controller = new AbortController();
    benchmarkAbortRef.current = controller;
    setIsRunningExp(true);
    setBenchmarkError(null);
    try {
      const pcm = studioPcm && studioPcm.length > 0 ? studioPcm : new Float32Array(16000);
      const audioReport = validateAndPreprocessAudioForLab({
        fileName: 'studio_active_track.wav',
        channelsPcm: [pcm],
        sampleRate: studioSampleRate || 48000,
      });
      // Strictly isolate referenceTranscriptRaw inside the evaluator — NEVER pass reference text into EngineAdapterConfig.
      const res = await runAsrLabExperiment({
        audio: audioReport,
        referenceTranscriptRaw:
          referenceTranscript.trim() || INITIAL_VERIFIED_STUDIO_CORPUS[0].transcript_raw,
        selectedEngineIds: selectedEngines,
        config: {
          expectedLanguage: 'fa-en-mixed',
          mode: 'batch',
          timeoutMs: 15000,
          isFrozenTestSample: true,
        },
        localAdapterOptions: {
          modelManager,
        },
        signal: controller.signal,
      });
      setExpResult(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBenchmarkError(`خطا در اجرای بنچمارک ASR: ${msg}`);
    } finally {
      if (benchmarkAbortRef.current === controller) {
        benchmarkAbortRef.current = null;
      }
      setIsRunningExp(false);
    }
  };

  const handleCancelBenchmark = () => {
    benchmarkAbortRef.current?.abort();
  };

  const handleDownloadBenchmarkJson = () => {
    if (!expResult) return;
    const blob = new Blob([JSON.stringify(expResult, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${expResult.experimentId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const handleRunPhase4Inference = () => {
    const out = runIndependentAsrTranscription({
      sampleId: INITIAL_VERIFIED_STUDIO_CORPUS[0].sample_id,
      domainProfile,
      enableNormalization: true,
      enableDomainAdaptation: true,
      rawHypothesisOverride: phase4RawInput,
    });
    setPhase4Output(out);
  };

  const handleAdvanceOrRollbackCheckpoint = (action: 'save' | 'rollback') => {
    const list = GLOBAL_PHASE4_CHECKPOINT_MANAGER.listCheckpoints();
    if (action === 'rollback' && list.length > 0) {
      GLOBAL_PHASE4_CHECKPOINT_MANAGER.rollbackToCheckpoint(list[0].checkpointId);
    } else {
      const curr = GLOBAL_PHASE4_CHECKPOINT_MANAGER.getActiveCheckpoint();
      GLOBAL_PHASE4_CHECKPOINT_MANAGER.resumeTrainingFromCheckpoint({
        fromCheckpointId: curr.checkpointId,
        additionalSteps: 50,
      });
    }
    setCheckpointTick((v) => v + 1);
    handleRunPhase4Inference();
  };

  const handleRunStreamBurstSimulation = () => {
    const gateway = new StreamingSessionGatewayManager(8, 4);
    const created = gateway.createSession({
      backend_id: selectedStreamBackend,
      language: 'auto',
      domain_profile: domainProfile,
      user_id: 'studio-live-operator',
      tenant_id: 'tenant-avapardaz-lab',
    });
    if (!created.accepted || !created.session || !created.response) return;

    const sess: ActiveStreamingSession = created.session;
    sess.authenticateWebSocketHandshake({
      token: created.response.single_use_session_token,
      protocolVersion: 'asr-stream-v1',
      origin: 'http://localhost:3000',
    });

    // Feed active studio or synthesized speech via Stateful Resampler -> Packetizer -> ASR1 frames
    const inputRate = studioSampleRate || 48000;
    const resampler = new StatefulStreamingResampler16k(inputRate);
    const packetizer = new StreamingAudioPacketizer16k(5);
    const source =
      studioPcm && studioPcm.length >= 16000
        ? studioPcm.subarray(0, Math.min(studioPcm.length, inputRate * 2))
        : new Float32Array(inputRate).map((_, idx) => 0.18 * Math.sin((2 * Math.PI * 220 * idx) / inputRate));

    const chunkSize = Math.floor(inputRate * 0.25);
    let totalBytes = 0;
    const partials: string[] = [];
    for (let i = 0; i < source.length; i += chunkSize) {
      const slice = source.subarray(i, Math.min(source.length, i + chunkSize));
      const samples16k = resampler.processChunk(slice);
      const frames = packetizer.pushSamples16k(samples16k);
      for (const fr of frames) {
        totalBytes += fr.binaryFrame.byteLength;
        const ingestRes = sess.ingestBinaryAudioPacket({
          rawBinaryFrame: fr.binaryFrame,
          explicitVadProbability: 0.85,
        });
        for (const ev of ingestRes.emittedEvents) {
          if (ev.event_type === 'transcript.partial' && typeof ev.payload.text_raw === 'string') {
            partials.push(ev.payload.text_raw);
          }
        }
      }
    }
    const endRes = sess.finalizeSession();
    for (const ev of endRes.emittedEvents) {
      if (ev.event_type === 'transcript.partial' && typeof ev.payload.text_raw === 'string') {
        partials.push(ev.payload.text_raw);
      }
    }
    const finals = Array.from(sess.utterances.values())
      .map((u) => u.domain_adapted_text || u.normalized_text || u.raw_text)
      .filter((t): t is string => Boolean(t));
    const pct = sess.getPercentileSummary();

    setStreamSimState({
      sessionId: sess.metadata.session_id,
      modeDisclosure: sess.metadata.ui_mode_disclosure,
      framesSent: sess.metrics.frame_count,
      totalBytes,
      vadSpeechCount: sess.metrics.vad_speech_count,
      partials: partials.slice(-4),
      finalTexts: finals.length > 0 ? finals : ['[انتظار پایان بازه گفتار یا تکمیل بافر VAD]'],
      ttfpP95Ms: pct.ttfp.p95,
      backpressure: sess.metrics.backpressure_level,
    });
    if (typeof window !== 'undefined' && 'AudioWorkletNode' in window) {
      setWorkletStatus('SUPPORTED');
    }
  };

  const handleEvaluateRouter = (nextStrategy: RoutingStrategyName, nextPrivacy: PrivacyRoutingPolicy) => {
    setRouterStrategy(nextStrategy);
    setRouterPrivacy(nextPrivacy);
    const dec = makeAdaptiveRoutingDecision({
      request: {
        request_id: `route-${Date.now()}`,
        tenant_id: 'tenant-avapardaz-lab',
        input: {
          audio_sha256: INITIAL_VERIFIED_STUDIO_CORPUS[0].audio_hash,
          duration_ms: 11200,
          sample_rate: 16000,
          channels: 1,
          format: 'wav',
          estimated_snr_db: 26,
          code_switch_probability: 0.42,
        },
        task: {
          mode: 'batch',
          language: 'auto',
          domain: domainProfile,
          diarization: true,
          timestamps: true,
        },
        routing: {
          strategy: nextStrategy,
          privacy: nextPrivacy,
          allow_external: nextPrivacy !== 'local_only',
          allow_cascade: true,
          max_engines: 2,
        },
        constraints: {
          max_latency_ms: 3000,
          max_cost: 0.05,
          currency: 'USD',
          min_quality_level: 'MEDIUM',
        },
      },
    });
    setRouterDecision(dec);
  };

  const handleSubmitFeedback = (e: React.FormEvent) => {
    e.preventDefault();
    const res = GLOBAL_CONTINUOUS_LEARNING_HUB.submitFeedback({
      tenantId: 'tenant-avapardaz-lab',
      userId: 'studio-operator',
      requestId: `req-${Date.now()}`,
      utteranceId: 'utt-studio-01',
      audioSha256: INITIAL_VERIFIED_STUDIO_CORPUS[0].audio_hash,
      speakerId: 'SPK_FA_001',
      cohortName: 'persian_english_mixed',
      feedbackType: 'USER_CORRECTION',
      asrHypothesisRaw: 'امروز بک اند سیستم را با تایپ اسکریپت تست می کنیم',
      userCorrectionText: fbText,
      trainingConsent,
      audioRetentionConsent: true,
    });
    setFbResultMsg(
      res.record.eligibilityState === 'TRAINING_APPROVED'
        ? `بازخورد ثبت و برای صف یادگیری فعال تأیید شد (${res.record.eligibilityState} · خطای غالب: ${res.taxonomyTag}).`
        : `بازخورد ذخیره شد اما طبق دروازه رضایت‌نامه برای آموزش مسدود گردید (${res.record.eligibilityState}).`
    );
  };

  const activeStreamingSpec =
    PHASE5_STREAMING_BACKEND_REGISTRY.find((b) => b.backendId === selectedStreamBackend) ??
    PHASE5_STREAMING_BACKEND_REGISTRY[3];
  const qwenOverhead = calculateQwenCumulativeAudioOverhead({
    utteranceDurationSec: 30,
    chunkDurationSec: 2.0,
  });

  const activeCkpt = GLOBAL_PHASE4_CHECKPOINT_MANAGER.getActiveCheckpoint();

  const localEvalNorm = expResult?.engineResults.find(
    (r) =>
      r.engineId === 'avapardaz-local-ctc-dsp' &&
      r.status === 'SUCCESS' &&
      r.eligibleForAccuracyLeaderboard &&
      r.evaluation !== null &&
      r.rawOutputText.trim().length > 0,
  );
  const localNormReport =
    localEvalNorm && expResult
      ? evaluateWithNormalizationVersion(
          expResult.referenceTranscriptRaw,
          localEvalNorm.rawOutputText,
          normMode
        )
      : null;
  const localTaxonomy =
    localEvalNorm && expResult
      ? classifyTranscriptErrorsIntoTaxonomy({
          experimentId: expResult.experimentId,
          runId: 'lab-run',
          sampleId: 'studio-track',
          engineId: localEvalNorm.engineId,
          referenceRaw: expResult.referenceTranscriptRaw,
          hypothesisRaw: localEvalNorm.rawOutputText,
        })
      : [];
  const pairedStats =
    localEvalNorm && expResult && localNormReport
      ? runPairedBootstrapAndHolmBonferroni({
          comparisons: [
            {
              engineAId: 'avapardaz-local-ctc-dsp',
              engineBId: 'raw-unnormalized-baseline',
              metricName: 'cer',
              pairedSampleScoresA: [localNormReport.cer],
              pairedSampleScoresB: [0.18],
            },
          ],
          iterations: 1000,
        })
      : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="آزمایشگاه تحقیق و توسعه ASR فارسی-انگلیسی"
      className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5"
      dir="rtl"
    >
      <div className="w-full max-w-6xl max-h-[92vh] bg-[#0E131D] border border-[#252F42] rounded-xl shadow-2xl flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <header className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-[#252F42] bg-[#0B0F17]">
          <div className="flex items-center gap-3">
            <FlaskConical className="w-5 h-5 text-amber-400 shrink-0" aria-hidden="true" />
            <div>
              <h2 className="text-sm sm:text-base font-bold text-slate-100">
                آزمایشگاه مستقل پژوهش، استریم و مسیریابی ASR (فاز ۱ تا ۹)
              </h2>
              <p className="text-xs text-slate-400">
                وضعیت صادقانه محیط: <span className="text-amber-300 font-mono">G0_CPU_ONLY</span> · وضعیت انتشار:{' '}
                <span className="text-sky-300 font-mono">{truthSummary.overallReleaseStatus}</span> (ابزارهای محلی فعال؛ ورکر GPU و کلیدهای ابری در انتظار پیکربندی)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن آزمایشگاه ASR"
            className="p-2 rounded-md border border-[#252F42] bg-[#141B27] text-slate-300 hover:text-white hover:bg-[#1E2738] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Sub-navigation Tabs */}
        <nav
          aria-label="بخش‌های آزمایشگاه ASR"
          className="flex flex-wrap items-center gap-1.5 px-5 py-2.5 border-b border-[#252F42] bg-[#111827]"
        >
          {(
            [
              { id: 'benchmark', label: 'بنچمارک و رده‌بندی خطا (فاز ۱–۳)', icon: Activity },
              { id: 'dataset', label: 'ممیزی دیتاست ۱۱گانه (فاز ۲)', icon: Database },
              { id: 'model', label: 'مدل مستقل RC1 (فاز ۴)', icon: Cpu },
              { id: 'streaming', label: 'استریم زنده ASR1 و VAD (فاز ۵)', icon: Radio },
              { id: 'router', label: 'مسیریاب تطبیقی ۱۸ دروازه‌ای (فاز ۶)', icon: GitBranch },
              { id: 'research_security', label: 'پژوهش، امنیت و یادگیری مستمر (فاز ۷–۹)', icon: ShieldCheck },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`lab-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                  active
                    ? 'bg-amber-400 text-slate-950 font-semibold'
                    : 'bg-[#172030] text-slate-300 hover:bg-[#1F2A3E] border border-[#252F42]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Main Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {benchmarkError && (
            <div className="p-3 rounded-lg border border-rose-500/40 bg-rose-500/10 text-xs text-rose-200">
              {benchmarkError}
            </div>
          )}
          {/* TAB 1: BENCHMARK & ERROR TAXONOMY */}
          {activeTab === 'benchmark' && (
            <section className="space-y-4">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      اجرای هم‌زمان موتورهای ASR روی صدای ۱۶kHz مونو استودیو
                    </h3>
                    <p className="text-xs text-slate-400">
                      هر موتور بدون کلید API یا ورکر GPU با خطای صریح و هزینه صفر (`NOT_BILLED_FAILED_RUN`) ثبت می‌شود.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-300 flex items-center gap-1.5">
                      <span>نرمال‌سازی:</span>
                      <select
                        aria-label="نسخه نرمال‌سازی"
                        value={normMode}
                        onChange={(e) => setNormMode(e.target.value as 'fa_strict_v1' | 'fa_relaxed_v1')}
                        className="bg-[#0B0F17] border border-[#252F42] rounded px-2 py-1 text-xs text-slate-100"
                      >
                        <option value="fa_strict_v1">FA-STRICT-V1 (حساس به نیم‌فاصله)</option>
                        <option value="fa_relaxed_v1">FA-RELAXED-V1</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      data-testid="btn-run-benchmark"
                      onClick={handleRunBenchmark}
                      disabled={isRunningExp}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-semibold bg-amber-400 text-slate-950 hover:bg-amber-300 disabled:opacity-50 cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{isRunningExp ? 'در حال اجرا...' : 'اجرای آزمایش بنچمارک'}</span>
                    </button>
                    {isRunningExp && (
                      <button
                        type="button"
                        data-testid="btn-cancel-benchmark"
                        onClick={handleCancelBenchmark}
                        className="inline-flex items-center gap-1 px-3 py-2 rounded-md text-xs border border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 cursor-pointer"
                      >
                        <span>لغو</span>
                      </button>
                    )}
                    {expResult && (
                      <button
                        type="button"
                        onClick={handleDownloadBenchmarkJson}
                        className="inline-flex items-center gap-1 px-3 py-2 rounded-md text-xs border border-[#252F42] bg-[#0B0F17] text-slate-200 hover:bg-[#1E2738] cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>خروجی JSON</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {PHASE1_ENGINE_REGISTRY.map((eng) => {
                    const checked = selectedEngines.includes(eng.engineId);
                    return (
                      <label
                        key={eng.engineId}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[#252F42] bg-[#0B0F17] text-xs cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setSelectedEngines((prev) =>
                              e.target.checked
                                ? [...prev, eng.engineId]
                                : prev.filter((id) => id !== eng.engineId)
                            )
                          }
                        />
                        <span className="text-slate-200">{eng.displayName}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {expResult && (
                <div className="space-y-4">
                  <div className="overflow-x-auto rounded-lg border border-[#252F42]">
                    <table className="w-full text-right text-xs" data-testid="benchmark-results-table">
                      <thead className="bg-[#111827] text-slate-300 border-b border-[#252F42]">
                        <tr>
                          <th className="p-2.5">موتور / هویت مدل</th>
                          <th className="p-2.5">وضعیت اجرا</th>
                          <th className="p-2.5">منشأ فرضیه</th>
                          <th className="p-2.5">CER نرمال</th>
                          <th className="p-2.5">WER نرمال</th>
                          <th className="p-2.5">RTF / زمان (ms)</th>
                          <th className="p-2.5">برچسب هزینه</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#252F42] bg-[#0B0F17]">
                        {expResult.engineResults.map((res) => (
                          <tr key={res.engineId} data-testid={`benchmark-row-${res.engineId}`}>
                            <td className="p-2.5">
                              <div className="font-medium text-slate-100">{res.engineName}</div>
                              {res.modelIdentity.modelId && (
                                <div className="text-[10px] font-mono text-slate-400">
                                  {res.modelIdentity.modelId}@{res.modelIdentity.modelVersion ?? 'unknown'}
                                  {res.modelIdentity.architecture ? ` · ${res.modelIdentity.architecture}` : ''}
                                  {res.modelIdentity.modelSha256
                                    ? ` · sha256:${res.modelIdentity.modelSha256.slice(0, 12)}`
                                    : ''}
                                </div>
                              )}
                              {res.errorMessage && (
                                <div className="text-[11px] text-amber-300/90 mt-0.5">
                                  {res.errorMessage}
                                </div>
                              )}
                            </td>
                            <td className="p-2.5 font-mono">
                              <span
                                data-testid={`benchmark-status-${res.engineId}`}
                                className={
                                  res.status === 'SUCCESS'
                                    ? 'text-emerald-400'
                                    : res.status === 'MODEL_NOT_INSTALLED' || res.status === 'MODEL_NOT_READY'
                                      ? 'text-rose-300'
                                      : 'text-amber-300'
                                }
                              >
                                {res.status}
                              </span>
                            </td>
                            <td className="p-2.5 font-mono text-[11px] text-slate-300">
                              <span data-testid={`benchmark-provenance-${res.engineId}`}>
                                {res.hypothesisProvenance}
                              </span>
                            </td>
                            <td className="p-2.5 font-mono" data-testid={`benchmark-cer-${res.engineId}`}>
                              {res.evaluation ? `${res.evaluation.normalizedMetrics.cerPercent}%` : '—'}
                            </td>
                            <td className="p-2.5 font-mono" data-testid={`benchmark-wer-${res.engineId}`}>
                              {res.evaluation ? `${res.evaluation.normalizedMetrics.werPercent}%` : '—'}
                            </td>
                            <td className="p-2.5 font-mono">
                              {res.rtf} ({res.processingTimeMs}ms)
                            </td>
                            <td className="p-2.5 text-slate-300">
                              ${res.costUsd.toFixed(5)} · <span className="font-mono text-[11px]">{res.costLabel}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Honest local ASR status & raw vs normalized transcript disclosure */}
                  {expResult.engineResults
                    .filter((r) => r.engineId === 'avapardaz-local-ctc-dsp')
                    .map((localRes) =>
                      localRes.status === 'MODEL_NOT_INSTALLED' || localRes.status === 'MODEL_NOT_READY' ? (
                        <div
                          key={localRes.engineId}
                          data-testid="lab-local-model-unavailable-notice"
                          className="p-3.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-200 space-y-1"
                        >
                          <div className="font-semibold">
                            موتور محلی آماده استنتاج مستقل نیست ({localRes.status}) — هیچ نتیجه CER/WER ساختگی محاسبه نشد.
                          </div>
                          <div className="text-amber-200/80">
                            {localRes.errorMessage ?? 'برای اجرای بنچمارک واقعی، ابتدا مدل ONNX تأییدشده را از بخش مدیریت مدل نصب و بارگذاری کنید.'}
                          </div>
                        </div>
                      ) : localRes.status === 'SUCCESS' ? (
                        <div
                          key={localRes.engineId}
                          className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs"
                        >
                          <div className="p-3 rounded-lg border border-[#252F42] bg-[#0B0F17] space-y-1">
                            <div className="text-slate-400">خروجی خام مدل محلی (`rawOutputText`)</div>
                            <div className="text-slate-100">{localRes.rawOutputText}</div>
                          </div>
                          <div className="p-3 rounded-lg border border-[#252F42] bg-[#0B0F17] space-y-1">
                            <div className="text-amber-300">خروجی نرمال‌شده (`normalizedOutputText`)</div>
                            <div className="text-slate-100">{localRes.normalizedOutputText}</div>
                          </div>
                        </div>
                      ) : null,
                    )}

                  {localNormReport && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="lab-local-accuracy-details">
                      <div className="p-3.5 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2">
                        <h4 className="text-xs font-semibold text-amber-300">
                          تاکسونومی ۳۶گرهی خطا (TAXONOMY-V1.0) و معیارهای {normMode}
                        </h4>
                        <p className="text-xs text-slate-300">
                          CER: <span className="font-mono">{(localNormReport.cer * 100).toFixed(2)}%</span> · WER:{' '}
                          <span className="font-mono">{(localNormReport.wer * 100).toFixed(2)}%</span> · MER:{' '}
                          <span className="font-mono">{(localNormReport.mer * 100).toFixed(2)}%</span>
                        </p>
                        <p className="text-xs text-slate-400">
                          تعداد خطاهای طبقه‌بندی‌شده: {localTaxonomy.length} مورد (
                          {localTaxonomy.slice(0, 3).map((t) => t.error_category).join('، ') || 'بدون خطای ساختاری'}
                          )
                        </p>
                      </div>
                      <div className="p-3.5 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2">
                        <h4 className="text-xs font-semibold text-sky-300">
                          آزمون آماری Paired Bootstrap + Holm-Bonferroni
                        </h4>
                        {pairedStats.map((st) => (
                          <div key={st.engine_a_id} className="text-xs text-slate-300 space-y-1">
                            <div>
                              تفاوت میانگین CER:{' '}
                              <span className="font-mono">{(st.mean_difference_a_minus_b * 100).toFixed(2)}pp</span>
                            </div>
                            <div className="text-amber-300">
                              وضعیت کفایت آماری:{' '}
                              <span className="font-mono">
                                {st.sample_coverage_adequate ? 'ADEQUATE' : 'INSUFFICIENT_SAMPLE_COUNT'}
                              </span>{' '}
                              ({st.sample_count} نمونه)
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* TAB 2: DATASET 11-GATE QC & ZERO-LEAKAGE SPLITS */}
          {activeTab === 'dataset' && (
            <section className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-[11px] text-slate-400">کل نمونه‌های ممیزی‌شده</div>
                  <div className="text-lg font-bold font-mono text-slate-100">
                    {datasetAudit.qcRows.length}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-[11px] text-slate-400">نشت گوینده بین Train/Test</div>
                  <div className="text-lg font-bold font-mono text-emerald-400">
                    {datasetAudit.splits.speakerLeakageCount}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-[11px] text-slate-400">گویندگان Train / Val / Test</div>
                  <div className="text-sm font-bold font-mono text-amber-300">
                    {datasetAudit.splits.trainSpeakers.length} / {datasetAudit.splits.validationSpeakers.length} /{' '}
                    {datasetAudit.splits.testSpeakers.length}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27]">
                  <div className="text-[11px] text-slate-400">هش مانیفست قفل‌شده Test</div>
                  <div className="text-xs font-mono text-sky-300 truncate">
                    {datasetAudit.splits.frozenTestManifestSha256}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-[#252F42]">
                <table className="w-full text-right text-xs">
                  <thead className="bg-[#111827] text-slate-300 border-b border-[#252F42]">
                    <tr>
                      <th className="p-2.5">شناسه نمونه</th>
                      <th className="p-2.5">گوینده</th>
                      <th className="p-2.5">زبان / محیط</th>
                      <th className="p-2.5">امتیاز ۱۱ دروازه</th>
                      <th className="p-2.5">لایه مجوز / رضایت</th>
                      <th className="p-2.5">Split بدون نشت</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#252F42] bg-[#0B0F17]">
                    {datasetAudit.qcRows.map(({ sample, qc }) => {
                      const assigned =
                        datasetAudit.splits.splitSamples.find((s) => s.sample_id === sample.sample_id)
                          ?.assigned_split ?? sample.assigned_split;
                      return (
                        <tr key={sample.sample_id}>
                          <td className="p-2.5 font-mono text-amber-300">{sample.sample_id}</td>
                          <td className="p-2.5 font-mono">{sample.speaker_id}</td>
                          <td className="p-2.5">
                            {sample.language} · {sample.recording_environment}
                          </td>
                          <td className="p-2.5 font-mono text-emerald-400">
                            {qc.qcScore}/100 ({qc.qualityStatus})
                          </td>
                          <td className="p-2.5 text-slate-300">{sample.consent_status}</td>
                          <td className="p-2.5 font-mono text-sky-300">{assigned}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* TAB 3: PHASE 4 INDEPENDENT MODEL RC1 */}
          {activeTab === 'model' && (
            <section className="space-y-4">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      معماری ۳ لایه مستقل و مدیریت چک‌پوینت ({activeCkpt.modelVersion})
                    </h3>
                    <p className="text-xs text-slate-400">
                      چک‌پوینت فعال: <span className="font-mono text-amber-300">{activeCkpt.checkpointId}</span> ·
                      Step: <span className="font-mono">{activeCkpt.globalStep}</span> · Val CER:{' '}
                      <span className="font-mono">{activeCkpt.validationCerPercent}%</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="btn-advance-checkpoint"
                      onClick={() => handleAdvanceOrRollbackCheckpoint('save')}
                      className="px-3 py-1.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs hover:bg-emerald-500/30 cursor-pointer"
                    >
                      ذخیره چک‌پوینت (+50 Step)
                    </button>
                    <button
                      type="button"
                      data-testid="btn-rollback-checkpoint"
                      onClick={() => handleAdvanceOrRollbackCheckpoint('rollback')}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-xs hover:bg-rose-500/25 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>بازگشت (Rollback)</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div className="md:col-span-2">
                    <label className="block text-xs text-slate-300 mb-1">
                      خروجی خام تست ۳ لایه (Raw Model Input برای مشاهده جداسازی لایه ۱ تا ۳):
                    </label>
                    <input
                      type="text"
                      value={phase4RawInput}
                      onChange={(e) => setPhase4RawInput(e.target.value)}
                      className="w-full px-3 py-2 rounded border border-[#252F42] bg-[#0B0F17] text-xs text-slate-100"
                    />
                  </div>
                  <div className="flex gap-2">
                    <select
                      aria-label="پروفیل دامنه تخصصی"
                      value={domainProfile}
                      onChange={(e) => setDomainProfile(e.target.value as DomainProfileName)}
                      className="flex-1 px-2.5 py-2 rounded border border-[#252F42] bg-[#0B0F17] text-xs text-slate-100"
                    >
                      <option value="technology">دامنه فناوری</option>
                      <option value="general">عمومی</option>
                      <option value="business">کسب‌وکار</option>
                      <option value="medical">پزشکی</option>
                      <option value="legal">حقوقی</option>
                    </select>
                    <button
                      type="button"
                      data-testid="btn-run-phase4-infer"
                      onClick={handleRunPhase4Inference}
                      className="px-3 py-2 rounded bg-amber-400 text-slate-950 font-semibold text-xs hover:bg-amber-300 cursor-pointer"
                    >
                      تبدیل ۳ لایه
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded border border-[#252F42] bg-[#0B0F17]">
                    <div className="text-slate-400 mb-1">لایه ۱: `raw_model_output`</div>
                    <div className="text-slate-200">{phase4Output.raw_model_output}</div>
                  </div>
                  <div className="p-3 rounded border border-[#252F42] bg-[#0B0F17]">
                    <div className="text-amber-300 mb-1">لایه ۲: `normalized_text`</div>
                    <div className="text-slate-100">{phase4Output.normalized_text}</div>
                  </div>
                  <div className="p-3 rounded border border-emerald-500/30 bg-[#0B0F17]">
                    <div className="text-emerald-400 mb-1">لایه ۳: `domain_adapted_text`</div>
                    <div className="text-slate-100">{phase4Output.domain_adapted_text}</div>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-[#252F42]">
                <table className="w-full text-right text-xs">
                  <thead className="bg-[#111827] text-slate-300 border-b border-[#252F42]">
                    <tr>
                      <th className="p-2.5">کاندید</th>
                      <th className="p-2.5">مدل / پارامتر</th>
                      <th className="p-2.5">لایسنس ۶لایه</th>
                      <th className="p-2.5">وضعیت در G0_CPU_ONLY</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#252F42] bg-[#0B0F17]">
                    {PHASE4_CANDIDATE_MODEL_REGISTRY.map((m) => (
                      <tr key={m.candidateId}>
                        <td className="p-2.5 font-mono text-amber-300">{m.candidateId}</td>
                        <td className="p-2.5">
                          {m.modelName} ({m.parameterCount})
                        </td>
                        <td className="p-2.5 font-mono text-emerald-400">
                          {m.licenseVerification.weightsLicense} · {m.licenseVerification.verificationStatus}
                        </td>
                        <td className="p-2.5 font-mono text-xs">
                          <span
                            className={
                              m.localExecutionStatusInG0 === 'EXECUTABLE_IN_G0_CPU'
                                ? 'text-emerald-400'
                                : 'text-amber-300'
                            }
                          >
                            {m.localExecutionStatusInG0}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="p-3 rounded-lg border border-[#252F42] bg-[#141B27] text-xs text-slate-300">
                ارزیابی مقایسه Baseline با RC1 روی {phase4Comparison.sampleCount} نمونه: CER فارسی از{' '}
                <span className="font-mono text-slate-200">{phase4Comparison.persianBaselineCerPercent}%</span> به{' '}
                <span className="font-mono text-emerald-400">{phase4Comparison.persianFineTunedCerPercent}%</span> و CER کدسوئیچ از{' '}
                <span className="font-mono text-slate-200">{phase4Comparison.mixedBaselineCerPercent}%</span> به{' '}
                <span className="font-mono text-emerald-400">{phase4Comparison.mixedFineTunedCerPercent}%</span> رسید.
              </div>
            </section>
          )}

          {/* TAB 4: PHASE 5 REAL-TIME STREAMING ASR1 & VAD */}
          {activeTab === 'streaming' && (
            <section className="space-y-4">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      موتور استریم زنده با پروتکل باینری `ASR1` (۲۴ بایت هدر + PCM16 مونو)
                    </h3>
                    <p className="text-xs text-slate-400">
                      وضعیت Web AudioWorklet خارج از ترد اصلی: <span className="font-mono text-emerald-400">{workletStatus}</span> (`/asr-stream-worklet.js`)
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="انتخاب بک‌اند استریم"
                      value={selectedStreamBackend}
                      onChange={(e) => setSelectedStreamBackend(e.target.value as StreamingBackendId)}
                      className="px-2.5 py-2 rounded border border-[#252F42] bg-[#0B0F17] text-xs text-slate-100"
                    >
                      {PHASE5_STREAMING_BACKEND_REGISTRY.map((b) => (
                        <option key={b.backendId} value={b.backendId}>
                          {b.backendId} ({b.localG0Availability})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      data-testid="btn-run-stream-sim"
                      onClick={handleRunStreamBurstSimulation}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded bg-amber-400 text-slate-950 font-semibold text-xs hover:bg-amber-300 cursor-pointer"
                    >
                      <Mic className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>اجرای شبیه‌ساز فریم زنده ۱۰۰ms</span>
                    </button>
                  </div>
                </div>

                {/* Mandatory Transparent Mode Disclosure */}
                <div
                  data-testid="stream-mode-disclosure"
                  className={`p-2.5 rounded border text-xs flex items-center justify-between ${
                    activeStreamingSpec.nativeIncrementalStreamingSupported
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                  }`}
                >
                  <span>
                    افشای صادقانه حالت استریم: <strong>{activeStreamingSpec.uiModeDisclosureLabel}</strong>
                  </span>
                  <span className="font-mono">{activeStreamingSpec.executionMode}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded border border-[#252F42] bg-[#0B0F17]">
                    <div className="text-slate-400">سربار تجمعی Qwen (۳۰s با چانک ۲s)</div>
                    <div className="font-mono text-amber-300 mt-1">
                      {qwenOverhead.totalCumulativeAudioSec}s ({qwenOverhead.overheadMultiplier}x)
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      محدودیت نرم VAD برای مهار سربار: ۱۲.۰ ثانیه
                    </div>
                  </div>
                  <div className="p-3 rounded border border-[#252F42] bg-[#0B0F17]">
                    <div className="text-slate-400">هیسترزیس VAD ۵۱۲ نمونه</div>
                    <div className="font-mono text-sky-300 mt-1">
                      Start ≥ 0.50 · Continue ≥ 0.35 · Endpoint = 600ms
                    </div>
                  </div>
                  <div className="p-3 rounded border border-[#252F42] bg-[#0B0F17]">
                    <div className="text-slate-400">ابعاد پکت باینری ۱۰۰ms</div>
                    <div className="font-mono text-emerald-400 mt-1">24B Header + 3200B PCM16 = 3224B</div>
                  </div>
                </div>

                {streamSimState && (
                  <div className="p-3.5 rounded-lg border border-sky-500/30 bg-[#0B0F17] space-y-2 text-xs">
                    <div className="flex flex-wrap gap-4 font-mono text-sky-300">
                      <span>Session: {streamSimState.sessionId}</span>
                      <span>Frames: {streamSimState.framesSent}</span>
                      <span>Bytes: {streamSimState.totalBytes}</span>
                      <span>VAD Speech Frames: {streamSimState.vadSpeechCount}</span>
                      <span>Backpressure: {streamSimState.backpressure}</span>
                      <span>TTFP P95: {streamSimState.ttfpP95Ms}ms</span>
                    </div>
                    <div className="text-slate-300">
                      <span className="text-amber-300">پیش‌نمایش‌های موقت (Partial Replace):</span>{' '}
                      {streamSimState.partials.join(' | ') || 'بدون بازنگری میانی در حالت Segmented'}
                    </div>
                    <div className="text-emerald-300">
                      <span className="font-semibold">متن نهایی قطعی (Committed Final):</span>{' '}
                      {streamSimState.finalTexts.join(' · ')}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* TAB 5: PHASE 6 ADAPTIVE ROUTER */}
          {activeTab === 'router' && (
            <section className="space-y-4">
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      مسیریاب هوشمند با فیلتر ۱۸ دروازه‌ای و محافظ حریم خصوصی (`disagreement_only: false`)
                    </h3>
                    <p className="text-xs text-slate-400">
                      پیش‌بینی محافظه‌کارانه خطا با `CER_Upper_95` و کنترلر بودجه اتمیک
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="سیاست مسیریابی"
                      value={routerStrategy}
                      onChange={(e) =>
                        handleEvaluateRouter(e.target.value as RoutingStrategyName, routerPrivacy)
                      }
                      className="px-2.5 py-1.5 rounded border border-[#252F42] bg-[#0B0F17] text-xs"
                    >
                      <option value="balanced">Balanced</option>
                      <option value="quality_first">Quality First</option>
                      <option value="low_latency">Low Latency</option>
                      <option value="low_cost">Low Cost</option>
                      <option value="privacy_first">Privacy First</option>
                    </select>
                    <select
                      aria-label="سیاست حریم خصوصی"
                      value={routerPrivacy}
                      onChange={(e) =>
                        handleEvaluateRouter(routerStrategy, e.target.value as PrivacyRoutingPolicy)
                      }
                      className="px-2.5 py-1.5 rounded border border-[#252F42] bg-[#0B0F17] text-xs"
                    >
                      <option value="local_only">Local Only (قطع کامل انتقال ابری)</option>
                      <option value="local_preferred">Local Preferred</option>
                      <option value="external_allowed">External Allowed</option>
                    </select>
                  </div>
                </div>

                <div className="p-3 rounded border border-emerald-500/30 bg-[#0B0F17] text-xs space-y-1">
                  <div>
                    موتور منتخب اولیه:{' '}
                    <span className="font-mono text-emerald-400 font-bold" data-testid="router-selected-primary">
                      {routerDecision.selected_primary ?? 'NONE'}
                    </span>{' '}
                    · حالت اجرا: <span className="font-mono text-amber-300">{routerDecision.operating_mode}</span>
                  </div>
                  <div className="text-slate-300">{routerDecision.decision_reason}</div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-[#252F42]">
                  <table className="w-full text-right text-xs">
                    <thead className="bg-[#111827] text-slate-300 border-b border-[#252F42]">
                      <tr>
                        <th className="p-2">موتور</th>
                        <th className="p-2">وضعیت دروازه ۱۸گانه</th>
                        <th className="p-2">امتیاز Utility</th>
                        <th className="p-2">CER_Upper_95</th>
                        <th className="p-2">دلیل رد (در صورت رد)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#252F42] bg-[#0B0F17]">
                      {routerDecision.candidates.map((cand) => (
                        <tr key={cand.engine_id}>
                          <td className="p-2 font-mono">{cand.engine_id}</td>
                          <td className="p-2 font-mono">
                            <span className={cand.eligible ? 'text-emerald-400' : 'text-rose-400'}>
                              {cand.eligible ? 'ELIGIBLE' : 'REJECTED'}
                            </span>
                          </td>
                          <td className="p-2 font-mono">{cand.eligible ? cand.utility_score.toFixed(4) : '—'}</td>
                          <td className="p-2 font-mono">{cand.predicted_cer_upper_95.toFixed(3)}</td>
                          <td className="p-2 text-[11px] text-slate-400 font-mono">
                            {cand.rejection_reasons.join(', ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="p-3 rounded border border-[#252F42] bg-[#0B0F17] text-xs text-slate-300 flex flex-wrap gap-4">
                  <span>
                    دقت تطابق با Oracle: <strong className="font-mono text-emerald-400">{routerRegret.routingAccuracyPercent}%</strong>
                  </span>
                  <span>
                    میانگین Quality Regret: <strong className="font-mono text-amber-300">{routerRegret.meanQualityRegretCer}</strong>
                  </span>
                  <span>
                    نقض بودجه: <strong className="font-mono text-emerald-400">{routerRegret.budgetViolationRate}%</strong>
                  </span>
                </div>
              </div>
            </section>
          )}

          {/* TAB 6: PHASES 7–9 ARCHITECTURE, SECURITY TRUTH AUDIT & CONTINUOUS LEARNING */}
          {activeTab === 'research_security' && (
            <section className="space-y-4">
              {/* Phase 7 */}
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                    <Layers className="w-4 h-4 text-amber-400" aria-hidden="true" />
                    <span>فاز ۷: دروازه تصمیم آموزش از صفر و پروتوتایپ‌های FastConformer</span>
                  </h3>
                  <span
                    data-testid="from-scratch-verdict"
                    className="font-mono px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40"
                  >
                    {fromScratchReport.assignedDataTier} · {fromScratchReport.trackBProductionFromScratchDecision}
                  </span>
                </div>
                <p className="text-slate-300">{fromScratchReport.permittedGoalsSummary}</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1 font-mono text-[11px]">
                  <div className="p-2.5 rounded border border-[#252F42] bg-[#0B0F17]">
                    FC-CTC-S1: {(archPrototypes.ctcS1.totalParameters / 1e6).toFixed(2)}M Params ·{' '}
                    {archPrototypes.ctcS1.estimatedGflopsPer10SecAudio} GFLOPs/10s
                  </div>
                  <div className="p-2.5 rounded border border-[#252F42] bg-[#0B0F17]">
                    FC-RNNT-S1: {(archPrototypes.rnntS1.totalParameters / 1e6).toFixed(2)}M Params
                  </div>
                  <div className="p-2.5 rounded border border-[#252F42] bg-[#0B0F17]">
                    Hybrid Loss H01 (0.5/0.5): {archPrototypes.lossH01.combinedTotalLoss.toFixed(3)}
                  </div>
                </div>
              </div>

              {/* Phase 8 Truth Audit & Security */}
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                    <span>فاز ۸: ممیزی صداقت معماری و تست امنیتی OWASP ASVS / STRIDE</span>
                  </h3>
                  <button
                    type="button"
                    data-testid="btn-rerun-security-audit"
                    onClick={() => setSecurityReport(runAdversarialSecurityAndReadinessAudit())}
                    className="px-3 py-1.5 rounded bg-[#1D283A] border border-[#252F42] text-slate-200 hover:bg-[#25344B] cursor-pointer"
                  >
                    اجرای مجدد تست نفوذ ورودی
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono">
                  <div className="p-2 rounded bg-[#0B0F17] border border-[#252F42]">
                    تست‌های امنیتی: <span className="text-emerald-400">{securityReport.passedCount}/{securityReport.totalChecks} PASS</span>
                  </div>
                  <div className="p-2 rounded bg-[#0B0F17] border border-[#252F42]">
                    تایید محلی کامل: {truthSummary.countsByStatus.IMPLEMENTED_AND_VERIFIED}
                  </div>
                  <div className="p-2 rounded bg-[#0B0F17] border border-[#252F42]">
                    نیازمند GPU/PG: {truthSummary.countsByStatus.PARTIALLY_IMPLEMENTED}
                  </div>
                  <div className="p-2 rounded bg-[#0B0F17] border border-[#252F42]">
                    وضعیت کل سیستم: <span className="text-amber-300">{truthSummary.overallReleaseStatus}</span>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {PHASE8_SYSTEM_INVENTORY.slice(0, 4).map((inv) => (
                    <div key={inv.componentId} className="p-2 rounded border border-[#252F42] bg-[#0B0F17] flex justify-between gap-2">
                      <span className="text-slate-200">{inv.name}</span>
                      <span className="font-mono text-[11px] text-sky-300 shrink-0">{inv.truthStatus}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Phase 9 Continuous Learning & Canary */}
              <div className="p-4 rounded-lg border border-[#252F42] bg-[#141B27] space-y-3 text-xs">
                <h3 className="text-sm font-semibold text-slate-100">
                  فاز ۹: جمع‌آوری بازخورد با دروازه رضایت‌نامه ۸گانه، Champion/Challenger و Canary
                </h3>
                <form onSubmit={handleSubmitFeedback} className="space-y-2">
                  <div className="flex flex-wrap gap-2 items-center">
                    <input
                      type="text"
                      value={fbText}
                      onChange={(e) => setFbText(e.target.value)}
                      aria-label="متن اصلاحی کاربر"
                      className="flex-1 min-w-[240px] px-3 py-2 rounded border border-[#252F42] bg-[#0B0F17] text-xs text-slate-100"
                    />
                    <label className="inline-flex items-center gap-1.5 text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid="chk-training-consent"
                        checked={trainingConsent}
                        onChange={(e) => setTrainingConsent(e.target.checked)}
                      />
                      <span>رضایت صریح برای استفاده آموزشی (`ALLOW_MODEL_TRAINING`)</span>
                    </label>
                    <button
                      type="submit"
                      data-testid="btn-submit-feedback"
                      className="px-3.5 py-2 rounded bg-amber-400 text-slate-950 font-semibold hover:bg-amber-300 cursor-pointer"
                    >
                      ثبت بازخورد
                    </button>
                  </div>
                  {fbResultMsg && (
                    <div data-testid="feedback-consent-result" className="p-2 rounded bg-[#0B0F17] border border-sky-500/30 text-sky-200">
                      {fbResultMsg}
                    </div>
                  )}
                </form>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <div className="p-2.5 rounded border border-[#252F42] bg-[#0B0F17]">
                    <div className="text-slate-400">دروازه Champion/Challenger</div>
                    <div className="text-emerald-400 font-mono mt-1">
                      {championGate.approvedForCanaryPromotion ? 'APPROVED' : 'REJECTED'} (+
                      {championGate.overallRelativeCerImprovementPercent}% Rel CER)
                    </div>
                  </div>
                  <div className="p-2.5 rounded border border-[#252F42] bg-[#0B0F17]">
                    <div className="text-slate-400">پایش PSI (کوهورت با ۱۴ نمونه)</div>
                    <div className="text-amber-300 font-mono mt-1">
                      {psiLowSampleDemo.status} (جلوگیری از آلارم کاذب &lt; 30 نمونه)
                    </div>
                  </div>
                  <div className="p-2.5 rounded border border-[#252F42] bg-[#0B0F17] flex items-center justify-between gap-2">
                    <div>
                      <div className="text-slate-400">Canary Rollout</div>
                      <div className="font-mono text-sky-300 mt-0.5">
                        {canaryState.mode} · {canaryState.stagePercent}%
                      </div>
                    </div>
                    <button
                      type="button"
                      data-testid="btn-advance-canary"
                      onClick={() =>
                        setCanaryState((s) =>
                          advanceOrRollbackCanaryRollout({
                            state: s,
                            errorRateDeltaPp: 0.1,
                            p95LatencyDeltaPct: 3.0,
                            crashRatePct: 0.0,
                          })
                        )
                      }
                      className="px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 cursor-pointer"
                    >
                      ارتقا
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
