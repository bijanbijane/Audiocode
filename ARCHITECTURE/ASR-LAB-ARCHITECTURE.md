# معماری فنی آزمایشگاه مهندسی معکوس گفتار و مسیریاب هوشمند (LAB-01 to LAB-10: ASR Lab & Adaptive Router Architecture)

**نسخه معماری:** `1.0.0-phase0`  
**تاریخ:** ۱۸ نوامبر ۲۰۲۶  
**هدف:** طراحی معماری ماژولار، مستقل از ارائه‌دهنده (Provider-Agnostic) و مبتنی بر شواهد برای کالبدشکافی موتورهای تجاری، توسعه موتور مستقل و مسیریابی هوشمند تولیدی.

---

## ۱. نمای کلان ۱۰ زیرسیستم آزمایشگاه (LAB-01 تا LAB-10)

```
+---------------------------------------------------------------------------------------------------+
|                             ASR RESEARCH & REVERSE ENGINEERING LAB                                |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|  [LAB-02: Audio Corpus Registry] ---> [LAB-03: Audio Forensics & FFmpeg 16kHz Normalizer]         |
|               |                                              |                                    |
|               v                                              v                                    |
|  [LAB-01: Unified Engine Registry & Provider Adapters (Batch & WebSocket Streaming)]              |
|     |-- Commercial Adapters: ElevenLabs Scribe v3 / Live, Deepgram Nova-3, OpenAI GPT-Transcribe  |
|     |-- Open-Source Adapters: Qwen3-ASR (0.6B/1.7B), Whisper Large-v3/Turbo, NeMo FastConformer   |
|     |-- Independent Engine: Avapardaz Hybrid Persian-English Pipeline (LAB-08)                    |
|               |                                              |                                    |
|               v                                              v                                    |
|  [LAB-04: Benchmark Engine (CER/WER/MER/DER/RTF)]    [LAB-05: Live Streaming Lab (TTFT/EOU)]      |
|               \                                             /                                     |
|                v                                           v                                      |
|         [LAB-06: Error Intelligence & Persian Orthographic Taxonomy]                              |
|                                      |                                                            |
|                                      v                                                            |
|         [LAB-07: Model Research] ---> [LAB-08: Independent ASR Engine]                            |
|                                      |                                                            |
|                                      v                                                            |
|         [LAB-09: Adaptive ASR Router & ROVER Quality Control Layer]                               |
|                                      |                                                            |
|                                      v                                                            |
|         [LAB-10: Evaluation, Governance, Cost Ledger & Reproducibility Audit]                     |
+---------------------------------------------------------------------------------------------------+
```

---

## ۲. قرارداد یکپارچه آداپتور موتورها (`UnifiedAsrProviderAdapter` — LAB-01)

برای آنکه آزمایشگاه بتواند بدون تغییر یک خط کد در هسته بنچمارک یا محصول نهایی، هر موتور تجاری یا متن‌باز را جایگزین یا مقایسه کند، تمامی موتورها باید از یک رابط استاندارد پیروی کنند:

