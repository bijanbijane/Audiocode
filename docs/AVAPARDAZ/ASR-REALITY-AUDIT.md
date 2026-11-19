# ممیزی واقعیت ASR و استنتاج محلی (AVP-P00-001 — ASR Reality Audit)

**مأموریت:** `AVP-P00-001`  
**سؤال اصلی:** آیا سامانه فعلی استنتاج آکوستیک واقعی محلی روی گفتار فارسی انجام می‌دهد؟  
**پاسخ ممیزی:** **خیر — `[OBSERVED]`.** هیچ مدل ASR واقعی `.onnx` یا ران‌تایم `onnxruntime-web` در مخزن وجود ندارد و مسیر فعال استودیو از Gemini ابری یا تولیدگر کلمات ساختگی + هم‌ترازگر انرژی استفاده می‌کند.

---

## ۱. تفکیک دقیق ۷ قابلیت مختلف در مخزن (`[OBSERVED]`)

| قابلیت | وضعیت واقعی در کد | فایل‌های مرتبط و شاهد |
| --- | --- | --- |
| **۱. بازشناسی گفتار واقعی (Genuine Local ASR)** | **پیاده‌سازی عملیاتی نشده** | `WebWorkerOrtRuntimeProvider.ts:127` به `onnxruntime-web` متکی است که در `package.json` نصب نیست؛ صفر فایل `.onnx` و `/public/ort/` موجود نیست |
| **۲. هم‌ترازی آکوستیک (Acoustic Alignment)** | **دو پیاده‌سازی مجزا موجود** | (الف) هم‌ترازگر واقعی CTC Viterbi (`PersianCtcForcedAligner.ts` با تست پاس‌شده) — به UI وصل نیست؛ (ب) هم‌ترازگر اکتشافی انرژی/تناسب کاراکتر (`persianAsrTranscriber.ts:alignPersianScriptToAudio`) — در UI فعال است |
| **۳. نرمال‌سازی متن فارسی (Text Normalization)** | **عملیاتی و تست‌شده** | `persianText.ts` (`normalizePersianText`) و `PersianTextNormalizer.ts` و `CoreNormalizationAndLanguage.ts` (یکسان‌سازی ی/ک، نیم‌فاصله، ارقام) |
| **۴. تصحیح واژگان (Vocabulary Correction)** | **مبتنی بر واژه‌نامه/قاعده** | `applyCustomLexiconAndPhoneticCorrections` (`persianAsrTranscriber.ts`), `PersianPostAsrSpellingAndCompoundRestorer.ts` |
| **۵. تولید صوت مصنوعی (Synthetic Speech Gen)** | **فعال در تست/دمو/Node** | `audioFixtures.ts:95,629` (`buildSyntheticMicRecordingPcm`), `CoreAcousticCtcEngine.ts` (`synthesizeAcousticSpeechFromText` از موج سینوسی و هارمونیک) |
| **۶. استنتاج ساختگی (Mock / Placeholder Inference)** | **فعال در حالت آفلاین UI و تست‌ها** | `persianAsrTranscriber.ts:525` (`buildOfflineAcousticSegmentedTranscript` کلمات `'اممم'`, `'پادکستِ'`, `'فارسی'`, `'بخشِ_N'` می‌سازد)؛ تست‌های Vitest/Unit با `OrtRuntimeProvider` ساختگی |
| **۷. بازپخش بنچمارک (Benchmark Replay)** | **فعال در Backend/Lab** | `IndependentAsrModelDevelopmentEngine.ts` و `AsrExperimentationLabCore.ts` (روی متن‌های مرجع/کورپوس آزمایشی) |

---

## ۲. جدول وضعیت مدل‌ها و آرتیفکت‌های ASR (`AVP-P00-001 Section 5.1`)

| ویژگی مدل | پشته UI فعلی (`App.tsx` + `server.ts`) | پشته ONNX مرورگر (`UnifiedOnnxPersianAsrEngine`) | پشته Node (`CoreAcousticCtcEngine`) |
| --- | --- | --- | --- |
| **Model ID** | `gemini-3.5-transcribe` (ابری) / Offline Acoustic Fallback | `silero-vad-v5-int8`, `persian-fastconformer-ctc-int8`, `whisper-small-fa-int8`, `ecapa-tdnn-int8` | `avapardaz-core-ctc-char-v1` |
| **Model Architecture** | Cloud LLM Audio (در سرور) / Energy Burst Heuristic (در مرورگر) | Silero VAD + Conformer CTC / Whisper Encoder-Decoder | ۱۶-bin DFT Prototype Acoustic Scorer + CTC Greedy/Beam (غیرعصبی) |
| **Model File** | ندارد (سرویس ابری) / ندارد | **`UNKNOWN` — هیچ فایل `.onnx` در مخزن وجود ندارد `[OBSERVED]`** | فایل وزن JSON در دیسک Node (یا درجا از کورپوس) |
| **Model File Size** | N/A | **۰ بایت در مخزن (موجود نیست) `[OBSERVED]`** | چند کیلوبایت |
| **Model Quantization** | N/A | اسمی `int8` در شناسه؛ فایل واقعی ناموجود (`UNKNOWN`) | Float32 / JSON |
| **Input Tensor Shape** | WAV Base64 (`16kHz`) یا `Float32Array` | `[1, frames, 80]` Log-Mel (`OnnxPersianAsrAndVadAdapter.ts:97`), `[1, 512]` VAD | `[frames, 16]` DFT spectrum |
| **Input Sample Rate** | `16,000 Hz` (via `resampleTo16kMono`) | `16,000 Hz` | `16,000 Hz` |
| **Input Feature Dimensions** | N/A | `80` Log-Mel bins (`win=400`, `hop=160`, `nFft=512`) | `16` DFT bands (`400` samples) |
| **Output Tensor Shape** | JSON `{ transcriptText }` | `[1, T, vocabSize]` logits / token IDs (`UNKNOWN` تا بارگذاری مدل واقعی) | `[T, vocabSize]` |
| **Output Vocabulary** | خروجی متنی آزاد | نقشه `idToChar` / `vocabTokens` در زمان تست | الفبای فارسی + لاتین در `CoreAcousticCtcEngine` |
| **Runtime Provider** | `fetch` → `@google/genai` یا Main Thread fallback | `onnxruntime-web` (`WebWorkerOrtRuntimeProvider.ts:127`) — **نصب نیست** | Pure TypeScript در Node.js (`node:fs`) |
| **Execution Location** | Main Thread + سرور Express + ابر Google | طراحی برای Web Worker (`asr-inference.worker.ts`) — **غیرمتصل** | Node.js Server Process فقط |
| **Peak Memory** | وابسته به طول فایل (در `App.tsx` بدون سقف) | **`UNKNOWN`** (بدون مدل واقعی اندازه‌گیری نشده) | `< 50 MiB` (تخمین تست Node) |
| **Inference Latency** | وابسته به شبکه / همگام در fallback | **`UNKNOWN`** (فقط با Mock تست شده) | `< 100ms` در تست کورپوس مصنوعی |
| **Model Status** | **NOT LOCAL / PLACEHOLDER FALLBACK** | **STRUCTURED ONLY — NO WEIGHTS / NO RUNTIME** | **PROTOTYPE BENCHMARK / NODE-ONLY** |

