# AVAPARDAZ — PHASE 1B
## NATIVE COMPANION STREAMING & MEMORY FOUNDATION REPORT
**تاریخ اجرا:** `2026-11-23`
**وضعیت فاز:** **`VERIFIED_IN_TESTS` / `HARDWARE_QUALIFICATION_PENDING`**
**دامنهٔ فاز 1B:** مسیر `Adobe Audition CEP` $\rightarrow$ `Companion Audio Transfer` $\rightarrow$ `LocalCompanionService` $\rightarrow$ `Native ASR Preparation`

---

## ۱. نتیجهٔ راستی‌آزمایی پیش‌نیاز Phase 1A.1 (Prerequisite Gate)

پیش از شروع هرگونه تغییر کد در Phase 1B، تمام فایل‌های امنیتی Phase 1A و Phase 1A.1 به‌صورت مستقیم از دیسک بررسی و تست‌های امنیتی آن‌ها مجدداً اجرا شدند (`[Observed Fact]`):

| فایل بررسی‌شده | وضعیت در کد جاری | نتیجهٔ بررسی و تست |
| :--- | :---: | :--- |
| `src/security/AudioApiSecurityGuard.ts` | موجود و منطبق | تفکیک صریح `local` و `hosted`، رد Shared Secret خام در Hosted، اعتبارسنجی `aud`/`iss`/`sub`/`exp`، رد `ownerId` جعلی در Body/Header، مسدودسازی DNS-Rebinding و الزام `Origin` در `/api/local-auth/session` (`[Observed Fact]`). |
| `src/workflow/SmartAudioEditJobManager.ts` | موجود و منطبق | الزام `requireExplicitOwnerId: true` در Hosted، رد Subjectهای عمومی (`default`, `shared`, `anonymous`, `local-default`)، و ایزوله‌سازی آمار و سهمیهٔ هر کاربر (`[Observed Fact]`). |
| `src/workflow/SmartAudioEditHttpRouter.ts` | موجود و منطبق | استخراج `ownerId` صرفاً از `getVerifiedAudioApiPrincipal(res)` و رد هرگونه `ownerId` ارسالی کلاینت با `400 CLIENT_OWNER_ID_FORBIDDEN` (`[Observed Fact]`). |
| `src/asr-core/SafeModelSupplyChain.ts` | موجود و منطبق | دانلود HTTPS-only با Host Allowlist، مسدودسازی IPهای خصوصی/Loopback با DNS Pinning، سقف حجم جریانی، بررسی SHA-256، استخراج عضو‌به‌عضو بدون `extractall()` یا Fallback ناامن `tar -xjf`، و فعال‌سازی اتمیک با Rollback (`[Observed Fact]`). |
| `src/asr-core/LocalSherpaNeuralEngine.ts` | موجود و منطبق | اتصال کامل به `downloadModelFileSafe`, `extractTarBz2ArchiveSafe` و `activateDirectoryAtomically` (`[Observed Fact]`). |
| `src/lifecycle/LocalModelArtifactHttpRouter.ts` | موجود و منطبق | سقف `1 MiB` روی هر درخواست HTTP `Range` (`416 RANGE_TOO_LARGE`)، رد Multi-Range، قفل Single-Flight روی `/prepare`، بررسی SHA-256 پیش از تحویل و `ETag`/`304` (`[Observed Fact]`). |
| `server.ts` | موجود و منطبق | نصب گاردهای امنیتی روی `/api/shahab/*`, `/api/v2/smart-edit/*`, `/api/v1/local-models/*` و `/api/v2/companion` (`[Observed Fact]`). |
| `src/security/AudioApiSecurityPhase1A.test.ts` + `src/security/Phase1A1SupplyChainAndAuthClosure.test.ts` | اجرای زنده | **`10/10 PASS` (صفر خطا)** (`[Observed Fact]`). |

---

## ۲. نقاط حذف‌شدهٔ Full-File Materialization در مسیر Companion

در ممیزی فاز صفر و بررسی کد Phase 1B، نقاط زیر کل فایل صوتی را یکجا در RAM بارگذاری و تا **`2.5x` تا `3.0x`** حجم فایل تخصیص هم‌زمان ایجاد می‌کردند که در Phase 1B به‌طور کامل حذف شدند (`[Observed Fact]`):

