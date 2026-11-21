# AVP-P0-005 — Cross-Runtime Conformance, System Reliability & Release Qualification

**Status:** `VERIFIED (30/30 AUTOMATED SUITE TESTS PASS; EXTERNAL RELEASE BLOCKERS DOCUMENTED)`  
**Artifacts:**
- `.github/workflows/avapardaz-quality-gates.yml`
- `docs/AVAPARDAZ/release-acceptance-manifest.json`
- `src/asr-core/RealOnnxAndCrossRuntimeConformance.test.ts`
- `src/security/ArchitectureAndSecurityGuardrails.test.ts`

---

## 1. Dual Independent Local Runtime Conformance

- **Browser Local Runtime (`BROWSER_WASM_CPU`):** Runs strictly inside Browser Web Worker + `onnxruntime-web@1.31.1` WASM + OPFS with ZERO dependency on Native Companion and ZERO outbound network requests.
- **Native Local Runtime (`NATIVE_COMPANION_CPU`):** Runs independently via Standalone Companion + native inference adapter with ZERO dependency on Browser UI.
- **Canonical Output Parity (`AvapardazTranscriptResult` v2.0.0):** Both Browser and Native normalizers emit identical schema, monotonic bounded integer-sample segments, word spans, and Persian normalization metadata (`PERSIAN_NORMALIZATION_CONTRACT_VERSION`).

## 2. Verified Quality Gates (Observed Results)

| Gate | Suite / Check | Result |
| :--- | :--- | :---: |
| Real Unmocked Offline ORT WASM | `RealOnnxAndCrossRuntimeConformance.test.ts` (`3/3`) | **PASS** |
| Model Provenance, 19-State & Updates | `ModelProvenanceAndDelivery.test.ts` (`6/6`) | **PASS** |
| DSP Integrity & E2E Project Workflow | `CanonicalProjectWorkflowAndDsp.test.ts` (`3/3`) | **PASS** |
| Persian Linguistic, Evidence Repair & Lexical | `PersianLinguisticCorrectionAndLexical.test.ts` (`3/3`) | **PASS** |
| Companion IPC, Chunking & CEP Hygiene | `CompanionProductionIpcAndCep.test.ts` (`3/3`) | **PASS** |
| Security & Architecture Guardrails | `ArchitectureAndSecurityGuardrails.test.ts` (`4/4`) | **PASS** |
| Companion Red-Team & 60m O(1) Stress | `LocalCompanionAndSecurity.test.ts` (`8/8`) | **PASS** |
| Zipformer-Transducer Checksum Verification | `node scripts/acquire-persian-zipformer.mjs --verify-only` | **PASS** |

See `docs/AVAPARDAZ/release-acceptance-manifest.json` for machine-readable acceptance status and all 5 explicit external release blockers (`BLK-001`..`BLK-005`).
