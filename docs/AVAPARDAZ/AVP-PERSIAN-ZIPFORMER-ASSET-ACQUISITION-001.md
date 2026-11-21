# AVP-PERSIAN-ZIPFORMER-ASSET-ACQUISITION-001 — Genuine Persian Zipformer-Transducer Acquisition Report

**Status:** `VERIFIED (ASSETS ACQUIRED & CHECKSUM/STRUCTURE VERIFIED ONLY — NOT WIRED TO CTC ENGINE)`  
**Authoritative Upstream Repository:** `https://huggingface.co/ramin-mahmoodi/persian-zipformer-asr`  
**Pinned Upstream Commit:** `0408facbcf3f670121def48e0802c395c225d150`  
**Local Storage Directory:** `models/persian-zipformer-transducer/1.0.0/` (gitignored binary weights; NOT inside `src/` or `public/`)  
**Verification Command:** `node scripts/acquire-persian-zipformer.mjs --verify-only` → **`[PASS]`**

---

## 1. Strict Architecture & Compatibility Boundary

- **Architecture:** `pruned_transducer_stateless7` (3-graph RNN-T / Zipformer-Transducer: `encoder.int8.onnx` + `decoder.int8.onnx` + `joiner.int8.onnx` + `tokens.txt`), runtime ecosystem `sherpa-onnx`.
- **NOT CTC-Compatible:** This model MUST NOT be wired into `CoreAcousticCtcEngine` (`audio_signal` / `logprobs` CTC contract).
- **Guardrail Enforcement:** Verified via `src/lifecycle/ModelProvenanceAndDelivery.test.ts` and `src/security/ArchitectureAndSecurityGuardrails.test.ts` that `CoreAcousticCtcEngine` has zero references to `persian-zipformer-transducer`, and zero `.onnx` files exist inside `src/` or `public/`.
- **Honest Scope:** This mission covers acquisition, SHA-256 verification, ONNX wire inspection, and packaging ONLY. It does NOT claim Transducer ASR inference readiness in the Browser CTC engine.

---

## 2. Verified File Manifest & Exact SHA-256 Checksums

Total mandatory INT8 package (`encoder.int8.onnx` + `decoder.int8.onnx` + `joiner.int8.onnx` + `tokens.txt`): **`115,757,880` bytes (~110.40 MiB)**.

| File | Category | Exact Size (Bytes) | Verified SHA-256 | LFS OID Match |
| :--- | :--- | ---: | :--- | :---: |
| `encoder.int8.onnx` | Mandatory INT8 Encoder | `113,609,320` | `08735923618e196bd093b369f6843c8a390a6113a391e7b7095115582fd2cd27` | Exact Match |
| `decoder.int8.onnx` | Mandatory INT8 Decoder | `1,736,806` | `9d4ad2da0335d86d8638ff026e6b37247d97df940af6ad40bba671af5fd4aa9d` | Exact Match |
| `joiner.int8.onnx` | Mandatory INT8 Joiner | `398,795` | `a2a4a30585dc53e46afafd03690181107a610f67ff0e29cab460ec16df5cc00b` | Exact Match |
| `tokens.txt` | Mandatory Vocabulary (`1,024` tokens) | `12,959` | `435f9e09a290c764670044e54c2450670fc2eab50176cd912734fa6f92ab166f` | Exact Match |
| `bpe_fa_1024.model` | Preserved Upstream SentencePiece | `257,275` | `38ce80cf76e8535d41d625dcbf1a5a5e7d4cb7260a1d7b0dc1663385fc4fd075` | Exact Match |
| `README.md` | Preserved Upstream Model Card | `6,054` | `7e60fdf2ba87e188124da1874fc06a93dbac6be7569169099dcc1774c28f2ac4` | Exact Match |
| `transcribe.py` | Preserved Upstream Reference Script | `10,719` | `a25d398d513177f371f21f1b12740f62fe43527501973ba055441b9cc8a8123e` | Exact Match |
| `sample.wav` | Preserved Upstream Sample Audio | `775,738` | `e4f83ec981187afc2bd5902d604dfa55c3692c4010a5de2232b15427ca697b97` | Exact Match |

---

## 3. Inspected ONNX Protobuf Tensor & Metadata Contracts

- **`encoder.int8.onnx`**: ONNX IR v7, `ai.onnx` opset 14, `onnx.quantize`, `4,445` nodes, metadata `{model_type: "zipformer2", model_author: "k2-fsa", comment: "stateless7"}`, inputs `x: float32[N, T, 80]`, `x_lens: int64[N]`, outputs `encoder_out: float32[N, T, 384]`, `encoder_out_lens: int64[N]`.
- **`decoder.int8.onnx`**: ONNX IR v7, opset 14, `14` nodes, metadata `{context_size: "2", vocab_size: "1024"}`, input `y: int64[N, 2]`, output `decoder_out: float32[N, 384]`.
- **`joiner.int8.onnx`**: ONNX IR v7, opset 14, `8` nodes, metadata `{joiner_dim: "384"}`, inputs `encoder_out: float32[N, 384]`, `decoder_out: float32[N, 384]`, output `logit: float32[N, 1024]`.
- **`tokens.txt`**: Exact `1,024` UTF-8 Persian BPE entries (`<blk> 0` through `ژ 1023`).

---

## 4. Licensing Transparency & Explicit Blocker

- Upstream `README.md` explicitly declares `license: apache-2.0` in YAML frontmatter and the License section.
- **Explicit Finding (`BLK-002`):** Upstream commit `0408facbcf3f670121def48e0802c395c225d150` omitted a standalone `LICENSE` file in its Git tree. `models/persian-zipformer-transducer/1.0.0/LICENSE`, `NOTICE`, and `manifest.json` document this provenance transparently without misrepresenting a locally added license text as an upstream commit file.
