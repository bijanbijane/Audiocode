# ماتریس قابلیت‌های مرورگر، Worker و WASM (AVP-P00-001 — Browser Capability Matrix)

**مأموریت:** `AVP-P00-001`  
**اصل ممیزی:** وجود API در مرورگر به‌معنای پیاده‌سازی در کد محصول نیست. تمام قابلیت‌ها با استناد به فایل و تست ثبت شده‌اند.

---

## ۱. جدول ممیزی ۱۴ قابلیت مرورگر و ران‌تایم (`[OBSERVED]`)

| قابلیت | تشخیص پشتیبانی (`Detection`) | پیاده‌سازی واقعی در کد (`Implementation`) | مصرف‌کننده فعال تولیدی (`App.tsx` / `Bootstrapper`) | Fallback واقعی | پوشش تست | رفتار در صورت شکست |
| --- | --- | --- | --- | --- | --- | --- |
| **Dedicated Web Workers** | `typeof Worker !== 'undefined'` (`storageBroker.ts`) | `src/workers/ioBroker.worker.ts` (فعال در Storage)؛ `asr-inference.worker.ts` و `StreamingExportEncoderWorker.ts` (غیرمتصل) | **فقط `ioBroker.worker.ts`** از `App.tsx:208` | اجرای درون-حافظه Main Thread (`storageBroker.ts`) | `full-pipeline.spec.ts` | برگشت به `memoryFallbackStore` (بدون سقف رم) |
| **Shared Workers** | ندارد | **هیچ پیاده‌سازی وجود ندارد** | ندارد | Dedicated Worker | ندارد | استفاده نمی‌شود |
| **AudioWorklet** | `typeof AudioWorkletNode !== 'undefined'` (`storageBroker.ts:17`) | `src/audio-engine/playback.worklet.ts` + `public/asr-stream-worklet.js` | **هیچ‌کدام در `App.tsx` فعال نیستند** (`StudioAudioTransport` از `AudioBufferSourceNode` استفاده می‌کند) | `AudioBufferSourceNode` پنجره‌بندی‌شده (`audioPlayback.ts`) | تست RingBuffer | عدم پخش در صورت نبود `AudioContext` |
| **SharedArrayBuffer** | `typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated` (`storageBroker.ts:16`) | `src/audio-engine/SharedRingBuffer.ts` (پشتیبان `Atomics`) | متصل به `StreamingPlaybackPumpController` در مسیر غیرفعال `?shell=v12`؛ **غیرفعال در `App.tsx`** | `ArrayBuffer` بدون `Atomics` یا `MessagePort` (`SharedRingBuffer.ts`) | `full-pipeline.spec.ts` | برگشت خودکار به `MessagePort-Fallback` |
| **WebAssembly** | ندارد (بررسی صریح روی `WebAssembly`) | `wasm-audio-core/src/*.rs` + `AudioRestorationEngine.ts:40` | **هیچ فایل `.wasm` در ریپو بیلد نشده (`0` فایل `.wasm`)** `[OBSERVED]` | پیاده‌سازی TypeScript در `AudioRestorationEngine.ts` | تست پل WASM در `full-pipeline.spec.ts` با Mock | اجرای نسخه TypeScript |
| **WASM SIMD** | فرض در `ResilientAiRuntime.ts` و `WebWorkerOrtRuntimeProvider.ts:76` (بدون probe بایت‌کد SIMD) | `ort.env.wasm.simd = true` | غیرفعال (به‌علت نبود `onnxruntime-web`) | تک‌رشته‌ای بدون SIMD | تست واحد Mock (`ResilientAiRuntime.test.ts`) | کندشدن استنتاج یا خطا هنگام نبود WASM |
| **WebGPU** | `'gpu' in navigator && requestAdapter()` (`ResilientAiRuntime.ts:53`, `HardwareBenchmarkProfiler.ts:178`) | `WebGpuAcceleratedKernelRunner.ts` + `WebWorkerOrtRuntimeProvider` | پروب در Bootstrapper برای Telemetry؛ بدون کرنل/مدل فعال در `App.tsx` | تغییر خودکار به `WASM_SIMD` (`ResilientAiRuntime.ts:62`) | `full-pipeline.spec.ts` (Mock device) | افت ایمن به CPU/WASM در `device.lost` |
| **WebNN** | **ندارد** | **ندارد** | ندارد | N/A | ندارد | استفاده نمی‌شود |
| **WebCodecs (`AudioDecoder`)** | **ندارد** (`grep` بدون نتیجه در سورس) | **ندارد** — دیکد فعلی با `AudioContext.decodeAudioData` است | ندارد | `ctx.decodeAudioData` (تمام‌فایل در RAM) | ندارد | مصرف بالای RAM روی فایل طولانی |
| **OPFS (`navigator.storage.getDirectory`)** | `'getDirectory' in navigator.storage` (`storageBroker.ts:22`) | `ioBroker.worker.ts`, `DirectStudioOpfsRecorder.ts`, `CrashRecoveryAndSessionLock.ts`, `HardwareBenchmarkProfiler.ts` | Bootstrapper (چک کرش + بنچمارک ۲MB)، دکمه‌های تب Storage در `App.tsx`؛ **در Upload/Export `App.tsx` استفاده نمی‌شود** | `memoryFallbackStore` (Map در RAM) | `DirectStudioOpfsRecorder.test.ts` (Mock OPFS) | نگه‌داری بلوک‌ها در RAM |
| **OPFS `SyncAccessHandle`** | تست runtime در `ioBroker.worker.ts:26` روی فایل پروب در Worker | `ioBroker.worker.ts:77,111`, `StreamingExportEncoderWorker.ts:478` | Worker پروب می‌گیرد؛ اما مسیر اصلی تدوین `App.tsx` بلوکی به آن نمی‌فرستد | `createWritable()` (در Workerهای دیگر) یا `memoryFallbackStore` | Mock تست | برگشت به `createWritable` یا RAM |
| **IndexedDB** | **ندارد** (`grep indexedDB` = صفر نتیجه در `src/` و `packages/`) | **هیچ استفاده‌ای در کل کد وجود ندارد** | ندارد | ندارد | ندارد | فراداده EDL و لیست پروژه‌ها با بستن تب بدون OPFS checkpoint گم می‌شود |
| **Cache Storage** | `scope.caches` در `OfflineFirstServiceWorker.ts` و `public/sw.js` | کش پوسته برنامه (`paudio-shell-v1.2.0`), bypass برای `/models/` و `/api/` | فعال از طریق رجیستر `/sw.js` در `StudioRootBootstrapper.tsx:211` | `Response` خطای ۵۰۳ آفلاین | `OfflineFirstServiceWorker.test.ts` | در نبود شبکه و کش، ۵۰۳ برمی‌گرداند |
| **Cross-Origin Isolation (`COOP/COEP`)** | `self.crossOriginIsolated` (`storageBroker.ts:15`) | هدرها در `server.ts:125-126`, `vite.config.ts:46-47` و `public/sw.js:16-17` | فعال در Express و Vite Dev Server | `MessagePort-Fallback` | تست هدر در `OfflineFirstServiceWorker.test.ts` | از کار افتادن `SharedArrayBuffer` و Multi-thread WASM |

