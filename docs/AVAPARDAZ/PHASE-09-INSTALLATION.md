# AVAPARDAZ — PHASE-09 / PHASE-11: INSTALLATION, LIFECYCLE & PACKAGING GUIDE

**Document ID:** `AVP-P09-INSTALL-1.0`  
**Date:** `2026-11-20`  
**Package Artifact:** `dist-packages/avapardaz-audition-cep-v1.0.0.tar.gz` (`11,369 bytes`, `9` files)  
**Artifact SHA-256:** `b96b5e5afb2e0560d2b6d5d6c80d486b98192ac4365de65786b4c4aac6ef9a68`  
**Manifest File:** `dist-packages/avapardaz-audition-cep-v1.0.0.manifest.json`

---

## 1. Distribution Package Contents (Verified via `package-plugin.mjs`)

1. `CSXS/manifest.xml` — Adobe Audition CEP 11 manifest (`AUDT [22.0,99.9]`)
2. `jsx/auditionHost.jsx` — ExtendScript Audition host bridge
3. `client/index.html` — Strict-CSP Persian RTL CEP panel
4. `client/styles.css` — Local offline styling (zero external network fetches)
5. `client/app.js` — HMAC-SHA256 Companion IPC client (`v2.0.0`), transcript editor & exporter
6. `installers/install-macos.sh` — macOS user-level installer (`~/Library/Application Support/Adobe/CEP/extensions/com.avapardaz.audition.cep`)
7. `installers/uninstall-macos.sh` — macOS uninstaller (preserves `~/.avapardaz/models` and user projects by default)
8. `installers/install-windows.ps1` — Windows user-level PowerShell installer (`%APPDATA%\Adobe\CEP\extensions\com.avapardaz.audition.cep`)
9. `installers/uninstall-windows.ps1` — Windows uninstaller (preserves `%USERPROFILE%\.avapardaz\models` and user projects by default)

---

## 2. Clean Install & Uninstall Workflows

### macOS (Developer / Controlled Beta — Unsigned Debug Mode)
```bash
tar -xzf avapardaz-audition-cep-v1.0.0.tar.gz
chmod +x installers/install-macos.sh installers/uninstall-macos.sh
./installers/install-macos.sh
```
- Copies CEP extension into `~/Library/Application Support/Adobe/CEP/extensions/com.avapardaz.audition.cep`.
- Enables `PlayerDebugMode=1` for `com.adobe.CSXS.11` and `com.adobe.CSXS.12` (required until `.zxp` code signing is completed).
- Starts Local Companion daemon (`127.0.0.1:47291`) separately (`npx tsx companion/avapardaz-companion.ts`).
- Uninstall via `./installers/uninstall-macos.sh` removes only the CEP extension folder and **does not delete user audio, transcripts, or downloaded model weights**.

### Windows (Developer / Controlled Beta — Unsigned Debug Mode)
```powershell
tar -xzf avapardaz-audition-cep-v1.0.0.tar.gz
powershell -ExecutionPolicy Bypass -File .\installers\install-windows.ps1
```
- Installs into `%APPDATA%\Adobe\CEP\extensions\com.avapardaz.audition.cep`.
- Sets `HKCU\Software\Adobe\CSXS.11` & `CSXS.12` `PlayerDebugMode = 1`.
- Uninstall via `installers\uninstall-windows.ps1` removes only the extension folder and preserves user models/data.

### Offline Model Installation & Verification
- Models are **never committed to Git** (`ADR-006`).
- `LocalSherpaNeuralEngine.ts` discovers local models from `AVAPARDAZ_MODELS_DIR`, `~/.avapardaz/models`, or local benchmark directories, verifying required ONNX encoder/decoder/tokens files before execution.
- Model provenance SHA-256 digests are recorded in `docs/AVAPARDAZ/MODEL-PROVENANCE.md` and `benchmarks/phase02/results-2026-11-20.json`.

---

## 3. Honest Packaging Gaps Blocking Mass-Market Non-Technical Release (`BLOCKED`)

1. **No Signed Standalone OS Installers (`.dmg`/`.pkg`, `.msi`/`.exe`):** End users currently would need Node.js/`tsx` to run `companion/avapardaz-companion.ts` until a compiled standalone binary (e.g., Node SEA / pkg / Rust launcher) + `sherpa-onnx` native binary are bundled per OS/arch (`macOS arm64/x64`, `Windows x64/arm64`) and signed with Apple Developer ID (notarized) and Windows Authenticode.
2. **No Signed Adobe `.zxp`:** Requires `ZXPSignCmd` + certificate to remove `PlayerDebugMode=1`.
3. **Physical OS Verification Untested:** `install-macos.sh` and `install-windows.ps1` have been syntax/structure-verified in Linux only; neither has been executed on physical macOS or Windows machines with Adobe Audition installed.
