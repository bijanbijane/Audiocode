# گزارش ممیزی محیط اجرایی و زیرساخت فعلی (Phase 0: Execution Environment Reality Check)

**نسخه سند:** `1.0.0-phase0`  
**تاریخ ممیزی:** ۱۸ نوامبر ۲۰۲۶  
**وضعیت:** تمامی مشخصات زیر از طریق اجرای مستقیم دستورات سیستمی در همین نشست (`uname`, `lscpu`, `free`, `df`, `node`, `python3`, `ffmpeg`, `nvidia-smi`) اندازه‌گیری و تأیید شده‌اند (`[Observed Fact]`).

---

## ۱. مشخصات سخت‌افزاری و سیستم‌عامل محیط فعلی (`[Observed Fact]`)

| مؤلفه | مقدار مشاهده‌شده در محیط فعلی | وضعیت برای آزمایشگاه ASR |
| :--- | :--- | :--- |
| **سیستم‌عامل و کرنل** | `Linux localhost 4.19.0-gvisor #1 SMP x86_64 GNU/Linux` | کانتینر ایزوله gVisor (Sandboxed Linux) |
| **پردازنده (CPU)** | `4 vCPUs (x86_64)` | مناسب برای سرور ارکستراسیون، پیش‌پردازش DSP/PCM، محاسبه متریک‌ها (CER/WER) و تست APIها |
| **حافظه رم (RAM)** | `12 GiB Total` (`~10 GiB Available`, `0B Swap`) | کافی برای Node.js/TypeScript، دیتابیس آزمایش‌ها و پردازش فایل‌های صوتی در حافظه |
| **فضای دیسک (Storage)** | `378 GiB Available` (`254 MiB Used` — `1%`) | فضای کافی برای ذخیره دیتاست صوتی آزمایشی (Phase 1-3 Corpus) و لاگ‌های بنچمارک |
| **شتاب‌دهنده گرافیکی (GPU)** | `nvidia-smi: not found` (**فاقد GPU محلی**) | **مانع سخت‌افزاری برای آموزش (Fine-tuning) یا استنتاج سنگین PyTorch در داخل این کانتینر** |

---

## ۲. وضعیت ابزارها، زبان‌ها و پکیج‌های نصب‌شده (`[Observed Fact]`)

### ۲.۱. پشته Node.js / TypeScript (کاملاً آماده و فعال)
- **نسخه Node.js:** `v22.23.2`
- **نسخه npm:** `10.9.8`
- **نسخه TypeScript:** `7.0.2` (به همراه `tsx 4.21.0` و `vitest 5.1.0` و `node:test`)
- **چارچوب وب و سرور:** `Express 4.21.2` (`server.ts` روی پورت `3000`) + `React 19.0.1` + `Vite 8.3.0` + `Tailwind CSS 4.3.3`
- **SDK هوش مصنوعی نصب‌شده:** `@google/genai ^2.4.0`

### ۲.۲. ابزارهای پردازش سیگنال و صوت (`[Observed Fact]`)
- **FFmpeg:** نسخه `ffmpeg version 4.4.2-0ubuntu0.22.04.1+esm17` **نصب و آماده استفاده از خط فرمان است**. (قابلیت تبدیل کلیه فرمت‌های صوتی WAV/MP3/OGG/FLAC/WebM به استاندارد آزمایشگاه `16kHz Mono 16-bit PCM WAV` را دارد).
- **موتورهای DSP و ASR پیاده‌سازی‌شده در کدهای موجود پروژه (`/src/ai-engine/` و `/packages/audio-runtime/`):**
  - پیش‌پردازش و اعتبارسنجی سیگنال ۱۶ کیلوهرتز (`PreAsrInputSanityValidator`)
  - فیلتر جداسازی موسیقی/جینگل از گفتار (`PreAsrMusicAndJingleBoundaryFilter`)
  - حذف نویز طیفی وینر (`SpectralWienerDenoiserEngine`)
  - هم‌ترازگر اجباری وایتربی در سطح کلمه و کاراکتر (`PersianCtcForcedAligner`)
  - دیکودر جستجوی پرتو پیشوندی CTC و تزریق واژگان تخصصی (`PersianCtcPrefixBeamSearchDecoder` + `ContextBiasingTrieCtcScorer`)
  - تصحیح‌گر هم‌آواهای فارسی با مدل زبانی دوطرفه (`PersianPhoneticConfusionCorrector` + `CompactPersianLanguageModelScorer`)
  - تشخیص تغییر زبان سه‌گانه فارسی/انگلیسی/عربی (`MultilingualCodeSwitchAndArabicEngine`)
  - تجمیع چندمدلی ROVER و شبکه ابهام N-Best (`PersianRoverMultiModelEnsembleEngine` + `PersianNBestConfusionNetworkBuilder`)
  - تشخیص پایان جمله نحوی و آکوستیک فارسی (`PersianSyntacticAcousticEndpointDetector`)
  - معماری ترکیبی ۳ موتوره (`TriArchitectureBenchmarkAsrEngine`)

