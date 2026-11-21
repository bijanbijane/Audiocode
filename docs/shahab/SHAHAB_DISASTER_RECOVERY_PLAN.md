# SHAHAB-015 — Disaster Recovery Plan & Restore Verification

## Backup Scope Separation
| Asset Class | Local Backup | External Without Consent | Rationale |
|---|---|---|---|
| `USER_CREATED_CONTENT` | YES | NO | Critical user recordings/edits; NEVER uploaded externally without explicit authorization. |
| `AUTHORIZED_FINAL_TRANSCRIPTS` | YES | NO | Irreplaceable human-reviewed transcripts; protected from partial-recovery overwrite. |
| `PROJECT_METADATA` | YES | NO | Small structured JSON metadata essential for timeline and provenance restoration. |
| `MODEL_MANIFESTS` | YES | NO | Tiny SHA-256 lineage manifests enabling verified reacquisition of exact model revisions. |
| `MODEL_ARTIFACTS_WEIGHTS` | NO | NO | Excluded (~115.77 MB); securely reacquirable by pinned 40-char commit SHA + SHA-256 manifest. |
| `RUNTIME_CONFIGURATION` | YES | NO | Small local runtime & consent preference files. |
| `OPERATIONAL_TELEMETRY` | YES | NO | Sanitized local operational ledger; external sharing strictly opt-in. |
| `TEMPORARY_INFERENCE_STATE` | NO | NO | Ephemeral FFT/encoder buffers and .tmp files are disposable and excluded. |

## Recovery Scenarios & Honest Boundaries
- **Application crash / OS restart during active job**: Verified chunk checkpoints (`POST_ENCODER_EXECUTION`, `POST_CHUNK_TRANSCRIPT_ASSEMBLY`) can resume safely; in-flight ONNX kernel frames without a committed checkpoint cannot be recovered and are recomputed cleanly.
- **Interrupted model installation / failed update**: Non-destructive staging rejects partial/corrupted packages while keeping `ACTIVE_RELEASE.json` pointing to the last known-good release.
- **Storage exhaustion during persistence**: Atomic temp-file write aborts without touching previously committed state; new jobs pause until space recovers.
- **Power loss**: Uncommitted in-memory buffers are lost; committed files rely on host OS filesystem durability.
- **Corrupted operational metadata / job state**: Rejected on SHA-256/schema validation; append-only history preserved.

## Latest Restore Verification Drill
- **Report ID:** `restore-d43f02cc-b`
- **Verified Files:** 5
- **All Checks Passed:** `true`
- **Large Model Weights Excluded:** `true`
- **External Upload Performed:** `false`
