# نقشه تخصیص حافظه و حرکت داده (AVP-P00-001 — Memory & Data Movement Map)

**مأموریت:** `AVP-P00-001`  
**سیاست بودجه هدف (`AVAPARDAZ_MEMORY_POLICY`):**
- `targetBytes = 850 MiB` | `throttleBytes = 900 MiB` | `emergencyBytes = 950 MiB` | `hardLimitBytes = 1,024 MiB` | `audioCacheBytes = 32 MiB`

---

## ۱. جدول کانون‌های تخصیص سنگین و کپی داده (`[OBSERVED]`)

| محل تخصیص (`Allocation Site`) | فایل و تابع | اندازه ورودی / خروجی | کپی یا View؟ | Thread | طول عمر (`Lifetime`) | مکانیزم آزادسازی (`Release`) | پیک حافظه بالقوه |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `file.arrayBuffer()` | `src/engine/audioFixtures.ts:447` (`ingestUploadedAudioFile`) | کل حجم فایل فشرده/WAV | **کپی کامل در RAM** | Main | تا پایان `decodeAudioData` | GC (بعد از خروج از تابع) | حجم کل فایل ورودی (مثلاً ۲۰۰ MB تا ۲ GB) |
| `ctx.decodeAudioData(buf)` | `src/engine/audioFixtures.ts:456` | `AudioBuffer` استریو/چندکاناله کل فایل | **کپی کامل دیکدشده** | Browser Audio Thread / Main | تا پایان میکس مونو | GC | برای ۲ ساعت استریو ۴۸kHz: **`~2.64 GiB`** |
| `new Float32Array(totalSamples)` | `src/engine/audioFixtures.ts:462` → ذخیره در `project.pcmSources` | کل نمونه‌های مونو ۴۸kHz (`4B/sample`) | **کپی در React State** | Main | **دائمی در طول باز بودن پروژه** | فقط با آپلود پروژه جدید | برای ۲ ساعت ۴۸kHz مونو: **`~1.32 GiB`** (کل حد ۱ GiB را به تنهایی پر می‌کند!) |
| `resampleTo16kMono` + `encodeMono16kWavBase64` | `src/App.tsx:594-595` (`handleRunPersianAsr`), `resampler.ts:48,70` | `mono` کامل + `16kHz Float32` + `WAV ArrayBuffer` + `Base64 string` | **۴ کپی متوالی** | Main | حین درخواست ASR | GC | صدها MB اضافه روی فایل طولانی |
| `const out = new Float32Array(totalSamples)` | `src/engine/audioPlayback.ts:132` (`streamingChunkedRender`) | کل مدت خروجی تدوین‌شده | **کپی کامل در RAM** | Main (`setTimeout`) | حین Export تا GC | GC بعد از ساخت WAV | تا **`~1.32 GiB`** روی پروژه ۲ ساعته مونو |
| `new ArrayBuffer(44 + dataSize)` | `src/engine/storageBroker.ts:282` (`encodeAndValidateWavExport`) | کل فایل WAV (`16-bit` = `2B/sample`) | **کپی کامل WAV + Blob** | Main | تا بستن یا جایگزینی `URL.createObjectURL` | `URL.revokeObjectURL` در Export بعدی (`App.tsx:1558`) | برای ۲ ساعت ۴۸kHz مونو: **`~660 MiB`** هم‌زمان با بافر `out` بالا! |
| `audioBuf.copyToChannel(new Float32Array(chunkPcm))` | `src/engine/audioPlayback.ts:318-319` (`StudioAudioTransport`) | پنجره‌های ۴ ثانیه‌ای (`max 6` بلوک پیش‌بارگذاری) | کپی پنجره‌ای | Main | چرخشی حین پخش | حذف از `scheduledSources` پس از پایان | محدود (~۴.۵ MB) |
| `memoryFallbackStore.set(..., buffer.slice(0))` | `src/workers/ioBroker.worker.ts` (در نبود OPFS) | تمام بلوک‌های نوشته‌شده | **کپی بدون سقف** | Worker | دائمی در طول نشست | هیچ LRU ای داخل fallback worker وجود ندارد | **بدون سقف در نبود OPFS!** |
| `new Uint8Array(manifest.totalBytes)` | `WebWorkerOrtRuntimeProvider.ts:150` (`assembleModelBytesFromOpfsChunks`) | کل حجم وزن مدل ONNX | **کپی کل مدل + چانک موقت در حلقه** | AI Worker | تا زمان ساخت `InferenceSession` | GC پس از پاس‌دادن به ORT + `WASM/WebGPU` copy | **۲ برابر اندازه مدل در لحظه ساخت Session** (تا تکمیل `InferenceSession.create`) |
| `structuredClone(tracks)` | `TimelineTransactionEngine.ts` / `timeline.ts` | صرفاً JSON کلیپ‌ها و FlickRange (بدون صوت) | کپی شیء سبک | Main | تاریخچه Undo/Redo | محدود به سقف تاریخچه | ناچیز (< چند MB) — ایمن به شرط نبود PCM در ساختار |
| `postMessage(..., [copy.buffer])` | `storageBroker.ts:173`, `asr-stream-worklet.js:30` | بافر بلوک صوتی | **Transferable Zero-Copy** | Main ↔ Worker / Worklet | لحظه‌ای | مالکیت منتقل می‌شود | محدود به اندازه بلوک |

---

## ۲. محاسبه ریاضی نیاز حافظه Float32 PCM خام (بخش `7.2`)

فرمول: `MemoryBytes = DurationSeconds × 48,000 Hz × 2 Channels × 4 Bytes/Sample` (`= 384,000 Bytes/sec ≈ 0.3662 MiB/sec`)