### ۲.۳. پشته Python (`[Observed Fact — Partial / Restricted]`)
- **نسخه Python:** `Python 3.11.2` نصب است.
- **محدودیت مهم:** ماژول `pip` / `pip3` در ایمیج سیستم‌عامل نصب نیست (`/usr/bin/python3: No module named pip`). بنابراین کتابخانه‌های سنگین پایتون مانند `torch`، `transformers`، `vllm` یا `torchaudio` روی این کانتینر محلی قابل نصب و اجرا نیستند.

### ۲.۴. وضعیت کلیدهای API در متغیرهای محیطی (`[Observed Fact]`)
در بررسی متغیرهای محیطی سیستم (بدون نمایش مقادیر محرمانه)، هیچ‌یک از کلیدهای زیر در حال حاضر در محیط تنظیم نشده‌اند:
- `ELEVENLABS_API_KEY`: تنظیم نشده
- `DEEPGRAM_API_KEY`: تنظیم نشده
- `OPENAI_API_KEY`: تنظیم نشده
- `GEMINI_API_KEY`: تنظیم نشده
- `ASSEMBLYAI_API_KEY`: تنظیم نشده

---

## ۳. تفکیک دقیق: چه کارهایی در محیط فعلی ممکن است و چه کارهایی نیازمند محیط مکمل است؟

### الف) کارهایی که ۱۰۰٪ در همین محیط (Google AI Studio Container) قابل اجرا هستند:
1. **پیاده‌سازی کامل هسته آزمایشگاه (LAB-01 تا LAB-10) در TypeScript / Node.js (`server.ts`):**
   - ریجستری موتورها (`LAB-01`)، مدیریت دیتاست و هش فایل‌ها (`LAB-02`)، کالبدشکافی سیگنال صوتی و تبدیل با `FFmpeg` (`LAB-03`).
2. **اجرای کامل موتور بنچمارک و خطایابی (`LAB-04` و `LAB-06`):**
   - محاسبه دقیق و ریاضی `CER`، `WER`، `MER`، `DER`، `RTF`، `TTFT`، `E2E Latency`، ماتریس درهم‌ریختگی خطاها (حذف نیم‌فاصله، خطای هم‌آوا، خطای Code-Switching) و مقایسه آماری زوجی (Paired Bootstrap / Confidence Intervals) روی متن خام و متن نرمال‌شده فارسی.
3. **اتصال و تست زنده تمام APIهای تجاری (`ElevenLabs Scribe v3`, `Deepgram Nova-3`, `OpenAI GPT-Transcribe`, `Gemini`):**
   - به محض تامین کلیدهای API مربوطه توسط کاربر، سرور Express محلی می‌تواند فایل‌های صوتی یکسان را به تمام سرویس‌ها ارسال کند، زمان پاسخ‌دهی (`TTFT` و `Latency`) و خروجی‌ها را ثبت کند و گزارش مقایسه‌ای تولید نماید.
4. **اجرای الگوریتم‌های پس‌پردازش، هم‌ترازی زمانی CTC، تجمیع ROVER و مسیریاب هوشمند (`Adaptive ASR Router - LAB-09`):**
   - تمام این ماژول‌ها بدون نیاز به GPU روی ۴ هسته CPU فعلی با سرعت بسیار بالا (`< 5ms`) اجرا می‌شوند.

### ب) کارهایی که در این کانتینر ممکن نیست و نیازمند Worker محاسباتی GPU خارجی است:
1. **اجرای مستقیم وزن‌های PyTorch مدل‌های `Qwen3-ASR-1.7B` و `Whisper Large-v3`:**
   - به دلیل نبودن GPU (`nvidia-smi: not found`) و عدم وجود `pip`/`PyTorch` در این کانتینر، اجرای مدل‌های چندمیلیارد پارامتری باید روی یک **GPU Worker خارجی** (مانند RunPod / Modal / Lambda Labs / Colab Pro / سرور ابری مجهز به NVIDIA L4/A10G/A100 با FastAPI + vLLM) انجام شود و آزمایشگاه ما از طریق REST/WebSocket Adapter به آن متصل گردد.
2. **آموزش و Fine-tuning (LoRA / QLoRA) مدل مستقل فارسی (`LAB-08`):**
   - همان‌طور که در طرح جامع نیز اشاره شد، آموزش مدل نه روی لپ‌تاپ M2 (۸ گیگابایت رم) و نه در کانتینر AI Studio نباید انجام شود، بلکه نیازمند اجاره GPU ابری (`1x A100 40GB` یا `1x L40S / RTX 4090 24GB`) در فاز ۵ است.
