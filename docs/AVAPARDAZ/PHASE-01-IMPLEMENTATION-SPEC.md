# مشخصات اجرایی فاز ۱: ران‌تایم محلی و مهندسی حافظه (AVP-P01-001 — Phase 01 Implementation Spec)

**مأموریت بعدی مجاز:** `AVP-P01-001` (پس از بررسی و تایید گزارش فاز صفر توسط کاربر — در فاز ۰ شروع نشود)  
**تمرکز انحصاری فاز ۱:** مهندسی ران‌تایم محلی، قطع وابستگی اجباری ابر از مسیر استودیو، پیاده‌سازی بودجه حافظه ۱,۰۲۴ MiB، و تبدیل Decode / Cache / Playback / Export به جریان بلوکی OPFS (بدون تغییر یا توسعه مدل جدید ASR در این فاز).

---

## ۱. فایل‌های جدید که باید ساخته شوند (`Exact Files to Create`)

| مسیر فایل جدید | مسئولیت و نوع قرارداد | مالکیت Thread |
| --- | --- | --- |
| `src/runtime/MemoryBudgetManager.ts` | پیاده‌سازی `AVAPARDAZ_MEMORY_POLICY` (`target=850 MiB`, `throttle=900 MiB`, `emergency=950 MiB`, `hardLimit=1024 MiB`, `audioCache=32 MiB`)، کلاس `AllocationRegistry` (ثبت دسته‌ای تخصیص‌های کنترل‌شده بافری، حذف شمارش تکراری) و `MemoryPressureController` (تخلیه اضطراری LRU، کندسازی/توقف کارهای پس‌زمینه در `>= 900 MiB`) | Main + Worker Telemetry Sync |
| `src/runtime/MemoryBudgetManager.test.ts` | آزمون‌های واحد (`node:test` یا `vitest`) برای آستانه‌های 850 / 900 / 950 / 1024 MiB، رد تخصیص مازاد، و واکنش به فشار حافظه | Test Runner |
| `src/engine/streamingIngest.ts` | جایگزین بلوکی برای `ingestUploadedAudioFile`: خواندن تدریجی فایل (`file.slice(...)`) یا دیکد تکه‌ای بدون نگهداری `AudioBuffer` و `Float32Array` کامل در React State، نوشتن بلوک‌های ۴ ثانیه‌ای (`192,000` نمونه/کانال یا چانک ثابت) به `StorageBrokerClient` / OPFS، و ساخت `PeakPyramid` به‌صورت افزایشی (`O(chunks)` RAM) | Worker / Bounded Main Steps |
| `src/engine/streamingIngest.test.ts` | تست‌های برآورد و کنترل حافظه اوج حین ورود صوت چنددقیقه‌ای/بلوکی و تایید عدم نگهداری `pcmSources` کامل | Test Runner |
| `src/runtime/LocalExecutionPolicy.ts` | سیاست قطعی `LOCAL_ONLY_PRIVACY` (مسدودسازی ارسال صوت/متن کاربر به `/api/v1/asr/transcribe` یا دامنه‌های بیرونی در ران‌تایم محصول + Audit hook شبکه) | Main & Worker |

---

## ۲. فایل‌های موجود که باید اصلاح شوند (`Exact Files to Modify`)

