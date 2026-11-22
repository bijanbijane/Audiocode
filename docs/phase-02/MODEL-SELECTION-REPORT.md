# AVAPARDAZ — PHASE-02: MODEL SELECTION & ARCHITECTURE DECISION REPORT

**Document ID:** `AVP-P02-SELECTION-2.0`  
**Execution ID:** `AVP-P02-RECOVERY-002` (superseding unverified claims in historical `docs/AVAPARDAZ/MODEL-SELECTION-REPORT.md`, which is preserved untouched for audit traceability)  
**Date:** `2026-11-22`  
**Decision Status:** **PROVISIONAL ARCHITECTURAL DIRECTION ONLY — FINAL PRODUCTION MODEL SELECTION IS `BLOCKED`**  
**Evidence Sources:**
- `docs/phase-02/MODEL-DISCOVERY.md` (`sha256: 5c52407173452884da40e1e6fa0d0b102d11cf4b5fe826b59324aa64e5eb40d0`)
- `docs/phase-02/MODEL-CANDIDATE-MATRIX.md` (`AVP-P02-MATRIX-2.0`)
- `docs/phase-02/LICENSE-COMPLIANCE-REGISTER.md` (`AVP-P02-LICENSE-2.0`)
- `docs/phase-02/CPU-BENCHMARK-RESULTS.md` (`AVP-P02-CPU-BENCH-2.0`)
- `docs/phase-02/TIMESTAMP-EVALUATION.md` (`AVP-P02-TS-2.0`)
- `docs/phase-02/OFFLINE-AND-STABILITY-REPORT.md` (`AVP-P02-OFFLINE-2.0`)
- `benchmarks/phase02/results-2026-11-20.json` (`sha256: 7abb940d90ae3df4176a66dac9280f105c3b7917541019f823e451ca7b866fe9`)
- `benchmarks/phase02/product-fit-results-2026-11-22.json` (`sha256: f75ff6a32f654c1cd8ed1eb4ce5274926dde6f7ab7bb51a42d40c9753a03648d`)
- `benchmarks/phase02/recovery-verification-2026-11-22.json` (`sha256: e8ebdb07764fb55c88d47d796bbdc7f4a1a9f26ed79263f7b8d6e6c7aae82b44`)

**Test Environment (`ACTUAL_LINUX_CPU_RESULTS`):** `Linux 4.19.0-gvisor x86_64`, `4 vCPU` (`AVX-512 VNNI / AVX2 / SSE4.2`), `12,288 MiB RAM`, `GPU: NONE`, `sherpa-onnx-offline v2.0.2` (`ONNX Runtime 1.28.2 CPU`).  
**Target Hardware (`ACTUAL_APPLE_M2_RESULTS`):** Apple Silicon M2 / 8 GB unified memory — **`NOT_RUN`** (`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`).

---

## 1. Executive Verdict (BLUF)

1. **No single evaluated ASR model currently satisfies all AVAPARDAZ Phase-02 product requirements simultaneously (`P02-18 = FAIL`).**
   - **`A. Reza2kn/Shenava-Rizeh v1.0` (`14ca75f0c5c6`, `Apache-2.0`, `36.43 MiB`)** is the clear empirical winner on **Persian accuracy** (`5.71%` Norm CER / `19.44%` Norm WER), **CPU efficiency** (`RTF 0.0299–0.0360`, `28–33×` faster than real-time on Linux CPU), **memory footprint** (`165.81–204.50 MiB`), **zero silence hallucination**, **verbatim repetition retention**, and **native CTC token timestamps** — **but completely fails English (`100.00%` WER) and FA-EN code-switching (`0.0%` Latin recall)**.
   - **`B. openai/whisper-large-v3-turbo-int8` (`41f01f3fe87f`, `MIT`, `988.59 MiB`)** delivers strong **English (`5.83%` Norm WER)** and usable **Persian (`7.71%` Norm CER / `27.78%` Norm WER)** — **but fails code-switching (`67.82%` WER, `17.50%` Latin recall due to single-language decoder lock), emits NO native word-level timestamps in `sherpa-onnx`, consumes `1,382.88 MiB` (`1x`) to `1,823.38 MiB` (`b=5`) RAM, runs `17×` slower (`RTF 0.6121`), and still carries a raw JSON `"offline_verified": false` telemetry caveat**.
   - **`C. Qwen/Qwen3-ASR-0.6B-int8` (`5eb144179a02`, `Apache-2.0`, `941.28 MiB`)** is **REJECTED** for zero-shot Persian (`56.57%` Norm CER — transliterates Persian to Turkish/Latin script, `11.6 s` cold start, `1,588–2,292 MiB` RAM, `RTF 0.9970`).
   - **`D. Unbenchmarked Alternatives (`whisper.cpp` GGML Q5_0, `nvidia/stt_fa_fastconformer_hybrid_large`, `vhdm/whisper-large-fa-v1`, external CTC forced aligners)`** remain **`NOT_RUN`** and are explicitly tracked as follow-up contenders rather than assumed winners.
