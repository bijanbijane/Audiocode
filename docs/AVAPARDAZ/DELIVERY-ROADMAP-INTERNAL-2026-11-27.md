# AVAPARDAZ — Internal Delivery Roadmap

> Approved scope: Adobe Audition + Native Companion + shared Core | Release: Internal | Platforms: macOS + Windows

> Source of truth: Notion roadmap section 12, revision AVP-DELIVERY-ROADMAP-1.1. This file mirrors the approved scope and delivery plan; it does not imply that any phase has started or passed.

## 12. رودمپ نهایی مصوب — Audition / Internal / macOS + Windows

**شناسه بازنگری:** AVP-DELIVERY-ROADMAP-1.1
**تاریخ تصمیم:** 2026-11-27
**وضعیت:** دامنه و جهت انتشار توسط مالک پروژه تعیین شده؛ برنامه‌ریزی‌شده و هنوز شروع یا پذیرش اجرایی هیچ مرحله‌ای را نشان نمی‌دهد.

### 12.1 تصمیم‌های تثبیت‌شده

| محور | تصمیم نهایی | پیامد اجرایی |
| --- | --- | --- |
| دامنه محصول | Adobe Audition + Native Companion + Core مشترک | فقط محصول Audition در دامنه این نسخه است؛ Web Studio جزو تحویل v1 نیست. |
| هدف انتشار | Internal Release | معیارها برای نسخه داخلی قابل نصب و قابل استفاده‌اند؛ انتشار عمومی/تجاری، پرداخت و توزیع عمومی خارج از دامنه است. |
| پلتفرم | هر دو: macOS و Windows | هر دو سیستم‌عامل باید در معیارهای پذیرش، CI، نصب، تست میزبان و پشتیبانی داخلی پوشش داده شوند؛ هیچ‌کدام صرفاً best-effort نیست. |

این تصمیم‌ها مبنای برنامه اجرایی هستند و بخش‌های قبلی سند را از نظر تاریخی حذف نمی‌کنند. هر تعارض دامنه‌ای در بخش‌های قبلی با این تصمیم مصوب برای برنامه جاری حل می‌شود؛ تاریخچه و نقد Red-Team حفظ می‌شود.

### 12.2 تعریف محصول هدف

تحویل نهایی این رودمپ یک گردش‌کار داخلی Audition است که در آن:

1. افزونه Audition به Native Companion محلی و امن متصل می‌شود.
2. کاربر صوت/انتخاب معتبر را از میزبان به جریان پردازش می‌دهد؛ مسیر انتقال برای فایل بلند bounded-memory است.
3. transcript فارسی/انگلیسی با بیان صادقانه سطح دقت زمانی تولید می‌شود.
4. پیشنهادهای Smart Speech Editing بر پایه timing معتبر و EDL غیرمخرب ارائه می‌شوند.
5. کاربر پیش‌نمایش و تأیید انسانی دارد و می‌تواند تغییرات را رد، اصلاح، Undo و Redo کند.
6. رندر نهایی از EDL و در سطح sample index انجام می‌شود.
7. خروجی یا مسیر writeback/interchange در Audition واقعی بررسی می‌شود و قطع ارتباط، خطا یا restart موجب تخریب منبع یا از دست‌رفتن وضعیت پروژه نمی‌شود.
8. همین گردش‌کار روی macOS و Windows در ماتریس نسخه‌های هدف تأیید می‌شود.

### 12.3 موارد خارج از دامنه این تحویل

- Web Studio مستقل و مسیر Browser/WASM/OPFS؛ به Post-v1 منتقل می‌شود و فقط با تصمیم دامنه‌ای جداگانه بازمی‌گردد.
- انتشار عمومی یا تجاری، پرداخت، سیستم صدور مجوز تجاری و توزیع عمومی مدل/CDN.
- پشتیبانی از تمام نسخه‌های Audition، تمام سیستم‌عامل‌ها یا تمام فرمت‌های صوتی؛ فقط ماتریس هدفی که در R0 تصویب می‌شود.
- حذف خودکار بدون تأیید کاربر.
- افزودن مدل ASR جدید بدون benchmark مستقل که شکاف واقعی مدل فعلی را اثبات کند.
- ادعای word-level timing تا عبور از اعتبارسنجی انسانی و آستانه خطای مصوب.

