# ممیزی ذخیره‌سازی، قفل‌ها و بازیابی کرش (AVP-P00-001 — Storage & Recovery Audit)

**مأموریت:** `AVP-P00-001`  
**فایل‌های بررسی‌شده:** `src/engine/storageBroker.ts`, `src/engine/lruCache.ts`, `src/workers/ioBroker.worker.ts`, `src/runtime/CrashRecoveryAndSessionLock.ts`, `packages/audio-runtime/src/DirectStudioOpfsRecorder.ts`, `src/project-core/*`.

---

## ۱. چک‌لیست ۱۲گانه واقعیت ذخیره‌سازی و بازیابی (`[OBSERVED]`)

| مورد ممیزی | وضعیت واقعی در کد | شواهد خط و فایل |
| --- | --- | --- |
| **۱. دسترسی OPFS** | **پیاده‌سازی‌شده و محدود به Worker / Bootstrapper** | `ioBroker.worker.ts:21-29` دسترسی را پروب می‌کند؛ `CrashRecoveryAndSessionLock.ts:21` دایرکتوری `recovery-journal` می‌سازد؛ `DirectStudioOpfsRecorder.ts:103` دایرکتوری `live-studio-recordings` می‌سازد |
| **۲. استفاده از IndexedDB** | **موجود نیست (۰ استفاده)** | هیچ فراخوانی `indexedDB` در `src/` یا `packages/` وجود ندارد. تمام متادیتا یا در RAM/React State است یا به‌صورت فایل JSON در OPFS نوشته می‌شود |
| **۳. اعمال سقف کش (`RollingLruBlockCache`)** | **موجود در کلاس، ولی معیوب در پیکربندی `App.tsx`** | `lruCache.ts:65-75` به‌درستی با حلقه `while (this.usedBytes + byteSize > this.maxBytes)` قدیمی‌ترین کلید `Map` را حذف می‌کند؛ اما `App.tsx:208` آن را با `8 MiB` مقداردهی کرده درحالی‌که telemetry اولیه `32 MiB` نشان می‌دهد (`App.tsx:175`) و هیچ صوت آپلودشده‌ای وارد آن نمی‌شود! |
| **۴. حذف LRU (Eviction)** | **تست‌شده روی بلوک‌های تستی** | در `lruCache.test.ts` و دکمه آزمایشی `handleSimulateLruCacheFill` (`App.tsx:1642`) کار می‌کند |
| **۵. مالکیت اجاره (`Lease Ownership`)** | **شبیه‌سازی/ساختار منطقی در Worker** | `ioBroker.worker.ts` و `storageBroker.ts` قفل‌های منطقی (`simulateConcurrentLockBrokerTest`) را مدیریت می‌کنند؛ اما قفل واقعی برای خواندن/نوشتن بلوک‌های پروژه در جریان کار کاربر استفاده نمی‌شود |
| **۶. رفتار قفل چندتبه (`Web Locks`)** | **پیاده‌سازی واقعی با Ref-Counting درون-تبی** | `CrashRecoveryAndSessionLock.ts:71-142` قفل انحصاری `project_edit_lock_{projectId}` با `{ ifAvailable: true }` می‌گیرد و از رقابت در همان تب با `sameTabHeldLocks` جلوگیری می‌کند |
| **۷. بازیابی تراکنش (`Transaction Recovery`)** | **موجود در دو نسخه موازی** | `TimelineHistoryManager` (`timeline.ts`, متصل به `App.tsx`) در RAM و `TimelineTransactionEngine` (`project-core/`, غیرمتصل به `App.tsx`) با `structuredClone` کار می‌کنند؛ هیچ‌کدام به دیسک persist نمی‌شوند مگر از طریق `CrashRecoveryAndSessionLock` |
| **۸. دوام Checkpoint (`Checkpoint Durability`)** | **فقط چک خواندن در استارتاپ، بدون نوشتن خودکار در ویرایش** | `StudioRootBootstrapper.tsx:224` متد `checkCrashRecovery()` را هنگام بالا آمدن صدا می‌زند؛ اما جستجو در `src/App.tsx` نشان می‌دهد `writeRecoveryCheckpoint()` هنگام تغییرات یا برش‌های کاربر در `App.tsx` فراخوانی نمی‌شود! (`[OBSERVED]`) |
| **۹. بازیابی کار ناتمام (`Interrupted-Job Recovery`)** | **در پشته ASR غیرمتصل وجود دارد** | `ResilientAiRuntime.ts:95` (`executeChunkedJobWithCheckpoint`) و `PersianChunkedAsrWorker.ts:37` (`onWindowCheckpoint`) از سرگیری از پنجره ناتمام را دارند، اما به `App.tsx` متصل نیستند |
| **۱۰. کش مدل‌ها (`Model Caching`)** | **منطقی و جداگانه در مسیر `ai-models/` OPFS** | `WebWorkerOrtRuntimeProvider.ts:144` دایرکتوری `ai-models/{id}_{version}/` را می‌خواند و `ChunkedModelDelivery.ts` آن را می‌نویسد |
| **۱۱. کش بلوک صوت (`Audio Block Caching`)** | **در مسیر Upload/Playback `App.tsx` استفاده نمی‌شود** | صوت آپلودشده اصلاً به OPFS نوشته نمی‌شود و `pcmSources` در RAM می‌ماند |
| **۱۲. رفتار تمام‌شدن سهمیه دیسک (`Quota Exhaustion`)** | **فقط خواندن `estimate()`, بدون هندلر `QuotaExceededError`** | `storageBroker.ts:68` سهمیه را گزارش می‌دهد؛ اما `ioBroker.worker.ts` در `QuotaExceededError` استراتژی پاکسازی اضطراری بلوک‌های یتیم یا نمایش هشدار قابل اقدام ندارد |

---

## ۲. تفکیک بودجه فایل‌های مدل از فایل‌های صوتی کاربر (`[OBSERVED]`)

- **ساختار دیسک OPFS:**
  - مدل‌های AI: مسیر `OPFS/ai-models/{modelId}_{version}/` (`WebWorkerOrtRuntimeProvider.ts:144`)
  - فایل‌های صوت و ضبط کاربر: مسیر `OPFS/live-studio-recordings/` (`DirectStudioOpfsRecorder.ts:103`) و کلیدهای بلاک در `ioBroker.worker.ts`
  - ژورنال بازیابی کرش: `OPFS/recovery-journal/` (`CrashRecoveryAndSessionLock.ts:22`)
- **نقص فعلی:** هنوز هیچ **Quota Partitioning Manager** وجود ندارد که اندازه `ai-models/` و `live-studio-recordings/` را جداگانه حسابرسی کند و هنگام پرشدن دیسک، بلوک‌های صوت موقت (مورد نیاز برای Undo قدیمی یا پروژه‌های بسته) را بدون پاک‌کردن مدل‌های دانلودشده آزاد کند.
- **نکته حیاتی:** **OPFS معادل RAM نیست، اما کپی‌های موقت از OPFS به RAM (از طریق `await file.arrayBuffer()`) اگر به‌درستی آزاد یا قطعه‌بندی نشوند، مستقیم مصرف RAM را بالا می‌برند** (مثلاً `assembleModelBytesFromOpfsChunks` در `WebWorkerOrtRuntimeProvider.ts:150` کل مدل را یکجا در یک `Uint8Array` در RAM جمع می‌کند).
