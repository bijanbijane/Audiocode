import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import {
  ModelLifecycleStatus,
  PlatformLicenseService,
  SubscriptionPlan,
} from './backend/src/PlatformLicenseService.ts';
import {
  PHASE1_ENGINE_REGISTRY,
} from './src/ai-engine/asr/AsrExperimentationLabCore.ts';
import {
  PHASE3_ENGINE_CAPABILITY_REGISTRY,
  INITIAL_VERIFIED_STUDIO_CORPUS,
} from './src/ai-engine/asr/AsrDatasetAndBehavioralBenchmarkEngine.ts';
import {
  PHASE4_CANDIDATE_MODEL_REGISTRY,
  GLOBAL_PHASE4_CHECKPOINT_MANAGER,
  runIndependentAsrTranscription,
  runPhase4BaselineVsFineTunedEvaluation,
} from './src/ai-engine/asr/IndependentAsrModelDevelopmentEngine.ts';
import {
  PHASE5_STREAMING_BACKEND_REGISTRY,
  PHASE5_FAILURE_RECOVERY_MATRIX,
} from './src/ai-engine/asr/RealTimeStreamingAsrEngine.ts';
import {
  PHASE6_ROUTER_ENGINE_REGISTRY,
  GLOBAL_PHASE6_ADAPTIVE_ROUTER,
  makeAdaptiveRoutingDecision,
  runOfflineCounterfactualRegretEvaluation,
  type AdaptiveRoutingRequest,
} from './src/ai-engine/asr/AdaptiveAsrRouterEngine.ts';
import {
  evaluateFromScratchGoNoGoDecision,
  PHASE7_SOURCE_ACQUISITION_LEDGER,
} from './src/ai-engine/asr/AdvancedModelResearchAndArchitectureEngine.ts';
import {
  buildArchitectureTruthSummary,
  buildSbomAndProvenanceManifest,
  runAdversarialSecurityAndReadinessAudit,
  sanitizePublicErrorOutput,
} from './src/ai-engine/asr/IndustrialValidationAndSecurityEngine.ts';
import {
  GLOBAL_CONTINUOUS_LEARNING_HUB,
} from './src/ai-engine/asr/ContinuousLearningAndEvolutionEngine.ts';
import {
  GLOBAL_PLATFORM_CONTROL_PLANE,
  PHASE10_PUBLIC_MODEL_CATALOG,
} from './src/platform/PlatformControlPlaneEngine.ts';
import { PlatformDataPlaneGateway } from './src/platform/PlatformDataPlaneGateway.ts';
import { PlatformControlPlaneGateway } from './src/platform/PlatformControlPlaneGateway.ts';
import { createPlatformControlPlaneHttpRouter } from './src/platform/PlatformControlPlaneHttpRouter.ts';
import {
  createSpeechIntelligenceSandboxRouter,
  resolveSandboxRuntimePolicy,
} from './src/intelligence/SandboxHttpAccessGuard.ts';
import { DataFactoryGateway } from './src/data-factory/DataFactoryGateway.ts';
import { ModelFactoryGateway } from './src/model-factory/ModelFactoryGateway.ts';
import { createModelFactoryHttpRouter } from './src/model-factory/ModelFactoryHttpRouter.ts';
import type {
  AugmentationConfig,
  DatasetReleaseType,
  IngestionSourceType,
  LanguageClassification,
  RightsPermissions,
  SplitPolicyConfig,
  StereoChannelPolicy,
} from './src/data-factory/DataFactoryContracts.ts';
import { SpeechSecurityService } from './src/security/SpeechSecurityService.ts';
import { SpeechSecurityGateway } from './src/security/SpeechSecurityGateway.ts';
import { createSpeechSecurityHttpRouter } from './src/security/SpeechSecurityHttpRouter.ts';
import { CoreModelRouter } from './src/asr-core/CoreModelRouter.ts';
import { float32ToPcm16Buffer } from './src/asr-core/CoreAudioIngestion.ts';
import { CORE_SAMPLE_RATE, synthesizeAcousticSpeechFromText } from './src/asr-core/CoreAcousticCtcEngine.ts';
import { runCoreBenchmarkAndAdaptationSuite } from './src/asr-core/CoreAsrBenchmarkSuite.ts';
import type { DetectedLanguageTag, LongFormConfig } from './src/asr-core/CoreAsrContracts.ts';
import {
  LocalExecutionAdapter,
  UnifiedProcessingError,
  UnifiedProcessingOrchestrator,
  type UnifiedProcessingRequest,
} from './src/processing-engine/index.ts';
import {
  CloudAsrConsentRegistry,
  createStudioCloudAsrRouter,
  STUDIO_CLOUD_MODEL_ID,
} from './src/security/CloudAsrConsentRegistry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();

  const licenseService = new PlatformLicenseService({
    privateKeyPem: process.env.ED25519_PRIVATE_KEY_PEM,
    publicKeyPem: process.env.ED25519_PUBLIC_KEY_PEM,
    keyVersion: 1,
  });

  // Fail-closed startup guard: production with ENABLE_INTELLIGENCE_SANDBOX_ROUTES=true throws immediately
  const sandboxPolicy = resolveSandboxRuntimePolicy({
    NODE_ENV: process.env.NODE_ENV,
    ENABLE_INTELLIGENCE_SANDBOX_ROUTES: process.env.ENABLE_INTELLIGENCE_SANDBOX_ROUTES,
    INTELLIGENCE_SANDBOX_TOKEN: process.env.INTELLIGENCE_SANDBOX_TOKEN,
  });

  const platformGateway = new PlatformDataPlaneGateway(GLOBAL_PLATFORM_CONTROL_PLANE);
  const platformControlPlaneGateway = new PlatformControlPlaneGateway(GLOBAL_PLATFORM_CONTROL_PLANE, {
    isProduction: IS_PROD,
    bootstrapEnabled: process.env.PLATFORM_BOOTSTRAP_ENABLED === 'true',
    bootstrapToken: process.env.PLATFORM_BOOTSTRAP_TOKEN,
    resolvePublicModels: () =>
      platformGateway.resolveCatalogModelsForProject(
        PHASE10_PUBLIC_MODEL_CATALOG.map((m) => m.modelId)
      ),
  });
  const dataFactoryGateway = new DataFactoryGateway(GLOBAL_PLATFORM_CONTROL_PLANE);
  const modelFactoryGateway = new ModelFactoryGateway(GLOBAL_PLATFORM_CONTROL_PLANE, dataFactoryGateway.service);
  const speechSecurityService = new SpeechSecurityService(
    GLOBAL_PLATFORM_CONTROL_PLANE,
    dataFactoryGateway.service,
    modelFactoryGateway.service
  );
  const speechSecurityGateway = new SpeechSecurityGateway(speechSecurityService);
  const coreAsrRouter = new CoreModelRouter();
  coreAsrRouter.warmup();
  const unifiedProcessingOrchestrator = new UnifiedProcessingOrchestrator({
    localAdapter: new LocalExecutionAdapter({ coreRouter: coreAsrRouter }),
  });
  const cloudAsrConsentRegistry = new CloudAsrConsentRegistry();

  // Preserve Cross-Origin Isolation so SharedArrayBuffer & OPFS SyncAccessHandle remain active
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
  });

  // Mount binary-streaming public transcription route BEFORE global express.json() so raw audio streams
  // are never buffered in heap or rejected by JSON middleware.
  app.post('/v1/audio/transcriptions', async (req, res) => {
    const idempotencyKey =
      typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key']
        : undefined;

    let parsedOptions: Record<string, unknown> = {};
    const rawOptionsHeader = req.headers['x-asr-options'];
    if (typeof rawOptionsHeader === 'string' && rawOptionsHeader.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawOptionsHeader);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          req.resume();
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'X-ASR-Options header must decode to a JSON object.',
              request_id: `req_opts_${Date.now()}`,
              retryable: false,
              details: {},
            },
          });
          return;
        }
        parsedOptions = parsed as Record<string, unknown>;
      } catch {
        req.resume();
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'X-ASR-Options header contains malformed JSON.',
            request_id: `req_opts_${Date.now()}`,
            retryable: false,
            details: {},
          },
        });
        return;
      }
    }

    const abortController = new AbortController();
    const onAborted = () => abortController.abort();
    const onResClose = () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    };
    req.on('aborted', onAborted);
    res.on('close', onResClose);

    try {
      const out = await platformGateway.createTranscription({
        bearerToken: String(req.headers.authorization ?? ''),
        idempotencyKey,
        contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined,
        contentLengthHeader: req.headers['content-length'],
        audioStream: req,
        options: parsedOptions,
        abortSignal: abortController.signal,
      });
      if (!res.writableEnded) {
        res.status(out.status).json(out.body);
      }
    } finally {
      req.off('aborted', onAborted);
      res.off('close', onResClose);
    }
  });

  // Mount Speech Intelligence Sandbox router BEFORE global express.json() so it enforces its strict
  // 256 KiB route-scoped payload limit (or returns sanitized 404 when disabled / in production).
  app.use(
    createSpeechIntelligenceSandboxRouter({
      gateway: platformGateway,
      controlPlane: GLOBAL_PLATFORM_CONTROL_PLANE,
      config: sandboxPolicy,
    })
  );

  // Mount Studio Cloud ASR Consent & Binary WAV Router BEFORE global express.json() so raw
  // audio/wav payloads are strictly validated, capped at 4 MiB, and never JSON-parsed.
  app.use(
    createStudioCloudAsrRouter({
      registry: cloudAsrConsentRegistry,
      isApiKeyAvailable: () => Boolean(process.env.GEMINI_API_KEY),
      transcribeWavBytes: async ({ wavBytes, modelId }) => {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          throw new Error('ASR_API_KEY_UNAVAILABLE');
        }
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
        const response = await ai.models.generateContent({
          model: modelId || STUDIO_CLOUD_MODEL_ID,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/wav',
                  data: wavBytes.toString('base64'),
                },
              },
              {
                text:
                  'این فایل صوتی را دقیق و کلمه‌به‌کلمه به متن تبدیل کن. این گفتار چندزبانه (Code-Switching) است: ' +
                  '۱) گفتار اصلی فارسی را همراه با تپق‌ها و کشیدگی‌های گفتاری (مثل اممم، رفتیممم) دقیق پیاده کن. ' +
                  '۲) اگر کلمات یا اصطلاحات انگلیسی و فنی (مانند API, TypeScript, Backend, Docker, WebGPU, LLM, Cloud, Startup) در میان کلام فارسی بیان شدند، آن‌ها را دقیق تشخیص بده و به فرم استاندارد انگلیسی (Latin) یا معادل دقیق بنویس. ' +
                  '۳) اگر عبارات یا واژگان عربی (مانند إن شاء الله، الحمد لله، فی‌الواقع، علی‌ای‌حال، تحقیقاً، دقیقاً) بیان شدند، املای صحیح عربی و تنوین آن‌ها را حفظ کن. فقط متن پیاده‌شده را بدون هیچ توضیح اضافی برگردان.',
              },
            ],
          },
        });
        const rawText = (response.text ?? '').trim();
        const transcriptText = rawText
          .replace(/^```(?:text|txt)?\s*/i, '')
          .replace(/\s*```$/i, '')
          .replace(/^["«»]|["«»]$/g, '')
          .trim();
        return {
          transcriptText,
          model: modelId || STUDIO_CLOUD_MODEL_ID,
        };
      },
    }),
  );

  app.use(express.json({ limit: '16mb' }));

  // Public Ed25519 SPKI key endpoint for offline client verification
  app.get('/api/v1/crypto/public-key', (_req, res) => {
    res.json(licenseService.getPublicKeyInfo());
  });

  // Issue cryptographically signed Ed25519 offline license lease
  app.post('/api/v1/license/lease', (req, res) => {
    const body = req.body as {
      userId?: unknown;
      displayName?: unknown;
      deviceFingerprint?: unknown;
      plan?: unknown;
      graceDays?: unknown;
    };

    if (typeof body?.userId !== 'string' || body.userId.trim().length === 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'userId is required' });
      return;
    }
    if (
      typeof body?.deviceFingerprint !== 'string' ||
      body.deviceFingerprint.trim().length === 0
    ) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'deviceFingerprint is required',
      });
      return;
    }

    const allowedPlans: SubscriptionPlan[] = ['FREE', 'PRO', 'ENTERPRISE'];
    const plan: SubscriptionPlan =
      typeof body.plan === 'string' && allowedPlans.includes(body.plan as SubscriptionPlan)
        ? (body.plan as SubscriptionPlan)
        : 'PRO';

    const graceDays =
      typeof body.graceDays === 'number' && Number.isFinite(body.graceDays)
        ? body.graceDays
        : 14;

    const envelope = licenseService.issueOfflineLicenseLease({
      userId: body.userId,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      deviceFingerprint: body.deviceFingerprint,
      plan,
      graceDays,
    });

    res.json(envelope);
  });

  // Signed chunked model registry manifest (supports ACTIVE, SUPPORTED, DEPRECATED, REVOKED)
  app.get('/api/v1/models/:modelId/manifest', (req, res) => {
    const { modelId } = req.params;
    const override = req.query.status as ModelLifecycleStatus | undefined;
    const allowedStatuses: ModelLifecycleStatus[] = [
      'ACTIVE',
      'SUPPORTED',
      'DEPRECATED',
      'REVOKED',
    ];
    const validOverride =
      override && allowedStatuses.includes(override) ? override : undefined;

    const envelope = licenseService.issueSignedModelManifestEnvelope(modelId, validOverride);
    if (!envelope) {
      res.status(404).json({ error: 'MODEL_NOT_FOUND', modelId });
      return;
    }

    res.json(envelope);
  });

  // ── Phases 1–4 API Routes: Engines, Leaderboards, Model Development ─────────
  app.post('/api/v1/lab/provider-transcribe', (req, res) => {
    const body = req.body as { engineId?: string };
    const engineId = typeof body?.engineId === 'string' ? body.engineId : '';
    const desc = PHASE1_ENGINE_REGISTRY.find((e) => e.engineId === engineId);
    if (!desc) {
      res.status(400).json({
        status: 'API_ERROR',
        rawTranscript: '',
        errorMessage: 'موتور درخواستی در رجیستری فاز ۱ ثبت نشده است.',
      });
      return;
    }
    const envVarName = desc.requiredEnvVar;
    const configured = Boolean(envVarName && process.env[envVarName]?.trim());
    if (!configured) {
      const isWorker = desc.deploymentKind === 'SELF_HOSTED_GPU_WORKER';
      res.status(200).json({
        status: isWorker ? 'WORKER_OFFLINE' : 'MISSING_API_KEY',
        rawTranscript: '',
        errorMessage: isWorker
          ? `سرور GPU (${envVarName ?? 'UNCONFIGURED'}) در کانتینر فعلی متصل نیست.`
          : `کلید دسترسی (${envVarName ?? 'API_KEY'}) در متغیرهای محیطی سرور تنظیم نشده است.`,
      });
      return;
    }
    res.status(200).json({
      status: 'API_ERROR',
      rawTranscript: '',
      errorMessage: `آداپتور سرور برای موتور ${engineId} در بنچمارک صوتی خام نیاز به ارسال بایت صوتی مستقیم دارد.`,
    });
  });

  app.get('/api/v1/engines', (_req, res) => {
    res.json({
      phase1Registry: PHASE1_ENGINE_REGISTRY,
      phase3Capabilities: PHASE3_ENGINE_CAPABILITY_REGISTRY,
      corpusSamplesCount: INITIAL_VERIFIED_STUDIO_CORPUS.length,
    });
  });

  app.get('/api/v1/benchmark/leaderboards', (_req, res) => {
    const evalSummary = runPhase4BaselineVsFineTunedEvaluation();
    res.json({
      hardwareProfile: 'G0_CPU_ONLY',
      status: 'LOCAL_CPU_VERIFIED',
      baselineVsRc1: evalSummary,
    });
  });

  app.get('/api/v1/asr/health', (_req, res) => {
    const activeCheckpoint = GLOBAL_PHASE4_CHECKPOINT_MANAGER.getActiveCheckpoint();
    const cloudGeminiAsrConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0,
    );
    res.json({
      status: 'OK',
      hardwareProfile: 'G0_CPU_ONLY',
      activeCheckpointId: activeCheckpoint.checkpointId,
      globalStep: activeCheckpoint.globalStep,
      releaseStatus: 'PARTIAL',
      cloudGeminiAsrConfigured,
      cloudGeminiModel: 'gemini-3.5-transcribe',
    });
  });

  app.get('/api/v1/asr/models', (_req, res) => {
    res.json({
      candidates: PHASE4_CANDIDATE_MODEL_REGISTRY,
      activeCheckpoint: GLOBAL_PHASE4_CHECKPOINT_MANAGER.getActiveCheckpoint(),
      history: GLOBAL_PHASE4_CHECKPOINT_MANAGER.listCheckpoints(),
    });
  });

  app.post('/api/v1/asr/transcriptions', (req, res) => {
    const body = req.body as {
      sampleId?: string;
      domainProfile?: 'general' | 'technology' | 'business' | 'real_estate' | 'education' | 'medical' | 'legal';
      enableNormalization?: boolean;
      enableDomainAdaptation?: boolean;
      rawHypothesisOverride?: string;
    };
    const result = runIndependentAsrTranscription({
      sampleId: body?.sampleId,
      domainProfile: body?.domainProfile ?? 'technology',
      enableNormalization: body?.enableNormalization ?? true,
      enableDomainAdaptation: body?.enableDomainAdaptation ?? true,
      rawHypothesisOverride: body?.rawHypothesisOverride,
    });
    res.json(result);
  });

  app.post('/api/v1/asr/checkpoints/rollback', (req, res) => {
    const body = req.body as { checkpointId?: string };
    const list = GLOBAL_PHASE4_CHECKPOINT_MANAGER.listCheckpoints();
    const targetId = body?.checkpointId || list[0]?.checkpointId;
    if (!targetId) {
      res.status(400).json({ error: 'CHECKPOINT_NOT_FOUND' });
      return;
    }
    const rolled = GLOBAL_PHASE4_CHECKPOINT_MANAGER.rollbackToCheckpoint(targetId);
    res.json({ ok: Boolean(rolled), activeCheckpoint: rolled });
  });

  // ── Phase 5 API Routes: Streaming Backends & Failure Matrix ─────────────────
  app.get('/api/v1/streaming/backends', (_req, res) => {
    res.json({
      backends: PHASE5_STREAMING_BACKEND_REGISTRY,
      failureMatrix: PHASE5_FAILURE_RECOVERY_MATRIX,
    });
  });

  // ── Phase 6 API Routes: Adaptive Router & Counterfactual Regret ─────────────
  app.get('/api/v1/router/regret', (_req, res) => {
    res.json({
      engines: PHASE6_ROUTER_ENGINE_REGISTRY,
      regretEvaluation: runOfflineCounterfactualRegretEvaluation(),
      decisionsCount: GLOBAL_PHASE6_ADAPTIVE_ROUTER.listDecisions().length,
      executionsCount: GLOBAL_PHASE6_ADAPTIVE_ROUTER.listExecutions().length,
    });
  });

  app.post('/api/v1/router/decide', (req, res) => {
    const body = req.body as Partial<AdaptiveRoutingRequest>;
    const sampleRequest: AdaptiveRoutingRequest = {
      request_id: body?.request_id ?? `req-${Date.now()}`,
      tenant_id: body?.tenant_id ?? 'tenant-studio-default',
      input: {
        audio_sha256: body?.input?.audio_sha256 ?? 'studio-fa-001',
        duration_ms: Number(body?.input?.duration_ms ?? 11200),
        sample_rate: Number(body?.input?.sample_rate ?? 16000),
        channels: Number(body?.input?.channels ?? 1),
        format: 'pcm16',
        estimated_snr_db: body?.input?.estimated_snr_db ?? 24,
        code_switch_probability: body?.input?.code_switch_probability ?? 0.35,
      },
      task: {
        mode: body?.task?.mode ?? 'batch',
        language: body?.task?.language ?? 'auto',
        domain: body?.task?.domain ?? 'technology',
        diarization: Boolean(body?.task?.diarization ?? true),
        timestamps: Boolean(body?.task?.timestamps ?? true),
      },
      routing: {
        strategy: body?.routing?.strategy ?? 'balanced',
        privacy: body?.routing?.privacy ?? 'local_only',
        allow_external: Boolean(body?.routing?.allow_external ?? false),
        allow_cascade: Boolean(body?.routing?.allow_cascade ?? true),
        max_engines: Number(body?.routing?.max_engines ?? 2),
        manual_engine_id: body?.routing?.manual_engine_id,
      },
      constraints: {
        max_latency_ms: Number(body?.constraints?.max_latency_ms ?? 3000),
        max_cost: Number(body?.constraints?.max_cost ?? 0.05),
        currency: 'USD',
        min_quality_level: body?.constraints?.min_quality_level ?? 'LOW',
      },
    };
    const decision = makeAdaptiveRoutingDecision({ request: sampleRequest });
    res.json(decision);
  });

  // ── Phases 7–9 API Routes: Readiness, Security Truth Audit, Continuous Learning ──
  app.get('/api/v1/production-readiness/audit', (_req, res) => {
    res.json({
      truthSummary: buildArchitectureTruthSummary(),
      securityAudit: runAdversarialSecurityAndReadinessAudit(),
      sbomAndProvenance: buildSbomAndProvenanceManifest(),
      fromScratchGoNoGo: evaluateFromScratchGoNoGoDecision({
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
      dataAcquisitionLedger: PHASE7_SOURCE_ACQUISITION_LEDGER,
    });
  });

  app.get('/api/v1/continuous-learning/status', (_req, res) => {
    res.json({
      feedbackCount: GLOBAL_CONTINUOUS_LEARNING_HUB.feedbackRecords.length,
      activeLearningQueueCount: GLOBAL_CONTINUOUS_LEARNING_HUB.activeLearningQueue.length,
      canaryState: GLOBAL_CONTINUOUS_LEARNING_HUB.canaryState,
      recentFeedback: GLOBAL_CONTINUOUS_LEARNING_HUB.feedbackRecords.slice(-10),
    });
  });

  app.post('/api/v1/continuous-learning/feedback', (req, res) => {
    const body = req.body as {
      tenantId?: string;
      userId?: string;
      requestId?: string;
      utteranceId?: string;
      audioSha256?: string;
      speakerId?: string;
      cohortName?: string;
      feedbackType?:
        | 'USER_CORRECTION'
        | 'QUALITY_RATING'
        | 'BAD_SEGMENT_FLAG'
        | 'CODE_SWITCH_FAILURE';
      asrHypothesisRaw?: string;
      userCorrectionText?: string;
      trainingConsent?: boolean;
      audioRetentionConsent?: boolean;
    };
    if (!body?.utteranceId || !body?.userCorrectionText) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'utteranceId and userCorrectionText are required' });
      return;
    }
    const result = GLOBAL_CONTINUOUS_LEARNING_HUB.submitFeedback({
      tenantId: body.tenantId ?? 'tenant-studio-default',
      userId: body.userId ?? 'editor-user',
      requestId: body.requestId ?? `req-${Date.now()}`,
      utteranceId: body.utteranceId,
      audioSha256: body.audioSha256 ?? 'studio-fa-001',
      speakerId: body.speakerId ?? 'spk-sara',
      cohortName: body.cohortName ?? 'persian_conversational',
      feedbackType: body.feedbackType ?? 'USER_CORRECTION',
      asrHypothesisRaw: body.asrHypothesisRaw ?? '',
      userCorrectionText: body.userCorrectionText,
      trainingConsent: Boolean(body.trainingConsent),
      audioRetentionConsent: Boolean(body.audioRetentionConsent ?? true),
    });
    res.json(result);
  });

  // ── Phase 10 Public Product API (`/v1/*`) ─────────────────────────────────
  app.get('/v1/models', async (req, res) => {
    const out = await platformGateway.listPublicModels(String(req.headers.authorization ?? ''));
    res.status(out.status).json(out.body);
  });

  app.get('/v1/models/:id', async (req, res) => {
    const out = await platformGateway.getPublicModel(String(req.headers.authorization ?? ''), req.params.id);
    res.status(out.status).json(out.body);
  });

  app.post('/v1/audio/estimates', (req, res) => {
    const body = req.body as { model?: string; duration_seconds?: unknown; region_id?: string };
    const parsedDuration =
      body?.duration_seconds === undefined ? 60 : Number(body.duration_seconds);
    if (!Number.isFinite(parsedDuration) || parsedDuration < 0) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'duration_seconds must be a non-negative finite number',
      });
      return;
    }
    const out = platformGateway.estimateTranscriptionCost({
      bearerToken: String(req.headers.authorization ?? ''),
      modelId: body?.model ?? 'asr-fa-en-v1',
      durationSeconds: parsedDuration,
      regionId: body?.region_id,
    });
    res.status(out.status).json(out.body);
  });

  // NOTE: POST /v1/audio/transcriptions is registered above express.json() for raw binary streaming.

  app.get('/v1/audio/transcriptions/:id', (req, res) => {
    const out = platformGateway.getTranscriptionJob({
      bearerToken: String(req.headers.authorization ?? ''),
      transcriptionId: req.params.id,
    });
    res.status(out.status).json(out.body);
  });

  app.get('/v1/audio/transcriptions/:id/result', (req, res) => {
    const out = platformGateway.getTranscriptionJob({
      bearerToken: String(req.headers.authorization ?? ''),
      transcriptionId: req.params.id,
    });
    res.status(out.status).json(out.body);
  });

  app.delete('/v1/audio/transcriptions/:id', (req, res) => {
    const out = platformGateway.deleteTranscriptionJob({
      bearerToken: String(req.headers.authorization ?? ''),
      transcriptionId: req.params.id,
    });
    res.status(out.status).json(out.body);
  });

  app.post('/v1/audio/streaming-sessions', (req, res) => {
    const out = platformGateway.createStreamingProductSession({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (req.body ?? {}) as Record<string, unknown>,
    });
    res.status(out.status).json(out.body);
  });

  // ── Phase 10 Authenticated Control Plane Router (`/api/v1/platform/*`) ────
  app.use(createPlatformControlPlaneHttpRouter(platformControlPlaneGateway));

  // ── Phase 11 Public Speech Intelligence API (`/v1/*`) ─────────────────────
  app.get('/v1/capabilities', (req, res) => {
    const out = platformGateway.listCapabilities(String(req.headers.authorization ?? ''));
    res.status(out.status).json(out.body);
  });

  app.get('/v1/capabilities/:capabilityId', (req, res) => {
    const out = platformGateway.getCapability(String(req.headers.authorization ?? ''), req.params.capabilityId);
    res.status(out.status).json(out.body);
  });

  app.get('/v1/capabilities/:capabilityId/versions', (req, res) => {
    const out = platformGateway.getCapability(String(req.headers.authorization ?? ''), req.params.capabilityId);
    if (out.status !== 200) {
      res.status(out.status).json(out.body);
      return;
    }
    const cap = out.body as (typeof PHASE11_CAPABILITY_REGISTRY)[number];
    res.json({ capabilityId: cap.capabilityId, versions: [cap.capabilityVersion] });
  });

  app.post('/v1/intelligence/jobs', (req, res) => {
    const idempKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
    const out = platformGateway.createIntelligenceJob({
      bearerToken: String(req.headers.authorization ?? ''),
      idempotencyKey: idempKey,
      body: (req.body ?? {}) as Parameters<PlatformDataPlaneGateway['createIntelligenceJob']>[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  app.get('/v1/intelligence/jobs/:jobId', (req, res) => {
    const out = platformGateway.getIntelligenceJob(String(req.headers.authorization ?? ''), req.params.jobId);
    res.status(out.status).json(out.body);
  });

  app.post('/v1/intelligence/jobs/:jobId/cancel', (req, res) => {
    const out = platformGateway.cancelIntelligenceJob(String(req.headers.authorization ?? ''), req.params.jobId);
    res.status(out.status).json(out.body);
  });

  app.get('/v1/intelligence/jobs/:jobId/artifacts', (req, res) => {
    const out = platformGateway.getIntelligenceJobArtifacts(String(req.headers.authorization ?? ''), req.params.jobId);
    res.status(out.status).json(out.body);
  });

  app.post('/v1/recordings/:recordingId/search', (req, res) => {
    const body = req.body as { query?: string; speakerId?: string; language?: 'fa' | 'en' | 'fa-en' };
    const out = platformGateway.searchRecordingSemantic({
      bearerToken: String(req.headers.authorization ?? ''),
      recordingId: req.params.recordingId,
      query: body?.query ?? '',
      speakerId: body?.speakerId,
      language: body?.language,
    });
    res.status(out.status).json(out.body);
  });

  app.get('/v1/recordings/:recordingId/:artifactSlug', (req, res) => {
    const out = platformGateway.getRecordingArtifactBySlug(
      String(req.headers.authorization ?? ''),
      req.params.recordingId,
      req.params.artifactSlug
    );
    res.status(out.status).json(out.body);
  });

  app.delete('/v1/recordings/:recordingId', (req, res) => {
    const out = platformGateway.deleteRecordingAndDerived(String(req.headers.authorization ?? ''), req.params.recordingId);
    res.status(out.status).json(out.body);
  });

  app.get('/v1/integrations', (req, res) => {
    const out = platformGateway.listIntegrations(String(req.headers.authorization ?? ''));
    res.status(out.status).json(out.body);
  });

  app.post('/v1/integrations', (req, res) => {
    const out = platformGateway.createIntegration({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (req.body ?? {}) as Parameters<PlatformDataPlaneGateway['createIntegration']>[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  app.delete('/v1/integrations/:integrationId', (req, res) => {
    const out = platformGateway.deleteIntegration(String(req.headers.authorization ?? ''), req.params.integrationId);
    res.status(out.status).json(out.body);
  });

  // NOTE: Phase 11 Speech Intelligence Sandbox routes are guarded & mounted before express.json()
  // via `createSpeechIntelligenceSandboxRouter(...)`. No unauthenticated sandbox routes exist here.

  // ── Phase 12 Public Data Factory API (`/v1/data/*`, `/v1/datasets/*`) ───────
  app.post('/v1/data/sources', (req, res) => {
    const out = dataFactoryGateway.createDataSource({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (req.body ?? {}) as {
        sourceType?: IngestionSourceType;
        sourceName?: string;
        ownerReference?: string;
        licenseReference?: string;
        verified?: boolean;
        provenanceMetadata?: Record<string, string | number | boolean>;
      },
    });
    res.status(out.status).json(out.body);
  });

  app.get('/v1/data/sources', (req, res) => {
    const out = dataFactoryGateway.listDataSources(String(req.headers.authorization ?? ''));
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/ingestion-jobs', async (req, res, next) => {
    try {
      const idemp = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
      const out = await dataFactoryGateway.createIngestionJob({
        bearerToken: String(req.headers.authorization ?? ''),
        idempotencyKey: idemp,
        body: (req.body ?? {}) as Parameters<DataFactoryGateway['createIngestionJob']>[0]['body'],
      });
      res.status(out.status).json(out.body);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/data/ingestion-jobs/:jobId', (req, res) => {
    const out = dataFactoryGateway.getIngestionJob(String(req.headers.authorization ?? ''), req.params.jobId);
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/ingestion-jobs/:jobId/cancel', (req, res) => {
    const out = dataFactoryGateway.cancelIngestionJob(String(req.headers.authorization ?? ''), req.params.jobId);
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/recordings', async (req, res, next) => {
    try {
      const out = await dataFactoryGateway.ingestRecording({
        bearerToken: String(req.headers.authorization ?? ''),
        body: (req.body ?? {}) as {
          sourceId?: string;
          filename?: string;
          claimedMimeType?: string;
          audioBase64?: string;
          speakerRef?: string;
          sessionRef?: string;
          sourceCorpusTag?: string;
          domainTag?: string;
          declaredLanguage?: LanguageClassification;
          licenseId?: string;
          rightsVerified?: boolean;
          permissions?: Partial<RightsPermissions>;
          evaluationAllowed?: boolean;
          autoNormalizeCanonical?: boolean;
          channelPolicyOverride?: StereoChannelPolicy;
        },
      });
      res.status(out.status).json(out.body);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/data/recordings', (req, res) => {
    const out = dataFactoryGateway.listRecordings(String(req.headers.authorization ?? ''));
    res.status(out.status).json(out.body);
  });

  app.get('/v1/data/recordings/:recordingId', (req, res) => {
    const out = dataFactoryGateway.getRecording(String(req.headers.authorization ?? ''), req.params.recordingId);
    res.status(out.status).json(out.body);
  });

  app.get('/v1/data/recordings/:recordingId/artifacts', (req, res) => {
    const out = dataFactoryGateway.getRecordingArtifacts(String(req.headers.authorization ?? ''), req.params.recordingId);
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/recordings/:recordingId/normalize', (req, res) => {
    const body = (req.body ?? {}) as { channelPolicy?: StereoChannelPolicy };
    const out = dataFactoryGateway.normalizeRecording({
      bearerToken: String(req.headers.authorization ?? ''),
      recordingId: req.params.recordingId,
      channelPolicy: body.channelPolicy,
    });
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/recordings/:recordingId/augment', (req, res) => {
    const body = (req.body ?? {}) as { config: AugmentationConfig; datasetReleaseId?: string | null };
    const out = dataFactoryGateway.augmentRecording({
      bearerToken: String(req.headers.authorization ?? ''),
      recordingId: req.params.recordingId,
      config: body.config,
      datasetReleaseId: body.datasetReleaseId,
    });
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/recordings/:recordingId/validate', (req, res) => {
    const out = dataFactoryGateway.validateRecording(String(req.headers.authorization ?? ''), req.params.recordingId);
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/annotations', (req, res) => {
    const out = dataFactoryGateway.createAnnotation({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (req.body ?? {}) as Parameters<DataFactoryGateway['createAnnotation']>[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  app.get('/v1/data/annotations/:annotationId', (req, res) => {
    const out = dataFactoryGateway.getAnnotation({
      bearerToken: String(req.headers.authorization ?? ''),
      annotationId: req.params.annotationId,
      requesterAnnotatorId: typeof req.query.annotatorId === 'string' ? req.query.annotatorId : undefined,
      isReviewer: req.query.reviewer === 'true',
    });
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/annotations/:annotationId/submit', (req, res) => {
    const body = (req.body ?? {}) as {
      segments?: Parameters<DataFactoryGateway['submitAnnotation']>[0]['segments'];
    };
    const out = dataFactoryGateway.submitAnnotation({
      bearerToken: String(req.headers.authorization ?? ''),
      annotationId: req.params.annotationId,
      segments: body.segments ?? [],
    });
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/annotations/:annotationId/review', (req, res) => {
    const out = dataFactoryGateway.reviewAnnotation({
      bearerToken: String(req.headers.authorization ?? ''),
      annotationId: req.params.annotationId,
      body: (req.body ?? {}) as Parameters<DataFactoryGateway['reviewAnnotation']>[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  app.post('/v1/datasets', (req, res) => {
    const out = dataFactoryGateway.createDataset({
      bearerToken: String(req.headers.authorization ?? ''),
      body: (req.body ?? {}) as { datasetName?: string; description?: string },
    });
    res.status(out.status).json(out.body);
  });

  app.get('/v1/datasets', (req, res) => {
    const out = dataFactoryGateway.listDatasets(String(req.headers.authorization ?? ''));
    res.status(out.status).json(out.body);
  });

  app.post('/v1/datasets/:datasetId/build', (req, res) => {
    const out = dataFactoryGateway.buildDatasetRelease({
      bearerToken: String(req.headers.authorization ?? ''),
      datasetId: req.params.datasetId,
      body: (req.body ?? {}) as {
        version?: string;
        releaseType?: DatasetReleaseType;
        releaseAuthor?: string;
        splitPolicy?: Partial<SplitPolicyConfig>;
        recordingIdsFilter?: readonly string[];
      },
    });
    res.status(out.status).json(out.body);
  });

  app.post('/v1/datasets/:datasetId/audit', (req, res) => {
    const body = (req.body ?? {}) as { releaseId?: string };
    const out = dataFactoryGateway.auditDataset(String(req.headers.authorization ?? ''), req.params.datasetId, body.releaseId);
    res.status(out.status).json(out.body);
  });

  app.get('/v1/datasets/:datasetId/releases', (req, res) => {
    const out = dataFactoryGateway.listDatasetReleases(String(req.headers.authorization ?? ''), req.params.datasetId);
    res.status(out.status).json(out.body);
  });

  app.get('/v1/datasets/releases/:releaseId', (req, res) => {
    const role = typeof req.query.role === 'string' ? (req.query.role as 'TRAINING_PIPELINE' | 'AUTHORIZED_EVAL_WORKFLOW' | 'ADMIN') : undefined;
    const out = dataFactoryGateway.getDatasetRelease({
      bearerToken: String(req.headers.authorization ?? ''),
      releaseId: req.params.releaseId,
      requesterRole: role,
    });
    res.status(out.status).json(out.body);
  });

  app.get('/v1/data/rights/:recordingId', (req, res) => {
    const out = dataFactoryGateway.getRights(String(req.headers.authorization ?? ''), req.params.recordingId);
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/rights/:recordingId/verify', (req, res) => {
    const out = dataFactoryGateway.verifyRights({
      bearerToken: String(req.headers.authorization ?? ''),
      recordingId: req.params.recordingId,
      body: (req.body ?? {}) as Parameters<DataFactoryGateway['verifyRights']>[0]['body'],
    });
    res.status(out.status).json(out.body);
  });

  app.post('/v1/data/rights/:recordingId/revoke', (req, res) => {
    const out = dataFactoryGateway.revokeRights(String(req.headers.authorization ?? ''), req.params.recordingId);
    res.status(out.status).json(out.body);
  });

  app.get('/v1/data/dashboard', (req, res) => {
    const out = dataFactoryGateway.getDashboard(String(req.headers.authorization ?? ''));
    res.status(out.status).json(out.body);
  });

  // ── Phase 12 Sandbox UI Routes (`/api/v1/data-factory/sandbox/*`) ───────────
  app.get('/api/v1/data-factory/sandbox/dashboard', async (_req, res, next) => {
    try {
      await dataFactoryGateway.service.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
      const tenantId = 'org_avapardaz_sandbox';
      const recs = dataFactoryGateway.service.listRecordings(tenantId);
      const datasets = dataFactoryGateway.service.listDatasets(tenantId);
      const releases = datasets.flatMap((d) => dataFactoryGateway.service.listDatasetReleases(tenantId, d.datasetId));
      const rights = recs.map((r) => dataFactoryGateway.service.getRightsRecord(tenantId, r.recordingId));
      const annotationsByRec = Object.fromEntries(
        recs.map((r) => [r.recordingId, dataFactoryGateway.service.listAnnotationsForRecording(tenantId, r.recordingId)])
      );
      const artifactsByRec = Object.fromEntries(
        recs.map((r) => [r.recordingId, dataFactoryGateway.service.getArtifactsForRecording(tenantId, r.recordingId)])
      );
      res.json({
        dashboard: dataFactoryGateway.service.computeDashboardMetrics(tenantId),
        sources: dataFactoryGateway.service.listDataSources(tenantId),
        recordings: recs,
        rights,
        datasets,
        releases,
        annotationsByRec,
        artifactsByRec,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/data-factory/sandbox/rights/:recordingId/revoke', async (req, res, next) => {
    try {
      await dataFactoryGateway.service.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
      try {
        const report = dataFactoryGateway.service.revokeRecordingRights('org_avapardaz_sandbox', req.params.recordingId);
        res.json(report);
      } catch (err) {
        res.status(400).json({ error: 'REVOKE_FAILED', message: sanitizePublicErrorOutput(String(err)) });
      }
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/data-factory/sandbox/datasets/:datasetId/build', async (req, res, next) => {
    try {
      await dataFactoryGateway.service.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
      try {
        const body = (req.body ?? {}) as { version?: string; releaseType?: DatasetReleaseType };
        const version = body.version?.trim() || `v1.0.${Date.now() % 10000}`;
        const built = dataFactoryGateway.service.buildDatasetRelease({
          tenantId: 'org_avapardaz_sandbox',
          datasetId: req.params.datasetId,
          version,
          releaseType: body.releaseType ?? 'TRAIN',
          releaseAuthor: 'studio_sandbox_operator',
        });
        res.status(201).json(built);
      } catch (err) {
        res.status(400).json({ error: 'DATASET_BUILD_FAILED', message: sanitizePublicErrorOutput(String(err)) });
      }
    } catch (err) {
      next(err);
    }
  });

  // ── Phase 13 Public Model Factory & MLOps API (`/v1/ml/*`) ──────────────────
  // Strictly server-side identity & membership authorization; x-avapardaz-role is ignored.
  app.use(createModelFactoryHttpRouter(modelFactoryGateway));

  // ── Phase 13 Sandbox Studio Routes (`/api/v1/model-factory/sandbox/*`) ─────
  app.get('/api/v1/model-factory/sandbox/overview', async (_req, res, next) => {
    try {
      await modelFactoryGateway.service.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
      res.json(modelFactoryGateway.service.getSandboxLifecycleSummary('org_avapardaz_sandbox'));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/model-factory/sandbox/deployments/:deploymentId/rollback', async (req, res, next) => {
    try {
      await modelFactoryGateway.service.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
      try {
        const result = modelFactoryGateway.service.rollbackDeployment({
          tenantId: 'org_avapardaz_sandbox',
          deploymentId: req.params.deploymentId,
          actorId: 'studio_sandbox_operator',
          reason: 'Sandbox emergency rollback verification drill',
        });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: 'ROLLBACK_FAILED', message: sanitizePublicErrorOutput(String(err)) });
      }
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/model-factory/sandbox/models/:modelVersionId/optimize', async (req, res, next) => {
    try {
      await modelFactoryGateway.service.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
      try {
        const result = modelFactoryGateway.service.optimizeAndRegisterDerivedVersion({
          tenantId: 'org_avapardaz_sandbox',
          parentModelVersionId: req.params.modelVersionId,
          newVersion: `1.0.0-int8-${Date.now() % 1000}`,
          technique: 'DYNAMIC_INT8_QUANTIZATION',
        });
        res.status(201).json(result);
      } catch (err) {
        res.status(400).json({ error: 'OPTIMIZE_FAILED', message: sanitizePublicErrorOutput(String(err)) });
      }
    } catch (err) {
      next(err);
    }
  });

  // ── Phase 14 Public Security & Robustness Gateway (`/v1/security/*`) ─────────
  // Strictly server-side identity & membership authorization; x-avapardaz-role is ignored.
  app.use(createSpeechSecurityHttpRouter(speechSecurityGateway));

  // ── Phase 14 Sandbox UI Routes (`/api/v1/security/sandbox/*`) ────────────────
  app.get('/api/v1/security/sandbox/overview', async (_req, res, next) => {
    try {
      await modelFactoryGateway.service.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
      res.json(speechSecurityService.getSandboxSecurityOverview('org_avapardaz_sandbox'));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/security/sandbox/red-team/run', async (_req, res, next) => {
    try {
      await modelFactoryGateway.service.ensureSandboxDemoSeeded('org_avapardaz_sandbox');
      res.json({ groups: speechSecurityService.runFullRedTeamVerificationSuite('org_avapardaz_sandbox') });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/security/sandbox/pii-redact', (req, res) => {
    const body = (req.body ?? {}) as { recordingId?: string; originalTranscript?: string };
    const derivative = speechSecurityService.createPiiDerivative({
      tenantId: 'org_avapardaz_sandbox',
      recordingId: body.recordingId ?? 'rec_sandbox_pii',
      originalTranscript: body.originalTranscript ?? '',
      actorId: 'studio_sandbox_operator',
    });
    res.status(201).json(derivative);
  });

  app.post('/api/v1/security/sandbox/prompt-boundary-test', (req, res) => {
    const body = (req.body ?? {}) as { transcriptText?: string };
    const env = speechSecurityService.protectTranscriptAndCheckTool({
      tenantId: 'org_avapardaz_sandbox',
      recordingId: 'rec_sandbox_prompt_probe',
      rawTranscriptText: body.transcriptText ?? '',
      actorId: 'studio_sandbox_operator',
    });
    const toolDecision = speechSecurityService.authorizeIntelligenceToolCall({
      triggerOrigin: 'TRANSCRIPT_TEXT_EXTRACTION',
      actorPrincipalId: 'studio_sandbox_operator',
      actorTenantId: 'org_avapardaz_sandbox',
      targetTenantId: 'org_avapardaz_sandbox',
      actorRole: 'OWNER',
      toolName: 'deleteRecording',
      allowedRoles: ['OWNER', 'ADMIN'],
      parametersValid: true,
      explicitUserConfirmation: true,
    });
    res.json({ envelope: env, toolDecision });
  });

  app.post('/api/v1/security/sandbox/deletion-cascade', (req, res) => {
    const body = (req.body ?? {}) as { recordingId?: string };
    const report = speechSecurityService.deleteRecordingWithCascade({
      tenantId: 'org_avapardaz_sandbox',
      recordingId: body.recordingId ?? 'rec_sandbox_pii',
      actorId: 'studio_sandbox_operator',
    });
    res.json(report);
  });

  // ── CORE ASR Engine Independent API Routes (`/api/v1/asr-core/*`) ───────────
  app.get('/api/v1/asr-core/health', (_req, res) => {
    res.json(coreAsrRouter.getHealthAndProfile());
  });

  app.get('/api/v1/asr-core/router/audit', (_req, res) => {
    res.json({ audit: coreAsrRouter.listRecentRoutingAudit() });
  });

  app.post('/api/v1/asr-core/batch', (req, res) => {
    const body = (req.body ?? {}) as {
      filename?: string;
      audioBase64?: string;
      rawPcm16Hint?: boolean;
      languageHint?: DetectedLanguageTag | 'auto';
      longFormConfig?: Partial<LongFormConfig>;
    };
    if (typeof body.audioBase64 !== 'string' || body.audioBase64.trim().length === 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'audioBase64 is required' });
      return;
    }
    try {
      const routing = coreAsrRouter.routeInference({
        mode: body.longFormConfig ? 'long_form' : 'batch',
        languageHint: body.languageHint ?? 'auto',
      });
      const rawBytes = Buffer.from(body.audioBase64, 'base64');
      const result = coreAsrRouter.batchEngine.transcribeAudioBytes({
        filename: body.filename ?? 'upload.wav',
        rawBytes,
        rawPcm16Hint: Boolean(body.rawPcm16Hint),
        languageHint: body.languageHint ?? 'auto',
        longFormConfig: body.longFormConfig,
      });
      res.json({ routing, result });
    } catch (err) {
      res.status(422).json({
        error: 'CORE_ASR_INGEST_OR_DECODE_FAILED',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  app.post('/api/v1/asr-core/stream-sim', (req, res) => {
    const body = (req.body ?? {}) as {
      chunkDurationMs?: number;
      textProbe?: string;
      languageHint?: DetectedLanguageTag | 'auto';
    };
    const chunkMs = Math.max(20, Math.min(1000, Number(body.chunkDurationMs) || 250));
    const speech = synthesizeAcousticSpeechFromText(body.textProbe?.trim() || 'سلام امروز api آماده');
    const pad = new Float32Array(CORE_SAMPLE_RATE * 0.5);
    const full = new Float32Array(speech.length + pad.length);
    full.set(speech, 0);

    const created = coreAsrRouter.streamingManager.createSession({
      tenantId: 'org_avapardaz_sandbox',
      languageHint: body.languageHint ?? 'auto',
      streamingCategory: 'STATEFUL_CHUNKED_STREAMING',
      silenceEndpointMs: 320,
    });
    if (!created.accepted) {
      res.status(429).json(created);
      return;
    }

    const samplesPerChunk = Math.round((chunkMs / 1000) * CORE_SAMPLE_RATE);
    for (let pos = 0; pos < full.length; pos += samplesPerChunk) {
      const slice = full.subarray(pos, Math.min(full.length, pos + samplesPerChunk));
      coreAsrRouter.streamingManager.pushPcm16Chunk(created.sessionId, float32ToPcm16Buffer(slice));
    }
    const finalized = coreAsrRouter.streamingManager.finalizeSession(created.sessionId);
    res.json({
      sessionId: created.sessionId,
      chunkDurationMs: chunkMs,
      events: coreAsrRouter.streamingManager.getSessionEvents(created.sessionId),
      metrics: finalized.metrics,
    });
  });

  app.get('/api/v1/asr-core/benchmark', (req, res) => {
    const iters = Math.max(500, Math.min(5000, Number(req.query.iterations) || 1000));
    res.json(runCoreBenchmarkAndAdaptationSuite(iters));
  });

  // ── Unified Processing Engine Routes (`/api/v1/processing/*`) ──────────────
  app.get('/api/v1/processing/capabilities', async (_req, res, next) => {
    try {
      const report = await unifiedProcessingOrchestrator.discoverCapabilities();
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/processing/trace', (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json({ trace: unifiedProcessingOrchestrator.getExecutionTrace(limit) });
  });

  app.post('/api/v1/processing/execute', async (req, res) => {
    const abortCtrl = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortCtrl.abort();
    });
    try {
      const payload = req.body as UnifiedProcessingRequest;
      const result = await unifiedProcessingOrchestrator.execute(payload, abortCtrl.signal);
      res.json(result);
    } catch (err) {
      if (err instanceof UnifiedProcessingError) {
        const status =
          err.code === 'INVALID_PROCESSING_REQUEST'
            ? 400
            : err.code === 'UNSUPPORTED_AUDIO_FORMAT'
              ? 415
              : err.code === 'PROVIDER_AUTHENTICATION_FAILED'
                ? 401
                : err.code === 'PROVIDER_RATE_LIMITED'
                  ? 429
                  : err.code === 'PROVIDER_TIMEOUT'
                    ? 504
                    : err.code === 'PROCESSING_CANCELLED'
                      ? 499
                      : err.code === 'PROCESSING_RESOURCE_LIMIT_EXCEEDED'
                        ? 413
                        : err.code === 'LOCAL_RUNTIME_UNAVAILABLE' ||
                            err.code === 'CLOUD_PROVIDER_UNAVAILABLE'
                          ? 503
                          : 502;
        res.status(status).json({ error: err.toPayload() });
        return;
      }
      res.status(500).json({
        error: {
          code: 'PROCESSING_FAILED',
          messageEn: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
        },
      });
    }
  });

  // Sanitized JSON error handler for malformed JSON bodies and unexpected API errors
  app.use(
    ['/api', '/v1'],
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      if (err instanceof SyntaxError && 'body' in err) {
        res.status(400).json({
          error: 'INVALID_JSON',
          message: 'Malformed JSON request payload.',
        });
        return;
      }
      res.status(500).json({
        error: 'INTERNAL_API_ERROR',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    },
  );

  if (!IS_PROD) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          const normalized = filePath.replace(/\\/g, '/');
          if (normalized.endsWith('.wasm')) {
            res.setHeader('Content-Type', 'application/wasm');
          } else if (normalized.endsWith('.mjs') || normalized.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          }
          if (
            normalized.endsWith('/sw.js') ||
            normalized.endsWith('/index.html') ||
            normalized.endsWith('/manifest.webmanifest') ||
            normalized.endsWith('/release-manifest.json')
          ) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          } else if (normalized.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
        },
      }),
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Avapardaz Express+Vite server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
