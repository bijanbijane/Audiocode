# ردیابی اجرای واقعی صوت در محصول (AVP-P00-001 — Audio Execution Trace)

**مأموریت:** `AVP-P00-001`  
**مبنا:** ردیابی خط‌به‌خط از رویداد واقعی انتخاب فایل (`<input type="file">`) در `src/App.tsx` تا نمایش متن و خروجی WAV.

---

## ۱. نمودار زنجیره واقعی کنونی (`[OBSERVED]`)

```text
User File Selection (<input type="file"> @ App.tsx:1809-1814 -> handleFileUpload @ App.tsx:1500)
    │
    ▼ [Asynchronous, Main Thread]
File Validation (AudioSecurityGuard.verifyMagicBytes @ audioFixtures.ts:441 -> AudioSecurityGuard.ts:14)
    │
    ▼ [Asynchronous, Main Thread - FULL FILE IN RAM!]
Metadata & Full Audio Decoding (await file.arrayBuffer() -> AudioContext.decodeAudioData @ audioFixtures.ts:447-458)
    │
    ▼ [Synchronous, Main Thread - FULL COPY IN RAM!]
Mono Mixdown + Security Duration Check (new Float32Array(totalSamples) @ audioFixtures.ts:462; assertSafeDecodedDuration @ :459)
    │
    ▼ [Synchronous, Main Thread]
Acoustic Profile + Peak Pyramid + Offline Burst Segmentation (extractAcousticProfile, buildPeakPyramid, buildOfflineAcousticSegmentedTranscript @ audioFixtures.ts:472-492)
    │
    ▼ [React State Storage — NO OPFS AUDIO STORAGE!]
Local Audio Storage = React State `project.pcmSources[assetId]` (@ App.tsx:1509 -> FULL Float32Array HELD IN RAM!)
(StorageBrokerClient exists @ App.tsx:208 but NEVER stores uploaded PCM blocks!)
    │
    ▼ [User triggers ASR -> handleRunPersianAsr @ App.tsx:581]
Resampling + Full WAV Encoding (resampleTo16kMono @ :594 -> encodeMono16kWavBase64 @ :595)
    │
    ▼ [HTTP POST over network to local Express server]
ASR Job Creation = fetch('/api/v1/asr/transcribe') @ App.tsx:601 -> server.ts:133
    │
    ├──[If GEMINI_API_KEY present]──► GoogleGenAI('gemini-3.5-transcribe') @ server.ts:168 (CLOUD!)
    │
    └──[If 503 / Offline / No Key]──► buildOfflineAcousticSegmentedTranscript() @ App.tsx:628
                                      (Synthesizes fake placeholder words: 'اممم', 'پادکستِ', 'فارسی', 'بخشِ_i'!)
    │
    ▼ [ASR Model Loading in Browser = SKIPPED / MISSING!]
    (UnifiedOnnxPersianAsrEngine & asr-inference.worker.ts NEVER called; onnxruntime-web NOT installed)
    │
    ▼ [Synchronous, Main Thread]
Word Alignment = alignPersianScriptToAudio() @ App.tsx:635 (src/engine/persianAsrTranscriber.ts:440+)
                 Distributes characters proportionally across RMS energy bursts — NOT neural alignment!
    │
    ▼ [React State Update]
Transcript Presentation = setTokens(mergedTokens) + setRecommendations(mergedRecs) @ App.tsx:652-653 -> TranscriptPanel
```

---

## ۲. جدول دقیق جزئیات هر گام انتقال (`[OBSERVED]`)

