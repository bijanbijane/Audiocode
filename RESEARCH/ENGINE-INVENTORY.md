# سیاهه و شناسنامه فنی موتورهای تبدیل گفتار به متن (LAB-01: Engine Inventory)

**نسخه سند:** `1.0.0-phase0`  
**تاریخ ممیزی:** ۱۸ نوامبر ۲۰۲۶  
**وضعیت معرفت‌شناختی:** تفکیک صریح بین `[Observed Fact]`، `[Vendor Claim / Official Docs]`، `[Estimate]` و `[Hypothesis / Requires Testing]`

---

## ۱. موتورهای تجاری (Commercial Cloud ASR Engines)

### ۱.۱. ElevenLabs Scribe v3 (Batch) و Scribe v3 Live (Streaming)
- **شناسه مدل‌ها:**
  - پردازش فایل (Batch): `scribe_v3` (نسخه پیشین دارای بنچمارک عمومی: `scribe_v2` / `scribe_v1`)
  - پردازش زنده (Realtime WebSocket): `scribe_v3_live`
- **اولویت آزمایشگاه:** **اولویت A (موتور مرجع اول برای فارسی و Code-Switching)**
- **پشتیبانی زبان `[Vendor Claim / Official Docs]`:** بیش از ۹۰ زبان شامل فارسی (`fa`)، انگلیسی (`en`) و عربی (`ar`).
- **پشتیبانی از گفتار ترکیبی فارسی-انگلیسی (Code-Switching):**
  - `[Observed Benchmark Reference]`: در گزارش منتشرشده توسط Perle AI روی گفتار ترکیبی فارسی-انگلیسی، مدل `ElevenLabs Scribe v2` به نرخ خطای کلمه **WER = 16.4%** دست یافته که نسبت به Google Chirp 3 (`31.2%`) و GPT-4o Transcribe (`54.3%`) اختلاف معناداری دارد.
  - `[Hypothesis / Requires Testing]`: عملکرد واقعی `scribe_v3` و `scribe_v3_live` روی دیتاست استاندارد آزمایشگاه ما (شامل فارسی محاوره‌ای تهرانی، لهجه‌های استانی و اصطلاحات فنی نرم‌افزار/پزشکی) باید در فاز ۳ مستقلاً با معیارهای `CER` و `WER` نرمال‌شده اندازه‌گیری شود.
- **قابلیت‌های کلیدی `[Vendor Claim / Official Docs]`:**
  - زمان‌بندی در سطح کلمه و کاراکتر (`word` & `character` timestamps)
  - تفکیک گوینده (`Speaker Diarization`)
  - برچسب‌گذاری رخدادهای صوتی غیرکلامی (`tag_audio_events`: خنده، سرفه، نفس، موسیقی، تشویق)
  - تزریق واژگان کلیدی و تخصصی (`Keyterm Prompting`)
- **شیوه دسترسی و محدودیت‌ها:** فقط از طریق Cloud REST / WebSocket API (امکان اجرای محلی یا دسترسی به وزن‌های مدل وجود ندارد). نیازمند `ELEVENLABS_API_KEY`.
- **برآورد هزینه `[Estimate]`:** حدود `$0.22` تا `$0.40` به ازای هر ساعت صوت (بسته به سطح اشتراک Enterprise/Scale و فعال بودن Diarization).

---

### ۱.۲. OpenAI GPT-Transcribe (`gpt-transcribe`) و GPT-Live-Transcribe (`gpt-live-transcribe`)
- **شناسه مدل‌ها:**
  - پردازش فایل (Batch Audio API): `gpt-transcribe` (جایگزین خانواده در حال بازنشستگی `gpt-4o-transcribe` و `whisper-1`)
  - پردازش جریانی زنده (Realtime WebSocket API): `gpt-live-transcribe`
- **اولویت آزمایشگاه:** **اولویت A (موتور دوم، مقایسه معنایی و مسیر جایگزین)**
- **پشتیبانی زبان `[Vendor Claim / Official Docs]`:** چندزبانه شامل فارسی (`fa`)، انگلیسی (`en`) و عربی (`ar`).
- **پشتیبانی از گفتار ترکیبی و واژگان تخصصی:**
  - `[Vendor Claim / Official Docs]`: پشتیبانی بومی از `prompt` (توصیف زمینه معنایی گفتگو) و فهرست کلمات کلیدی (`keyterms`) برای کاهش خطای املایی اسامی خاص و اصطلاحات تخصصی.
  - `[Hypothesis / Requires Testing]`: در نسل قبلی (`gpt-4o-transcribe`) خطای WER روی گفتار ترکیبی فارسی-انگلیسی بالا (`54.3%`) گزارش شده بود و گرایش به بازنویسی معنایی (Paraphrasing) به جای رونویسی کلمه‌به‌کلمه وجود داشت. باید در فاز ۳ بررسی کنیم آیا `gpt-transcribe` با پرامپت سخت‌گیرانه متن اصلی گوینده را بدون حذف تپق‌ها یا تغییر ساختار نحوی حفظ می‌کند یا خیر.
