# ثبت وابستگی‌های ابری و قابلیت آفلاین (AVP-P00-001 — Cloud Dependency Register)

**مأموریت:** `AVP-P00-001`  
**اصل بررسی:** وجود یک endpoint بلااستفاده به‌تنهایی به‌معنای وابستگی تولیدی نیست؛ هر نقطه تماس بر اساس **قابل‌دسترس‌بودن در تولید (`Production Reachable`)** و محتوای payload طبقه‌بندی شده است.

---

## ۱. جدول طبقه‌بندی اتصالات خارجی و بین‌مرزی (`[OBSERVED]`)

| # | Category | Endpoint / External Target | Caller | Payload | Audio? | Transcript? | User Data? | Req / Opt | Production Reachable | Local Alternative | Removal Risk |
| :-: | --- | --- | --- | --- | :---: | :---: | :---: | :---: | :---: | --- | --- |
| 1 | `TRANSCRIPTION REQUEST` + `USER AUDIO UPLOAD` | `POST /api/v1/asr/transcribe` → `GoogleGenAI('gemini-3.5-transcribe')` (`server.ts:133-201`) | `src/App.tsx:601` (`handleRunPersianAsr`) | JSON `{ audioBase64, mimeType }` (کل صوت 16kHz WAV) | **بله** | دریافت | **بله** | اختیاری در نبود کلید (سقوط به کلمات ساختگی)، اما مسیر اصلی UI | **بله (مستقیم از دکمه ASR)** | خط لوله محلی `WebWorker + onnxruntime-web` (فاز ۲) | کم؛ پس از آماده‌شدن پشته ONNX حذف یا مسدود می‌شود |
| 2 | `OPTIONAL RESEARCH PROVIDER` | `POST /api/v1/lab/provider-transcribe` (`server.ts:278-308`) | `ServerBackedProviderAdapter` (`AsrExperimentationLabCore.ts:885`) via `AsrResearchLabModal` | `{ engineId, audioSha256, durationSec, keyterms, contextPrompt }` | خیر (در نسخه فعلی سرور فقط متادیتا چک می‌شود) | پاسخ خالی/خطا | اندک | اختیاری (آزمایشگاه پژوهش) | **بله (از طریق مودال ASR Lab)** | ایزوله‌سازی پشت فلگ Dev-Only | بسیار کم؛ تاثیری بر تدوین ندارد |
| 3 | `DEVELOPMENT TOOLING` / CDN Font | `https://fonts.googleapis.com` & `https://fonts.gstatic.com` (`index.html:20-22`) | مرورگر در زمان لود `index.html` | درخواست HTTP GET CSS/WOFF2 | خیر | خیر | خیر (IP/UA) | اختیاری (فونت) | **بله (هر بار باز کردن برنامه)** | بسته‌بندی فونت محلی `Vazirmatn` و `JetBrains Mono` در `public/fonts/` | صفر؛ بهبود آفلاین و سازگاری COEP |
| 4 | `MODEL DOWNLOAD` | `fetch(url)` (`src/platform/ChunkedModelDelivery.ts:138`) | دانلود چانک مدل به OPFS (هنوز به `App.tsx` وصل نیست) | GET دریافت فایل مدل + بررسی SHA-256 | خیر | خیر | خیر | نیاز اولیه برای دریافت مدل محلی | خیر (هنوز به UI وصل نشده) | سرو از مبدأ محلی `/models/` یا انتخاب فایل مدل محلی توسط کاربر | کم (در فاز ۲ باید به مسیر ایمن متصل شود) |
| 5 | `MODEL METADATA` / `LICENSE VALIDATION` | `/api/v1/models/:id/manifest`, `/api/v1/license/lease`, `/api/v1/crypto/public-key` (`server.ts:204-275`) | فعلاً فراخوانی‌کننده فعال از `App.tsx` ندارد (`[INFERRED]` از grep) | JSON امضای Ed25519 و مانیفست | خیر | خیر | شناسه‌های نمونه | اختیاری | فقط در صورت فراخوانی مستقیم API | مانیفست استاتیک محلی با هش SHA-256 درون بسته PWA | کم |
| 6 | `TELEMETRY` / `PLATFORM` / `SECURITY` | `/api/v1/platform/*`, `/v1/*`, `/api/v1/intelligence/*`, `/api/v1/data/*`, `/api/v1/ml/*`, `/api/v1/security/*` (`server.ts:510+`) | مودال‌های پورتال و کارخانه (`App.tsx:2127-2174`) | متادیتای سازمان، پروژه‌های تست، قوانین و بخش‌هایی از متن استودیو (`SpeechIntelligenceModal.tsx:2135`) | خیر | **بله (در `SpeechIntelligenceModal` فقط به حافظه همین سرور Express محلی)** | بله (در نشست محلی) | غیرضروری برای محصول تدوین | **بله (با باز کردن مودال‌های Toolbar)** | پنهان‌کردن مودال‌ها از رابط استودیوی اصلی (فاز ۴) | بسیار کم |
| 7 | `OPTIONAL RESEARCH PROVIDER` (Server Condition) | `process.env.GEMINI_API_KEY` check (`TranslationSubtitlesEngine.ts:147`) | فقط هنگام فراخوانی صریح `requireExternalNeuralMt: true` از API ترجمه | متن سگمنت‌ها | خیر | بله | بله | اختیاری | فقط از اندپوینت intelligence | آداپتور محلی قطعی موجود (`DeterministicBilingualTranslationAdapter`) | صفر |
| 8 | `WEBSOCKET` (Planned / Test-Only) | شبیه‌سازی دست‌دادن WebSocket در `RealTimeStreamingAsrEngine.ts` و `backend/src/gateway/WebSocketLiveAsrGateway.ts` | `AsrResearchLabModal.tsx:368` (حالت حافظه محلی) | بسته‌های تستی PCM | در تست | در تست | خیر | اختیاری/تستی | خیر (اتصال شبکه واقعی `new WebSocket()` در سورس کلاینت یافت نشد `[OBSERVED]`) | `AudioWorklet` + Worker محلی | صفر |

