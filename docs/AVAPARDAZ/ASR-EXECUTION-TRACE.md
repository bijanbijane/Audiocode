# ردیابی مسیر واقعی اجرای ASR (Phase 0 — ASR Execution Trace)

در مخزن کنونی **سه پشته (Stack) مجزای ASR** وجود دارد که تنها یکی از آن‌ها در رابط کاربری اصلی فعال است. این سند مسیر دقیق اجرای هر سه را مستندسازی می‌کند.

---

## ۱. پشته A — مسیر واقعی فعال در استودیو (`src/App.tsx`)

وقتی کاربر در محیط فعلی دکمه تحلیل ASR را در `App.tsx` می‌زند، مسیر واقعی زیر اجرا می‌شود:

```text
App.tsx:handleRunPersianAsr (lines 582-660)
 ├─ ۱. دریافت تمام Float32Array صوت از project.pcmSources[track.assetId] (در RAM)
 ├─ ۲. اجرای resampleTo16kMono() -> ساخت کپی 16kHz در RAM
 ├─ ۳. رمزگذاری کل صوت 16kHz به WAV و سپس Base64 (encodeWavPcm16Mono)
 ├─ ۴. ارسال HTTP POST به /api/v1/asr/transcribe
 │      └─ server.ts:133-201 -> GoogleGenAI('gemini-3.5-transcribe')
 │         └─ [در نبود GEMINI_API_KEY]: برگرداندن HTTP 503 CLOUD_ASR_UNAVAILABLE
 └─ ۵. سقوط به Fallback آفلاین در App.tsx:
        └─ buildOfflineAcousticSegmentedTranscript() (src/engine/persianAsrTranscriber.ts:525-565)
             ├─ تقسیم بازه انرژی صدا به قطعه‌های فرضی
             ├─ تولید کلمات ساختگی ثابت: ['اممم', 'پادکستِ', 'فارسی', 'بخشِ_${i+1}']
             └─ فراخوانی alignPersianScriptToAudio() (src/engine/persianAsrTranscriber.ts:440+)
                  └─ توزیع تناسبی زمان کلمات بر اساس تعداد کاراکتر روی burstهای انرژی (بدون مدل عصبی!)
```

**حکم ممیزی پشته A:**
- در نبود اینترنت/کلید ابری، خروجی ASR فعلی در UI **یک شبیه‌ساز کلمات placeholder بر پایه انرژی (RMS Energy Burst)** است و هیچ بازشناسی گفتار فارسی واقعی انجام نمی‌شود.
- تابع `alignPersianScriptToAudio()` برای هم‌ترازی متن مرجعِ داده‌شده توسط کاربر روی صدا طراحی شده، نه کشف کلمات از صدا (ASR).

---

## ۲. پشته B — معماری ONNX مرورگر (ساختار موجود، غیرمتصل و فاقد موتور/وزن)

فایل‌های زیر یک خط لوله کامل ONNX در مرورگر را تعریف کرده‌اند:
- `src/ai-engine/OnnxPersianAsrAndVadAdapter.ts` — محاسبه واقعی Log-Mel Spectrogram ۸۰ باند با Radix-2 FFT + دیکدر Greedy CTC + قرارداد `inferenceRunner`
- `src/ai-engine/PersianChunkedAsrWorker.ts` — پنجره‌بندی ۲۵ ثانیه‌ای (`CHUNK_WINDOW_SECONDS = 25`) با ۳ ثانیه هم‌پوشانی (`OVERLAP_SECONDS = 3`) و Merge متن در مرز هم‌پوشانی
- `src/ai-engine/asr/UnifiedOnnxPersianAsrEngine.ts` — یکپارچه‌سازی VAD (Silero) + ASR (FastConformer-CTC / Whisper Seq2Seq) + Diarization (ECAPA-TDNN) + Aligner
- `src/ai-engine/workers/asr-inference.worker.ts` — صف ترتیبی اجرای پایپ‌لاین در Web Worker (`SequentialPersianAiPipelineRunner`)
- `src/ai-engine/asr/WebWorkerOrtRuntimeProvider.ts` — آداپتور `onnxruntime-web`

**سه مانع بحرانی که مانع اجرای واقعی پشته B می‌شوند:**
1. **عدم نصب پکیج اجرا:** `WebWorkerOrtRuntimeProvider.ts:127` دستور `import('onnxruntime-web')` را دارد، اما `onnxruntime-web` در `package.json` وجود ندارد.
2. **نبود فایل‌های WASM و وزن مدل‌ها:** مسیر پیش‌فرض `/ort/` در `/public/` وجود ندارد و هیچ فایل وزن `.onnx` (مثل Silero VAD، FastConformer یا Whisper quantized) در پروژه نیست (`CoreAcousticCtcEngine.ts:287` در `probeRuntimeBackendAvailability()` نیز همین نبود وزن‌ها را گزارش می‌کند).
3. **اتصال‌نداشتن به UI و Worker واقعی:** `App.tsx` هیچ‌یک از کلاس‌های `UnifiedOnnxPersianAsrEngine` یا `asr-inference.worker.ts` را وارد یا اجرا نمی‌کند؛ این ماژول‌ها صرفاً در تست‌های واحد با `OrtRuntimeProvider` ساختگی (Mock) آزمایش شده‌اند.

---

## ۳. پشته C — هسته Node.js و آزمایشگاه تحقیق (`src/asr-core/` و `AsrExperimentationLabCore`)

- `src/asr-core/CoreAcousticCtcEngine.ts`: قابل اجرا فقط در Node.js (`import fs from 'node:fs'`, `import crypto from 'node:crypto'`)؛ از DFT ۱۶‌باندی و سیگنال سنتز شده (`synthesizeAcousticSpeechFromText`) برای پیش‌ساخت/آزمون مسیرهای `/api/v1/asr-core/*` در `server.ts` استفاده می‌کند. قابل انتقال مستقیم به مرورگر بدون بازطراحی نیست.
- `src/ai-engine/asr/AsrExperimentationLabCore.ts`: رجیستری آزمایشگاه پژوهش برای مقایسه موتورها که روی سرور با کلید API یا وضعیت `MISSING_API_KEY` / `WORKER_OFFLINE` کار می‌کند.

---

## ۴. جمع‌بندی اجرایی برای فاز ۲

**ASR محلی عملیاتی در مرورگر هنوز اثبات نشده است.** در فاز ۲ باید:
1. پکیج `onnxruntime-web` و باینری‌های WASM محلی در پروژه مستقر شوند.
2. مدل‌های محلی واقعی (حداقل Silero VAD + مدل کوچک/متوسط FastConformer-CTC یا Whisper کوچک کوانتیزه‌شده برای فارسی، یا بارگذاری مدل تاییدشده کاربر در OPFS با بررسی SHA-256) از طریق `Web Worker` به `App.tsx` متصل شوند.
3. تولید کلمات جعلی (`buildOfflineAcousticSegmentedTranscript`) از مسیر محصول حذف شده و در نبود مدل بارگذاری‌شده، وضعیت صادقانه (`MODEL_NOT_LOADED`) نمایش داده شود.
