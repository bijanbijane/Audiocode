import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { LocalCompanionService } from './src/host-bridge/companion/LocalCompanionService.ts';
import { createSmartAudioEditHttpRouter } from './src/workflow/SmartAudioEditHttpRouter.ts';
import {
  ShahabZipformerAsrRuntime,
} from './src/shahab/ShahabZipformerAsrRuntime.ts';
import { createShahabHttpRouter } from './src/shahab/ShahabHttpRouter.ts';
import {
  AudioApiSecurityGuard,
  resolveServerBindHost,
} from './src/security/AudioApiSecurityGuard.ts';
import { createLocalModelArtifactHttpRouter } from './src/lifecycle/LocalModelArtifactHttpRouter.ts';
import {
  forwardPlatformApiCompatibilityRequest,
  normalizeLegacyPlatformLeaseRequestBody,
} from './src/platform/PlatformApiCompatibilityProxy.ts';

interface SandboxStudioScope {
  readonly tenantId: string;
  readonly operatorId: string;
}

function getSandboxStudioScope(res: express.Response): SandboxStudioScope {
  const scope = res.locals.sandboxStudioScope as SandboxStudioScope | undefined;
  if (!scope) {
    throw new Error('SANDBOX_STUDIO_SCOPE_UNAVAILABLE');
  }
  return scope;
}

/**
 * Sandbox-only routes are disabled unless explicitly provisioned with a tenant,
 * operator, and high-entropy bearer token. No demo tenant identity is hardcoded
 * into the HTTP server, and production callers cannot reach these routes by
 * relying on implicit sample credentials.
 */
