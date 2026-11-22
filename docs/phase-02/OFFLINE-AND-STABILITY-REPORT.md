# AVAPARDAZ — PHASE-02: OFFLINE ISOLATION, HALLUCINATION & STABILITY REPORT

**Document ID:** `AVP-P02-OFFLINE-2.0`  
**Execution ID:** `AVP-P02-RECOVERY-002`  
**Date:** `2026-11-22`  
**Evidence Sources:**
- `benchmarks/phase02/results-2026-11-20.json` (`sha256: 7abb940d90ae3df4176a66dac9280f105c3b7917541019f823e451ca7b866fe9`)
- `benchmarks/phase02/product-fit-results-2026-11-22.json` (`sha256: f75ff6a32f654c1cd8ed1eb4ce5274926dde6f7ab7bb51a42d40c9753a03648d`)
- `benchmarks/phase02/recovery-verification-2026-11-22.json` (`sha256: e8ebdb07764fb55c88d47d796bbdc7f4a1a9f26ed79263f7b8d6e6c7aae82b44`)
- `benchmarks/phase02/run_cpu_bakeoff.py` (`sha256: 977584c2a1f193e855076b57bbf8ccb04c12993170db2a25cf11ef4dddf8d211`)
- `benchmarks/phase02/run_product_fit_benchmark.py` (`sha256: f3c61d61fe831b6647f7af68b939a5f1957b6b61d586adb7eac0d28efbb38d54`)

**Test Environment (`ACTUAL_LINUX_CPU_RESULTS`):** `Linux 4.19.0-gvisor x86_64`, `4 vCPU` (`AVX-512 VNNI / AVX2 / SSE4.2`), `12,288 MiB RAM`, `GPU: NONE`, `sherpa-onnx-offline v2.0.2` (`ONNX Runtime 1.28.2 CPU`).  
**Target Hardware (`ACTUAL_APPLE_M2_RESULTS`):** Apple Silicon M2 / 8 GB unified memory — **`NOT_RUN`** (`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`).

---

## 1. Offline Execution Isolation Audit

### 1.1 Isolation Mechanism Used (`[Observed Fact]`)

All three Linux benchmark executions (`EVID-01`, `EVID-02`, `EVID-03`) invoked the native C++ binary `/root/.avapardaz/runtime/bin/sherpa-onnx-offline` (`v2.0.2`) inside a subprocess environment with outbound proxy-blackhole and Hugging Face offline environment variables:

```text
http_proxy=http://127.0.0.1:9
https_proxy=http://127.0.0.1:9
ALL_PROXY=http://127.0.0.1:9
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
```

### 1.2 Per-Model Offline Verification Matrix

| Model ID | Evidence Artifact | Raw JSON `offline_verified` | Process Exit Codes | Verification Status | Forensic Caveats |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **`Reza2kn/Shenava-Rizeh v1.0`** | `EVID-01`, `EVID-02`, `EVID-03` | **`true`** (all 3) | `25/25`, `10/10`, `12/12`, `5/5` (`rc=0`) | **`VERIFIED` (Process-Env Proxy Blackhole)** | Zero outbound requests expected in C++ `sherpa-onnx-offline`; kernel-level air-gap (`unshare -n` / physical Wi-Fi off) `NOT_RUN`. |
| **`openai/whisper-large-v3-turbo-int8`** | `EVID-01` | **`false`** *(Forensic Finding)* | `25/25` (`rc=0` after 10-sample `batch_size=1` recovery) | **`PARTIAL`** | Raw `results-2026-11-20.json` recorded `"offline_verified": false` and `subsets.en.total_inference_sec = 0.0` after 10 split-byte UTF-8 failures were re-run via `recovery_note`. Requires a clean single-pass `25/25` offline run to promote to `VERIFIED`. |
| **`openai/whisper-base-fp32`** | `EVID-01` | **`true`** | `25/25` (`rc=0`) | **`VERIFIED` (Proxy Blackhole)** | Rejected on accuracy. |
| **`openai/whisper-base-int8`** | `EVID-01` | **`true`** | `25/25` (`rc=0`) | **`VERIFIED` (Proxy Blackhole)** | Rejected on quantization regression. |
| **`Qwen/Qwen3-ASR-0.6B-int8`** | `EVID-01` | **`true`** | `25/25` (`rc=0`) | **`VERIFIED` (Proxy Blackhole)** | Rejected on Persian accuracy. |

> **Security & Network Audit Note:** Setting `http_proxy=http://127.0.0.1:9` blocks proxy-aware HTTP clients, but does **not** prove at the OS kernel level that a binary never opens raw TCP/UDP sockets bypassing proxy variables. Before production release (Phase 03/04), final offline sign-off must run inside an OS-enforced network-isolated namespace (`ip netns` / `unshare -n` on Linux; Little Snitch / airplane-mode / sandbox profile on macOS M2).

---

## 2. Silence & Low-Level Noise Hallucination Audit (`EVID-02`)

