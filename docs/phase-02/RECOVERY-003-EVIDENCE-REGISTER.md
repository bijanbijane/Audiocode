# AVAPARDAZ — PHASE-02 RECOVERY-003..006 EVIDENCE REGISTER

**Document ID:** `AVP-P02-REC003-EVID-001`  
**Execution Series:** `AVP-P02-RECOVERY-003` / `RECOVERY-004` / `RECOVERY-005` / `RECOVERY-006`  
**Date (UTC):** `2026-11-22`  
**Evidence Root:** `evidence/phase02/recovery-003/`  
**Cryptographic Manifest:** `evidence/phase02/recovery-003/EVIDENCE_MANIFEST.sha256`

---

## 1. Model & Runtime Artifacts Verified on Disk (`/root/.avapardaz/`)

| Artifact | Provider / Runtime | License | Exact SHA-256 Digest |
| --- | --- | --- | --- |
| `Reza2kn/Shenava-Rizeh v1.0 INT8` (`model.int8.onnx`) | `sherpa-onnx-offline v2.0.2` | `Apache-2.0` | `6bdd4ab80626ddfe0b19338a5c96fcc4f2021ad78899cece20a805a48dc5250d` |
| `Reza2kn/Shenava-Rizeh v1.0 INT8` (`tokens.txt`) | `sherpa-onnx-offline v2.0.2` | `Apache-2.0` | `8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954` |
| `openai/whisper-large-v3-turbo INT8` (`turbo-encoder.int8.onnx`) | `sherpa-onnx-offline v2.0.2` | `MIT` | `b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b` |
| `openai/whisper-large-v3-turbo INT8` (`turbo-decoder.int8.onnx`) | `sherpa-onnx-offline v2.0.2` | `MIT` | `20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547` |
| `openai/whisper-large-v3-turbo INT8` (`turbo-tokens.txt`) | `sherpa-onnx-offline v2.0.2` | `MIT` | `b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126` |
| `english-mfa-v3.1.0` (`final.alimdl`) | `sherpa-onnx-fa v2.0.2` | `CC-BY-4.0` | `1780c629972e968a2fc4a7808c0076945df62865a0acb6ad09a02feed8d74edf` |
| `ggml-large-v3-turbo-q5_0.bin` | `whisper.cpp v1.9.5` (`d1be6fde11ac6e0407606b4e42fe72d34add8037`) | `MIT` | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |
| `silero_vad_v5.onnx` | `sherpa-onnx-vad-with-offline-asr v2.0.2` | `MIT` | `6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396` |

---

## 2. Dataset & Continuous Recording Provenance

| Artifact | Path | License | SHA-256 Digest |
| --- | --- | --- | --- |
| Persistent Dataset Manifest (`avp-p02-v1`, `764` clips, `3.5635 h`) | `datasets/phase02/manifest_v1.jsonl` | `CC-BY-4.0` / `CC0-1.0` | `681ddb093c79fd6c1ef33929c739a52b9f41889a81a3654f1d5d98588931b7bd` |
| Unbroken Continuous Master WAV (`59.39 min`, `3,563.337 s`) | `/root/.avapardaz/datasets/librivox/bleak_house_03_16k.wav` | `CC0-1.0` | `1d3e0bfc16aff05e0241fa1f7ae77592132d6a12a4c032c320a66d7b50cdef01` |
| Dataset Summary & Shortfall Audit | `datasets/phase02/dataset_summary_v1.json` | Internal | Repository tracked |
| Pilot Human Annotation Queue (`60` clips, `20%` IAA) | `datasets/phase02/annotation_assignment_queue.json` | Internal | Repository tracked |

---

## 3. Raw Experimental Evidence JSONs (`evidence/phase02/recovery-003/`)

| File | Experiment / Scope | SHA-256 Digest |
| --- | --- | --- |
| `00_os_netns_isolation_proof.json` | Independent Linux kernel netns (`net:[82]` vs `net:[2]`, `Errno 101`) | `17709faa4b65a2d4727c02b52c4b33ab6dee73143e339c9bf5ee01325b1fa3db` |
| `01_os_offline_whisper_and_shenava.json` | `EXP1`: 25 EN + 25 paired FA (`Whisper Turbo` vs `Shenava-Rizeh`, 1,000 bootstrap) | `d7a70b2c3ab7ac6b9379dc01b5fdc354463d9d8e315c1e8f1a4f8749f96161a9` |
| `02_whisper_cpp_and_alignment_eval.json` | `EXP2`: `whisper.cpp v1.9.5` DTW + `sherpa-onnx-fa` 25/25 EN + Persian CTC audit | `50cc4035ca739d5b76bcd9ee7565f5652f1fe3cd456988c26f592aed84165f56` |
| `03_stability_50_jobs.json` | `EXP3`: 50/50 real netns-isolated mixed jobs, 0 crashes, checkpointed | `080027f8342de5d213382dbe28625e90da2a7fe595ea4a7a737eb1fc18d63072` |
| `04_continuous_long_audio.json` | `EXP4`: Continuous `30.00 min` (`1,800.0 s`) unbroken audio `[0, 1800)`, `STATUS=PASS` | `cebfd5617bc754a3a8437dbc083bb8064e8e323a4946d83a39dad7b822559453` |
| `05_direct_inference_netns_proof.json` | Live per-PID `/proc/<pid>/ns/net` proof on actual Whisper EN & Shenava FA processes | `e84c722db1fca7b2c8b0cedc9d97f11a580048f94c2e8d69d802f37d743d0d9a` |
| `EVIDENCE_MANIFEST.sha256` | Full cryptographic manifest (`69/69` files verified `OK` via `sha256sum -c`) | `09428a1a32675d56b0654b40879a8b50972b8874e5a34ec6372b1069ab5edeff` |
| `checkpoints/exp3_stability_50_jobs.{state.json,checkpoints.jsonl}` | `EXP3` durable checkpoint state & JSONL journal | Indexed in `EVIDENCE_MANIFEST.sha256` |
| `textgrids/` (`31` files) | `25` MFA EN TextGrids + `6` `whisper.cpp` DTW JSONs | Indexed in `EVIDENCE_MANIFEST.sha256` |

---

## 4. Preserved Pre-Existing Phase-02 Deliverables (Untouched)

All 11 original Phase-02 docs (`docs/phase-02/{MODEL-DISCOVERY,BENCHMARK-PROTOCOL,MODEL-CANDIDATE-MATRIX,LICENSE-COMPLIANCE-REGISTER,DATASET-REGISTER,DATASET-ANNOTATION-STANDARD,CPU-BENCHMARK-RESULTS,TIMESTAMP-EVALUATION,OFFLINE-AND-STABILITY-REPORT,MODEL-SELECTION-REPORT,PHASE-02-ACCEPTANCE}.md`) and all 3 historical raw benchmark JSONs (`benchmarks/phase02/{results-2026-11-20,product-fit-results-2026-11-22,recovery-verification-2026-11-22}.json`) remain preserved unmodified.