### 12.4 مراحل اجرا

#### R0 — Baseline، دامنه و دروازه‌های دوپلتفرمی

**هدف:** قبل از توسعه، واقعیت HEAD، تعارض اسناد، کارهای انجام‌شده و موانع ادامه کار را روشن کنیم.

کارها:

- ثبت SHA دقیق main، وضعیت branch/working tree، تاریخ ممیزی و نسخه ابزارها.
- تطبیق اسناد authoritative، Master Roadmap، Decision Log، PHASE-15 و گزارش SHAHAB؛ ثبت یک ماتریس قابلیت با دو ستون مستقل Capability Status و Evidence Status.
- استخراج و تعیین وضعیت هر پنج پیش‌نیاز بیرونی اشاره‌شده برای ادامه چرخه پس از ADR-026؛ هر مورد باید مالک، مدرک، اثر بر دامنه و وضعیت BLOCKED/OPEN/CLOSED داشته باشد. هیچ موردی با حدس بسته نشود.
- تعیین ماتریس دقیق Audition، نسخه macOS و Windows، معماری CPU، حداقل RAM، فرمت‌های ورودی/خروجی و روش نصب داخلی.
- inventory واقعی تست‌ها و CI scripts؛ اجرای baseline فقط با ثبت فرمان، محیط، exit code و artifact.
- بررسی گزارش SHAHAB برای جلوگیری از بازتوسعه مواردی که ظاهراً پیاده شده‌اند؛ هر ادعای implementation جداگانه به تست/شواهد وصل شود.
- شروع مصاحبه و مشاهده workflow با تدوین‌گران داخلی؛ این کار منتظر پایان توسعه نمی‌ماند.

معیار خروج:

- دامنه Audition-only / Internal / macOS+Windows در یک تصمیم ثبت شده باشد.
- پنج پیش‌نیاز بیرونی تعیین تکلیف مستند داشته باشند؛ موارد حل‌نشده صریحاً BLOCKED بمانند.
- ماتریس نسخه‌ها و سخت‌افزار هدف تصویب شده باشد.
- baseline قابل تکرار و فهرست P0/P1/P2 با مالک یا TBD ثبت شده باشد.
- هیچ قابلیت صرفاً به‌دلیل وجود کد یا mock، VERIFIED اعلام نشده باشد.

#### R1 — ممیزی شکاف و اثبات پایداری Core

**هدف:** فقط شکاف‌های واقعی قرارداد، orchestration و مدیریت حافظه را رفع کنیم؛ نه بازنویسی از صفر.

کارها:

- ممیزی AudioSourceHandle، range reader، file-backed transport، chunked staging، cancellation، cleanup، Job lifecycle، source hash و قراردادهای Transcript/EDL/Render Artifact.
- ردیابی تمام مسیرهای تولیدی Audition تا Resolver/Orchestrator؛ شناسایی bypass و legacy PCM/Base64.
- آزمون فایل‌های 10، 30، 60 و 120 دقیقه‌ای mono/stereo روی macOS و Windows در حداقل سخت‌افزار هدف.
- اندازه‌گیری peak RSS، heap، temporary disk، retained bytes، cancellation latency و recovery پس از crash.
- آزمون موفقیت، خطا، cancel، قطع Companion، restart و پاک‌سازی فایل‌های موقت.

معیار خروج:

- حد حافظه و فضای موقت پیش از آزمون تعریف و روی هر دو سیستم‌عامل سنجیده شده باشد.
- رشد RAM با مدت فایل متناسب نباشد و سقف‌های مصوب پاس شوند.
- فایل موقت یتیم پس از سناریوهای آزمون باقی نماند.
- مسیرهای legacy پرخطر حذف یا محدود و استثناهای باقی‌مانده مستند شده باشند.
- بازیابی Job و آزادسازی منابع با تست قابل تکرار اثبات شود.

