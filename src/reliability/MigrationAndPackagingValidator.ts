/**
 * Deterministic Migration & Packaging Integrity Validator (AVP-M-P0-02)
 * Statically verifies:
 *  - Canonical /platform/migrations/ sequential ordering, uniqueness, zero duplicate CREATE TABLE,
 *    zero destructive SQL (DROP TABLE / TRUNCATE), valid FK table creation order, and legacy coverage.
 *  - Canonical ADR-001 packaging consistency (Dockerfiles, docker-compose, root package.json).
 */

export interface MigrationFileInput {
  readonly fileName: string;
  readonly sql: string;
}

export interface MigrationIntegrityReport {
  readonly valid: boolean;
  readonly migrationCount: number;
  readonly versions: readonly number[];
  readonly canonicalTables: readonly string[];
  readonly duplicateTables: readonly string[];
  readonly missingFkTargets: readonly string[];
  readonly destructiveStatements: readonly string[];
  readonly missingLegacyCapabilities: readonly string[];
  readonly errors: readonly string[];
}

const REQUIRED_LEGACY_RECONCILED_TABLES: readonly string[] = [
  'users',
  'organizations',
  'subscriptions',
  'invoices',
  'payment_events',
  'payment_transactions',
  'offline_license_leases',
  'ai_models_catalog',
  'ai_model_chunks',
  'model_delivery_telemetry',
  'cloud_asr_jobs',
  'model_rollout_policies',
  'backend_event_outbox',
  'asr_engines',
  'dataset_samples',
  'benchmark_experiments',
  'benchmark_runs',
  'stream_sessions',
  'stream_utterances',
  'stream_events',
  'api_credentials',
  'enterprise_api_key_quotas',
];