- **قابلیت‌های کلیدی:**
  - درک بافتار معنایی عمیق و اصلاح خودکار علائم نگارشی
  - تشخیص هوشمند پایان نوبت صحبت (Semantic Turn Detection / Endpointing) در نسخه `gpt-live-transcribe`
- **شیوه دسترسی و محدودیت‌ها:** فقط Cloud API (نیازمند `OPENAI_API_KEY`). در ایران نیازمند پروکسی امن سمت سرور به دلیل محدودیت‌های تحریمی آی‌پی.
- **برآورد هزینه `[Estimate]`:** حدود `$0.36` به ازای هر ساعت صوت در حالت Batch و حدود `$0.60+` در حالت Realtime توکن‌محور.

---

### ۱.۳. Deepgram Nova-3 (`nova-3` / `nova-3-general` / Multilingual)
- **شناسه مدل‌ها:**
  - مدل تک‌زبانه/اختصاصی: `nova-3` با پارامتر `language=fa` یا `language=en`
  - مدل چندزبانه (معرفی‌شده در اکتبر ۲۰۲۶): `nova-3` با پشتیبانی از ۵۵ زبان و `Language Hinting`
  - توجه فنی `[Vendor Claim / Official Docs]`: مدل مکالمه‌ای `Deepgram Flux` فعلاً فاقد پشتیبانی رسمی زبان فارسی در لیست زبان‌های چندزبانه خود است؛ بنابراین در آزمایشگاه ما صرفاً `Nova-3` مرجع آزمایش خواهد بود.
- **اولویت آزمایشگاه:** **اولویت A (موتور مرجع برای پردازش زنده کم‌تأخیر و صدای نویزدار/تلفنی)**
- **قابلیت‌های کلیدی `[Vendor Claim / Official Docs]`:**
  - تأخیر بسیار پایین در استریم زنده (`TTFT < 250ms`)
  - مقاومت بالا در برابر نویز محیطی و کانال‌های تلفنی (`8kHz / 16kHz`)
  - قابلیت `Keyterm Prompting` بدون نیاز به بازآموزش مدل
  - `Smart Formatting`، `Diarization` و زمان‌بندی دقیق کلمات
- **فرضیات نیازمند آزمایش `[Hypothesis / Requires Testing]`:**
  - مقایسه دقت مدل تک‌زبانه `language=fa` در برابر حالت چندزبانه `multi` هنگام رخداد Code-Switching فارسی-انگلیسی.
- **شیوه دسترسی و هزینه `[Estimate]`:** Cloud API (و امکان استقرار On-Premise فقط در قراردادهای سازمانی سنگین). هزینه حدود `$0.26` تا `$0.46` به ازای هر ساعت صوت. نیازمند `DEEPGRAM_API_KEY`.

---

### ۱.۴. AssemblyAI Universal-3.5 Pro و Microsoft MAI-Transcribe-2
- **شناسه مدل‌ها:**
  - AssemblyAI: `universal-3.5-pro` (و نسخه کم‌تأخیر `universal-3.5-nano` / Streaming)
  - Microsoft Azure Speech: `mai-transcribe-2` (Batch & Custom Speech)
- **اولویت آزمایشگاه:** **اولویت B (مراجع مقایسه تکمیلی برای جلسات چندنفره و بنچمارک فایل)**
- **کاربرد در آزمایشگاه:**
  - ارزیابی کیفیت `Speaker Diarization` در مکالمات چندنفره با هم‌پوشانی صدا (Overlapping Speech).
  - مقایسه دقت `WordBoosting` و زمان‌بندی کلمات با Scribe v3 و Nova-3.
- **نیازمندی:** نیازمند `ASSEMBLYAI_API_KEY` و `AZURE_SPEECH_KEY`.

---

