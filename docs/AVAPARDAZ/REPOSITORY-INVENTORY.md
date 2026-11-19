# فهرست جامع مخزن و طبقه‌بندی زیرسیستم‌ها (AVP-P00-001 — Repository Inventory)

**مأموریت:** `AVP-P00-001`  
**استاندارد طبقه‌بندی شواهد:** `[OBSERVED]` (مشاهده مستقیم در کد/فایل‌سیستم)، `[TESTED]` (تایید در تست اجراشده)، `[INFERRED]` (استنباط از شواهد متعدد)، `[UNKNOWN]` (اطلاعات ناکافی).

---

## ۱. نمای کلی ریشه و پوشه‌ها (`[OBSERVED]`)

| مسیر | تعداد فایل | طبقه‌بندی نقشه راه | وضعیت واقعی در ران‌تایم فعلی |
| --- | :---: | --- | --- |
| `src/` | **۲۹۲** | هسته برنامه کلاینت، موتورها، کامپوننت‌ها، تست‌ها | ترکیبی از هسته فعال استودیو (`App.tsx`)، پوسته موازی (`?shell=v12`)، آزمایشگاه ASR، پورتال و شبیه‌سازها |
| `packages/` | **۳۸** | پکیج‌های `audio-runtime` و `persian-core` | عمدتاً با تست واحد پوشش داده شده‌اند؛ تنها بخشی از `SensitiveContentAndPiiRedactorEngine` در `App.tsx` ایمپورت می‌شود |
| `backend/` | **۶۳** | سرویس Fastify + PostgreSQL + Docker + تست | تنها `PlatformLicenseService.ts` در `server.ts:8` ایمپورت می‌شود؛ کل `backend/src/server.ts` در `npm run dev` غیرفعال است |
| `wasm-audio-core/` | **۵** | سورس Rust + Cargo (`symphonia`, `rubato`, `fft_radix2_f32`) | کد Rust موجود است اما هیچ فایل کامپایل‌شده `.wasm` در پروژه یا `public/` یافت نشد `[OBSERVED]` |
| `public/` | **۹** | `sw.js`، `asr-stream-worklet.js`، آیکون PWA، `manifest.webmanifest` | `sw.js` در `StudioRootBootstrapper.tsx:211` رجیستر می‌شود؛ `/ort/` یا وزن `.onnx` وجود ندارد |
| `docs/` (قدیمی) | پیشین | نقشه‌ها و Specهای v1.2 | مرجع تاریخی |
| `RESEARCH/`, `ARCHITECTURE/`, `ENGINEERING/`, `MODEL-RESEARCH/`, `BENCHMARK/`, `STREAMING/`, `DATASET/`, `MODEL-DEVELOPMENT/`, `PLATFORM/` | ~۶۰+ | مستندات آزمایشگاه ASR و پلتفرم ابری/هیبریدی | مرجع پژوهشی؛ بیانگر معماری آزمایشگاه چندموتوره (نه محدودیت Local-First v2) |
| `README.md` (در ریشه) | **۰** | مفقود | `[OBSERVED]` فایل `README.md` در ریشه مخزن وجود ندارد |

---

## ۲. موجودی ۱۲گانه ماژول‌ها و زیرسیستم‌ها

### ۲.۱. ماژول‌های ران‌تایم تولیدی کلاینت (`Production Runtime — Browser`)
- **Subsystem:** Studio Bootstrap & Workspace Shell (`StudioRootBootstrapper`, `src/App.tsx`) `[OBSERVED]`
  - **Primary Entry Point:** `index.html` → `src/main.tsx:1` → `StudioRootBootstrapper.tsx:184` → `src/App.tsx:117`
  - **Public Interfaces:** `WorkspaceTab`, `StudioRootBootstrapperProps`, `LoadedStudioProject`
  - **Runtime Callers:** Browser DOM (`#root`)
  - **Dependencies:** `HardwareBenchmarkProfiler`, `CrashRecoveryAndSessionLock`, `ResilientAiRuntimeManager`, `HeaderNav`, `WaveformCanvas`, `TranscriptPanel`, `SuggestionsPanel`, `DspControlRack`, `AuditionTransportBar`, `AuditionSideDock`, `ExportModal`
  - **External Dependencies:** `https://fonts.googleapis.com` در `index.html:20-22`؛ `fetch('/api/v1/asr/transcribe')` در `App.tsx:601`
  - **Execution Status:** **فعال و عملیاتی** (با بارگذاری پروژه نمونه مصنوعی و نگهداری کل PCM در RAM).

