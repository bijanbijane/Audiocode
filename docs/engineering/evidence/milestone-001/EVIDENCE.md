# Milestone `M-P0-01` Verification Evidence (`R0` Release Gate)

- **Milestone:** `M-P0-01` — Foundation Test Integrity & Truth Verification Gate
- **Date Verified:** 2026-11-18
- **Hardware Profile:** `G0_CPU_ONLY` (`4 vCPUs`, `12 GiB RAM`, `0` CUDA GPUs)
- **Verdict:** **`VERIFIED` (`R0` CLEARED)**

---

## 1. Defects Fixed in `M-P0-01`
1. **`/src/ai-engine/PersianProsodicPunctuationRestorer.ts` (`estimateQuickF0`):**
   - *Root Cause:* Coarse lag step (`lag += 2`) combined with global `maxCorr` selection matched the double-period subharmonic (`lag ≈ 173`, `~92.5 Hz`) on a rising `185 Hz` (`T ≈ 86.5` samples) terminal word contour instead of the fundamental (`~185 Hz`), producing negative F0 slope and emitting `.` instead of `؟`.
   - *Fix:* Full integer-lag autocorrelation scan `[minLag..maxLag]` + first-strong-local-peak selection (`>= 0.85 * maxCorr`) + parabolic sub-sample interpolation.
2. **`/src/quality-gate/AutomatedQualityGateRunner.ts` (`computePersianWER`):**
   - *Root Cause:* `PersianTextNormalizer.normalizeTokenText` standardizes spaced verb prefixes (`می کنم -> می‌کنم`), while joined prefixes without ZWNJ (`صحبت میکنیم` vs `صحبت می‌کنیم`) stayed unequal in normalized WER, falsely causing `11.11%` error instead of `0%` in `EditQualityVsModelQualityEvaluator.test.ts`.
   - *Fix:* Strip optional `\u200c` inside `computePersianWER` strictly for `normalizedWerPercent` comparison while preserving strict `rawWerPercent` penalty and keeping `\u200c` intact in `PersianTextNormalizer` typography/display layers.
3. **`/package.json`:**
   - Added `"test:unit"` (all `src/`, `packages/`, `backend/` `*.test.ts` files via `tsx --test`) and `"verify:foundation"` (`lint` + `vitest run` + `test:unit` + `vite build`).

---

## 2. Observed Verification Results (Executed After Final Code/Config Edit)

| Check | Command Executed | Observed Result | Duration |
|---|---|---|---|
| TypeScript Check | `npm run lint` (`tsc --noEmit`) | **PASS (`0` errors)** | — |
| Production Bundle | `npm run build` (`vite build` / `compile_applet`) | **PASS (compiled cleanly)** | — |
| Vitest Integration & Gates | `npx vitest run` | **PASS (`13/13` files, `75/75` tests)** | `4.67s` |
| Full Node Unit Suite | `npm run test:unit` (`tsx --test` across `src/`, `packages/`, `backend/`) | **PASS (`250/250` tests, `38` suites, `0` failed, `0` skipped)** | `39.76s` |
| Circular Dependencies | `npx --yes madge --circular --extensions ts,tsx src/ packages/` | **PASS (`0` circular deps across `318` files)** | `8.0s` |
| Python Syntax Validation | `python3 -m py_compile python_asr_lab/asr_lab_core.py training/preflight.py sdk/python/asr_platform/client.py` | **PASS (`exit code 0`)** | `< 1s` |
| DAG Acyclicity Check | DFS cycle & edge verification on `docs/engineering/dependency-graph.json` | **PASS (`DAG_VALID nodes=9 edges=10 gates=8`, `DAG_ACYCLIC_VERIFIED`)** | `< 1s` |

---

## 3. Honest Remaining Limitations Disclosed
- Passing `M-P0-01` clears local foundation integrity (`R0`) only.
- Live GPU neural decoding (`ASR-004`), `30h+` corpus training (`MODEL-001`), live PostgreSQL/Redis persistence (`PLATFORM-002`), Rust/WASM compilation (`cargo` absent), and live PSP/OIDC/KMS connectors remain gated (`BLOCKED_BY_EXTERNAL_DEPENDENCY`) in `R2..R7`.
