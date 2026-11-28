# AudioCode Execution State

**Updated:** 2026-11-28  
**Repository:** `bijanbijane/Audiocode` (private)  
**Roadmap:** `AVP-DELIVERY-ROADMAP-1.1` — `docs/AVAPARDAZ/DELIVERY-ROADMAP-INTERNAL-2026-11-27.md`  
**Scope:** Adobe Audition CEP + Native Companion + shared Core; Internal Release; macOS + Windows.

## Repository reference

- Default branch: `main`
- Main baseline / current main HEAD observed: `e73394f8e00e477f1de0046e04fd233681610563`
- Working branch: `docs/r0-baseline-audit-2026-11-27`
- Latest fully validated implementation HEAD: `bc8dfc2d1ae568528f39010c8c0a41cd35506606`
- PR: [#6 — R0 baseline and Audition CEP ASR boundary](https://github.com/bijanbijane/Audiocode/pull/6) — OPEN, DRAFT, not merged.
- Latest PR metadata observed: 37 changed files; 139 commits; 2,317 additions; 150 deletions.
- All implementation changes in this execution are on the PR branch through GitHub. No local Mac checkout is used.

## Roadmap status

R0 — Baseline, scope and dual-platform release gates: **IN PROGRESS**. CI baseline is now executable and passing at the validated head; the phase remains open because owner decisions and live-host acceptance are outstanding. No release gate is promoted to VERIFIED or DONE by this record.

| Task | Priority | Status | Evidence / remaining acceptance |
|---|---:|---|---|
| R0-BASE-01 — Record repository baseline and reconcile approved delivery scope | P0 | IMPLEMENTED | Initial audit: `docs/AVAPARDAZ/R0-BASELINE-AUDIT-2026-11-27.md`; approved scope is mirrored in the delivery roadmap. R0 exit criteria remain open. |
| R0-CI-02 — Establish executable CI baseline | P0 | PASS — CI EXECUTED | Four workflows passed on `bc8dfc2`: Architecture Governance / Reliability, Web+API container build, AVAPARDAZ Quality Gates Levels 1–5, and Standalone Platform API Readiness. Exact run IDs are recorded below. |
| R0-SEC-08 — Enforce session ownership for Companion jobs | P0 | IMPLEMENTED / TESTED | Jobs and staged audio resources use a stable, random 256-bit client-instance capability scoped by host. A renewed IPC session from the same CEP installation can recover its jobs; another client, including another Audition client, receives 404. Job accessors require an explicit owner. HTTP regression coverage passed in Level 2–4 and architecture suites. |
| R0-IPC-03 — Version and isolate the Audition CEP transcript boundary | P1 | IMPLEMENTED / TESTED | CEP DTO, mapper, independent schema negotiation, execution-mode-specific result serialization and HTTP integration coverage passed in the quality suite. |
| R0-CONSUMER-04 — Complete repository-wide IPC consumer inventory | P1 | IN PROGRESS | Reviewed CEP `app.js`, `CompanionWebClient`, the Companion HTTP dispatcher, `LocalCompanionService`, and `CompanionAudioTransfer`. The two active client implementations send stable client identity; reviewed HTTP routes pass the authenticated owner to job, staged-upload and transfer operations. However, internal service/manager APIs still accept omitted owner identity in several paths (details under Open blockers); full repository-wide caller inventory is not yet proven. Retain legacy response fields until closure. |
| R0-PLATFORM-05 — Approve exact Audition / OS / hardware / audio-format matrix | P1 | BLOCKED | Candidate matrix exists in the R0 audit; exact builds, minimum hardware, architectures and formats are not owner-approved. |
| R0-HOST-06 — Verify live Audition workflow on macOS and Windows | P0 | BLOCKED | Physical or authorized test hosts and live-host evidence are unavailable in this repository-only session. |
| R0-DIST-07 — Decide internal installation and trust model | P1 | IN PROGRESS | Internal trust, installation and update policy still need an explicit decision and documentation. Public signing requirements are not automatically assumed. |

## Latest implemented changes

- Companion session ownership and reconnect: a random 256-bit `client_instance_id` is stored in CEP `localStorage` and held for the lifetime of a Web client. The IPC bridge derives a host-scoped owner from this capability, so re-handshaking no longer strands in-memory jobs when the panel reloads or the short-lived session renews. Distinct client identities remain isolated even for the same host. Reviewed HTTP routes pass the authenticated owner to status, reconnect, list, cancel, staged-upload and transfer operations. Job accessors require an explicit owner; integration tests poll completion through authenticated IPC rather than bypassing the ownership boundary. CEP and Web IPC nonce fallbacks use cryptographic randomness rather than `Math.random`.
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

Validated implementation HEAD: `bc8dfc2d1ae568528f39010c8c0a41cd35506606`.

| Check | Result | Evidence |
|---|---|---|
| Architecture Governance, Reliability & Release Quality Gate | PASS | Implementation run `46070705179`; latest docs-head run `46071024890` also passed. TypeScript compilation, Vitest integration, Unit/Reliability/Fault-Injection, E2E quality gates, production bundle and release manifest completed successfully on the implementation head. |
| Unit / Reliability / Fault-Injection | PASS | 283 tests passed; 0 failed; run job `140746701176`. |
| Vitest integration and quality suites | PASS | Run job `140745106320`; 22 test files and 98 tests passed; the subsequent Node integration suite also passed. |
| AVAPARDAZ Quality & Release Gates, Levels 1–5 | PASS | Implementation run `46070705246`; latest docs-head run `46071024923` also passed. All five levels completed successfully, including real ORT, DSP, workflow, linguistic, IPC/security and Audition CEP packaging checks. The targeted Companion HTTP IPC integration test passed, including same-client recovery after re-handshake and cross-client denial. |
| Standalone Platform API Readiness | PASS | Implementation run `46070705226`; latest docs-head run `46071024879` also passed. Install, typecheck, test and build completed successfully. |
| Web/API container build | PASS | Implementation run `46070705150`; latest docs-head run `46071024913` also passed. Independent web and API images built successfully. |
| TypeScript compilation / zero circular dependencies / SBOM | PASS | Architecture workflow `46070705179`. |
| Live Audition host tests | BLOCKED | No authorized live macOS and Windows hosts; CI packaging is not equivalent to live-host acceptance. |

Non-blocking observations from the production build:
- Vite reports one or more minified chunks above 500 kB; consider code splitting after profiling and without weakening the current release gate.
- Node emits a `punycode` deprecation warning through a dependency/action path; no build failure resulted.

## Open blockers and risks

1. Live Audition workflow acceptance on both macOS and Windows remains unverified.
2. Exact Audition host versions, OS builds, hardware minimums and audio-format support matrix require owner approval.
3. Internal installation, signing/trust and update policy remains open.
4. Full IPC consumer inventory remains incomplete; legacy DTO compatibility must be preserved until it is complete. A targeted API-boundary review found defense-in-depth gaps for trusted internal callers: `LocalCompanionService.initStagedUpload` defaults to `local-default`; `appendStagedUploadChunk` and `abortStagedUpload` allow an omitted owner; `submitTranscriptionJob` allows an omitted owner and falls back to `local-default`; upload handoff checks ownership only when an owner is supplied. `CompanionAudioTransferManager.initTransfer` similarly falls back to a default owner, while `validateOwner` treats an omitted owner as authorized for chunk append, finalize, source acquisition, small-payload consume and abort. The authenticated HTTP router currently supplies the owner for these paths, so this is not evidence of an unauthenticated HTTP bypass; it is an internal API footgun that can reintroduce cross-client access if a future/native caller omits the owner. Next fix should make owner identity mandatory at these service/manager boundaries, update direct unit-test callers, and preserve ownerless `cleanupAll` only as an internal shutdown operation. The client-instance ID is a bearer-like local capability stored in CEP localStorage; it must not be logged or exposed to untrusted same-origin scripts. The Companion job store remains in-memory, so reconnect does not survive a Companion process restart.
5. WebSocket session reservations are in-process only; they do not coordinate quota reservations across multiple backend replicas. Server-side ASR remains disabled by default in V1.
6. Word-level Persian timing remains gated by independent human-gold alignment evidence; do not enable automatic edits based on unverified word boundaries.
7. Large Vite chunks and the dependency deprecation warning are non-blocking technical debt, not release acceptance evidence.

## Next execution order

1. Close the owner-optional internal API paths identified in `LocalCompanionService` and `CompanionAudioTransferManager`, with regression tests for missing-owner denial; then complete the repository-wide caller inventory.
2. Obtain owner decisions for the exact dual-platform compatibility matrix and internal distribution trust model.
3. Execute live Audition acceptance on both macOS and Windows when authorized hosts are available.
4. Assess Vite chunk splitting and dependency deprecation separately from release-critical work.

## Safety and release state

- PR #6 remains an unmerged draft; `main` is unchanged.
- No production deployment, live service modification, destructive data operation, or database migration was performed.
- CI success is evidence for the tested PR head only; it does not promote R0 or any release gate to VERIFIED or DONE.
