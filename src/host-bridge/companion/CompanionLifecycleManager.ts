/**
 * AVAPARDAZ — NATIVE COMPANION LIFECYCLE MANAGER & SINGLE-INSTANCE LOCK
 *
 * Implements AVP-P0-004:
 * - Exact 12-state Companion lifecycle machine:
 *   PROCESS_NOT_FOUND, STARTING, PORT_BOUND, AUTH_READY, MODEL_NOT_INSTALLED,
 *   MODEL_LOADING, INFERENCE_READY, BUSY, DEGRADED, SHUTTING_DOWN, CRASHED,
 *   VERSION_INCOMPATIBLE
 * - Atomic single-instance lockfile with stale-PID detection and recovery
 * - Explicit instance identity (`instanceId`, `pid`, `installationId`, `startedAtIso`)
 * - Deterministic graceful shutdown & draining coordination
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type CompanionLifecycleState =
  | 'PROCESS_NOT_FOUND'
  | 'STARTING'
  | 'PORT_BOUND'
  | 'AUTH_READY'
  | 'MODEL_NOT_INSTALLED'
  | 'MODEL_LOADING'
  | 'INFERENCE_READY'
  | 'BUSY'
  | 'DEGRADED'
  | 'SHUTTING_DOWN'
  | 'CRASHED'
  | 'VERSION_INCOMPATIBLE';

export interface CompanionInstanceIdentity {
  readonly instanceId: string;
  readonly installationId: string;
  readonly pid: number;
  readonly serviceVersion: string;
  readonly ipcProtocolVersion: string;
  readonly startedAtIso: string;
  readonly bindHost: string;
  readonly bindPort: number;
}

export interface CompanionLockfilePayload {
  readonly instanceId: string;
  readonly installationId: string;
  readonly pid: number;
  readonly bindHost: string;
  readonly bindPort: number;
  readonly serviceVersion: string;
  readonly startedAtIso: string;
}

export interface CompanionLifecycleTransition {
  readonly from: CompanionLifecycleState;
  readonly to: CompanionLifecycleState;
  readonly reason: string;
  readonly atIso: string;
}

const VALID_TRANSITIONS: Readonly<Record<CompanionLifecycleState, readonly CompanionLifecycleState[]>> = {
  PROCESS_NOT_FOUND: ['STARTING', 'CRASHED'],
  STARTING: ['PORT_BOUND', 'CRASHED', 'VERSION_INCOMPATIBLE', 'SHUTTING_DOWN'],
  PORT_BOUND: ['AUTH_READY', 'DEGRADED', 'CRASHED', 'SHUTTING_DOWN'],
  AUTH_READY: [
    'MODEL_NOT_INSTALLED',
    'MODEL_LOADING',
    'INFERENCE_READY',
    'DEGRADED',
    'VERSION_INCOMPATIBLE',
    'SHUTTING_DOWN',
    'CRASHED',
  ],
  MODEL_NOT_INSTALLED: ['MODEL_LOADING', 'INFERENCE_READY', 'DEGRADED', 'SHUTTING_DOWN', 'CRASHED'],
  MODEL_LOADING: ['INFERENCE_READY', 'MODEL_NOT_INSTALLED', 'DEGRADED', 'SHUTTING_DOWN', 'CRASHED'],
  INFERENCE_READY: ['BUSY', 'MODEL_LOADING', 'MODEL_NOT_INSTALLED', 'DEGRADED', 'SHUTTING_DOWN', 'CRASHED'],
  BUSY: ['INFERENCE_READY', 'DEGRADED', 'SHUTTING_DOWN', 'CRASHED'],
  DEGRADED: ['AUTH_READY', 'MODEL_NOT_INSTALLED', 'MODEL_LOADING', 'INFERENCE_READY', 'SHUTTING_DOWN', 'CRASHED'],
  SHUTTING_DOWN: ['PROCESS_NOT_FOUND', 'CRASHED'],
  CRASHED: ['STARTING', 'PROCESS_NOT_FOUND'],
  VERSION_INCOMPATIBLE: ['SHUTTING_DOWN', 'PROCESS_NOT_FOUND'],
};

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM means the process exists under another user/permission boundary
    return code === 'EPERM';
  }
}

export class CompanionSingleInstanceLock {
  public readonly lockFilePath: string;
  private held = false;
  private staleRecovered = false;
  private payload: CompanionLockfilePayload | null = null;

  constructor(lockFilePath: string) {
    this.lockFilePath = path.resolve(lockFilePath);
  }

  public acquire(
    payload: CompanionLockfilePayload,
    isPidAliveFn: (pid: number) => boolean = isProcessAlive,
  ): {
    readonly ok: boolean;
    readonly recoveredStaleLock: boolean;
    readonly existingHolder?: CompanionLockfilePayload | null;
    readonly code?: 'LOCK_HELD_BY_LIVE_INSTANCE' | 'LOCK_IO_ERROR';
    readonly message?: string;
  } {
    fs.mkdirSync(path.dirname(this.lockFilePath), { recursive: true });
    const serialized = JSON.stringify(payload, null, 2);

    const tryExclusiveCreate = (): boolean => {
      const fd = fs.openSync(this.lockFilePath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, serialized, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    };

    try {
      tryExclusiveCreate();
      this.held = true;
      this.staleRecovered = false;
      this.payload = payload;
      return { ok: true, recoveredStaleLock: false };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return {
          ok: false,
          recoveredStaleLock: false,
          code: 'LOCK_IO_ERROR',
          message: err instanceof Error ? err.message : 'Unable to create Companion lockfile.',
        };
      }
    }

    // Lockfile exists: inspect holder and detect stale PID
    let existing: CompanionLockfilePayload | null = null;
    try {
      const raw = fs.readFileSync(this.lockFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CompanionLockfilePayload>;
      if (typeof parsed.pid === 'number' && typeof parsed.instanceId === 'string') {
        existing = parsed as CompanionLockfilePayload;
      }
    } catch {
      existing = null;
    }

    if (existing && existing.pid !== payload.pid && isPidAliveFn(existing.pid)) {
      return {
        ok: false,
        recoveredStaleLock: false,
        existingHolder: existing,
        code: 'LOCK_HELD_BY_LIVE_INSTANCE',
        message: `Another AVAPARDAZ Companion instance (pid=${existing.pid}, instanceId=${existing.instanceId}) is already running.`,
      };
    }

    // Stale lockfile (dead PID or corrupted file): clean up and re-acquire atomically
    try {
      fs.rmSync(this.lockFilePath, { force: true });
      tryExclusiveCreate();
      this.held = true;
      this.staleRecovered = true;
      this.payload = payload;
      return { ok: true, recoveredStaleLock: true, existingHolder: existing };
    } catch (err: unknown) {
      return {
        ok: false,
        recoveredStaleLock: false,
        existingHolder: existing,
        code: 'LOCK_IO_ERROR',
        message: err instanceof Error ? err.message : 'Failed to recover stale Companion lockfile.',
      };
    }
  }

  public release(): void {
    if (!this.held) return;
    try {
      const raw = fs.readFileSync(this.lockFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CompanionLockfilePayload>;
      if (!this.payload || parsed.instanceId === this.payload.instanceId) {
        fs.rmSync(this.lockFilePath, { force: true });
      }
    } catch {
      try {
        fs.rmSync(this.lockFilePath, { force: true });
      } catch {
        // ignore cleanup race
      }
    } finally {
      this.held = false;
      this.payload = null;
    }
  }

  public isHeld(): boolean {
    return this.held;
  }

  public didRecoverStaleLock(): boolean {
    return this.staleRecovered;
  }
}

export class CompanionLifecycleManager {
  public readonly identity: CompanionInstanceIdentity;
  private state: CompanionLifecycleState;
  private readonly history: CompanionLifecycleTransition[] = [];
  private lock: CompanionSingleInstanceLock | null = null;

  constructor(params: {
    readonly serviceVersion: string;
    readonly ipcProtocolVersion: string;
    readonly bindHost?: string;
    readonly bindPort?: number;
    readonly installationId?: string;
    readonly initialState?: CompanionLifecycleState;
    readonly lockFilePath?: string;
  }) {
    this.identity = Object.freeze({
      instanceId: `cmp_${crypto.randomBytes(6).toString('hex')}`,
      installationId: params.installationId ?? `inst_${crypto.createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12)}`,
      pid: process.pid,
      serviceVersion: params.serviceVersion,
      ipcProtocolVersion: params.ipcProtocolVersion,
      startedAtIso: new Date().toISOString(),
      bindHost: params.bindHost ?? '127.0.0.1',
      bindPort: params.bindPort ?? 47291,
    });
    this.state = params.initialState ?? 'STARTING';
    if (params.lockFilePath) {
      this.lock = new CompanionSingleInstanceLock(params.lockFilePath);
    }
  }

  public getState(): CompanionLifecycleState {
    return this.state;
  }

  public getHistory(): readonly CompanionLifecycleTransition[] {
    return [...this.history];
  }

  public canTransition(next: CompanionLifecycleState): boolean {
    if (next === this.state) return true;
    return VALID_TRANSITIONS[this.state].includes(next);
  }

  public transition(next: CompanionLifecycleState, reason: string): {
    readonly ok: boolean;
    readonly state: CompanionLifecycleState;
    readonly error?: string;
  } {
    if (next === this.state) {
      return { ok: true, state: this.state };
    }
    if (!this.canTransition(next)) {
      return {
        ok: false,
        state: this.state,
        error: `Illegal Companion lifecycle transition: ${this.state} -> ${next}`,
      };
    }
    const prev = this.state;
    this.state = next;
    this.history.push(
      Object.freeze({
        from: prev,
        to: next,
        reason,
        atIso: new Date().toISOString(),
      }),
    );
    if (this.history.length > 200) this.history.shift();
    return { ok: true, state: this.state };
  }

  public acquireSingleInstanceLock(
    isPidAliveFn: (pid: number) => boolean = isProcessAlive,
  ): ReturnType<CompanionSingleInstanceLock['acquire']> {
    if (!this.lock) {
      return { ok: true, recoveredStaleLock: false };
    }
    return this.lock.acquire(
      {
        instanceId: this.identity.instanceId,
        installationId: this.identity.installationId,
        pid: this.identity.pid,
        bindHost: this.identity.bindHost,
        bindPort: this.identity.bindPort,
        serviceVersion: this.identity.serviceVersion,
        startedAtIso: this.identity.startedAtIso,
      },
      isPidAliveFn,
    );
  }

  public releaseSingleInstanceLock(): void {
    this.lock?.release();
  }

  public syncOperationalState(params: {
    readonly runtimeAvailable: boolean;
    readonly activeJobs: number;
    readonly modelLoading?: boolean;
  }): CompanionLifecycleState {
    if (this.state === 'SHUTTING_DOWN' || this.state === 'CRASHED' || this.state === 'VERSION_INCOMPATIBLE') {
      return this.state;
    }
    if (params.modelLoading) {
      if (this.canTransition('MODEL_LOADING')) this.transition('MODEL_LOADING', 'Loading local ASR model');
      return this.state;
    }
    if (!params.runtimeAvailable) {
      if (this.canTransition('MODEL_NOT_INSTALLED')) {
        this.transition('MODEL_NOT_INSTALLED', 'No verified local model or runtime installed');
      }
      return this.state;
    }
    if (params.activeJobs > 0) {
      if (this.state !== 'INFERENCE_READY' && this.canTransition('INFERENCE_READY')) {
        this.transition('INFERENCE_READY', 'Runtime ready for inference');
      }
      if (this.canTransition('BUSY')) {
        this.transition('BUSY', `Executing ${params.activeJobs} active transcription job(s)`);
      }
      return this.state;
    }
    if (this.canTransition('INFERENCE_READY')) {
      this.transition('INFERENCE_READY', 'Local runtime ready and idle');
    }
    return this.state;
  }

  public beginGracefulShutdown(reason: string): void {
    if (this.canTransition('SHUTTING_DOWN')) {
      this.transition('SHUTTING_DOWN', reason);
    }
    this.releaseSingleInstanceLock();
  }
}
