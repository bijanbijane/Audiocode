# سیاست تقسیم بدون نشت داده و محافظت از مجموعه آزمون (Phase 2: Anti-Leakage Split Policy)

**نسخه سند:** `1.0.0-phase2`  
**تاریخ:** ۱۸ نوامبر ۲۰۲۶  
**قانون مطلق:** هیچ گوینده‌ای (`speaker_id`) یا فایل صوتی (`audio_hash`) که در مجموعه `Test` حضور دارد، تحت هیچ شرایطی نباید در `Train` یا `Validation` قرار گیرد.

---

## ۱. اصول تقسیم سه‌گانه (`Train` / `Validation` / `Test`)

برخلاف تقسیم تصادفی فایل‌ها (Random File Split) که باعث حضور صدای یک گوینده واحد در هر دو بخش آموزش و آزمون و ایجاد **دقت کاذب (Speaker Leakage Overfitting)** می‌شود، الگوریتم تقسیم ما (`assignZeroLeakageDatasetSplits`) بر اساس **گروه‌بندی گوینده و منبع (`Speaker-Disjoint & Source-Isolated Partitioning`)** عمل می‌کند:

1. **قفل انحصاری منابع بنچمارک استاندارد در `Test`:**
   - تمامی نمونه‌های متعلق به بنچمارک `PESTE_BENCHMARK` بدون استثنا در مجموعه `test` قرار می‌گیرند.
2. **مسدودسازی منابع دارای مجوز غیرتجاری از ورود به `Train`:**
   - هر نمونه‌ای با مجوز `ACADEMIC_NON_COMMERCIAL` یا `UNKNOWN_RESTRICTED` از ورود به `train` مسدود می‌شود.
3. **تخصیص گسسته گویندگان (`Speaker-Disjoint Hash Bucket`):**
   - برای هر `speaker_id` یکتا، تمام نمونه‌های آن گوینده به‌صورت یک خوشه تفکیک‌ناپذیر (Atomic Speaker Cluster) دسته‌بندی می‌شوند.
   - خوشه‌های گویندگان به نسبت هدف (`70% Train`، `15% Validation`، `15% Test` در دیتاست کامل؛ و تضمین حداقل ۱ خوشه گوینده مجزا در هر بخش در دیتاست‌های کوچک) تخصیص می‌یابند به گونه‌ای که:
     $$\text{Speakers}(\text{Train}) \cap \text{Speakers}(\text{Test}) = \emptyset$$
     $$\text{Speakers}(\text{Validation}) \cap \text{Speakers}(\text{Test}) = \emptyset$$
     $$\text{Speakers}(\text{Train}) \cap \text{Speakers}(\text{Validation}) = \emptyset$$
     $$\text{AudioHashes}(\text{Train}) \cap \text{AudioHashes}(\text{Test}) = \emptyset$$

---

## ۲. قفل رمزنگاری‌شده مجموعه آزمون (`Frozen Test Set Manifest Checksum`)

- پس از تخصیص، لیست مرتب‌شده `sample_id` و `audio_hash` تمامی نمونه‌های مجموعه `test` هش (`SHA-256`) می‌شود (`frozenTestManifestSha256`).
- در فازهای ۳، ۴ و ۵، موتور ارزیابی پیش از شروع هر بنچمارک، این هش را بررسی می‌کند تا اطمینان حاصل شود هیچ نمونه‌ای از مجموعه آزمون دستکاری نشده و هیچ‌یک از هش‌های مجموعه آزمون وارد مجموعه آموزش یا پرامپت نشده است.
