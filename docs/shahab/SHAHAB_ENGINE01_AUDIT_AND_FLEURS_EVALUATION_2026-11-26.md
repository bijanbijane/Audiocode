# SHAHAB Engine 01 — Audit, Runtime Integration and Persian Evaluation

**Assessment date:** 2026-11-26
**Workspace:** macOS Apple Silicon, 8 GiB RAM
**Model:** `Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx` — NeMo FastConformer CTC, FP32
**Runtime:** Sherpa-ONNX 2.0.3, CPU, offline
**Model status:** Frozen upstream weights; not trained or fine-tuned by AVAPARDAZ.

## Executive result

SHAHAB now has a single preferred Persian ASR model for the Native Companion / Adobe Audition path: the verified Koochik FastConformer CTC model. The normal Studio workflow prefers Native Companion when it is ready, with Browser WASM retained as a fallback. The legacy Zipformer path is opt-in only and is not selected merely because old weights happen to be present.

The full Google FLEURS `fa_ir/test` split was evaluated: **871/871 utterances completed, with zero runtime failures and zero empty transcripts**. After applying the project `FA-RELAXED-V1` normalization and Persian spoken-number display ITN, corpus **WER was 9.9232%** and **CER was 3.6439%**. The test split contained 13,321.86 seconds (3 h 42 min 1.86 sec) of speech. The run completed in 307.49 seconds, giving **RTF 0.02308** (approximately 43.3× real time) on this Mac.

These are measured results for this model, runtime and dataset—not evidence that SHAHAB is the best ASR engine globally. They do not establish conversational, dialect, noisy-room, overlapping-speaker, telephone or studio generalization.

## Dataset and scoring protocol