#### R2 — کیفیت ASR و اعتبارسنجی Alignment فارسی/انگلیسی

**هدف:** کیفیت گفتار و timing را با داده مستقل و قابل ممیزی بسنجیم.

کارها:

- pin کردن مدل، revision، hash، license، runtime و manifest مدل‌های مورد استفاده در Native Companion.
- بازتولید benchmark FLEURS با پروتکل ثابت و ثبت خروجی خام؛ نتایج FLEURS از گفتار طبیعی تعمیم داده نشود.
- ایجاد corpus مجاز و رضایت‌محور مکالمه فارسی/انگلیسی شامل لهجه، نویز، تپق، تکرار و code-switching با split مستقل بر اساس speaker.
- ارزیابی جداگانه WER/CER خام و نرمال‌شده، نرخ خطای runtime، latency و مصرف حافظه روی macOS و Windows.
- تعیین وضعیت واقعی SHAHAB-025: مستندات معماری، کد اجراشده، اتصال محصول و ارزیابی انسانی چهار ادعای جدا هستند.
- مقایسه forced aligner با TextGrid انسانی و گزارش پوشش و خطای P50/P90/P95 برای start و end کلمات.

معیار خروج:

- benchmark مستقل، speaker-independent و قابل بازتولید باشد.
- برای هر پلتفرم نتایج و محدودیت‌های مدل مشخص باشند.
- تا پیش از عبور alignment از آستانه از پیش مصوب، محصول فقط segment-level timing را ادعا کند.
- timestamp نامعتبر یا نامطمئن هرگز ورودی اجرای خودکار edit نباشد.

#### R3 — Smart Speech Editing با کنترل انسانی

**هدف:** پیشنهادهای تدوین قابل توضیح، برگشت‌پذیر و غیرمخرب ارائه شود.

کارها:

- taxonomy و سیاست جداگانه برای pause، filler، stutter، repetition، false start، breath و noise.
- اتصال هر پیشنهاد به source hash، transcript revision، sample range، timing validity و دلیل پیشنهاد.
- EDL نسخه‌دار و غیرمخرب؛ منبع اصلی immutable بماند.
- رابط accept/reject/modify، preview، Undo/Redo و ثبت تصمیم کاربر در Audition.
- محافظت از نفی، عدد، نام، واژه حساس معنایی و code-switching؛ موارد مبهم به کاربر ارجاع شوند.
- invalidation پیشنهادها پس از تغییر source hash، transcript یا sample rate.

معیار خروج:

- هر edit دارای provenance کامل و قابل ممیزی باشد.
- هیچ edit مبهم یا meaning-critical بدون تأیید صریح کاربر اعمال نشود.
- round-trip پروژه، EDL و Undo/Redo روی هر دو سیستم‌عامل یکسان و قابل تکرار باشد.
- تست adversarial برای مرز chunk، overlap، گفتار سریع و موارد حساس پاس شود.

#### R4 — Precision Renderer و صحت خروجی

**هدف:** اجرای قطعی EDL با دقت sample و خروجی قابل بازخوانی.

کارها:

- تعریف قرارداد sample rate، channel layout، sample format، integer sample ranges، fades و silence.
- اجرای streaming render و حذف readback کامل خروجی به RAM.
- تست مرز برش، click، gap، overlap، phase، channel mapping و clipping.
- پوشش فرمت‌های واقعاً داخل ماتریس R0؛ decode-back و مقایسه با مرجع.
- تطبیق preview با render artifact و atomic finalize.

معیار خروج:

- آزمون sample-exact برای EDLهای مرجع پاس شود.
- هیچ اختلاف ناخواسته بین preview و خروجی نهایی وجود نداشته باشد.
- فایل خروجی در هر دو پلتفرم decode و در Audition باز شود.
- حافظه رندر bounded باشد و فایل ناقص به‌عنوان خروجی موفق گزارش نشود.

#### R5 — یکپارچه‌سازی محصول در Adobe Audition

**هدف:** تحویل workflow کامل در میزبان واقعی، نه صرفاً تست مستقل موتور یا mock.

کارها:

- تثبیت ماتریس نسخه‌های Audition و APIهای واقعاً پشتیبانی‌شده Host.
- نصب افزونه و Native Companion روی دستگاه تمیز macOS و Windows.
- اتصال/قطع/اتصال مجدد، انتخاب کلیپ/بازه، انتقال صوت، نمایش transcript و پیشنهادها، preview، apply/cancel، marker یا interchange/writeback.
- بررسی lifecycle پنل، مجوزهای فایل، مسیرها، encoding، تفاوت‌های OS و رفتار crash/restart.
- تست پروژه‌های کوچک و بلند و بازگشایی session پس از restart.

معیار خروج:

- گردش‌کار انتها‌به‌انتها در Audition واقعی و روی هر دو سیستم‌عامل اجرا شود.
- نصب تمیز، اتصال Companion، پردازش، preview، apply، Undo/Redo، ذخیره و recovery مستند و تکرارپذیر باشد.
- هیچ mock یا شبیه‌ساز به‌جای تأیید Host واقعی شمرده نشود.
- شکست Host/Companion به فایل منبع یا پروژه آسیب نزند.

#### R6 — بسته‌بندی و تضمین انتشار داخلی

**هدف:** نسخه داخلی امن، قابل نصب، قابل به‌روزرسانی و قابل بازگشت تولید شود.

کارها:

- threat model، ممیزی dependency و سیاست رسیدگی به آسیب‌پذیری با تعیین reachability، شدت، مالک استثنا و تاریخ انقضا.
- تفکیک CI به PR، nightly و release؛ تست‌های سریع در PR و آزمون‌های سنگین در nightly/release.
- تولید SBOM، provenance و artifactهای نسخه‌دار؛ ثبت hash و امضای artifactها متناسب با کانال داخلی.
- installer و فرایند install/upgrade/rollback/uninstall برای macOS و Windows.
- مستندات نصب، محدودیت‌ها، عیب‌یابی، جمع‌آوری log با حفظ حریم خصوصی و روش گزارش خطا.
- تعیین کانال توزیع داخلی و کنترل دسترسی؛ پرداخت، مجوز تجاری و انتشار عمومی در این مرحله ساخته نمی‌شوند.

معیار خروج:

- نصب و حذف روی دستگاه تمیز هر دو سیستم‌عامل موفق باشد.
- ارتقا و rollback آزموده شده باشد.
- artifactهای داخلی نسخه‌دار، hash-دار و قابل انتساب به commit باشند.
- آسیب‌پذیری‌های release-blocking بسته یا دارای استثنای مصوب، مالک و تاریخ انقضا باشند.

#### R7 — Internal Pilot و تصمیم پذیرش

**هدف:** اعتبارسنجی محصول با تدوین‌گران داخلی و تصمیم مبتنی بر داده برای پذیرش نسخه داخلی.

کارها:

- انتخاب cohort محدود از کاربران داخلی و سناریوهای نماینده.
- ثبت task success، correction rate، time-to-edit، export defects، crash rate، install success و تعداد مداخلات پشتیبانی.
- ثبت خطاها با شدت، قابلیت بازتولید، پلتفرم، نسخه Audition و شناسه artifact.
- triage و اصلاح blockerها؛ اجرای مجدد regression روی هر دو پلتفرم.
- صدور تصمیم مستقل برای Internal Release: ACCEPTED، ACCEPTED WITH RESTRICTIONS یا BLOCKED.

معیار خروج:

- اهداف عددی و denominatorها قبل از pilot ثبت شده باشند.
- هیچ blocker بحرانی باز نمانده باشد؛ محدودیت‌های پذیرفته‌شده مستند باشند.
- شواهد macOS و Windows جداگانه موجود و قابل ردیابی باشند.
- رأی انتشار داخلی با artifact مشخص، commit، گزارش تست و فهرست محدودیت‌ها ثبت شود.

### 12.5 وابستگی و مسیر بحرانی

