# آواپرداز | AVAPARDAZ

**Local-first Persian speech recognition and intelligent audio editing.**

آواپرداز is a privacy-oriented speech and audio editing platform built around a shared local ASR core. Its goal is not merely to transcribe audio: it is to turn spoken recordings into accurate, reviewable transcripts and carefully edited audio, while keeping speech recognition on the user's device.

> **Product mission:** Recognize Persian and English speech locally, analyze the spoken content, propose precise edits, and render the approved result without requiring cloud-based ASR.

[فارسی](#معرفی-فارسی) · [Architecture](#architecture) · [Product scope](#product-scope) · [Getting started](#getting-started) · [Project status](#project-status)

---

## What AVAPARDAZ does

AVAPARDAZ is organized around three cooperating engines:

1. **SHAHAB — Engine 01: Speech Recognition**
   - Local Persian-first ASR, with English support.
   - Produces transcript segments and timing metadata.
   - Must report model/runtime readiness honestly; it must not fabricate transcript text, confidence, or timestamps.

2. **Smart Speech Editing — Engine 02: Speech Analysis and Edit Decisions**
   - Detects candidate pauses, disfluencies, repetitions, and other speech-editing opportunities.
   - Produces an edit decision list (EDL).
   - Keeps a human approval step between analysis and destructive or externally visible edits.

3. **Precision Audio Renderer — Engine 03: Audio Rendering**
   - Applies approved edits using sample-index-based timing.
   - Preserves channel behavior and renders audio such as WAV.
   - Separates edit decisions from the final rendering operation.

The intended workflow is:

`Audio → Local ASR → Transcript → Speech analysis → Review / approval → Precise render → Export`

## Architecture

The project is designed around one shared, platform-independent **AVAPARDAZ ASR CORE**, with separate runtime adapters for its products:

- **Adobe Audition CEP extension:** the primary professional editing integration, backed by a standalone Native Companion.
- **Native Companion:** CPU-first local inference and local IPC for host applications.
- **Web application:** a separate client that is intended to consume the same core contracts through browser-local execution (Web Worker / WASM and local storage).

The core contracts cover audio ingestion, model lifecycle and integrity, transcript structure, Persian text normalization, runtime capabilities, cancellation, and resource limits.

### Local-first and privacy principles

- No mandatory cloud ASR or third-party speech-recognition API.
- No silent upload or cloud fallback for user audio transcription.
- CPU-first execution; a GPU is not a requirement for the core workflow.
- Model artifacts are expected to be integrity-checked (SHA-256) before use.
- Long recordings should be processed in bounded chunks with explicit memory/resource governance.
- Runtime, model, and transcription readiness are distinct states; the presence of a manifest alone does not mean a model is ready.

These principles describe the product requirements. They do **not** mean every platform, feature, or release has already passed offline and hardware qualification.

## Product scope

The current v1 delivery priority is:

1. Adobe Audition CEP extension.
2. Standalone Native Companion.
3. Shared local processing core: SHAHAB, Smart Speech Editing, and Precision Audio Renderer.

A fully independent Web Studio and CDN-based browser model distribution are documented as follow-on work, not prerequisites for the initial v1 delivery.

The repository also contains web application code. Its presence should not be interpreted as proof that the independent browser product has reached release acceptance.

## Getting started

### Requirements

- A supported Node.js runtime.
- Bun, matching the repository's `bun.lock` dependency lockfile.
- Platform-specific native tooling may be required for Native Companion and Adobe Audition integration.

### Install dependencies

```bash
bun install
```

### Run the development server

```bash
bun run dev
```

### Useful project scripts

| Command | Purpose |
| --- | --- |
| `bun run lint` | TypeScript check (`tsc --noEmit`) |
| `bun run build` | Production web build with Vite |
| `bun run test:unit` | Main unit-test selection |
| `bun run test:quality-gates` | Full-pipeline quality-gate test |
| `bun run test:stress` | Long-audio / streaming stress tests |
| `bun run test:e2e` | Playwright end-to-end tests |
| `bun run test:separation` | Platform/runtime separation contract tests |
| `bun run verify:foundation` | Typecheck, Vitest, selected unit tests, and build |

Some test scripts intentionally select or exclude particular suites. A passing `verify:foundation` run should not be treated as a substitute for the separate stress, E2E, separation, security, native-host, and hardware acceptance gates.

## Model evaluation and known limitations

The project records a controlled Persian ASR evaluation for **Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx** on Google FLEURS `fa_ir/test`:

- 871 test utterances; no runtime failures or empty transcripts in that evaluation.
- WER: **9.9232%**; CER: **3.6439%**.
- Real-time factor (RTF): **0.02308** in the recorded CPU test environment.

This is evidence for that model, runtime, dataset, and test setup only. It is not a claim of state-of-the-art performance or proof of accuracy on spontaneous conversation, dialects, noisy recordings, overlapping speakers, or every supported device.

Known areas requiring further qualification include:

- Conversational, noisy, dialectal, and multi-speaker Persian evaluation.
- Reliable word-level end timestamps and forced alignment.
- 60–120 minute stress tests with measured peak memory, cancellation, and recovery.
- Windows x64 and macOS hardware qualification.
- End-to-end acceptance inside supported Adobe Audition versions.
- Complete release/security dependency checks and packaging verification.

See the authoritative project-state document and the SHAHAB evaluation report for evidence, dates, and acceptance criteria.

## Development principles

- Prefer measured behavior over claims based on implementation or mock tests.
- Keep ASR runtime adapters behind shared contracts.
- Keep user audio local for ASR; do not introduce an implicit cloud fallback.
- Treat transcript timing and confidence as data that must be evidenced, not guessed.
- Keep edit proposals reviewable and preserve human approval.
- Make memory, cancellation, cleanup, and error handling part of the feature design.
- Update project-state documentation when implementation or acceptance status changes.

## Documentation

- [Authoritative project state and v1 scope](docs/AVAPARDAZ/AUTHORITATIVE-PROJECT-STATE.md)
- [Master engineering roadmap](docs/AVAPARDAZ/MASTER-ROADMAP.md)
- [ASR core engine interface](docs/AVAPARDAZ/ENGINE-INTERFACE-SPEC.md)
- [Decision log](docs/AVAPARDAZ/DECISION-LOG.md)
- [SHAHAB Engine 01 FLEURS evaluation](docs/shahab/SHAHAB_ENGINE01_AUDIT_AND_FLEURS_EVALUATION_2026-11-26.md)

---

## معرفی فارسی

**آواپرداز یک سامانهٔ محلی و هوشمند برای تشخیص گفتار و تدوین صوت است؛ با تمرکز ویژه بر زبان فارسی.**

هدف آن فقط تبدیل صدا به متن نیست. آواپرداز باید گفتار را تشخیص دهد، متن و زمان‌بندی آن را در اختیار کاربر بگذارد، مکث‌ها و تپق‌ها و تکرارهای قابل اصلاح را شناسایی کند، پیشنهاد تدوین بسازد و پس از تأیید کاربر، خروجی صوتی دقیق تولید کند.

سه بخش اصلی آن عبارت‌اند از:

- **شهاب (SHAHAB):** موتور تشخیص گفتار محلی.
- **تدوین هوشمند گفتار:** تحلیل گفتار و ساخت پیشنهادهای تدوین قابل بازبینی.
- **رندر دقیق صوت:** اعمال اصلاحات تأییدشده با دقت نمونه‌ای.

اولویت نسخهٔ اول، افزونهٔ Adobe Audition به همراه Native Companion و هستهٔ پردازش محلی مشترک است. نسخهٔ مستقل Web Studio و توزیع مستقل مدل مرورگر در برنامهٔ پس از v1 قرار دارند.

**اصل بنیادین محصول:** صدای کاربر برای تشخیص گفتار نباید بدون اطلاع و رضایت او به سرویس ابری ارسال شود. قابلیت آفلاین و کیفیت هر مدل نیز باید با آزمون واقعی اثبات شود، نه صرفاً با وجود کد یا فایل مدل.

## وضعیت پروژه

این مخزن در حال توسعه است. وجود قابلیت یا کد به‌تنهایی به معنی آماده‌بودن آن برای انتشار نیست. وضعیت هر قابلیت باید بر اساس گزارش آزمون، پلتفرم هدف، نسخهٔ مدل و معیار پذیرش مربوطه سنجیده شود.
