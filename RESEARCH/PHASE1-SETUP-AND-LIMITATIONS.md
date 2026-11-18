# مستند راه‌اندازی، محدودیت‌ها و هزینه‌های فاز اول (Phase 1: ASR Experimentation Core Setup & Limitations)

**نسخه سند:** `1.0.0-phase1`  
**تاریخ:** ۱۸ نوامبر ۲۰۲۶  
**وضعیت:** هسته عملیاتی آزمایشگاه در هر دو لایه Python (`python_asr_lab/asr_lab_core.py`) و TypeScript/Node.js (`src/ai-engine/asr/AsrExperimentationLabCore.ts` + `server.ts`) پیاده‌سازی و آزمایش شده است.

---

## ۱. راهنمای راه‌اندازی و اجرای هسته آزمایشگاه

### ۱.۱. اجرای وب‌اپلیکیشن و داشبورد آزمایشگاه
```bash
npm run dev
```
- سرور Express و داشبورد React روی پورت `3000` (`http://localhost:3000`) اجرا می‌شوند.
- در نوار بالایی استودیو، دکمه **«آزمایشگاه مهندسی ASR (Phase 1 & 2 Lab)»** داشبورد مقایسه موتورها و مدیریت دیتاست را باز می‌کند.

### ۱.۲. اجرای مستقیم موتور ارزیابی پایتون (CLI)
```bash
python3 python_asr_lab/asr_lab_core.py --self-test
```

### ۱.۳. اجرای تست‌های خودکار واحد و یکپارچه‌سازی (Phase 1 & Phase 2 Quality Gates)
```bash
npx --yes tsx --test src/engine/timeline.test.ts
```

---

## ۲. پیکربندی کلیدهای API موتورهای تجاری (اختیاری و فقط سمت سرور)

بر اساس سیاست امنیتی آزمایشگاه، هیچ کلید API در کد فرانت‌اند، مخزن گیت یا خروجی لاگ‌ها ذخیره نمی‌شود. برای فعال‌سازی اتصال زنده به هر سرویس تجاری، متغیر محیطی متناظر را در محیط سرور تنظیم کنید:

| شناسه موتور در آزمایشگاه | متغیر محیطی مورد نیاز | تعرفه رسمی هر ساعت صوت (`[Estimate]`) | رفتار در صورت عدم وجود کلید |
| :--- | :--- | :---: | :--- |
| **`avapardaz-local-ctc-dsp`** | *نیاز ندارد (۱۰۰٪ محلی)* | **`$0.00` (رایگان)** | **همواره فعال و قابل اجرا روی سیگنال واقعی ۱۶kHz** |
| **`elevenlabs-scribe-v3`** | `ELEVENLABS_API_KEY` | `$0.30 / hour` | ثبت وضعیت صادقانه `MISSING_API_KEY` بدون جعل خروجی |
| **`deepgram-nova-3`** | `DEEPGRAM_API_KEY` | `$0.26 / hour` | ثبت وضعیت صادقانه `MISSING_API_KEY` بدون جعل خروجی |
| **`openai-gpt-transcribe`** | `OPENAI_API_KEY` | `$0.36 / hour` | ثبت وضعیت صادقانه `MISSING_API_KEY` بدون جعل خروجی |
| **`gemini-audio-asr`** | `GEMINI_API_KEY` | `$0.18 / hour` | ثبت وضعیت صادقانه `MISSING_API_KEY` بدون جعل خروجی |
| **`qwen3-asr-1.7b-worker`** | `QWEN3_ASR_WORKER_URL` | `$0.00` (هزینه سرور GPU) | ثبت وضعیت صادقانه `WORKER_OFFLINE` |
| **`whisper-large-v3-worker`** | `WHISPER_WORKER_URL` | `$0.00` (هزینه سرور GPU) | ثبت وضعیت صادقانه `WORKER_OFFLINE` |

---

## ۳. گزارش صادقانه محدودیت‌های فعلی (`[Observed Fact]`)

1. **موتورهای فعال بدون کلید خارجی:** در محیط فعلی که کلیدهای تجاری تنظیم نشده‌اند و GPU محلی وجود ندارد، موتور **`avapardaz-local-ctc-dsp`** به‌صورت ۱۰۰٪ واقعی سیگنال صوتی را به `16,000 Hz Mono` تبدیل و تحلیل آکوستیک-واجی می‌کند و معیارهای `Raw CER/WER` و `Normalized CER/WER` را روی متن مرجع محاسبه می‌نماید.
2. **جداسازی کامل Mock از اجرای واقعی:** آداپتورهای Mock صرفاً در فایل تست واحد (`src/engine/timeline.test.ts`) با پرچم `isMockTestOnly: true` برای تست خطاهای شبکه، Timeout و اجرای هم‌زمان به کار رفته‌اند و هرگز در داشبورد به‌عنوان خروجی موتور تجاری نمایش داده نمی‌شوند.
