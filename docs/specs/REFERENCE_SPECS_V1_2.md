# مشخصات مرجع رسمی پلتفرم آواپرداز (SPEC-01 تا SPEC-10 — نسخه ۱.۲)

این سند طبق قوانین بخش ۶۷ و ۶۹ سند معماری مرجع تدوین شده و بر دو اصل استوار است:
1. **قانون مالکیت واحد (Single Source of Truth):** هر مفهوم فنی تنها در یک سند مرجع تعریف می‌شود و سایر ماژول‌ها با شناسه یکتا به سند مالک ارجاع می‌دهند.
2. **قانون آزمون‌پذیری:** هیچ الزامی بدون معیار پذیرش عددی و کمی (Quantitative Acceptance Criterion) معتبر نیست.

---

## ماتریس مالکیت انحصاری مفاهیم (Single Source of Truth Matrix)

| شناسه | عنوان رسمی سند مرجع | مفاهیم تحت مالکیت انحصاری | ماژول‌های متناظر در مخزن فعلی |
| :--- | :--- | :--- | :--- |
| **`SPEC-01`** | Platform Architecture Specification | مرز ۸ حوزه، ساختار Modular Monolith، زنجیره سیاست اجرا، چرخه بلوغ قابلیت‌ها (`Stage`) | `src/core/VerticalSliceOrchestrator.ts`, `src/project-core/ReleaseAndFeatureMaturityManager.ts` |
| **`SPEC-02`** | Project & Asset Specification | هویت Asset، جدول `SeekTable`، هرم `PeakPyramid`، کش چرخشی LRU، بازیابی رسانه گمشده، مهاجرت ۴بعدی، حذف گرانولار | `src/contracts/project-schema.contract.ts`, `src/project-core/ProjectLifecycleAndMigrationEngine.ts`, `src/project-core/GranularDataDeletionManager.ts` |
| **`SPEC-03`** | Timeline & Non-Destructive Editing Spec | مرجع زمانی `Flicks` (`705,600,000 Hz`)، بازه نیمه‌باز `[start, end)`، تراکنش Undo/Redo، ادغام Gesture، قفل سینک چندترک | `src/contracts/timebase.contract.ts`, `src/project-core/TimelineTransactionEngine.ts` |
| **`SPEC-04`** | Audio Runtime Specification | دیکد جریانی `Symphonia`، بافر حلقوی `SharedArrayBuffer`، کلاک `AudioWorklet`، تبدیل نرخ نمونه ضد Aliasing | `src/audio-engine/SharedRingBuffer.ts`, `src/audio-engine/playback.worklet.ts`, `src/ai-engine/AntiAliasedResampler.ts`, `wasm-audio-core/src/lib.rs` |
| **`SPEC-05`** | Processing Graph & Render Spec | گراف DAG، جبران تأخیر خودکار (`Automatic PDC`)، تغذیه `Pre-Roll`، استاندارد `LUFS / True Peak`، اعتبارسنجی Export | `src/processing-core/ProcessingGraphEngine.ts`, `src/audio-engine/LoudnessAndMasteringEngine.ts`, `src/processing-core/ExportValidator.ts` |
| **`SPEC-06`** | Internal AI Runtime Spec | چرخه عمر مدل، بارگذاری Zero-Copy، اجرای پنجره‌ای هم‌پوشان، توزیع قطعه‌قطعه، تفکیک گویندگان و تشخیص Bleed | `src/ai-engine/PersianChunkedAsrWorker.ts`, `src/platform/ChunkedModelDelivery.ts`, `src/runtime/ResilientAiRuntime.ts`, `src/ai-engine/MultiSpeakerDiarizationAndCrosstalkEngine.ts` |
| **`SPEC-07`** | Persian Speech Editing Spec | نرمال‌سازی ۳ لایه فارسی، تراز دره انرژی، تشخیص تپق کشیده، حفاظت کسره اضافه، الگوریتم `Reparandum/Repair`، تزریق Room Tone | `src/ai-engine/PersianTextNormalizer.ts`, `src/audio-engine/PersianAcousticSnapper.ts`, `src/ai-engine/PersianDisfluencyEngine.ts` |
| **`SPEC-08`** | Execution & Runtime Infrastructure Spec | هدرهای `COOP/COEP`، کارگزار انحصاری `OPFS I/O Broker`، بودجه RAM/Disk، قفل `Web Locks`، بازیابی از کرش | `src/workers/ioBroker.worker.ts`, `src/runtime/CrashRecoveryAndSessionLock.ts`, `vite.config.ts`, `server.ts` |
| **`SPEC-09`** | External API & Privacy Governance Spec | ۱۰ قانون استقلال از API خارجی، رضایت مستقل، برآورد هزینه، پاک‌سازی Telemetry، لایسنس آفلاین `Ed25519` | `src/ai-engine/ExternalApiGovernanceGateway.ts`, `src/security/AudioSecurityGuard.ts`, `src/security/OfflineCryptoVerifier.ts`, `backend/src/PlatformLicenseService.ts` |
| **`SPEC-10`** | Testing, Benchmark & Quality Spec | چارچوب ارزیابی گفتار فارسی (`WER`)، کاتالوگ ۱۰ دسته خطا، دروازه‌های کیفیت انتشار | `src/quality-gate/AutomatedQualityGateRunner.ts`, `src/contracts/PlatformErrorCatalog.ts` |

