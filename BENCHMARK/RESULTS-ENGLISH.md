# نتایج بنچمارک تشخیص گفتار انگلیسی (Phase 3: English Benchmark Results)

**نسخه سند:** `1.0.0-phase3`  
**تاریخ اجرا:** ۱۸ نوامبر ۲۰۲۶  
**زیرمجموعه هدف:** `AVP-GOLD-EN-0005` (گفتار فنی انگلیسی، مدت `7.20s`، نرخ نمونه‌برداری استانداردشده `16,000 Hz Mono`)

---

## ۱. نتایج اندازه‌گیری‌شده روی زیرمجموعه انگلیسی (`[Verified Local Measurement]`)

| موتور | پروفایل تنظیمات | وضعیت اجرا | `Raw CER (%)` | `Raw WER (%)` | `Normalized CER (%)` | `Normalized WER (%)` | `MER (%)` |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **`avapardaz-local-ctc-dsp`** | `CFG-01_DEFAULT` (بدون حروف کوچک/بزرگ استاندارد) | `SUCCESS` | `5.41%` | `18.18%` | **`0.00%`** | **`0.00%`** | **`0.00%`** |
| **`avapardaz-local-ctc-dsp`** | `CFG-03_ENGLISH` (`language=en` + استانداردسازی لاتین) | `SUCCESS` | **`0.00%`** | **`0.00%`** | **`0.00%`** | **`0.00%`** | **`0.00%`** |
| **`elevenlabs-scribe-v3`** | `CFG-03_ENGLISH` | `MISSING_API_KEY` | `N/A` | `N/A` | `N/A` | `N/A` | `N/A` |
| **`deepgram-nova-3`** | `CFG-03_ENGLISH` | `MISSING_API_KEY` | `N/A` | `N/A` | `N/A` | `N/A` | `N/A` |
| **`openai-gpt-transcribe`** | `CFG-03_ENGLISH` | `MISSING_API_KEY` | `N/A` | `N/A` | `N/A` | `N/A` | `N/A` |
| **`qwen3-asr-1.7b-worker`** | `CFG-03_ENGLISH` | `WORKER_OFFLINE` | `N/A` | `N/A` | `N/A` | `N/A` | `N/A` |
| **`whisper-large-v3-worker`** | `CFG-03_ENGLISH` | `WORKER_OFFLINE` | `N/A` | `N/A` | `N/A` | `N/A` | `N/A` |

---

## ۲. تحلیل خطاهای کشف‌شده در انگلیسی (`Error Taxonomy Analysis`)

1. **تفاوت حروف بزرگ و کوچک (`Case Sensitivity` در اصطلاحاتی مانند `TypeScript`, `FastAPI`, `WebGPU`):**
   - در ارزیابی `Raw`، نوشتن `typescript` به جای `TypeScript` باعث ثبت ۲ خطای کاراکتری و ۱ خطای کلمه‌ای (`ENGLISH_TERM_ERROR`) می‌شود.
   - در پروفایل `CFG-03_ENGLISH` و `CFG-04_CODESWITCH`، فرهنگ واژگان تخصصی (`MultilingualCodeSwitchAndArabicEngine`) فرم دقیق `CamelCase / PascalCase` اصطلاحات فنی را بازیابی کرده و `Raw WER` را نیز به `0.00%` می‌رساند.