- **Subsystem:** Audio DSP, Resampling & Graph PDC (`src/engine/dsp.ts`, `resampler.ts`, `processingGraph.ts`, `peakPyramid.ts`, `timebase.ts`) `[OBSERVED]` `[TESTED]`
  - **Primary Entry Point:** `dsp.ts`, `resampler.ts`, `processingGraph.ts`
  - **Concrete Implementations:** `extractAcousticProfile`, `findMinimumRmsValley`, `snapToZeroCrossing`, `applyEqualPowerMicroCrossfade`, `detectPitchPlateauSegments`, `detectLongPauses`, `resampleTo16kMono` (Windowed-Sinc Kaiser β=6.5), `planProcessingGraphPdc` (Kahn DAG), `processChunkWithPreRoll`, `buildPeakPyramid`
  - **Runtime Callers:** `App.tsx`, `audioFixtures.ts`, `audioPlayback.ts`, `persianAsrTranscriber.ts`
  - **Tests:** `dsp.test.ts`, `resampler.test.ts`, `processingGraph.test.ts` (پاس در `npm run test:unit`)
  - **Execution Status:** **عملیاتی روی Main Thread** (هنوز به Worker منتقل نشده‌اند).

- **Subsystem:** Non-Destructive Timeline & History (`src/engine/timeline.ts`) `[OBSERVED]` `[TESTED]`
  - **Concrete Implementations:** `TimelineHistoryManager`, `applySyncSafeCut`, `applyBatchRecommendationsAtomically`, `splitTrackClipsAtPlayhead`, `projectTokensAfterCut`
  - **Runtime Callers:** `App.tsx`
  - **Tests:** `timeline.test.ts`, `full-pipeline.spec.ts`
  - **Execution Status:** **عملیاتی**.

### ۲.۲. ماژول‌های Worker مرورگر و WebAudio Worklet
- `src/workers/ioBroker.worker.ts` `[OBSERVED]` — تنها Worker باندل‌شده در `vite build` (`dist/assets/ioBroker.worker-*.js`)؛ پیاده‌ساز OPFS `createSyncAccessHandle` و `memoryFallbackStore`. فراخوانی‌شده از `StorageBrokerClient` در `App.tsx` (اما فقط برای تست‌های Storage tab؛ نه در مسیر Upload/Playback).
- `src/ai-engine/workers/asr-inference.worker.ts` `[OBSERVED]` — `SequentialPersianAiPipelineRunner`؛ در بیلد کلاینت ایمپورت نشده است (`Not Bundled`).
- `packages/audio-runtime/src/StreamingExportEncoderWorker.ts` و `src/processing-core/StreamingExportEncoderWorker.ts` `[OBSERVED]` — رمزگذار WAV جریانی با OPFS؛ در بیلد فعلی به `App.tsx` متصل نیستند.
- `src/audio-engine/playback.worklet.ts` `[OBSERVED]` — `StreamingPlaybackProcessor` متصل به `SharedAudioRingBuffer`؛ تنها در مسیر قطعه‌ای غیرمتصل، نه در `StudioAudioTransport` فعال.
- `public/asr-stream-worklet.js` `[OBSERVED]` — `AvapardazAsrStreamProcessor` (بافر ۱۰۲۴ نمونه)؛ بدون مصرف‌کننده فعال در `App.tsx` (`[INFERRED]` از grep).