Hallucination during silent pauses or room-tone gaps is a major failure mode in encoder-decoder ASR (such as Whisper emitting phantom phrases like `"Thank you"` or `"زیرنویس..."`), which corrupts EDL silence cutting.

| Model | Test Input (`16 kHz` Mono PCM16) | Duration | Observed Transcript | Hallucination Detected? | Status |
| :--- | :--- | ---: | :--- | :---: | :---: |
| **`Reza2kn/Shenava-Rizeh v1.0`** | Pure digital silence (`0.0` amplitude) | `10.0 s` | `""` (empty string) | **NO (`false`)** | **`PASS`** |
| **`Reza2kn/Shenava-Rizeh v1.0`** | Synthetic room noise (`-45 dBFS`) | `10.0 s` | `""` (empty string) | **NO (`false`)** | **`PASS`** |
| **`openai/whisper-large-v3-turbo-int8`** | Pure silence / `-45 dBFS` room noise | — | `NOT_RUN` | **`NOT_RUN`** | **`NOT_RUN`** |

**Architectural Takeaway:** `Shenava-Rizeh` (CTC) naturally outputs the `<blk>` blank token across silence and `-45 dBFS` room tone with zero phantom text. `whisper-large-v3-turbo-int8` hallucination behavior under long silence / background music remains **`NOT_RUN`** and MUST be guarded by VAD (`Silero VAD`) and benchmarked before any production deployment.

---

## 3. Long-Audio Memory Stability & Chunked O(1) Profile (`EVID-02`)

Executed on `Reza2kn/Shenava-Rizeh v1.0` (`4` threads, offline) over **`300.0 s` (`5.0 min`)** processed as `12` sequential `25.0 s` chunks:

| Metric | Observed Value (`EVID-02`) | Assessment |
| :--- | ---: | :--- |
| Total Audio Processed | `300.0 s` (`5.0 min`, `12 × 25.0 s`) | Verified `5-min` chunked baseline |
| Chunks Passed (`rc = 0`) | **`12 / 12` (`100%`)** | `PASS` |
| Mean / Min / Max Chunk `RTF` | `0.0292` (`min 0.0263`, `max 0.0390`) | `~34×` faster than real-time |
| Min / Max Peak RSS Across Chunks | `273.20 MiB` – `279.16 MiB` | **`5.96 MiB` total drift** — flat `O(1)` memory envelope |
| Word-Count Consistency Across Identical Chunks | `true` (`100%` consistent) | Zero state leakage across chunks |
| **30–60 Minute Continuous Real Recording** | **`NOT_RUN`** | **BLOCKER** for `P02-15` full acceptance |
| **`whisper-large-v3-turbo-int8` Long-Audio Memory** | **`NOT_RUN`** | **BLOCKER** for dual-model `8 GB` M2 budget |

---

## 4. Repeated-Run Determinism & Crash-Free Stability (`EVID-02` & `EVID-03`)

| Test Series | Model | Runs | Exit Code `0` Rate | Output Determinism | Mean / Median `RTF` | Peak RSS Range (`MiB`) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **`EVID-02` Sequential Stability (`10×`)** | `Reza2kn/Shenava-Rizeh v1.0` | `10` | `10 / 10` (`100%`) | **`100.0%`** byte-identical | `0.0295` (mean) | `198.15 – 204.00` |
| **`EVID-03` Recovery Repeatability (`1` warmup + `5` measured)** | `Reza2kn/Shenava-Rizeh v1.0` | `5` (`+1`) | `5 / 5` (`100%`) | **`100.0%`** (`38` tokens, `38` timestamps) | `0.0315` (median `0.455/14.466`) | `204.50` (children max) |
| **`50`-Job Repeated Stability Soak** | Any candidate | `0` | **`NOT_RUN`** | **`NOT_RUN`** | `NOT_RUN` | `NOT_RUN` |

---

## 5. Known Limitations & Acceptance Status

1. **Long-Audio Coverage Gap (`P02-15` = `PARTIAL`):** Only a `5-min` (`300 s`) chunked probe on `Shenava-Rizeh` was executed. A `30–60 min` continuous real-world podcast recording has **NOT** been run on either Linux or M2.
2. **Offline Verification Gap (`P02-16` = `PARTIAL`):** `Shenava-Rizeh` passed all process-level proxy-blackhole checks, but `whisper-large-v3-turbo-int8` retains raw JSON `"offline_verified": false` and kernel-level network-namespace / macOS airplane-mode isolation has **NOT** been run.
3. **50-Job Soak Gap (`P02-17` = `PARTIAL`):** `10/10` (`EVID-02`) and `5/5` (`EVID-03`) sequential runs succeeded with `100%` determinism on `Shenava-Rizeh` only; a `50`-job mixed-length stability soak (including long-lived worker process memory-leak profiling, not just cold CLI invocations) has **NOT** been run.
4. **Apple Silicon M2 Thermal & Memory Pressure:** `NOT_RUN` (`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`).