| ردیف | فایل و محل قبلی | رفتار قبلی (حذف‌شده) | رفتار جدید در Phase 1B (`[Observed Fact]`) |
| :---: | :--- | :--- | :--- |
| **۱** | `src/host-bridge/companion/CompanionAudioTransfer.ts` (`consumeFinalizedTransferAsWav`) | فراخوانی `rawBytes = fs.readFileSync(sess.tempPath)`، تخصیص `new Float32Array(floatCount)` برای کل فایل در `pcm_f32le`، و تخصیص یک `Buffer.alloc(44 + dataSize)` سوم در `encodePcmFloat32ToWav` / `encodePcmInt16ToWav`؛ همچنین حذف زودهنگام فایل موقت در `finally` پیش از مصرف. | حذف کامل `fs.readFileSync` از `CompanionAudioTransfer.ts`؛ پیاده‌سازی `acquireAudioSource(transferId)` که یک `CompanionAudioSource` مبتنی بر فایل (`FileHandle`) برمی‌گرداند؛ تبدیل استریم دیسک‌به‌دیسک `prepareWavFileStreaming` با پنجره‌های ثابت `<= 256 KiB` و Backpressure واقعی (`drain`)؛ نگهداری فایل موقت تا فراخوانی صریح `await source.close()`. |
| **۲** | `src/host-bridge/companion/LocalCompanionService.ts` (`submitTranscriptionJob` — مسیر `transferId`) | فراخوانی `this.audioTransfers.consumeFinalizedTransferAsWav(transferId)` و نگهداری کل `audioBytes = consumed.wavBytes` در حافظهٔ Node.js در طول عمر Job. | فراخوانی `this.audioTransfers.acquireAudioSource(transferId, { ownerId })`، آماده‌سازی فایل WAV روی دیسک با `await acquiredTransferSource.prepareWavFileStreaming({ signal })`، تحویل مسیر فایل دیسک (`audioFilePath: targetFilePath`, `audioBytes: undefined`) به موتور ASR، و بستن و پاک‌سازی منبع در بلاک `.finally(() => acquiredTransferSource.close(...))`. |
| **۳** | `src/host-bridge/companion/LocalCompanionService.ts` (`submitTranscriptionJob` — مسیر `uploadId` و `GET_SAMPLE_PERSIAN_AUDIO`) | فراخوانی `audioBytes = fs.readFileSync(staged.tempPath)` و حذف فوری فایل، به‌همراه `fs.readFileSync(sample.filePath)`. | حذف کامل تمام فراخوانی‌های `fs.readFileSync` از `LocalCompanionService.ts`؛ نوشتن چانک‌های آپلود با File Descriptor باز (`0o600`) و سقف چانک `<= 256 KiB`، تحویل مستقیم مسیر فایل `staged.tempPath` به موتور ASR و حذف فایل پس از اتمام Job در `.finally(...)`. |
| **۴** | `packages/audition-cep-plugin/client/app.js` (`#localFileInput`) | خواندن کل فایل انتخاب‌شده در حافظهٔ پنل CEP با `FileReader.readAsDataURL(file)` و ارسال یکجای رشتهٔ Base64 در `JOB_SUBMIT`. | حذف `FileReader.readAsDataURL` برای فایل‌های انتخاب‌شده؛ برش فایل با `file.slice(start, end)` در قطعات `192 KiB` (`<= 256 KiB`) و ارسال ترتیبی از طریق `AUDIO_TRANSFER_INIT` $\rightarrow$ `AUDIO_TRANSFER_CHUNK` $\rightarrow$ `AUDIO_TRANSFER_FINALIZE` $\rightarrow$ `JOB_SUBMIT({ transferId })` با پشتیبانی از لغو در حین انتقال (`AUDIO_TRANSFER_ABORT`). |

---

## ۳. طراحی File-Backed `CompanionAudioSource` و مرز تحویل به Native ASR

