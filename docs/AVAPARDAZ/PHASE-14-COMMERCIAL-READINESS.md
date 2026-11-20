# AVAPARDAZ — PHASE-14: COMMERCIALIZATION, LICENSING & GO-TO-MARKET READINESS

**Document ID:** `AVP-P14-COMM-1.0`  
**Date:** `2026-11-20`  
**Status:** `FOUNDATION IMPLEMENTED — COMMERCIAL LAUNCH BLOCKED ON EXTERNAL PREREQUISITES`

---

## 1. Commercial Model & Runtime License Clearance (`[OBSERVED]`)

Every component selected for AVAPARDAZ commercial offline distribution uses a permissive commercial-friendly open-source license (zero `CC-BY-NC`, zero copyleft `GPL/AGPL` contamination):

| Component | Upstream Source | SPDX License | Commercial Bundling / Distribution | Attribution Required |
| :--- | :--- | :---: | :---: | :---: |
| **`Reza2kn/Shenava-Rizeh v1.0`** (`AVP_MODEL_LITE` / Persian Fast) | Hugging Face `Reza2kn/Shenava-Rizeh` (NeMo FastConformer CTC) | **`Apache-2.0`** | **CLEARED** | Include Apache-2.0 NOTICE |
| **`openai/whisper-large-v3-turbo`** (`AVP_MODEL_QUALITY` / Bilingual & EN) | Hugging Face `openai/whisper-large-v3-turbo` / `k2-fsa/sherpa-onnx` | **`MIT`** | **CLEARED** | Include MIT copyright notice |
| **`openai/whisper-base` (FP32)** (Baseline reference) | Hugging Face `openai/whisper-base` | **`MIT`** | **CLEARED** | Include MIT copyright notice |
| **`k2-fsa/sherpa-onnx` (`v2.0.2`)** (Native CPU runtime) | GitHub `k2-fsa/sherpa-onnx` | **`Apache-2.0`** | **CLEARED** | Include Apache-2.0 NOTICE |
| **`onnxruntime-web` (`^1.31.1`)** (Browser WASM runtime) | npm `onnxruntime-web` | **`MIT`** | **CLEARED** | Include MIT notice |
| **`google/fleurs` (`dev` split)** (Benchmark audio ONLY) | Hugging Face `google/fleurs` | **`CC-BY-4.0`** | **BENCHMARK ONLY** (Not shipped in app; attribution kept in provenance docs) | CC-BY-4.0 attribution |
| **Rejected Models** (`CC-BY-NC-*`, `Qwen3-ASR-0.6B` un-finetuned, `Whisper-Base INT8`) | Various | Rejected on license or empirical Persian accuracy | **EXCLUDED** | N/A |

---

## 2. Offline Licensing Architecture (Existing & Verified in Codebase)

- **No Forced Always-Online DRM:** AVAPARDAZ already includes a cryptographic offline license verification engine (`src/security/PlatformLicenseService.ts` using Ed25519 signature verification + machine binding + grace-period validation) so paying customers can use Adobe Audition Plugin and Local Companion **100% offline** after one-time license activation/import.
- **Commercial Separation of Concerns:**
  1. **Codebase:** Proprietary commercial software (AVAPARDAZ Studio, CEP Plugin, Local Companion).
  2. **Model Packs:** Modular SHA-256 verified downloads (or offline `.tar.gz` side-load) kept strictly outside Git and outside the core app installer to keep installers small and legally clean.

---

## 3. Proposed Commercial Edition Structure (Ready for Launch Once Blockers Clear)

| Edition | Target Customer | Included Products & Engines | Offline Capability |
| :--- | :--- | :--- | :---: |
| **Free / Community Trial** | Evaluators & indie creators | Web App + `AVP_MODEL_LITE` (`Shenava-Rizeh` Persian fast CPU), `TXT`/`SRT` export | 100% Offline |
| **Creator / Pro (Perpetual or Annual License)** | Iranian & bilingual podcasters, YouTubers, voice editors | Adobe Audition CEP Plugin + Local Companion + `AVP_MODEL_LITE` + `AVP_MODEL_QUALITY` (`Whisper large-v3-turbo`), full `SRT`/`VTT`/`JSON`/`SESX` export, unlimited local hours | 100% Offline (Ed25519 key) |
| **Studio / Team** | Broadcast studios, post-production houses, agencies | Multi-seat offline license keys, air-gapped `.tar.gz` model pack installer, priority Persian custom glossary support | 100% Air-Gapped |

---

## 4. Honest Commercial Launch Blockers (`BLOCKED` — Cannot Be Resolved Inside Container)

1. **No Live Payment Gateway / Billing Backend:** No ZarinPal/Iranian PSP (for IRR market) or Stripe/Paddle/LemonSqueezy (for international USD market) merchant account, webhook verification, or live invoice/tax flow is provisioned.
2. **No Code-Signing Certificates:** Public distribution requires Apple Developer ID + notarization (macOS), Windows EV/OV Authenticode certificate (Windows SmartScreen), and Adobe `ZXPSignCmd` certificate (`.zxp` without `PlayerDebugMode=1`).
3. **No Dedicated Model CDN / Mirror:** Model packs (`36 MB` for `Shenava-Rizeh`, `~988 MB` for `Whisper Turbo`) need reliable Iran-accessible + global HTTPS download mirrors with SHA-256 verification and resume support.
4. **No Physical Adobe Audition Beta Sign-Off:** Cannot charge customers for an Adobe Audition plugin before verifying installation, markers, and playback sync on real macOS & Windows machines running Adobe Audition.