export function validateCanonicalMigrationSequence(
  files: readonly MigrationFileInput[],
): MigrationIntegrityReport {
  const sorted = [...files].sort((a, b) => a.fileName.localeCompare(b.fileName));
  const versions: number[] = [];
  const seenVersions = new Set<number>();
  const createdTables = new Set<string>();
  const duplicateTables: string[] = [];
  const missingFkTargets: string[] = [];
  const destructiveStatements: string[] = [];
  const errors: string[] = [];

  for (const file of sorted) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file.fileName);
    if (!match) {
      errors.push(`Invalid migration filename format: ${file.fileName}`);
      continue;
    }
    const ver = Number(match[1]);
    if (seenVersions.has(ver)) {
      errors.push(`Duplicate migration version ${ver} in ${file.fileName}`);
    }
    seenVersions.add(ver);
    versions.push(ver);

    // Strip SQL single-line comments before inspection
    const stripped = file.sql.replace(/--[^\n]*/g, '');

    // Check for dangerous destructive DDL
    const destructiveRe = /\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DROP\s+DATABASE)\b/gi;
    let dMatch: RegExpExecArray | null;
    while ((dMatch = destructiveRe.exec(stripped)) !== null) {
      destructiveStatements.push(`${file.fileName}: ${dMatch[0]}`);
    }

    // Extract CREATE TABLE statements in order
    const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi;
    const fileTablesInOrder: string[] = [];
    let ctMatch: RegExpExecArray | null;
    while ((ctMatch = createTableRe.exec(stripped)) !== null) {
      const tableName = ctMatch[1].toLowerCase();
      if (createdTables.has(tableName)) {
        duplicateTables.push(`${file.fileName}:${tableName}`);
      } else {
        createdTables.add(tableName);
      }
      fileTablesInOrder.push(tableName);
    }

    // Check REFERENCES table(col) targets against tables created up to and including this migration
    const refRe = /\bREFERENCES\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = refRe.exec(stripped)) !== null) {
      const refTable = rMatch[1].toLowerCase();
      if (!createdTables.has(refTable)) {
        missingFkTargets.push(`${file.fileName} -> REFERENCES ${refTable}`);
      }
    }
  }

  // Verify strictly sequential 1..N numbering without gaps
  for (let i = 0; i < versions.length; i += 1) {
    if (versions[i] !== i + 1) {
      errors.push(`Expected sequential migration version ${i + 1}, found ${versions[i]}`);
    }
  }

  const missingLegacyCapabilities = REQUIRED_LEGACY_RECONCILED_TABLES.filter(
    (tbl) => !createdTables.has(tbl),
  );

  if (duplicateTables.length > 0) {
    errors.push(`Duplicate table definitions: ${duplicateTables.join(', ')}`);
  }
  if (missingFkTargets.length > 0) {
    errors.push(`Unresolved FK targets: ${missingFkTargets.join(', ')}`);
  }
  if (destructiveStatements.length > 0) {
    errors.push(`Destructive SQL detected: ${destructiveStatements.join(', ')}`);
  }
  if (missingLegacyCapabilities.length > 0) {
    errors.push(`Missing reconciled legacy tables: ${missingLegacyCapabilities.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    migrationCount: sorted.length,
    versions,
    canonicalTables: Array.from(createdTables).sort(),
    duplicateTables,
    missingFkTargets,
    destructiveStatements,
    missingLegacyCapabilities,
    errors,
  };
}

export interface PackagingConsistencyInput {
  readonly packageJsonText: string;
  readonly controlPlaneDockerfile: string;
  readonly backendDockerfile: string;
  readonly dockerComposeYml: string;
  readonly existingRepoPaths: ReadonlySet<string>;
}

export interface PackagingConsistencyReport {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly notes: readonly string[];
}

export function validatePackagingConsistency(
  input: PackagingConsistencyInput,
): PackagingConsistencyReport {
  const errors: string[] = [];
  const notes: string[] = [];

  try {
    const pkg = JSON.parse(input.packageJsonText) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    for (const script of ['dev', 'build', 'lint', 'test:unit', 'test:quality-gates']) {
      if (!pkg.scripts?.[script]) {
        errors.push(`package.json missing required script "${script}"`);
      }
    }
    // ADR-001 / Local-First constraint: root app must not add Fastify/pg/redis as mandatory runtime deps
    for (const forbidden of ['fastify', 'pg', 'ioredis', 'redis']) {
      if (pkg.dependencies?.[forbidden]) {
        errors.push(`Root package.json should not require "${forbidden}" under Local-First ADR-001.`);
      }
    }
    notes.push('Root package.json scripts and Local-First dependency hygiene verified.');
  } catch {
    errors.push('package.json is not valid JSON.');
  }

  const checkDockerfileBuilderCopies = (name: string, content: string) => {
    const [builderPart, prodPart] = content.split(/FROM\s+[^\n]+AS\s+production/i);
    if (!builderPart || !prodPart) {
      errors.push(`${name}: missing multi-stage builder/production sections.`);
      return;
    }
    if (prodPart.includes('/workspace/platform/migrations') && !builderPart.includes('COPY platform/migrations')) {
      errors.push(`${name}: production copies /workspace/platform/migrations but builder stage never copied it.`);
    }
    if (prodPart.includes('dist/server.mjs') && !builderPart.includes('dist/server.mjs')) {
      errors.push(`${name}: production runs dist/server.mjs but builder stage does not emit it.`);
    }
    if (!content.includes('/api/v1/asr/health')) {
      errors.push(`${name}: missing healthcheck referencing real /api/v1/asr/health route.`);
    }
  };

  checkDockerfileBuilderCopies('deploy/Dockerfile.control-plane', input.controlPlaneDockerfile);
  checkDockerfileBuilderCopies('backend/Dockerfile', input.backendDockerfile);

  if (!input.dockerComposeYml.includes('deploy/Dockerfile.control-plane')) {
    errors.push('deploy/docker-compose.backend.yml must reference canonical deploy/Dockerfile.control-plane (ADR-001).');
  }
  if (!input.dockerComposeYml.includes('ENABLE_CLOUD_ASR: "false"')) {
    errors.push('deploy/docker-compose.backend.yml must explicitly set ENABLE_CLOUD_ASR: "false".');
  }
  if (!input.existingRepoPaths.has('server.ts')) {
    errors.push('Canonical runtime entrypoint server.ts is missing.');
  }
  if (!input.existingRepoPaths.has('deploy/Dockerfile.control-plane')) {
    errors.push('deploy/Dockerfile.control-plane is missing.');
  }

  return {
    valid: errors.length === 0,
    errors,
    notes,
  };
}