2. **Formal Architecture Decision (`ADR-P02-REC-001`):** Adopt a **Pluggable Model-Provider Architecture** as the permanent engine abstraction layer shared between the **Adobe Audition Plugin** and the **AVAPARDAZ Web App**, targeting a **Provisional Dual-Model + Forced-Alignment Strategy** (`Shenava-Rizeh v1.0` for Persian-primary workflows; `whisper-large-v3-turbo` or `whisper.cpp` + acoustic forced alignment for English/multilingual workflows).
3. **Phase Gate Integrity:** Because **Apple Silicon M2 (8 GB) validation is `NOT_RUN`**, **spontaneous Persian disfluency/code-switching/human word-boundary datasets are `NOT_AVAILABLE`**, and **the routed dual-model + aligner pipeline is `NOT_RUN`**, **final production model selection is NOT authorized (`FINAL_PHASE_02_STATUS: BLOCKED`, `NEXT_AUTHORIZED_PHASE: NONE`)**.

---

## 2. Head-to-Head Model Evaluation Matrix (A / B / C / D)

| Evaluation Dimension | **A. `Reza2kn/Shenava-Rizeh v1.0`** (`14ca75f0c5c6`) | **B. `openai/whisper-large-v3-turbo-int8`** (`41f01f3fe87f`) | **C. `Qwen/Qwen3-ASR-0.6B-int8`** (`5eb144179a02`) | **D. Provisional Dual-Model (`A + B` Routed) & Alternatives** |
| :--- | :--- | :--- | :--- | :--- |
| **License (`SPDX`)** | `Apache-2.0` (`VERIFIED_PERMISSIVE`) | `MIT` (`VERIFIED_PERMISSIVE`) | `Apache-2.0` (`VERIFIED_PERMISSIVE`) | `Apache-2.0` + `MIT` (`VERIFIED_PERMISSIVE`) |
| **Disk Footprint (Unpacked)** | **`36.43 MiB`** (`MEASURED`) | `988.59 MiB` (`MEASURED`) | `941.28 MiB` (`MEASURED`) | `1,025.02 MiB` total (`36.43 MiB` base + optional `988.59 MiB` pack) |
| **Persian (`fa`) Norm CER / WER** | **`5.71%` / `19.44%`** (`MEASURED`) | `7.71%` / `27.78%` (`MEASURED`) | `56.57%` / `74.31%` (`MEASURED` — **FAIL**) | `5.71%` / `19.44%` via `A` (FA route); `C08` NeMo 114M `NOT_RUN` |
| **English (`en`) Norm WER** | `100.00%` (**FAIL — FA-only**) | **`5.83%`** (`MEASURED`) | `13.00%` (`MEASURED`) | `5.83%` via `B` (EN route) |
| **FA-EN Concat CER / WER / Latin Recall** | `65.23%` / `74.14%` / `0.00%` (**FAIL**) | `63.90%` / `67.82%` / `17.50%` (**FAIL**) | `48.06%` / `56.90%` / `72.01%` (**FAIL** on FA) | **Routed VAD+LID CS = `NOT_RUN`** (must be built & benchmarked on real CS audio) |
| **Linux CPU `RTF` (`1x` / `25`-clip)** | **`0.0331` / `0.0360`** (`0.0299` 4T) | `0.6976` / `0.6121` | `0.6030` / `0.9970` | `0.03` (FA) / `0.61–0.70` (EN) |
| **Linux Cold Start (`ms`)** | `1,665 – 2,128 ms` (`MEASURED`) | `7,519 ms` (`MEASURED`) | `11,612 ms` (`MEASURED`) | `~1.8 s` (FA-only load); `~7.5 s` (on-demand EN load) |
| **Linux Peak RSS (`1x` / Batch)** | **`165.81 MiB`** (`204.5 MiB` `wav_0`, `836 MiB` `b=5`) | `1,382.88 MiB` (`1,823 MiB` `b=5`) | `1,588.21 MiB` (`2,292 MiB` `b=5`) | Sequential swap `<= 1.38 GiB`; concurrent `NOT_RUN` |
| **Word-Level Timestamps** | **Native CTC tokens** (`VERIFIED`; human ground truth `NOT_AVAILABLE`) | **NONE in `sherpa-onnx`** (`SEGMENT`-only) | **NONE** (aligner lacks FA) | Native CTC (FA) + **External Aligner / `whisper.cpp` DTW required for EN (`NOT_RUN`)** |
| **Silence Hallucination** | **0 words** (`10s` silence & `-45 dBFS`) | `NOT_RUN` (known Whisper risk) | `NOT_RUN` | Guarded via Silero VAD + CTC on FA |
| **Offline Verification** | **`VERIFIED`** (proxy-blackhole) | **`PARTIAL`** (raw JSON `offline_verified: false`) | `VERIFIED` (proxy-blackhole) | **`PARTIAL`** until clean single-pass `B` + OS air-gap |
| **Apple Silicon M2 (`8 GB`)** | **`NOT_RUN`** | **`NOT_RUN`** | **`NOT_RUN`** | **`NOT_RUN`** (`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`) |
| **Verdict** | **PROVISIONAL PERSIAN ENGINE** | **PROVISIONAL MULTILINGUAL ENGINE** (needs clean offline + aligner) | **REJECTED** | **LEADING ARCHITECTURE** (blocked on M2, real CS/disfluency/Praat data & aligner test) |

