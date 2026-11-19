# ممیزی دامنه محصول و پیچیدگی رابط کاربری (AVP-P00-001 — UI Product Scope Audit)

**مأموریت:** `AVP-P00-001`  
**اصل محصولی:** آواپرداز یک **استودیوی محلی تدوین هوشمند گفتار** است، نه یک DAW همه‌کاره، آزمایشگاه پژوهش چندموتوره، پورتال توسعه‌دهنده یا کارخانه MLOps.

---

## ۱. نقشه گردش کار واقعی UI در مقایسه با جریان ۶مرحله‌ای هدف (`[OBSERVED]`)

| گام هدف محصول | وضعیت فعلی در `src/App.tsx` | ارزیابی |
| --- | --- | --- |
| **۱. Import Audio** | دکمه «ورود فایل صوتی» (`App.tsx:1817`) + پیش‌فرض پروژه نمونه ساختگی | موجود، اما با Decode کامل در RAM و وجود دکمه ضبط مصنوعی |
| **۲. Transcribe** | دکمه ASR در `TranscriptPanel` → `handleRunPersianAsr` (`App.tsx:581`) | **معیوب از نظر هدف محلی** (تلاش ابری Gemini یا سقوط به کلمات placeholder) |
| **۳. Analyze Speech** | تشخیص تپق/مکث/تکرار (`persianAsrTranscriber.ts`) — خودکار پس از Load/ASR + دکمه اسکن عمیق | موجود و ارزشمند (نیازمند اتصال به متن واقعی ASR در فاز ۳) |
| **۴. Review Suggested Edits** | `SuggestionsPanel` + پیش‌نمایش صوتی (`handlePreviewRecommendation`) + تغییر لبه برش | موجود و هم‌راستا با هدف |
| **۵. Apply Approved Edits** | دکمه‌های قبول/رد/اعمال گروهی + برش مستقیم در `TranscriptPanel` و `WaveformCanvas` | موجود و هم‌راستا با هدف |
| **۶. Export Clean Audio** | دکمه «خروجی WAV» در `HeaderNav` → `ExportModal` | موجود، اما با تخصیص کامل WAV در RAM |

---

## ۲. طبقه‌بندی بخش‌های قابل مشاهده در رابط کاربری (`[OBSERVED]`)

| بخش UI | محل در کد | طبقه‌بندی پیشنهادی | وابستگی‌ها و دلیل |
| --- | --- | --- | --- |
| **Studio Workspace (`WaveformCanvas`, `TranscriptPanel`, `SuggestionsPanel`, `AuditionTransportBar`, `AuditionSideDock`)** | `App.tsx:1933-2102`, `HeaderNav.tsx` | **هسته ضروری محصول (KEEP — CORE)** | تشکیل‌دهنده مستقیم ۶ گام اصلی کاربر تدوین صوت |
| **Export Modal** | `App.tsx:2104`, `components/ExportModal.tsx` | **هسته ضروری محصول (KEEP — CORE)** | خروجی نهایی تمیز برای کاربر |
| **DSP Control Rack & Processing Graph** | `App.tsx:2021, 2060`, `DspControlRack.tsx`, `ProcessingGraphView.tsx` | **پیشرفته / ثانویه (SIMPLIFY / COLLAPSE)** | برای تدوین صوت کاربردی است اما نباید تمرکز صفحه اول را از متن/پیشنهاد بگیرد |
| **Storage Broker View** | `App.tsx:2070`, `StorageBrokerView.tsx` | **تشخیصی داخلی (MOVE TO INTERNAL / DIAGNOSTICS)** | دکمه‌های تست آزمایشگاهی («Simulate LRU Cache Fill»، «Broker Concurrency Test») دارد که مناسب کاربر نهایی نیست |
| **ASR Lab (`AsrResearchLabModal`)** | `App.tsx:1855, 2116` | **ابزار پژوهش داخلی (HIDE / DEV FLAG)** | آزمایشگاه بنچمارک ۱۰ موتور تجاری (`ElevenLabs`, `Deepgram`, `OpenAI`, ...) — ناهم‌راستا با محصول محلی کاربر |
| **Developer Portal (`DeveloperPlatformPortalModal`)** | `App.tsx:1865, 2127` | **ابزار توسعه‌دهنده / SaaS (HIDE / REMOVE FROM STUDIO)** | مدیریت کلید API، Webhook و Billing سازمانی |
| **Speech Intelligence (`SpeechIntelligenceModal`)** | `App.tsx:1875, 2132` | **حاشیه خارج از دامنه (HIDE / INTERNAL)** | خلاصه‌سازی، QA، چت جلسه و ترجمه چندزبانه |
| **Data Factory (`DataFactoryModal`)** | `App.tsx:1885, 2161` | **کارخانه داده داخلی (HIDE / INTERNAL)** | مدیریت Dataset، برچسب‌زنی و Split Policy |
| **Model Factory (`ModelFactoryModal`)** | `App.tsx:1895, 2166` | **کارخانه MLOps (HIDE / INTERNAL)** | آموزش LoRA، آزمایش‌های هایپرپارامتر و انتشار مدل |
| **Speech Security (`SpeechSecurityModal`)** | `App.tsx:1905, 2171` | **ممیزی امنیت SaaS (HIDE / INTERNAL)** | Red-team، Prompt injection و Deletion cascade چندمستاجره |
| **پوسته موازی `DesktopAudioStudioApp` & `useAudioStudioController`** | `StudioRootBootstrapper.tsx:408`, `?shell=v12` | **پوسته تکراری (CONSOLIDATE / REMOVE DUPLICATION)** | دو UI کاملاً متفاوت برای یک برنامه وجود دارد |

---

## ۳. حداقل برنامه ایمن ساده‌سازی رابط کاربری (برای فاز ۴ / فاز ۷)

1. **عدم تغییر UI در فاز ۰ و ۱.**
2. پس از تکمیل هسته حافظه و ASR محلی:
   - انتقال ۶ دکمه مودال غیرمرتبط (`ASR Lab`, `Developer Portal`, `Speech Intelligence`, `Data Factory`, `Model Factory`, `Speech Security`) از نوار ابزار اصلی به پشت پرچم صریح توسعه (`?devTools=1`) یا حذف از شل استودیوی کاربر.
   - یکدست‌سازی `StudioRootBootstrapper` با پوسته واحد استودیو (بدون نمایش هم‌زمان دکمه‌های تست ذخیره و پورتال).
   - قرار دادن نمایشگر شفاف وضعیت مدل محلی و مصرف بودجه حافظه (`Target 850 MiB / Hard 1024 MiB`) در نوار وضعیت.
