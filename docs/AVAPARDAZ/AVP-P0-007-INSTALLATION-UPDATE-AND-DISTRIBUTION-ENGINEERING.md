# AVP-P0-007 — Production Installation, Update Orchestration, Recovery & Distribution Engineering

**Status:** `IN PROGRESS (PINNED TARGET RUNTIMES + HOSTED-RUNNER SMOKE PASS; FULL INSTALLER, PHYSICAL HOST/AUDITION AND TRUST GATES OPEN)`  
**Primary Modules:**
- `src/lifecycle/ProductDeliveryAndUpdateEngine.ts`
- `src/lifecycle/index.ts`
- `src/lifecycle/ModelProvenanceAndDelivery.test.ts`

---

## 1. Delivery, Compatibility & Recovery Guarantees

1. **Independent Component Version & Compatibility Matrix (`evaluateComponentCompatibility`):** Tracks `webAppVersion`, `companionVersion`, `auditionCepVersion`, and `ipcProtocolVersion` independently and rejects incompatible major protocol mismatches.
2. **First-Run Readiness Verification (`evaluateFirstRunReadiness`):**
   - `BROWSER_ONLY` mode verifies WASM + OPFS + local model readiness with ZERO Companion requirement.
   - `NATIVE_AUDITION` mode verifies Companion + native dependency + Audition CEP + local model readiness with ZERO Browser requirement.
3. **17-State Atomic Update Orchestrator (`ComponentUpdateOrchestrator`):** Progresses through discovery, metadata, compatibility, authenticity, download, integrity, staging, activation, and post-activation verification; rejects invalid signatures, SHA-256 mismatches, or insufficient disk space; performs automatic atomic rollback (`UPDATE_ROLLED_BACK`) if post-activation health fails.
4. **Safe Uninstallation Planner (`buildSafeUninstallPlan`):** Stops Companion and cleans lock/IPC files while ALWAYS preserving `USER_PROJECTS`, `USER_SOURCE_MEDIA`, and `USER_EXPORTS` unless explicitly authorized.
5. **Environment-Separated Deployment Validator (`validateDeploymentConfiguration`):** Blocks production deployments enabling cloud ASR, debug endpoints, wildcard/unsafe CSP, missing `COOP: same-origin`, or missing self-hosted `/ort/` WASM assets.

## 2. Verified Automated Evidence

- `src/lifecycle/ModelProvenanceAndDelivery.test.ts`: **PASS** (component compatibility, independent Browser/Native first-run readiness, 17-state atomic update + rollback + bad-sig/hash/disk rejection, safe uninstall preservation, and production deployment validation).


## 10. Approved dual-platform target packaging update (2026-11-28)

The owner-approved internal target matrix is:

- `darwin-arm64`: macOS 14/15 Apple Silicon + Adobe Audition 25.x
- `darwin-x64`: macOS 14/15 Intel + Adobe Audition 25.x
- `win32-x64`: Windows 11 x64 + Adobe Audition 25.x

Implementation added on `feat/r6-target-specific-release-packaging`:

- Shared target registry in `src/asr-core/NativeReleaseTargets.mjs`, re-exported through `scripts/release-targets.mjs`.
- Target-specific native Sherpa executable and ONNX Runtime library selection.
- Fail-closed runtime target provenance assertion via `AVAPARDAZ_SHERPA_RUNTIME_TARGET`.
- Target-specific package/update directory and artifact names, plus target/build-host fields in package manifest.
- Generated installer OS/architecture and Node.js 20+ preflight.
- Generated Windows PowerShell launcher in addition to macOS shell launcher.
- Release engine supported-platform metadata aligned to the approved target list.
- Pinned official Sherpa-ONNX v2.0.2 runtime archives with GitHub-provided SHA-256 and exact byte counts for all three targets.
- Added `scripts/provision-release-native-runtime.ts` for verified download, safe extraction, native architecture checks, runtime manifest, and real CLI smoke test.
- Updated `LocalSherpaNeuralEngine` provisioning, Windows DLL discovery / `PATH`, and macOS versioned dylib discovery / `DYLD_LIBRARY_PATH`.
- Package builder copies all target-native shared libraries and prefers the verified target-specific runtime root.

