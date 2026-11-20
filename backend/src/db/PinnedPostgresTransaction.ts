/**
 * @file backend/src/db/PinnedPostgresTransaction.ts
 * @description Shared pinned single-connection PostgreSQL primitive and transaction boundary.
 *              Used by AVP-005 (transactional license ownership) and AVP-006 (distributed
 *              advisory lock coordination and atomic SQL migration execution).
 *
 * Guarantees:
 * - Acquires exactly one dedicated physical connection via `pool.connect()`.
 * - Fails closed immediately with `PinnedTransactionUnavailableError` (`PINNED_CONNECTION_UNAVAILABLE`)
 *   when `pool.connect` is absent or fails — never silently falls back to `pool.query()`.
 * - Prevents client reuse after release or explicit connection invalidation.
 * - Releases the physical client exactly once in `finally`, propagating caller-supplied
 *   poisoned-connection eviction errors to `rawClient.release(error)`.
 * - Preserves primary operation exceptions across rollback/release failures.
 */

export type DatabaseCoordinationErrorCode =
  | 'PINNED_CONNECTION_UNAVAILABLE'
  | 'ADVISORY_LOCK_ACQUISITION_FAILED'
  | 'ADVISORY_LOCK_RELEASE_FAILED'
  | 'MIGRATION_TRANSACTION_FAILED'
  | 'MIGRATION_ROLLBACK_FAILED'
  | 'MIGRATION_COMMIT_FAILED'
  | 'MIGRATION_CONNECTION_INVALID';

export interface DatabaseCoordinationErrorDiagnostics {
  readonly code: DatabaseCoordinationErrorCode;
  readonly lockId?: number;
  readonly migrationVersion?: string;
  readonly connectionInvalidated?: boolean;
  readonly secondaryErrorCode?: DatabaseCoordinationErrorCode;
  readonly secondaryErrorMessage?: string;
}

export class DatabaseCoordinationError extends Error {
  public readonly code: DatabaseCoordinationErrorCode;
  public readonly diagnostics: DatabaseCoordinationErrorDiagnostics;

  constructor(
    code: DatabaseCoordinationErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      diagnostics?: Omit<DatabaseCoordinationErrorDiagnostics, 'code'>;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DatabaseCoordinationError';
    this.code = code;
    this.diagnostics = Object.freeze({
      code,
      ...(options?.diagnostics ?? {}),
    });
  }
}

export interface PgQueryResult<TRow = Record<string, unknown>> {
  readonly rows: TRow[];
  readonly rowCount: number | null;
}

export interface PinnedPgClient {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{
    rows: TRow[];
    rowCount: number | null;
  }>;

  release(error?: Error | boolean): void;
}

/** Backward-compatible alias used by AVP-005 transactional license services. */
export type PgTransactionClient = PinnedPgClient;

export interface PgTransactionalPoolLike {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{
    rows: TRow[];
    rowCount: number | null;
  }>;
  connect?(): Promise<PinnedPgClient>;
}

export class PinnedTransactionUnavailableError extends DatabaseCoordinationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('PINNED_CONNECTION_UNAVAILABLE', message, {
      cause: options?.cause,
      diagnostics: { connectionInvalidated: false },
    });
    this.name = 'PinnedTransactionUnavailableError';
  }
}

export class ReleasedTransactionClientError extends DatabaseCoordinationError {
  constructor(
    message = 'Cannot execute query on a released or invalidated PostgreSQL connection.',
  ) {
    super('MIGRATION_CONNECTION_INVALID', message, {
      diagnostics: { connectionInvalidated: true },
    });
    this.name = 'ReleasedTransactionClientError';
  }
}

/**
 * Shared pinned-connection primitive.
 *
 * Checks out exactly one dedicated physical PostgreSQL client via `pool.connect()`,
 * executes `operation(client)` bound to that client, blocks any post-release or
 * post-invalidation queries, and releases the underlying physical client exactly once.
 *
 * Callers may signal a poisoned/unusable session by invoking `client.release(err)` or
 * `client.release(true)`; doing so immediately invalidates the guarded client and passes
 * that eviction signal to the pool when releasing in `finally`.
 */
