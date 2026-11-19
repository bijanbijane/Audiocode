# وضعیت فعلی مخزن آواپرداز (AVP-P00-001 — Current State)

**شناسه مأموریت:** `AVP-P00-001`  
**تاریخ ممیزی:** ۱۸ نوامبر ۲۰۲۶  
**مبنای بررسی:** کد واقعی مخزن (`bijanbijane/Audiocode`) در محیط Node.js v22.23.2 / Vite 8 / Express 4

---

## ۱. وضعیت واقعی محصول (`[OBSERVED]`)

آواپرداز در وضعیت فعلی یک سامانه مهندسی چندلایه با زیرساخت‌های قابل‌توجه (۲۹۲ فایل در `src/`، ۶۳ فایل در `backend/`، ۳۸ فایل در `packages/`، ۵ فایل Rust در `wasm-audio-core/`) است، اما **چهار شکاف بنیادین** میان هدف محصول (استودیوی کاملاً محلی تدوین گفتار فارسی با سقف حافظه ۱ GiB) و پیاده‌سازی اجرایی کنونی وجود دارد:

1. **مسیر فعال ASR ابری/شبیه‌سازی‌شده است، نه محلی عصبی.**
2. **کل صوت واردشده به‌طور کامل در RAM (`React State`)، رندر کامل (`streamingChunkedRender`) و بافر WAV کامل (`encodeAndValidateWavExport`) نگه داشته می‌شود.**
3. **پوسته اصلی (`src/App.tsx`) ۶ مودال آزمایشگاهی و سازمانی نامرتبط با تدوین صوت را روی نوار ابزار اصلی نمایش می‌دهد و هم‌زمان یک پوسته تکراری (`DesktopAudioStudioApp.tsx` در `?shell=v12`) وجود دارد.**
4. **مستندات ریشه (`EXECUTION-ROADMAP.md`, `RISKS-AND-BLOCKERS.md`, `ARCHITECTURE/ASR-LAB-ARCHITECTURE.md`) بر یک آزمایشگاه چندموتوره تجاری/ابری متمرکزند و `README.md` در ریشه وجود ندارد.**

---

## ۲. معماری راستی‌آزمایی‌شده فعلی (`[OBSERVED]`)

- **ورودی اصلی کلاینت:** `index.html` → `src/main.tsx` → `StudioRootBootstrapper.tsx` → `src/App.tsx` (جزئیات در `RUNTIME-DEPENDENCY-MAP.md`).
- **سرور توسعه (`npm run dev`):** `tsx server.ts` روی `0.0.0.0:3000` همراه با `Vite` dev middleware و مسیرهای API فازهای ۱ تا ۱۴ و `/api/v1/asr/transcribe` (متصل به `@google/genai`).
- **باندل تولیدی (`vite build`):** ۱۷۴۹ ماژول، اما **فقط یک Web Worker (`ioBroker.worker`)** در خروجی `dist/` باندل می‌شود؛ Workerهای ASR و Export هنوز به UI متصل نیستند.

---

## ۳. قابلیت‌های موجود و عملیاتی در برابر قابلیت‌های ناقص

