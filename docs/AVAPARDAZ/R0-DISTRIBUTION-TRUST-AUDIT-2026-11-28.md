# R0 Distribution, Installation & Trust Audit

**Date:** 2026-11-28  
**Roadmap:** `AVP-DELIVERY-ROADMAP-1.1`  
**Task:** `R0-DIST-07` — Internal installation and trust model  
**Scope:** Internal V1 only; Adobe Audition CEP + Native Companion + shared Core; macOS and Windows  
**Status:** `IN PROGRESS — platform matrix approved; packaging and trust implementation gaps remain`

## Executive finding

The repository contains packaging and update-engine components, but the current end-to-end installer path is not yet a verified macOS + Windows internal-release workflow. The CEP-only installers, full release packager, and lifecycle/update engine are separate pieces with incomplete integration. The release trust path is also not cryptographically closed: current CEP package metadata explicitly says unsigned and unnotarized, while the update engine accepts a caller-supplied signature-status enum and does not itself verify a signed manifest.

Do not mark `R0-DIST-07`, `R0-PLATFORM-05`, or `R0-HOST-06` complete based on packaging-engine unit tests or Linux CI alone.

## Verified repository evidence

### 1. Platform target mismatch

- At the time of the initial audit, `ProductionReleaseAndBetaEngine.ts` declared only `darwin-arm64` and `linux-x64`. The follow-up branch aligns it to the owner-approved `darwin-arm64`, `darwin-x64`, and `win32-x64` matrix; the target registry is in `scripts/release-targets.mjs`.
- The owner approved Windows 11 x64, macOS 14/15 Apple Silicon, and macOS 14/15 Intel, all with Adobe Audition 25.x (ADR-027). These target selections are approved; physical-host validation, exact OS build coverage, minimum hardware, and supported audio formats remain unverified or open.
- `packages/audition-cep-plugin/CSXS/manifest.xml` currently declares Audition host `AUDT [22.0,99.9]` and CSXS 11.0. This is a broad compatibility declaration, not a verified host matrix.

### 2. Two different installer paths

**CEP-only package**

- `packages/audition-cep-plugin/scripts/package-plugin.mjs` creates a `.tar.gz` archive and a SHA-256 file manifest.
- The generated release manifest explicitly sets `codeSigned: false` and `notarized: false`; it states that production distribution requires Apple Developer ID, Windows Authenticode, and ZXPSignCmd signing credentials. The prior R0 baseline audit explicitly re-scoped public signing as not automatically mandatory for an internal release; the internal trust policy remains an owner decision, not an assumed production requirement.
- `install-macos.sh` and `install-windows.ps1` copy only the CEP extension files into Adobe's CEP extension directory. They do not install the Companion daemon, native runtime, or ASR models, and they do not register or start a Companion background process.
- Optional beta debug switches set CEP `PlayerDebugMode` for CSXS 11 and 12. This is a machine-wide CEP debug setting, not an AVAPARDAZ-only trust grant; it must remain opt-in and must not be enabled in a production installer.
- The plugin installer scripts use recursive copy/merge rather than a versioned atomic swap. Existing extension files may remain when a later package removes or renames files.

**Full release package**

