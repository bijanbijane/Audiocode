# AVP-P0-007 — Production Installation, Update Orchestration, Recovery & Distribution Engineering

**Status:** `IN PROGRESS (ENGINE TESTS PASS; TARGET-SPECIFIC INTERNAL PACKAGING IMPLEMENTED; TARGET RUNTIME / HOST VALIDATION AND TRUST GATES OPEN)`  
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

- Central target registry in `scripts/release-targets.mjs`.
- Target-specific native Sherpa executable and ONNX Runtime library selection.
- Fail-closed runtime target provenance assertion via `AVAPARDAZ_SHERPA_RUNTIME_TARGET`.
- Target-specific package/update directory and artifact names, plus target/build-host fields in package manifest.
- Generated installer OS/architecture and Node.js 20+ preflight.
- Generated Windows PowerShell launcher in addition to macOS shell launcher.
- Release engine supported-platform metadata aligned to the approved target list.

The runtime-target environment variable is an explicit build assertion, not a signature or binary-format verification. No native runtime payloads were built or executed on all target hosts in this session. Actual Windows 11, macOS 14/15 Intel/Apple Silicon, and Audition 25.x acceptance remains NOT TESTED. CEP host registration, Companion startup registration, signed release verification, and atomic package update integration remain open; therefore this phase is IN PROGRESS, not VERIFIED.