| قابلیت | وضعیت واقعی | طبقه‌بندی | شاهد |
| --- | --- | :---: | --- |
| **موتور تدوین غیرمخرب، Undo/Redo و هم‌گام‌سازی متن/موج** | پیاده‌سازی‌شده و فعال در `App.tsx` | `[OBSERVED]` `[TESTED]` | `src/engine/timeline.ts`, `App.tsx:480-545` |
| **موتور DSP و مرزبندی آوایی فارسی (Min-RMS, Zero-Crossing, Crossfade 5–15ms, Pitch Plateau)** | پیاده‌سازی‌شده و تست‌شده روی Main Thread | `[OBSERVED]` `[TESTED]` | `src/engine/dsp.ts`, `dsp.test.ts` |
| **فیلتر Windowed-Sinc 16kHz و هرم Peak (LOD 64..4096)** | پیاده‌سازی‌شده، ولی روی بافر کامل فراخوانی می‌شود | `[OBSERVED]` `[TESTED]` | `src/engine/resampler.ts`, `src/engine/peakPyramid.ts` |
| **گراف پردازش DAG با جبران تاخیر (PDC) و Pre-Roll** | پیاده‌سازی‌شده برای Manifest و تست؛ در پخش `StudioAudioTransport` فقط بخشی اجرا می‌شود | `[OBSERVED]` `[TESTED]` | `src/engine/processingGraph.ts`, `processingGraph.test.ts` |
| **ASR محلی مرورگر (ONNX / Silero VAD / Conformer-Whisper)** | **ناقص / غیرمتصل:** `onnxruntime-web` نصب نیست، `/public/ort/` و فایل `.onnx` موجود نیست، UI به `buildOfflineAcousticSegmentedTranscript` با کلمات ساختگی سقوط می‌کند | `[OBSERVED]` | `WebWorkerOrtRuntimeProvider.ts:127`, `persianAsrTranscriber.ts:525`, `App.tsx:601-633` |
| **مدیریت حافظه ≤ ۱ GiB و پخش/رندر/خروجی OPFS** | **ناقص / غیرمتصل در UI:** `ingestUploadedAudioFile` کل فایل را در RAM دیکد می‌کند، `StorageBrokerClient` در `App.tsx` صوت آپلودی را ذخیره نمی‌کند، `MemoryBudgetManager` وجود ندارد | `[OBSERVED]` | `audioFixtures.ts:447-469`, `audioPlayback.ts:132`, `storageBroker.ts:282` |
| **آفلاین ۱۰۰٪ واقعی و حذف ابر** | **نقض‌شده:** `@google/genai` در `server.ts:5`، درخواست شبکه در `App.tsx:601`، و فونت CDN در `index.html:20-22` | `[OBSERVED]` | `server.ts:133-201`, `index.html:20-22` |
| **هسته Rust/WASM (`wasm-audio-core`)** | سورس Rust موجود است اما هیچ فایل `.wasm` کامپایل‌شده در ریپو وجود ندارد | `[OBSERVED]` | `wasm-audio-core/src/*.rs` (`0` فایل `.wasm`) |

---

## ۴. موانع بحرانی (`Critical Blockers`)

1. **[P0] نشت احتمالی داده و نقض Local-Only:** ارسال WAV Base64 به `/api/v1/asr/transcribe` و `@google/genai`.
2. **[P0] نبود استنتاج عصبی واقعی در مرورگر:** وابستگی به مدل‌های ساختگی در حالت آفلاین و نبود `onnxruntime-web` + وزن `.onnx`.
3. **[P0] تخصیص کامل فایل در RAM:** عبور حتمی از سقف ۱ GiB برای فایل‌های ≥ ۶۰ دقیقه استریو ۴۸kHz (`~1,318 MiB` فقط برای یک بافر خام Float32).
4. **[P1] شکست `npm run start` (`node server.ts`):** خطای نحو TS22 در `AsrExperimentationLabCore.ts:830` هنگام اجرا بدون `tsx`.
5. **[P1] ناهماهنگی COOP/COEP و فونت CDN:** `credentialless` در سرور در برابر `require-corp` در `public/sw.js` به‌همراه لینک `fonts.googleapis.com` در `index.html`.

---

## ۵. موارد نامعلوم (`Unknowns`)

- نرخ خطای واقعی (`CER/WER`)، حافظه پیک ONNX، و `RTF` واقعی مدل فارسی در مرورگر روی سخت‌افزار کاربر **تا زمان تأمین وزن واقعی `.onnx` و `onnxruntime-web` در فاز ۲ `UNKNOWN` است.**
- مصرف حافظه واقعی پروسس مرورگر (`Chromium Process Memory`) تحت تست فایل ۲ ساعته پس از پیاده‌سازی جریانی فاز ۱ **`UNKNOWN`** است (تا تست واقعی مرورگر در فاز ۶/۷).
- وضعیت قابلیت اجرای واقعی `wasm-audio-core` در محیط فعلی بدون بررسی نصب `cargo` / `wasm-pack` **`UNKNOWN`**.

---

## ۶. خلاصه نتایج تست‌های پایه (`[TESTED]`)

- `npm run lint`: Exit `0` (۰ خطا)
- `npx vitest run`: Exit `0` — **۱۷ فایل / ۷۹ تست پاس‌شده** (`5.14s`)
- `npm run test:unit`: Exit `0` — **۳۸ سوئیت / ۲۶۱ تست پاس‌شده** (`29.11s`)
- `npm run build`: Exit `0` — `vite build` در `1.14s` موفق (۱۷۴۹ ماژول، ۱ Worker باندل‌شده)
