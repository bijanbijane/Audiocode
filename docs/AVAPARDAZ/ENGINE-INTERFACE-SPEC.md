# AVAPARDAZ ASR CORE — ENGINE INTERFACE SPECIFICATION (v2.0)

**Document ID:** `AVP-ENGINE-SPEC-2.0`  
**Phase:** `PHASE-00` (Frozen Target Contract for `PHASE-02` Implementation)  
**Date:** 2026-11-20  
**Scope:** Canonical shared contract consumed identically by **Adobe Audition Plugin (Companion Native Runtime)** and **Web Application (Browser WASM Runtime)**.

---

## 1. Architectural Boundary

```text
[Adobe Audition CEP Panel] --(Loopback HMAC IPC)--> [Native Companion]
                                                           |
                                               implementing AsrRuntimeAdapter
                                                           v
                                            +-----------------------------+
                                            |     AVAPARDAZ ASR CORE      |
                                            | - AudioIngestContract       |
                                            | - ModelLifecycleContract    |
                                            | - TranscriptSchema (v2)     |
                                            | - PersianLinguisticPipeline |
                                            | - Error & Memory Contracts  |
                                            +-----------------------------+
                                                           ^
                                               implementing AsrRuntimeAdapter
                                                           |
[Web App React UI] --------(Worker RPC)----------> [Browser ASR Worker]
```

Existing modules to unify into this contract in `PHASE-02`:
- `src/asr-core/CoreAsrContracts.ts` (normalization profiles, audio ingest, segment/word timing, streaming events)
- `src/processing-engine/UnifiedProcessingContract.ts` (execution modes, capability states, cancellation, error taxonomy)
- `src/lifecycle/ModelRepositoryContracts.ts` (OPFS/disk chunk manifest & SHA-256 verification)
- `src/persian-linguistics/` (tokenization, ZWNJ/orthography, code-switching, punctuation/numbers)

---

## 2. Seven-State Truthful Model Lifecycle Contract

Every runtime adapter MUST report model readiness using strictly distinct states (never conflated):

| # | State Identifier | Meaning |
| :-: | :--- | :--- |
| 1 | `RUNTIME_INSTALLED` | Execution runtime library/binary (`onnxruntime-web` WASM or native `whisper.cpp`/ORT binary) is present and probeable. |
| 2 | `MODEL_MANIFEST_EXISTS` | Signed/structured model manifest declaring files, sizes, tokenizer, license, and SHA-256 hashes is registered. |
| 3 | `MODEL_WEIGHTS_EXIST` | Actual weight files (`.onnx`, `.gguf`, `.bin`, etc.) are stored locally in OPFS or local companion disk directory. |
| 4 | `MODEL_INTEGRITY_VERIFIED` | Per-chunk and full-artifact SHA-256 digest verification succeeded offline against the manifest. |
| 5 | `MODEL_LOADED` | Model session initialized in runtime memory within `MemoryBudgetManager` limits. |
| 6 | `REAL_INFERENCE_EXECUTED` | Neural forward pass executed on non-mock 16 kHz PCM audio waveform without fatal runtime errors. |
| 7 | `REAL_TRANSCRIPTION_VERIFIED` | Decoded Persian/English/Code-Switching text verified against real speech benchmark assertions. |

---

## 3. Canonical Audio Input Contract

All runtimes normalize input media into canonical PCM before inference:
- **Sample Rate:** `16_000 Hz` (`CORE_SAMPLE_RATE = 16000`)
- **Channels:** `1` (Mono), downmixed via stereo phase inspection (`MONO_PASSTHROUGH`, `EQUAL_POWER_AVG`, `LEFT_PRIMARY_PHASE_GUARD`, or `DOMINANT_ACTIVE_CHANNEL` per `src/asr-core/CoreAudioIngestion.ts`)
- **Sample Format:** `Float32Array` normalized to `[-1.0, +1.0]` (or `Int16Array` PCM16LE for streaming IPC transport)
- **Chunking / Long-Form Windowing:** Bounded windowing (e.g., 25s–30s windows with 2s–3s overlap or VAD-guided silence valleys) so peak RAM stays within `MemoryBudgetManager` policy (≤ 1 GiB browser ceiling)
- **Integrity Metadata:** `audioSha256`, `durationSec`, `sampleCount`, `originalSampleRateHz`, `originalChannels`

---

## 4. Unified Runtime Adapter Interface (`AsrRuntimeAdapter`)

