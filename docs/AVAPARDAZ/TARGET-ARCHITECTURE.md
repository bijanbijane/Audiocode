# معماری هدف و فریز طراحی آواپرداز (AVP-P00-001 — Target Architecture v2.0)

**مأموریت:** `AVP-P00-001`  
**سیاست معماری منجمد:** کاملاً محلی (`Local-First / Zero Cloud Audio Inference`)، بودجه حافظه مدیریت‌شده (`Target 850 MiB / Hard Policy 1,024 MiB`)، تدوین غیرمخرب، حفظ گفتار خام (`Verbatim`)، بدون تکرار موتورها.

---

## ۱. نقشه مرزهای منطقی ۹گانه و نگاشت کد موجود (`AVP-P00-001 Section 12`)

### ۱.۱. `PRESENTATION` (نمایش و کنترل کاربر)
- **نگاشت فایل‌های موجود قابل استفاده مجدد:** `src/components/WaveformCanvas.tsx`, `TranscriptPanel.tsx`, `SuggestionsPanel.tsx`, `AuditionTransportBar.tsx`, `AuditionSideDock.tsx`, `ExportModal.tsx`, `src/ui/waveform/LodWaveformCanvasRenderer.ts`.
- **مسئولیت‌های تکراری / زائد:** دو پوسته `App.tsx` در برابر `DesktopAudioStudioApp.tsx` (`?shell=v12`)؛ ۶ مودال آزمایشگاهی/پلتفرمی در `App.tsx:1855-1914`.
- **کدهای مفقود:** نشانگر شفاف وضعیت مدل محلی + نوار وضعیت بودجه حافظه؛ پاک‌سازی کامل دکمه‌های پژوهش/پورتال از UI اصلی (در فاز ۴/۷).

### ۱.۲. `APPLICATION RUNTIME` (زمان‌بندی، لغو، پیشرفت، هماهنگی)
- **نگاشت موجود:** `src/project-core/JobSchedulerAndConcurrencyController.ts`, `src/runtime/ResilientAiRuntime.ts`, `src/runtime/HardwareBenchmarkProfiler.ts`.
- **مسئولیت‌های تکراری / شکاف:** `JobSchedulerAndConcurrencyController` به `App.tsx` متصل نیست؛ `App.tsx` عملیات سنگین (Decode/ASR/Export) را بی‌واسطه روی Main Thread یا در `setTimeout` بدون `AbortController` سراسری اجرا می‌کند.
- **حداقل بازآرایی ایمن:** اتصال یک Runtime Coordinator واحد به `App.tsx` با پشتیبانی Pause/Cancel/Progress و هماهنگی کامل با `MemoryBudgetManager`.

### ۱.۳. `MEMORY MANAGEMENT` (بودجه حافظه، حسابداری، کنترل کش، اقامت مدل)
- **نگاشت موجود:** `src/engine/lruCache.ts` (`RollingLruBlockCache`).
- **مفقود کامل (`Missing in Code`):** `MemoryBudgetManager`, `AllocationRegistry`, `MemoryPressureController`, `ModelResidencyManager` (سیاست `850 / 900 / 950 / 1024 MiB` و کش پایه `32 MiB`).
- **مسئولیت معیوب فعلی:** `App.tsx:208` کش `8 MiB` می‌سازد ولی telemetry `32 MiB` نشان می‌دهد و صوت واقعی اصلاً در کش نمی‌رود.

### ۱.۴. `AUDIO INGESTION` (اعتبارسنجی، دیکد جریانی، نمونه‌برداری، ذخیره بلوکی)
- **نگاشت موجود قابل استفاده:** `src/security/AudioSecurityGuard.ts`, `src/engine/resampler.ts` (`resampleTo16kMono`), `src/engine/peakPyramid.ts`, `wasm-audio-core/src/streaming_decoder.rs`.
- **شکاف بحرانی:** `src/engine/audioFixtures.ts:439` (`ingestUploadedAudioFile`) کل فایل را یکجا دیکد و `pcmSources` را در RAM نگه می‌دارد؛ `resampler.ts` تمام-آرایه کار می‌کند.
- **بازآرایی لازم در فاز ۱:** افزودن `streamingIngest.ts` + تبدیل `resampler.ts` به بلوکی + ذخیره مستقیم در OPFS via `ioBroker.worker.ts`.

### ۱.۵. `SPEECH RECOGNITION` (مدل آکوستیک، ران‌تایم، CTC، متن خام، هم‌ترازی)
- **نگاشت موجود قابل استفاده:** `OnnxPersianAsrAndVadAdapter.ts` (Log-Mel 80 + Radix-2 FFT + Greedy CTC), `PersianChunkedAsrWorker.ts` (`25s / 3s`), `PersianCtcForcedAligner.ts` (Log-Domain Viterbi), `PersianTextNormalizer.ts` (`3-Layer Token`), `UnifiedOnnxPersianAsrEngine.ts`, `WebWorkerOrtRuntimeProvider.ts`, `asr-inference.worker.ts`.
- **شکاف بحرانی و وابستگی نامناسب:**
  - `App.tsx:601` به‌جای این پشته به `/api/v1/asr/transcribe` (ابری) یا `buildOfflineAcousticSegmentedTranscript` (ساختگی) وصل است!
  - `onnxruntime-web` نصب نیست و وزن `.onnx` وجود ندارد.
  - `CoreAcousticCtcEngine.ts` (`src/asr-core/`) وابسته به `node:fs` است و باید در فاز ۲ از ران‌تایم مرورگر تفکیک بماند.
