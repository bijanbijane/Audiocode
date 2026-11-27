# آواپرداز | AVAPARDAZ

**Local-first Persian speech recognition and intelligent audio editing**

AVAPARDAZ is an audio-workflow project focused on Persian speech recognition, transcript production, speech-aware edit decisions, and precise audio rendering. Its engineering direction is to keep speech inference local, use a shared processing core, and expose that core through product-specific adapters.

> **Release status:** The repository's Phase-15 release decision classifies public commercial release as **BLOCKED**. It classifies an internal Linux technical alpha as **READY WITH RESTRICTIONS**. The existence of source code, a passing isolated test, or a benchmark result does not by itself mean that every product path is release-ready.

[English](#overview) · [فارسی](#معرفی-فارسی) · [Architecture](#architecture) · [Quick start](#quick-start) · [Development and tests](#development-and-validation) · [Benchmarks](#asr-benchmarks) · [Release status](#release-status)

---

## Overview

AVAPARDAZ is designed for this workflow:

```text
Audio source
    → audio ingestion and normalization
    → local speech recognition
    → timestamped transcript
    → speech analysis and edit proposals
    → human review / approval
    → sample-accurate audio rendering
    → transcript and audio export
```

The project is more than an ASR wrapper. It combines three logical engines behind shared audio and workflow contracts:

### Engine 01 — SHAHAB (ASR)

- Recognizes Persian speech, with English support in the wider model/runtime plan.
- Produces transcript text and timing information.
- Uses local CPU inference in the supported Native Companion path.
- Must distinguish runtime availability, model files, integrity verification, model loading, real inference, and benchmark-verified transcription. A manifest alone is not proof that a model can run.
- Must not fabricate words, timestamps, confidence values, or successful model readiness.

### Engine 02 — Smart Speech Editing

- Analyzes speech for candidate pauses, repetitions, disfluencies, and other editing opportunities.
- Produces reviewable edit decisions (EDL) rather than silently applying destructive changes.
- Keeps human approval between suggested edits and final rendering.

### Engine 03 — Precision Audio Renderer

- Applies approved edit decisions using integer sample positions.
- Is designed to preserve channel behavior and produce deterministic audio output such as WAV.
- Keeps edit analysis separate from the rendering step.

The three-engine description is the product architecture. The degree of integration and acceptance differs by runtime and host; see [known limitations](#known-limitations) and the authoritative engineering records below.

## Architecture

### Shared core and product adapters

The architecture aims to maintain one shared ASR/audio contract with separate runtime adapters:

| Layer | Responsibility | Current direction |
| --- | --- | --- |
| Shared processing core | Audio ingestion, transcript contracts, Persian normalization, model lifecycle, cancellation, memory/resource policy, edit/render contracts | Shared by product paths |
| Native Companion | Local CPU inference, model/runtime lifecycle, local IPC | Primary runtime for the Adobe Audition path; also consumed by the Studio integration |
| Adobe Audition extension | CEP panel and ExtendScript host integration | Primary commercial product target |
| Web application | React/TypeScript editing UI and local processing integration | Secondary product; currently uses the shared Companion path in the normal Studio workflow |
| Standalone browser-only ASR | Browser Worker + ONNX Runtime Web/WASM + offline browser model storage | Further work; do not assume the independent browser-only path is release-complete |

### Runtime and trust boundaries

- **Native Companion:** communicates with local clients through a loopback interface and authenticated IPC. The project documents HMAC authentication, nonce/replay protection, Host/Origin checks, and path-traversal defenses.
- **Web application:** has a Vite/React UI. In separate development mode, Vite proxies legacy `/api` and `/v1` requests to the local API; `/platform-api` is a separate Platform API prefix.
- **Platform API:** a distinct backend boundary for account, licensing, catalog, payment, and related platform capabilities. It is not the place where user audio should be sent for ASR.
- **Audio privacy:** the production ASR policy is local-only. The project explicitly rejects mandatory cloud ASR, silent cloud fallback, and uploading user audio for transcription.

### Product scope

The formal v1 priority in the project-state record is:

1. Adobe Audition CEP extension.
2. Standalone CPU-first Native Companion.
3. Shared local processing core: SHAHAB, Smart Speech Editing, and Precision Audio Renderer.

A fully independent Web Studio and CDN-based browser model distribution are follow-on work, not prerequisites for the initial v1 scope. The repository contains Web application code, but that fact alone does not establish browser-only inference or independent Web Studio release acceptance.

## Quick start

### Prerequisites

- A supported Node.js runtime.
- [Bun](https://bun.sh/) for dependency installation and the repository's `bun.lock` lockfile.
- Git.
- For browser E2E tests: Chromium installed for Playwright.
- Native Companion and Adobe Audition workflows have additional platform/runtime requirements; a successful Web development-server start does not validate those integrations.

### Install dependencies

Run from the repository root:

```bash
bun install
```

### Start the default application server

```bash
bun run dev
```

The `dev` script runs `tsx server.ts`. It is the repository's default combined development entry point.

### Start the Web UI and local API separately

For the separated Web/API development setup, use two terminals:

Terminal 1 — local API:

```bash
bun run dev:api
```

Terminal 2 — Web UI:

```bash
bun run dev:web
```

The separate Vite mode uses port `5173` and proxies local API routes to `http://127.0.0.1:3000` by default. The Platform API proxy targets `http://127.0.0.1:4000` unless overridden. Start the Platform API separately only when working on features that require it.

### Production Web build and preview

```bash
bun run build
bun run preview
```

The build uses Vite. The preview command serves the generated Web build; it does not start or qualify the Native Companion, Adobe Audition host, or Platform API.

## Development and validation

### Repository scripts

The following descriptions are taken from the current root `package.json`. They describe what each script invokes, not a claim that it has passed in every environment.

| Command | Actual action | Important qualification |
| --- | --- | --- |
| `bun run dev` | Starts `tsx server.ts` | Default combined development entry point |
| `bun run dev:api` | Runs `scripts/start-api.ts` | Starts the local API without relying on the Web dev server |
| `bun run dev:web` | Starts Vite in `separate` mode on `5173` | Expects the local API proxy target to be available |
| `bun run build` | Runs `vite build` | Web production build only |
| `bun run preview` | Runs `vite preview` | Previews the Web build |
| `bun run lint` | Runs `tsc --noEmit` | TypeScript check; this is not ESLint |
| `bun run test:unit` | Runs the selected Node test files under `src`, `packages`, and `backend` | Explicitly excludes several stress, security, and platform integration test files |
| `bun run test:quality-gates` | Runs `vitest` on `src/quality-gate/__tests__/full-pipeline.spec.ts` | One named Vitest file; it is not the entire release gate suite |
| `bun run test:stress` | Runs the long-audio stress and streaming-ingestion test files | Separate from the unit-test selection |
| `bun run test:e2e` | Runs Playwright | Requires a usable Chromium installation and the configured local server |
| `bun run test:separation` | Runs the listed Web/API/runtime separation contract tests | Does not prove complete deployment or platform separation |
| `bun run audit:runtime-deps` | Runs the runtime dependency audit script | Review its output; it is not a full vulnerability audit |
| `bun run audit:express-routes` | Runs the Express route ownership audit script | Static route-ownership check |
| `bun run benchmark:shahab:fleurs` | Runs the SHAHAB FLEURS benchmark script | Use the benchmark report for dataset/model/protocol context |

### Important package-manager caveat

The repository has a `bun.lock` lockfile and no root `package-lock.json` in the audited project state. However, some scripts and test configuration invoke `npm` or `npx` internally:

- `verify:foundation` invokes `npm run lint`, `npx vitest run`, `npm run test:unit`, and `npm run build`.
- The Playwright web-server command invokes `npm run dev`.
- The Playwright setup hint uses `npx playwright install chromium`.

Therefore, do not assume that `bun run verify:foundation` is a Bun-only or fully reproducible validation path. The Phase-15 release audit specifically records the missing npm lockfile as a supply-chain audit blocker (`npm audit` reports `ENOLOCK`). Resolve the package-manager/lockfile policy before treating that audit gate as cleared.

### Suggested validation sequence

Run targeted checks separately and record their actual exit codes and environment:

```bash
bun run lint
bun run test:unit
bun run test:quality-gates
bun run test:stress
bun run test:separation
bun run build
bun run test:e2e
```

This list is a practical sequence, not a replacement for the project's full release acceptance matrix. In particular:

- `test:unit` intentionally omits test files that have dedicated or separately managed suites.
- `test:quality-gates` is one Vitest file, not every quality/security/release gate.
- Stress, E2E, separation, security, model-integrity, native-host, installer, and hardware checks must be run and reported independently.
- A passing TypeScript check or Web build does not establish ASR accuracy, offline behavior, Native Companion correctness, or Adobe Audition host compatibility.
- The root TypeScript configuration and backend exclusions must be considered when interpreting a successful typecheck.

## ASR benchmarks

### Latest SHAHAB Engine 01 Persian evaluation

The report dated **2026-11-26** evaluates:

- **Model:** `Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx` (NeMo FastConformer CTC, FP32).
- **Runtime:** Sherpa-ONNX 2.0.3, CPU, offline.
- **Dataset:** Google FLEURS `fa_ir/test`, all 871 utterances.
- **Execution environment:** Apple Silicon Mac, 8 GiB RAM.

| Metric | Reported result |
| --- | ---: |
| Completed utterances | 871 / 871 |
| Runtime failures | 0 |
| Empty transcripts | 0 |
| Corpus WER | 9.9232% |
| Corpus CER | 3.6439% |
| Audio duration | 13,321.86 seconds |
| Wall-clock inference time | 307.49 seconds |
| Real-time factor (RTF) | 0.02308 |
| Approximate throughput | 43.3× real time |

These values are specific to the model, runtime, normalization/scoring protocol, dataset split, and test machine. They are not a universal accuracy guarantee and do not establish performance on spontaneous conversation, regional dialects, noisy recordings, telephone audio, overlapping speakers, or Persian-English code-switching. The report notes that the FLEURS test audio is read speech and that the evaluated speaker metadata in this export is male.

The evaluated Koochik weights are upstream model artifacts; AVAPARDAZ does not claim to have trained or fine-tuned them. The report records pinned artifact sizes and SHA-256 digests.

### Do not mix benchmark reports

Older project records describe other models and smaller FLEURS experiments, including Shenava-Rizeh and Whisper Turbo. Those results use different datasets, model versions, environments, and scoring protocols. Do not combine their WER/CER/RTF values with the 2026-11-26 Koochik evaluation as if they were one benchmark run.

The Phase-15 release decision dated 2026-11-20 predates the Koochik evaluation. Its overall public-release blockers remain the formal release verdict unless a newer, explicitly approved acceptance decision supersedes them.

## Known limitations

The project records distinguish implemented code from verified product behavior. The following gaps are explicitly documented:

- **Public commercial release is blocked.** Physical macOS and Windows validation with live Adobe Audition is not complete.
- **Adobe Audition host QA:** CEP packaging and host integration code exist, but real host execution, marker/playhead behavior, installation, and long-session behavior require physical desktop verification.
- **Signing and installers:** signed CEP `.zxp`, macOS notarization, and Windows Authenticode-signed Companion installers remain release prerequisites.
- **Supply-chain audit:** the root npm lockfile/CVE audit is unresolved in the Phase-15 decision.
- **Persian-English code-switching:** the Phase-15 report records a substantial code-switching quality gap for Whisper Turbo (63.90% CER in its evaluated setup), requiring dedicated data and GPU-backed specialization. The newer Koochik Persian-only FLEURS test does not resolve that gap.
- **Real-world beta data:** the 2026-11-26 Koochik result is a controlled read-speech benchmark, not a blind beta evaluation of podcasts, calls, accents, noise, or spontaneous speech.
- **Independent browser-only ASR:** browser Worker/WASM inference and standalone Web Studio acceptance remain follow-on work. The normal Studio workflow's Companion integration should not be described as proof of independent browser-only inference.
- **Cross-platform hardware:** Linux CPU evidence does not establish qualification on physical macOS/Windows systems or across all CPU architectures.
- **Commercial infrastructure:** live payment integration and dedicated model CDN infrastructure remain external blockers in the final acceptance record.

## Release status

The formal Phase-15 decision records:

| Release target | Decision |
| --- | --- |
| Public commercial release for macOS/Windows and Adobe Audition customers | **BLOCKED** |
| Internal engineering / local Linux technical alpha | **READY WITH RESTRICTIONS** |

The public-release blockers include physical macOS/Windows + Adobe Audition host testing, signed installers, supply-chain lockfile/CVE clearance, improved bilingual code-switching quality, and live payment/model-delivery infrastructure.

This status is taken from `PHASE-15-FINAL-ACCEPTANCE-DECISION.md` (2026-11-20). The SHAHAB model evaluation dated 2026-11-26 is a later Engine 01 benchmark update, not a replacement for the overall product release decision.

## Privacy and engineering principles

- No mandatory cloud ASR and no silent cloud fallback.
- Do not upload user audio to a remote service for speech recognition.
- Keep model inference local after model provisioning; verify model artifacts against pinned integrity metadata.
- Treat runtime readiness, model availability, integrity verification, model loading, inference, and transcription quality as separate states.
- Process long recordings with bounded memory and explicit cancellation/cleanup behavior.
- Keep edit proposals reviewable and require human approval before applying them.
- Never invent transcript text, timestamps, confidence, benchmark scores, or test results.
- Update the project-state and acceptance documents when implementation or verification status changes.

## Documentation and engineering records

Use the dated report appropriate to the question. The repository contains historical phase documents whose snapshots may not reflect later implementation changes.

- [Authoritative project state](docs/AVAPARDAZ/AUTHORITATIVE-PROJECT-STATE.md)
- [Master roadmap v3.1 and phase closure](docs/AVAPARDAZ/MASTER-ROADMAP.md)
- [ASR core engine interface specification](docs/AVAPARDAZ/ENGINE-INTERFACE-SPEC.md)
- [Decision log](docs/AVAPARDAZ/DECISION-LOG.md)
- [Product integration status](docs/AVAPARDAZ/PRODUCT-INTEGRATION-STATUS.md)
- [Phase-15 final product acceptance and release decision](docs/AVAPARDAZ/PHASE-15-FINAL-ACCEPTANCE-DECISION.md)
- [SHAHAB Engine 01 audit and FLEURS evaluation (2026-11-26)](docs/shahab/SHAHAB_ENGINE01_AUDIT_AND_FLEURS_EVALUATION_2026-11-26.md)

---

## معرفی فارسی

**آواپرداز سامانه‌ای برای تشخیص گفتار و تدوین هوشمند صوت است که تمرکز ویژه‌ای بر زبان فارسی دارد و مسیر اصلی پردازش گفتار را به‌صورت محلی طراحی می‌کند.**

هدف آواپرداز فقط تبدیل صدا به متن نیست. جریان کاری آن شامل دریافت و آماده‌سازی صوت، تشخیص گفتار، تولید متن زمان‌بندی‌شده، تحلیل مکث و تکرار و تپق، ساخت پیشنهادهای تدوین، بازبینی و تأیید انسانی و در نهایت رندر دقیق صوت است.

### سه موتور اصلی

1. **شهاب (SHAHAB):** موتور تشخیص گفتار (ASR) با اجرای محلی و پردازش CPU.
2. **تدوین هوشمند گفتار:** تحلیل گفتار و تولید فهرست تصمیم‌های تدوین (EDL) که باید پیش از اعمال نهایی توسط کاربر بازبینی و تأیید شوند.
3. **رندر دقیق صوت:** اعمال تغییرات تأییدشده بر اساس موقعیت نمونه‌های صوتی و تولید خروجی مانند WAV.

### معماری محصول

هستهٔ پردازش و قراردادهای صوتی باید میان محصولات مشترک بماند، اما هر محصول آداپتور اجرایی خودش را دارد:

- **افزونهٔ Adobe Audition مبتنی بر CEP** به همراه Native Companion محلی، اولویت اصلی محصول تجاری است.
- **Native Companion** اجرای مدل روی CPU و ارتباط محلی امن با برنامهٔ میزبان را فراهم می‌کند.
- **برنامهٔ وب** رابط ویرایش و مسیر یکپارچه‌شده با Companion را ارائه می‌دهد. این موضوع به معنی تکمیل مسیر مستقل تشخیص گفتار در مرورگر نیست.
- **Web Studio مستقل و توزیع مدل مرورگر از CDN** در اسناد نقشهٔ راه به‌عنوان کارهای بعدی ثبت شده‌اند.

### راه‌اندازی سریع

برای نصب وابستگی‌ها در ریشهٔ مخزن:

```bash
bun install
```

اجرای سرور توسعه:

```bash
bun run dev
```

ساخت نسخهٔ وب:

```bash
bun run build
```

برای اجرای جداگانهٔ API و رابط وب، به بخش [Quick start](#quick-start) مراجعه کنید.

### نتیجهٔ ارزیابی شهاب

در گزارش ۲۶ نوامبر ۲۰۲۶، مدل `Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx` روی مجموعهٔ آزمون فارسی Google FLEURS با ۸۷۱ نمونه ارزیابی شده است:

- WER: **۹٫۹۲۳۲٪**
- CER: **۳٫۶۴۳۹٪**
- RTF: **۰٫۰۲۳۰۸**
- خطای اجرایی: **صفر**
- خروجی متن خالی: **صفر**

این اعداد فقط به همان مدل، مجموعه‌داده، روش نرمال‌سازی و دستگاه آزمون مربوط‌اند و تضمین کیفیت روی مکالمهٔ روزمره، لهجه‌ها، محیط پرنویز یا گفتار ترکیبی فارسی و انگلیسی نیستند.

### وضعیت انتشار

طبق تصمیم رسمی Phase-15:

- انتشار تجاری عمومی برای macOS، Windows و Adobe Audition: **مسدود (BLOCKED)**.
- آلفای فنی داخلی روی Linux: **آماده با محدودیت (READY WITH RESTRICTIONS)**.

آزمون واقعی روی میزبان Adobe Audition در macOS و Windows، امضای نصب‌کننده‌ها، رفع مانع ممیزی وابستگی‌ها، بهبود کیفیت گفتار ترکیبی فارسی و انگلیسی و تکمیل زیرساخت پرداخت و توزیع مدل از موانع انتشار عمومی هستند.

**اصل بنیادین:** صدای کاربر نباید بدون اطلاع و رضایت او برای تشخیص گفتار به سرویس ابری ارسال شود. هر ادعای کیفیت، آفلاین‌بودن یا آمادگی انتشار باید با آزمون و گزارش قابل بازبینی پشتیبانی شود.
