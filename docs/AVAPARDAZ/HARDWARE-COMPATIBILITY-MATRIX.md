# AVAPARDAZ — CROSS-PLATFORM HARDWARE COMPATIBILITY MATRIX

**Document ID:** `AVP-HW-MATRIX-3.0`  
**Phase:** `PHASE-00` (`TASK AVP-P00-007`)  
**Date:** 2026-11-20  
**Evidence Policy:** No platform/architecture combination may be marked `Supported` without direct runtime execution evidence. All untested target configurations are explicitly classified as `Unverified`, `Partially Supported`, `Experimental`, or `Unsupported`.

---

## 1. Hardware Resource Tiers (Multi-Device Adaptation — Section 03.3)

| Tier ID | Tier Name | Physical RAM Band | Typical CPU Profile | Target Default Profile (Pending `PHASE-01` Benchmarks) | Concurrency Limit | Notes |
| :--- | :--- | :---: | :--- | :---: | :---: | :--- |
| **`TIER-0`** | `LOW_RESOURCE` | `4 GB – 8 GB` | Entry x86_64 / ARM64 (2–4 cores, no AVX2 or mobile thermal cap) | `AVP_MODEL_LITE` | `1` job | Aggressive chunking (10–15s), single active model, unload immediately on idle/pressure |
| **`TIER-1`** | `MAINSTREAM` | `8 GB – 16 GB` | Mid-range x86_64 (SSE4.2/AVX2) or Apple Silicon M-series base (4–8 cores) | `AVP_MODEL_BALANCED` | `1` job | Standard chunking (20–30s), bounded memory reservation, no parallel large models |
| **`TIER-2`** | `PERFORMANCE` | `16 GB – 32 GB` | Modern x86_64 AVX2 / Apple Silicon Pro (8–12 cores) | `AVP_MODEL_BALANCED` or `AVP_MODEL_QUALITY` | `1–2` jobs | Eligible for Quality profile after `PHASE-01` RTF/RAM validation |
| **`TIER-3`** | `WORKSTATION` | `32 GB – 64 GB+` | High-core x86_64 (AVX2/AVX-512) / Apple Silicon Max/Ultra (12+ cores) | `AVP_MODEL_QUALITY` | `2` jobs | Supports larger quantized models + parallel diarization/alignment pipelines |

> **Important:** RAM alone never determines performance. `DeviceCapabilityDetector` MUST combine available memory with CPU concurrency/instruction features (`SSE4.2`, `AVX2`, `AVX512`, `NEON`) and empirical microbenchmarks (`HardwareBenchmarkProfiler.ts`) rather than hardcoding Apple M2 or any single reference machine.

---

## 2. Web Application Compatibility Matrix (Browser Sandbox — Product B)

### 2.1 OS × Architecture × Browser Matrix