### ۱.۵. Google Gemini Audio Transcription (`@google/genai`)
- **شناسه مدل:** خانواده Gemini 2.5 / 3.5 Flash & Pro از طریق SDK رسمی `@google/genai`
- **اولویت آزمایشگاه:** **اولویت B (در دسترس در زیرساخت فعلی در صورت تزریق کلید محیطی)**
- **وضعیت در پروژه فعلی `[Observed Fact]`:**
  - پکیج `@google/genai` نسخه `^2.4.0` در `package.json` نصب است و مسیر سرور `/api/v1/asr/transcribe` در `server.ts` پیاده‌سازی شده است.
- **نقاط قوت و ضعف `[Hypothesis / Requires Testing]`:**
  - نقطه قوت: درک عالی لهجه‌های فارسی، اصطلاحات انگلیسی میانه کلام و عبارات عربی.
  - نقطه ضعف: نداشتن زمان‌بندی کلمه‌به‌کلمه آکوستیک بومی (نیازمند لایه `Forced Alignment` یا `CTC Viterbi` محلی پس از دریافت متن) و ریسک اصلاح بیش‌ازحد جملات محاوره‌ای.

---

## ۲. موتورهای متن‌باز و قابل اجرا روی سرور شخصی (Open-Source & Self-Hosted ASR)

### ۲.۱. خانواده Qwen3-ASR (`Qwen3-ASR-1.7B` و `Qwen3-ASR-0.6B`)
- **توسعه‌دهنده:** Alibaba Cloud / تیم Qwen
- **اولویت آزمایشگاه:** **اولویت A (نامزد اصلی برای هسته موتور مستقل فارسی-انگلیسی)**
- **مشخصات فنی `[Vendor Claim / Official Docs]`:**
  - دو نسخه با وزن‌های سبک و متوسط: `0.6B` (مناسب استریم سریع و مصرف حافظه پایین) و `1.7B` (مناسب دقت بالا در فایل و استریم).
  - پشتیبانی از ۵۲ زبان و لهجه شامل فارسی (`fa`)، انگلیسی (`en`) و عربی (`ar`).
  - پشتیبانی بومی از تشخیص زبان خودکار (`LID`)، پردازش آفلاین (Batch) و پردازش جریانی (Streaming).
- **نیاز سخت‌افزاری `[Estimate]`:**
  - نسخه `0.6B` (FP16/INT8): حدود `1.5 GB` تا `2.5 GB` VRAM (قابل اجرا روی GPUهای ارزان و حتی Apple Silicon M2 با کوانتیزاسیون).
  - نسخه `1.7B` (FP16): حدود `4.5 GB` تا `6 GB` VRAM برای استنتاج، و `16 GB` تا `24 GB` VRAM برای Fine-tuning با LoRA/QLoRA.
- **مجوز استفاده:** متن‌باز (بررسی دقیق بندهای مجوز تجاری Apache-2.0 / Qwen License پیش از انتشار تجاری الزامی است).

---

### ۲.۲. خانواده OpenAI Whisper (`whisper-large-v3` و `whisper-large-v3-turbo`)
- **شناسه مدل‌ها:** `openai/whisper-large-v3` (`1.55B` پارامتر، ۳۲ لایه رمزگشا) و `openai/whisper-large-v3-turbo` (`809M` پارامتر، ۴ لایه رمزگشا)
- **اولویت آزمایشگاه:** **اولویت A (خط پایه استاندارد جهانی برای مقایسه)**
- **مشخصات فنی `[Observed Fact]`:**
  - اندازه واژه‌نامه: `51866` توکن (توکن زبان فارسی `<|fa|> = 50300`، توکن `<|transcribe|> = 50360`).
  - پشتیبانی از پرامپت اولیه تا `224` توکن (`<|startofprev|>`) برای هدایت املایی و اصطلاحات تخصصی.
- **نقاط ضعف شناخته‌شده در فارسی `[Observed Fact / Literature]`:**
  - توهم تکرار (Hallucination Loops) در بخش‌های سکوت یا موسیقی در صورت نبودن فیلتر VAD/Music پیش از ASR.
  - خطای نسبتاً بالا در گفتار محاوره‌ای سریع فارسی در مدل پایه بدون Fine-tuning، و عدم تولید مستقیم زمان‌بندی در سطح کاراکتر (نیازمند WhisperX یا CTC Aligner مکمل).
- **مجوز استفاده:** `MIT License` (کاملاً آزاد برای استفاده تجاری و تغییر معماری).

---

