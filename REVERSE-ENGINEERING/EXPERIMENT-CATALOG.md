# کاتالوگ آزمایش‌های کنترل‌شده کالبدشکافی رفتاری موتورهای ASR (Phase 3: Experiment Catalog)

**نسخه سند:** `1.0.0-phase3`  
**تاریخ:** ۱۸ نوامبر ۲۰۲۶  
**هدف:** تعریف دقیق ۱۰ آزمایش کنترل‌شده و ۴ پروفایل تنظیماتی برای کالبدشکافی رفتار موتورهای تجاری و متن‌باز روی ورودی‌های صوتی یکسان.

---

## ۱. چهار پروفایل تنظیمات استاندارد (`4 Controlled Configuration Profiles`)

هر نمونه صوتی در آزمایشگاه تحت ۴ وضعیت تنظیمات کاملاً مشخص آزمایش می‌شود تا اثر تنظیمات از توان ذاتی مدل تفکیک گردد:

| کد پروفایل | نام وضعیت تنظیمات | پارامتر زبان (`language`) | وضعیت `Keyterm Prompting` | وضعیت `Context Prompt` | هدف علمی مقایسه |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **`CFG-01_DEFAULT`** | **تنظیمات پیش‌فرض کارخانه** | `auto` (تشخیص خودکار) | غیرفعال (`[]`) | غیرفعال (`""`) | سنجش رفتار خام موتور بدون هیچ راهنمایی بیرونی |
| **`CFG-02_PERSIAN`** | **تنظیمات مخصوص فارسی** | `fa` (فارسی صریح) | غیرفعال (`[]`) | پرامپت نگارش معیار و نیم‌فاصله فارسی | سنجش بهبود `CER` فارسی هنگام حذف ابهام تشخیص زبان |
| **`CFG-03_ENGLISH`** | **تنظیمات مخصوص انگلیسی** | `en` (انگلیسی صریح) | غیرفعال (`[]`) | پرامپت انگلیسی فنی | سنجش خط پایه دقت انگلیسی خالص |
| **`CFG-04_CODESWITCH`**| **تنظیمات گفتار ترکیبی و تخصصی** | `fa-en` / `multi` | **فعال (تزریق واژگان تخصصی دامنه)** | **فعال (پرامپت دوزبانه فنی فارسی-انگلیسی)** | سنجش حداکثر توان موتور در تشخیص Code-Switching و اسامی خاص |

---

## ۲. جدول ۱۰ آزمایش تخصصی کالبدشکافی رفتاری (`EXP-01` تا `EXP-10`)

| کد آزمایش | عنوان آزمایش | متغیر مورد بررسی | متریک‌های خروجی ثبت‌شده | وضعیت پیاده‌سازی در هسته آزمایشگاه |
| :--- | :--- | :--- | :--- | :--- |
| **EXP-01** | **Language Detection (LID)** | ارسال نمونه‌های فارسی، انگلیسی و ترکیبی در پروفایل `CFG-01_DEFAULT` | دقت تشخیص زبان (`LID Accuracy %`) و خطای `LANGUAGE_ID_ERROR` | عملیاتی در `AsrDatasetAndBehavioralBenchmarkEngine.ts` |
| **EXP-02** | **Code-Switching Reaction** | جملات فارسی حاوی ۱ تا ۴ اصطلاح فنی انگلیسی (`TypeScript`, `Backend`, `API`, `WebGPU`) | نرخ بازیابی انگلیسی (`CS Recall %`)، نوع خط خروجی (لاتین در برابر آوانگاری فارسی) | عملیاتی (ارزیابی سه‌لایه Raw / Normalized / Dual-Script) |
| **EXP-03** | **Noise Robustness** | مقایسه سیگنال تمیز (`SNR = 30dB`) با نویز محیطی/کافه (`SNR = 15dB, 8dB`) | شیب افت دقت ($\Delta\text{CER} / \Delta\text{SNR}$) و نرخ توهم (`HALLUCINATION_NO_AUDIO`) | عملیاتی با تزریق نویز کنترل‌شده روی سیگنال ۱۶kHz |
| **EXP-04** | **Accent & Colloquial Sensitivity**| مقایسه فارسی معیار (`formal_read`) با فارسی محاوره‌ای (`conversational_spontaneous`) | شکاف دقت محاوره ($\text{CER}_{\text{colloquial}} - \text{CER}_{\text{formal}}$) | عملیاتی |
| **EXP-05** | **Speech Rate Tolerance** | سرعت گفتار عادی (`120-150 WPM`) در برابر گفتار سریع (`> 185 WPM`) | نرخ حذف کلمات کوتاه و حروف ربط (`WORD_DELETION`) | عملیاتی (قابل تست با موتور تغییر سرعت `TimeStretchWsolaEngine`) |
| **EXP-06** | **Keyterm Prompting Impact** | مقایسه مستقیم پروفایل `CFG-02_PERSIAN` (بدون Keyterm) با `CFG-04_CODESWITCH` (با Keyterm) | درصد کاهش خطای اسامی خاص و هم‌آواها (`PROPER_NOUN_ERROR` & `PERSIAN_WORD_ERROR`) | عملیاتی با `ContextBiasingTrieCtcScorer` |
| **EXP-07** | **Long Audio & Chunking** | برش فایل به قطعات ۱۰ و ۳۰ ثانیه‌ای و بررسی مرز قطعات | نرخ حذف یا تکرار کلمه در مرز برش (`CHUNKING_BOUNDARY_ERROR`) | عملیاتی |
| **EXP-08** | **Speaker Diarization** | گفتگوی ۲ گوینده با تغییر نوبت و هم‌پوشانی (Crosstalk) | نرخ خطای گوینده (`DER %`)، ادغام دو گوینده (`SPEAKER_MERGE_ERROR`) و تفکیک کاذب (`SPEAKER_SPLIT_ERROR`) | عملیاتی با `MultiSpeakerDiarizationAndCrosstalkEngine` |
| **EXP-09** | **Streaming Revision & Latency**| بررسی زمان اولین توکن (`TTFT`)، تأخیر میانه (`Median`)، صدک ۹۵ (`P95`) و پایداری Endpointing | `TTFT ms`, `P50/P95 Latency ms`, نرخ برش زودهنگام مکث پس از «که...» | عملیاتی با `PersianSyntacticAcousticEndpointDetector` |
| **EXP-10** | **Failure Recovery & Timeout** | شبیه‌سازی قطع اتصال، Timeout، پاسخ خالی و نبود کلید API | نرخ بازیابی، عدم توقف سایر موتورها و عدم نشت اسرار در لاگ | عملیاتی و تأییدشده در تست‌های خودکار |
