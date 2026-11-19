# پایه آزمون‌ها و تکرارپذیری (AVP-P00-001 — Test Baseline)

**مأموریت:** `AVP-P00-001`  
**اصل ممیزی:** هیچ تستی تغییر داده نشده، هیچ خطایی پنهان نشده و نام تست با واقعیت آن‌چه می‌سنجد مطابقت داده شده است.

---

## ۱. نتایج اجرای مستقیم دستورهای پایه (`[TESTED]`)

| دستور | کد خروج (`Exit Code`) | زمان (`Duration`) | Passed | Failed | Skipped | هشدارها (`Warnings`) | خلاصه شکست (`Failure Summary`) |
| --- | :---: | :---: | :---: | :---: | :---: | --- | --- |
| `npm run lint` (`tsc --noEmit`) | `0` | ~7s | — | 0 | 0 | ندارد | بدون شکست (فقط تایپ‌چک ایستا؛ صحت زمان اجرا را تضمین نمی‌کند) |
| `npx vitest run` | `0` | `5.14s` | **17 files / 79 tests** | 0 | 0 | توصیه Vite/Vitest درباره `isolate: false` | بدون شکست |
| `npm run test:unit` (`tsx --test`) | `0` | `29.11s` | **38 suites / 261 tests** | 0 | 0 | ندارد | بدون شکست (`1..248`, 261 subtests) |
| `npm run build` (`vite build`) | `0` | `1.14s` | 1749 modules | 0 | 0 | هشدار `__dirname` در `vite.config.ts:22` و chunk بزرگ `1,282 kB` | بدون شکست؛ **تنها 1 Worker (`ioBroker.worker`) در `dist/` باندل شده است** |
| `npm run start` (`node server.ts`) | **Non-zero (Fail)** | < 1s | 0 | 1 | — | Node v22 strip-only mode | `[OBSERVED]` پیش از ممیزی: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` به‌علت parameter property در `AsrExperimentationLabCore.ts:830` |

---

## ۲. تحلیل کیفی پوشش تست‌ها (`[OBSERVED]`)

| دسته آزمون | وضعیت در مخزن | مثال‌ها و ارزیابی |
| --- | --- | --- |
| **تست‌های کار با کلید ابری (External Credentials)** | **فاقد تماس واقعی با API ابری در CI** | `AsrExperimentationLabCore` در نبود متغیر محیطی `MISSING_API_KEY` یا `WORKER_OFFLINE` برمی‌گرداند؛ کلیدهای `GEMINI_API_KEY` / `OPENAI_API_KEY` نیاز نیستند |
| **تست‌های متکی بر داده مصنوعی (`Synthetic Data`)** | **اکثریت تست‌ها** | تست‌های DSP، `buildDefaultPersianPodcastProject`، `CoreAcousticCtcEngine` (امواج سینوسی و متن سنتز‌شده) و تست‌های درگاه/تراکنش با بافرهای کوچک چندکیلو/چندثانیه‌ای |
| **تست‌های استنتاج ساختگی (`Mock Inference`)** | **تمامی تست‌های ASR مرورگر** | `UnifiedOnnxPersianAsrEngine.test.ts`، `SileroVadOnnxRunner.test.ts`، `WhisperKvCacheAutoregressiveOptimizer.test.ts` همگی از `OrtRuntimeProvider` ساختگی (با `Float32Array` تصادفی/ثابت) استفاده می‌کنند |
| **تست‌های صرفاً قراردادی (`Interface / Schema Only`)** | `full-pipeline.spec.ts` (بخشی از Gateها)، تست‌های پلتفرم/کارخانه | بررسی شکل ساختار خروجی‌ها و RBAC و State Transition بدون اجرای واقعی ONNX یا AudioWorklet مرورگر |
| **تست‌های خروجی مدل عصبی واقعی (`Real Model Output`)** | **موجود نیست (۰ تست)** | به‌دلیل نبود وزن `.onnx` و نبود `onnxruntime-web` در `package.json` |
| **تست‌های اندازه‌گیری حافظه (`Memory Measurement`)** | **موجود نیست (۰ تست واقعی ران‌تایم)** | تست‌های LRU تنها کاهش شمارنده `usedBytes` منطقی روی بلوک‌های مصنوعی کوچک را چک می‌کنند؛ هیچ تست مرورگر واقعی (Playwright / Chromium Heap / ArrayBuffer) برای سقف ۱ GiB وجود ندارد |
| **تست‌های فایل‌های صوتی طولانی (`Long Audio Stress Tests`)** | **موجود نیست (۰ تست ۱ تا ۲ ساعته)** | هیچ تستی یک فایل ۳۰ دقیقه تا ۲ ساعته استریو ۴۸kHz را از مسیر `ingestUploadedAudioFile` یا `streamingChunkedRender` عبور نداده است |
| **اسکریپت/تست کشف‌نشده یا Rust** | `wasm-audio-core` (`cargo test`) در اسکریپت‌های `npm` گنجانده نشده | نیازمند toolchain رستم برای اجرا |

---

## ۳. جمع‌بندی اعتبارسنجی نام تست‌ها

به‌طور خاص تست‌هایی نظیر `Persian AI Audio Platform - Master Release Quality Gates (v1.2)` (در `full-pipeline.spec.ts`) **نامی فراتر از پوشش واقعی خود دارند**: پاس شدن ۳۲ گیت آن در `vitest` به معنی اثبات استنتاج واقعی ASR فارسی در مرورگر یا ماندن زیر سقف حافظه ۱ گیگابایت روی فایل واقعی نیست، بلکه صحت منطق ایزوله واحدها و Mockها را می‌سنجد (`[OBSERVED]`).