```typescript
export interface AsrTranscriptionRequest {
  readonly experimentRunId: string;
  readonly sampleId: string;
  readonly audioSha256: string;
  readonly pcm16kMono: Float32Array;
  readonly durationSec: number;
  readonly mode: 'BATCH_FILE' | 'LIVE_STREAM';
  readonly languageHint?: 'fa' | 'en' | 'ar' | 'multi' | 'auto';
  readonly keyterms?: readonly string[];
  readonly contextPrompt?: string;
  readonly enableDiarization?: boolean;
  readonly enableCharacterTimestamps?: boolean;
  readonly enableAudioEventTags?: boolean;
}

export interface AsrStandardizedOutput {
  readonly providerId:
    | 'elevenlabs-scribe-v3'
    | 'elevenlabs-scribe-v3-live'
    | 'deepgram-nova-3'
    | 'openai-gpt-transcribe'
    | 'openai-gpt-live-transcribe'
    | 'qwen3-asr-1.7b'
    | 'qwen3-asr-0.6b'
    | 'whisper-large-v3-turbo'
    | 'nemo-fastconformer-ctc'
    | 'avapardaz-independent-hybrid';
  readonly modelVersion: string;
  readonly configProfileId: 'CFG-01_DEFAULT' | 'CFG-02_FA' | 'CFG-03_EN' | 'CFG-04_CODESWITCH';
  readonly rawTranscript: string;
  readonly normalizedTranscriptFa: string;
  readonly detectedLanguages: readonly ('FA' | 'EN' | 'AR')[];
  readonly words: readonly {
    readonly word: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly confidence: number;
    readonly speakerId?: string;
    readonly language?: 'FA' | 'EN' | 'AR';
    readonly characters?: readonly { char: string; startMs: number; endMs: number }[];
  }[];
  readonly audioEvents: readonly {
    readonly kind: 'BREATH' | 'COUGH_THROAT' | 'LAUGHTER' | 'MUSIC_JINGLE' | 'LONG_PAUSE';
    readonly startMs: number;
    readonly endMs: number;
  }[];
  readonly telemetry: {
    readonly processingTimeMs: number;
    readonly rtf: number;
    readonly ttftMs?: number;
    readonly e2eLatencyMs: number;
    readonly estimatedCostUsd: number;
    readonly retryCount: number;
  };
}
```

---

## ۳. معماری مسیریاب هوشمند (`Adaptive ASR Router` — LAB-09)

بر اساس اصل **«تمام صوت‌ها نباید به‌طور پیش‌فرض به تمام ارائه‌دهندگان ارسال شوند»** (کنترل هزینه و تأخیر)، مسیریاب هوشمند در ۴ گام تصمیم‌گیری می‌کند:

### گام ۱: کالبدشکافی سریع پیش از ارسال (`Pre-Routing Audio Forensics — < 10ms`)
- محاسبه نسبت سیگنال به نویز (`SNR dB`)، نرخ عبور از صفر (`ZCR`)، تشخیص قطعات موسیقی/سکوت و تخمین اولیه حالت پردازش (`Batch` در برابر `Live Stream`).

### گام ۲: جدول سیاست مسیریابی پویا (Policy-Driven Engine Selection)

| سناریوی ورودی | موتور انتخابی اول (Primary Route) | موتور جایگزین / Failover (Fallback Route) | شرط فعال‌سازی موتور دوم (Selective Verification) |
| :--- | :--- | :--- | :--- |
| **فایل ضبط‌شده فارسی و ترکیبی (FA + EN Code-Switching)** | **ElevenLabs Scribe v3** (یا موتور مستقل `Qwen3-ASR-1.7B + CTC` در حالت Self-Hosted) | **OpenAI GPT-Transcribe** | تنها برای قطعاتی که میانگین اطمینان کالیبره‌شده (`Calibrated Confidence`) کمتر از `0.82` باشد یا دارای تراکم بالای اصطلاحات ناشناخته باشد |
| **استریم زنده کم‌تأخیر یا صدای نویزدار/تلفنی** | **Deepgram Nova-3** (یا `ElevenLabs Scribe v3 Live` / `Qwen3-ASR-0.6B`) | **OpenAI GPT-Live-Transcribe** | در صورت قطع WebSocket، افزایش تأخیر `TTFT > 600ms` یا افت ناگهانی اطمینان |
| **محدودیت هزینه یا الزام حریم خصوصی / بدون اینترنت** | **موتور مستقل آواپرداز (`Qwen3-ASR / FastConformer + Local DSP`)** | `Whisper Large-v3 Turbo (Local)` | اجرای ROVER داخلی بین خروجی مدل مستقل و لایه تصحیح هم‌آوا (`Context-Biasing Prefix Trie`) |

### گام ۳: قطع‌کننده مدار و مدیریت خطا (Circuit Breaker & Failover)
- هر آداپتور دارای `Timeout` قابل تنظیم (مثلاً `3500ms` برای استریم و `30s` برای فایل)، شمارنده خطای متوالی (`Circuit Breaker Threshold = 3 failures`) و ثبت دقیق علت سوییچ (`Fallback Provenance Log`) است.

