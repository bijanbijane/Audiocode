# Koochik Model Provenance and License Audit — 2026-11-28

**Status:** `PINNED TO VERIFIED APACHE-2.0 REVISION; PROVISIONER AND PACKAGER GATES IMPLEMENTED; CI VALIDATION PENDING`

## 1. Model identity

- Model: `Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx`
- Intended use: offline Persian ASR, sherpa-onnx / NeMo FastConformer-CTC
- Pinned immutable revision: `158e40e9ccf166c3655b7f4cd2abbfc7bbc87f7a`
- Model file: `model.onnx`, 458,819,249 bytes
- Model SHA-256: `6a564b5541920ce1c37bbc91d22e4b3a6838648b9b327eb88997e8db1f90950d`
- Tokens: `tokens.txt`, 12,236 bytes
- Tokens SHA-256: `8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954`

## 2. License history and resolution

The original model commit `b67cd889f37746469b1396cf4236682aec72fd6d` had `license: cc-by-nc-4.0` in README frontmatter and no repository LICENSE file. This conflicted with the repository's later model-card metadata.

The model author subsequently published the verified commit:

- [158e40e9 — Set Shenava artifact license to Apache-2.0](https://huggingface.co/Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx/commit/158e40e9ccf166c3655b7f4cd2abbfc7bbc87f7a)
- That commit changes README frontmatter from `cc-by-nc-4.0` to `apache-2.0` and adds the 202-line Apache License 2.0 `LICENSE` file.
- The commit changes only `README.md` and `LICENSE`; the model and tokens blobs remain the same as the already-pinned hashes above.
- [Current upstream model card](https://huggingface.co/Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx) declares Apache-2.0.

The release pipeline therefore pins the exact license-corrected revision, not the earlier CC-BY-NC revision. The provisioner validates README frontmatter and the actual LICENSE text; a missing LICENSE, old CC-BY-NC metadata, or mismatched file fails closed.

## 3. Implemented controls

- `src/asr-core/KoochikModelProvenance.mjs` owns the immutable model revision, model/token byte counts and SHA-256 values, Apache license validation, and model-manifest verification.
- `scripts/provision-release-koochik-model.ts` downloads `model.onnx`, `tokens.txt`, `README.md`, and `LICENSE` from the pinned commit using the SafeModelSupplyChain HTTPS host allowlist.
- The provisioner validates exact model/token bytes and hashes, validates the Apache license declaration and text, writes `model-manifest.json`, and atomically activates the directory.
- Existing unverified model directories are not overwritten. A missing or invalid manifest is a hard error.
- `scripts/build-release-installer.mjs` now requires and revalidates the model manifest and embeds README, LICENSE and model-manifest in the release payload; the package manifest records repository, revision, license and manifest hash.
- The CI workflow includes a cached model-provisioning/license-verification job for PR #7.

## 4. Remaining limitations

- The new Hugging Face download path and CI model-provisioning job have not yet completed on the latest PR head.
- The model's license is Apache-2.0 at the pinned revision; downstream obligations (retain license and notices) are carried into the package. This is an engineering provenance record, not legal advice.
- Full installer package generation and real Audition host acceptance remain separate gates.