- R0 پیش‌نیاز شروع توسعه دامنه‌دار است.
- پس از R0، R1 و R2 می‌توانند موازی پیش بروند؛ R5 نیز می‌تواند ممیزی Host و نصب اولیه را موازی آغاز کند.
- R3 به R1 و timing معتبر از R2 وابسته است.
- R4 می‌تواند قرارداد و harness خود را زودتر آماده کند، اما پذیرش نهایی آن به EDL تثبیت‌شده در R3 وابسته است.
- R5 برای پذیرش workflow کامل به R1، R3 و R4 وابسته است.
- R6 از R0 به‌صورت تدریجی اجرا می‌شود؛ gate انتشار آن پس از تثبیت artifact محصول و ماتریس پلتفرم است.
- R7 pilot را پس از عبور از gateهای محصول و بسته‌بندی آغاز می‌کند؛ user research از R0 ادامه دارد.

### 12.6 Gateهای تصمیم

| Gate | شرط عبور |
| --- | --- |
| G0 — Scope & Baseline | دامنه مصوب، پنج پیش‌نیاز تعیین‌تکلیف‌شده، ماتریس پلتفرم و baseline مستند |
| G1 — Core Reliability | bounded-memory، cancellation، cleanup و recovery روی macOS و Windows |
| G2 — Speech Evidence | ASR مستقل و timing با ground truth؛ محدودیت segment/word-level شفاف |
| G3 — Editing Safety | EDL غیرمخرب، timing معتبر، تأیید انسانی و Undo/Redo |
| G4 — Render Integrity | sample-accurate، decode-back و خروجی سالم |
| G5 — Audition Workflow | گردش‌کار واقعی انتها‌به‌انتها در نسخه‌های هدف Audition روی هر دو OS |
| G6 — Internal Distribution | نصب، upgrade، rollback، uninstall، امنیت و artifact قابل ردیابی |
| G7 — Internal Acceptance | pilot و معیارهای کمی پاس‌شده یا محدودیت‌ها رسماً پذیرفته‌شده |

### 12.7 قواعد مدیریت وضعیت و شواهد

دو محور وضعیت مستقل نگهداری شود:

- **Capability:** NOT_IMPLEMENTED / PARTIAL / IMPLEMENTED / DEPRECATED
- **Evidence:** NOT_TESTED / TESTED / VERIFIED / ACCEPTED

تعریف‌ها:

- IMPLEMENTED یعنی کد/قابلیت وجود دارد؛ به‌تنهایی اثبات عملکرد نیست.
- TESTED یعنی آزمون مشخص اجرا شده و نتیجه ثبت شده است.
- VERIFIED یعنی شواهد کافی، قابل تکرار و متناسب با ادعا وجود دارد.
- ACCEPTED یعنی معیار پذیرش محصول و محدودیت‌های آن توسط مالک پروژه تأیید شده است.

برای هر deliverable این فیلدها ثبت شوند: شناسه، هدف، مسیرهای GitHub، مالک (در نبود تعیین مالک: TBD)، dependency، effort estimate (فقط پس از ظرفیت‌سنجی)، معیار پذیرش عددی، تست، commit/PR، evidence، ریسک و blocker. تاریخ و effort بدون توافق تیم تعهد فرض نشوند.

### 12.8 تعریف موفقیت نسخه داخلی

نسخه داخلی زمانی موفق است که تدوین‌گر بتواند در Audition واقعی، روی macOS و Windows، فایل واقعی را وارد کند؛ بدون materialize غیرضروری کل PCM پردازش کند؛ transcript با محدودیت‌های روشن بگیرد؛ پیشنهادهای تدوین را بررسی و preview کند؛ تغییرات را با تأیید انسانی اعمال یا Undo کند؛ خروجی سالم و مطابق EDL بگیرد؛ و پس از قطع ارتباط یا restart پروژه و فایل اصلی را از دست ندهد.

**تصمیم دامنه‌ای:** Web Studio مستقل از critical path این تحویل خارج است. بازگشت آن فقط با ADR/تصمیم دامنه‌ای جدید مجاز است. این سند برنامه‌ریزی است؛ هیچ مرحله‌ای با افزودن این بخش به‌عنوان شروع‌شده، اجراشده یا پذیرفته‌شده تلقی نمی‌شود.