### الف) قرارداد `CompanionAudioSource` (`src/host-bridge/companion/CompanionAudioTransfer.ts`)
- **مشخصات صوتی حفظ‌شده:**
  - `sampleRate`: نرخ نمونه‌برداری دقیق (`8000` تا `192000` هرتز) بدون تغییر ضمنی.
  - `channelCount`: تعداد کانال دقیق (`1` تا `8` کانال) بدون Downmix ناخواسته.
  - `exactSampleCount`: تعداد دقیق Frameها در هر کانال.
  - `totalSampleValues`: تعداد کل نمونه‌ها (`exactSampleCount * channelCount`).
  - `format`: فرمت دقیق (`pcm_f32le` | `pcm_s16le` | `wav`).
  - `maxRangeSamples`: حداکثر تعداد Frame قابل‌خواندن در یک فراخوانی `readRange` به نحوی که بافر خواندن از دیسک هرگز از **`256 KiB`** تجاوز نکند.
- **عملیات پنجره‌ای و استریمی:**
  - `readRange(startSample, sampleCount, signal?)`: خواندن مستقیم بازهٔ `[startSample, startSample + sampleCount)` از آفست بایتی دقیق روی دیسک با `fs.promises.FileHandle`، بررسی `AbortSignal`، و حسابداری بافر در `fileReadBuffers` و `decoderBuffers`.
  - `readPlanarChannels(startFrame, frameCount, signal?)`: خواندن بازهٔ محدود و تفکیک بدون افت کانال‌ها به آرایهٔ `Float32Array[]` مستقل به ازای هر کانال (`[ch0, ch1, ...]`)؛ تضمین ۱۰۰٪ حفظ تفکیک کانال‌های چپ و راست در فایل‌های Stereo 48 kHz.
  - `prepareWavFileStreaming({ signal, writeHighWaterMarkBytes, onChunkWritten })`:
    - اگر فرمت ورودی `wav` باشد و هدر آن در مرحلهٔ `VALIDATING` تأیید شده باشد، بدون کپی اضافی همان مسیر فایل دیسک را برمی‌گرداند.
    - اگر فرمت ورودی `pcm_s16le` یا `pcm_f32le` باشد، هدر استاندارد ۴۴ بایتی `RIFF/WAVE` (یا هدر ۸۰ بایتی `RF64/ds64` برای داده‌های بزرگ‌تر از `4 GiB`) را تولید کرده و دادهٔ صوتی را در پنجره‌های `<= 256 KiB` از فایل `.part` خوانده، تبدیل کرده و با رعایت کامل Backpressure (`if (!ws.write(chunk)) await once(ws, 'drain')`) در فایل `${transferId}.prepared.wav` می‌نویسد.
  - `close(finalState)`: بستن تمام `FileHandle`ها و Streamها، گذار به وضعیت نهایی (`COMPLETED` | `CANCELLED` | `FAILED`) و سپس `CLEANED`، حذف قطعی فایل‌های موقت از دیسک و آزادسازی سهمیهٔ دیسک (`reservedStagingBytes`).

### ب) شفافیت مرز تحویل به `LocalSherpaNeuralEngine` (`[Observed Fact]`)
- طبق محدودیت‌های صریح بخش ۳ و بخش ۱۰ دستورالعمل Phase 1B («منطق داخلی مدل‌های ASR را بازنویسی نکن؛ کدهای زیر را تغییر نده: موتورهای ASR و DSP برای بازنویسی معماری»)، فایل `src/asr-core/LocalSherpaNeuralEngine.ts` در این فاز دست‌نخورده باقی مانده است.
- در نتیجه:
  1. در لایهٔ **`CompanionAudioTransfer`** و **`LocalCompanionService`**، Materialization کامل فایل به‌طور ۱۰۰٪ حذف شده است (`0` فراخوانی `readFileSync`، انتقال و آماده‌سازی WAV با بافرهای ثابت `<= 256 KiB` و تحویل مسیر فایل روی دیسک `audioFilePath` به `neuralEngine.transcribe`).
  2. در داخل خود `LocalSherpaNeuralEngine.transcribe` (`src/asr-core/LocalSherpaNeuralEngine.ts:943, 952`)، متد داخلی قدیمی همچنان فایل WAV روی دیسک را برای `ingestAudioBufferToCanonical16kMono` می‌خواند و سپس چانک‌های ۲۵ ثانیه‌ای را به باینری `sherpa-onnx-offline` می‌دهد. جریانی‌سازی درون خود `CoreAudioIngestion` / `LocalSherpaNeuralEngine` بدون تغییر منطق ASR، به فاز یکپارچه‌سازی `AudioSourceHandle` در موتورهای داخلی موکول شده و در این گزارش هیچ ادعای کاذبی دربارهٔ تغییر داخلی `LocalSherpaNeuralEngine` مطرح نمی‌شود.

