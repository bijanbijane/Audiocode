# SHAHAB-015 — Processing Job State Machine, Checkpointing & Retry Policy

## 14-State Processing Lifecycle
Valid transitions enforced by `SHAHABJobStateMachine` (`src/shahab/ShahabResilienceEngine.ts`):

- `CREATED` → `VALIDATING`, `CANCELLATION_REQUESTED`, `FAILED_NON_RECOVERABLE`
- `VALIDATING` → `QUEUED`, `CANCELLATION_REQUESTED`, `FAILED_NON_RECOVERABLE`, `FAILED_RECOVERABLE`
- `QUEUED` → `INITIALIZING`, `PAUSED`, `CANCELLATION_REQUESTED`, `FAILED_RECOVERABLE`
- `INITIALIZING` → `PROCESSING`, `CANCELLATION_REQUESTED`, `FAILED_RECOVERABLE`, `FAILED_NON_RECOVERABLE`
- `PROCESSING` → `PAUSED`, `CANCELLATION_REQUESTED`, `RECOVERY_PENDING`, `COMPLETED`, `FAILED`, `FAILED_RECOVERABLE`, `FAILED_NON_RECOVERABLE`
- `PAUSED` → `QUEUED`, `PROCESSING`, `CANCELLATION_REQUESTED`, `RECOVERY_PENDING`
- `CANCELLATION_REQUESTED` → `CANCELLED`, `FAILED_RECOVERABLE`
- `CANCELLED` → `RECOVERY_PENDING`
- `RECOVERY_PENDING` → `RECOVERING`, `CANCELLATION_REQUESTED`, `FAILED_NON_RECOVERABLE`
- `RECOVERING` → `PROCESSING`, `COMPLETED`, `FAILED_RECOVERABLE`, `FAILED_NON_RECOVERABLE`, `CANCELLATION_REQUESTED`
- `COMPLETED` → _(terminal)_
- `FAILED` → `RECOVERY_PENDING`, `FAILED_RECOVERABLE`, `FAILED_NON_RECOVERABLE`
- `FAILED_RECOVERABLE` → `RECOVERY_PENDING`, `RECOVERING`, `CANCELLED`
- `FAILED_NON_RECOVERABLE` → _(terminal)_

## Hard Invariants
1. A job cannot enter `COMPLETED` unless `outputDurablyCommitted === true` AND `partialOutputDesignated === false`.
2. Duplicate `idempotencyKey` creation and duplicate `COMPLETED` events are rejected (`DUPLICATE_JOB_DETECTED`).
3. Cancellation never discards already committed user transcripts.
4. An existing `authorizedFinalTranscript` is never overwritten by a partial recovery result.
5. Checkpoints are verified for schema version, envelope SHA-256, payload SHA-256, audio hash, model digest, tokenizer SHA-256, preprocessing digest, and runtime tag before resume.

## Atomic Persistence & Platform Durability Limitations
- Node.js filesystem commits write to a sibling `.tmp.<pid>.<nonce>` file, invoke `fs.fsyncSync`, re-read and verify JSON + SHA-256, then perform `fs.renameSync`.
- **Platform limitation**: On power loss or non-POSIX mounts, directory-entry rename durability depends on host OS/filesystem barriers; zero data loss under sudden hardware power cut is NOT claimed without hardware-level verification.