---

## 3. Formal Architecture Decision Record (`ADR-P02-REC-001`)

### Context
AVAPARDAZ must power both a **desktop Adobe Audition plugin** (strict offline, low-RAM `8 GB` unified memory target alongside Audition itself, fast turnaround) and the **AVAPARDAZ web app** (local companion runtime or future WebAssembly fallback) without locking the `Edit Decision Engine` or `EDL Contracts` to any single ASR checkpoint.

### Architectural Options Compared

| Criterion | Option 1: Single-Model Monolith | Option 2: Static Dual-Model (`Shenava` + `Whisper Turbo`) | Option 3: ASR + Dedicated Forced Alignment | **Option 4: Pluggable Model-Provider Architecture *(RECOMMENDED)*** |
| :--- | :--- | :--- | :--- | :--- |
| **1. Accuracy (FA / EN / CS)** | **FAIL** today — no evaluated single model passes FA + EN + CS simultaneously. | **STRONG** on pure FA (`5.71%` CER) & pure EN (`5.83%` WER); CS depends on VAD/LID routing (`NOT_RUN`). | Matches underlying ASR text accuracy; improves cut-boundary precision independent of ASR. | **BEST** — routes per-language/per-project profile to optimal local provider (`Shenava`, `Whisper`, or future fine-tuned multilingual model) without rewriting downstream engines. |
| **2. Word-Alignment Reliability** | Fails if Whisper-only (`SEGMENT`-only); lacks EN if Shenava-only. | **Asymmetric** — native CTC on FA, broken (`SEGMENT`-only) on EN. | **HIGH** — decouples word timing from autoregressive decoder limitations (fixes Whisper). | **HIGH** — standardizes mandatory `WordTimestamp[]` output contract; providers without native word timing MUST compose an aligner stage before returning to EDL. |
| **3. CPU Performance (`RTF`)** | `0.03` (if Shenava) or `0.61–0.70` (if Whisper Turbo). | Fast on Persian (`0.03`), moderate on English (`0.61–0.70`). | Adds small acoustic alignment pass (`~0.03–0.08 RTF`, `NOT_RUN` locally). | Preserves `0.03 RTF` fast-path for 90%+ Persian-only sessions; pays Whisper/aligner compute only when EN/multilingual mode is selected. |
| **4. Peak Memory (`8 GB` M2 Risk)** | Low (`~205 MiB`) for Shenava; heavy (`~1.4–1.8 GiB`) for Whisper Turbo. | **High risk if both stay resident concurrently (`~1.6–2.0 GiB+`) alongside Audition**; safe only with lazy unload/swap (`NOT_RUN` on M2). | Adds `~150–400 MiB` aligner memory if loaded simultaneously; safe if run sequentially (`unload ASR -> load aligner`). | **SAFEST** — enforces single-active-model residency (`unload-before-load` lifecycle) and explicit memory-budget telemetry per provider. |
| **5. Offline Packaging & Deployment** | Smallest (`36 MiB` or `989 MiB`). | `1.03 GiB` total if bundled together; better as `36 MiB` default + optional `989 MiB` EN pack. | Adds `~40–350 MiB` aligner model pack. | Supports modular downloadable offline packs (`fa-core: 36 MiB`, `multilingual-en: ~550–989 MiB`, `aligner`) verified by SHA-256 manifest. |
| **6. Licensing & Compliance** | Clean (`Apache-2.0` or `MIT`). | Clean (`Apache-2.0` + `MIT`), single `sherpa-onnx` binary. | Must restrict aligner to `MIT`/`Apache-2.0` (strictly exclude `CC-BY-NC-4.0` MMS!). | Isolates license metadata & attribution (`LICENSE`/`NOTICE`) per provider manifest. |
| **7. Operational Complexity** | Lowest. | Medium (requires VAD/LID routing or explicit user language mode). | Medium-High (two-stage ASR -> Aligner orchestration + boundary reconciliation). | Medium — clean `AsrProvider` + `AlignmentProvider` interfaces with deterministic fallback; avoids hard-coded engine assumptions. |
| **8. Integration Cost (Web + Audition)** | Low initially, **very high rewrite cost** when model changes. | Medium initially; fragile if `sherpa-onnx` Whisper still lacks word timestamps. | Medium; reusable across any future ASR upgrade. | **LOWEST LONG-TERM COST** — one shared local service contract (`TranscriptWithWordTimestamps`) serves both Audition plugin & Web UI. |
| **9. Adobe Audition Plugin Compatibility** | High for `36 MiB` `sherpa-onnx` C++ binary; risky if Python required. | High (`sherpa-onnx` single native C++/C-API runtime; zero Python dependency). | High **if** aligner runs on ONNX Runtime / `sherpa-onnx` C++ (reject Python-only `WhisperX` inside Audition!). | **HIGHEST** — native C++/ONNX local companion (zero Python runtime in Audition installer) with swappable model/aligner backends (`sherpa-onnx`, `whisper.cpp`). |

