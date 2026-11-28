# AudioCode Execution State

**Updated:** 2026-11-28  
**Repository:** `bijanbijane/Audiocode` (private)  
**Roadmap:** `AVP-DELIVERY-ROADMAP-1.1` — `docs/AVAPARDAZ/DELIVERY-ROADMAP-INTERNAL-2026-11-27.md`  
**Scope:** Adobe Audition CEP + Native Companion + shared Core; Internal Release; macOS + Windows.

## Repository reference

- Default branch: `main`
- Main baseline / current main HEAD observed: `e73394f8e00e477f1de0046e04fd233681610563`
- Working branch: `docs/r0-baseline-audit-2026-11-27`
- Previously validated implementation HEAD: `bc8dfc2d1ae568528f39010c8c0a41cd35506606`.
- Latest fully validated code HEAD: `32576614884e3f8dfde974487f2f1202892572bd` (all four workflows passed: Architecture/Reliability `46117769582`, AVAPARDAZ Quality Gates `46117769590`, Web/API containers `46117769575`, Platform API `46117769549`).
- Follow-up regression-test HEAD: `5367356fc6f4efdfcee15091c7ac8da3a55d8537`; All four workflows passed: AVAPARDAZ Levels 1–5 (`46116543390`), Platform API (`46116543388`), separated Web/API container build (`46116543398`), and Architecture/Reliability (`46116543436`).
- PR: [#6 — R0 baseline and Audition CEP ASR boundary](https://github.com/bijanbijane/Audiocode/pull/6) — OPEN, DRAFT, not merged.
- Latest PR metadata observed before this execution-state refresh: 38 changed files; 150 commits; 2,437 additions; 209 deletions.
- All implementation changes in this execution are on the PR branch through GitHub. No local Mac checkout is used.

## Roadmap status

R0 — Baseline, scope and dual-platform release gates: **IN PROGRESS**. CI baseline is now executable and passing at the validated head; the phase remains open because owner decisions and live-host acceptance are outstanding. No release gate is promoted to VERIFIED or DONE by this record.

| Task | Priority | Status | Evidence / remaining acceptance |
|---|---:|---|---|
| R0-BASE-01 — Record repository baseline and reconcile approved delivery scope | P0 | IMPLEMENTED | Initial audit: `docs/AVAPARDAZ/R0-BASELINE-AUDIT-2026-11-27.md`; approved scope is mirrored in the delivery roadmap. R0 exit criteria remain open. |
| R0-CI-02 — Establish executable CI baseline | P0 | PASS — latest head `3257661` | All four workflows passed on `32576614884e3f8dfde974487f2f1202892572bd`: AVAPARDAZ Quality Gates (`46117769590`), Standalone Platform API (`46117769549`), Web/API container build (`46117769575`), and Architecture/Reliability (`46117769582`). |
| R0-SEC-08 — Enforce session ownership for Companion jobs | P0 | IMPLEMENTED / TESTED — latest head `3257661` | Every Companion job submission requires a non-empty explicit owner, regardless of source. Job status/list/cancel and transfer lifecycle inspection are owner-scoped. The CI-included active/closed lifecycle metadata isolation regression executed and passed in AVAPARDAZ job `140895410175` (test 18); the canonical P0 suite reported 40 passed / 0 failed. |
| R0-IPC-03 — Version and isolate the Audition CEP transcript boundary | P1 | IMPLEMENTED / TESTED | CEP DTO, mapper, independent schema negotiation, execution-mode-specific result serialization and HTTP integration coverage passed in the quality suite. |
| R0-CONSUMER-04 — Complete repository-wide IPC consumer inventory | P1 | IN PROGRESS — targeted runtime inventory documented | Confirmed runtime callers: (1) CEP panel `packages/audition-cep-plugin/client/app.js` — `JOB_SUBMIT/STATUS/RECONNECT/CANCEL`, audio transfer/upload and capability actions; stable 256-bit client identity persists in CEP localStorage. (2) Web Studio `src/App.tsx` — two distinct workflow call sites construct `CompanionWebClient` and inject it into `NativeCompanionAsrRuntimeAdapter`; both use `JOB_SUBMIT/STATUS/CANCEL`, transfer/upload and capability actions. Each client instance owns a random 256-bit identity only for its object lifetime (not persisted across page reload); Web Studio is post-V1 and outside the critical path. (3) `CompanionDiagnostics` — transient handshake plus read-only `CAPABILITY_LIST`; no client identity and no job/audio resource access. Server-side: `LocalCompanionService` is the sole reviewed `/ipc` dispatcher; `CompanionIpcBridge` authenticates and resolves owner identity; `companion/avapardaz-companion.ts` mounts the daemon router. `NativeCompanionAsrRuntimeAdapter` consumes the `NativeCompanionTransport` port and is not a fourth IPC implementation. Tests are fixtures, not runtime clients. Every `JOB_SUBMIT` and per-resource transfer/upload operation requires explicit owner identity; reviewed authenticated routes propagate it. GitHub code search returned no indexed results, so this remains a targeted rather than exhaustive repository-wide semantic inventory. Retain legacy response fields until exhaustive closure. |
| R0-PLATFORM-05 — Approve exact Audition / OS / hardware / audio-format matrix | P1 | BLOCKED | Candidate matrix exists in the R0 audit; exact builds, minimum hardware, architectures and formats are not owner-approved. |
| R0-HOST-06 — Verify live Audition workflow on macOS and Windows | P0 | BLOCKED | Physical or authorized test hosts and live-host evidence are unavailable in this repository-only session. |
| R0-DIST-07 — Decide internal installation and trust model | P1 | IN PROGRESS | Internal trust, installation and update policy still need an explicit decision and documentation. Public signing requirements are not automatically assumed. |

## IPC consumer inventory (targeted review)

- **CEP client:** `packages/audition-cep-plugin/client/app.js` owns the persistent CEP client identity and calls job submit/status/reconnect/cancel plus audio transfer/upload and capability actions.
- **Web Studio callers:** `src/App.tsx` has two separate workflow call sites that each instantiate `CompanionWebClient` and inject it into `NativeCompanionAsrRuntimeAdapter`. The client implements the `NativeCompanionTransport` port, holds a secure random 256-bit identity for its object lifetime, and calls job submit/status/cancel, transfer/upload, and capability actions. This identity is not persisted across page reloads; this Web Studio integration is post-V1 and is not an Audition V1 acceptance dependency.
- **Diagnostics probe:** `src/host-bridge/companion/CompanionDiagnostics.ts` performs a handshake and read-only `CAPABILITY_LIST` request only. It intentionally has no persistent client identity and receives session-scoped fallback ownership; it does not access jobs or audio resources.
- **Server boundary:** `LocalCompanionService` is the reviewed `/ipc` dispatcher; `CompanionIpcBridge` authenticates requests and resolves the owner; `companion/avapardaz-companion.ts` mounts the daemon router. `NativeCompanionAsrRuntimeAdapter` consumes the `NativeCompanionTransport` interface and does not add a separate IPC protocol implementation. `CompanionConnectionDiagnostic` is a UI wrapper around the diagnostics probe. Mobile companion workspace files reviewed do not issue Companion IPC calls.
- **Direct resource API audit:** `CompanionAudioTransferManager` requires an explicit matching owner for init, append, finalize, source acquisition, legacy finalized-transfer consumption, abort, and active/closed lifecycle metadata. Its ownerless public methods are aggregate inspection or global maintenance (`getActiveSessionCount`, memory/staging counters, expiry sweep, startup orphan cleanup, and `cleanupAll`); these are not routed as per-transfer IPC operations. `LocalCompanionService` similarly requires owner identity for job submit/get/list/cancel and staged-upload init/append/abort. The reviewed IPC dispatcher passes the authenticated session owner into every resource operation. Global model/runtime actions are authenticated capability operations, not per-owner resource reads.
- **Additional classification:** `CompanionLifecycleManager` manages daemon lifecycle/locking and does not issue IPC requests. `AuditionHostAdapter` and `AdobeAuditionHostAdapter` describe host integration/capability behavior but do not implement another Companion IPC client. `CompanionConnectionDiagnostic` is only the UI wrapper for the diagnostics probe. The mobile Companion workspace files reviewed do not issue Companion IPC calls. `TranscriptPanel` and `WorkflowStageBar` reference `CompanionHealthResponse` as a type and expose presentation/callback props; they do not send IPC requests.
- **Inventory limitation:** GitHub code search is not indexed for this repository and returned no matches. The above inventory is based on the recursive repository tree, Companion-named paths, the two `src/App.tsx` constructor sites, primary client/service/bridge files, and targeted callsite review. It is stronger than the previous scan but does not justify marking the repository-wide semantic inventory complete. Legacy response fields remain in place.

## Latest implemented changes

- Companion session ownership and reconnect: a random 256-bit `client_instance_id` is stored in CEP `localStorage` and held for the lifetime of a Web client. The IPC bridge derives a host-scoped owner from this capability, so re-handshaking no longer strands in-memory jobs when the panel reloads or the short-lived session renews. Distinct client identities remain isolated even for the same host. Reviewed HTTP routes pass the authenticated owner to status, reconnect, list, cancel, staged-upload and transfer operations. Job accessors require an explicit owner; integration tests poll completion through authenticated IPC rather than bypassing the ownership boundary. CEP and Web IPC nonce fallbacks use cryptographic randomness rather than `Math.random`.
- Companion resource ownership hardening: every `JOB_SUBMIT` requires a non-empty explicit owner, removing the shared `local-default` fallback even for local-file and inline-Base64 jobs. Audio transfer init and chunk request DTOs require `ownerId`; the manager rejects missing/blank or foreign owners for initialization, chunk append, finalize, source acquisition, legacy consume, abort, lifecycle-state inspection, and closed-history inspection. Internal audio-source callbacks retain the authenticated owner when reading lifecycle metadata. Staged upload init/chunk/abort APIs require explicit owner identity; internal shutdown/overflow cleanup uses a separate private cleanup path. Regression coverage covers ownerless job submission and foreign-owner denial for active and closed transfer metadata. The CI-included lifecycle metadata test was executed successfully in the latest AVAPARDAZ run (subtest 18; P0 suite 40/40).
- Audition CEP boundary: versioned transcript DTO and mapper; independent ASR/CEP schema negotiation; Audition and Web Companion job-result serialization remain execution-mode-specific.
- Enterprise export isolation: artifact exports fail closed when tenant provenance is missing or mismatched; regression tests cover both cross-tenant and unowned artifacts.
- Invoice authorization: invoice routes are registered and included in authenticated-user route protection; ownership mismatch returns an explicit denial.
- FFmpeg input security: all non-file URI schemes and UNC shares are rejected; allowed-root checks canonicalize symlinks and pass the canonical target path to FFmpeg.
- Live ASR quota protection: per-key in-process concurrent-session reservations enforce a five-second minimum per active session and release reservations when sessions close. This is not a distributed reservation across multiple backend processes.
- Rate limiter: active buckets are never evicted to admit new keys; when capacity is exhausted, new keys fail closed until capacity expires.
- Telemetry: model-delivery event types and fields are validated before database insertion.
- Admin secret verification: constant-time comparison helper is restored and used for enterprise-key issuance.
- Test fixtures now use valid device fingerprint hashes, pinned PostgreSQL connections, advisory unlock results, and the negotiated Audition ASR/CEP versions.

## Validation evidence

Validated implementation heads: baseline `bc8dfc2d1ae568528f39010c8c0a41cd35506606`; owner-boundary hardening `654f35df583d3d7eeb127ecc7aefa15b33c8755d`; regression-test correction `5367356fc6f4efdfcee15091c7ac8da3a55d8537`; required job-owner follow-up `f44f5ae2a46f8793612efa8a1f5a0b0055813874`; latest focused lifecycle-test head `32576614884e3f8dfde974487f2f1202892572bd`. All four workflows passed on the latest head: AVAPARDAZ Quality Gates (`46117769590`), Standalone Platform API (`46117769549`), Web/API containers (`46117769575`), and Architecture/Reliability (`46117769582`). AVAPARDAZ canonical P0 suite: 40 passed / 0 failed; the new owner-isolation test ran as subtest 18 and passed. Architecture Unit/Reliability: 283 passed / 0 failed; Vitest integration: 22 files and 98 tests passed.

| Check | Result | Evidence |
|---|---|---|
| Architecture Governance, Reliability & Release Quality Gate | PASS — latest head | Run `46117769582`; TypeScript compilation, 22 Vitest files / 98 tests, Unit/Reliability/Fault-Injection (283 passed / 0 failed), E2E quality gates, production bundle and release manifest completed successfully. |
| Unit / Reliability / Fault-Injection | PASS | 283 tests passed; 0 failed; run job `140746701176`. |
| Vitest integration and quality suites | PASS | Run job `140745106320`; 22 test files and 98 tests passed; the subsequent Node integration suite also passed. |
| AVAPARDAZ Quality & Release Gates, Levels 1–5 | PASS — latest head | Run `46117769590`; Levels 1, 2–4 and 5 all passed. Real WeSpeaker, Silero VAD and SHAHAB Zipformer ONNX/WASM inference, canonical P0 suite (40 passed / 0 failed), bundle secret/model scan, and CEP packaging/security checks completed. The focused active/closed transfer lifecycle owner-isolation test passed (subtest 18 in job `140895410175`). |
| Standalone Platform API Readiness | PASS — latest head | Run `46117769549` completed successfully. |
| Web/API container build | PASS — latest head | Run `46117769575` completed successfully; independent web and API images built and route/client contract checks passed. |
| TypeScript compilation / zero circular dependencies / SBOM | PASS — latest head | Architecture workflow `46117769582`; all selected checks completed successfully. |
| Live Audition host tests | BLOCKED | No authorized live macOS and Windows hosts; CI packaging is not equivalent to live-host acceptance. |
| Latest owner-boundary validation | PASS — latest code head `32576614884e3f8dfde974487f2f1202892572bd` | All four workflows passed: Architecture/Reliability `46117769582`, AVAPARDAZ `46117769590`, Web/API containers `46117769575`, Platform API `46117769549`. AVAPARDAZ P0: 40/40; Architecture Unit/Reliability: 283/283; Vitest: 22 files / 98 tests. The active/closed transfer lifecycle owner-isolation regression was explicitly executed and passed (subtest 18, job `140895410175`). |

Non-blocking observations from the production build:
- Vite reports one or more minified chunks above 500 kB; consider code splitting after profiling and without weakening the current release gate.
- Node emits a `punycode` deprecation warning through a dependency/action path; no build failure resulted.

## Open blockers and risks

1. Live Audition workflow acceptance on both macOS and Windows remains unverified.
2. Exact Audition host versions, OS builds, hardware minimums and audio-format support matrix require owner approval.
3. Internal installation, signing/trust and update policy remains open.
4. Full IPC consumer inventory remains incomplete. Targeted review has documented the three runtime clients (CEP, web/native Companion client, and read-only diagnostics probe) and the single HTTP dispatcher. A direct source review confirmed the CEP panel's handshake and job/transfer actions, the Web client’s job and transfer actions, the diagnostics probe’s read-only `CAPABILITY_LIST`, and the server dispatcher’s authenticated owner propagation for job submit/status/reconnect/list/cancel, transfer init/chunk/finalize/abort, and staged-upload init/chunk/abort. The lifecycle metadata owner-isolation regression is now CI-verified. Continue the repository-wide semantic caller inventory before closing R0-CONSUMER-04; retain legacy DTO compatibility until closure. The authenticated HTTP router supplies the owner for reviewed routes, and no unauthenticated HTTP bypass was identified in this review. The client-instance ID remains a bearer-like local capability stored in CEP localStorage; it must not be logged or exposed to untrusted same-origin scripts. The Companion job store remains in-memory, so reconnect does not survive a Companion process restart.
5. WebSocket session reservations are in-process only; they do not coordinate quota reservations across multiple backend replicas. Server-side ASR remains disabled by default in V1.
6. Word-level Persian timing remains gated by independent human-gold alignment evidence; do not enable automatic edits based on unverified word boundaries.
7. Large Vite chunks and the dependency deprecation warning are non-blocking technical debt, not release acceptance evidence.

## Next execution order

1. Complete the repository-wide semantic IPC caller inventory and audit remaining resource-access methods against the now-required owner boundary; preserve legacy DTO compatibility until the inventory is complete.
2. Obtain owner decisions for the exact dual-platform compatibility matrix and internal distribution trust model.
3. Execute live Audition acceptance on both macOS and Windows when authorized hosts are available.
4. Assess Vite chunk splitting and dependency deprecation separately from release-critical work.

## Safety and release state

- PR #6 remains an unmerged draft; `main` is unchanged.
- No production deployment, live service modification, destructive data operation, or database migration was performed.
- CI success is evidence for the tested PR head only; it does not promote R0 or any release gate to VERIFIED or DONE.