const requireSandboxStudioAccess: express.RequestHandler = (req, res, next) => {
  const enabled = process.env.ENABLE_SANDBOX_STUDIO_ROUTES === 'true';
  const tenantId = process.env.AVAPARDAZ_SANDBOX_TENANT_ID?.trim();
  const operatorId = process.env.AVAPARDAZ_SANDBOX_OPERATOR_ID?.trim();
  const expectedToken = process.env.AVAPARDAZ_SANDBOX_STUDIO_TOKEN ?? '';

  if (!enabled || !tenantId || !operatorId || expectedToken.length < 32) {
    res.status(404).json({ error: 'SANDBOX_STUDIO_DISABLED' });
    return;
  }

  const authorization = req.headers.authorization ?? '';
  const suppliedToken = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const suppliedBytes = Buffer.from(suppliedToken);
  const expectedBytes = Buffer.from(expectedToken);
  if (
    suppliedBytes.byteLength !== expectedBytes.byteLength ||
    !crypto.timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    res.status(401).json({ error: 'SANDBOX_STUDIO_UNAUTHORIZED' });
    return;
  }

  res.locals.sandboxStudioScope = { tenantId, operatorId } satisfies SandboxStudioScope;
  next();
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';
const RAW_PORT = process.env.PORT;
const COLLIDES_WITH_NGINX = Boolean(RAW_PORT && process.env.NGINX_PORT && RAW_PORT === process.env.NGINX_PORT);
const PORT =
  !IS_PROD || COLLIDES_WITH_NGINX
    ? Number(process.env.APP_PORT || process.env.DEFAULT_APP_PORT || 3000)
    : Number(process.env.APP_PORT || RAW_PORT || 3000);

async function startServer() {
  const app = express();

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
  const localCompanionService = new LocalCompanionService();
  const shahabZipformerRuntime = new ShahabZipformerAsrRuntime();
  const audioApiSecurityGuard = new AudioApiSecurityGuard();

  // The legacy Express signer belongs to Local compatibility only.
  // Hosted mode must not require or load the Local Ed25519 private key;
  // the Fastify Platform API is the sole Hosted signing authority.
  const localLicenseService =
    audioApiSecurityGuard.config.mode === 'local'
      ? new PlatformLicenseService({
          privateKeyPem: process.env.ED25519_PRIVATE_KEY_PEM,
          publicKeyPem: process.env.ED25519_PUBLIC_KEY_PEM,
          keyVersion: 1,
        })
      : null;
  const getLocalLicenseService = (): PlatformLicenseService => {
    if (!localLicenseService) {
      throw new Error('LOCAL_LICENSE_SIGNER_UNAVAILABLE_IN_HOSTED_MODE');
    }
    return localLicenseService;
  };
  const unifiedProcessingOrchestrator = new UnifiedProcessingOrchestrator({
    localAdapter: new LocalExecutionAdapter({
      coreRouter: coreAsrRouter,
      checkNeuralWeightsAvailable: () => {
        const status = localCompanionService.neuralEngine.getStatus();
        const primary =
          status.installedModels.find((m) => m.integrityVerified) ?? status.installedModels[0];
        return {
          available: status.available,
          modelId: primary?.modelId ?? null,
          modelVersion: primary?.quantization ?? null,
        };
      },
    }),
  });

  // Preserve Cross-Origin Isolation so SharedArrayBuffer & OPFS SyncAccessHandle remain active
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
  });

  // Process liveness only. Do not report local ASR readiness from this endpoint.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'LIVE',
      service: 'avapardaz-local-audio-runtime',
      localOnlyEnforced: true,
      cloudAsrEnabled: false,
    });
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

  // AVP-P01-006: Strict Local-Only ASR Enforcement — Cloud ASR / audio upload is permanently disabled.
  app.all('/api/v1/asr/transcribe', (req, res) => {
    req.resume();
    res.status(410).json({
      error: 'LOCAL_ONLY_ASR_POLICY_ENFORCED',
      code: 'LOCAL_ONLY_CLOUD_ASR_BLOCKED',
      localOnlyEnforced: true,
      message:
        'Cloud ASR audio upload (/api/v1/asr/transcribe) is permanently disabled by AVAPARDAZ Local-Only Policy (AVP-P01-006).',
      messageFa:
        'سرویس رونویسی ابری و ارسال صوت به سرور طبق سیاست ۱۰۰٪ محلی آواپرداز به‌طور کامل غیرفعال شده است.',
    });
  });

  app.all('/api/v1/asr/cloud-consents', (req, res) => {
    req.resume();
    res.status(410).json({
      error: 'LOCAL_ONLY_ASR_POLICY_ENFORCED',
      code: 'LOCAL_ONLY_CLOUD_ASR_BLOCKED',
      localOnlyEnforced: true,
      message: 'Cloud ASR consent issuance is disabled under AVAPARDAZ Local-Only Policy.',
    });
  });

  // Phase 1A: Ephemeral Local Session Bootstrap (active ONLY in Local/Desktop mode; 404 in Hosted mode)
  app.post('/api/local-auth/session', audioApiSecurityGuard.createLocalSessionEndpoint());

  // AVP-P08/P09/P10: Shared Local Companion Service (Loopback-only, HMAC IPC v1.0.0)
  // Isolated strictly to local mode; never exposed in Hosted Mode.
  if (audioApiSecurityGuard.config.mode === 'local') {
    app.use(
      '/api/v2/companion',
      localCompanionService.createExpressRouter({
        allowSameOriginProxyHost: audioApiSecurityGuard.config.allowSameOriginProxyHost,
      }),
    );
  } else {
    app.use('/api/v2/companion', (_req, res) => {
      res.status(404).json({
        error: 'COMPANION_LOCAL_ONLY',
        message: 'Native Companion IPC is only available in local/desktop mode.',
      });
    });
  }

  // AVP-SHAHAB-001 + Phase 1A: Hardened SHAHAB Zipformer-Transducer Execution Routes (/api/shahab/*)
  // Auth, Origin/Host/Loopback, Replay Defense & Rate/Concurrency Limits run BEFORE express.raw().
  app.use(
    '/api/shahab',
    createShahabHttpRouter({
      shahabZipformerRuntime,
      securityGuard: audioApiSecurityGuard,
    }),
  );

  // AVP-EXECUTION-001 + Phase 1A: Hardened 3-Engine Smart Audio Edit Vertical Slice (/api/v2/smart-edit/*)
  const { router: smartEditRouter } = createSmartAudioEditHttpRouter({
    neuralEngine: localCompanionService.neuralEngine,
    shahabZipformerRuntime,
    securityGuard: audioApiSecurityGuard,
  });
  app.use('/api/v2/smart-edit', smartEditRouter);

  app.use(express.json({ limit: '16mb' }));

  // In Hosted mode the Fastify Platform API is the sole key-discovery owner.
  // Keep the local demo signer only in Local mode for backward compatibility.
  app.get('/api/v1/crypto/public-key', (req, res) => {
    if (audioApiSecurityGuard.config.mode !== 'local') {
      void forwardPlatformApiCompatibilityRequest(req, res, {
        path: '/api/v1/crypto/public-key',
        method: 'GET',
      });
      return;
    }
    res.json(getLocalLicenseService().getPublicKeyInfo());
  });

  // Local/demo lease endpoint only. Hosted subscription issuance must use the
  // authenticated PostgreSQL Platform API; never trust a client-supplied plan/userId
  // on the legacy Express route in Hosted mode.
  app.post('/api/v1/license/lease', (req, res) => {
    if (audioApiSecurityGuard.config.mode !== 'local') {
      // Compatibility adapter: Fastify still performs the real Bearer/JWT,
      // PostgreSQL subscription, device-seat, and Ed25519 checks.
      req.body = normalizeLegacyPlatformLeaseRequestBody(req.body);
      void forwardPlatformApiCompatibilityRequest(req, res, {
        path: '/api/v1/license/lease',
        method: 'POST',
      });
      return;
    }

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

    const envelope = getLocalLicenseService().issueOfflineLicenseLease({
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
    if (audioApiSecurityGuard.config.mode !== 'local') {
      void forwardPlatformApiCompatibilityRequest(req, res, {
        path: `/api/v1/models/${encodeURIComponent(modelId)}/manifest`,
        method: 'GET',
      });
      return;
    }
    const override = req.query.status as ModelLifecycleStatus | undefined;
    const allowedStatuses: ModelLifecycleStatus[] = [
      'ACTIVE',
      'SUPPORTED',
      'DEPRECATED',
      'REVOKED',
    ];
    const validOverride =
      override && allowedStatuses.includes(override) ? override : undefined;

    const envelope = getLocalLicenseService().issueSignedModelManifestEnvelope(modelId, validOverride);
    if (!envelope) {
      res.status(404).json({ error: 'MODEL_NOT_FOUND', modelId });
      return;
    }

    res.json(envelope);
  });

  // Phase 1A.1: Hardened Public/Immutable Browser Model Artifact Router
  // Enforces manifest-only allowlist, realpath confinement, 1 MiB Range cap, multi-range rejection,
  // single-flight preparation lock, rate/concurrency limits, integrity verification, ETag & immutable cache.
  app.use(
    '/api/v1/local-models/shenava-rizen',
    createLocalModelArtifactHttpRouter({
      provider: localCompanionService.neuralEngine,
    }),
  );

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
    const neuralRuntime = localCompanionService.neuralEngine.getStatus();
    const verifiedModelCount = neuralRuntime.installedModels.filter((model) => model.integrityVerified).length;
    const provisioningBlockers = [
      ...(neuralRuntime.binaryPath ? [] : ['SHERPA_RUNTIME_BINARY_NOT_INSTALLED']),
      ...(verifiedModelCount > 0 ? [] : ['VERIFIED_LOCAL_MODEL_NOT_INSTALLED']),
    ];

    res.status(200).json({
      // API process liveness is separate from the native inference provisioning state.
      status: 'OK',
      apiStatus: 'LIVE',
      localInferenceProvisioningStatus: neuralRuntime.available ? 'PROVISIONED' : 'NOT_PROVISIONED',
      localInferenceProvisioned: neuralRuntime.available,
      localOnlyEnforced: true,
      cloudGeminiAsrConfigured: false,
      cloudAsrEnabled: false,
      neuralRuntime: {
        runtimeName: neuralRuntime.runtimeName,
        binaryAvailable: Boolean(neuralRuntime.binaryPath),
        verifiedModelCount,
        installedModelCount: neuralRuntime.installedModels.length,
        cpuThreads: neuralRuntime.cpuThreads,
        offlineOnlyEnforced: neuralRuntime.offlineOnlyEnforced,
        provisioningBlockers,
      },
      hardwareProfile: 'G0_CPU_ONLY',
      activeCheckpointId: activeCheckpoint.checkpointId,
      globalStep: activeCheckpoint.globalStep,
      releaseStatus: 'PHASE_01_LOCAL_FOUNDATION',
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
    const cap = out.body as { capabilityId: string; capabilityVersion: string };
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

  // Sandbox studio APIs require explicit environment provisioning and a bearer token.
  app.use('/api/v1/data-factory/sandbox', requireSandboxStudioAccess);
  app.use('/api/v1/model-factory/sandbox', requireSandboxStudioAccess);
  app.use('/api/v1/security/sandbox', requireSandboxStudioAccess);

  // ── Phase 12 Sandbox UI Routes (`/api/v1/data-factory/sandbox/*`) ───────────
  app.get('/api/v1/data-factory/sandbox/dashboard', async (_req, res, next) => {
    try {
      await dataFactoryGateway.service.ensureSandboxDemoSeeded(getSandboxStudioScope(res).tenantId);
      const tenantId = getSandboxStudioScope(res).tenantId;
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
      await dataFactoryGateway.service.ensureSandboxDemoSeeded(getSandboxStudioScope(res).tenantId);
      try {
        const report = dataFactoryGateway.service.revokeRecordingRights(getSandboxStudioScope(res).tenantId, req.params.recordingId);
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
      await dataFactoryGateway.service.ensureSandboxDemoSeeded(getSandboxStudioScope(res).tenantId);
      try {
        const body = (req.body ?? {}) as { version?: string; releaseType?: DatasetReleaseType };
        const version = body.version?.trim() || `v1.0.${Date.now() % 10000}`;
        const built = dataFactoryGateway.service.buildDatasetRelease({
          tenantId: getSandboxStudioScope(res).tenantId,
          datasetId: req.params.datasetId,
          version,
          releaseType: body.releaseType ?? 'TRAIN',
          releaseAuthor: getSandboxStudioScope(res).operatorId,
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
      await modelFactoryGateway.service.ensureSandboxDemoSeeded(getSandboxStudioScope(res).tenantId);
      res.json(modelFactoryGateway.service.getSandboxLifecycleSummary(getSandboxStudioScope(res).tenantId));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/model-factory/sandbox/deployments/:deploymentId/rollback', async (req, res, next) => {
    try {
      await modelFactoryGateway.service.ensureSandboxDemoSeeded(getSandboxStudioScope(res).tenantId);
      try {
        const result = modelFactoryGateway.service.rollbackDeployment({
          tenantId: getSandboxStudioScope(res).tenantId,
          deploymentId: req.params.deploymentId,
          actorId: getSandboxStudioScope(res).operatorId,
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
      await modelFactoryGateway.service.ensureSandboxDemoSeeded(getSandboxStudioScope(res).tenantId);
      try {
        const result = modelFactoryGateway.service.optimizeAndRegisterDerivedVersion({
          tenantId: getSandboxStudioScope(res).tenantId,
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
      await modelFactoryGateway.service.ensureSandboxDemoSeeded(getSandboxStudioScope(res).tenantId);
      res.json(speechSecurityService.getSandboxSecurityOverview(getSandboxStudioScope(res).tenantId));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/security/sandbox/red-team/run', async (_req, res, next) => {
    try {
      await modelFactoryGateway.service.ensureSandboxDemoSeeded(getSandboxStudioScope(res).tenantId);
      res.json({ groups: speechSecurityService.runFullRedTeamVerificationSuite(getSandboxStudioScope(res).tenantId) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/security/sandbox/pii-redact', (req, res) => {
    const body = (req.body ?? {}) as { recordingId?: string; originalTranscript?: string };
    const derivative = speechSecurityService.createPiiDerivative({
      tenantId: getSandboxStudioScope(res).tenantId,
      recordingId: body.recordingId ?? 'rec_sandbox_pii',
      originalTranscript: body.originalTranscript ?? '',
      actorId: getSandboxStudioScope(res).operatorId,
    });
    res.status(201).json(derivative);
  });

  app.post('/api/v1/security/sandbox/prompt-boundary-test', (req, res) => {
    const body = (req.body ?? {}) as { transcriptText?: string };
    const env = speechSecurityService.protectTranscriptAndCheckTool({
      tenantId: getSandboxStudioScope(res).tenantId,
      recordingId: 'rec_sandbox_prompt_probe',
      rawTranscriptText: body.transcriptText ?? '',
      actorId: getSandboxStudioScope(res).operatorId,
    });
    const toolDecision = speechSecurityService.authorizeIntelligenceToolCall({
      triggerOrigin: 'TRANSCRIPT_TEXT_EXTRACTION',
      actorPrincipalId: getSandboxStudioScope(res).operatorId,
      actorTenantId: getSandboxStudioScope(res).tenantId,
      targetTenantId: getSandboxStudioScope(res).tenantId,
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
      tenantId: getSandboxStudioScope(res).tenantId,
      recordingId: body.recordingId ?? 'rec_sandbox_pii',
      actorId: getSandboxStudioScope(res).operatorId,
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

  app.post('/api/v1/asr-core/stream-sim', requireSandboxStudioAccess, (req, res) => {
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
      tenantId: getSandboxStudioScope(res).tenantId,
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

  // ── SHAHAB Persistent Observatory & Operations API (SHAHAB-002 .. SHAHAB-021) ──
  const SHAHAB_DOCS_ROOT = path.resolve(process.cwd(), 'docs', 'shahab');
  const readShahabJsonSafe = (relativeName: string): unknown => {
    const resolved = path.resolve(SHAHAB_DOCS_ROOT, relativeName);
    if (!resolved.startsWith(SHAHAB_DOCS_ROOT + path.sep)) return null;
    if (!fs.existsSync(resolved)) return null;
    try {
      return JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch {
      return null;
    }
  };
  const readShahabJsonlSafe = (relativeName: string, limit = 120): unknown[] => {
    const resolved = path.resolve(SHAHAB_DOCS_ROOT, relativeName);
    if (!resolved.startsWith(SHAHAB_DOCS_ROOT + path.sep)) return [];
    if (!fs.existsSync(resolved)) return [];
    try {
      const lines = fs
        .readFileSync(resolved, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      return lines.slice(-limit).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { parseError: true };
        }
      });
    } catch {
      return [];
    }
  };
  const writeShahabJsonAtomic = (relativeName: string, value: unknown): void => {
    const resolved = path.resolve(SHAHAB_DOCS_ROOT, relativeName);
    if (!resolved.startsWith(SHAHAB_DOCS_ROOT + path.sep)) {
      throw new Error('Path traversal rejected for SHAHAB persistence.');
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const tmpPath = `${resolved}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmpPath, resolved);
  };
  const appendShahabJsonl = (relativeName: string, entry: Record<string, unknown>): void => {
    const resolved = path.resolve(SHAHAB_DOCS_ROOT, relativeName);
    if (!resolved.startsWith(SHAHAB_DOCS_ROOT + path.sep)) {
      throw new Error('Path traversal rejected for SHAHAB JSONL append.');
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, `${JSON.stringify(entry)}\n`, 'utf8');
  };

  // Phase 1A: Protect Shahab operational & context-memory routes with deployment-mode security guard
  app.use(
    ['/api/shahab/state', '/api/shahab/memory', '/api/shahab/operations'],
    audioApiSecurityGuard.middleware({
      requireAuth: audioApiSecurityGuard.config.mode === 'hosted',
      rateLimitBucket: 'shahab-ops',
      rateLimitMax: 60,
    }),
  );

  app.get('/api/shahab/state', (_req, res) => {
    const implementationState = readShahabJsonSafe('SHAHAB_IMPLEMENTATION_STATE.json');
    const consentRecords = readShahabJsonSafe('SHAHAB_CONSENT_RECORDS.json');
    const operationalState = readShahabJsonSafe('SHAHAB_OPERATIONAL_STATE.json');
    const releaseManifest = readShahabJsonSafe('SHAHAB_RELEASE_MANIFEST.json');
    const sbom = readShahabJsonSafe('SHAHAB_SBOM.json');
    const resilienceState = readShahabJsonSafe('SHAHAB_RESILIENCE_STATE.json');
    const faultInjectionResults = readShahabJsonSafe('SHAHAB_FAULT_INJECTION_RESULTS.json');
    const restoreReports = readShahabJsonSafe('SHAHAB_RESTORE_VERIFICATION_REPORTS.json');
    const performanceState = readShahabJsonSafe('SHAHAB_PERFORMANCE_STATE.json');
    const streamingState = readShahabJsonSafe('SHAHAB_STREAMING_STATE.json');
    const runtimeState = readShahabJsonSafe('SHAHAB_RUNTIME_STATE.json');
    const persianFidelityState = readShahabJsonSafe('SHAHAB_PERSIAN_FIDELITY_STATE.json');
    const compactModelState = readShahabJsonSafe('SHAHAB_COMPACT_MODEL_STATE.json');
    const systemQualificationState = readShahabJsonSafe('SHAHAB_SYSTEM_QUALIFICATION_STATE.json');
    const sdkState = readShahabJsonSafe('SHAHAB_SDK_STATE.json');
    const avapardazIntegrationState = readShahabJsonSafe('SHAHAB_AVAPARDAZ_INTEGRATION_STATE.json');
    const adobeIntegrationState = readShahabJsonSafe('SHAHAB_ADOBE_INTEGRATION_STATE.json');
    const evidenceLedger = readShahabJsonlSafe('SHAHAB_EVIDENCE_LEDGER.jsonl', 150);
    const runtimeEvents = readShahabJsonlSafe('SHAHAB_RUNTIME_EVENTS.jsonl', 150);

    res.json({
      available: Boolean(implementationState),
      implementationState,
      consentRecords,
      operationalState,
      releaseManifest,
      sbom,
      resilienceState,
      faultInjectionResults,
      restoreReports,
      performanceState,
      streamingState,
      runtimeState,
      persianFidelityState,
      compactModelState,
      systemQualificationState,
      sdkState,
      avapardazIntegrationState,
      adobeIntegrationState,
      evidenceLedger,
      runtimeEvents,
    });
  });

  app.post('/api/shahab/memory', (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const rawTerm = typeof body?.term === 'string' ? body.term.trim() : '';
    const scopeRaw = typeof body?.scope === 'string' ? body.scope : 'PROJECT';
    const categoryRaw = typeof body?.category === 'string' ? body.category : 'DOMAIN_TERM';
    const verificationStatusRaw =
      typeof body?.verificationStatus === 'string' ? body.verificationStatus : 'USER_VERIFIED';

    const allowedScopes = new Set(['SESSION', 'PROJECT', 'WORKSPACE', 'USER']);
    const allowedCategories = new Set(['PROPER_NOUN', 'TECHNICAL_TERM', 'DOMAIN_TERM', 'BRAND_OR_ACRONYM', 'COLLOQUIAL_FORM']);
    const allowedStatuses = new Set(['USER_VERIFIED', 'UNVERIFIED_CANDIDATE', 'ADMIN_APPROVED']);

    if (!rawTerm || rawTerm.length > 120) {
      res.status(400).json({ error: 'INVALID_TERM', message: 'Persian context term must be 1..120 characters.' });
      return;
    }
    if (!allowedScopes.has(scopeRaw) || !allowedCategories.has(categoryRaw) || !allowedStatuses.has(verificationStatusRaw)) {
      res.status(400).json({ error: 'INVALID_MEMORY_METADATA', message: 'Invalid scope, category, or verificationStatus.' });
      return;
    }

    const state = (readShahabJsonSafe('SHAHAB_IMPLEMENTATION_STATE.json') as Record<string, unknown> | null) ?? {};
    const existingMem = (state.persianContextMemory as Record<string, unknown> | undefined) ?? { entries: [] };
    const existingEntries = Array.isArray(existingMem.entries) ? [...existingMem.entries] : [];

    const nowUtc = new Date().toISOString();
    const entry = {
      entryId: `mem_${crypto.randomBytes(4).toString('hex')}`,
      term: rawTerm,
      canonicalSurface: rawTerm.replace(/\u064A/g, '\u06CC').replace(/\u0643/g, '\u06A9'),
      scope: scopeRaw,
      category: categoryRaw,
      verificationStatus: verificationStatusRaw,
      boostWeight: typeof body?.boostWeight === 'number' && Number.isFinite(body.boostWeight)
        ? Math.max(0.1, Math.min(2.0, body.boostWeight))
        : 1.0,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
      source: 'SHAHAB_LAB_UI',
    };

    const nextEntries = [entry, ...existingEntries];
    const nextState = {
      ...state,
      updatedAtUtc: nowUtc,
      persianContextMemory: {
        ...existingMem,
        entries: nextEntries,
      },
    };
    writeShahabJsonAtomic('SHAHAB_IMPLEMENTATION_STATE.json', nextState);
    appendShahabJsonl('SHAHAB_EVIDENCE_LEDGER.jsonl', {
      eventId: `evt_${crypto.randomBytes(6).toString('hex')}`,
      timestampUtc: nowUtc,
      missionId: 'SHAHAB-008',
      eventType: 'PERSIAN_CONTEXT_MEMORY_ADDED',
      evidenceStatus: 'VERIFIED',
      summary: `Added Persian context memory term (${scopeRaw}/${verificationStatusRaw}).`,
      details: { entryId: entry.entryId, scope: scopeRaw, category: categoryRaw, verificationStatus: verificationStatusRaw },
    });

    res.status(201).json({ entry, totalEntries: nextEntries.length });
  });

  app.delete('/api/shahab/memory/:entryId', (req, res) => {
    const entryId = String(req.params.entryId || '').trim();
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(entryId)) {
      res.status(400).json({ error: 'INVALID_ENTRY_ID', message: 'Invalid memory entry identifier.' });
      return;
    }
    const state = (readShahabJsonSafe('SHAHAB_IMPLEMENTATION_STATE.json') as Record<string, unknown> | null) ?? {};
    const existingMem = (state.persianContextMemory as Record<string, unknown> | undefined) ?? { entries: [] };
    const existingEntries = Array.isArray(existingMem.entries) ? existingMem.entries : [];
    const filtered = existingEntries.filter(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>).entryId !== entryId &&
        (item as Record<string, unknown>).id !== entryId,
    );

    const nowUtc = new Date().toISOString();
    const nextState = {
      ...state,
      updatedAtUtc: nowUtc,
      persianContextMemory: {
        ...existingMem,
        entries: filtered,
      },
    };
    writeShahabJsonAtomic('SHAHAB_IMPLEMENTATION_STATE.json', nextState);
    appendShahabJsonl('SHAHAB_EVIDENCE_LEDGER.jsonl', {
      eventId: `evt_${crypto.randomBytes(6).toString('hex')}`,
      timestampUtc: nowUtc,
      missionId: 'SHAHAB-008',
      eventType: 'PERSIAN_CONTEXT_MEMORY_DELETED',
      evidenceStatus: 'VERIFIED',
      summary: `Removed Persian context memory entry ${entryId}.`,
      details: { entryId, remainingCount: filtered.length },
    });

    res.json({ deleted: existingEntries.length !== filtered.length, remainingCount: filtered.length });
  });

  app.post('/api/shahab/operations/consent', (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const nowUtc = new Date().toISOString();
    const existingConsent = (readShahabJsonSafe('SHAHAB_CONSENT_RECORDS.json') as Record<string, unknown> | null) ?? {};
    const current = (existingConsent.currentConsent as Record<string, unknown> | undefined) ?? {
      localDiagnosticsEnabled: true,
      externalAnonymizedMetricsOptIn: false,
      crashDiagnosticsOptIn: false,
      humanFeedbackResearchOptIn: false,
      revokedByUser: false,
    };

    const nextConsent = {
      localDiagnosticsEnabled:
        typeof body?.localDiagnosticsEnabled === 'boolean'
          ? body.localDiagnosticsEnabled
          : Boolean(current.localDiagnosticsEnabled ?? true),
      externalAnonymizedMetricsOptIn:
        typeof body?.externalAnonymizedMetricsOptIn === 'boolean'
          ? body.externalAnonymizedMetricsOptIn
          : Boolean(current.externalAnonymizedMetricsOptIn ?? false),
      crashDiagnosticsOptIn:
        typeof body?.crashDiagnosticsOptIn === 'boolean'
          ? body.crashDiagnosticsOptIn
          : Boolean(current.crashDiagnosticsOptIn ?? false),
      humanFeedbackResearchOptIn:
        typeof body?.humanFeedbackResearchOptIn === 'boolean'
          ? body.humanFeedbackResearchOptIn
          : Boolean(current.humanFeedbackResearchOptIn ?? false),
      revokedByUser:
        typeof body?.revokedByUser === 'boolean'
          ? body.revokedByUser
          : false,
      updatedAtUtc: nowUtc,
    };

    if (nextConsent.revokedByUser) {
      nextConsent.externalAnonymizedMetricsOptIn = false;
      nextConsent.crashDiagnosticsOptIn = false;
      nextConsent.humanFeedbackResearchOptIn = false;
    }

    const history = Array.isArray(existingConsent.history) ? [...existingConsent.history] : [];
    history.push({ ...nextConsent, actor: 'LOCAL_USER_UI' });

    const consentDoc = {
      schemaVersion: '1.0.0',
      updatedAtUtc: nowUtc,
      currentConsent: nextConsent,
      history: history.slice(-50),
    };
    writeShahabJsonAtomic('SHAHAB_CONSENT_RECORDS.json', consentDoc);

    const opState = (readShahabJsonSafe('SHAHAB_OPERATIONAL_STATE.json') as Record<string, unknown> | null);
    if (opState) {
      writeShahabJsonAtomic('SHAHAB_OPERATIONAL_STATE.json', {
        ...opState,
        updatedAtUtc: nowUtc,
        privacyConsent: nextConsent,
      });
    }

    appendShahabJsonl('SHAHAB_RUNTIME_EVENTS.jsonl', {
      eventId: `op_${crypto.randomBytes(6).toString('hex')}`,
      timestampUtc: nowUtc,
      eventType: nextConsent.revokedByUser ? 'PRIVACY_CONSENT_REVOKED' : 'PRIVACY_CONSENT_UPDATED',
      severity: 'INFO',
      fields: {
        localDiagnosticsEnabled: nextConsent.localDiagnosticsEnabled,
        externalAnonymizedMetricsOptIn: nextConsent.externalAnonymizedMetricsOptIn,
        crashDiagnosticsOptIn: nextConsent.crashDiagnosticsOptIn,
        humanFeedbackResearchOptIn: nextConsent.humanFeedbackResearchOptIn,
        revokedByUser: nextConsent.revokedByUser,
      },
    });

    res.json({ consent: nextConsent, historyCount: consentDoc.history.length });
  });

  app.post('/api/shahab/operations/diagnostic-export', (_req, res) => {
    const nowUtc = new Date().toISOString();
    const opState = (readShahabJsonSafe('SHAHAB_OPERATIONAL_STATE.json') as Record<string, unknown> | null) ?? {};
    const qualState = (readShahabJsonSafe('SHAHAB_SYSTEM_QUALIFICATION_STATE.json') as Record<string, unknown> | null) ?? {};
    const runtimeEvents = readShahabJsonlSafe('SHAHAB_RUNTIME_EVENTS.jsonl', 50);

    // Strictly sanitized bundle: zero raw transcripts, zero audio buffers, zero user vocabulary, zero file paths
    const sanitizedBundle = {
      exportedAtUtc: nowUtc,
      sanitizationPolicy: 'ZERO_RAW_TRANSCRIPT_ZERO_AUDIO_ZERO_USER_VOCAB_ZERO_LOCAL_PATHS',
      privacyConsent: opState.privacyConsent ?? null,
      releaseDecision: (qualState.releaseDecision as Record<string, unknown> | undefined)?.primaryDecision ?? null,
      recentSanitizedEventsCount: runtimeEvents.length,
      recentSanitizedEventTypes: runtimeEvents.map((e) =>
        typeof e === 'object' && e !== null ? (e as Record<string, unknown>).eventType ?? 'UNKNOWN' : 'UNKNOWN',
      ),
    };
    res.json(sanitizedBundle);
  });

  app.delete('/api/shahab/operations/local-diagnostics', (_req, res) => {
    const resolved = path.resolve(SHAHAB_DOCS_ROOT, 'SHAHAB_RUNTIME_EVENTS.jsonl');
    if (resolved.startsWith(SHAHAB_DOCS_ROOT + path.sep) && fs.existsSync(resolved)) {
      fs.writeFileSync(resolved, '', 'utf8');
    }
    res.json({ cleared: true, clearedAtUtc: new Date().toISOString() });
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
    // The API can run independently of the browser app. In that mode, Vite
    // owns the web origin and proxies /api and /v1 requests to this server.
    if (process.env.DISABLE_EMBEDDED_VITE !== 'true') {
      // Load Vite only for the legacy combined dev server. API-only mode must
      // not resolve or initialize any frontend development-server dependency.
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
      app.use(vite.middlewares);
    }
  } else if (process.env.DISABLE_WEB_HOST !== 'true') {
    // Production API-only deployments leave static asset hosting to the web tier.
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

  const bindHost = resolveServerBindHost(process.env, audioApiSecurityGuard.config);
  const webServingEnabled = IS_PROD
    ? process.env.DISABLE_WEB_HOST !== 'true'
    : process.env.DISABLE_EMBEDDED_VITE !== 'true';
  app.listen(PORT, bindHost, () => {
    console.log(
      `Avapardaz Express API listening on http://${bindHost}:${PORT} (mode=${audioApiSecurityGuard.config.mode}, webServing=${webServingEnabled})`,
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