### گام ۴: لایه کنترل کیفیت و آشتی خروجی‌ها (Quality Control & Meaning-Preserving Reconciliation)
- همان‌طور که در طرح جامع تأکید شده است: **«اختلاف دو خروجی به‌تنهایی نشانه اشتباه بودن یکی از آن‌ها نیست.»**
- زمانی که دو موتور (مثلاً `Scribe v3` و `GPT-Transcribe`) خروجی متفاوتی روی یک بازه زمانی تولید می‌کنند، لایه کنترل کیفیت (`QC Layer`) با سه معیار تصمیم می‌گیرد:
  1. **شواهد آکوستیک و تطابق طول واجی (`CTC Acoustic Alignment Score`)**: کدام کلمه با انرژی و طول هجاهای سیگنال صوتی هم‌خوانی دارد؟
  2. **امتیاز مدل زبانی و درخت پیشوندی دامنه (`Context-Biasing Trie & Bigram Score`)**: در جفت‌های هم‌آوا («صحبت» در برابر «سهبط» یا «تحقیق» در برابر «تهغیغ»)، کدام واژه از نظر بافتاری معتبر است؟
  3. **حفظ مطلق معنای گوینده (`Original Spoken Immutability`)**: هیچ‌گاه کلمات محاوره‌ای یا ساختار نحوی گوینده به شکل مخرب حذف یا بازنویسی نمی‌شود؛ متن خام در لایه `originalText` قفل می‌شود و اصلاحات نگارشی/نیم‌فاصله صرفاً در لایه `displayText` اعمال می‌گردد.

---

## ۴. معماری استقرار دوگانه (Control Plane vs. GPU Compute Worker)

با توجه به نتایج ممیزی محیط اجرایی در `RESEARCH/EXECUTION-ENVIRONMENT.md`:
1. **Control Plane & Studio Dashboard (در همین محیط Node.js / Express + React + TypeScript):**
   - مدیریت دیتاست، نرمال‌سازی سیگنال با `FFmpeg`، اجرای آداپتورهای API تجاری، اجرای لایه هم‌ترازی CTC، تصحیح هم‌آوا، تجمیع ROVER، محاسبه متریک‌های بنچمارک (`CER/WER/MER/DER/RTF`) و داشبورد تحلیلی آزمایشگاه.
2. **External GPU Inference & Training Worker (سرویس مکمل Python + FastAPI + PyTorch/vLLM):**
   - یک میکروسرویس سبک و استاندارد که روی سرور GPU ابری مستقر می‌شود و مدل‌های متن‌باز (`Qwen3-ASR-1.7B/0.6B`، `Whisper Large-v3 Turbo` و `NeMo FastConformer`) را از طریق یک قرارداد REST/WebSocket استاندارد در اختیار Control Plane قرار می‌دهد.

---

## ۵. امنیت، حاکمیت داده و تکرارپذیری (LAB-10: Security & Governance)

1. **مدیریت کلیدها و اسرار:** هیچ کلید API در کد، دیتابیس یا مرورگر کاربر ذخیره نمی‌شود؛ تمامی فراخوانی‌ها فقط از طریق متغیرهای محیطی سمت سرور (`server.ts`) انجام می‌گیرد.
2. **جلوگیری از ارسال خودکار صوت به سرویس‌های خارجی:** ارسال هر نمونه صوتی به APIهای ابری نیازمند فعال بودن فلگ رضایت‌نامه نمونه (`consent_verified = true`) و تأیید صریح کاربر بر روی بودجه مصرفی آزمایش است.
3. **ثبت تغییرناپذیر آزمایش‌ها (`Experiment Provenance Ledger`):** هر بار اجرای بنچمارک با `audio_sha256`، `engine_id`، `model_version`، `config_profile`، `normalization_policy_version` و `timestamp_utc` مهروموم می‌شود تا ۱۰۰٪ قابل بازتولید باشد.
