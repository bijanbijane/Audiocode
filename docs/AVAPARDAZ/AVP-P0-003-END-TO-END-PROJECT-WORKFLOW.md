# AVP-P0-003 — End-to-End Transcription Workflow, Project State Integrity & Edit Decision Execution

**Status:** `VERIFIED`  
**Primary Modules:**
- `src/workflow/CanonicalProjectWorkflowEngine.ts`
- `src/workflow/UnifiedLocalAsrWorkflowService.ts`
- `src/audio-renderer/CanonicalAudioDspEngine.ts`

---

## 1. Canonical Workflow Pipeline

`Import Audio -> Validate Audio -> Transcribe -> Analyze Speech -> Review Suggestions -> Approve/Reject/Modify Decisions -> Apply Edits -> Undo/Redo -> Persist/Recover Project -> Export Independently Verified WAV`

## 2. Key Engineering Guarantees

1. **Integer-Sample Canonical Timebase:** All transcript segments, suggestions, edit decisions, and timeline cuts bind to integer sample indices (`sampleRate` + `frameCount`), with automatic repair logging (`TimestampRepairRecord`) for overlapping/out-of-bounds segment edges.
2. **7-State Edit Decision Governance:** `PENDING`, `APPROVED`, `REJECTED`, `MODIFIED`, `APPLIED`, `UNDONE`, `INVALIDATED`.
3. **Immutable Source Buffer & Idempotent Transactional Apply:** Source audio is never mutated; approved decisions apply from highest sample offset downward with dry-run verification and transactional rollback on failure.
4. **Full Undo/Redo & Atomic Persistence Recovery:** `saveAtomically` preserves the last committed snapshot if an interrupted save occurs; `restoreFromSerializedEnvelope` validates and migrates schema-versioned project envelopes.
5. **Source-Change Invalidation:** Importing a different audio asset automatically invalidates prior transcripts (`SOURCE_AUDIO_CHANGED`) and marks prior decisions `INVALIDATED`.
6. **Independent Decode-Back Export Verification:** `exportValidatedWav` renders non-destructive timeline edits and decodes the generated WAV bytes back to verify exact sample rate, channel count, frame count, and deterministic SHA-256 hash.

## 3. Verified Automated Evidence

- `src/workflow/CanonicalProjectWorkflowAndDsp.test.ts`: **PASS** (full end-to-end lifecycle test including timestamp repair, silence & Persian filler suggestion generation, review/approve/reject, immutable source buffer check, undo/redo, verified WAV export, atomic save + interrupted save recovery, and source-change invalidation).