---

## ۳. بررسی دقیق چرخه استنتاج در پشته ONNX (`[OBSERVED]`)

- **بارگذاری مدل (`WebWorkerOrtRuntimeProvider.ts:138-170`):** تابع `assembleModelBytesFromOpfsChunks` به دنبال دایرکتوری `ai-models/{modelId}_{version}/chunk_XXXX.bin` در OPFS می‌گردد؛ اگر نباشد خطا می‌دهد.
- **ساخت نشست (`WebWorkerOrtRuntimeProvider.ts:96-133`):** `loadDynamicOrtWeb()` بسته `onnxruntime-web` را با مسیر WASM `/ort/` بارگذاری می‌کند (`configuredNumThreads = 1..4` بر اساس `crossOriginIsolated`).
- **استخراج ویژگی (`OnnxPersianAsrAndVadAdapter.ts:87-146`):** پیاده‌سازی واقعی و سالم برای Windowed Hann 25ms / hop 10ms / Radix-2 FFT ۵۱۲تایی / ۸۰ باند مل لگاریتمی.
- **دیکدر CTC و Viterbi (`OnnxPersianAsrAndVadAdapter.ts:163`, `PersianCtcForcedAligner.ts:54`):** هر دو پیاده‌سازی سالم با رعایت Blank Token `epsilon=0` بین حروف مکرر دارند `[TESTED]`.
- **آزادسازی مدل (`Disposal`):** در کلاس `ResilientAiRuntimeManager` (`unloadPreviousModelFn`) تعریف شده، اما در `WebWorkerOrtRuntimeProvider` ردیابی مرکزی `InferenceSession.release()` تحت فشار حافظه هنوز پیاده‌سازی نشده است `[OBSERVED]`.

---

## ۴. ارزیابی حفظ گفتار خام کلمه‌به‌کلمه (`Section 5.2 — Verbatim Preservation`)

| ویژگی گفتار | رفتار فعلی در کد | محل تغییر یا حذف پنهان |
| --- | --- | --- |
| کلمات و عبارات تکراری / تپق / مکث / ناتمام | در حالت `Gemini` (`server.ts:181`) در پرامپت خواسته شده حفظ شود؛ اما در حالت آفلاین (`buildOfflineAcousticSegmentedTranscript`) اصلاً کلمه واقعی استخراج نمی‌شود! همچنین در پرامپت هیچ قیدی برای گفتار نامفهوم وجود ندارد | **خطر حذف/تغییر:** `convertTranscriptColloquialToFormal` (`persianAsrTranscriber.ts:605`) و `normalizeNumbersAndCompoundsInTranscript` به‌صراحت `displayText` را تغییر می‌دهند، و `originalText` را حفظ می‌کنند (`[OBSERVED]`) |
| نگهداری مستقل خام و نرمال‌شده | در `PersianTextNormalizer.ts:8-18` (`TimedPersianToken`) و `PersianWordToken` (`contracts/v1_2.ts`) سه لایه `originalText`، `normalizedText` و `displayText` جدا هستند `[OBSERVED]` | **نقص قرارداد در برابر هدف `VerbatimTranscript`:** فیلدهای زمانی در UI فعلی بر حسب `FlickRange` (`startFlicks`, `endFlicks`) است نه `startSample` / `endSample` به‌عنوان فیلد صریح، و فیلد `tokenIds?: number[]` در `PersianWordToken` وجود ندارد `[OBSERVED]` |
| تفکیک گوینده و کدسوئیچ انگلیسی | `EnglishScriptRenderMode` و `Track.speakerLabel` موجودند `[OBSERVED]` | در حالت آفلاین فعلی (`App.tsx`) تشخیص واقعی کدسوئیچ انگلیسی یا تغییر گوینده از مدل عصبی انجام نمی‌شود `[OBSERVED]` |
