# R0 — Baseline Audit (Initial Snapshot)

**Date:** 2026-11-27  
**Roadmap:** AVP-DELIVERY-ROADMAP-1.1  
**Scope:** Audition / Internal / macOS + Windows  
**Audit status:** IN PROGRESS — read-only repository and evidence review; not an acceptance decision.

## 1. Repository baseline

| Field | Observed value |
|---|---|
| Repository | `bijanbijane/Audiocode` (private) |
| Default branch | `main` |
| Baseline commit | `e73394f8e00e477f1de0046e04fd233681610563` |
| Baseline commit date | 2026-11-27 13:36:55 UTC |
| Roadmap document | `docs/AVAPARDAZ/DELIVERY-ROADMAP-INTERNAL-2026-11-27.md` |
| Package manager lockfile | `bun.lock` present |
| npm lockfile | `package-lock.json` absent |
| Local checkout / working tree | NOT INSPECTED — this execution environment has no mounted repository checkout; GitHub API access only |

The baseline commit is the exact `main` head observed during this audit. No source code or product files were modified during the read-only inspection.

## 2. CI baseline

Two workflows ran on the baseline commit and both concluded `failure`:

- [Architecture Governance, Reliability & Release Quality Gate](https://github.com/bijanbijane/Audiocode/actions/runs/46008647628)
- [AVAPARDAZ Quality & Release Gates](https://github.com/bijanbijane/Audiocode/actions/runs/46008647708)

In the second workflow, Level 1 failed and dependent Levels 2–5 were skipped. The connector did not provide step-level summaries or downloadable logs for these runs; the root cause is therefore **UNKNOWN**, not inferred.

Relevant configured commands in `package.json` include:

- `npm run lint` — `tsc --noEmit`
- `npm run build` — `vite build`
- `npm run test:unit`
- `npm run test:quality-gates`
- `npm run test:e2e`
- `npm run test:stress`
- `npm run verify:foundation`
- `npm run audit:runtime-deps`
- `npm run audit:express-routes`

The workflows install dependencies with `bun install --frozen-lockfile`. One workflow warns that npm audit cannot consume the absent `package-lock.json`; another workflow generates a CycloneDX SBOM from `bun.lock`. No test command was executed by this audit session.

## 3. External prerequisites reconciled to the approved internal scope

The previous `MASTER-ROADMAP.md` and ADR-026 list five external prerequisites for the former public/commercial roadmap. They must not be carried forward without scope analysis.

| Legacy prerequisite | Internal Audition disposition | Evidence / next action | Initial status |
|---|---|---|---|
| Physical macOS + Windows + live Adobe Audition host | Mandatory. Both operating systems are explicit release targets. | Obtain/identify physical or authorized remote test hosts; verify live panel, Companion, markers, playback/seek, lifecycle and long-file behavior. | BLOCKED — host access/evidence not available in this audit |
| Signed standalone packaging (.dmg notarization, .msi Authenticode, signed .zxp) | Re-scope. Public distribution signing is not automatically an internal-release requirement; security and OS installation constraints still apply. | Decide internal trust/distribution model and document whether signing is mandatory for the internal cohort. | OPEN — decision required in R0 |
| Supply-chain audit and stale-test hygiene | Mandatory in proportion to internal distribution risk. | Establish Bun-lockfile-compatible vulnerability scanning, triage reachable Critical/High issues, diagnose current Level-1 CI failure, and repair/retire stale tests with evidence. | OPEN — CI failure confirmed; root cause unknown |
| GPU bilingual fine-tuning and 50–200h corpus | Not a gate for the current Audition internal release unless product requirements explicitly depend on improved code-switching. | Preserve current ASR limitations; do not claim general conversational/code-switching accuracy. Revisit only through scope/ADR change. | DEFERRED — outside current critical path |
| Live payment and model CDN infrastructure | Out of scope for internal local-first delivery. | No work unless the product/release scope changes. | DEFERRED — outside current critical path |

This table is a scope reconciliation, not a claim that any external dependency has been provisioned.

## 4. macOS / Windows / Audition evidence

Existing repository documents provide the following candidate compatibility baseline:

- `docs/shahab/SHAHAB_ADOBE_HOST_VERSION_MATRIX.md`: Adobe Audition 25.x on Windows 11 x64 and macOS 14/15 (arm64/x86_64); both live-host tests are `NOT_TESTED`.
- `docs/AVAPARDAZ/HARDWARE-COMPATIBILITY-MATRIX.md`: older broader matrix mentions Windows 10/11 and macOS Intel/Apple Silicon, but labels desktop Audition host capabilities `Unverified`.
- `docs/AVAPARDAZ/PHASE-09-TEST-REPORT.md`: Linux x86_64 only; live Audition GUI and physical consumer hardware are explicitly blocked.
- `docs/shahab/SHAHAB_ADOBE_INTEGRATION_TEST_REPORT.md`: SDK offset mapping, interchange generation, authenticated bridge and privacy/recovery checks are reported as passing; installed live Audition GUI remains not tested.

**Provisional test matrix (not yet approved):**

| Dimension | Candidate | Evidence status |
|---|---|---|
| Windows | Windows 11 x64 | Candidate from SHAHAB-024 matrix; live host NOT_TESTED |
| macOS | macOS 14/15, Apple Silicon and Intel | Candidate from SHAHAB-024 matrix; live host NOT_TESTED |
| Adobe Audition | 25.x | Candidate from SHAHAB-024 matrix; exact supported build/minor version not pinned |
| Windows minimum hardware | TBD | Not established for the internal release |
| macOS minimum hardware | TBD | Not established for the internal release |
| Audio input/output formats | TBD against current Audition workflow and renderer contract | Not frozen by this audit |

R0 must freeze exact OS builds, Audition builds, CPU architectures, minimum RAM/CPU, and supported audio formats before platform acceptance testing.

## 5. Core, ASR and alignment evidence

### Long-file processing

`docs/AVAPARDAZ/LONG-FILE-STRESS-REPORT.md` records Linux x86_64 synthetic streaming stress tests through 120-minute mono/stereo cases, with zero reported leaked bytes and peak RSS of approximately 507 MiB in the 120-minute 48 kHz stereo case. This is useful Linux harness evidence only; it is not physical macOS/Windows Native Companion verification.

The 2026-11-26 SHAHAB audit separately states that 60–120 minute continuous Native Companion stress on Mac, including peak RSS, staging disk, cancellation and recovery, is **NOT YET VERIFIED**.

### ASR

`docs/shahab/SHAHAB_ENGINE01_AUDIT_AND_FLEURS_EVALUATION_2026-11-26.md` reports a full Google FLEURS `fa_ir/test` evaluation (871 utterances, WER 9.9232%, CER 3.6439%, RTF 0.02308) on the reported Mac environment. The report explicitly limits this evidence to read speech in that corpus; it is not evidence of general conversational, noisy, dialectal or code-switched accuracy.

### Alignment

The current files are `docs/shahab/SHAHAB_ALIGNMENT_ARCHITECTURE.md`, `SHAHAB_ALIGNMENT_TEST_REPORT.md` and `SHAHAB_ALIGNMENT_STATE.json` (the prior audit's guessed `SHAHAB-025-FARSI-FORCED-ALIGNMENT.md` path does not exist on current `main`).

The state JSON reports:

- `ALIGNMENT_PARTIALLY_SUPPORTED`
- no dedicated Persian CTC aligner weights bundled
- no verified human-annotated Persian word-boundary gold corpus
- real-world word-boundary MAE/P95 `NOT_MEASURED`
- segment-anchored output may leave internal words `TIMING_UNAVAILABLE`

Therefore, word-level timing is not accepted as a safe input to automatic edits. Segment-level timing and explicit uncertainty remain the safe product boundary until independent gold validation passes.

## 6. Initial risk register

| ID | Priority | Finding | Required action |
|---|---|---|---|
| R0-P0-01 | P0 | Both principal CI workflows fail on the exact baseline commit; failure reason unavailable. | Reproduce Level-1 failure in a real checkout and record exact command, environment, exit code and logs. |
| R0-P0-02 | P0 | Live Audition host tests on both target operating systems remain NOT_TESTED. | Secure physical/authorized test hosts and execute host acceptance matrix. |
| R0-P1-01 | P1 | Internal signing/distribution policy is not settled by the previous commercial prerequisite list. | Record internal trust model and packaging acceptance. |
| R0-P1-02 | P1 | Current ASR evidence does not establish natural speech or code-switching performance. | Preserve explicit limitations; define whether internal cohort use cases require additional corpus. |
| R0-P1-03 | P1 | Persian word-boundary accuracy has no human-gold MAE/P95 evidence. | Keep word-level automatic edits gated; acquire consented gold alignment corpus only if required. |
| R0-P1-04 | P1 | Exact minimum hardware and supported audio format matrix is not frozen. | Approve reproducible macOS/Windows test configurations and formats. |

## 7. R0 completion status

**R0 is NOT COMPLETE.** This initial snapshot establishes the remote repository baseline and reconciles key evidence, but the following exit criteria remain open:

1. Local Git branch and working-tree status must be inspected in a real checkout.
2. Root cause of both current CI failures must be reproduced and diagnosed.
3. The five legacy prerequisites must be formally accepted as required, deferred or out of scope for the internal release.
4. Exact Audition, macOS, Windows and minimum hardware versions must be approved.
5. Supported input/output formats must be frozen.
6. Physical/authorized macOS and Windows test-host access must be established.
7. The test inventory must be reconciled against actual execution results, not workflow configuration alone.

**No R0 gate is passed by this document.** No capability is promoted to VERIFIED or ACCEPTED by the existence of code, documentation or historical test reports.

## 8. Next action

The next engineering action is to obtain a runnable checkout at baseline commit `e73394f8e00e477f1de0046e04fd233681610563`, reproduce the two failing Level-1 CI workflows, and capture the first failing command and complete logs. Do not start feature implementation until this blocker is understood.

## 9. Follow-up evidence collected after the initial snapshot

### Pull request validation

The documentation-only R0 pull request (#6) is still **OPEN / DRAFT / NOT MERGED**. Its head commit is `afb0cf8b8bdf8068019c89b30912182a184742aa`.

GitHub Actions also ran against the PR head and reproduced the same two workflow-level failures:

- [AVAPARDAZ Quality & Release Gates — PR validation](https://github.com/bijanbijane/Audiocode/actions/runs/46009771297): Level 1 failed; Levels 2–5 skipped.
- [Architecture Governance, Reliability & Release Quality Gate — PR validation](https://github.com/bijanbijane/Audiocode/actions/runs/46009771370): failed.

Each failed check reports one annotation, but the GitHub connector returned no step list or log URL for the jobs. The job-log download endpoint returned `BlobNotFound`; the annotation endpoint is not exposed through the current GitHub connector. Consequently the failing command and root cause remain **UNKNOWN**. The failure is reproducible at workflow level, not yet reproducible locally.

### Static validation of the Level-1 test paths

The five files invoked by the AVAPARDAZ Level-1 focused regression command were individually fetched from `main` and all exist:

- `src/ai-engine/asr/SileroVadOnnxRunner.test.ts`
- `src/ai-engine/asr/SpeakerEmbeddingOnnxRunner.test.ts`
- `src/ai-engine/asr/WespeakerKaldiFbank80.test.ts`
- `src/ai-engine/asr/LocalWeSpeakerDiarizationService.test.ts`
- `src/ai-engine/MultiSpeakerDiarizationAndCrosstalkEngine.test.ts`

The configured Vitest file `src/quality-gate/__tests__/full-pipeline.spec.ts` also exists. This rules out missing test-file paths as the obvious static explanation, but does not establish that the tests pass or that imports resolve at runtime.

### Execution environment availability

The only registered Desktop Commander device, `MacBook-Air.local`, is currently **OFFLINE** (last seen approximately 23 hours before this check). No local checkout, branch state, working tree, package install, test execution, or physical macOS/Windows host test could be inspected from this session.

### Revised next action

1. Restore an authorized online development host or provide another runnable checkout environment.
2. At the baseline commit, inspect `git status --short --branch` before changing files.
3. Run the exact failing workflow commands in sequence and capture stdout/stderr, exit codes and environment versions; identify the first failure before modifying code.
4. Fix only the demonstrated root cause on a focused branch, then rerun the affected test and complete Level-1 gate.

No source code was changed, no CI workflow was edited, and no R0 gate is passed by this follow-up.


## 10. GitHub-only execution constraint and CI retry (2026-11-27)

The execution method is now explicitly constrained to the official GitHub repository and GitHub-hosted automation. No Mac/Desktop Commander session or local checkout is to be used as the development or test environment. Repository inspection and edits are performed through GitHub; executable validation must run in GitHub Actions. Accordingly, the earlier references in Sections 7–9 to restoring a local checkout or inspecting a local working tree are superseded. The remote branch, commit and PR state are the authoritative state available to this workflow.

### Additional workflow evidence

The exact Level-1 workflow definitions were inspected on `main`:

- `.github/workflows/avapardaz-quality-gates.yml` runs `bun install --frozen-lockfile`, five focused Node test files, then (with `if: always()`) the production Vite build, the self-hosted ORT WASM asset check, and `npm run lint`.
- `.github/workflows/ci-quality-gate.yml` runs Bun install, cargo-deny, Madge, CycloneDX SBOM generation, TypeScript lint, Vitest, Node reliability tests, quality-gate tests and production build.

The `package.json` scripts and `bun.lock` are present. The five focused AVAPARDAZ Level-1 test paths and the configured Vitest quality-gate spec path were confirmed to exist. This is static inspection only; no command has yet been executed successfully in a GitHub runner during this audit.

The failed workflow jobs were retried through GitHub Actions (failed-jobs-only) for runs:

- [AVAPARDAZ Quality & Release Gates, attempt 2](https://github.com/bijanbijane/Audiocode/actions/runs/46010718548)
- [Architecture Governance, Reliability & Release Quality Gate, attempt 2](https://github.com/bijanbijane/Audiocode/actions/runs/46010718553)

Both retries again concluded `failure`. The job summaries returned no step records, and job-log retrieval again returned `BlobNotFound`. The original baseline jobs exposed `runner_id: 0`, empty step arrays and effectively immediate completion; this suggests a runner/job-initialization or Actions observability issue, but it does **not** prove the root cause. No specific source-code defect has been established.

### Updated disposition

- CI status: **FAILURE — cause still UNKNOWN**. Re-run did not provide executable logs or step evidence.
- Source-code fix: **NOT MADE**. Changing application code or weakening gates without a demonstrated failure would be speculative.
- R0: **IN PROGRESS**. No gate is passed.
- Next action: obtain usable GitHub Actions step/job diagnostics (including runner assignment and first failing step) for these existing workflows, then reproduce and fix only a demonstrated defect. Keep all edits on a dedicated GitHub branch and validate them with Actions; do not use a local Mac checkout.


## 11. Runner allocation diagnosis (2026-11-27)

A fresh PR-triggered validation occurred after the report update:

- [AVAPARDAZ Quality & Release Gates](https://github.com/bijanbijane/Audiocode/actions/runs/46013373171)
- [Architecture Governance, Reliability & Release Quality Gate](https://github.com/bijanbijane/Audiocode/actions/runs/46013373182)

The AVAPARDAZ Level-1 job payload was inspected directly through the Actions jobs endpoint. It reports:

- `runner_id: 0`
- `runner_name: ""`
- `steps: []`
- job started at 14:09:33 UTC and completed at 14:09:35 UTC
- conclusion: `failure`

The Architecture Governance job shows the same failure pattern in the run summary: it completed in approximately two seconds, with no step summaries or downloadable logs. Dependent AVAPARDAZ jobs were skipped because Level 1 failed.

**Finding:** these observed runs do not demonstrate a TypeScript, test, build, or application-code failure. The failing job did not report assignment to a GitHub-hosted runner and no workflow step was recorded. The most precise current classification is **pre-runner / Actions execution-layer failure**. The exact underlying reason (for example account billing/spending limits, repository Actions policy, or GitHub runner-service failure) is still unverified because repository Actions settings and check annotations are not readable through the available connector.

A temporary runner-diagnostics workflow was briefly added to the PR branch, but GitHub did not schedule it because a newly introduced workflow file on a PR branch is not eligible to trigger from that same PR when it is absent from the base branch. It was removed immediately; no diagnostic workflow remains in the branch.

### Required next action

Do not change source code or relax CI checks based on these results. The repository owner must inspect GitHub **Settings → Actions → General** and account **Billing / Actions usage** for this private repository, confirm Actions are enabled and spending limits/available minutes permit hosted runners, then rerun the existing workflows. Once a job is assigned a runner and produces steps, continue with the first actual failing command. This settings/billing verification is outside the read/write capabilities of the current repository connector.

### Current R0 CI disposition

- Runner allocation: **NOT OBSERVED** for the latest failed Level-1 jobs (`runner_id=0`).
- Application-level CI failure: **NOT ESTABLISHED**.
- Exact Actions execution-layer cause: **UNKNOWN / OWNER SETTINGS CHECK REQUIRED**.
- Source changes for CI: **NONE**.
- R0: **IN PROGRESS; no gate passed**.


## 12. Cross-run confirmation of the pre-runner pattern (2026-11-27)

To distinguish a one-off failure from a persistent runner-allocation issue, job payloads were also inspected for earlier runs on the repository:

- [AVAPARDAZ PR run 46005452215](https://github.com/bijanbijane/Audiocode/actions/runs/46005452215)
- [Architecture Governance PR run 46005452116](https://github.com/bijanbijane/Audiocode/actions/runs/46005452116)
- [AVAPARDAZ main run 46005599076](https://github.com/bijanbijane/Audiocode/actions/runs/46005599076)
- [Architecture Governance main run 46005599082](https://github.com/bijanbijane/Audiocode/actions/runs/46005599082)

All four failed jobs independently show the same pattern: `runner_id=0`, empty `runner_name`, zero recorded steps, and completion in approximately two seconds. The latest pair of PR runs (46013373171 / 46013373182) show the same pattern.

This repeated pattern across different commits, both workflows, main pushes and PR events makes a repository-wide Actions execution/configuration or account-level runner availability issue substantially more likely than a source-code regression. It still does not identify the exact setting or service-side cause; billing, spending limits and repository Actions policy remain owner-side checks.

**Engineering decision:** pause application-code changes intended to fix CI. Keep CI gates intact. Resume code-level diagnosis only after a GitHub Actions job is actually assigned a runner and records its first step.

## 13. Correction: temporary runner-diagnostics workflow did trigger (2026-11-27)

The earlier wording in Section 11 that the temporary diagnostic workflow "was not scheduled" was inaccurate and is corrected here.

GitHub Actions did create a PR-triggered run for the temporary workflow:

- [Temporary GitHub Runner Diagnostics — run 46013656016](https://github.com/bijanbijane/Audiocode/actions/runs/46013656016)

Its job payload was inspected directly. It shows `runner_id=0`, empty `runner_name`, zero recorded steps, and failure after approximately two seconds. Therefore, the diagnostic workflow **was triggered but failed before runner allocation**, exactly like the two product workflows. It did not reach checkout, Node/Bun setup, or the shell smoke-test commands, so it provides no toolchain or runner-environment result.

The temporary workflow file was subsequently deleted from the PR branch and its absence was verified with a GitHub 404 response. No diagnostic workflow remains in the branch.

### Latest CI observation

The newest product-workflow runs on the current PR head `493ba25961be08472b1cc5842f1a71fabd1d7118` are:

- [AVAPARDAZ Quality & Release Gates — 46014006026](https://github.com/bijanbijane/Audiocode/actions/runs/46014006026)
- [Architecture Governance — 46014005836](https://github.com/bijanbijane/Audiocode/actions/runs/46014005836)

Their failed jobs again show `runner_id=0`, no runner name and no recorded steps. AVAPARDAZ Level 2–5 jobs were skipped after Level 1 failed.

### Corrected disposition

- Diagnostic workflow: **TRIGGERED; PRE-RUNNER FAILURE** (not "not scheduled").
- Product workflows: **PRE-RUNNER FAILURE pattern persists**.
- Application commands: **NOT EXECUTED / NO EVIDENCE**.
- Root cause within GitHub account/repository Actions configuration or GitHub service: **NOT YET IDENTIFIED**.
- Temporary workflow: **REMOVED; absence verified**.
- Source-code changes and gate relaxations: **NONE**.


## 14. Validation after authoritative-state alignment commit

The latest PR-head workflows were also inspected after commit `771b009e1a4a1b2730cdf84d0fc5493a887eed91`:

- [Architecture Governance — run 46014422935](https://github.com/bijanbijane/Audiocode/actions/runs/46014422935)
- [AVAPARDAZ Quality & Release Gates — run 46014422928](https://github.com/bijanbijane/Audiocode/actions/runs/46014422928)

The job payloads again show `runner_id=0`, empty `runner_name`, zero steps and failure in approximately two seconds. AVAPARDAZ Levels 2–5 were skipped. This confirms the same pre-runner failure on the latest PR head; it does not test or validate the document changes or application code.

The authoritative-state and R0 report files were fetched back from the PR branch after the writes. Their updated content hashes were confirmed. PR #6 remains OPEN / DRAFT / NOT MERGED; base is `main`; the main branch was not modified.

**No executable validation passed.** The only completed verification in this update is GitHub read-back of the two documentation files and PR metadata.



## 15. Latest PR-head CI recheck and R0 decision inventory (2026-11-27)

### 15.1. Remote state revalidated

- PR #6 remains **OPEN / DRAFT / NOT MERGED**.
- PR head at the start of this recheck: `7c19e312d2dcbc907fdc44f6696b498bc07aacde`.
- PR base remains `main` at `e73394f8e00e477f1de0046e04fd233681610563`.
- No changes were made to `main`.

### 15.2. New Actions evidence on the current PR head

Two additional workflow runs were discovered for the current PR head:

- [Architecture Governance — run 46014529274](https://github.com/bijanbijane/Audiocode/actions/runs/46014529274)
- [AVAPARDAZ Quality & Release Gates — run 46014529304](https://github.com/bijanbijane/Audiocode/actions/runs/46014529304)

The GitHub job summaries report both primary jobs as failed. The available job-step endpoint returns an empty step array for both jobs. The AVAPARDAZ dependent Level 2–4 and Level 5 jobs are skipped. The job summaries do not expose a log URL. This is consistent with the previously observed pre-step failure pattern, but this connector response alone does not expose the runner assignment fields for these two latest jobs.

**Disposition:** the latest runs still provide no evidence that lint, typecheck, tests, build, packaging, or security-audit commands executed. CI remains blocked at workflow/job initialization or an earlier unobservable stage; the exact cause remains **UNKNOWN**. Do not treat these runs as application test failures, and do not weaken or bypass any gate.

### 15.3. Correction of superseded execution instructions

Sections 7–9 contain historical wording that requests a local checkout, local working-tree inspection, or a restored local development host. Those instructions are superseded by Section 10 and the explicit GitHub-only execution constraint. For this project workflow:

- Repository state is inspected remotely through the official GitHub repository.
- File edits are made through GitHub on the existing audit branch.
- Executable validation is performed only through GitHub Actions.
- No Mac/Desktop Commander or local checkout is requested or used.

The historical text is retained for audit traceability; it is not an active prerequisite for this workflow.

### 15.4. Platform-matrix reconciliation

A fresh read of the two source matrices confirms that the candidate platform scope is not yet a single approved compatibility contract:

- `docs/shahab/SHAHAB_ADOBE_HOST_VERSION_MATRIX.md` lists Audition 25.x on Windows 11 x86_64 and macOS 14/15 arm64/x86_64; both live-host tests are `NOT_TESTED`.
- `docs/AVAPARDAZ/HARDWARE-COMPATIBILITY-MATRIX.md` lists a broader desktop-plugin candidate range: Windows 10/11 x86_64, Windows 11 ARM64 (conditional on Audition support), macOS Apple Silicon, and macOS Intel. Every Audition desktop row remains `Unverified`.

These documents are not evidence that any listed combination is supported. In particular, they differ on Windows 10, Windows ARM64, and whether Intel macOS is part of the required compatibility set. The current roadmap requires both macOS and Windows, but does not itself freeze these architecture/version sub-targets.

**R0 action:** preserve these combinations as candidates only. Do not mark them Supported or Verified until the product owner freezes the internal support matrix and live host acceptance evidence is collected. The exact Audition build, minimum OS builds, CPU architectures, minimum hardware, and input/output formats remain open.

### 15.5. R0 decision and blocker inventory

| Item | Current classification | Next required action |
|---|---|---|
| GitHub Actions runner/job initialization | BLOCKED / cause UNKNOWN | Repository owner checks Actions policy and account usage/spending limits; rerun the existing workflows and capture the first actual step |
| Audition × OS × CPU support matrix | OPEN / candidate evidence only | Freeze exact target combinations; then run live host acceptance on both operating systems |
| Internal package trust and distribution | OPEN / owner decision | Decide internal cohort installation/update trust model and whether signing/notarization is required for that model |
| Minimum hardware and supported audio formats | OPEN / not established | Define reproducible minimum configurations and format acceptance against the current renderer/host workflow |
| Physical macOS and Windows host evidence | BLOCKED / NOT_TESTED | Obtain authorized host access and execute the same acceptance protocol on each platform |

No product scope change is proposed by this audit. These are unresolved acceptance inputs, not decisions made by engineering.

### 15.6. Current status

- R0: **IN PROGRESS**.
- CI application commands: **NO EXECUTION EVIDENCE** from the latest runs.
- Live Audition GUI acceptance: **NOT_TESTED** on both target operating systems.
- Candidate platform combinations: **NOT APPROVED / NOT VERIFIED**.
- Product source and CI gate definitions: **UNCHANGED** by this update.
- No R0 gate is passed.


## 16. اصلاح انتساب اجرای CI به commit و تأیید runner_id (2026-11-27)

بازخوانی مستقیم REST endpointهای GitHub Actions جزئیات دقیق‌تری از دو اجرای بخش ۱۵ فراهم کرد و لازم است عبارت «روی HEAD جاری PR» دقیق‌تر شود:

- commit فعلی PR هنگام این اصلاح: `0c5e260894646f2bde5501ea2af526e2a1ea2aea` (ثبت‌شده در 14:25:20 UTC).
- دو اجرای `46014529274` و `46014529304` در 14:17:07 UTC ایجاد شده‌اند و هر دو Job، صریحاً `head_sha=7c19e312d2dcbc907fdc44f6696b498bc07aacde` دارند.
- بنابراین این دو اجرا مربوط به commit قبلی PR هستند، نه commit فعلی `0c5e260`. گزارش بخش ۱۵ نباید به‌عنوان CI اجراشده روی commit جدید تفسیر شود.
- REST Job payload برای اجرای Architecture Governance نشان می‌دهد: `runner_id=0`، `runner_name=""` و `steps=[]`.
- REST Job payload برای AVAPARDAZ Level 1 نیز همین مقادیر را نشان می‌دهد. دو Job وابسته Level 2–4 و Level 5 با conclusion برابر `skipped` ثبت شده‌اند.
- هر دو Job اصلی حدود دو ثانیه پس از ایجاد خاتمه یافته‌اند.

**نتیجه اصلاح‌شده:** شواهد مستقیم، شکست پیش از تخصیص Runner را برای commit `7c19e312` تأیید می‌کند. برای commit فعلی `0c5e260` هنوز اجرای CI مشاهده نشده است؛ پس نباید ادعا کرد که commit فعلی CI را اجرا کرده یا در آن شکست خورده است. پس از رفع مانع Actions، اجرای جدید روی HEAD فعلی لازم است.

### وضعیت lockfile و ممیزی زنجیره تأمین — نکته تکمیلی

بازخوانی فایل‌های واقعی روی `main` تأیید کرد:

- `package.json` دارای scriptهای lint، build، unit، quality-gate، stress و e2e است.
- CI اصلی نصب را با `bun install --frozen-lockfile` انجام می‌دهد و SBOM را از Bun تولید می‌کند.
- Workflow مربوط به AVAPARDAZ در Level 5 فقط در صورت وجود `package-lock.json`، `npm audit` را اجرا می‌کند؛ در غیر این صورت صرفاً warning می‌دهد که npm audit قادر به ممیزی `bun.lock` نیست.
- بنابراین وجود SBOM به‌تنهایی اثبات نمی‌کند که advisory/vulnerability scan برای dependency graph قفل‌شده انجام شده است. یک اسکن آسیب‌پذیری سازگار با lockfile واقعی هنوز باید به‌عنوان نیاز R0/R6 تعیین‌تکلیف شود.
- هیچ lockfile موازی یا صوری ایجاد نشد و هیچ dependency یا workflow در این مرحله تغییر نکرد.

### Traceability

این اصلاح صرفاً مستنداتی است. PR #6 باز و Draft باقی می‌ماند؛ `main`، کد محصول و CI gateها بدون تغییرند. R0 همچنان IN PROGRESS است و هیچ تست اجرایی PASS نشده است.


## 17. CI result on the current PR HEAD (2026-11-27)

پس از commit `0c5e260894646f2bde5501ea2af526e2a1ea2aea`، دو workflow اصلی روی همین SHA اجرا شدند:

- [AVAPARDAZ Quality & Release Gates — run 46015793367](https://github.com/bijanbijane/Audiocode/actions/runs/46015793367)
- [Architecture Governance — run 46015793347](https://github.com/bijanbijane/Audiocode/actions/runs/46015793347)

GitHub REST Job payload برای هر دو Job اصلی، `head_sha=0c5e260894646f2bde5501ea2af526e2a1ea2aea` را تأیید می‌کند و جزئیات زیر را ثبت کرده است:

- AVAPARDAZ Level 1: `runner_id=0`، `runner_name=""`، `steps=[]`؛ شکست در حدود یک ثانیه.
- Architecture Governance: `runner_id=0`، `runner_name=""`، `steps=[]`؛ شکست در حدود دو ثانیه.
- AVAPARDAZ Level 2–4 و Level 5: `skipped`.

**نتیجه:** این بار همان شکست پیش از تخصیص Runner مستقیماً روی HEAD فعلی PR نیز تأیید شد. هیچ command پروژه اجرا نشده است؛ پس هنوز هیچ نتیجه‌ای درباره سلامت یا نقص lint، تست، build، بسته‌بندی یا کد محصول نداریم. علت نهایی همچنان UNKNOWN است.

تلاش برای خواندن Repository Actions permissions از GitHub connector با محدودیت endpoint مجاز متوقف شد؛ تنظیمات Billing و spending limit نیز از دسترس این اتصال خارج است. بنابراین رفع مانع نیازمند بررسی تنظیمات از سوی مالک مخزن/حساب است.

### وضعیت

- PR #6: OPEN / DRAFT / NOT MERGED.
- main: بدون تغییر.
- source code و CI workflow definitions: بدون تغییر.
- R0: IN PROGRESS؛ هیچ Gate عبور نکرده است.
- تست اجرایی PASS: صفر.
