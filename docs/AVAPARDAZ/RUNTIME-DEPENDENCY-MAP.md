# نقشه وابستگی‌های زمان اجرا (AVP-P00-001 — Runtime Dependency Map)

**مأموریت:** `AVP-P00-001`  
**توضیح:** این سند صرفاً روابط واقعی اجرا (نه صرفاً ایمپورت‌های تستی یا کدهای ایزوله) را با نمودار Mermaid مستندسازی می‌کند `[OBSERVED]`.

---

## ۱. نمودار جریان اجرای واقعی برنامه کنونی (`Mermaid`)

```mermaid
flowchart TD
    HTML[index.html\n+ Google Fonts CDN] --> MAIN[src/main.tsx]
    MAIN --> BOOT[StudioRootBootstrapper.tsx]

    BOOT -->|Runs at mount| PROF[HardwareBenchmarkProfiler.ts\n2MB OPFS probe + Matrix GFLOPS]
    BOOT -->|Registers| SW[public/sw.js\nCOOP+COEP require-corp]
    BOOT -->|Checks startup| LOCK[CrashRecoveryAndSessionLock.ts\nOPFS recovery-journal]

    BOOT -->|Default Desktop| APP[src/App.tsx]
    BOOT -.->|Only if ?shell=v12| V12[DesktopAudioStudioApp.tsx\n+ useAudioStudioController.ts]
    BOOT -.->|If MOBILE_COMPANION| MOB[MobileCompanionWorkspace.tsx]

    APP -->|Upload File| FIX[audioFixtures.ts\ndecodeAudioData -> FULL RAM Float32Array]
    FIX --> STATE[(React State\nproject.pcmSources in RAM)]

    APP -->|ASR Button| RESAMP[resampler.ts -> 16k WAV Base64]
    RESAMP -->|HTTP POST| API1[/POST /api/v1/asr/transcribe\nserver.ts:133/]
    API1 -->|If GEMINI_API_KEY| GEM[GoogleGenAI\ngemini-3.5-transcribe CLOUD]
    API1 -.->|503 / Offline Fallback| FAKE[buildOfflineAcousticSegmentedTranscript\nPlaceholder Persian words]
    GEM --> ALIGN[persianAsrTranscriber.ts\nalignPersianScriptToAudio]
    FAKE --> ALIGN

    APP -->|Play| PLAY[StudioAudioTransport\naudioPlayback.ts 4s AudioBufferSourceNode]
    STATE --> PLAY
    APP -->|Export WAV| EXP[streamingChunkedRender -> FULL Float32Array\nencodeAndValidateWavExport -> FULL ArrayBuffer]
    STATE --> EXP

    APP -->|Storage Tab Test Buttons ONLY| BROKER[StorageBrokerClient 8MiB cap\nsrc/engine/storageBroker.ts]
    BROKER --> WORKER[Web Worker: src/workers/ioBroker.worker.ts\nONLY worker bundled in vite build]

    APP -->|6 Non-Core Toolbar Modals| MODALS[ASR Lab / Dev Portal / Intel /\nData Factory / Model Factory / Security]
    MODALS -->|HTTP fetch| EXPR[Express server.ts:3000\nPhases 1-14 REST + CoreAcousticCtc]

    ONNX[UnifiedOnnxPersianAsrEngine\n+ asr-inference.worker.ts\n+ StreamingExportEncoderWorker] -.->|NOT CALLED by App.tsx\nNOT bundled in dist/| DEAD_END((Disconnected from Runtime))
```

---

## ۲. جدول خلاصه مرزهای اجرایی (`[OBSERVED]`)

| لایه اجرایی | محل اجرا | فایل‌های فعال | وضعیت اتصال در `vite build` |
| --- | --- | --- | --- |
| **Main UI & State** | Browser Main Thread | `main.tsx`, `StudioRootBootstrapper.tsx`, `App.tsx`, `components/*` | باندل کامل (`index-*.js`, `1,282 kB`) |
| **Audio DSP & Timeline** | Browser Main Thread | `dsp.ts`, `timeline.ts`, `resampler.ts`, `peakPyramid.ts`, `processingGraph.ts`, `persianAsrTranscriber.ts` | باندل کامل (همه همگام روی Main Thread) |
| **Worker Storage** | Dedicated Worker | `src/workers/ioBroker.worker.ts` | باندل‌شده (`ioBroker.worker-*.js`) ولی خارج از مسیر Upload/Export |
| **Worker ASR / Export** | Dedicated Workers (طراحی‌شده) | `asr-inference.worker.ts`, `StreamingExportEncoderWorker.ts` | **باندل نشده و غیرمتصل در تولید** |
| **AudioWorklet** | Audio Rendering Thread | `playback.worklet.ts`, `public/asr-stream-worklet.js` | **غیرمتصل به `App.tsx`** |
| **Express Server** | Node.js (`tsx server.ts`) | `server.ts`, `src/asr-core/*`, `src/ai-engine/asr/*`, `src/platform/*`, `@google/genai` | فعال در پورت `3000` (اما `node server.ts` fail می‌شود) |
| **Docker / Postgres Backend** | ایزوله | `backend/*`, `deploy/docker-compose.backend.yml` | **غیرمتصل در اجرای فعلی** (بجز `PlatformLicenseService.ts`) |