| OS | CPU Arch | Browser | Priority | Current Status (`PHASE-00`) | Evidence & Known Constraints |
| :--- | :---: | :--- | :---: | :---: | :--- |
| **Windows 11** | `x86_64` | Chrome / Edge | Primary | `Unverified` | Target primary desktop web tier; requires Phase-05 WASM SIMD/OPFS tests |
| **Windows 11** | `x86_64` | Firefox | Primary | `Unverified` | `navigator.deviceMemory` unavailable in Firefox; must use conservative `UNKNOWN` fallback |
| **Windows 10** | `x86_64` | Chrome / Edge / Firefox | Compatibility | `Unverified` | Supported browser configurations only |
| **Windows** | `ARM64` | Chrome / Edge | Required Evaluation | `Unverified` | Native ARM64 browser WASM SIMD requires device verification |
| **macOS** | `ARM64` (Apple Silicon) | Chrome / Safari / Firefox | Primary | `Unverified` | Safari lacks `navigator.deviceMemory` and has stricter OPFS/WASM memory caps |
| **macOS** | `x86_64` (Intel) | Chrome / Safari / Firefox | Compatibility | `Unverified` | Must evaluate single-thread & SIMD RTF on older Intel Macs |
| **Linux** | `x86_64` | Chrome / Chromium | Primary | `Partially Supported` | **[OBSERVED/TESTED]:** Studio UI + `COOP: same-origin` / `COEP: credentialless` + `onnxruntime-web@1.31.1` verified in container Chromium (`0` console errors); neural WASM inference is `Unverified` (`0` `.onnx` weights, `/public/ort/` absent) |
| **Linux** | `x86_64` | Firefox | Primary | `Unverified` | Requires Phase-05/08 browser testing |
| **Linux** | `ARM64` | Chrome / Firefox | Extended Evaluation | `Unverified` | Requires ARM64 runner |
| **Android** | `ARM64` | Chrome | Mobile Evaluation | `Experimental` | Strict tab RAM ceilings (`TIER-0` / `AVP_MODEL_LITE` only) |
| **iOS / iPadOS** | `ARM64` | Safari | Mobile Evaluation | `Experimental` | Strict Safari Jetsam memory limits (~384 MiB WASM ceiling), no `deviceMemory`, limited `SharedArrayBuffer` |

### 2.2 Browser Runtime Capability Groups

| Capability Group | Detection Method (Local Only) | Status (`PHASE-00`) | Fallback Behavior |
| :--- | :--- | :---: | :--- |
| **`WASM_BASELINE`** | `typeof WebAssembly === 'object'` + minimal module compile | `Partially Supported` | Hard floor for browser local execution; single-threaded WASM |
| **`WASM_SIMD`** | Actual 128-bit SIMD bytecode validation (`WebAssembly.validate(SIMD_PROBE_BYTES)`) — **NOT** assumed from `typeof WebAssembly` | `Unverified` (probe missing in `ResilientAiRuntime.ts`; must add in `PHASE-02`/`PHASE-05`) | Fall back to `WASM_BASELINE` (slower RTF, warn user, never upload to Cloud) |
| **`WASM_THREADS`** | `globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function'` | `Partially Supported` (`server.ts:143-144` & `public/sw.js:36-37` emit `COOP/COEP`; worker inference untested) | Fall back cleanly to single-threaded `WASM_SIMD` (`numThreads = 1`) |
| **`WEBGPU`** | `navigator.gpu?.requestAdapter()` + runtime op probe | `Experimental` | Automatic fallback to `WASM_SIMD` on adapter loss or unsupported ONNX op (`WebWorkerOrtRuntimeProvider.ts:158`) |

---

## 3. Adobe Audition Plugin Compatibility Matrix (Desktop Host + Native Companion — Product A)

> **Rule:** Linux is **NOT** an Adobe Audition target (`Unsupported` for Audition Plugin; supported for Web App). All desktop Adobe Audition host capabilities remain `Unverified` from this Linux container.

### 3.1 OS × Architecture × Host Matrix

| OS | CPU Arch | Extension Path | Companion Native Runtime | Current Status (`PHASE-00`) | Evidence & Constraints |
| :--- | :---: | :--- | :--- | :---: | :--- |
| **Windows 11** | `x86_64` | Adobe Audition CEP Panel + ExtendScript | `NATIVE_X86_64` (`SSE4.2` baseline + optional `AVX2`) | `Unverified` (owner-approved target) | Target ID: `win32-x64`; Adobe Audition 25.x; physical Windows 11 acceptance still required |
| **Windows 11** | `ARM64` | N/A for internal V1 | N/A | `Out of Scope` | Windows ARM64 is not part of the owner-approved internal V1 matrix |
| **macOS 14 / 15** | `ARM64` (Apple Silicon) | Adobe Audition CEP Panel + ExtendScript | `NATIVE_ARM64` (`NEON` + Accelerate/Metal optional) | `Unverified` (owner-approved target) | Target ID: `darwin-arm64`; Adobe Audition 25.x; physical Apple Silicon acceptance still required |
| **macOS 14 / 15** | `x86_64` (Intel) | Adobe Audition CEP Panel + ExtendScript | `NATIVE_X86_64` (`SSE4.2` baseline + optional `AVX2`) | `Unverified` (owner-approved target) | Target ID: `darwin-x64`; Adobe Audition 25.x; physical Intel acceptance still required |
| **Linux** | `x86_64` / `ARM64` | N/A | N/A (Linux Companion usable only for CI/dev CLI testing) | `Unsupported` (Adobe Audition does not exist on Linux) | Linux users run **Product B (Web App)** |



