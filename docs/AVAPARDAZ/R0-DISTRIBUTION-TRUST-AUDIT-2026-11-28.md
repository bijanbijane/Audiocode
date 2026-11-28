# R0 Distribution, Installation & Trust Audit

**Date:** 2026-11-28  
**Roadmap:** `AVP-DELIVERY-ROADMAP-1.1`  
**Task:** `R0-DIST-07` — Internal installation and trust model  
**Scope:** Internal V1 only; Adobe Audition CEP + Native Companion + shared Core; macOS and Windows  
**Status:** `BLOCKED — owner decisions and platform implementation gaps`

## Executive finding

The repository contains packaging and update-engine components, but the current end-to-end installer path is not yet a verified macOS + Windows internal-release workflow. The CEP-only installers, full release packager, and lifecycle/update engine are separate pieces with incomplete integration. The release trust path is also not cryptographically closed: current CEP package metadata explicitly says unsigned and unnotarized, while the update engine accepts a caller-supplied signature-status enum and does not itself verify a signed manifest.

Do not mark `R0-DIST-07`, `R0-PLATFORM-05`, or `R0-HOST-06` complete based on packaging-engine unit tests or Linux CI alone.

## Verified repository evidence

### 1. Platform target mismatch

- `src/lifecycle/ProductionReleaseAndBetaEngine.ts` declares `supportedPlatforms: ['darwin-arm64', 'linux-x64']`; Windows is absent, and macOS Intel is absent.
- The approved V1 scope requires macOS + Windows. The exact OS builds, Audition versions, CPU architectures, minimum hardware, and supported audio formats are still not owner-approved.
- `packages/audition-cep-plugin/CSXS/manifest.xml` currently declares Audition host `AUDT [22.0,99.9]` and CSXS 11.0. This is a broad compatibility declaration, not a verified host matrix.

### 2. Two different installer paths

**CEP-only package**

- `packages/audition-cep-plugin/scripts/package-plugin.mjs` creates a `.tar.gz` archive and a SHA-256 file manifest.
- The generated release manifest explicitly sets `codeSigned: false` and `notarized: false`; it states that production distribution requires Apple Developer ID, Windows Authenticode, and ZXPSignCmd signing credentials.
- `install-macos.sh` and `install-windows.ps1` copy only the CEP extension files into Adobe's CEP extension directory. They do not install the Companion daemon, native runtime, or ASR models, and they do not register or start a Companion background process.
- Optional beta debug switches set CEP `PlayerDebugMode` for CSXS 11 and 12. This is a machine-wide CEP debug setting, not an AVAPARDAZ-only trust grant; it must remain opt-in and must not be enabled in a production installer.
- The plugin installer scripts use recursive copy/merge rather than a versioned atomic swap. Existing extension files may remain when a later package removes or renames files.

**Full release package**

- `scripts/build-release-installer.mjs` packages the web app, Companion bundle, Sherpa runtime, models, and CEP extension under a versioned package directory.
- It generates `installer/install.mjs` and an `install-macos.sh` wrapper. It does not generate a Windows PowerShell wrapper or a Windows service/task registration path. The generic Node installer may be invoked manually on Windows when a compatible Node runtime is present, but that is not a verified Windows installer workflow.
- The generated `install.mjs` requires Node.js. During this audit its header/help text was corrected to state `Node.js 20 or newer`; the package still does not bundle a Node runtime or a native launcher.
- The generated installer copies the CEP extension into the package's `cep-extension/` directory under the install root; it does not copy it into the actual Adobe CEP extension directory. It also does not register or start the Companion daemon. The separate CEP installer is not invoked by this full installer.
- The installer refuses to overwrite a non-empty target directory. The generated update tarball is a copy of the package with a changed version/build ID; this script does not apply it through `ComponentUpdateOrchestrator`, perform an in-place update, or execute rollback.
- The generated install script previously resolved its own location from `new URL(import.meta.url).pathname`, which is unsafe for portable Windows file URLs. This was corrected on the PR branch in commit `a188667a125dac46b531137cf132b8db5f654910` by using `fileURLToPath(import.meta.url)`; a Vitest regression spec was added in `4da63a52631435e9bc9015a58baeda13dc99ab6d`. CI for that new spec is pending, and actual Windows execution remains unverified.
- The package manifest records build identity, platform/architecture, dirty-worktree state, and per-component SHA-256 hashes. These checksums detect accidental corruption only when the manifest itself is trusted; the manifest is not signed.

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
| Exact platform matrix | macOS arm64 only vs arm64 + Intel; Windows x64 vs x64 + arm64; exact Audition versions | Determines native binaries, runtime packaging, and live acceptance matrix |
| Internal signing policy | Controlled unsigned pilot with explicit risk acceptance vs obtain Apple Developer ID / Authenticode / ZXPSignCmd credentials | Determines installer formats, Gatekeeper/SmartScreen behavior, and release trust gate |
| Companion startup | Manual user launch vs OS user-level background startup | Determines LaunchAgent / Task Scheduler integration and lifecycle ownership |
| Update policy | Manual versioned install with backup vs signed atomic auto-update | Determines rollback, signing, and recovery implementation |
| Node dependency | Require a preinstalled supported Node runtime vs bundle a runtime / compile a launcher | Determines whether “self-contained” installation is achievable |

## Next engineering steps after decisions

1. Freeze the approved platform matrix and produce a per-platform dependency manifest.
2. Implement a single install/uninstall orchestrator that registers the CEP extension, installs the Companion/runtime/models, and never deletes user data implicitly.
3. Add Windows packaging and a Windows-native install/verification job; separately validate macOS arm64 and any approved Intel target.
4. Add actual detached-signature verification with a pinned trust root; require it for updates.
5. Add integration tests for clean install, repair, upgrade, rollback, and uninstall on each approved OS.
6. Perform live Audition acceptance on authorized physical macOS and Windows hosts.

**No installer was executed on a user's machine, no signing credentials were used, and no production or live-service operation was performed during this audit.**