### ۲.۳. خانواده NVIDIA NeMo FastConformer (`FastConformer-CTC` / `FastConformer-TDT`)
- **اولویت آزمایشگاه:** **اولویت B (بهترین معماری برای استنتاج فوق‌سریع و هم‌ترازی زمانی CTC)**
- **مشخصات فنی `[Observed Fact / Official Docs]`:**
  - زیرنمونه‌برداری ۸ برابری (`8x Depthwise Separable Conv Subsampling`) که سرعت استنتاج را حدود ۲.۵ تا ۳ برابر نسبت به Conformer استاندارد افزایش می‌دهد.
  - خروجی ماتریس احتمال لگاریتمی فریم‌به‌فریم (`Log-Probs`) با گام ۲۰ میلی‌ثانیه که برای الگوریتم `CTC Prefix Beam Search`، تزریق پیشوند `Context-Biasing Prefix Trie` و هم‌ترازی اجباری `Viterbi Forced Alignment` ایده‌آل است.
- **نیاز سخت‌افزاری:** بسیار سبک (`115M` تا `600M` پارامتر؛ قابل اجرا با `RTF < 0.05` روی GPU و قابل تبدیل به `ONNX / WebGPU / WASM SIMD`).
- **مجوز استفاده:** `Apache-2.0` (برای کدهای NeMo؛ مجوز هر چک‌پوینت فارسی باید جداگانه در ریجستری بررسی شود).

---

### ۲.۴. مدل‌های تخصصی فارسی مبتنی بر Wav2Vec2 / XLS-R
- **نمونه‌ها:** چک‌پوینت‌های Fine-tune شده روی `facebook/wav2vec2-large-xlsr-53` یا `xls-r-300m` برای فارسی.
- **کاربرد در آزمایشگاه:** استفاده به‌عنوان **Acoustic Forced Aligner** (هم‌ترازی دقیق واج و کاراکتر به کمک خروجی CTC) در کنار مدل‌های تولیدکننده متن مانند Qwen3-ASR یا Whisper Turbo.

---

## ۳. جدول خلاصه وضعیت دسترسی در فاز صفر

| نام موتور | نوع | پشتیبانی فارسی | پشتیبانی انگلیسی | Code-Switching (FA+EN) | Batch | Streaming | اجرای محلی (Self-Hosted) | وضعیت فعلی در محیط آزمایشگاه `[Observed Fact]` |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **ElevenLabs Scribe v3** | تجاری (API) | بله (قوی) | بله | بله (مرجع اول) | بله | خیر (`v3_live` مجزاست) | خیر | نیازمند `ELEVENLABS_API_KEY` |
| **ElevenLabs Scribe v3 Live** | تجاری (WS) | بله | بله | بله | خیر | بله (کم‌تأخیر) | خیر | نیازمند `ELEVENLABS_API_KEY` |
| **Deepgram Nova-3** | تجاری (API/WS) | بله | بله | نیازمند تست `fa` vs `multi` | بله | بله (فوق‌سریع) | خیر (فقط Enterprise) | نیازمند `DEEPGRAM_API_KEY` |
| **OpenAI GPT-Transcribe** | تجاری (API) | بله | بله | نیازمند تست حفظ متن خام | بله | خیر | خیر | نیازمند `OPENAI_API_KEY` |
| **OpenAI GPT-Live-Transcribe**| تجاری (WS) | بله | بله | نیازمند تست در استریم | خیر | بله | خیر | نیازمند `OPENAI_API_KEY` |
| **AssemblyAI Universal-3.5 Pro**| تجاری (API/WS)| متوسط/نیازمند تست| بله | نیازمند تست | بله | بله | خیر | نیازمند `ASSEMBLYAI_API_KEY` |
| **Microsoft MAI-Transcribe-2**| تجاری (API) | بله (`fa-IR`) | بله | نیازمند تست | بله | بله (Azure SDK) | کانتینر سازمانی | نیازمند `AZURE_SPEECH_KEY` |
| **Qwen3-ASR (0.6B / 1.7B)** | متن‌باز | بله | بله | بله (نامزد اصلی بومی) | بله | بله | **بله** | نیازمند محیط GPU ابری/محلی Python |
| **Whisper Large-v3 / Turbo** | متن‌باز (MIT) | بله | بله | متوسط (نیازمند پرامپت/LoRA)| بله | با Chunking | **بله** | منطق توکن/پرامپت در کد موجود است؛ وزن‌ها نیازمند GPU |
| **NeMo FastConformer-CTC** | متن‌باز (Apache)| بله | بله | نیازمند Vocabulary دوزبانه| بله | بله (Cache-aware)| **بله (حتی ONNX)** | دیکودر CTC و Prefix Trie در کد تایپ‌اسکریپت موجود است |