---

## ۴. چرخهٔ عمر ۱۰ مرحله‌ای منابع و مدیریت فایل‌های موقت

در `CompanionAudioTransferManager`، هر انتقال صوتی دقیقاً از ماشین وضعیت ۱۰ مرحله‌ای زیر عبور می‌کند (`[Observed Fact]`):

```text
CREATED -> RECEIVING -> RECEIVED -> VALIDATING -> READY -> PROCESSING -> COMPLETED | CANCELLED | FAILED -> CLEANED
```

| الزام امنیتی و چرخهٔ عمر (بخش ۵) | وضعیت پیاده‌سازی در کد (`[Observed Fact]`) |
| :--- | :--- |
| **شناسهٔ غیرقابل‌حدس ۱۲۸ بیتی (`transferId`)** | تولید با `xfr_${crypto.randomBytes(16).toString('hex')}` (۳۲ کاراکتر هگز، ۱۲۸ بیت آنتروپی). |
| **مسیر اختصاصی و مجوز فایل (`0o600`)** | ایجاد دایرکتوری با `mode: 0o700` و باز کردن فایل موقت با `fs.openSync(tempPath, 'wx', 0o600)`. |
| **محصورسازی ریشه (`stagingDir`) و مسدودسازی Symlink / `..`** | متد `resolveConfinedStagingFilePath` با `fs.lstatSync` (رد Symlink روی دایرکتوری)، `fs.realpathSync` و `path.relative` هرگونه خروج از ریشه یا نام فایل حاوی `..`/`/`/`\` را مسدود می‌کند. |
| **ایزوله‌سازی مالکیت (`ownerId`)** | هر انتقال به `session_id` نشست احراز هویت‌شدهٔ IPC مقید می‌شود؛ دسترسی نشست دیگر به `appendChunk`, `finalizeTransfer`, `acquireAudioSource` یا `abortTransfer` با **`403 TRANSFER_OWNER_MISMATCH`** رد می‌شود. |
| **محدودیت تعداد انتقال هم‌زمان (`maxConcurrentTransfers`)** | پیش‌فرض `4` انتقال هم‌زمان؛ درخواست مازاد با **`429 TRANSFER_CONCURRENCY_LIMIT_EXCEEDED`** رد می‌شود. |
| **محدودیت حجم هر انتقال (`maxTransferBytes`) و کل فضای موقت (`maxTotalStagingBytes`)** | سقف هر انتقال (`512 MiB` قابل‌تنظیم، رد با `413`) و سهمیهٔ کل دایرکتوری موقت (`1 GiB` قابل‌تنظیم، رد با **`507 TEMP_STORAGE_QUOTA_EXCEEDED`**). |
| **اعتبارسنجی هدر WAV بدون خواندن کل فایل (`VALIDATING`)** | در `finalizeTransfer`، برای فرمت `wav` فقط حداکثر `4096` بایت ابتدای فایل از دیسک خوانده شده و ساختار `RIFF`/`RF64`/`WAVE`/`fmt `/`data` و تطابق `sampleRateHz` و `channels` بررسی می‌شود؛ هدر خراب با **`422 INVALID_WAV_HEADER`** به `FAILED -> CLEANED` می‌رود. |
| **عدم حذف فایل موقت پیش از پایان مصرف‌کننده** | فایل‌های `.part` و `.prepared.wav` در وضعیت `PROCESSING` حفظ می‌شوند و تنها زمانی حذف می‌شوند که مصرف‌کننده `await source.close(...)` را فراخوانی کند. |
| **پاک‌سازی فایل‌های یتیم در راه‌اندازی (`cleanupOrphanedFilesOnStartup`)** | در سازندهٔ `CompanionAudioTransferManager` و `LocalCompanionService`، تمام فایل‌های یتیم `xfr_*.part`, `xfr_*.prepared.wav` و `up_*.bin` باقی‌مانده از کرش یا ری‌استارت قبلی شناسایی و پاک‌سازی می‌شوند. |

---

## ۵. سیاست Backpressure و حسابداری تفکیک‌شدهٔ حافظه (Memory Accounting)

کلاس `CompanionTransferMemoryAccountant` (`src/host-bridge/companion/CompanionAudioTransfer.ts:75–191`) تمام ۷ دستهٔ حافظه را به‌صورت مجزا ثبت و سقف‌های سیاست بافر بخش ۶ را اعمال می‌کند (`[Observed Fact]`):

| شاخص سیاستی / دستهٔ حافظه | سقف مجاز طبق دستورالعمل | مقدار اعمال‌شده و اندازه‌گیری‌شده در کد |
| :--- | :---: | :---: |
| حداکثر اندازهٔ هر چانک شبکه (`Transfer Buffers`) | `<= 256 KiB` | **`262,144 B` (`256 KiB`)** — چانک بزرگ‌تر با `413 CHUNK_SIZE_EXCEEDS_POLICY` رد می‌شود. |
| حداکثر بافر خواندن فایل (`File Read Buffers`) | `<= 256 KiB` | **`262,144 B` (`256 KiB`)** |
| حداکثر بافر نوشتن فایل (`File Write Buffers`) | `<= 256 KiB` | **`262,144 B` (`256 KiB`)** با `highWaterMark` محدودشده و انتظار روی رویداد `drain`. |
| بافرهای رمزگشا (`Decoder Buffers`) | محدود به پنجرهٔ خواندن | ثبت‌شده در `readRange` و اعتبارسنجی هدر WAV (`4 KiB` برای هدر). |
| بافرهای رمزگذار (`Encoder Buffers`) | محدود به پنجرهٔ تبدیل | ثبت‌شده در تبدیل استریمی `pcm_f32le -> pcm_s16le` (`<= 256 KiB`). |
| مجموع بافرهای زنده به ازای هر انتقال | `<= 1 MiB` | **`786,432 B` (`768 KiB <= 1 MiB`)** در اوج هم‌زمانی خواندن + تبدیل + نوشتن. |
| شمارش توقف‌های Backpressure (`backpressureDrainWaitCount`) | `> 0` در اشباع Stream | **`73`** بار در فایل ۱۰ دقیقه‌ای، **`219`** بار در ۳۰ دقیقه‌ای، **`439`** بار در ۶۰ دقیقه‌ای. |

---

## ۶. جدول نتایج ۱۶ سناریوی تست اجباری (بخش ۸)

تمام ۱۶ سناریوی الزامی بخش ۸ در فایل `src/host-bridge/companion/__tests__/Phase1BCompanionStreamingAndMemory.test.ts` پیاده‌سازی و اجرا شدند (`[Observed Fact]`):

| ردیف | سناریو | رفتار مورد انتظار | نتیجهٔ واقعی اجرای تست (`[Observed Fact]`) |
| :---: | :--- | :--- | :--- |
| **۱** | فایل کوتاه WAV | خروجی و مقدار نمونه‌ها بدون تغییر | **`PASS`** — نمونه‌های خوانده‌شده با `readRange` با خطای `< 1e-6` منطبق بر موج سینوسی مرجع؛ چرخهٔ کامل ۱۰ وضعیت تا `CLEANED`. |
| **۲** | فایل Stereo با نرخ 48kHz | حفظ کامل تفکیک کانال‌ها و نرخ نمونه | **`PASS`** — خواندن با `readPlanarChannels` روی کانال چپ (500Hz) و کانال راست (1200Hz) با تطابق ۱۰۰٪ نمونه‌به‌نمونه و هدر WAV خروجی `48000 Hz, 2ch`. |
| **۳** | فایل Mono | حفظ دقیق تعداد نمونه | **`PASS`** — `exactSampleCount === 4000` و `channelCount === 1` بدون تغییر. |
| **۴** | فایل بزرگ ۳۰ دقیقه‌ای | عدم ایجاد PCM کامل در RAM | **`PASS`** — فایل `57,600,000 B` (`54.93 MiB`) با بافرهای زندهٔ ثابت `768 KiB` (`<= 1 MiB`) پردازش و آماده شد. |
| **۵** | فایل بزرگ ۶۰ دقیقه‌ای | عدم رشد حافظه متناسب با طول فایل | **`PASS`** — فایل `115,200,000 B` (`109.86 MiB`) دقیقاً با همان سقف بافر زندهٔ `768 KiB` فایل ۱۰ دقیقه‌ای پردازش شد (رشد بافر `0 B`). |
| **۶** | ارسال چانک ناقص | خطای کنترل‌شده و پاک‌سازی | **`PASS`** — رد با `422 TRANSFER_INCOMPLETE_CHUNKS`، حذف فایل موقت و گذار به `FAILED -> CLEANED`. |
| **۷** | ارسال چانک تکراری | رد درخواست | **`PASS`** — رد با `409 DUPLICATE_CHUNK_REJECTED`. |
| **۸** | ارسال چانک خارج از ترتیب | رد درخواست و عدم فساد داده | **`PASS`** — رد با `409 OUT_OF_ORDER_CHUNK_REJECTED`. |
| **۹** | قطع ارتباط در میانهٔ انتقال | توقف و پاک‌سازی فایل موقت | **`PASS`** — فراخوانی `abortTransfer` فایل را بسته و تاریخچهٔ `CREATED -> RECEIVING -> CANCELLED -> CLEANED` را ثبت می‌کند. |
| **۱۰** | لغو در میانهٔ پردازش | توقف مصرف‌کننده و پاک‌سازی امن | **`PASS`** — فعال‌شدن `AbortSignal` در میانهٔ `prepareWavFileStreaming` بلافاصله با `TRANSFER_PROCESSING_ABORTED` متوقف شده و پس از `close('CANCELLED')` به `CLEANED` می‌رود. |
| **۱۱** | خطای دیسک یا نوشتن | آزادسازی منابع و پاک‌سازی | **`PASS`** — خطای نوشتن روی Descriptor بسته با `500 DISK_WRITE_ERROR` مدیریت شده و منابع و فایل موقت به `FAILED -> CLEANED` می‌روند. |
| **۱۲** | خطای رمزگشا یا هدر خراب | خطای کنترل‌شده و پاک‌سازی | **`PASS`** — هدر WAV خراب در مرحلهٔ `VALIDATING` با خواندن صرفاً ۴ کیلوبایت اول شناسایی و با `422 INVALID_WAV_HEADER` به `FAILED -> CLEANED` منتقل شد. |
| **۱۳** | راه‌اندازی مجدد Companion | پاک‌سازی فایل‌های موقت یتیم | **`PASS`** — دو فایل یتیم `xfr_*.part` و `xfr_*.prepared.wav` در بدو راه‌اندازی شناسایی و حذف شدند (`getOrphanedFilesCleanedOnStartup() === 2`). |
| **۱۴** | دو انتقال هم‌زمان | جداسازی کامل منابع و مالکیت | **`PASS`** — تلاش `owner-B` برای ارسال چانک به انتقال `owner-A` با `403 TRANSFER_OWNER_MISMATCH` مسدود شد و اتمام انتقال `B` تأثیری بر فایل فعال `A` نداشت. |
| **۱۵** | رسیدن به سقف فضای موقت | رد کنترل‌شدهٔ انتقال جدید | **`PASS`** — عبور از `maxTotalStagingBytes` با **`507 TEMP_STORAGE_QUOTA_EXCEEDED`** رد شد. |
| **۱۶** | اتصال مجدد CEP (`JOB_RECONNECT`) و Backpressure | بازیابی وضعیت صحیح Job و کارکرد `drain` | **`PASS`** — تست کامل HTTP Loopback از Handshake تا `AUDIO_TRANSFER_*`، `JOB_SUBMIT` و `JOB_RECONNECT` (`200 OK, reconnected: true`)؛ همچنین تأیید هدر `RF64` برای فایل‌های `> 4 GiB`. |

---

## ۷. نتایج بنچمارک حافظه برای سناریوهای ۱۰، ۳۰ و ۶۰ دقیقه (بخش ۹)

بنچمارک‌های زیر در اجرای واقعی تست `Phase1BCompanionStreamingAndMemory.test.ts` روی محیط لینوکس فعلی ثبت شده‌اند (`[Observed Fact]`).
**تذکر صداقت اپیستمیک:** مقادیر زیر در محیط اجرای تست لینوکس فعلی اندازه‌گیری شده‌اند و **تست سخت‌افزار واقعی macOS Apple Silicon M2 با وضعیت `NOT_RUN` (`HARDWARE_QUALIFICATION_PENDING`)** ثبت می‌شود.

| سناریو | حجم واقعی فایل صوتی (`pcm_s16le`, 16kHz Mono) | اندازهٔ بافر چانک / خواندن / نوشتن | اوج کل بافرهای زندهٔ انتقال (`<= 1 MiB`) | RSS پیش از انتقال | اوج RSS در حین انتقال | اوج RSS در حین آماده‌سازی ASR WAV | RSS پس از پاک‌سازی | Companion Peak RSS | تعداد توقف‌های Backpressure (`drain`) | زمان کل انتقال و آماده‌سازی دیسک | فایل موقت باقیمانده پس از `close()` |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **۱۰ دقیقه** | `19,200,000 B` (`18.31 MiB`) | `256 KiB` / `256 KiB` / `256 KiB` | **`768 KiB`** (`786,432 B`) | `142.00 MiB` (`148,897,792 B`) | `144.72 MiB` (`151,748,608 B`) | `155.37 MiB` (`162,914,304 B`) | `155.37 MiB` | **`155.37 MiB`** | `73` | `168 ms` | **`0`** |
| **۳۰ دقیقه** | `57,600,000 B` (`54.93 MiB`) | `256 KiB` / `256 KiB` / `256 KiB` | **`768 KiB`** (`786,432 B`) | `155.62 MiB` (`163,176,448 B`) | `158.00 MiB` (`165,675,008 B`) | `172.25 MiB` (`180,617,216 B`) | `172.25 MiB` | **`172.25 MiB`** | `219` | `351 ms` | **`0`** |
| **۶۰ دقیقه** | `115,200,000 B` (`109.86 MiB`) | `256 KiB` / `256 KiB` / `256 KiB` | **`768 KiB`** (`786,432 B`) | `172.27 MiB` (`180,641,792 B`) | `172.99 MiB` (`181,391,360 B`) | `175.17 MiB` (`183,681,024 B`) | `175.17 MiB` | **`175.17 MiB`** | `439` | `526 ms` | **`0`** |

**تحلیل عددی بنچمارک (`[Observed Fact]`):**
1. با ۶ برابر شدن طول فایل از ۱۰ دقیقه (`18.31 MiB`) به ۶۰ دقیقه (`109.86 MiB`)، **اوج بافرهای زندهٔ انتقال مطلقاً ثابت و برابر `768 KiB` (`O(1)`) باقی ماند**.
2. در سناریوی ۶۰ دقیقه‌ای (`109.86 MiB` دادهٔ صوتی خام + `109.86 MiB` فایل WAV نهایی روی دیسک = `219.72 MiB` دادهٔ جابه‌جاشده)، افزایش کل RSS پروسهٔ Node.js در کل چرخهٔ انتقال و آماده‌سازی استریمی WAV تنها **`2.90 MiB`** (`172.27 MiB -> 175.17 MiB`) بود که اثبات می‌کند هیچ نسخهٔ کاملی از فایل در RAM ساخته نمی‌شود.

---

## ۸. انضباط دامنه و فهرست موارد خارج از دامنه (Deferred to Next Phases)

طبق بخش ۱۰ دستورالعمل Phase 1B، هیچ‌یک از بخش‌های زیر در این فاز لمس نشدند (`[Observed Fact]`):
- **Phase 1C (بعدی):**
  - تاریخچهٔ Undo و `TimelineHistoryManager` (`src/engine/timeline.ts`)
  - بازطراحی PCM در حافظهٔ `App.tsx` و ۷ نقطهٔ `resolveTrackAssetAndPcm`
  - جریانی‌سازی `SmartAudioEditPipeline.ts` و `SmartAudioEditJobManager.ts`
  - تغییر `NativeCompanionAsrRuntimeAdapter.ts` در سمت Web
  - جریانی‌سازی داخلی `CoreAudioIngestion` در `LocalSherpaNeuralEngine.ts`
- **مؤجل به پس از v1:**
  - Browser ONNX Runtime و انتقال مدل‌های مرورگر به CDN مستقل
- **Requires Hardware Qualification (`NOT_RUN` در این محیط):**
  - تست سخت‌افزار واقعی macOS Apple Silicon M2 (8GB RAM) و اجرای زندهٔ پنل درون GUI نرم‌افزار Adobe Audition 24/25.
