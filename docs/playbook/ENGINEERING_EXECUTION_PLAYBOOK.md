# کتابچه عملیاتی روز اول تا روز سی‌ام (Engineering Execution Playbook · بخش ۳۳)

این سند نقشه اجرایی ۴ هفته‌ای تیم فنی برای استقرار، اجرای آزمایش‌های PoC و قفل‌کردن دروازه‌های کیفیت معماری مرجع نسخه ۱.۲ است.

---

## هفته اول: زیرساخت پایه، هسته WASM و PoC شماره ۱ و ۲ (موتور صوتی و OPFS)

1. **آماده‌سازی محیط توسعه و ایزوله‌سازی مرورگر:**
   - اطمینان از فعال بودن هدرهای `Cross-Origin-Opener-Policy: same-origin` و `Cross-Origin-Embedder-Policy` در `vite.config.ts` و `server.ts` (و در تولید از طریق `deploy/nginx/nginx.conf`).
   - بررسی سلامت مجوزهای تجاری Rust در `wasm-audio-core/deny.toml` با `cargo deny check`.
   - کامپایل هسته صوتی `wasm-audio-core/src/lib.rs` با `wasm-pack build wasm-audio-core --target web --release`.
2. **اجرای تست استرس فایل ۲ ساعته (PoC #1 & #2):**
   - بارگذاری یک فایل پادکست فارسی ۲ ساعته (`48kHz Stereo`).
   - ثبت معیارهای قبولی کمی (`SPEC-02` و `SPEC-03`):
     - سقف مصرف RAM زیر `150 MB`.
     - سقف کش چرخشی OPFS در `256 MB` (`StorageBroker`).
     - مقدار `UNDERRUN_COUNT === 0` در `SharedAudioRingBuffer` حین اسکرول ۶۰ فریم بر ثانیه `LodWaveformCanvasRenderer`.
     - نبود خطای `NoModificationAllowedError` در `src/workers/ioBroker.worker.ts`.

---

## هفته دوم: موتور هوش مصنوعی فارسی و تراز آوایی برش (PoC #3)

1. **آماده‌سازی دیتاست بنچمارک گفتار فارسی:**
   - گردآوری حداقل ۲۰ نمونه صوتی شامل پادکست محاوره‌ای، مصاحبه دو نفره، گویندگی کتاب صوتی، تپق‌های مستقل («اممم»، «ااا»)، تپق‌های چسبیده («رفتیمممم») و عبارات دارای کسره اضافه.
2. **اجرای خط لوله پردازش گفتار فارسی:**
   - کاهش نرخ نمونه ضد-آلیاسینگ با `src/ai-engine/AntiAliasedResampler.ts` به `16kHz Mono`.
   - پردازش پنجره‌ای با همپوشانی ۳ ثانیه‌ای در `src/ai-engine/PersianChunkedAsrWorker.ts`.
   - نرمال‌سازی سه‌لایه (`src/ai-engine/PersianTextNormalizer.ts`)، تشخیص تپق و تکرار (`src/ai-engine/PersianDisfluencyEngine.ts`) و تراز دقیق نقطه صفر (`src/audio-engine/PersianAcousticSnapper.ts`).
3. **ارزیابی کمی و تست شنیداری کور:**
   - محاسبه Normalized WER از طریق `AutomatedQualityGateRunner.computePersianWER`.
   - ارزیابی ۵۰ برش خودکار توسط ۳ تدوینگر انسانی جهت تایید حذف کلیک صوتی و طبیعی بودن تزریق `Room Tone`.

---

## هفته سوم: شبکه ناپایدار، موبایل و تاب‌آوری GPU (PoC #4)

1. **آزمون دانلود بلوکی مدل‌ها (۸ مگابایتی با Resume):**
   - تست سروینگ از `location /models/` در `deploy/nginx/nginx.conf` با `Accept-Ranges: bytes` و مانیفست امضاشده با Ed25519 در `backend/src/PlatformLicenseService.ts`.
   - قطع و وصل شبکه در ۵۰٪ دانلود برای تایید ادامه از آخرین قطعه سالم در `src/runtime/ChunkedModelDownloader.ts` بدون دریافت تکراری.
2. **آزمون سخت‌افزاری کلاینت و بازیابی GPU:**
   - اجرای `src/runtime/HardwareBenchmarkProfiler.ts` برای کالیبراسیون واقعی RTF و آستانه مدت فایل روی موبایل/تبلت/دسکتاپ.
   - شبیه‌سازی رخداد `GPUDevice.lost` در `src/runtime/ResilientAiRuntime.ts` برای تایید سوئیچ بدون توقف به `WASM_SIMD` روی آخرین Checkpoint.

---

## هفته چهارم: قفل کردن اسناد مرجع و یکپارچه‌سازی Vertical Slice

1. **تولید گزارش رسمی PoC و قفل کیفیت انتشار:**
   - اجرای دروازه کیفیت خودکار (`src/quality-gate/AutomatedQualityGateRunner.ts`) و ممیزی رشته‌های وابستگی با پایپلاین `.github/workflows/ci-quality-gate.yml`.
2. **یکپارچه‌سازی کامل مسیر End-to-End:**
   - اتصال `VerticalSliceOrchestrator`، `TimelineTransactionEngine`، `ProcessingGraphEngine`، `AudioRestorationEngine`، `LoudnessAndMasteringEngine` و `StreamingExportEncoder` به محیط کار `PersianTranscriptWorkspace.tsx`.
   - تایید بیلد کانتینری غیرریشه با `deploy/Dockerfile` و بررسی فعال بودن `self.crossOriginIsolated === true` در مرورگر تولیدی.