- `scripts/build-release-installer.mjs` packages the web app, Companion bundle, Sherpa runtime, models, and CEP extension under a versioned, target-specific package directory.
- The follow-up branch generates `installer/install.mjs`, `install-macos.sh`, and `install-windows.ps1`; it rejects OS/architecture mismatches and Node.js below 20. This is still not a verified Windows installer workflow, and it does not register a Windows service/task for Companion.
- The generated `install.mjs` requires Node.js. During this audit its header/help text was corrected to state `Node.js 20 or newer`; the package still does not bundle a Node runtime or a native launcher.
- The generated installer copies the CEP extension into the package's `cep-extension/` directory under the install root; it does not copy it into the actual Adobe CEP extension directory. It also does not register or start the Companion daemon. The separate CEP installer is not invoked by this full installer.
- The installer refuses to overwrite a non-empty target directory. The generated update tarball is a copy of the package with a changed version/build ID; this script does not apply it through `ComponentUpdateOrchestrator`, perform an in-place update, or execute rollback.
- The generated install script previously resolved its own location from `new URL(import.meta.url).pathname`, which is unsafe for portable Windows file URLs. This was corrected on the PR branch in commit `a188667a125dac46b531137cf132b8db5f654910` by using `fileURLToPath(import.meta.url)`. The misleading “Zero-Terminal / Self-Contained” header/help was corrected in `1eab866d127651d5bea1630a98380358a5b66320` to state the Node.js 20+ requirement; a Vitest regression spec was added in `4da63a52631435e9bc9015a58baeda13dc99ab6d` and expanded to assert the runtime requirement. The installer regression spec passed 1/1 in Vitest on PR-head commit `3818431e5b18169a335eed5b54ab56e2e7f9b916` (Architecture Governance run [46131619653](https://github.com/bijanbijane/Audiocode/actions/runs/46131619653)); actual Windows execution remains unverified.
- The packager validates the primary Koochik ONNX model and token file against pinned byte counts and SHA-256 values before copying them into the payload. The package manifest also records build identity, platform/architecture, dirty-worktree state, and per-component SHA-256 hashes. These are useful build-time integrity checks, but the manifest itself is unsigned and the generated installer does not authenticate it against a pinned trust root.

### 3. Update authenticity is not yet end-to-end

- `src/lifecycle/ProductDeliveryAndUpdateEngine.ts` defines `UpdateManifest.signatureStatus` as a caller-provided enum: `SIGNATURE_VERIFIED`, `UNSIGNED_CHECKSUM_ONLY`, or `SIGNATURE_INVALID`.
- `executeSafeUpdate` rejects an invalid status and rejects unsigned status only when the caller sets `requireCryptographicSignature: true`. That flag is optional and defaults to permissive behavior.
- The engine validates the supplied status and SHA-256 value; it does not parse a signature, select a trusted public key, or perform cryptographic signature verification itself.
- The current CEP package manifest explicitly declares unsigned/unnotarized output. No detached signature or repository-owned trust-root verification was identified in the reviewed packaging path.

### 4. Install/uninstall ownership is split

- The CEP-only uninstallers remove the CEP extension directory and a runtime subdirectory under their respective app-support locations; models are preserved unless an explicit remove-models switch is supplied.
- The full package uninstaller removes directories under its own install root, but does not remove a CEP extension that was separately installed into Adobe's actual CEP extension directory.
- Neither installer path registers or removes a macOS LaunchAgent or Windows service/task for Companion. Companion currently has a manual daemon entrypoint at `companion/avapardaz-companion.ts`; the packaged `.mjs` bundle is not wired into OS startup by the inspected installer.
- The CEP-only installers create `Application Support/AVAPARDAZ` or `%LOCALAPPDATA%/AVAPARDAZ` directories but do not populate them with a runtime/model package. The native engine's default roots are `AVAPARDAZ_HOME` (default `~/AvaPardaz`) and `~/.avapardaz`; any future installer must keep install and discovery paths consistent.

## Risk register

| Priority | Gap | Consequence |
|---|---|---|
| P0 | No verified Windows platform target in the release engine | Cannot claim approved dual-platform V1 support |
| P0 | Full installer does not install/register the CEP extension or start Companion | A successful file copy does not yield a ready Audition workflow |
| P0 | No end-to-end cryptographic package/update authenticity | SHA-256 manifest alone does not protect against artifact + manifest replacement |
| P1 | No signed/notarized CEP ZXP or signed OS installer | Gatekeeper, SmartScreen, and CEP trust friction; production signing not ready |
| P1 | Update tarball is staged metadata, not an applied atomic update | Update/rollback behavior is not proven by the generated artifact |
| P1 | Node runtime is not bundled and the installer requires Node | “Self-contained / zero-terminal” installation claim is not met |
| P1 | Split install/uninstall paths do not manage the same files or Companion lifecycle | Orphaned extension/runtime or a non-starting Companion is possible |
| P2 | CEP install copy is not atomic and can retain stale files | Upgrade can leave a mixed-version extension |
| P2 | Reproducible archive claim is not demonstrated by the current tar invocation | Repeated packaging may produce different archive hashes |

## Recommended internal V1 direction (proposal, not an approved decision)

1. Keep the pilot explicitly **internal and device-controlled**. Do not publish a public installer or enable auto-update until authenticity verification is implemented.
2. Define one canonical per-user install root and one install manifest. The installer must place the Companion, runtime, models, and CEP extension in locations that match runtime discovery.
3. Provide separate verified macOS and Windows packaging jobs. Do not infer Windows support from a generic Node installer or a Windows binary filename.
4. Use an atomic CEP extension install with a versioned backup and rollback. Preserve user projects, transcripts, source media, and models by default.
5. Make Companion startup behavior explicit. A manual start command is the lowest-risk pilot option; a LaunchAgent / Windows scheduled task should be a separate approved design with clear stop/uninstall behavior.
6. Before enabling an updater, verify a detached signed release manifest against a pinned public key in code. SHA-256 remains necessary for integrity but is not a substitute for authenticity.
7. Keep CEP `PlayerDebugMode` disabled by default and document that enabling it changes a global Adobe CEP trust setting.

## Owner decisions required

| Decision | Options requiring owner selection | Engineering consequence |
|---|---|---|
| Exact platform matrix | **RESOLVED (ADR-027):** Windows 11 x64, macOS 14/15 arm64 + Intel, Adobe Audition 25.x | Determines native binaries, runtime packaging, and live acceptance matrix |
| Internal signing policy | Controlled unsigned pilot with explicit risk acceptance vs obtain Apple Developer ID / Authenticode / ZXPSignCmd credentials | Determines installer formats, Gatekeeper/SmartScreen behavior, and release trust gate |
| Companion startup | Manual user launch vs OS user-level background startup | Determines LaunchAgent / Task Scheduler integration and lifecycle ownership |
| Update policy | Manual versioned install with backup vs signed atomic auto-update | Determines rollback, signing, and recovery implementation |
| Node dependency | Require a preinstalled supported Node runtime vs bundle a runtime / compile a launcher | Determines whether “self-contained” installation is achievable |

## Next engineering steps after decisions

1. Produce and qualify a per-platform dependency manifest and native runtime payload for each approved target.
2. Implement a single install/uninstall orchestrator that registers the CEP extension, installs the Companion/runtime/models, and never deletes user data implicitly.
3. Add Windows packaging and a Windows-native install/verification job; separately validate macOS arm64 and any approved Intel target.
4. Add actual detached-signature verification with a pinned trust root; require it for updates.
5. Add integration tests for clean install, repair, upgrade, rollback, and uninstall on each approved OS.
6. Perform live Audition acceptance on authorized physical macOS and Windows hosts.

**No installer was executed on a user's machine, no signing credentials were used, and no production or live-service operation was performed during this audit.**


## 8. Owner decision and target-specific packaging implementation (2026-11-28)

### 8.1. Approved internal host matrix

The project owner approved the following exact target matrix for internal V1:

| Target ID | OS | CPU architecture | Adobe Audition |
|---|---|---|---|
| `darwin-arm64` | macOS 14 / 15 | Apple Silicon | 25.x |
| `darwin-x64` | macOS 14 / 15 | Intel | 25.x |
| `win32-x64` | Windows 11 | x64 | 25.x |

This resolves the previous owner decision about platform/architecture selection. It does **not** convert any target to VERIFIED or ACCEPTED; physical-host and Audition validation remains outstanding.

### 8.2. Code changes on the follow-up engineering branch

Branch: `feat/r6-target-specific-release-packaging`, based on the reviewed R0 documentation head.

- Added `src/asr-core/NativeReleaseTargets.mjs` as the shared source of truth for the three approved targets and pinned Sherpa runtime archive provenance; `scripts/release-targets.mjs` remains a compatibility re-export.
- Added tests for the exact matrix, target artifact selection, unsupported target rejection, and runtime-target mismatch rejection.
- Updated `scripts/build-release-installer.mjs` to select native runtime artifacts from the explicit release target rather than the packager host, require `AVAPARDAZ_SHERPA_RUNTIME_TARGET` to match, include target/build-host identity in the package manifest, and suffix package/update artifacts with the target ID.
- Generated installers now reject a mismatched OS/CPU and Node.js versions below 20 before copying payload files.
- Added a Windows PowerShell installer wrapper (`install-windows.ps1`) alongside the macOS wrapper.
- Added `scripts/provision-release-native-runtime.ts` to download the exact pinned asset, verify byte count and SHA-256, safely extract it, validate all Mach-O/PE binaries and shared libraries, write a runtime manifest, and execute a real `--help` smoke test.
- Updated `LocalSherpaNeuralEngine.installShenavaRizehRuntime()` to provision the approved macOS and Windows targets; Linux x64 retains its existing development/runtime path.
- Fixed Companion discovery of Windows DLLs and `PATH` loading; macOS supports versioned dylibs and `DYLD_LIBRARY_PATH`.
- The packager now copies all target shared libraries and prefers the verified target-specific runtime directory.
- Updated `ProductionReleaseAndBetaEngine` release metadata to `darwin-arm64`, `darwin-x64`, and `win32-x64`.

### 8.3. Build invocation contract

For each package, set all of the following explicitly:

- `AVAPARDAZ_TARGET_PLATFORM`: `darwin` or `win32`
- `AVAPARDAZ_TARGET_ARCH`: `arm64` or `x64`
- `AVAPARDAZ_SHERPA_RUNTIME_TARGET`: exact target ID, such as `win32-x64`
- `AVAPARDAZ_SHERPA_RUNTIME_DIR`: target-specific runtime root containing `bin/`, `lib/`, and a verified `runtime-manifest.json`.
- Optional `AVAPARDAZ_SHERPA_RUNTIME_LIB_DIR`: explicit shared-library directory override.

Before packaging, run `bunx tsx scripts/provision-release-native-runtime.ts` on a native host matching the requested target. The provisioner verifies the pinned upstream archive's exact byte count and SHA-256, checks all native binary/library architectures, writes the runtime manifest, and executes the real Sherpa CLI `--help` smoke test. The package builder rechecks the manifest and every binary/library hash, then embeds the manifest in the final payload. The manifest is a local provenance record; final release signing and trust-root verification remain separate mandatory gates.

The explicit runtime-target variable is a build provenance assertion, not cryptographic proof that the binary bytes truly match the target. The package still needs artifact-level inspection/signing and execution on the destination OS. Cross-target packaging must never reuse the host's native runtime merely because a filename happens to exist.

### 8.4. Remaining blockers

- Official Sherpa-ONNX v2.0.2 runtime archives are now pinned by byte count and SHA-256 and were downloaded, extracted, architecture-checked, and smoke-tested on hosted macOS 15 arm64, macOS 15 Intel, and Windows Server 2025 x64 runners.
- The full release packager itself has not yet been executed end-to-end because the production web build and verified Persian model payloads were not available through this repository-only workflow.
- Windows 11 physical-host installation is not yet tested; the Windows runtime smoke ran on Windows Server 2025 x64. macOS 14 is not available as a current GitHub-hosted runner; physical macOS 14/15 acceptance remains required.
- Adobe Audition 25.x integration remains unverified on all three target IDs.
- Internal signing/trust policy, pinned signature verification for the final product package, Companion startup registration, CEP registration into the host's actual extension directory, and atomic update/rollback integration remain open.

The platform matrix is **APPROVED**, but platform support is still **NOT VERIFIED**. R0 distribution work remains IN PROGRESS.


### 8.5. Native binary architecture verification and CI evidence (2026-11-28)

The follow-up implementation adds `scripts/verify-native-binary.mjs`:

- macOS: parses thin Mach-O CPU type and Universal/Fat Mach-O architecture slices; accepts only the requested `arm64` or `x64` slice.
- Windows: validates the DOS header, PE signature, and PE Machine field; the current approved Windows target is `x64`.
- The packager validates the Sherpa executable and every shared library, requires the target-specific runtime manifest, rechecks all recorded hashes against the pinned release asset, and embeds that manifest in the release payload.
- A missing ONNX Runtime library now fails explicitly. The prior check tested only whether a non-empty path string existed, which could never detect a missing file.
- Synthetic regression coverage includes Mach-O arm64, Mach-O x64, Universal Mach-O, PE x64, missing/malformed binaries, and architecture mismatch.

**Automated evidence on PR #7 head `4959fdddb3f3a7205a800e80562de76b282aa2ec`:**

| Workflow | Result |
|---|---|
| AVAPARDAZ Quality & Release Gates | SUCCESS |
| Architecture Governance, Reliability & Release Quality Gate | SUCCESS |
| TypeScript compilation / lint | PASS |
| Vitest | 26 files / 109 tests PASS |
| Native binary verifier suite | 4 tests PASS |
| Unit / reliability / fault-injection | PASS |
| End-to-end quality gates | PASS |
| Production build and release manifest verification | PASS |
| Audition CEP manifest / CSP hygiene | PASS |

The first two CI attempts exposed a nested-template syntax error and then strict TypeScript fixture typing errors; both were corrected before the successful head above. These results validate the code paths and synthetic fixtures on GitHub's Linux runner. They do **not** prove that supplied native runtime payload bytes are valid for any of the three destination operating systems, nor do they replace execution on physical macOS/Windows hosts with Audition 25.x.

Remaining gates are unchanged: real target runtime acquisition/build, artifact provenance/signing, physical-host installation and update/rollback tests, CEP host registration, and Companion startup/lifecycle validation.


### 8.6. Cross-platform parser CI

A dedicated CI matrix was added to `.github/workflows/ci-quality-gate.yml` for the R6 qualification PR:

- `ubuntu-latest`
- `macos-15` (Apple Silicon)
- `macos-15-intel`
- `windows-latest`

The matrix installs the frozen Bun dependencies and runs `bunx vitest run scripts/verify-native-binary.spec.ts`, recording each runner's `process.platform` and `process.arch`. It is scoped to PR head `feat/r6-target-specific-release-packaging` so the stacked R0 baseline PR does not run a test file that exists only in the follow-up branch.

This matrix validates parser behavior and filesystem/test portability across hosted OS runners using synthetic Mach-O/PE fixtures. It does **not** build Sherpa native binaries, verify downloaded production payloads, or replace physical host installation tests. The first `macos-14` job was cancelled before steps started; after switching to `macos-latest`, all three matrix jobs completed successfully on the latest qualification run.


**Successful cross-platform evidence on PR #7 head `5d31165ee455f288c8de67baeb8b1c086fc21f62`:**

| Hosted runner | Actual runtime | Result |
|---|---|---|
| macos-15 | `darwin-arm64` | 5/5 tests PASS |
| macos-15-intel | `darwin-x64` | 5/5 tests PASS |
| ubuntu-latest | `linux-x64` | 5/5 tests PASS |
| windows-latest | `win32-x64` | 5/5 tests PASS |

The macOS runner was Apple Silicon. The Windows runner was x64. This proves the parser tests execute successfully on those runner environments, not that the product's target-native Sherpa/ONNX payloads have been built or installed there.


### 8.7. Official runtime assets — provenance and real host smoke tests

The runtime source is the official [k2-fsa/sherpa-onnx v2.0.2 release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.2). The archive byte counts and SHA-256 values below are pinned in `src/asr-core/NativeReleaseTargets.mjs` and checked before extraction:

| Target | Release asset | Bytes | SHA-256 |
|---|---|---:|---|
| `darwin-arm64` | `sherpa-onnx-v2.0.2-osx-arm64-shared-no-tts.tar.bz2` | 20,197,239 | `1a803809572335ef545978b62b0271ad119969fef6f9153a94c174c3adc95608` |
| `darwin-x64` | `sherpa-onnx-v2.0.2-osx-x64-shared-no-tts.tar.bz2` | 22,763,064 | `c1f69c0752ec7deef44eb8662e4489330513e514c64db5251879950e77066eaf` |
| `win32-x64` | `sherpa-onnx-v2.0.2-win-x64-shared-MT-Release-no-tts.tar.bz2` | 26,896,305 | `6a71d5ef016e544026d6505486d9fa42177ad989238adc6e4bd2eebfb6947416` |

**Real runtime provisioning evidence on PR #7 head `5d31165ee455f288c8de67baeb8b1c086fc21f62`:**

| Product target | Hosted runner / actual runtime | Binary and libraries | `--help` smoke |
|---|---|---|---|
| `darwin-arm64` | macOS 15 / `darwin-arm64` | Mach-O arm64; 3 dylibs | PASS |
| `darwin-x64` | macOS 15 Intel / `darwin-x64` | Mach-O x64; 3 dylibs | PASS |
| `win32-x64` | Windows Server 2025 / `win32-x64` | PE x64; 2 DLLs | PASS |

For every target, the provisioning job verified the archive's exact byte count and SHA-256, safely extracted it, checked the executable and all shared-library architectures, and ran the actual Sherpa CLI `--help` command successfully. No binary payloads were committed to the repository.

The safe extractor continues to reject symlinks by default. For these pinned native archives only, it accepts same-directory relative symlinks under a `lib` directory and materializes them as regular files; absolute links, parent traversal, link chains, hardlinks, and links outside `lib` remain forbidden.

### 8.8. Latest CI checkpoint — PASS

Latest fully validated PR #7 CI head for the full native + package matrix: `b60afa999b7a0892c81742ac8710b893cdbac4ba`.

Both applicable GitHub Actions workflows completed with `SUCCESS`:

- **AVAPARDAZ Quality & Release Gates:** Levels 1–5 all PASS, including production web build, ORT/ASR/DSP, IPC/security, CEP packaging and supply-chain gates.
- **Architecture Governance, Reliability & Release Quality Gate:** Vitest 31 files / 134 tests PASS (including CPU preflight regression cases); Node unit/reliability/fault-injection suite 32 tests PASS; TypeScript compilation, zero-circular dependency check (730 files), SBOM generation, license audit, production build, E2E quality gates and release-manifest verification PASS.
- The same Architecture workflow's native binary parser matrix passed on Ubuntu, macOS 15 arm64, macOS 15 Intel, and Windows x64.
- Its three real native runtime provisioning jobs passed on macOS 15 arm64, macOS 15 Intel, and Windows Server 2025 x64, including pinned archive SHA-256/byte verification, binary/library architecture validation, actual CLI `--help` smoke tests, and CPU feature probes (`NEON`, `AVX2`, `AVX2`) on the corresponding hosts.
- **Cross-target Internal Installer Package Build:** PASS. Built unsigned Installer and Update tarballs for all three targets (six packages total); verified every tarball byte length/SHA-256 and the embedded target/model provenance. All three targets printed `hashes, embedded manifest, installer syntax and provenance PASS`; generated `install.mjs`, `uninstall.mjs`, and CPU helper passed `node --check`, macOS shell wrappers passed `bash -n`, and the manifest-only CI artifact was uploaded (artifact ID `15263232073`).

The earlier stale source assertion and malformed symlink test fixture were corrected; the full native/runtime/package and installer syntax verification run is green. This does **not** mean the full release installer or physical Adobe hosts are accepted.

GitHub-hosted macOS 14 runners are retired; current CI validates macOS 15 arm64 and Intel. Windows hosted smoke is Windows Server 2025, not Windows 11. Physical-host and Audition acceptance remain separate gates.


### 8.9. CPU floor and runtime manifest integrity

The shared target registry declares `requiredCpuFeatures`: `NEON` for `darwin-arm64`, and `AVX2` for the two x86_64 Audition 25.x targets. These are now actively probed: Intel macOS uses `sysctl -n hw.optional.avx2_0`; Windows x64 uses `IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE=40)` through PowerShell; Apple Silicon accepts NEON as an AArch64 baseline only for `darwin-arm64`. Unsupported feature/target pairs fail closed. The generated installer performs this check before creating or copying installation files.

The provisioner runs the CPU probe on the actual target host and records `cpuFeatureProbe.required/checked` in `runtime-manifest.json`. The package builder requires those values to match the target's required features, checks target ID, pinned archive name/bytes/SHA-256, executable hash, ONNX library hash, and the complete shared-library set and hashes. It embeds the verified manifest and CPU probe evidence into the package payload and package manifest. This is local build provenance/integrity validation; release signing and trust-root verification are still mandatory and not implemented.


### 8.10. Koochik model license provenance

The Koochik model's initial upstream README at revision `b67cd889f37746469b1396cf4236682aec72fd6d` declared `cc-by-nc-4.0`, while later repository metadata was inconsistent. The author published the verified corrective commit [`158e40e9ccf166c3655b7f4cd2abbfc7bbc87f7a`](https://huggingface.co/Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx/commit/158e40e9ccf166c3655b7f4cd2abbfc7bbc87f7a), changing README frontmatter to `apache-2.0` and adding the Apache 2.0 LICENSE file. The commit changes only README and LICENSE; the existing pinned model/token blobs remain unchanged.

The new provisioner pins this exact revision and verifies:
- model ONNX bytes/SHA-256 and tokens bytes/SHA-256,
- README frontmatter says `apache-2.0`,
- LICENSE contains the Apache License 2.0 text,
- model manifest records repository, immutable revision, license and hashes.

The package builder now refuses an unmanifested model directory and embeds README, LICENSE and `model-manifest.json` in the release payload. CI has a cached Koochik provisioning/license-validation job; its first run is pending after the workflow update. The CI provenance/license job passed on run `46144552901`. Details: `MODEL-LICENSE-AUDIT-2026-11-28.md`.


### 8.11. Cross-target package build and manifest integrity — PASS

On PR #7 head `b60afa999b7a0892c81742ac8710b893cdbac4ba`, the `Cross-target Internal Installer Package Build` job completed successfully after the three verified runtime artifacts and pinned Koochik model were downloaded.

| Target | Installer tarball | Update tarball | Integrity / provenance |
|---|---:|---:|---|
| darwin-arm64 | 444.50 MiB | 444.50 MiB | PASS |
| darwin-x64 | 446.04 MiB | 446.04 MiB | PASS |
| win32-x64 | 442.00 MiB | 442.00 MiB | PASS |

For all six packages, CI recomputed the tarball byte length and SHA-256, checked target ID, immutable Koochik revision and Apache-2.0 license metadata, and emitted a PASS line for each target. The `avapardaz-target-release-manifests` artifact was uploaded (artifact ID `15263232073`). The unsigned tarballs remained in the ephemeral runner workspace and were not published.

The corrected schema assertion reads `packageManifest.components.primaryPersianAsrModel`; the earlier root-level assertion was incorrect. This closes the hosted CI package-build and integrity gate, not signing, installation, update activation, or physical-host acceptance.

Latest fully validated feature head: `b60afa999b7a0892c81742ac8710b893cdbac4ba`. Architecture Governance run `46144552901` completed SUCCESS; all three CPU probes and all six unsigned Installer/Update package integrity checks passed.
