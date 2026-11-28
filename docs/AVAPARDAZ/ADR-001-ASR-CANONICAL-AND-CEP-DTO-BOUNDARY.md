# ADR-001 — Canonical ASR Contract and Adobe Audition CEP DTO Boundary

- **Status:** Accepted for implementation on PR #6; implementation in progress
- **Date:** 2026-11-27
- **Scope:** Internal Adobe Audition CEP + Native Companion + shared ASR core
- **Decision owner:** Product owner / AudioCode maintainer

## Context

The Browser and Native runtime adapters both implement `LocalAsrRuntimeAdapter` and return `AvapardazTranscriptResult` v2.0.0. The Adobe Audition CEP panel does not consume that canonical result directly. It polls the Companion's `JOB_STATUS` command, whose `job.result` is a `LocalNeuralTranscriptionResult` DTO. The panel currently reads segment fields such as `text`, while the canonical ASR result uses `rawText` and `normalizedText`.

The Companion handshake currently negotiates the IPC protocol and a generic canonical capability contract version. It does not independently negotiate the ASR transcript schema version. A transcript-only breaking change could therefore remain invisible to the handshake.

The current native canonical mapper also substitutes zero when word confidence is absent and derives segment confidence from those values. Zero is a valid numeric score and must not be used to mean “unavailable”.

## Decision

1. Preserve `AvapardazTranscriptResult` as the canonical ASR runtime result. Do not reshape the core contract to match the legacy CEP DTO.
2. Introduce a dedicated, explicitly versioned CEP-facing transcript DTO and a single mapper at the Companion/CEP boundary. Keep the existing Companion job lifecycle, progress, cancellation, source-identity and recovery semantics intact.
3. Negotiate the CEP transcript DTO version independently from the IPC protocol and generic capability contract. Reject unsupported or incompatible schema versions explicitly; do not infer compatibility from coincidentally equal version strings.
4. Represent unavailable confidence as unavailable (nullable value plus explicit status where the source contract supports it). Never coerce missing confidence to numeric zero. Preserve genuine measured zero values.
5. Keep the existing Web Companion response shape unchanged unless a separate consumer audit demonstrates that it also needs a versioned DTO.

## Implementation constraints

- Add runtime validation for the incoming handshake schema-version field and return the negotiated schema version in the handshake response.
- Add a mapper with exhaustive field mapping and deterministic defaults only for fields whose semantics permit defaults.
- Preserve raw transcript text separately from normalized text.
- Preserve timestamp granularity and do not synthesize word-level timestamps.
- Keep the old CEP panel contract only as a separately named/versioned compatibility DTO if compatibility is required; do not leak it into the canonical ASR domain types.
- Add tests for supported-version handshake, missing/unsupported version, DTO mapping, confidence unavailable versus genuine zero, and preservation of source/job metadata.
- Add cross-runtime conformance coverage that executes both concrete adapters on equivalent deterministic fixtures when the runtime test harness permits it. Do not label mapper-only tests as full runtime parity.

## Compatibility and rollout

The CEP panel and Native Companion are shipped together for the internal release. The new handshake field and DTO version must be deployed atomically with that pair. The IPC protocol version remains independently governed; changing the ASR DTO version does not by itself imply an IPC protocol break.

No compatibility row or release gate is considered verified until the corresponding tests execute successfully on GitHub Actions and the live Audition host workflow is exercised on both supported operating systems.

## Consequences

**Benefits**
- Separates stable ASR domain semantics from host-specific presentation/transport needs.
- Makes transcript-schema compatibility explicit.
- Prevents “missing confidence” from being misrepresented as a zero score.
- Allows CEP evolution without coupling the core ASR contract to legacy field names.

**Costs**
- Adds a mapper and an independently negotiated schema version.
- Requires coordinated updates to the CEP panel and Companion handshake.
- Requires focused contract and compatibility tests.

## Open implementation checks

- Confirm all `JOB_STATUS`, `JOB_RECONNECT`, and `JOB_LIST` consumers before selecting the exact response envelope.
- Confirm whether any CEP consumer relies on serialized `LocalNeuralTranscriptionResult` fields outside the inspected panel path.
- Targeted inventory across 19 companion/Audition-related source and test files found the CEP panel consuming `JOB_STATUS` and `JOB_RECONNECT`, and `CompanionWebClient` consuming `JOB_STATUS`; `JOB_LIST` is currently exposed by the service and exercised by tests. Complete a repository-wide consumer scan before removing or changing the legacy result shape.

## Implementation progress (2026-11-27)

- Added `src/host-bridge/companion/CepTranscriptDto.ts` with explicit schema version `1.0.0` and a mapper from the native inference result. Normalization profile selection follows the detected language.
- Added `src/host-bridge/companion/CompanionJobResultMapper.ts` to apply the CEP DTO only for `audition-cep` execution mode; Web and native Companion consumers retain the original job result type.
- The DTO preserves the existing CEP `text` field as a compatibility alias while separately exposing `rawText` and `normalizedText`; timestamps and word timings are copied without synthesis.
- The native inference result currently exposes no calibrated confidence values. The CEP DTO therefore reports `confidence: null` and `UNAVAILABLE_UNCALIBRATED`, rather than inventing a zero.
- `CompanionWebClient` explicitly sends `execution_mode: web-client` for normal and retry requests, so its existing raw native result contract is selected intentionally rather than by an omitted-mode fallback.
- The handshake now negotiates ASR contract `2.0.0` and CEP transcript schema `1.0.0` independently for Adobe Audition clients. Other execution modes retain their existing handshake request requirements.
- `JOB_STATUS`, `JOB_RECONNECT`, and `JOB_LIST` map completed results only when `execution_mode` is `audition-cep`; other consumers retain the original job result shape.
- The CEP client validates both negotiated versions and the returned result schema before applying a transcript.
- Added focused mapper, execution-mode isolation, handshake compatibility, and legacy Web handshake tests. They have not yet been observed executing because GitHub Actions jobs continue to fail before exposing steps.
- Cross-runtime concrete-adapter parity and live Audition host validation remain unimplemented / unverified.
