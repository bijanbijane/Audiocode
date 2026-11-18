# PROVIDER ADAPTER CONTRACT — PHASE 3 ENGINEERING SPECIFICATION

**Document Version:** `1.0.0-phase3`  
**Implementation Module:** `/src/ai-engine/asr/AsrExperimentationLabCore.ts` & `/src/ai-engine/asr/AsrDatasetAndBehavioralBenchmarkEngine.ts`

---

## 1. Provider-Independent Adapter Interface (`AsrProviderAdapter`)

Every commercial cloud API and self-hosted open-weight model in the ASR Lab must implement the normalized `AsrProviderAdapter` contract without leaking provider-specific JSON fields into the core evaluator or frontend:

```typescript
export interface AsrProviderAdapter {
  readonly descriptor: AsrEngineDescriptor;
  checkAvailability(): Promise<EngineAvailabilityStatus>;
  transcribe(
    audio: ValidatedLabAudioInput,
    options: LabTranscriptionOptions
  ): Promise<NormalizedAdapterTranscriptionOutput>;
}
```

## 2. Fault Isolation & Honest Failure Semantics
- **No Silent Mock Fallback:** If an adapter lacks its required environment credential (`ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`) or GPU worker endpoint, `checkAvailability()` returns `available: false` with an explicit diagnostic reason, and `transcribe()` returns status `SKIPPED_UNAVAILABLE` rather than fabricating synthetic output.
- **Per-Engine Fault Containment:** In multi-engine experiments (`runAsrLabExperiment`), each adapter executes inside an isolated try/catch boundary with secret redaction (`sanitizeSecretsFromText`), ensuring one provider timeout never aborts sibling engines.