---

## خلاصه معیارهای پذیرش کمی (Quantitative Acceptance Criteria)

- **SPEC-01:** `AC-01.1` صفر وابستگی چرخه‌ای یا معکوس از هسته به لایه UI؛ `AC-01.2` عملکرد ۱۰۰٪ آفلاین حوزه‌های ۱ تا ۶ پس از نصب مدل.
- **SPEC-02:** `AC-02.1` تطبیق `HASH_VERIFIED` فایل ۵۰۰MB تغییرنام‌یافته زیر `800 ms`؛ `AC-02.2` رعایت سقف کش `256 MB`؛ `AC-02.3` دست‌نخورده ماندن فایل مبدأ در شکست Migration.
- **SPEC-03:** `AC-03.1` خطای `0` نمونه در تبدیل ۱۰ ساعته بین `16k/44.1k/48k`؛ `AC-03.2` ادغام ۳۰۰ فریم Gesture در دقیقاً `1` تراکنش Undo.
- **SPEC-04:** `AC-04.1` زمان اجرای `process()` صدک ۹۹ام زیر `0.40 ms`؛ `AC-04.2` مقدار `UNDERRUN_COUNT = 0`.
- **SPEC-05:** `AC-05.1` خطای فاز `0` نمونه پس از Automatic PDC؛ `AC-05.2` مسترینگ روی `-16.0 ± 0.3 LUFS`، پیک واقعی حداکثر `-1.0 dBTP` و `0` نمونه Clipping.
- **SPEC-06:** `AC-06.1` ادامه دانلود قطعه ۸MB با `0` بایت تکرار؛ `AC-06.2` بازیابی از `GPUDevice.lost` به `WASM_SIMD` زیر `500 ms`.
- **SPEC-07:** `AC-07.1` بیشینه جهش دامنه اتصال (`Step Delta < 0.05`)؛ `AC-07.2` دقت بالای `90%` در حفظ بخش سالم `Repair` و حذف `Reparandum + Interregnum`.
- **SPEC-08:** `AC-08.1` صفر خطای `NoModificationAllowedError` در I/O هم‌زمان؛ `AC-08.2` بازیابی ژورنال کرش زیر `300 ms`.
- **SPEC-09:** `AC-09.1` رد ۱۰۰٪ دستکاری توکن لایسنس با `Ed25519`؛ `AC-09.2` حفظ دسترسی خواندن و Export پروژه (`GROUP_A`) پس از انقضای اشتراک.
- **SPEC-10:** `AC-10.1` توقف انتشار (Block) در صورت شکست هر یک از ۴ دروازه کیفیت.