**Internal V1 scope decision (ADR-027, 2026-11-28):** Windows 11 x64, macOS 14/15 Apple Silicon, and macOS 14/15 Intel, all with Adobe Audition 25.x. `Unverified` remains the evidence status until target-specific native runtime builds and physical-host tests pass.

### 3.2 Native CPU Feature Groups (`Companion Runtime`)

| Feature Group | Requirement Policy | Status (`PHASE-00`) | Fallback Strategy |
| :--- | :--- | :---: | :--- |
| **`NATIVE_X86_64` (Baseline `SSE4.2`)** | Mandatory floor for x86_64 Windows/macOS builds | `Unverified` (no native binary built yet) | Reject unsupported pre-SSE4.2 CPUs clearly; never fall back to cloud |
| **`AVX2_CAPABLE`** | Optional acceleration dispatch (NEVER mandatory across all builds) | `Unverified` | Runtime CPUID dispatch down to SSE4.2 baseline build |
| **`AVX512`** | Optional workstation optimization (`TIER-3`) | `Unverified` | Dispatch down to `AVX2` or `SSE4.2` |
| **`NATIVE_ARM64` + `NEON_CAPABLE`** | Standard for Apple Silicon & Windows ARM64 | `Unverified` | Baseline ARMv8 NEON build |

---

## 4. Memory Classes & Browser vs Native Constraints

| Physical RAM Class | Browser Safe Working Budget (Conservative) | Native Companion Safe Working Budget | Expected Eligible Profiles (Subject to `PHASE-01` Proof) |
| :---: | :---: | :---: | :--- |
| **`4 GB`** | `<= 384 MiB` (Mobile/iOS) to `<= 512 MiB` (Desktop tab) | `<= 1.2 GiB` | `AVP_MODEL_LITE` only (strict chunking) |
| **`8 GB`** | `<= 768 MiB – 1,024 MiB` (`MemoryPolicy` 1 GiB ceiling) | `<= 2.5 GiB` | `AVP_MODEL_LITE`, potentially `AVP_MODEL_BALANCED` (quantized) |
| **`16 GB`** | `<= 1,024 MiB` (browser sandbox cap remains conservative) | `<= 5.0 GiB` | `AVP_MODEL_LITE`, `AVP_MODEL_BALANCED`, potentially `AVP_MODEL_QUALITY` (Native) |
| **`32 GB`** | `<= 1,536 MiB` (subject to browser WASM 32-bit 4 GiB address space limit) | `<= 10.0 GiB` | All profiles (`LITE`, `BALANCED`, `QUALITY`) |
| **`64 GB+`** | `<= 2,048 MiB` (browser WASM32 ceiling still applies) | `<= 16.0 GiB` | All profiles + concurrent multi-stage pipelines |

> **Critical Browser Constraint:** Standard 32-bit WebAssembly (`wasm32`) has a hard theoretical address-space ceiling (2–4 GiB per tab/worker depending on browser engine) regardless of whether the host computer has 32 GB or 64 GB physical RAM. Therefore, large Quality models (`> 1 GB` weights) belong primarily to the **Native Companion** (Adobe Audition), while Web App focuses on quantized `LITE` and `BALANCED` models.
