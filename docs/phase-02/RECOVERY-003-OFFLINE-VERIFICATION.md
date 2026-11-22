# AVAPARDAZ — PHASE-02 RECOVERY-003 OS-LEVEL OFFLINE VERIFICATION REPORT

**Document ID:** `AVP-P02-REC003-OFFLINE-001`  
**Execution Series:** `AVP-P02-RECOVERY-003` / `RECOVERY-004` / `RECOVERY-005`  
**Date (UTC):** `2026-11-22`  
**Primary Raw Evidence:**
- `evidence/phase02/recovery-003/00_os_netns_isolation_proof.json` (`sha256: 17709faa4b65a2d4727c02b52c4b33ab6dee73143e339c9bf5ee01325b1fa3db`)
- `evidence/phase02/recovery-003/01_os_offline_whisper_and_shenava.json` (`sha256: d7a70b2c3ab7ac6b9379dc01b5fdc354463d9d8e315c1e8f1a4f8749f96161a9`)
- `evidence/phase02/recovery-003/02_whisper_cpp_and_alignment_eval.json` (`sha256: 50cc4035ca739d5b76bcd9ee7565f5652f1fe3cd456988c26f592aed84165f56`)
- `evidence/phase02/recovery-003/03_stability_50_jobs.json` (`sha256: 080027f8342de5d213382dbe28625e90da2a7fe595ea4a7a737eb1fc18d63072`)

---

## 1. OS-Level Kernel Network-Namespace Proof (`[Observed Fact]`)

Unlike prior environment-variable-only offline checks (`HF_HUB_OFFLINE=1`), every inference, alignment, stability, and long-audio process in `RECOVERY-003`..`005` was wrapped directly in an isolated Linux kernel network namespace (`unshare -r -n`) with zero external network interfaces and zero outbound routes.

### 1.1 Independent Kernel Isolation Proof (`00_os_netns_isolation_proof.json`)

- **Isolation Mechanism:** `unshare -r -n` (per-process Linux user + network namespace; completely reversible, zero host networking modifications, zero proxy environment variables).
- **Host Network Namespace Inode:** `net:[2]`
- **Isolated Network Namespace Inode:** `net:[82]` (`distinct_kernel_netns_verified = true`)
- **`ip link` inside namespace:** `1: lo: <LOOPBACK,UP,LOWER_UP>` **ONLY** (zero `eth*`, zero external veth)
- **`ip route` inside namespace:** `::1 dev lo` and `127.0.0.0/8 dev lo` **ONLY** (zero default gateway)
- **Raw TCP Egress Attempt (`1.1.1.1:443`, no proxy env):** `OSError: [Errno 101] Network is unreachable` (`kernel_egress_blocked = true`)

### 1.2 Direct Live Per-PID Inference Process Namespace Verification (`05_direct_inference_netns_proof.json`)

To prove directly that the **actual `sherpa-onnx-offline` binary** (not merely a sibling shell) executes inside an isolated kernel network namespace with proxy environment variables stripped (`proxy_env_stripped = true`):

- **Mechanism:** `unshare -r -n` runs a pre-exec probe verifying `readlink("/proc/self/ns/net")` and confirming raw TCP `1.1.1.1:443` fails with `OSError: [Errno 101] Network is unreachable`, then calls `os.execv()` to replace the **exact same PID** with `/root/.avapardaz/runtime/bin/sherpa-onnx-offline`; the parent simultaneously reads `/proc/<pid>/ns/net` live during model execution.
- **English Whisper Large-v3-Turbo INT8 (`PID 10872`):** `host_netns = net:[2]`, live `/proc/10872/ns/net = net:[276]`, `EGRESS = OSError: [Errno 101] Network is unreachable`, `rc = 0`, `wall_sec = 12.08 s`.
- **Persian Shenava-Rizeh v1.0 INT8 (`PID 10879`):** `host_netns = net:[2]`, live `/proc/10879/ns/net = net:[278]`, `EGRESS = OSError: [Errno 101] Network is unreachable`, `rc = 0`, `wall_sec = 2.256 s`.

> **Forensic Audit Note:** In `01_os_offline_whisper_and_shenava.json`, the inline `curl` probe ran while inherited container proxy env vars pointed at `127.0.0.1:9` (`CURL_RC=7`), so both `00_os_netns_isolation_proof.json` and `05_direct_inference_netns_proof.json` were executed with proxy env vars stripped to prove true kernel-level `Errno 101` egress denial on the exact inference PIDs.

---

## 2. Granular Offline Verification Matrix (Linux `x86_64` CPU, `unshare -r -n`)