### ۲.۳. ماژول‌های پژوهش، آزمایشگاه، کارخانه و پورتال (`Research / Dev-Only / Platform Overlays`)
- `src/ai-engine/asr/AsrExperimentationLabCore.ts` (`PHASE1_ENGINE_REGISTRY`)
- `src/ai-engine/asr/AsrDatasetAndBehavioralBenchmarkEngine.ts`
- `src/ai-engine/asr/IndependentAsrModelDevelopmentEngine.ts`
- `src/ai-engine/asr/AdaptiveAsrRouterEngine.ts`
- `src/ai-engine/asr/AdvancedModelResearchAndArchitectureEngine.ts`
- `src/ai-engine/asr/ContinuousLearningAndEvolutionEngine.ts`
- `src/platform/*`, `src/data-factory/*`, `src/model-factory/*`, `src/intelligence/*`, `src/security/SpeechSecurity*.ts`
- **Runtime Callers:** از سمت سرور (`server.ts:11-96`) و ۶ مودال در `App.tsx:2116-2175`.
- **Execution Status:** متصل به UI اصلی از طریق دکمه‌های Toolbar (`App.tsx:1855-1914`) و اندپوینت‌های سرور، خارج از مأموریت اصلی تدوین محلی.

### ۲.۴. ماژول‌های شبیه‌ساز و آزمایشی (`Mock / Simulation / Synthetic`)
- `src/engine/persianAsrTranscriber.ts:525` (`buildOfflineAcousticSegmentedTranscript`) — تولید کلمات مصنوعی فارسی در حالت آفلاین `[OBSERVED]`.
- `src/engine/audioFixtures.ts:95,629` (`buildDefaultPersianPodcastProject`, `buildSyntheticMicRecordingPcm`) — تولید صوت و پروژه دمو `[OBSERVED]`.
- `src/asr-core/CoreAcousticCtcEngine.ts` (`synthesizeAcousticSpeechFromText`) — سنتز صوت و دیکد DFT برای تست‌های Node `[OBSERVED]`.
- `src/ui/desktop/DesktopAudioStudioApp.tsx` و `src/hooks/useAudioStudioController.ts` — پوسته جایگزین `?shell=v12` با وضعیت `aiModelReady={true}` ثابت در `StudioRootBootstrapper.tsx:416` `[OBSERVED]`.

### ۲.۵. ماژول‌های سرور-تنها (`Server-Only`)
- `server.ts` — میزبان Express روی پورت `3000`، ایمپورت `GoogleGenAI` (`@google/genai`), `PlatformLicenseService`, `CoreModelRouter`, و Vite dev middleware `[OBSERVED]`.
- `src/asr-core/*` — وابسته به `node:fs` و `node:crypto` (غیرقابل اجرا در مرورگر) `[OBSERVED]`.
- `backend/*` — ۶۳ فایل بک‌اند Fastify + مهاجرت‌های PostgreSQL (`backend/db/*.sql`) و Docker (`deploy/docker-compose.backend.yml`) `[OBSERVED]`.

### ۲.۶. ماژول‌های WASM
- `wasm-audio-core/src/lib.rs` (StreamingPeakPyramidBuilder, StatefulPersianVoiceDsp, de_clip_in_place, de_click_in_place, de_reverb_in_place) و `streaming_decoder.rs` (Symphonia packet indexer) `[OBSERVED]`.
- `src/processing-core/AudioRestorationEngine.ts` — پل `WasmRestorationBridge` همراه با TypeScript fallback `[OBSERVED]`.
- **Execution Status:** بدون فایل `.wasm` بیلدشده در دیسک (`[OBSERVED]`: جستجوی `*.wasm` نتیجه صفر برگرداند)؛ در مرورگر کد TypeScript fallback اجرا می‌شود `[INFERRED]`.

### ۲.۷. ماژول‌های قطعه‌ای غیرمتصل یا نیازمند اتصال (`Unconnected Reusable Core`)
- `src/ai-engine/OnnxPersianAsrAndVadAdapter.ts`, `PersianChunkedAsrWorker.ts`, `UnifiedOnnxPersianAsrEngine.ts`, `WebWorkerOrtRuntimeProvider.ts`
- `src/processing-core/ParallelChunkRenderCoordinator.ts`, `StreamingExportEncoder.ts`, `ProcessingGraphEngine.ts`, `ExportValidator.ts`
- `packages/audio-runtime/src/DirectStudioOpfsRecorder.ts`, `StreamingPlaybackPumpController.ts`, `WebGpuAcceleratedKernelRunner.ts`
- `src/project-core/TimelineTransactionEngine.ts`
