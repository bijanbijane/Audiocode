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