| مدت زمان صوت | تعداد نمونه‌ها (در هر کانال) | بایت دقیق (Stereo 48kHz Float32) | معادل دقیق (`MiB` / `GiB`) | با معماری Chunked (`25s / 3s` در `16kHz Mono` برای ASR) | مقایسه با سقف `1,024 MiB` |
| :---: | :---: | :---: | :---: | --- | --- |
| **۱ دقیقه (`60s`)** | `2,880,000` | `23,040,000 B` | **`21.97 MiB`** | بافر ۲۵ ثانیه 16kHz مونو = `1.53 MiB` | قابل اجرا بدون جریانی، اما همراه کپی‌های decode حدود `~70–100 MiB` |
| **۱۰ دقیقه (`600s`)** | `28,800,000` | `230,400,000 B` | **`219.73 MiB`** | همان **`1.53 MiB`** ثابت در هر پنجره | همراه با Decode + Mono + Export کامل به حدود `~550–700 MiB` نزدیک می‌شود |
| **۳۰ دقیقه (`1,800s`)** | `86,400,000` | `691,200,000 B` | **`659.18 MiB`** | همان **`1.53 MiB`** ثابت در هر پنجره | **از آستانه `850 MiB` و `1,024 MiB` عبور می‌کند** به دلیل وجود هم‌زمان `AudioBuffer` + `mono` + بافر رندر |
| **۶۰ دقیقه (`3,600s`)** | `172,800,000` | `1,382,400,000 B` | **`1,318.36 MiB` (`1.29 GiB`)** | همان **`1.53 MiB`** ثابت در هر پنجره | **نقض قطعی سقف `1,024 MiB` حتی پیش از شروع ASR** |
| **۱۲۰ دقیقه (`7,200s`)** | `345,600,000` | `2,764,800,000 B` | **`2,636.72 MiB` (`2.57 GiB`)** | همان **`1.53 MiB`** ثابت در هر پنجره | **سقوط قطعی تب در معماری فعلی `ingestUploadedAudioFile`** |

---

## ۳. تحلیل پنجره‌بندی ۲۵ ثانیه / ۳ ثانیه و تفکیک دسته‌های حافظه مرورگر

### الف) بررسی `PersianChunkedAsrWorker.ts` (`[OBSERVED]`)
- مقادیر فعلی دقیق: `windowDurationSec = 25`, `overlapDurationSec = 3`, `stride = 22s` (`400,000` نمونه ورودی، `352,000` نمونه گام در `16kHz`).
- **آیا مرز چانک کلمات را نصف می‌کند و هم‌پوشانی ایمن ادغام می‌شود؟**
  - کلمه‌ای که دقیقاً روی نقطه برش میانی (`midpointFlicks` در خط `127`) بیفتد ممکن است توسط پنجره قبل یا بعد بریده شود؛ کد فعلی در خطوط `139-156` برای یک جفت کلمه لبه، تکراری با `normalizedText` برابر را حذف می‌کند و واژه با اطمینان بالاتر را نگه می‌دارد، اما اگر به علت تفاوت آوایی در لبه پنجره یک کلمه به دو پاره متفاوت تبدیل شود یا چند کلمه روی مرز تغییر ترتیب دهند، `mergeOverlappingTokens` فقط آخرین کلمه `prev` و اولین `curr` را چک می‌کند (`[INFERRED]` از مطالعه دقیق خطوط `122-160`). بهبود یا سخت‌سازی آن مربوط به فاز ۲/۳ است و در فاز ۰ دست نخورده می‌ماند.

### ب) تفکیک ۹ دسته حافظه و محدودیت تله‌متری مرورگر (`Section 7.1`)
1. **JS Heap** (اشیاء React, DOM, توکن‌ها) ↔ فقط بخش `usedJSHeapSize` در Chromium (`performance.memory`, غیراستاندارد) دیده می‌شود.
2. **ArrayBuffer Memory** (خارج از Heap اصلی V8 در بسیاری از موتورها ولی جزئی از Process RAM).
3. **WASM Linear Memory** (`WebAssembly.Memory.buffer` که می‌تواند تا سقف تعریف‌شده رشد کند اما معمولاً به‌سرعت به سیستم‌عامل برگردانده نمی‌شود!).
4. **Model Weights** (بافر `.onnx` در RAM + کپی داخلی ORT/WASM/GPU هنگام ساخت Session).
5. **Audio Decode Buffers** (`AudioBuffer` داخلی مرورگر که ممکن است خارج از دید JS Heap باشد).
6. **Worker Memory** (هر Dedicated Worker یک Isolate و Heap مجزا دارد که `performance.memory` پنجره اصلی آن را نمی‌بیند!).
7. **Browser-Managed Media Memory** و **GPU Allocations** (در WebGPU VRAM/Shared Memory و غیرقابل رویت دقیق برای JS).
8. **Persistent Storage (OPFS)** (روی دیسک ذخیره می‌شود؛ معادل RAM نیست مگر هنگام خواندن با `arrayBuffer()`).

**محدودیت تله‌متری مرورگر (`[OBSERVED]`):** هیچ مرورگری اجازه خواندن دقیق و همزمان حافظه کل پروسس در لحظه بدون `crossOriginIsolated` + `measureUserAgentSpecificMemory` (که آن هم آسنکرون و در Firefox/Safari ناموجود است) را نمی‌دهد؛ بنابراین **`MemoryBudgetManager` باید یک برآوردگر تجمیعی حسابرسی‌شده (`AllocationRegistry`) باشد که تخصیص‌های خود ما (کش صوتی، وزن مدل‌ها، بافرهای Worker و رندر) را دقیق بشمارد و با `performance.memory` (در Chromium) ترکیب و کالیبره شود، و در فاز ۷ با ابزار بیرونی پروسس مرورگر راستی‌آزمایی گردد.**