```ts
export type AsrRuntimeTarget = 'NATIVE_COMPANION_CPU' | 'BROWSER_WASM_CPU' | 'BROWSER_WEBGPU_WITH_WASM_FALLBACK';

export interface RuntimeCapabilityReport {
  readonly target: AsrRuntimeTarget;
  readonly runtimeInstalled: boolean;
  readonly runtimeVersion: string | null;
  readonly simdSupported: boolean;
  readonly crossOriginIsolated: boolean | null;
  readonly configuredThreads: number;
  readonly maxMemoryBytes: number;
  readonly supportsStreaming: boolean;
  readonly supportsWordTimestamps: boolean;
  readonly supportsForcedAlignmentFa: boolean;
  readonly requiresNetworkForInference: false; // MUST ALWAYS BE false
}

export interface AsrModelDescriptor {
  readonly modelId: string;
  readonly version: string;
  readonly family: 'WHISPER_GGML' | 'WHISPER_ONNX' | 'QWEN3_ASR' | 'FASTCONFORMER_ONNX' | 'CUSTOM_ADAPTED';
  readonly format: 'gguf' | 'ggml-bin' | 'onnx' | 'safetensors';
  readonly quantization: 'fp32' | 'fp16' | 'q8_0' | 'q5_k_m' | 'q4_k_m' | 'int8' | 'uint8';
  readonly totalBytes: number;
  readonly sha256Hex: string;
  readonly supportedLanguages: readonly ('fa' | 'en' | 'fa-en')[];
  readonly licenseSpdx: string;
}

export interface AsrTranscriptionRequest {
  readonly jobId: string;
  readonly mode: 'batch' | 'long_form' | 'streaming';
  readonly languageHint: 'fa' | 'en' | 'fa-en' | 'auto';
  readonly pcm16kMono: Float32Array;
  readonly sampleRateHz: 16000;
  readonly normalizationProfile: 'RAW_UNMODIFIED' | 'FA-STRICT-V1' | 'FA-RELAXED-V1' | 'EN-NORM-V1' | 'MIXED-NORM-V1';
  readonly enableWordTimestamps: boolean;
  readonly enableDiarization: boolean;
  readonly keyterms?: readonly string[];
}

export interface AsrRuntimeAdapter {
  readonly adapterId: string;
  probeCapabilities(): Promise<RuntimeCapabilityReport>;
  loadModel(descriptor: AsrModelDescriptor, signal?: AbortSignal): Promise<void>;
  warmup(signal?: AbortSignal): Promise<{ readonly warmupLatencyMs: number }>;
  transcribeBatch(request: AsrTranscriptionRequest, signal?: AbortSignal): Promise<AvapardazTranscriptResult>;
  transcribeStream?(
    sessionConfig: { readonly sessionId: string; readonly languageHint: 'fa' | 'en' | 'fa-en' | 'auto' },
    signal?: AbortSignal,
  ): AsrStreamingSessionHandle;
  unloadModel(): Promise<void>;
  dispose(): Promise<void>;
}
```

---

## 5. Canonical Transcript Output Schema (`AvapardazTranscriptResult`)

Both Adobe Audition Plugin and Web App MUST consume this single schema:

```ts
export interface AvapardazWordSpan {
  readonly wordId: string;
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly language: 'fa' | 'en' | 'fa-en' | 'unknown' | 'uncertain';
  readonly confidence: number | null; // null if uncalibrated
  readonly timestampOrigin: 'MODEL_NATIVE' | 'CTC_ALIGNED' | 'FORCED_ALIGNER' | 'UNAVAILABLE';
}

export interface AvapardazTranscriptSegment {
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly speakerId: string | null;
  readonly language: 'fa' | 'en' | 'fa-en' | 'unknown' | 'uncertain';
  readonly rawModelOutput: string;
  readonly normalizedText: string;
  readonly normalizedByProfile: Readonly<Record<string, string>>;
  readonly words: readonly AvapardazWordSpan[];
  readonly timestampGranularity: 'WORD' | 'SEGMENT' | 'RECORDING' | 'UNAVAILABLE';
  readonly confidenceStatus: 'CALIBRATED' | 'UNAVAILABLE_UNCALIBRATED';
  readonly calibratedConfidence: number | null;
}

export interface AvapardazTranscriptResult {
  readonly contractVersion: '2.0.0';
  readonly jobId: string;
  readonly status: 'COMPLETED' | 'PARTIAL_WITH_FAILURES' | 'CANCELLED' | 'FAILED';
  readonly runtimeTarget: AsrRuntimeTarget;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly modelSha256: string;
  readonly isGenuineNeuralModel: boolean;
  readonly executedOffline: boolean;
  readonly audioSha256: string;
  readonly audioDurationSec: number;
  readonly processingTimeMs: number;
  readonly realTimeFactor: number;
  readonly peakMemoryMb: number | null;
  readonly dominantLanguage: 'fa' | 'en' | 'fa-en' | 'unknown' | 'uncertain';
  readonly rawText: string;
  readonly normalizedText: string;
  readonly segments: readonly AvapardazTranscriptSegment[];
  readonly warnings: readonly string[];
}
```

---

## 6. Standardized Export & Host Interchange Contracts

1. **Web App Exports:** `TXT`, `SRT`, `VTT`, `JSON` (Canonical Schema v2.0), `Praat TextGrid` (reusing `src/engine/persianAsrTranscriber.ts` & `src/ai-engine/asr/PraatTextGridAndLinguisticExporter.ts`).
2. **Adobe Audition Interchange:**
   - Companion IPC v1.0.0 commands (`CAPABILITY_LIST`, `CAPABILITY_EXECUTE`, `JOB_SUBMIT`, `JOB_STATUS`, `JOB_CANCEL`, `HOST_CAPABILITY_MATRIX`).
   - Non-destructive `.sesx` v1.9 XML export & validation (`src/host-bridge/audition/AuditionHostAdapter.ts`).
   - Transcript markers/cues mapped via integer sample positions (`sample_position`, `duration_samples`) on `CanonicalProject`.

---

## 7. Failure & Cancellation Guarantees

- **Strict Error Taxonomy:** `MODEL_NOT_INSTALLED`, `MODEL_MANIFEST_INVALID`, `MODEL_INTEGRITY_FAILURE`, `LOCAL_RUNTIME_UNAVAILABLE`, `UNSUPPORTED_AUDIO_FORMAT`, `MEMORY_BUDGET_EXCEEDED`, `PROCESSING_CANCELLED`, `INFERENCE_FAILED`.
- **No Silent Fallback:** Failing local inference MUST NEVER silently route user audio to any remote cloud API.
- **Deterministic Cleanup:** Every `AbortSignal` trigger or exception MUST release `MemoryBudgetManager` reservations and abort pending worker/native jobs cleanly.