| Pipeline Stage | Runtime & Artifact | Samples / Scope | Result | Measured Key Metrics |
| --- | --- | --- | --- | --- |
| **Model Load (Cold Start)** | `sherpa-onnx-offline` (`whisper-large-v3-turbo-int8`, `Shenava-Rizeh v1.0 INT8`), `sherpa-onnx-fa` (`english-mfa-v3.1.0`), `whisper.cpp v1.9.5` | `3x` cold runs each inside `unshare -r -n` | **PASS** | Turbo EN `8,146 ms`; Turbo FA `8,053 ms`; Shenava FA `1,799 ms`; MFA EN `1,503 ms`; `whisper.cpp` `1,191–1,233 ms` |
| **English ASR (`EXP1`)** | `sherpa-onnx-offline` + `openai/whisper-large-v3-turbo-int8` (MIT) | `25` held-out EN clips (`232.98 s`) | **PASS** | `25/25` OK, `total_decode = 151.128 s`, **`RTF = 0.6487`**, Peak RSS `1,952.80 MiB`, **Norm WER `7.46%`** (Raw `14.62%`), Norm CER `2.91%`, Latin Recall `93.74%` |
| **Persian ASR — Turbo (`EXP1`)** | `sherpa-onnx-offline` + `openai/whisper-large-v3-turbo-int8` (MIT) | `25` held-out FA clips (`280.44 s`) | **PASS** | `25/25` OK, `total_decode = 236.388 s`, **`RTF = 0.8429`**, Peak RSS `2,037.02 MiB`, **Norm CER `7.18%`** (Raw `8.62%`), **Norm WER `25.81%`** (Raw `38.88%`) |
| **Persian ASR — Shenava (`EXP1`)** | `sherpa-onnx-offline` + `Reza2kn/Shenava-Rizeh v1.0 INT8` (Apache-2.0) | Identical `25` held-out FA clips (`280.44 s`) | **PASS** | `25/25` OK, `total_decode = 10.070 s`, **`RTF = 0.0359`** (`23.5×` faster!), Peak RSS `196.31 MiB` (`1x`) / `602.19 MiB` (`b=5`), **Norm CER `3.94%`** (Raw `5.60%`), **Norm WER `14.53%`** (Raw `29.74%`) |
| **English Forced Alignment (`EXP2`)** | `sherpa-onnx-fa` + `english-mfa-v3.1.0` (`CC-BY-4.0`) | `25` held-out EN clips (`529` words) | **PASS** | `25/25` OK, **`RTF = 0.01043`**, Peak RSS `169.18 MiB`, `100%` word coverage, `0` invalid/overlapping intervals |
| **Mixed 50-Job Soak (`EXP3`)** | `Shenava FA (25)` + `MFA EN (15)` + `Turbo EN (10)` | `50` consecutive netns-isolated jobs | **PASS** | `50/50` validated, `0` crashes, `0` corrupted outputs |
| **Continuous 30-Min Pipeline (`EXP4`)** | `FFmpeg` -> `Silero VAD v5` + `Whisper Turbo INT8` + `sherpa-onnx-fa` | `1,800.0 s` unbroken LibriVox recording (`5/5` contiguous windows) | **PASS** | `249` VAD segments (`3,923` words), `RTF = 0.6812`, Peak RSS `2,289.85 MiB`, `0` gaps/discontinuities; live `/proc/11051/ns/net = net:[288]` verified |
| **Full Production Pipeline (macOS M2 + Audition)** | macOS `arm64` physical air-gap + Audition coexistence | Physical Apple M2 (`8 GB`) | **NOT_RUN** | Blocked on physical M2 hardware |

---

## 3. Paired Statistical Significance (`EXP1` — Identical 25 Held-Out Persian Clips)

1,000-iteration paired bootstrap (`Shenava-Rizeh v1.0 INT8` minus `whisper-large-v3-turbo-int8` on the exact same 25 Persian utterances):

| Metric | Mean Delta (`Shenava - Turbo`) | 95% Bootstrap CI | Statistically Significant (`p < 0.05`)? |
| --- | ---: | --- | --- |
| Persian Normalized CER | **`-2.861 pp`** | `[-4.669, -1.250]` | **YES (`true`)** |
| Persian Normalized WER | **`-11.203 pp`** | `[-16.448, -6.129]` | **YES (`true`)** |
| Speedup (Decode RTF ratio) | **`23.5×` faster** (`0.0359` vs `0.8429`) | — | Deterministic |
| Single-Stream Peak RSS | **`10.4×` lower** (`196.31` vs `2,037.02 MiB`) | — | Deterministic |