export async function withPinnedPostgresConnection<T>(
  pool: PgTransactionalPoolLike,
  operation: (client: PinnedPgClient) => Promise<T>,
): Promise<T> {
  if (!pool || typeof pool.connect !== 'function') {
    throw new PinnedTransactionUnavailableError(
      'Database pool does not provide connect() required for pinned PostgreSQL connections.',
    );
  }

  let rawClient: PinnedPgClient;
  try {
    rawClient = await pool.connect();
  } catch (connectErr) {
    throw new PinnedTransactionUnavailableError(
      'Failed to acquire a dedicated PostgreSQL connection from the pool.',
      { cause: connectErr },
    );
  }

  if (
    !rawClient ||
    typeof rawClient.query !== 'function' ||
    typeof rawClient.release !== 'function'
  ) {
    throw new PinnedTransactionUnavailableError(
      'Acquired PostgreSQL client is missing required query/release methods.',
    );
  }

  let released = false;
  let invalidated = false;
  let releaseArg: Error | boolean | undefined = undefined;

  const guardedClient: PinnedPgClient = {
    async query<TRow = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: TRow[]; rowCount: number | null }> {
      if (released || invalidated) {
        throw new ReleasedTransactionClientError();
      }
      return rawClient.query<TRow>(sql, params);
    },
    release(error?: Error | boolean): void {
      if (released) return;
      if (error instanceof Error || error === true) {
        invalidated = true;
        if (releaseArg === undefined || releaseArg === true) {
          releaseArg = error;
        }
      }
    },
  };

  let primaryError: unknown = undefined;
  let operationFailed = false;
  let result!: T;

  try {
    result = await operation(guardedClient);
  } catch (err) {
    operationFailed = true;
    primaryError = err;
  } finally {
    released = true;
    let releaseError: unknown = undefined;
    try {
      if (releaseArg !== undefined) {
        rawClient.release(releaseArg);
      } else {
        rawClient.release();
      }
    } catch (err) {
      releaseError = err;
    }

    if (releaseError !== undefined && !operationFailed) {
      throw new DatabaseCoordinationError(
        'MIGRATION_CONNECTION_INVALID',
        'Failed to release pinned PostgreSQL connection back to the pool.',
        {
          cause: releaseError,
          diagnostics: { connectionInvalidated: true },
        },
      );
    }
  }

  if (operationFailed) {
    throw primaryError;
  }

  return result;
}

/**
 * Executes `fn` inside a pinned PostgreSQL transaction built directly on top of
 * `withPinnedPostgresConnection()`.
 *
 * Guarantees:
 * - Executes `BEGIN`, all callback queries, and `COMMIT` / `ROLLBACK` on one dedicated client.
 * - Rolls back on any callback or `COMMIT` failure; if `ROLLBACK` itself fails, evicts the
 *   poisoned connection via `client.release(true)` and rethrows the original error.
 * - Prevents callback queries after the transaction has completed or been released.
 */
export async function withPinnedPostgresTransaction<T>(
  pool: PgTransactionalPoolLike,
  fn: (client: PinnedPgClient) => Promise<T>,
): Promise<T> {
  return withPinnedPostgresConnection(pool, async (client) => {
    let transactionOpen = false;
    let scopeClosed = false;

    const txClient: PinnedPgClient = {
      async query<TRow = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ): Promise<{ rows: TRow[]; rowCount: number | null }> {
        if (scopeClosed) {
          throw new ReleasedTransactionClientError();
        }
        return client.query<TRow>(sql, params);
      },
      release(error?: Error | boolean): void {
        // Allow caller-requested invalidation propagation without prematurely freeing pool slot.
        if (error instanceof Error || error === true) {
          client.release(error);
        }
      },
    };

    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const result = await fn(txClient);

      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (originalErr) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK');
          transactionOpen = false;
        } catch {
          // Destroy broken connection on release and preserve the original exception.
          client.release(true);
        }
      } else {
        // Failure happened during BEGIN or COMMIT after transactionOpen became false.
        client.release(true);
      }
      throw originalErr;
    } finally {
      scopeClosed = true;
    }
  });
}