The runtime-target environment variable remains a build provenance assertion, not a signature or binary-format verification. The official v2.0.2 native payloads were downloaded with pinned SHA-256 and byte counts, safely extracted, architecture-checked, and smoke-tested on hosted macOS 15 Apple Silicon, macOS 15 Intel, and Windows Server 2025 x64 runners. This does not equal physical Windows 11 or macOS 14 acceptance. Adobe Audition 25.x, CEP host registration, Companion startup registration, signed release verification, full installer execution, and atomic package update integration remain open; therefore this phase is IN PROGRESS, not VERIFIED.


## 11. Native runtime supply-chain qualification (2026-11-28)

Official upstream assets from [sherpa-onnx v2.0.2](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.2) are pinned in `src/asr-core/NativeReleaseTargets.mjs`. Each target asset is checked against exact bytes and SHA-256 before extraction.

Hosted-runner evidence on PR #7 head `5d31165ee455f288c8de67baeb8b1c086fc21f62`:

- macOS 15 arm64: executable + 3 dylibs verified; `sherpa-onnx-offline --help` PASS.
- macOS 15 Intel: executable + 3 dylibs verified; `sherpa-onnx-offline --help` PASS.
- Windows Server 2025 x64: executable + 2 DLLs verified; `sherpa-onnx-offline.exe --help` PASS.

Safe extraction rejects links by default. The explicit native-runtime mode materializes only relative, same-directory library symlinks under `lib` as regular files; path traversal, absolute links, hardlinks, symlink chains, and links outside `lib` remain rejected.

Remaining release acceptance:
- Physical clean install, repair, upgrade, rollback, and uninstall on Windows 11 and macOS 14/15; the hosted cross-target unsigned Installer + Update build and tarball hash/model/runtime provenance gates now PASS for all three targets.
- Clean install, repair, upgrade, rollback, and uninstall on physical macOS 14/15 and Windows 11.
- Adobe Audition 25.x CEP installation/registration and Companion startup/reconnect/cancel workflows.
- Final package signing, pinned trust-root verification, and update signature enforcement.

Latest fully validated full native/package CI head `337844e6b0b00228dbd1d6781e3c331c4344c6ee` completed the Architecture Governance workflow successfully: AVAPARDAZ Quality Gates Levels 1–5; Architecture Governance with Vitest 30 files / 130 tests, 32 Node reliability/fault-injection tests, TypeScript compilation, zero-circular dependency check, SBOM, license audit, E2E quality gates, production build and release-manifest verification. Native binary parser tests passed on four runners; pinned native runtime provisioning + CLI smoke tests passed on all three approved target architectures; all six unsigned target-specific Installer/Update tarballs passed SHA-256/byte-length checks and embedded model/runtime provenance validation. The earlier obsolete manifest assertion and malformed symlink fixture were corrected. The current branch head is `54a1da21778dc0dd852840c2b5662104a82c5664`; its AVAPARDAZ Levels 1–5 workflow passed.


## 12. Cross-target package build evidence (2026-11-28)

GitHub Actions run `46143509617` completed successfully on PR #7 commit `337844e6b0b00228dbd1d6781e3c331c4344c6ee`:

- Production web bundle and pinned Koochik model provisioning: PASS.
- Native runtime artifacts for darwin-arm64, darwin-x64, win32-x64: PASS.
- Six unsigned artifacts were built: Installer + Update for each approved target.
- CI recomputed byte length and SHA-256 for each tarball and checked target ID, immutable model revision and Apache-2.0 license metadata: PASS for all three targets.
- Manifest-only artifact `avapardaz-target-release-manifests` uploaded; unsigned tarballs were not published.

This is hosted build/integrity evidence. It does not certify physical Windows 11/macOS 14 acceptance, Adobe Audition 25.x integration, signature/trust-root verification, or update activation/rollback.