### Decision
- **ACCEPTED ARCHITECTURAL PATTERN:** **Option 4 — Pluggable Model-Provider Architecture** backed by **Option 3 (Optional Dedicated Forced-Alignment Stage)** for any provider lacking native word-level timestamps, implemented over native C++/ONNX local runtimes (zero Python requirement in the Adobe Audition plugin).
- **PROVISIONAL MODEL STACK (SUBJECT TO BLOCKING CLEARANCE):**
  - **Persian-Primary Provider (Default Fast-Path):** `Reza2kn/Shenava-Rizeh v1.0` (`14ca75f0c5c6`, `Apache-2.0`, `36.43 MiB`, `sherpa-onnx`) — provisional pending real spontaneous Persian podcast, disfluency, Praat word-boundary, and physical M2 validation.
  - **English / Multilingual Provider (On-Demand Pack):** Evaluate `openai/whisper-large-v3-turbo` (`41f01f3fe87f`, `MIT`) across BOTH `sherpa-onnx` INT8 + C++/ONNX forced aligner AND `whisper.cpp` GGML Q5_0 DTW before locking the production multilingual binary.
  - **Strictly Excluded from Selection:** `Qwen/Qwen3-ASR-0.6B-int8` (zero-shot Persian failure), `openai/whisper-base` FP32/INT8 (Persian accuracy & quantization regression), `facebook/mms-1b-all` & `seamless-m4t-v2-large` (`CC-BY-NC-4.0` non-commercial), `hezarai/whisper-small-fa` (`UNKNOWN` license).

---

## 4. Known Limitations & Unverified Assumptions

1. **No Production Model Final Sign-Off Yet (`P02-18 = FAIL`):** Recommending the Pluggable Model-Provider architecture resolves architectural coupling, **NOT** the missing empirical evidence required to approve a production base model.
2. **Unbenchmarked High-Potential Contenders:** `nvidia/stt_fa_fastconformer_hybrid_large` (`CC-BY-4.0`, 114M teacher of `Shenava-Rizeh`), `whisper.cpp` GGML Q5_0 on ARM64 NEON/Accelerate, and an ONNX forced aligner have **NOT** been benchmarked locally (`NOT_RUN`).
3. **Code-Switching Routing Unvalidated:** Whether VAD + language-ID routing between `Shenava-Rizeh` and `Whisper Turbo` works on rapid **intra-sentential** Persian-English tech podcasts (e.g., *"این API رو باید روی Docker بالا بیاریم"*) is **`UNKNOWN`** — sentence-level switching cannot split a 2-second mixed clause without fine-tuning or a unified bilingual model.
4. **Physical Apple Silicon M2 (`8 GB`) Validation Missing:** Memory headroom when Adobe Audition + macOS + local ASR companion run concurrently on `8 GB` unified memory is **`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`**.