| فایل موجود | تغییرات دقیق مورد نیاز | کلاس‌های موجود برای استفاده مجدد (بدون بازنویسی تکراری!) |
| --- | --- | --- |
| `src/App.tsx` | ۱) حذف `project.pcmSources[assetId]` به‌عنوان مخزن کامل PCM از State (جایگزینی با متادیتای دارایی + `PeakPyramid` + خوانش درخواستی از `StorageBrokerClient`);<br>۲) تغییر مقدار `new StorageBrokerClient(1024 * 1024 * 8)` در خط `208` به `AVAPARDAZ_MEMORY_POLICY.audioCacheBytes` (`32 * 1024 * 1024`) و اتصال آن به `MemoryBudgetManager`;<br>۳) قطع `fetch('/api/v1/asr/transcribe')` از `handleRunPersianAsr` و حذف سقوط به کلمات ساختگی (`buildOfflineAcousticSegmentedTranscript`) — نمایش وضعیت صادقانه «آماده اتصال موتور محلی فاز ۲» به‌جای کلمات جعلی;<br>۴) جایگزینی فراخوانی `streamingChunkedRender` + `encodeAndValidateWavExport` در `handleOpenExport` با `ParallelChunkRenderCoordinator` + `StreamingWavExportEncoder`;<br>۵) اتصال فراخوانی `CrashRecoveryAndSessionLock.writeRecoveryCheckpoint()` پس از commit تراکنش‌های تایم‌لاین. | استفاده مجدد از `StorageBrokerClient`, `RollingLruBlockCache`, `ParallelChunkRenderCoordinator`, `StreamingWavExportEncoder`, `CrashRecoveryAndSessionLock`, `AudioSecurityGuard`, `buildPeakPyramid` |
| `src/engine/audioFixtures.ts` | تبدیل `LoadedStudioProject` به مدل مبتنی بر مرجع بلوک (`AssetBlockManifest`) به‌جای نگهداشتن `Record<string, Float32Array>` تمام طول فایل در RAM؛ کوچک‌سازی/انتقال `ingestUploadedAudioFile` به استفاده از `streamingIngest.ts`. | `AudioSecurityGuard`, `extractAcousticProfile`, `buildPeakPyramid` |
| `src/engine/storageBroker.ts` | ۱) اتصال `RollingLruBlockCache` به `MemoryBudgetManager.registerCategory('audio_cache', ...)` و کاهش داینامیک کش هنگام عبور از `850 MiB`/`950 MiB`;<br>۲) افزودن متد `streamReadRange(assetId, startSample, length)` برای خواندن پنجره انتخاب‌شده از OPFS/LRU جهت پخش، DSP و رندر بدون بارگذاری کل فایل;<br>۳) هندل کردن خطای `QuotaExceededError` با آزادسازی بلوک‌های قابل حذف. | `RollingLruBlockCache`, `buildSeekTable`, `ioBroker.worker.ts` |
| `src/workers/ioBroker.worker.ts` | اعمال سقف سخت روی `memoryFallbackStore` (هنگام نبود OPFS) مطابق `audioCacheBytes` (۳۲ MiB + LRU eviction داخل Worker) تا در مرورگر/تست بدون OPFS انفجار RAM رخ ندهد؛ استفاده یکنواخت از Transferable ArrayBuffers. | ساختار پیام فعلی `ioBroker.worker.ts` |
| `src/engine/audioPlayback.ts` | ۱) بازنویسی `StudioAudioTransport` برای خواندن بلوکی از `StorageBrokerClient.streamReadRange` (و پشتیبانی مسیر `StreamingPlaybackPumpController` + `SharedAudioRingBuffer` در صورت `crossOriginIsolated`);<br>۲) حذف یا علامت‌گذاری `streamingChunkedRender` تمام-RAM به نفع خروجی بلوکی که هرگز `new Float32Array(totalSamples)` کامل نسازد. | `StreamingPlaybackPumpController`, `SharedAudioRingBuffer`, `processChunkWithPreRoll` (`src/engine/processingGraph.ts`) |
| `src/engine/resampler.ts` | افزودن تابع `resampleChunkedTo16kStream(...)` برای نمونه‌برداری بلوکی با State حفظ‌شده فیلتر Kaiser در مرز بلوک‌ها بدون تخصیص کل طول ورودی/خروجی در RAM. | هسته ریاضی `besselI0` و ضرایب در `resampler.ts` |
| `server.ts` و `package.json` | مسدودسازی/ایزوله‌سازی مسیر `POST /api/v1/asr/transcribe` در حالت استودیوی محلی (عدم فراخوانی `@google/genai` یا برگرداندن `410/503` با پیام Local-Only Policy) و آماده‌سازی حذف `@google/genai` پس از تایید نبود مصرف‌کننده باقی‌مانده؛ یکدست‌سازی هدر `COOP/COEP` بین `server.ts` و `public/sw.js` (`credentialless` یا `require-corp` هماهنگ با حذف فونت CDN). | `server.ts` و `OfflineFirstServiceWorker.ts` |

---

## ۳. قراردادها و رابط‌های کلیدی فاز ۱

```typescript
export const AVAPARDAZ_MEMORY_POLICY = {
  hardLimitBytes: 1024 * 1024 * 1024, // 1,024 MiB
  targetBytes: 850 * 1024 * 1024,     // 850 MiB warning
  throttleBytes: 900 * 1024 * 1024,   // 900 MiB pause non-critical bg tasks
  emergencyBytes: 950 * 1024 * 1024,  // 950 MiB force LRU eviction & abort unsafe jobs
  audioCacheBytes: 32 * 1024 * 1024,  // 32 MiB starting LRU audio block cache
} as const;

export type MemoryPressureLevel = 'NORMAL' | 'HIGH' | 'THROTTLE' | 'EMERGENCY';
```

- **مالکیت Workerها در فاز ۱:**
  - `ioBroker.worker.ts` تنها مالک OPFS `createSyncAccessHandle` و مدیریت بلوک‌های صوتی خام خواهد بود.
  - انتقال آرایه‌ها بین Main Thread و `ioBroker.worker.ts` منحصراً با `[buffer]` Transferable انجام می‌شود (بدون کپی اضافه).

---

## ۴. ترتیب اجرا و معیارهای پذیرش فاز ۱ (`Acceptance Criteria`)

1. **ترتیب اجرا:**
   1) ایجاد `MemoryBudgetManager.ts` + تست واحد؛
   2) سخت‌سازی `ioBroker.worker.ts` + `storageBroker.ts` (رفع ناهماهنگی 8 MiB / 32 MiB و سقف `memoryFallbackStore` + `streamReadRange`)؛
   3) پیاده‌سازی `streamingIngest.ts` و حذف `project.pcmSources` تمام-فایل از `App.tsx`؛
   4) اتصال پخش پنجره‌ای و رندر/Export بلوکی (`ParallelChunkRenderCoordinator` + `StreamingWavExportEncoder`)؛
   5) قطع مسیر ابری `/api/v1/asr/transcribe` و کلمات ساختگی از `App.tsx` (با نگهداری گزارش وضعیت شفاف تا استقرار ONNX در فاز ۲)؛
   6) اجرای همه تست‌های قدیمی + تست‌های جدید + تست فشار مصنوعی ۳۰ تا ۱۲۰ دقیقه‌ای (بدون نگهداشتن کامل PCM در RAM).
2. **معیارهای پذیرش فاز ۱:**
   - هیچ `AudioBuffer` یا `Float32Array` برابر با کل طول یک فایل صوتی طولانی در React State یا حافظه رندر/Export تخصیص داده نشود.
   - کش بلوکی روی دیسک (OPFS) و کش RAM زیر `32 MiB` پیش‌فرض بماند و در شبیه‌سازی `>= 950 MiB` تخلیه اضطراری بدون کرش رخ دهد.
   - هیچ درخواست شبکه‌ای شامل صوت کاربر به `@google/genai` یا بیرون از `origin` محلی ارسال نشود.
   - تمامی تست‌های قبلی (Vitest + `node:test`) + `tsc --noEmit` + `vite build` سبز باقی بمانند.
