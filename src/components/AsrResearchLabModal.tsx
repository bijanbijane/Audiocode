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
import { AccessibleModal } from './AccessibleModal';
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
import { getNextRovingTabIndex } from '../studio/layoutUtils';

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
  locale?: 'fa' | 'en';
  persianDigits?: boolean;
}

export const AsrResearchLabModal: React.FC<AsrResearchLabModalProps> = ({
  isOpen,
  onClose,
  studioPcm,
  studioSampleRate,
  referenceTranscript,
  modelManager,
  locale = 'fa',
}) => {
  const isFa = locale === 'fa';
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
    return () => {
      benchmarkAbortRef.current?.abort();
      benchmarkAbortRef.current = null;
    };
  }, [isOpen]);

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

  // AccessibleModal handles !isOpen presence cleanly
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
          keyterms: [],
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
      setBenchmarkError(
        isFa ? `خطا در اجرای بنچمارک ASR: ${msg}` : `ASR benchmark failed: ${msg}`,
      );
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
      finalTexts:
        finals.length > 0
          ? finals
          : [
              isFa
                ? '[انتظار پایان بازه گفتار یا تکمیل بافر VAD]'
                : '[Awaiting end of speech or VAD buffer completion]',
            ],
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
        ? isFa
          ? `بازخورد ثبت و برای صف یادگیری فعال تأیید شد (${res.record.eligibilityState} · خطای غالب: ${res.taxonomyTag}).`
          : `Feedback recorded and approved for active learning (${res.record.eligibilityState} · dominant error: ${res.taxonomyTag}).`
        : isFa
          ? `بازخورد ذخیره شد اما طبق دروازه رضایت‌نامه برای آموزش مسدود گردید (${res.record.eligibilityState}).`
          : `Feedback stored, but blocked from training by the consent gate (${res.record.eligibilityState}).`,
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
    <AccessibleModal
      isOpen={isOpen}
      onClose={onClose}
      dir={isFa ? 'rtl' : 'ltr'}
      ariaLabel={isFa ? 'آزمایشگاه تحقیق و توسعه ASR فارسی-انگلیسی' : 'Persian-English ASR Research & Dev Lab'}
      dataTestId="asr-research-lab-modal"
      closeOnBackdropClick
      panelClassName="w-full max-w-6xl"
    >
      <div className="w-full max-h-[92vh] bg-[var(--avp-surface)] border border-[var(--avp-border)] rounded-xl shadow-[var(--avp-shadow-md)] flex flex-col overflow-hidden text-[var(--avp-text)]">
        {/* Header */}
        <header className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-[var(--avp-border)] bg-[var(--avp-surface-shell)]">
          <div className="flex items-center gap-3">
            <FlaskConical className="w-5 h-5 text-[var(--avp-warning-text)] shrink-0" aria-hidden="true" />
            <div>
              <h2 className="text-sm sm:text-base font-bold text-[var(--avp-text)]">
                {isFa
                  ? 'آزمایشگاه مستقل پژوهش، استریم و مسیریابی ASR'
                  : 'Independent ASR Research, Streaming & Routing Lab'}
              </h2>
              <p className="text-xs text-[var(--avp-text-secondary)]">
                {isFa ? 'وضعیت صادقانه محیط:' : 'Honest Environment:'}{' '}
                <span className="text-[var(--avp-warning-text)] font-mono">G0_CPU_ONLY</span> ·{' '}
                {isFa ? 'وضعیت انتشار:' : 'Release Status:'}{' '}
                <span className="text-[var(--avp-accent-text)] font-mono">{truthSummary.overallReleaseStatus}</span>{' '}
                {isFa
                  ? '(ابزارهای محلی فعال؛ ورکر GPU و کلیدهای ابری در انتظار پیکربندی)'
                  : '(Local tools active; GPU worker & cloud API keys awaiting configuration)'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={isFa ? 'بستن آزمایشگاه ASR' : 'Close ASR Research Lab'}
            className="avp-touch-icon sm:w-8 sm:h-8 rounded-lg text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-hover)] inline-flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Sub-navigation Tabs */}
        <div
          role="tablist"
          aria-label={isFa ? 'بخش‌های آزمایشگاه ASR' : 'ASR Lab Sections'}
          className="flex flex-wrap items-center gap-1.5 px-5 py-2.5 border-b border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]"
        >
          {(
            [
              {
                id: 'benchmark',
                label: isFa ? 'بنچمارک و رده‌بندی خطا' : 'Benchmark & Error Taxonomy',
                icon: Activity,
              },
              {
                id: 'dataset',
                label: isFa ? 'ممیزی دیتاست ۱۱گانه' : 'Dataset 11-Gate Audit',
                icon: Database,
              },
              {
                id: 'model',
                label: isFa ? 'مدل مستقل RC1' : 'Independent RC1 Model',
                icon: Cpu,
              },
              {
                id: 'streaming',
                label: isFa ? 'استریم زنده ASR1 و VAD' : 'Live Streaming & VAD',
                icon: Radio,
              },
              {
                id: 'router',
                label: isFa ? 'مسیریاب تطبیقی ۱۸ دروازه‌ای' : '18-Gate Adaptive Router',
                icon: GitBranch,
              },
              {
                id: 'research_security',
                label: isFa ? 'پژوهش، امنیت و یادگیری مستمر' : 'Research, Security & Learning',
                icon: ShieldCheck,
              },
            ] as const
          ).map((tab, idx, arr) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-testid={`lab-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(e) => {
                  const nextIdx = getNextRovingTabIndex(idx, arr.length, e.key, isFa, 'horizontal');
                  if (nextIdx !== null) {
                    e.preventDefault();
                    const nextId = arr[nextIdx].id;
                    setActiveTab(nextId);
                    const el = e.currentTarget
                      .closest('[role="tablist"]')
                      ?.querySelector<HTMLButtonElement>(`[data-testid="lab-tab-${nextId}"]`);
                    el?.focus();
                  }
                }}
                className={`min-h-[44px] sm:min-h-[34px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors cursor-pointer border ${
                  active
                    ? 'bg-[var(--avp-brand)] text-[var(--avp-on-brand)] border-[var(--avp-brand)] font-semibold'
                    : 'bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] border-[var(--avp-border)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Main Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 bg-[var(--avp-bg)]">
          {benchmarkError && (
            <div className="p-3 rounded-lg border border-[var(--avp-danger)]/40 bg-[var(--avp-danger-soft)] text-xs text-[var(--avp-danger-text)]">
              {benchmarkError}
            </div>
          )}
          {/* TAB 1: BENCHMARK & ERROR TAXONOMY */}
          {activeTab === 'benchmark' && (
            <section className="space-y-4">
              <div className="p-4 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--avp-text)]">
                      {isFa
                        ? 'اجرای هم‌زمان موتورهای ASR روی صدای ۱۶kHz مونو استودیو'
                        : 'Concurrent ASR Engine Benchmark on 16kHz Mono Studio Audio'}
                    </h3>
                    <p className="text-xs text-[var(--avp-text-secondary)]">
                      {isFa
                        ? 'هر موتور بدون کلید API یا ورکر GPU با خطای صریح و هزینه صفر (`NOT_BILLED_FAILED_RUN`) ثبت می‌شود.'
                        : 'Engines without API keys or GPU workers fail explicitly with zero cost (`NOT_BILLED_FAILED_RUN`).'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-xs text-[var(--avp-text-secondary)] flex items-center gap-1.5">
                      <span>{isFa ? 'نرمال‌سازی:' : 'Normalization:'}</span>
                      <select
                        aria-label={isFa ? 'نسخه نرمال‌سازی' : 'Normalization Profile'}
                        value={normMode}
                        onChange={(e) => setNormMode(e.target.value as 'fa_strict_v1' | 'fa_relaxed_v1')}
                        className="avp-input h-8 px-2 text-xs"
                      >
                        <option value="fa_strict_v1">
                          {isFa ? 'FA-STRICT-V1 (حساس به نیم‌فاصله)' : 'FA-STRICT-V1 (ZWNJ-Sensitive)'}
                        </option>
                        <option value="fa_relaxed_v1">FA-RELAXED-V1</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      data-testid="btn-run-benchmark"
                      onClick={handleRunBenchmark}
                      disabled={isRunningExp}
                      className="avp-btn avp-btn-primary"
                    >
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        {isRunningExp
                          ? isFa
                            ? 'در حال اجرا...'
                            : 'Running...'
                          : isFa
                            ? 'اجرای آزمایش بنچمارک'
                            : 'Run Benchmark'}
                      </span>
                    </button>
                    {isRunningExp && (
                      <button
                        type="button"
                        data-testid="btn-cancel-benchmark"
                        onClick={handleCancelBenchmark}
                        className="avp-btn avp-btn-danger"
                      >
                        <span>{isFa ? 'لغو' : 'Cancel'}</span>
                      </button>
                    )}
                    {expResult && (
                      <button
                        type="button"
                        onClick={handleDownloadBenchmarkJson}
                        className="avp-btn avp-btn-outline"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{isFa ? 'خروجی JSON' : 'Export JSON'}</span>
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
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)] text-xs cursor-pointer"
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
                          className="accent-[var(--avp-brand)]"
                        />
                        <span className="text-[var(--avp-text)]">{eng.displayName}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {expResult && (
                <div className="space-y-4">
                  <div className="overflow-x-auto rounded-lg border border-[var(--avp-border)]">
                    <table
                      className={`w-full ${isFa ? 'text-right' : 'text-left'} text-xs`}
                      data-testid="benchmark-results-table"
                    >
                      <thead className="bg-[var(--avp-surface-shell)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
                        <tr>
                          <th className="p-2.5">{isFa ? 'موتور / هویت مدل' : 'Engine / Model Identity'}</th>
                          <th className="p-2.5">{isFa ? 'وضعیت اجرا' : 'Status'}</th>
                          <th className="p-2.5">{isFa ? 'منشأ فرضیه' : 'Provenance'}</th>
                          <th className="p-2.5">{isFa ? 'CER نرمال' : 'Norm CER'}</th>
                          <th className="p-2.5">{isFa ? 'WER نرمال' : 'Norm WER'}</th>
                          <th className="p-2.5">{isFa ? 'RTF / زمان (ms)' : 'RTF / Time (ms)'}</th>
                          <th className="p-2.5">{isFa ? 'برچسب هزینه' : 'Cost Label'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--avp-border-subtle)] bg-[var(--avp-surface)]">
                        {expResult.engineResults.map((res) => (
                          <tr key={res.engineId} data-testid={`benchmark-row-${res.engineId}`}>
                            <td className="p-2.5">
                              <div className="font-medium text-[var(--avp-text)]">{res.engineName}</div>
                              {res.modelIdentity.modelId && (
                                <div className="text-[11px] font-mono text-[var(--avp-text-muted)]" dir="ltr">
                                  {res.modelIdentity.modelId}@{res.modelIdentity.modelVersion ?? 'unknown'}
                                  {res.modelIdentity.architecture ? ` · ${res.modelIdentity.architecture}` : ''}
                                  {res.modelIdentity.modelSha256
                                    ? ` · sha256:${res.modelIdentity.modelSha256.slice(0, 12)}`
                                    : ''}
                                </div>
                              )}
                              {res.errorMessage && (
                                <div className="text-[11px] text-[var(--avp-warning-text)] mt-0.5">
                                  {res.errorMessage}
                                </div>
                              )}
                            </td>
                            <td className="p-2.5 font-mono">
                              <span
                                data-testid={`benchmark-status-${res.engineId}`}
                                className={
                                  res.status === 'SUCCESS'
                                    ? 'text-[var(--avp-success-text)]'
                                    : res.status === 'MODEL_NOT_INSTALLED' || res.status === 'MODEL_NOT_READY'
                                      ? 'text-[var(--avp-danger-text)]'
                                      : 'text-[var(--avp-warning-text)]'
                                }
                              >
                                {res.status}
                              </span>
                            </td>
                            <td className="p-2.5 font-mono text-[11px] text-[var(--avp-text-secondary)]">
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
                            <td className="p-2.5 text-[var(--avp-text-secondary)]">
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
                          className="p-3.5 rounded-lg border border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)] text-xs text-[var(--avp-warning-text)] space-y-1"
                        >
                          <div className="font-semibold">
                            {isFa
                              ? `موتور محلی آماده استنتاج مستقل نیست (${localRes.status}) — هیچ نتیجه CER/WER ساختگی محاسبه نشد.`
                              : `Local engine is not ready for standalone inference (${localRes.status}) — no synthetic CER/WER computed.`}
                          </div>
                          <div className="opacity-90">
                            {localRes.errorMessage ??
                              (isFa
                                ? 'برای اجرای بنچمارک واقعی، ابتدا مدل ONNX تأییدشده را از بخش مدیریت مدل نصب و بارگذاری کنید.'
                                : 'Install and load a verified local ONNX model from Model Management to run a real local benchmark.')}
                          </div>
                        </div>
                      ) : localRes.status === 'SUCCESS' ? (
                        <div
                          key={localRes.engineId}
                          className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs"
                        >
                          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-1">
                            <div className="text-[var(--avp-text-secondary)]">
                              {isFa ? 'خروجی خام مدل محلی (`rawOutputText`)' : 'Raw Model Output (`rawOutputText`)'}
                            </div>
                            <div className="text-[var(--avp-text)]" dir="auto">{localRes.rawOutputText}</div>
                          </div>
                          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-1">
                            <div className="text-[var(--avp-warning-text)]">
                              {isFa ? 'خروجی نرمال‌شده (`normalizedOutputText`)' : 'Normalized Output (`normalizedOutputText`)'}
                            </div>
                            <div className="text-[var(--avp-text)]" dir="auto">{localRes.normalizedOutputText}</div>
                          </div>
                        </div>
                      ) : null,
                    )}

                  {localNormReport && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="lab-local-accuracy-details">
                      <div className="p-3.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2">
                        <h4 className="text-xs font-semibold text-[var(--avp-warning-text)]">
                          {isFa
                            ? `تاکسونومی ۳۶گرهی خطا (TAXONOMY-V1.0) و معیارهای ${normMode}`
                            : `36-Node Error Taxonomy (TAXONOMY-V1.0) & ${normMode} Metrics`}
                        </h4>
                        <p className="text-xs text-[var(--avp-text-secondary)]" dir="ltr">
                          CER: <span className="font-mono">{(localNormReport.cer * 100).toFixed(2)}%</span> · WER:{' '}
                          <span className="font-mono">{(localNormReport.wer * 100).toFixed(2)}%</span> · MER:{' '}
                          <span className="font-mono">{(localNormReport.mer * 100).toFixed(2)}%</span>
                        </p>
                        <p className="text-xs text-[var(--avp-text-muted)]">
                          {isFa
                            ? `تعداد خطاهای طبقه‌بندی‌شده: ${localTaxonomy.length} مورد (${localTaxonomy.slice(0, 3).map((t) => t.error_category).join('، ') || 'بدون خطای ساختاری'})`
                            : `Classified errors: ${localTaxonomy.length} (${localTaxonomy.slice(0, 3).map((t) => t.error_category).join(', ') || 'No structural errors'})`}
                        </p>
                      </div>
                      <div className="p-3.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2">
                        <h4 className="text-xs font-semibold text-[var(--avp-accent-text)]">
                          {isFa ? 'آزمون آماری Paired Bootstrap + Holm-Bonferroni' : 'Paired Bootstrap + Holm-Bonferroni Test'}
                        </h4>
                        {pairedStats.map((st) => (
                          <div key={st.engine_a_id} className="text-xs text-[var(--avp-text-secondary)] space-y-1">
                            <div>
                              {isFa ? 'تفاوت میانگین CER:' : 'Mean CER Difference:'}{' '}
                              <span className="font-mono" dir="ltr">{(st.mean_difference_a_minus_b * 100).toFixed(2)}pp</span>
                            </div>
                            <div className="text-[var(--avp-warning-text)]">
                              {isFa ? 'وضعیت کفایت آماری:' : 'Sample Coverage Adequacy:'}{' '}
                              <span className="font-mono">
                                {st.sample_coverage_adequate ? 'ADEQUATE' : 'INSUFFICIENT_SAMPLE_COUNT'}
                              </span>{' '}
                              ({st.sample_count} {isFa ? 'نمونه' : 'samples'})
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
                <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[11px] text-[var(--avp-text-secondary)]">
                    {isFa ? 'کل نمونه‌های ممیزی‌شده' : 'Total Audited Samples'}
                  </div>
                  <div className="text-lg font-bold font-mono text-[var(--avp-text)]">
                    {datasetAudit.qcRows.length}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[11px] text-[var(--avp-text-secondary)]">
                    {isFa ? 'نشت گوینده بین Train/Test' : 'Train/Test Speaker Leakage'}
                  </div>
                  <div className="text-lg font-bold font-mono text-[var(--avp-success-text)]">
                    {datasetAudit.splits.speakerLeakageCount}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[11px] text-[var(--avp-text-secondary)]">
                    {isFa ? 'گویندگان Train / Val / Test' : 'Speakers (Train / Val / Test)'}
                  </div>
                  <div className="text-sm font-bold font-mono text-[var(--avp-warning-text)]">
                    {datasetAudit.splits.trainSpeakers.length} / {datasetAudit.splits.validationSpeakers.length} /{' '}
                    {datasetAudit.splits.testSpeakers.length}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)]">
                  <div className="text-[11px] text-[var(--avp-text-secondary)]">
                    {isFa ? 'هش مانیفست قفل‌شده Test' : 'Frozen Test Manifest SHA-256'}
                  </div>
                  <div className="text-xs font-mono text-[var(--avp-accent-text)] truncate" dir="ltr">
                    {datasetAudit.splits.frozenTestManifestSha256}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-[var(--avp-border)]">
                <table className={`w-full ${isFa ? 'text-right' : 'text-left'} text-xs`}>
                  <thead className="bg-[var(--avp-surface-shell)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
                    <tr>
                      <th className="p-2.5">{isFa ? 'شناسه نمونه' : 'Sample ID'}</th>
                      <th className="p-2.5">{isFa ? 'گوینده' : 'Speaker'}</th>
                      <th className="p-2.5">{isFa ? 'زبان / محیط' : 'Language / Environment'}</th>
                      <th className="p-2.5">{isFa ? 'امتیاز ۱۱ دروازه' : '11-Gate QC Score'}</th>
                      <th className="p-2.5">{isFa ? 'لایه مجوز / رضایت' : 'Consent / License'}</th>
                      <th className="p-2.5">{isFa ? 'Split بدون نشت' : 'Zero-Leakage Split'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--avp-border-subtle)] bg-[var(--avp-surface)]">
                    {datasetAudit.qcRows.map(({ sample, qc }) => {
                      const assigned =
                        datasetAudit.splits.splitSamples.find((s) => s.sample_id === sample.sample_id)
                          ?.assigned_split ?? sample.assigned_split;
                      return (
                        <tr key={sample.sample_id}>
                          <td className="p-2.5 font-mono text-[var(--avp-warning-text)]">{sample.sample_id}</td>
                          <td className="p-2.5 font-mono">{sample.speaker_id}</td>
                          <td className="p-2.5">
                            {sample.language} · {sample.recording_environment}
                          </td>
                          <td className="p-2.5 font-mono text-[var(--avp-success-text)]">
                            {qc.qcScore}/100 ({qc.qualityStatus})
                          </td>
                          <td className="p-2.5 text-[var(--avp-text-secondary)]">{sample.consent_status}</td>
                          <td className="p-2.5 font-mono text-[var(--avp-accent-text)]">{assigned}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* TAB 3: INDEPENDENT MODEL RC1 */}
          {activeTab === 'model' && (
            <section className="space-y-4">
              <div className="p-4 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--avp-text)]">
                      {isFa
                        ? `معماری ۳ لایه مستقل و مدیریت چک‌پوینت (${activeCkpt.modelVersion})`
                        : `3-Layer Independent Architecture & Checkpoint Manager (${activeCkpt.modelVersion})`}
                    </h3>
                    <p className="text-xs text-[var(--avp-text-secondary)]">
                      {isFa ? 'چک‌پوینت فعال:' : 'Active Checkpoint:'}{' '}
                      <span className="font-mono text-[var(--avp-warning-text)]">{activeCkpt.checkpointId}</span> ·
                      Step: <span className="font-mono">{activeCkpt.globalStep}</span> · Val CER:{' '}
                      <span className="font-mono">{activeCkpt.validationCerPercent}%</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid="btn-advance-checkpoint"
                      onClick={() => handleAdvanceOrRollbackCheckpoint('save')}
                      className="min-h-[44px] sm:min-h-[34px] px-3 py-1.5 rounded-md bg-[var(--avp-success-soft)] border border-[var(--avp-success)]/40 text-[var(--avp-success-text)] text-xs font-medium cursor-pointer"
                    >
                      {isFa ? 'ذخیره چک‌پوینت (+50 Step)' : 'Save Checkpoint (+50 Step)'}
                    </button>
                    <button
                      type="button"
                      data-testid="btn-rollback-checkpoint"
                      onClick={() => handleAdvanceOrRollbackCheckpoint('rollback')}
                      className="avp-btn avp-btn-danger min-h-[44px] sm:min-h-[34px]"
                    >
                      <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{isFa ? 'بازگشت (Rollback)' : 'Rollback'}</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div className="md:col-span-2">
                    <label
                      htmlFor="asr-lab-phase4-input"
                      className="block text-xs text-[var(--avp-text-secondary)] mb-1"
                    >
                      {isFa
                        ? 'خروجی خام تست ۳ لایه (Raw Model Input برای مشاهده جداسازی لایه ۱ تا ۳):'
                        : 'Raw Model Input for 3-Layer Separation Preview (Layers 1–3):'}
                    </label>
                    <input
                      id="asr-lab-phase4-input"
                      type="text"
                      dir="auto"
                      value={phase4RawInput}
                      onChange={(e) => setPhase4RawInput(e.target.value)}
                      className="avp-input w-full min-h-[44px] sm:min-h-[36px] sm:h-9 px-3 text-xs"
                    />
                  </div>
                  <div className="flex gap-2">
                    <select
                      aria-label={isFa ? 'پروفیل دامنه تخصصی' : 'Domain Profile'}
                      value={domainProfile}
                      onChange={(e) => setDomainProfile(e.target.value as DomainProfileName)}
                      className="avp-input flex-1 min-h-[44px] sm:min-h-[36px] sm:h-9 px-2.5 text-xs"
                    >
                      <option value="technology">{isFa ? 'دامنه فناوری' : 'Technology'}</option>
                      <option value="general">{isFa ? 'عمومی' : 'General'}</option>
                      <option value="business">{isFa ? 'کسب‌وکار' : 'Business'}</option>
                      <option value="medical">{isFa ? 'پزشکی' : 'Medical'}</option>
                      <option value="legal">{isFa ? 'حقوقی' : 'Legal'}</option>
                    </select>
                    <button
                      type="button"
                      data-testid="btn-run-phase4-infer"
                      onClick={handleRunPhase4Inference}
                      className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[36px] sm:h-9"
                    >
                      {isFa ? 'تبدیل ۳ لایه' : 'Run 3-Layer Pass'}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    <div className="text-[var(--avp-text-secondary)] mb-1">
                      {isFa ? 'لایه ۱: `raw_model_output`' : 'Layer 1: `raw_model_output`'}
                    </div>
                    <div className="text-[var(--avp-text)]" dir="auto">{phase4Output.raw_model_output}</div>
                  </div>
                  <div className="p-3 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    <div className="text-[var(--avp-warning-text)] mb-1">
                      {isFa ? 'لایه ۲: `normalized_text`' : 'Layer 2: `normalized_text`'}
                    </div>
                    <div className="text-[var(--avp-text)]" dir="auto">{phase4Output.normalized_text}</div>
                  </div>
                  <div className="p-3 rounded-md border border-[var(--avp-success)]/40 bg-[var(--avp-bg-subtle)]">
                    <div className="text-[var(--avp-success-text)] mb-1">
                      {isFa ? 'لایه ۳: `domain_adapted_text`' : 'Layer 3: `domain_adapted_text`'}
                    </div>
                    <div className="text-[var(--avp-text)]" dir="auto">{phase4Output.domain_adapted_text}</div>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-[var(--avp-border)]">
                <table className={`w-full ${isFa ? 'text-right' : 'text-left'} text-xs`}>
                  <thead className="bg-[var(--avp-surface-shell)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
                    <tr>
                      <th className="p-2.5">{isFa ? 'کاندید' : 'Candidate'}</th>
                      <th className="p-2.5">{isFa ? 'مدل / پارامتر' : 'Model / Parameters'}</th>
                      <th className="p-2.5">{isFa ? 'لایسنس ۶لایه' : '6-Layer License'}</th>
                      <th className="p-2.5">{isFa ? 'وضعیت در G0_CPU_ONLY' : 'G0_CPU_ONLY Status'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--avp-border-subtle)] bg-[var(--avp-surface)]">
                    {PHASE4_CANDIDATE_MODEL_REGISTRY.map((m) => (
                      <tr key={m.candidateId}>
                        <td className="p-2.5 font-mono text-[var(--avp-warning-text)]">{m.candidateId}</td>
                        <td className="p-2.5">
                          {m.modelName} ({m.parameterCount})
                        </td>
                        <td className="p-2.5 font-mono text-[var(--avp-success-text)]">
                          {m.licenseVerification.weightsLicense} · {m.licenseVerification.verificationStatus}
                        </td>
                        <td className="p-2.5 font-mono text-xs">
                          <span
                            className={
                              m.localExecutionStatusInG0 === 'EXECUTABLE_IN_G0_CPU'
                                ? 'text-[var(--avp-success-text)]'
                                : 'text-[var(--avp-warning-text)]'
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

              <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] text-xs text-[var(--avp-text-secondary)]">
                {isFa ? (
                  <>
                    ارزیابی مقایسه Baseline با RC1 روی {phase4Comparison.sampleCount} نمونه: CER فارسی از{' '}
                    <span className="font-mono text-[var(--avp-text)]">{phase4Comparison.persianBaselineCerPercent}%</span> به{' '}
                    <span className="font-mono text-[var(--avp-success-text)]">{phase4Comparison.persianFineTunedCerPercent}%</span> و CER کدسوئیچ از{' '}
                    <span className="font-mono text-[var(--avp-text)]">{phase4Comparison.mixedBaselineCerPercent}%</span> به{' '}
                    <span className="font-mono text-[var(--avp-success-text)]">{phase4Comparison.mixedFineTunedCerPercent}%</span> رسید.
                  </>
                ) : (
                  <>
                    Baseline vs RC1 across {phase4Comparison.sampleCount} samples: Persian CER improved from{' '}
                    <span className="font-mono text-[var(--avp-text)]">{phase4Comparison.persianBaselineCerPercent}%</span> to{' '}
                    <span className="font-mono text-[var(--avp-success-text)]">{phase4Comparison.persianFineTunedCerPercent}%</span> and Code-Switch CER from{' '}
                    <span className="font-mono text-[var(--avp-text)]">{phase4Comparison.mixedBaselineCerPercent}%</span> to{' '}
                    <span className="font-mono text-[var(--avp-success-text)]">{phase4Comparison.mixedFineTunedCerPercent}%</span>.
                  </>
                )}
              </div>
            </section>
          )}

          {/* TAB 4: REAL-TIME STREAMING ASR1 & VAD */}
          {activeTab === 'streaming' && (
            <section className="space-y-4">
              <div className="p-4 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--avp-text)]">
                      {isFa
                        ? 'موتور استریم زنده با پروتکل باینری `ASR1` (۲۴ بایت هدر + PCM16 مونو)'
                        : 'Live Streaming Engine with Binary `ASR1` Protocol (24B Header + Mono PCM16)'}
                    </h3>
                    <p className="text-xs text-[var(--avp-text-secondary)]">
                      {isFa ? 'وضعیت Web AudioWorklet خارج از ترد اصلی:' : 'Off-main-thread Web AudioWorklet status:'}{' '}
                      <span className="font-mono text-[var(--avp-success-text)]">{workletStatus}</span> (`/asr-stream-worklet.js`)
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={isFa ? 'انتخاب بک‌اند استریم' : 'Select Streaming Backend'}
                      value={selectedStreamBackend}
                      onChange={(e) => setSelectedStreamBackend(e.target.value as StreamingBackendId)}
                      className="avp-input min-h-[44px] sm:min-h-[36px] sm:h-9 px-2.5 text-xs"
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
                      className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[36px] sm:h-9"
                    >
                      <Mic className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{isFa ? 'اجرای شبیه‌ساز فریم زنده ۱۰۰ms' : 'Run 100ms Live Frame Sim'}</span>
                    </button>
                  </div>
                </div>

                {/* Mandatory Transparent Mode Disclosure */}
                <div
                  data-testid="stream-mode-disclosure"
                  className={`p-2.5 rounded-md border text-xs flex flex-wrap items-center justify-between gap-2 ${
                    activeStreamingSpec.nativeIncrementalStreamingSupported
                      ? 'border-[var(--avp-success)]/40 bg-[var(--avp-success-soft)] text-[var(--avp-success-text)]'
                      : 'border-[var(--avp-warning)]/40 bg-[var(--avp-warning-soft)] text-[var(--avp-warning-text)]'
                  }`}
                >
                  <span>
                    {isFa ? 'افشای صادقانه حالت استریم:' : 'Streaming Mode Disclosure:'}{' '}
                    <strong>{activeStreamingSpec.uiModeDisclosureLabel}</strong>
                  </span>
                  <span className="font-mono">{activeStreamingSpec.executionMode}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    <div className="text-[var(--avp-text-secondary)]">
                      {isFa ? 'سربار تجمعی Qwen (۳۰s با چانک ۲s)' : 'Qwen Cumulative Overhead (30s / 2s chunks)'}
                    </div>
                    <div className="font-mono text-[var(--avp-warning-text)] mt-1" dir="ltr">
                      {qwenOverhead.totalCumulativeAudioSec}s ({qwenOverhead.overheadMultiplier}x)
                    </div>
                    <div className="text-[11px] text-[var(--avp-text-muted)] mt-0.5">
                      {isFa ? 'محدودیت نرم VAD برای مهار سربار: ۱۲.۰ ثانیه' : 'VAD soft ceiling to bound overhead: 12.0s'}
                    </div>
                  </div>
                  <div className="p-3 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    <div className="text-[var(--avp-text-secondary)]">
                      {isFa ? 'هیسترزیس VAD ۵۱۲ نمونه' : '512-Sample VAD Hysteresis'}
                    </div>
                    <div className="font-mono text-[var(--avp-accent-text)] mt-1" dir="ltr">
                      Start ≥ 0.50 · Continue ≥ 0.35 · Endpoint = 600ms
                    </div>
                  </div>
                  <div className="p-3 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    <div className="text-[var(--avp-text-secondary)]">
                      {isFa ? 'ابعاد پکت باینری ۱۰۰ms' : '100ms Binary Packet Size'}
                    </div>
                    <div className="font-mono text-[var(--avp-success-text)] mt-1" dir="ltr">
                      24B Header + 3200B PCM16 = 3224B
                    </div>
                  </div>
                </div>

                {streamSimState && (
                  <div className="p-3.5 rounded-lg border border-[var(--avp-accent)]/35 bg-[var(--avp-bg-subtle)] space-y-2 text-xs">
                    <div className="flex flex-wrap gap-4 font-mono text-[var(--avp-accent-text)]" dir="ltr">
                      <span>Session: {streamSimState.sessionId}</span>
                      <span>Frames: {streamSimState.framesSent}</span>
                      <span>Bytes: {streamSimState.totalBytes}</span>
                      <span>VAD Speech Frames: {streamSimState.vadSpeechCount}</span>
                      <span>Backpressure: {streamSimState.backpressure}</span>
                      <span>TTFP P95: {streamSimState.ttfpP95Ms}ms</span>
                    </div>
                    <div className="text-[var(--avp-text-secondary)]">
                      <span className="text-[var(--avp-warning-text)]">
                        {isFa ? 'پیش‌نمایش‌های موقت (Partial Replace):' : 'Temporary Previews (Partial Replace):'}
                      </span>{' '}
                      {streamSimState.partials.join(' | ') ||
                        (isFa ? 'بدون بازنگری میانی در حالت Segmented' : 'No intermediate partial revisions in Segmented mode')}
                    </div>
                    <div className="text-[var(--avp-success-text)]">
                      <span className="font-semibold">
                        {isFa ? 'متن نهایی قطعی (Committed Final):' : 'Committed Final Transcript:'}
                      </span>{' '}
                      <span dir="auto">{streamSimState.finalTexts.join(' · ')}</span>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* TAB 5: ADAPTIVE ROUTER */}
          {activeTab === 'router' && (
            <section className="space-y-4">
              <div className="p-4 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--avp-text)]">
                      {isFa
                        ? 'مسیریاب هوشمند با فیلتر ۱۸ دروازه‌ای و محافظ حریم خصوصی (`disagreement_only: false`)'
                        : '18-Gate Adaptive Router & Privacy Guard (`disagreement_only: false`)'}
                    </h3>
                    <p className="text-xs text-[var(--avp-text-secondary)]">
                      {isFa
                        ? 'پیش‌بینی محافظه‌کارانه خطا با `CER_Upper_95` و کنترلر بودجه اتمیک'
                        : 'Conservative error prediction via `CER_Upper_95` & atomic budget controller'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={isFa ? 'سیاست مسیریابی' : 'Routing Strategy'}
                      value={routerStrategy}
                      onChange={(e) =>
                        handleEvaluateRouter(e.target.value as RoutingStrategyName, routerPrivacy)
                      }
                      className="avp-input min-h-[44px] sm:min-h-[34px] sm:h-8 px-2.5 text-xs"
                    >
                      <option value="balanced">Balanced</option>
                      <option value="quality_first">Quality First</option>
                      <option value="low_latency">Low Latency</option>
                      <option value="low_cost">Low Cost</option>
                      <option value="privacy_first">Privacy First</option>
                    </select>
                    <select
                      aria-label={isFa ? 'سیاست حریم خصوصی' : 'Privacy Routing Policy'}
                      value={routerPrivacy}
                      onChange={(e) =>
                        handleEvaluateRouter(routerStrategy, e.target.value as PrivacyRoutingPolicy)
                      }
                      className="avp-input min-h-[44px] sm:min-h-[34px] sm:h-8 px-2.5 text-xs"
                    >
                      <option value="local_only">
                        {isFa ? 'Local Only (قطع کامل انتقال ابری)' : 'Local Only (Zero Cloud Egress)'}
                      </option>
                      <option value="local_preferred">Local Preferred</option>
                      <option value="external_allowed">External Allowed</option>
                    </select>
                  </div>
                </div>

                <div className="p-3 rounded-md border border-[var(--avp-success)]/40 bg-[var(--avp-bg-subtle)] text-xs space-y-1">
                  <div>
                    {isFa ? 'موتور منتخب اولیه:' : 'Selected Primary Engine:'}{' '}
                    <span className="font-mono text-[var(--avp-success-text)] font-bold" data-testid="router-selected-primary">
                      {routerDecision.selected_primary ?? 'NONE'}
                    </span>{' '}
                    · {isFa ? 'حالت اجرا:' : 'Mode:'}{' '}
                    <span className="font-mono text-[var(--avp-warning-text)]">{routerDecision.operating_mode}</span>
                  </div>
                  <div className="text-[var(--avp-text-secondary)]">{routerDecision.decision_reason}</div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-[var(--avp-border)]">
                  <table className={`w-full ${isFa ? 'text-right' : 'text-left'} text-xs`}>
                    <thead className="bg-[var(--avp-surface-shell)] text-[var(--avp-text-secondary)] border-b border-[var(--avp-border)]">
                      <tr>
                        <th className="p-2">{isFa ? 'موتور' : 'Engine'}</th>
                        <th className="p-2">{isFa ? 'وضعیت دروازه ۱۸گانه' : '18-Gate Eligibility'}</th>
                        <th className="p-2">{isFa ? 'امتیاز Utility' : 'Utility Score'}</th>
                        <th className="p-2">CER_Upper_95</th>
                        <th className="p-2">{isFa ? 'دلیل رد (در صورت رد)' : 'Rejection Reason'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--avp-border-subtle)] bg-[var(--avp-surface)]">
                      {routerDecision.candidates.map((cand) => (
                        <tr key={cand.engine_id}>
                          <td className="p-2 font-mono">{cand.engine_id}</td>
                          <td className="p-2 font-mono">
                            <span className={cand.eligible ? 'text-[var(--avp-success-text)]' : 'text-[var(--avp-danger-text)]'}>
                              {cand.eligible ? 'ELIGIBLE' : 'REJECTED'}
                            </span>
                          </td>
                          <td className="p-2 font-mono">{cand.eligible ? cand.utility_score.toFixed(4) : '—'}</td>
                          <td className="p-2 font-mono">{cand.predicted_cer_upper_95.toFixed(3)}</td>
                          <td className="p-2 text-[11px] text-[var(--avp-text-muted)] font-mono">
                            {cand.rejection_reasons.join(', ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="p-3 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)] text-xs text-[var(--avp-text-secondary)] flex flex-wrap gap-4">
                  <span>
                    {isFa ? 'دقت تطابق با Oracle:' : 'Oracle Agreement Accuracy:'}{' '}
                    <strong className="font-mono text-[var(--avp-success-text)]">{routerRegret.routingAccuracyPercent}%</strong>
                  </span>
                  <span>
                    {isFa ? 'میانگین Quality Regret:' : 'Mean Quality Regret:'}{' '}
                    <strong className="font-mono text-[var(--avp-warning-text)]">{routerRegret.meanQualityRegretCer}</strong>
                  </span>
                  <span>
                    {isFa ? 'نقض بودجه:' : 'Budget Violation Rate:'}{' '}
                    <strong className="font-mono text-[var(--avp-success-text)]">{routerRegret.budgetViolationRate}%</strong>
                  </span>
                </div>
              </div>
            </section>
          )}

          {/* TAB 6: ARCHITECTURE, SECURITY TRUTH AUDIT & CONTINUOUS LEARNING */}
          {activeTab === 'research_security' && (
            <section className="space-y-4">
              {/* Architecture Go/No-Go */}
              <div className="p-4 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-[var(--avp-text)] flex items-center gap-2">
                    <Layers className="w-4 h-4 text-[var(--avp-warning-text)]" aria-hidden="true" />
                    <span>
                      {isFa
                        ? 'دروازه تصمیم آموزش از صفر و پروتوتایپ‌های FastConformer'
                        : 'From-Scratch Training Go/No-Go Gate & FastConformer Prototypes'}
                    </span>
                  </h3>
                  <span
                    data-testid="from-scratch-verdict"
                    className="font-mono px-2 py-0.5 rounded bg-[var(--avp-danger-soft)] text-[var(--avp-danger-text)] border border-[var(--avp-danger)]/40"
                    dir="ltr"
                  >
                    {fromScratchReport.assignedDataTier} · {fromScratchReport.trackBProductionFromScratchDecision}
                  </span>
                </div>
                <p className="text-[var(--avp-text-secondary)]">{fromScratchReport.permittedGoalsSummary}</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1 font-mono text-[11px]" dir="ltr">
                  <div className="p-2.5 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    FC-CTC-S1: {(archPrototypes.ctcS1.totalParameters / 1e6).toFixed(2)}M Params ·{' '}
                    {archPrototypes.ctcS1.estimatedGflopsPer10SecAudio} GFLOPs/10s
                  </div>
                  <div className="p-2.5 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    FC-RNNT-S1: {(archPrototypes.rnntS1.totalParameters / 1e6).toFixed(2)}M Params
                  </div>
                  <div className="p-2.5 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    Hybrid Loss H01 (0.5/0.5): {archPrototypes.lossH01.combinedTotalLoss.toFixed(3)}
                  </div>
                </div>
              </div>

              {/* Truth Audit & Security */}
              <div className="p-4 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-[var(--avp-text)] flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-[var(--avp-success-text)]" aria-hidden="true" />
                    <span>
                      {isFa
                        ? 'ممیزی صداقت معماری و تست امنیتی OWASP ASVS / STRIDE'
                        : 'Architectural Truth Audit & OWASP ASVS / STRIDE Security Suite'}
                    </span>
                  </h3>
                  <button
                    type="button"
                    data-testid="btn-rerun-security-audit"
                    onClick={() => setSecurityReport(runAdversarialSecurityAndReadinessAudit())}
                    className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[34px]"
                  >
                    {isFa ? 'اجرای مجدد تست نفوذ ورودی' : 'Re-run Input Audit'}
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono">
                  <div className="p-2 rounded-md bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)]">
                    {isFa ? 'تست‌های امنیتی:' : 'Security Checks:'}{' '}
                    <span className="text-[var(--avp-success-text)]" dir="ltr">
                      {securityReport.passedCount}/{securityReport.totalChecks} PASS
                    </span>
                  </div>
                  <div className="p-2 rounded-md bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)]">
                    {isFa ? 'تایید محلی کامل:' : 'Verified Local:'}{' '}
                    {truthSummary.countsByStatus.IMPLEMENTED_AND_VERIFIED}
                  </div>
                  <div className="p-2 rounded-md bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)]">
                    {isFa ? 'نیازمند GPU/PG:' : 'Requires GPU/PG:'}{' '}
                    {truthSummary.countsByStatus.PARTIALLY_IMPLEMENTED}
                  </div>
                  <div className="p-2 rounded-md bg-[var(--avp-bg-subtle)] border border-[var(--avp-border)]">
                    {isFa ? 'وضعیت کل سیستم:' : 'System Status:'}{' '}
                    <span className="text-[var(--avp-warning-text)]">{truthSummary.overallReleaseStatus}</span>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {PHASE8_SYSTEM_INVENTORY.slice(0, 4).map((inv) => (
                    <div key={inv.componentId} className="p-2 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)] flex justify-between gap-2">
                      <span className="text-[var(--avp-text)]">{inv.name}</span>
                      <span className="font-mono text-[11px] text-[var(--avp-accent-text)] shrink-0">{inv.truthStatus}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Continuous Learning & Canary */}
              <div className="p-4 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] space-y-3 text-xs">
                <h3 className="text-sm font-semibold text-[var(--avp-text)]">
                  {isFa
                    ? 'جمع‌آوری بازخورد با دروازه رضایت‌نامه ۸گانه، Champion/Challenger و Canary'
                    : 'Feedback Collection with 8-Gate Consent, Champion/Challenger & Canary Rollout'}
                </h3>
                <form onSubmit={handleSubmitFeedback} className="space-y-2">
                  <div className="flex flex-wrap gap-2 items-center">
                    <input
                      id="asr-lab-feedback-input"
                      type="text"
                      dir="auto"
                      value={fbText}
                      onChange={(e) => setFbText(e.target.value)}
                      aria-label={isFa ? 'متن اصلاحی کاربر' : 'User correction text'}
                      className="avp-input flex-1 min-w-[240px] min-h-[44px] sm:min-h-[36px] sm:h-9 px-3 text-xs"
                    />
                    <label className="min-h-[44px] sm:min-h-0 inline-flex items-center gap-1.5 text-[var(--avp-text-secondary)] cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid="chk-training-consent"
                        checked={trainingConsent}
                        onChange={(e) => setTrainingConsent(e.target.checked)}
                        className="w-4 h-4 accent-[var(--avp-brand)]"
                      />
                      <span>
                        {isFa
                          ? 'رضایت صریح برای استفاده آموزشی (`ALLOW_MODEL_TRAINING`)'
                          : 'Explicit consent for model training (`ALLOW_MODEL_TRAINING`)'}
                      </span>
                    </label>
                    <button
                      type="submit"
                      data-testid="btn-submit-feedback"
                      className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[36px] sm:h-9"
                    >
                      {isFa ? 'ثبت بازخورد' : 'Submit Feedback'}
                    </button>
                  </div>
                  {fbResultMsg && (
                    <div data-testid="feedback-consent-result" className="p-2 rounded-md bg-[var(--avp-accent-soft)] border border-[var(--avp-accent)]/35 text-[var(--avp-accent-text)]">
                      {fbResultMsg}
                    </div>
                  )}
                </form>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <div className="p-2.5 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    <div className="text-[var(--avp-text-secondary)]">
                      {isFa ? 'دروازه Champion/Challenger' : 'Champion/Challenger Gate'}
                    </div>
                    <div className="text-[var(--avp-success-text)] font-mono mt-1" dir="ltr">
                      {championGate.approvedForCanaryPromotion ? 'APPROVED' : 'REJECTED'} (+
                      {championGate.overallRelativeCerImprovementPercent}% Rel CER)
                    </div>
                  </div>
                  <div className="p-2.5 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)]">
                    <div className="text-[var(--avp-text-secondary)]">
                      {isFa ? 'پایش PSI (کوهورت با ۱۴ نمونه)' : 'PSI Drift Check (14-sample cohort)'}
                    </div>
                    <div className="text-[var(--avp-warning-text)] font-mono mt-1">
                      {psiLowSampleDemo.status}{' '}
                      {isFa ? '(جلوگیری از آلارم کاذب < 30 نمونه)' : '(False-alarm guard < 30 samples)'}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-md border border-[var(--avp-border)] bg-[var(--avp-bg-subtle)] flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[var(--avp-text-secondary)]">Canary Rollout</div>
                      <div className="font-mono text-[var(--avp-accent-text)] mt-0.5">
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
                      className="min-h-[44px] sm:min-h-[30px] px-2.5 py-1 rounded bg-[var(--avp-success-soft)] text-[var(--avp-success-text)] border border-[var(--avp-success)]/40 cursor-pointer"
                    >
                      {isFa ? 'ارتقا' : 'Promote'}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </AccessibleModal>
  );
};
