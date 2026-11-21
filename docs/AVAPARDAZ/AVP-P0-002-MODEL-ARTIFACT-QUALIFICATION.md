# AVP-P0-002 — Canonical Persian ASR Model Artifact Qualification, Provenance & Offline Deployment

**Status:** `VERIFIED (WITH EXPLICIT PUBLISHER SIGNING KEY & CORPUS BLOCKERS)`  
**Primary Modules:**
- `src/lifecycle/CanonicalModelProvenance.ts`
- `src/lifecycle/ModelLifecycleStateMachine.ts`
- `src/platform/ChunkedModelDelivery.ts`
- `src/asr-core/ModelQualificationPipeline.ts`
- `src/utils/StreamingSha256.ts`

---

## 1. Architecture & Guarantees Implemented

1. **Canonical Manifest Schema v2.0.0 (`CanonicalModelProvenance.ts`):**
   - Validates `schemaVersion`, safe `modelId`/`version` segments (blocking path traversal), architecture (`FASTCONFORMER_CTC` / `WHISPER_SEQ2SEQ`), ONNX opset bounds, artifact filenames/sizes/SHA-256 digests, tensor contracts, 16 kHz mono audio contract, and commercial SPDX licensing.
   - **Strict Checksum vs Authenticity Separation:** Explicitly distinguishes `UNSIGNED_CHECKSUM_ONLY`, `SIGNATURE_KEY_UNTRUSTED`, `SIGNATURE_INVALID`, and `SIGNATURE_VERIFIED`. Unsigned checksums never impersonate cryptographic publisher authenticity.
2. **Exact 19-State Model Lifecycle Machine (`ModelLifecycleStateMachine.ts`):**
   - Enforces legal state transitions across all 19 states (`DISCOVERED` .. `ACTIVE`, `CORRUPTED`, `REVOKED`, `REMOVAL_PENDING`).
   - Blocks direct `INSTALLED -> ACTIVE` shortcuts (requires `COMPATIBILITY_VERIFIED -> RUNTIME_INITIALIZED -> INFERENCE_VERIFIED -> ACTIVE`).
   - Persists transition ledgers and safely downgrades transient states (`DOWNLOADING`, `INSTALLING`, `RUNTIME_INITIALIZED`) upon simulated crash/restart recovery.
3. **Transactional Chunked OPFS Delivery (`ChunkedModelDelivery.ts`):**
   - Streams model artifacts in bounded chunks with incremental SHA-256 computation, atomic staging commit, abort cleanup, and zero full-file RAM duplication.
4. **11-Step Real ONNX Qualification Pipeline (`ModelQualificationPipeline.ts`):**
   - Verifies manifest, artifact byte lengths & SHA-256 digests, ONNX input/output tensor names, real unmocked `onnxruntime-web` WASM session creation, 80-bin Log-Mel inference, CTC decoding, monotonic/bounded timestamps, and normalized Persian WER/CER computation.

---

## 2. Verified Automated Evidence

- `src/lifecycle/ModelProvenanceAndDelivery.test.ts`: **PASS** (manifest validation, traversal rejection, checksum-vs-signature verification, 19-state transitions + restart ledger recovery, runtime compatibility, tensor contracts, `tokens.txt` parser).
- `src/asr-core/RealOnnxAndCrossRuntimeConformance.test.ts`: **PASS** (real unmocked `onnxruntime-web@1.31.1` WASM forward pass with `globalThis.fetch` disabled proving 0 outbound network calls; 11-step qualification pipeline passes on valid ONNX artifact and rejects 1-byte checksum tampering).

---

## 3. Explicit Blockers

- **`BLK-001`:** No production Ed25519/ECDSA publisher signing keypair provisioned yet.
- **`BLK-003`:** Statistical multi-domain Persian audio WER/CER qualification requires an external human-verified Persian speech corpus not bundled in this repository.
