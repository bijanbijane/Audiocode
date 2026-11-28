/**
 * AVAPARDAZ — MODULAR BACKEND API ROUTER (`/api/v2/*`)
 *
 * Compliant with AVP-ARCH-001 (Version 4.0):
 * - Exposes the single authoritative Processing Core via Canonical Capability Envelopes (v2.0.0)
 * - Async Job Lifecycle with Idempotency, Cancellation, and TTL Expiration
 * - Host-Neutral Canonical Project & Non-Destructive Edit Plan Commit/Rollback with Stale-Revision Guard
 * - Isolated Adobe Audition Host Capability Matrix & SESX v1.9 Exporter/Validator
 * - Loopback-enforced, Versioned, HMAC-Authenticated Companion IPC Bridge for Plugin Panel
 */

import express from 'express';
import {
  UnifiedProcessingError,
  UnifiedProcessingOrchestrator,
} from '../processing-engine';
import {
  CanonicalCapabilityId,
  CanonicalOperationEnvelope,
  CANONICAL_CONTRACT_VERSION,
} from '../processing-engine/capabilities/CanonicalCapabilityContracts';
import { ProcessingCapabilityRegistry } from '../processing-engine/capabilities/CapabilityRegistry';
import { ProcessingJobManager } from '../processing-engine/capabilities/ProcessingJobManager';
import {
  CanonicalProjectService,
  ProjectServiceError,
} from '../host-bridge/CanonicalProjectService';
import { AdobeAuditionHostAdapter } from '../host-bridge/audition/AuditionHostAdapter';
import {
  CompanionHandshakeRequest,
  CompanionIpcBridge,
} from '../host-bridge/companion/CompanionIpcBridge';
import { sanitizeSecurityTelemetry as sanitizePublicErrorOutput } from '../security/PrivacyRetentionAndIsolationEngine';

export interface AvapardazBackendServicesBundle {
  readonly capabilityRegistry: ProcessingCapabilityRegistry;
  readonly jobManager: ProcessingJobManager;
  readonly projectService: CanonicalProjectService;
  readonly auditionHostAdapter: AdobeAuditionHostAdapter;
  readonly companionIpcBridge: CompanionIpcBridge;
}

export interface CreateAvapardazBackendRouterOptions {
  readonly orchestrator?: UnifiedProcessingOrchestrator;
  readonly services?: Partial<AvapardazBackendServicesBundle>;
  /** Optional DI hook for unit tests only; defaults strictly to req.socket.remoteAddress */
  readonly resolveRemoteAddress?: (req: express.Request) => string | undefined;
}

function isAllowedCompanionHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader || typeof hostHeader !== 'string') return false;
  try {
    const parsed = new URL(`http://${hostHeader.trim()}`);
    return (
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === '/' &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isAllowedCompanionOrigin(originHeader: string | undefined): boolean {
  if (originHeader === undefined || originHeader === '' || originHeader === 'null') return true;
  if (originHeader.trim().toLowerCase().startsWith('file://')) return true;
  try {
    const parsed = new URL(originHeader);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === '/' &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function mapUnifiedErrorStatus(err: UnifiedProcessingError): number {
  switch (err.code) {
    case 'INVALID_PROCESSING_REQUEST':
      return 400;
    case 'UNSUPPORTED_AUDIO_FORMAT':
      return 415;
    case 'PROVIDER_AUTHENTICATION_FAILED':
      return 401;
    case 'PROVIDER_RATE_LIMITED':
      return 429;
    case 'PROVIDER_TIMEOUT':
      return 504;
    case 'PROCESSING_CANCELLED':
      return 499;
    case 'PROCESSING_RESOURCE_LIMIT_EXCEEDED':
      return 413;
    case 'LOCAL_RUNTIME_UNAVAILABLE':
    case 'CLOUD_PROVIDER_UNAVAILABLE':
      return 503;
    default:
      return 502;
  }
}

export function createAvapardazBackendRouter(options?: CreateAvapardazBackendRouterOptions): {
  readonly router: express.Router;
  readonly services: AvapardazBackendServicesBundle;
} {
  const capabilityRegistry =
    options?.services?.capabilityRegistry ??
    new ProcessingCapabilityRegistry(options?.orchestrator);
  const jobManager =
    options?.services?.jobManager ?? new ProcessingJobManager({ registry: capabilityRegistry });
  const projectService = options?.services?.projectService ?? new CanonicalProjectService();
  const auditionHostAdapter =
    options?.services?.auditionHostAdapter ?? new AdobeAuditionHostAdapter();
  const companionIpcBridge =
    options?.services?.companionIpcBridge ?? new CompanionIpcBridge();

  const services: AvapardazBackendServicesBundle = {
    capabilityRegistry,
    jobManager,
    projectService,
    auditionHostAdapter,
    companionIpcBridge,
  };

  const router = express.Router();

  // ── 1. Health & Architectural Metadata ────────────────────────────────────
  router.get('/health', async (_req, res, next) => {
    try {
      const capabilities = await capabilityRegistry.listCapabilities();
      res.json({
        status: 'READY',
        policy_id: 'AVP-ARCH-001',
        policy_version: '4.0',
        contract_version: CANONICAL_CONTRACT_VERSION,
        primary_host: 'adobe-audition',
        execution_model: 'PLUGIN_FIRST_LOCAL_FIRST_UNIFIED',
        registered_capabilities: capabilities.length,
        active_projects: projectService.listProjects().length,
        tracked_jobs: jobManager.getTrackedJobCount(),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── 2. Authoritative Capability Registry & Direct Execution ───────────────
  router.get('/capabilities', async (_req, res, next) => {
    try {
      const capabilities = await capabilityRegistry.listCapabilities();
      res.json({
        contract_version: CANONICAL_CONTRACT_VERSION,
        capabilities,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/capabilities/:capabilityId', async (req, res, next) => {
    try {
      const cap = await capabilityRegistry.getCapability(
        req.params.capabilityId as CanonicalCapabilityId,
      );
      if (!cap) {
        res.status(404).json({
          error: 'CAPABILITY_NOT_FOUND',
          message: `Unknown capability "${req.params.capabilityId}".`,
        });
        return;
      }
      res.json(cap);
    } catch (err) {
      next(err);
    }
  });

  router.post('/capabilities/execute', async (req, res) => {
    const abortCtrl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abortCtrl.abort();
    });
    try {
      const envelope = req.body as CanonicalOperationEnvelope;
      const result = await capabilityRegistry.executeEnvelope(envelope, abortCtrl.signal);
      res.json(result);
    } catch (err) {
      if (err instanceof UnifiedProcessingError) {
        res.status(mapUnifiedErrorStatus(err)).json({ error: err.toPayload() });
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

  // ── 3. Explicit Async Job Lifecycle (Queued/Running/Completed/Cancelled) ──
  router.post('/jobs', (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        envelope?: CanonicalOperationEnvelope;
        defer_execution_ms?: unknown;
      };
      if (
        body.defer_execution_ms !== undefined &&
        (typeof body.defer_execution_ms !== 'number' ||
          !Number.isFinite(body.defer_execution_ms) ||
          body.defer_execution_ms < 0 ||
          body.defer_execution_ms > 5_000)
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'defer_execution_ms must be a finite number between 0 and 5000.',
        });
        return;
      }
      const envelope = body.envelope ?? (req.body as CanonicalOperationEnvelope);
      const { job, deduplicated } = jobManager.submitJob(envelope, {
        deferExecutionMs: body.defer_execution_ms as number | undefined,
      });
      res.status(deduplicated ? 200 : 202).json({
        deduplicated,
        job,
      });
    } catch (err) {
      if (err instanceof UnifiedProcessingError) {
        res.status(mapUnifiedErrorStatus(err)).json({ error: err.toPayload() });
        return;
      }
      res.status(400).json({
        error: 'JOB_SUBMISSION_FAILED',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  router.get('/jobs', (req, res) => {
    const limit = Math.max(1, Math.min(200, Math.floor(Number(req.query.limit)) || 50));
    res.json({ jobs: jobManager.listJobs(limit) });
  });

  router.get('/jobs/:jobId', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'JOB_NOT_FOUND', message: `Job "${req.params.jobId}" not found.` });
      return;
    }
    res.json({ job });
  });

  router.post('/jobs/:jobId/cancel', (req, res) => {
    const job = jobManager.cancelJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'JOB_NOT_FOUND', message: `Job "${req.params.jobId}" not found.` });
      return;
    }
    res.json({ job });
  });

  // ── 4. Host-Neutral Projects, Non-Destructive Edit Plans & Rollback ───────
  router.get('/projects', (_req, res) => {
    res.json({ projects: projectService.listProjects() });
  });

  router.post('/projects', (req, res) => {
    try {
      const project = projectService.createProject(req.body ?? {});
      res.status(201).json({ project });
    } catch (err) {
      if (err instanceof ProjectServiceError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
      }
      res.status(400).json({
        error: 'INVALID_PROJECT_INPUT',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  router.get('/projects/:projectId', (req, res) => {
    const project = projectService.getProject(req.params.projectId);
    if (!project) {
      res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: `Project "${req.params.projectId}" not found.` });
      return;
    }
    res.json({ project });
  });

  router.post('/projects/:projectId/media', (req, res) => {
    try {
      const project = projectService.registerMedia(req.params.projectId, req.body ?? {});
      res.status(201).json({ project });
    } catch (err) {
      if (err instanceof ProjectServiceError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
      }
      res.status(400).json({
        error: 'INVALID_MEDIA_INPUT',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  router.post('/projects/:projectId/edit-plans', (req, res) => {
    try {
      const plan = projectService.createEditPlan(req.params.projectId, req.body ?? {});
      res.status(201).json({ edit_plan: plan });
    } catch (err) {
      if (err instanceof ProjectServiceError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
      }
      res.status(400).json({
        error: 'INVALID_EDIT_PLAN',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  router.post('/projects/:projectId/edit-plans/:planId/approve', (req, res) => {
    try {
      const body = (req.body ?? {}) as { approved_item_ids?: unknown };
      if (
        body.approved_item_ids !== undefined &&
        (!Array.isArray(body.approved_item_ids) ||
          !body.approved_item_ids.every((id) => typeof id === 'string'))
      ) {
        res.status(400).json({
          error: 'INVALID_PROJECT_INPUT',
          message: 'approved_item_ids must be an array of strings when provided.',
        });
        return;
      }
      const plan = projectService.approveEditPlan(
        req.params.projectId,
        req.params.planId,
        body.approved_item_ids,
      );
      res.json({ edit_plan: plan });
    } catch (err) {
      if (err instanceof ProjectServiceError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
      }
      res.status(400).json({
        error: 'APPROVAL_FAILED',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  router.post('/projects/:projectId/edit-plans/:planId/commit', (req, res) => {
    try {
      const body = (req.body ?? {}) as { expected_revision?: unknown };
      if (
        body.expected_revision !== undefined &&
        (!Number.isInteger(body.expected_revision) || (body.expected_revision as number) < 1)
      ) {
        res.status(400).json({
          error: 'INVALID_PROJECT_INPUT',
          message: 'expected_revision must be a positive integer when provided.',
        });
        return;
      }
      const committed = projectService.commitEditPlan(
        req.params.projectId,
        req.params.planId,
        body.expected_revision as number | undefined,
      );
      res.json(committed);
    } catch (err) {
      if (err instanceof ProjectServiceError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
      }
      res.status(400).json({
        error: 'COMMIT_FAILED',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  router.post('/projects/:projectId/rollback', (req, res) => {
    try {
      const body = (req.body ?? {}) as { target_revision?: unknown };
      if (!Number.isInteger(body.target_revision) || (body.target_revision as number) < 1) {
        res.status(400).json({
          error: 'INVALID_PROJECT_INPUT',
          message: 'target_revision must be a positive integer.',
        });
        return;
      }
      const project = projectService.rollbackToRevision(
        req.params.projectId,
        body.target_revision as number,
      );
      res.json({ project });
    } catch (err) {
      if (err instanceof ProjectServiceError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
      }
      res.status(400).json({
        error: 'ROLLBACK_FAILED',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  // ── 5. Isolated Adobe Audition Host Adapter & SESX Interchange ────────────
  router.get('/hosts/audition/capabilities', (_req, res) => {
    res.json({
      host_id: auditionHostAdapter.hostId,
      adapter_version: auditionHostAdapter.adapterVersion,
      capabilities: auditionHostAdapter.getHostCapabilityMatrix(),
    });
  });

  router.post('/hosts/audition/sesx/export', (req, res) => {
    const body = (req.body ?? {}) as { project_id?: unknown };
    if (typeof body.project_id !== 'string' || body.project_id.trim().length === 0) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: 'project_id string is required.' });
      return;
    }
    const project = projectService.getProject(body.project_id.trim());
    if (!project) {
      res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: `Project "${body.project_id.trim()}" not found.` });
      return;
    }
    res.json(auditionHostAdapter.exportCanonicalProjectToSesx(project));
  });

  router.post('/hosts/audition/sesx/validate', (req, res) => {
    const body = (req.body ?? {}) as { sesx_xml?: string };
    if (typeof body.sesx_xml !== 'string' || body.sesx_xml.trim().length === 0) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: 'sesx_xml string is required.' });
      return;
    }
    res.json({ validation: auditionHostAdapter.validateSesxDocument(body.sesx_xml) });
  });

  // ── 6. Plugin-to-Companion Loopback-Protected Versioned IPC Bridge ────────
  const getRemoteAddr = (req: express.Request): string | undefined =>
    options?.resolveRemoteAddress ? options.resolveRemoteAddress(req) : req.socket.remoteAddress;
  const isAllowedCompanionRequest = (req: express.Request, res: express.Response): boolean => {
    const secFetchSite = typeof req.headers['sec-fetch-site'] === 'string'
      ? req.headers['sec-fetch-site'].trim().toLowerCase()
      : undefined;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim().toLowerCase() : undefined;
    const crossContextNullOrigin = origin === 'null' && secFetchSite !== undefined && secFetchSite !== 'none';
    if (
      secFetchSite === 'cross-site' ||
      crossContextNullOrigin ||
      !isAllowedCompanionHostHeader(req.headers.host) ||
      !isAllowedCompanionOrigin(req.headers.origin)
    ) {
      res.status(403).json({ error: 'COMPANION_ORIGIN_BLOCKED', message: 'Companion IPC requires an approved loopback Host and Origin.' });
      return false;
    }
    return true;
  };

  router.post('/companion/handshake', (req, res) => {
    if (!isAllowedCompanionRequest(req, res)) return;
    const outcome = companionIpcBridge.handshake(
      (req.body ?? {}) as CompanionHandshakeRequest,
      getRemoteAddr(req),
    );
    res.status(outcome.statusCode).json(outcome.body);
  });

  router.post('/companion/ipc', async (req, res) => {
    if (!isAllowedCompanionRequest(req, res)) return;
    const authHeader = req.headers.authorization;
    const bearer =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : null;

    const auth = companionIpcBridge.verifyAuthorizedIpcCall({
      remoteAddress: getRemoteAddr(req),
      bearerToken: bearer,
      envelope: req.body,
    });

    if (!auth.ok || !auth.envelope) {
      res.status(auth.statusCode).json({ error: auth.code, message: auth.message });
      return;
    }

    const sessionOwnerId = typeof auth.ownerId === 'string' ? auth.ownerId.trim() : '';
    if (!sessionOwnerId) {
      res.status(403).json({ error: 'IPC_OWNER_REQUIRED', message: 'Authenticated Companion owner identity is required.' });
      return;
    }

    try {
      switch (auth.envelope.command) {
        case 'CAPABILITY_LIST':
          res.json({ capabilities: await capabilityRegistry.listCapabilities() });
          return;
        case 'HOST_CAPABILITY_MATRIX':
          res.json({
            host_id: auditionHostAdapter.hostId,
            adapter_version: auditionHostAdapter.adapterVersion,
            capabilities: auditionHostAdapter.getHostCapabilityMatrix(),
          });
          return;
        case 'CAPABILITY_EXECUTE': {
          const abortCtrl = new AbortController();
          res.on('close', () => {
            if (!res.writableEnded) abortCtrl.abort();
          });
          const result = await capabilityRegistry.executeEnvelope(
            auth.envelope.payload as CanonicalOperationEnvelope,
            abortCtrl.signal,
          );
          res.json({ result });
          return;
        }
        case 'JOB_SUBMIT': {
          const submitted = jobManager.submitJob(
            auth.envelope.payload as CanonicalOperationEnvelope,
            { ownerId: sessionOwnerId },
          );
          res.status(submitted.deduplicated ? 200 : 202).json({
            deduplicated: submitted.deduplicated,
            job: submitted.job,
          });
          return;
        }
        case 'JOB_LIST': {
          res.json({ jobs: jobManager.listJobs(200, sessionOwnerId) });
          return;
        }
        case 'JOB_STATUS':
        case 'JOB_RECONNECT': {
          const p = (auth.envelope.payload ?? {}) as { job_id?: unknown };
          if (typeof p.job_id !== 'string' || p.job_id.trim().length === 0) {
            res.status(400).json({
              error: 'VALIDATION_ERROR',
              message: 'job_id must be a non-empty string.',
            });
            return;
          }
          const job = jobManager.getJob(p.job_id.trim(), sessionOwnerId);
          if (!job) {
            res.status(404).json({ error: 'JOB_NOT_FOUND' });
            return;
          }
          res.json({ job, ...(auth.envelope.command === 'JOB_RECONNECT' ? { reconnected: true } : {}) });
          return;
        }
        case 'JOB_CANCEL': {
          const p = (auth.envelope.payload ?? {}) as { job_id?: unknown };
          if (typeof p.job_id !== 'string' || p.job_id.trim().length === 0) {
            res.status(400).json({
              error: 'VALIDATION_ERROR',
              message: 'job_id must be a non-empty string.',
            });
            return;
          }
          const job = jobManager.cancelJob(p.job_id.trim(), sessionOwnerId);
          if (!job) {
            res.status(404).json({ error: 'JOB_NOT_FOUND' });
            return;
          }
          res.json({ job });
          return;
        }
        default:
          res.status(400).json({
            error: 'IPC_UNKNOWN_COMMAND',
            message: 'Unsupported Companion IPC command.',
          });
          return;
      }
    } catch (err) {
      if (err instanceof UnifiedProcessingError) {
        res.status(mapUnifiedErrorStatus(err)).json({ error: err.toPayload() });
        return;
      }
      res.status(500).json({
        error: 'COMPANION_IPC_EXECUTION_FAILED',
        message: sanitizePublicErrorOutput(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  return { router, services };
}