- **قرارداد هدف Verbatim:** ارتقای توکن استودیو به نگهداری صریح `startSample`, `endSample`, `tokenIds?` در کنار `Flicks` و حفظ ۱۰۰٪ گفتار خام (تکرار/تپق/نا완م).

### ۱.۶. `SPEECH ANALYSIS` (سکوت، تپق، تکرار، شروع ناتمام، رویدادهای غیرگفتاری)
- **نگاشت موجود قابل استفاده:** `src/engine/persianAsrTranscriber.ts` (`analyzeDeepPersianDisfluenciesAndRetakes`, `attenuateBreathsAndCoughsInAudio`, `analyzeMultiTrackCrosstalkAndDiarization`), `src/engine/dsp.ts` (`detectLongPauses`, `detectPitchPlateauSegments`, `detectCrosstalkBleed`), `src/engine/persianText.ts` (`assessTrailingEzafeRisk`).
- **مسئولیت تکراری / نامناسب:** فایل `persianAsrTranscriber.ts` بیش از ۲,۲۰۰ خط است و هم تولید کلمات جعلی، هم هم‌ترازی، هم EQ/Denoise، و هم تحلیل تپق را یکجا در هم مخلوط کرده (`Cross-Layer Tangling`)؛ در فاز ۳ باید توابع تحلیل از fallback جعلی جدا شوند.

### ۱.۷. `EDIT DECISION` (دسته‌بندی، کالیبراسیون اطمینان، اصلاح مرز برش، EDL)
- **نگاشت موجود قابل استفاده:** `src/engine/dsp.ts` (`refinePersianCutBoundary`, `findMinimumRmsValley`, `snapToZeroCrossing`), `src/contracts/project-schema.contract.ts`, `src/engine/timeline.ts` (`determineSyncSafeEditMode`).
- **بازآرایی لازم:** اتصال کالیبراسیون اطمینان واقعی از خروجی ASR محلی به پیشنهادهای ویرایش و حذف هرگونه اعمال خودکار بدون تایید کاربر.

### ۱.۸. `AUDIO RENDERING` (تایم‌لاین غیرمخرب، Crossfade، خروجی جریانی، اعتبارسنجی)
- **نگاشت موجود قابل استفاده:** `src/engine/timeline.ts`, `src/project-core/TimelineTransactionEngine.ts`, `src/processing-core/ParallelChunkRenderCoordinator.ts`, `src/processing-core/StreamingExportEncoder.ts`, `packages/audio-runtime/src/StreamingPlaybackPumpController.ts`, `src/audio-engine/SharedRingBuffer.ts`, `src/processing-core/ProcessingGraphEngine.ts`, `src/processing-core/ExportValidator.ts`.
- **مسئولیت‌های تکراری:** دو موتور تاریخچه (`TimelineHistoryManager` در برابر `TimelineTransactionEngine`) و دو موتور رندر (`streamingChunkedRender` تمام-RAM در برابر `ParallelChunkRenderCoordinator` + `StreamingWavExportEncoder`) وجود دارد؛ در فاز ۱ و ۳ باید نسخه جریانی جایگزین نسخه تمام-RAM شود.

### ۱.۹. `LOCAL PERSISTENCE` (OPFS، IndexedDB، کش مدل، Checkpoint بازیابی)
- **نگاشت موجود قابل استفاده:** `src/engine/storageBroker.ts`, `src/workers/ioBroker.worker.ts`, `src/runtime/CrashRecoveryAndSessionLock.ts`, `packages/audio-runtime/src/DirectStudioOpfsRecorder.ts`, `src/sw/OfflineFirstServiceWorker.ts`.
- **مفقود:** استفاده از `IndexedDB` برای فراداده پروژه و ذخیره Checkpoint هنگام هر تراکنش ویرایش در `App.tsx`، جداسازی حسابرسی سهمیه دیسک بین `ai-models/` و `audio-blocks/`، و اصلاح هدر متضاد COEP در `sw.js`.

---

## ۲. جدول خلاصه مرزهای معماری منجمد

```text
[Presentation: Studio UI ONLY] ──(actions)──► [Application Runtime & Job Scheduler]
                                                       │
               ┌───────────────────────────────────────┴───────────────────────────────────────┐
               ▼                                                                               ▼
   [MemoryBudgetManager]                                                         [Worker Pool (Off Main Thread)]
   (850 / 900 / 950 / 1024 MiB)                                                   ├─ IO Worker (OPFS SyncHandle + LRU 32MiB)
               ▲                                                                  ├─ ASR Worker (onnxruntime-web + 25s/3s)
               └────────────────────── Accounting & Backpressure ─────────────────┴─ Render/Export Worker (Chunks + PDC)
```