---

## ۲. بررسی تضاد COOP / COEP با دارایی‌های شخص ثالث (`[OBSERVED]`)

- در `server.ts:125-126` و `vite.config.ts:46-47` سیاست **`Cross-Origin-Embedder-Policy: credentialless`** تنظیم شده، **اما** در `public/sw.js:17` و `src/sw/OfflineFirstServiceWorker.ts` سیاست سخت‌گیرانه‌تر **`require-corp`** روی تمام پاسخ‌های رهگیری‌شده تزریق می‌شود!
- **پیامد مستقیم (`[INFERRED]`):**
  1. وجود دو مقدار ناسازگار (`credentialless` در سرور در برابر `require-corp` در Service Worker) می‌تواند در رفرش‌های بعدی تحت کنترل SW رفتار متفاوتی ایجاد کند.
  2. فراخوانی فونت از `https://fonts.googleapis.com` و `https://fonts.gstatic.com` در `index.html:20-22` در صورت نبود هدرهای مناسب یا فعال شدن `require-corp` و همچنین در حالت آفلاین با شکست مواجه می‌شود و **سیاست آفلاین مطلق را نقض می‌کند**.

---

## ۳. ماتریس سازگاری مرورگرهای دسکتاپ (بر اساس مستندات استاندارد وب و بررسی کد)

*(توضیح: مطابق قوانین ممیزی، هیچ درصد ساختگی گزارش نمی‌شود و رفتار دقیق بر اساس مشخصات پلتفرم مرورگرها ثبت شده است.)*

| قابلیت | Chromium Desktop (Chrome / Edge) | Firefox Desktop | Safari Desktop (macOS) |
| --- | --- | --- | --- |
| **Dedicated Web Worker + Transferable** | پشتیبانی کامل | پشتیبانی کامل | پشتیبانی کامل |
| **`SharedArrayBuffer` (با COOP+COEP)** | پشتیبانی کامل | پشتیبانی کامل | پشتیبانی (نیازمند COOP/COEP صحیح؛ حساس به محدودیت‌های هدر) |
| **AudioWorklet** | پشتیبانی کامل | پشتیبانی کامل | پشتیبانی (در iOS/Safari نیازمند تعامل کاربر برای resume `AudioContext`) |
| **OPFS + `createSyncAccessHandle` (در Worker)** | پشتیبانی کامل (همگام در Worker) | پشتیبانی کامل | پشتیبانی در Workerهای اختصاصی (با محدودیت‌های انقضای سهمیه در حالت عادی بدون `persist()`) |
| **WebAssembly + WASM SIMD** | پشتیبانی کامل | پشتیبانی کامل | پشتیبانی کامل در نسخه‌های مدرن (نیازمند کنترل دقیق اندازه حافظه خطی) |
| **WebGPU** | پشتیبانی روی سیستم‌های واجد شرایط | پشتیبانی آزمایشی/متغیر بسته به پلتفرم (نیازمند fallback به WASM) | پشتیبانی متغیر/نسخه‌محور (نیازمند fallback قطعی به WASM) |
| **Service Worker + Cache Storage** | پشتیبانی کامل | پشتیبانی کامل | پشتیبانی کامل (با سیاست سخت‌گیرانه‌تر حذف کش در نبود تعامل طولانی) |
| **Web Locks API (`navigator.locks`)** | پشتیبانی کامل | پشتیبانی کامل | پشتیبانی (مکانیزم محافظت‌شده در `CrashRecoveryAndSessionLock.ts:74`) |
| **Telemetry دقیق حافظه کل تب (`measureUserAgentSpecificMemory`)** | نیاز به Cross-Origin Isolation؛ نامنظم/آسنکرون؛ `performance.memory` غیراستاندارد و فقط Heap JS | فاقد `performance.memory` | فاقد `performance.memory` و `measureUserAgentSpecificMemory` |
