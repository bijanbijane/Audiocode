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
- Full package build using the production web bundle and verified Persian model payloads.
- Clean install, repair, upgrade, rollback, and uninstall on physical macOS 14/15 and Windows 11.
- Adobe Audition 25.x CEP installation/registration and Companion startup/reconnect/cancel workflows.
- Final package signing, pinned trust-root verification, and update signature enforcement.

A later Vitest run caught one obsolete source assertion in `build-release-installer.spec.ts`; it was removed. CI on the latest commit is rerunning, so the earlier successful native runtime jobs are evidence for the pinned runtime provisioning code, not a claim that the latest complete workflow is green.