| مرحله | تابع و محل دقیق | دریافت‌کننده / نوع داده | کپی یا انتقال (Copy/Transfer) | همگام/ناهمگام و ترد | بافر کامل در RAM؟ | خروجی و رفتار شکست |
| --- | --- | --- | --- | --- | :---: | --- |
| **۱. انتخاب فایل** | `handleFileUpload` (`src/App.tsx:1500`) | `File` از `e.target.files[0]` | مرجع فایل (`File` Handle) | همگام / **Main Thread** | خیر | اگر فایل خالی باشد بازگشت بی‌صدا |
| **۲. اعتبارسنجی فایل** | `AudioSecurityGuard.verifyMagicBytes` (`src/audioFixtures.ts:441`) | ۶۴ بایت اول به `Uint8Array` | کپی ۶۴ بایتی (`file.slice(0, 64).arrayBuffer()`) | ناهمگام / **Main Thread** | خیر | پرتاب `SECURITY_*` ← نمایش در `statusNotice` (`App.tsx:1522`) |
| **۳. خواندن کل باینری و متادیتا** | `await file.arrayBuffer()` (`src/engine/audioFixtures.ts:447`) | کل فایل در `ArrayBuffer` | کپی کامل فایل فشرده در RAM | ناهمگام / **Main Thread** | **بله** | ریسک کرش OOM روی فایل حجیم |
| **۴. دیکد صوت و مونو** | `ctx.decodeAudioData(arrayBuffer)` + حلقه مونو (`audioFixtures.ts:456-469`) | `AudioBuffer` ← `mono: Float32Array` | **کپی کامل تمام کانال‌ها + تخصیص Float32Array کامل** | ناهمگام + حلقه همگام / **Main Thread** | **بله (چندبرابری!)** | `catch` در `App.tsx:1525` پیام خطای عمومی نشان می‌دهد |
| **۵. تحلیل اولیه و هرم موج** | `extractAcousticProfile`, `buildPeakPyramid`, `buildPeak` (`audioFixtures.ts:472-492`) | `mono: Float32Array` ← `PeakPyramid` + `tokens` | خواندن مستقیم View + تخصیص آرایه‌های Peak | همگام / **Main Thread** | بله (ورودی کامل) | UI در حین پردازش قفل می‌شود |
| **۶. ذخیره‌سازی محلی** | `setProject(loaded)` (`App.tsx:1509`) | `project.pcmSources[assetId]` | ذخیره مستقیم مرجع `Float32Array` کامل در React State | همگام / **Main Thread** | **بله** | **OPFS در این مسیر اصلاً صدا زده نمی‌شود!** (`StorageBrokerClient` بلااستفاده است) |
| **۷. Resampling (پیش از ASR)** | `resampleTo16kMono([pcm], sr, 16000)` (`App.tsx:594`) | کل `pcm` ← `samples: Float32Array` 16kHz | **کپی کامل + تخصیص آرایه خروجی 16kHz** | همگام / **Main Thread** | **بله** | فریز Main Thread روی فایل طولانی |
| **۸. ایجاد کار ASR و ارسال شبکه** | `encodeMono16kWavBase64` + `fetch('/api/v1/asr/transcribe')` (`App.tsx:595-608`) | WAV `ArrayBuffer` ← رشته `Base64` ← HTTP JSON | **کپی کامل در Base64 String** (۳۳٪ بزرگ‌تر!) | ناهمگام / Main + Server | **بله** | اگر سرور 503 بدهد یا آفلاین باشد، `catch`/fallback اجرا می‌شود |
| **۹. بارگذاری مدل محلی** | **مفقود (`MISSING`)** | وجود ندارد در مسیر فعال | N/A | N/A | N/A | هیچ مدل `.onnx` یا `onnxruntime-web` در مسیر کاربر اجرا نمی‌شود |
| **۱۰. استنتاج (Inference)** | مسیر سرور (`server.ts:168` Gemini) یا Placeholder (`buildOfflineAcousticSegmentedTranscript` در `App.tsx:628`) | WAV Base64 (سرور) یا `pcm` کامل (کلاینت) | کپی و ارسال شبکه یا محاسبه همگام FFT/Autocorrelation | ناهمگام (سرور) یا همگام (**Main Thread**) | بله | با نبود `GEMINI_API_KEY` متن جعلی تولید می‌کند؛ عدم وجود متن مرجع را به کاربر اطلاع نمی‌دهد! |
| **۱۱. تجمیع و هم‌ترازی کلمات** | `alignPersianScriptToAudio` (`App.tsx:635`) | `rawTranscriptText` + `pcm` کامل ← `PersianWordToken[]` | محاسبه طول کاراکترها روی انرژی صدا | همگام / **Main Thread** | بله | در حالت آفلاین کلمات جعلی را به موج واقعی می‌چسباند |
| **۱۲. رندر و خروجی WAV** | `handleOpenExport` (`App.tsx:1563`) → `streamingChunkedRender` (`audioPlayback.ts:132`) → `encodeAndValidateWavExport` (`storageBroker.ts:282`) | `pcmSources` ← `out: Float32Array` ← `ArrayBuffer` کامل WAV ← `Blob` | **۳ کپی کامل در RAM** (ورودی + خروجی رندر + بافر WAV) | `setTimeout` روی **Main Thread** | **بله** | فریز UI و عبور آسان از ۱ GiB |

---

## ۳. انتقال‌های شبیه‌سازی‌شده یا گمشده (`Missing / Simulated Transitions`)
1. **Local Audio Storage via OPFS (`audioFixtures.ts` / `App.tsx`):** انتقال بلوک‌ها از Decode به `ioBroker.worker.ts` انجام نمی‌شود؛ صوت مستقیماً در State جاوااسکریپت (`pcmSources`) نگه‌داری می‌شود `[OBSERVED]`.
2. **ASR Worker Dispatch & Model Load (`App.tsx` ↔ `asr-inference.worker.ts`):** هیچ Worker برای ASR از UI اسپان نمی‌شود `[OBSERVED]`.
3. **Chunked Resampling & Streaming Export:** `ParallelChunkRenderCoordinator` و `StreamingExportEncoder` نوشته شده‌اند اما `App.tsx` از توابع قدیمی تک‌تردی `streamingChunkedRender` و `encodeAndValidateWavExport` استفاده می‌کند `[OBSERVED]`.