---

## ۲. ماتریس ۷سؤال اجرای آفلاین کامل (`Offline Execution Assessment — [OBSERVED]`)

| سؤال قابلیت آفلاین | وضعیت کنونی | توضیح شاهد |
| --- | :---: | --- |
| **۱. بارگذاری UI بدون دسترسی شبکه؟** | **ناقص (نیازمند تکمیل)** | `/sw.js` رجیستر می‌شود و `index.html` را کش می‌کند، اما در `index.html:20-22` فونت‌ها به `fonts.googleapis.com` وابسته‌اند و پوسته PWA تنها فایل‌های `/`، `/index.html` و `/manifest.webmanifest` را پیش‌کش (`precache`) می‌کند (`public/sw.js:3-7`)؛ فایل JS اصلی تا یک بار لود آنلاین کش نمی‌شود. |
| **۲. بارگذاری مدل کش‌شده قبلی بدون شبکه؟** | **غیرعملیاتی** | هنوز هیچ فایل مدل `.onnx` یا `onnxruntime-web` در پروژه یا OPFS متصل به UI وجود ندارد. |
| **۳. رونویسی گفتار (Transcribe) بدون شبکه؟** | **خیر (کلمات ساختگی)** | در نبود شبکه، `App.tsx:628` صرفاً `buildOfflineAcousticSegmentedTranscript()` را اجرا کرده و کلمات جعلی می‌سازد؛ ASR واقعی آفلاین وجود ندارد. |
| **۴. تحلیل گفتار (تپق، مکث، تکرار) بدون شبکه؟** | **بله (مشروط به داشتن متن)** | الگوریتم‌های `persianAsrTranscriber.ts` و `dsp.ts` ۱۰۰٪ محلی در مرورگر روی `tokens` و `Float32Array` اجرا می‌شوند. |
| **۵. رندر صوت تدوین‌شده بدون شبکه؟** | **بله (با باگ حافظه کل فایل)** | `StudioAudioTransport` و `streamingChunkedRender` کاملاً محلی در مرورگر کار می‌کنند، اما برای فایل طولانی محدودیت ۱ GiB را نقض می‌کنند. |
| **۶. خروجی (Export WAV) بدون شبکه؟** | **بله (با باگ حافظه کل فایل)** | `encodeAndValidateWavExport` محلی است، اما کل فایل WAV را یکجا در RAM می‌سازد. |
| **۷. بازیابی پروژه قبلی بدون شبکه؟** | **ناقص / غیرفعال در ویرایش** | خواندن `recovery-journal` در `StudioRootBootstrapper.tsx:224` وجود دارد، اما `App.tsx` هنگام ویرایش Checkpoint نمی‌نویسد و PCM آپلودی نیز در OPFS ذخیره نمی‌شود! |