- Source: [Google FLEURS dataset](https://huggingface.co/datasets/google/fleurs), configuration `fa_ir`, split `test`.
- All 871 rows in the official TSV were joined to their matching test audio. The full run checked all rows; no audio row was missing or duplicated.
- Audio was decoded/re-encoded to mono 16 kHz signed PCM16 for Sherpa-ONNX.
- Audio inference was isolated from reference text: only WAV paths were passed to the recognizer. Reference text was used after inference for scoring.
- Hypotheses were scored using AVAPARDAZ `computePersianWerCer`, `FA-RELAXED-V1`, and `PersianNumeralAndCurrencyNormalizer.formatSpokenNumbersInDisplayLayer`.
- Original ASR text remains separately available in the result artifact; display-layer spoken-number normalization does not overwrite raw transcript evidence.
- The official FLEURS `fa_ir/test` speaker metadata in this exported split identifies the evaluated utterances as male. It is read speech, not a balanced conversational field corpus. Treat the result as a controlled held-out benchmark, not a population estimate.

## Metrics

| Metric | Measured result |
|---|---:|
| Utterances | 871 / 871 |
| Runtime failures | 0 |
| Empty transcripts | 0 |
| Reference words | 21,485 |
| Word edits | 2,132 |
| **Corpus WER** | **9.9232%** |
| Reference characters | 102,611 |
| Character edits | 3,739 |
| **Corpus CER** | **3.6439%** |
| Total audio | 13,321.86 s |
| Wall time | 307.49 s |
| **RTF** | **0.02308** |
| Approximate throughput | 43.3× real time |

### Duration buckets

| Audio duration | Samples | WER | CER |
|---|---:|---:|---:|
| Under 10 s | 78 | 6.20% | 1.76% |
| 10–20 s | 666 | 9.67% | 3.33% |
| 20–30 s | 114 | 11.06% | 4.59% |
| 30 s or longer | 13 | 14.82% | 8.04% |

The longer-utterance degradation is a signal to investigate chunk-boundary policy, overlap stitching, context retention and decoding strategy. The final bucket has only 13 samples and is descriptive, not statistically conclusive.

## Model provenance and integrity

The local model artifacts were verified against pinned size and SHA-256 values:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `model.onnx` | 458,819,249 | `6a564b5541920ce1c37bbc91d22e4b3a6838648b9b327eb88997e8db1f90950d` |
| `tokens.txt` | 12,236 | `8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954` |

The upstream model is Apache-2.0 as declared in its upstream model package. AVAPARDAZ does not claim ownership of or fine-tuning over these weights.

## Runtime and integration work

1. Added a browser-safe range-reader to canonical WAV streaming path. It uses the shared Kaiser-sinc streaming resampler and produces bounded 16 kHz mono Float32 WAV chunks.
2. Added a Node-only temporary-file stager with mode `0600`, size verification, cancellation and guaranteed cleanup.
3. Added `NativeCompanionTransport.transcribeAudioSource()` and a Companion client upload path using the existing staged-audio protocol. The browser reads bounded ranges; it does not materialize the complete recording as a Float32Array or WAV ArrayBuffer.
4. The Native adapter now uses file-backed source handles for long recordings. Legacy PCM transport is restricted to short clips and fails explicitly rather than silently allocating a long recording in memory.
5. Added a persistent offline Sherpa Python worker (one model load per process) and a one-process native CLI batch fallback for deployments without the Python binding. Both run CPU-only and offline.
6. The installed runtime resolver recognizes both legacy `runtime/bin` and the lean `runtime/sherpa-venv/bin` layout, including nested ONNX Runtime shared-library directories.
7. Installer packaging now verifies and includes the Koochik model, its tokens, the tested standalone Sherpa binary and its ONNX Runtime shared library. The package manifest records current build provenance and model hashes.
8. First-run readiness and model installation prefer Koochik and retain the smaller Shenava-Rizeh model as a verified fallback.
9. Normal Studio ASR prefers Native Companion/Koochik when ready. Browser WASM remains a fallback. Zipformer is explicitly experimental and is not silently preferred because old assets are installed.
10. The Koochik Sherpa output currently provides token onset timestamps but no token durations. The system therefore reports segment-level timing. It does **not** fabricate word end times or claim word-level timestamp support.

## Reproduction

The repository contains a small attributed FLEURS fixture for deterministic smoke testing:

- `e2e/fixtures/shahab-fleurs-fa-ir-test.wav`
- `e2e/fixtures/SHABAH_FLEURS_FIXTURE_ATTRIBUTION.md`

The complete benchmark is reproduced from the full extracted test manifest and result JSONL by running:

```sh
npm run benchmark:shahab:fleurs -- \
  --manifest /path/to/manifest-pcm16.json \
  --results /path/to/results.jsonl \
  --output /path/to/metrics.json
```

The audio run uses `scripts/run-shahab-worker-benchmark.py` with `companion/shahab_sherpa_worker.py` and the pinned model/tokens. The benchmark helper consumes no reference text during inference.

## Current acceptance status

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Koochik model artifact integrity | PASS | Exact file size and SHA-256 checked |
| Full FLEURS `fa_ir/test` inference | PASS | 871/871; zero runtime errors |
| Persian WER/CER on FLEURS | MEASURED | WER 9.9232%; CER 3.6439% under project normalization/ITN |
| Native Companion streaming transport | PASS | Mock and real Koochik end-to-end tests; bounded range reads and staging cleanup |
| Installed package inference | PASS | Fresh temporary installation; local runtime/model discovery and real FLEURS fixture inference |
| First-run readiness with Koochik | PASS | Installed package reports ready and verifies model hashes |
| Browser fallback when Companion unavailable | PASS | Resolver test |
| Native Companion preferred when ready | PASS | Resolver test, even when Browser model is installed |
| Word-level start/end timing | BLOCKED | No valid token durations from this model path; a real Persian forced aligner and gold boundary set are required |
| 60–120 minute continuous file stress | NOT YET VERIFIED | Streaming architecture is implemented; full-duration Mac stress and peak-RSS evidence still required |
| Conversational/dialect/noisy/overlap evaluation | NOT YET VERIFIED | Build a consented, speaker-independent Persian field corpus with blind references |
| Windows x64 and additional macOS/Adobe Audition versions | NOT YET VERIFIED | Native install and GUI acceptance runs are still required |
| Independent multilingual head-to-head benchmark | NOT YET VERIFIED | Compare matched audio, normalization, hardware, runtime and scoring across candidate engines |

## Next SHAHAB-only work

1. Add and validate a Persian forced aligner that emits real token/word start and end boundaries. Never infer the end of the last word from a chunk boundary.
2. Build a consented Persian conversational test set across speakers, dialects, recording conditions, code-switching and overlap. Keep train/dev/test speakers disjoint.
3. Run 60-minute and 120-minute Native Companion stress tests on 8 GiB and larger machines; capture peak RSS, staging-disk use, cancellation latency, partial-result behavior and recovery after process failure.
4. Tune chunk boundaries/overlap and decoding against the long-utterance error profile without regressing the locked FLEURS test.
5. Verify the CEP plug-in in actual Adobe Audition GUI sessions on supported macOS/Windows versions.
6. Only after matched, independent and reproducible comparisons should SHAHAB be described as outperforming specific alternatives.
