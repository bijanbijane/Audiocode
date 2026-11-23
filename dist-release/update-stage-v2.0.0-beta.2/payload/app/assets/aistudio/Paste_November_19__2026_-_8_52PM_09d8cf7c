# AVAPARDAZ — PERMANENT ARCHITECTURAL CONSTITUTION
## Version 4.0 — Plugin-First, Host-Independent, Unified Processing Architecture

**Policy ID:** AVP-ARCH-001  
**Policy Version:** 4.0  
**Policy Status:** PERMANENT / MANDATORY / NON-OPTIONAL  
**Policy Scope:** Entire Avapardaz codebase, product architecture, processing systems, integrations, interfaces, dependencies, infrastructure, deployment, and future development.  
**Primary Host:** Adobe Audition  
**Primary Product Interface:** Avapardaz Adobe Audition Plugin  
**Secondary Product Interface:** Avapardaz Web Portal  
**Execution Environments:** Local and Cloud  
**Architecture Style:** Modular, Host-Independent, Contract-Driven, Plugin-First, Local-First.

---

# 0. POLICY AUTHORITY AND INTERPRETATION

This document defines the permanent architectural constitution of Avapardaz.

It is binding for:

- AI coding agents.
- Autonomous software engineering agents.
- Human developers.
- Architecture decisions.
- New feature implementation.
- Existing module refactoring.
- Processing engines.
- Application workflows.
- Host integrations.
- Plugin components.
- Web interfaces.
- Native components.
- Infrastructure and deployment.
- Dependency and technology selection.

All current and future implementation decisions MUST comply with this constitution.

## 0.1 Normative terminology

Interpret the following terms strictly:

- **MUST / MUST NOT:** Mandatory requirement or prohibition.
- **SHOULD / SHOULD NOT:** Strong architectural requirement. Deviations require explicit technical justification.
- **MAY:** Permitted implementation choice.
- **Verified:** Supported by actual repository evidence, reproducible tests, or authoritative technical documentation.
- **Unverified:** Not yet established through sufficient evidence.
- **Architectural Violation:** An implementation that contradicts a mandatory invariant.
- **Architectural Debt:** An existing implementation that does not satisfy a target invariant and requires a documented migration path.

Do not interpret architectural requirements as instructions to create unnecessary packages, services, processes, abstractions, or infrastructure.

Logical separation is mandatory. Physical separation is conditional on actual technical requirements.

## 0.2 Existing-codebase precedence

This constitution defines the required architectural destination. It does not authorize indiscriminate rewrites.

Before modifying existing architecture, inspect the actual repository and determine what already exists.

Preserve functioning behavior and compatible implementations.

Classify existing violations as architectural debt and migrate them incrementally.

Do not pretend that an existing implementation already satisfies a requirement when it does not.

Do not introduce new violations simply because similar violations already exist.

---

# 1. PRODUCT IDENTITY AND PERMANENT STRATEGIC DIRECTION

Avapardaz is a professional intelligent speech-editing and audio-processing system.

Its primary production environment is Adobe Audition.

The final product MUST be centered on a professional installed plugin that allows users to access the supported Avapardaz capabilities directly inside the host application.

The web application is a supporting product interface whose primary responsibilities are:

- Product presentation and marketing.
- Interactive demonstrations.
- Product previews.
- Documentation and tutorials.
- Pricing and subscription acquisition.
- Account and device management.
- Licensing and entitlement management.
- Cloud usage and quota management.
- Downloads and software updates.
- Customer support.
- Administrative operations.

The web application MAY retain selected processing demonstrations, browser-based previews, or other justified capabilities.

However, the website MUST NOT become a structural dependency for normal plugin-based production workflows.

### Permanent product principle

**Avapardaz is a Plugin-First product, not a Web-First application with a secondary plugin.**

The Adobe Audition plugin MUST progressively become the primary operational environment.

Users MUST be able to perform normal supported production workflows without opening the Avapardaz website.

This requirement does not imply that every web page must be copied into the plugin.

The plugin must expose the workflows and capabilities appropriate to professional audio production.

---

# 2. NON-NEGOTIABLE ARCHITECTURAL INVARIANTS

These invariants apply to every module, service, dependency, feature, and implementation.

## INV-001 — Host Independence

The Domain and Processing Core MUST remain independent of any individual host application.

The shared core MUST NOT directly depend on:

- Adobe Audition APIs.
- CEP-specific runtime objects.
- ExtendScript objects.
- Adobe-specific project objects.
- Host-specific timeline structures.
- React components.
- Browser DOM APIs.
- Browser lifecycle events.
- UI state containers.
- Cloud-provider-specific SDKs.
- Host-specific filesystem assumptions.

Host-specific operations MUST be implemented behind explicit integration boundaries.

## INV-002 — UI Independence

The UI is a presentation and interaction layer, not the owner of product logic.

Core algorithms, domain rules, processing decisions, validation, project semantics, and editing transformations MUST NOT exist exclusively inside UI components.

The Web UI and Plugin UI MUST consume shared application capabilities through explicit interfaces.

A UI redesign or replacement MUST NOT require rewriting the Processing Core.

## INV-003 — One Authoritative Processing System

Avapardaz MUST maintain one authoritative logical processing system.

This means one authoritative definition of:

- Processing capabilities.
- Domain semantics.
- Business and processing rules.
- Operation meanings.
- Input and output semantics.
- Result interpretation.
- Processing provenance.
- Supported capability versions.

Local and Cloud MUST NOT evolve into independent products with incompatible definitions of the same capability.

Different low-level implementations are permitted when required by runtime, hardware, performance, platform, or model constraints.

One executable, one binary, one programming language, one physical service, or one runtime is NOT required.

## INV-004 — Unified Local and Cloud Semantics

Local and Cloud are two execution environments of the same logical processing system.

Both MUST conform to the applicable canonical processing contracts.

They MUST preserve the same operation meaning and domain rules.

They MUST NOT silently introduce materially different editing decisions, validation rules, output structures, or processing behavior.

Exact byte-for-byte equality is not universally required for nondeterministic AI processing or hardware-dependent execution.

Instead, every capability MUST define appropriate semantic-equivalence criteria, quality thresholds, tolerances, and conformance tests.

Material differences caused by model versions, quantization, precision, or implementation must be explicit and traceable.

## INV-005 — Plugin-First Capability Design

Every core processing capability MUST be designed so that it can be consumed by the Adobe Audition integration without rewriting its underlying domain logic.

A feature implemented only inside the Web UI MUST NOT be considered a complete shared product capability when its essential behavior belongs to the Processing Core.

Web-only functionality MUST be explicitly classified and justified.

## INV-006 — Future Host Extensibility

Adobe Audition is the first primary host, not the permanent boundary of Avapardaz.

The architecture MUST preserve a practical path toward additional integrations, potentially including:

- Adobe Premiere Pro.
- DaVinci Resolve.
- Other compatible professional audio and video environments.

Future host extensibility MUST NOT justify speculative infrastructure or premature multi-host development.

Adobe-specific assumptions MUST remain outside shared domain and processing modules.

## INV-007 — Local-First Execution

Local execution is a first-class product capability.

Where an operation is supported locally and the user is entitled to use it, processing SHOULD be available without requiring permanent internet connectivity or a browser session.

Local-first is an execution and privacy principle. Plugin-first is a product-delivery principle.

Do not confuse these two requirements.

## INV-008 — Non-Destructive User Control

The system MUST distinguish analysis, proposed editing decisions, previews, and committed project modifications.

Original media and user project state MUST NOT be destructively modified without explicit authorization.

## INV-009 — No Silent Architectural Regression

No change may silently introduce:

- Host-specific dependencies into the shared core.
- UI-owned processing logic.
- Duplicated authoritative implementations.
- Incompatible Local and Cloud contracts.
- Uncontrolled media transfer.
- Unverified host API assumptions.
- Unversioned breaking changes.
- Hidden dependence on the Web Portal.

---

# 3. REQUIRED LOGICAL ARCHITECTURE

Maintain the following architectural responsibilities.

These are logical boundaries. They do not automatically require separate repositories, packages, processes, or deployment units.

## LAYER A — DOMAIN MODEL

Contains platform-independent concepts and rules.

Responsibilities include:

- Media identity and references.
- Audio segments.
- Speech and speaker entities.
- Transcription and annotation models.
- Project semantics.
- Track and clip relationships.
- Time and media representations.
- Editing decisions.
- Processing metadata.
- Provenance.
- Domain validation.

Domain models MUST NOT contain UI-specific or host-specific structures.

## LAYER B — PROCESSING CORE

Contains authoritative processing capabilities.

Responsibilities include:

- ASR and transcription.
- Speaker detection and diarization.
- Audio analysis.
- Silence and pause detection.
- Filler-word identification.
- Repetition detection.
- Intelligent speech-editing decisions.
- Audio cleanup and enhancement.
- Quality evaluation.
- Processing result generation.
- Processing confidence and provenance.

The Processing Core MUST be independently testable.

Computationally expensive processing MUST NOT be implemented inside UI components.

## LAYER C — APPLICATION AND WORKFLOW LAYER

Coordinates application-level use cases.

Responsibilities include:

- Processing orchestration.
- Workflow sequencing.
- Job lifecycle management.
- Project lifecycle coordination.
- Capability coordination.
- Result validation.
- Cancellation and recovery.
- Application-level authorization.
- Entitlement evaluation.
- Processing operation coordination.

This layer MUST depend on declared interfaces and domain contracts, not concrete presentation or host implementations.

## LAYER D — PORTS AND ADAPTERS

Define explicit boundaries between application logic and external systems.

Potential ports include:

- Processing execution.
- Host project access.
- Host project modification.
- Media access.
- Storage.
- License validation.
- Cloud job dispatch.
- Model/runtime access.

Adapters implement these contracts.

Examples include:

- Local execution adapter.
- Cloud execution adapter.
- Adobe Audition host adapter.
- Filesystem adapter.
- Model runtime adapter.
- Licensing adapter.

Reuse established interfaces where appropriate.

Do not create an interface for every function or class without a concrete architectural purpose.

## LAYER E — PRESENTATION AND USER INTERACTION

Contains:

- Web Portal UI.
- Adobe Audition Panel UI.
- Future host-specific interfaces.

Each interface MUST remain independent of the Processing Core's internal implementation.

## LAYER F — INFRASTRUCTURE AND COMMERCIAL SERVICES

Contains:

- Authentication.
- Subscriptions.
- Licensing.
- Device activation.
- Usage metering.
- Cloud quotas.
- Secure storage.
- Remote processing infrastructure.
- Update distribution.
- Permitted telemetry.
- Administration.

These services MUST NOT become dependencies of shared processing algorithms.

---

# 4. DEPENDENCY DIRECTION AND PORTS-AND-ADAPTERS RULES

The intended logical interaction model is:

```text
                  USER / EXTERNAL HOST
                           |
              +------------+------------+
              |                         |
          WEB UI                  AUDITION PANEL
              |                         |
        WEB ADAPTER              PLUGIN ADAPTER
              |                         |
              +------------+------------+
                           |
                           v
                 APPLICATION USE CASES
                           |
                +----------+----------+
                |                     |
                v                     v
          DOMAIN MODEL          HOST PORTS
                |                     |
                v                     v
         PROCESSING CORE       AUDITION ADAPTER
                |
                v
       PROCESSING CONTRACTS
                |
           +----+----+
           |         |
           v         v
         LOCAL     CLOUD
        ADAPTER   ADAPTER
```

This diagram describes logical responsibilities, not a required deployment topology.

Mandatory dependency rules:

1. Presentation layers MUST depend on application-facing interfaces.
2. Application use cases MUST depend on domain contracts and declared ports.
3. Domain logic MUST NOT depend on presentation, host, or infrastructure implementations.
4. Execution adapters MUST implement the declared execution contracts.
5. Host adapters MUST translate between host-specific representations and neutral application/domain representations.
6. Platform-specific dependencies MUST NOT leak into shared modules.
7. Infrastructure details MUST NOT determine the meaning of domain operations.
8. Shared modules MUST NOT import higher-level modules for convenience.

A host adapter MAY serve as an inbound adapter for host events and an outbound adapter for host operations.

Do not treat the host adapter as the owner of processing algorithms.

---

# 5. PROCESSING CAPABILITY MODEL

Do not model the entire Processing Core as one universal function or one oversized interface.

Define processing as a collection of explicit, identifiable capabilities.

Each capability MUST have:

- A stable capability identifier.
- A defined responsibility.
- Input requirements.
- Output semantics.
- Configuration rules.
- Supported execution environments.
- Version information.
- Error semantics.
- Relevant quality criteria.
- A defined ownership boundary.

Examples include:

- `speech.transcription`
- `speech.diarization`
- `audio.silence_detection`
- `speech.filler_detection`
- `speech.repetition_detection`
- `speech.intelligent_editing`
- `audio.enhancement`
- `audio.quality_analysis`

These identifiers are illustrative, not mandatory names.

Reuse established naming conventions and existing project contracts.

Each capability MUST have one authoritative logical definition.

Platform-specific optimizations MAY use different internal algorithms, provided they conform to the capability's defined semantics and verification criteria.

Do not duplicate a complete capability merely because it is invoked from different interfaces.

---

# 6. CANONICAL PROCESSING CONTRACT ARCHITECTURE

The processing contract MUST be standardized without becoming a monolithic schema.

Use two complementary contract levels.

## 6.1 Shared Operation Envelope

All processing operations MUST use a common conceptual envelope containing the fields necessary to coordinate execution.

Where applicable, include:

- `request_id`
- `capability_id`
- `operation_version`
- `contract_version`
- `project_id`
- `project_revision`
- `media_references`
- `input_payload`
- `configuration`
- `execution_policy`
- `requested_model_policy`
- `idempotency_key`
- `created_at`
- `correlation_id`

The exact implementation and naming may follow existing repository conventions.

## 6.2 Capability-Specific Payload Contracts

Each capability MUST define its own typed input and output schema.

Do not create one universal input or output object containing dozens of unrelated optional fields.

Capability-specific payload schemas MUST be versioned and validated.

Every result SHOULD include the relevant information:

- `request_id`
- `capability_id`
- `operation_version`
- `result_schema_version`
- `status`
- `result_payload`
- `media_references`
- `processing_metadata`
- `actual_execution_environment`
- `actual_model_identity`
- `actual_model_version`
- `provenance`
- `warnings`
- `errors`

Not every capability requires every field, but required fields MUST be defined by its schema.

## 6.3 Contract Versus Transport Protocol

A canonical processing contract is NOT the same thing as a transport protocol.

The transport may use:

- In-process function calls.
- Local IPC.
- HTTP APIs.
- WebSocket communication.
- Host messaging.
- Other suitable mechanisms.

Transport protocols MAY differ between environments.

They MUST preserve the same contract meaning after serialization and deserialization.

Do not embed transport-specific assumptions in domain schemas.

## 6.4 Contract Evolution

Contracts MUST be versioned.

Breaking changes MUST include:

- Explicit version changes.
- Consumer impact analysis.
- Migration strategy.
- Validation updates.
- Regression tests.
- Compatibility decisions.

Do not silently reinterpret old project data or processing results under new incompatible semantics.

Do not modify a shared contract merely to satisfy one UI component or one host-specific workflow.

---

# 7. LOCAL AND CLOUD EXECUTION ARCHITECTURE

Local and Cloud are execution adapters for the same logical processing capabilities.

## 7.1 Shared Semantics

Both execution environments MUST implement the relevant capability contracts.

They MUST share:

- Operation definitions.
- Input interpretation.
- Domain rules.
- Output semantics.
- Result validation.
- Error classification.
- Job lifecycle meaning.
- Processing provenance.

Internal implementations MAY differ because of hardware, model, runtime, operating-system, or deployment constraints.

## 7.2 Capability Availability

Maintain an explicit capability registry or equivalent mechanism.

For every capability, record:

- Supported Local status.
- Supported Cloud status.
- Supported operation versions.
- Required models and runtime components.
- Hardware and memory requirements.
- Input constraints.
- Output constraints.
- Execution limitations.
- Relevant entitlement requirements.

A capability MUST NOT be advertised as available in an environment without verification.

When a capability is unavailable in a requested environment, report the actual limitation.

Do not silently create a different interpretation of the same operation.

## 7.3 Execution Routing

Execution routing MUST respect:

- User-selected execution preferences.
- Capability availability.
- Runtime requirements.
- Privacy requirements.
- Subscription entitlement.
- Cloud quota.
- Resource constraints.

Silent Local-to-Cloud fallback is prohibited when it violates an explicit Local-only preference or applicable privacy policy.

Automatic routing MAY be used when it follows a documented policy and does not violate the user's explicit expectations.

## 7.4 Local and Cloud Result Compatibility

For each shared capability, define an appropriate conformance standard.

Possible evaluation criteria include:

- Structural schema compatibility.
- Semantic equivalence.
- Numerical tolerances.
- Timestamp accuracy.
- Segment boundary accuracy.
- Transcription evaluation.
- Diarization evaluation.
- Audio quality measurements.
- Editing decision consistency.

Do not require exact byte equality when nondeterministic AI behavior makes it technically inappropriate.

Where outputs differ materially, expose the relevant execution and model provenance.

## 7.5 Job Lifecycle

Long-running processing operations MUST use explicit lifecycle semantics.

Define and validate applicable states such as:

- Queued.
- Running.
- Completed.
- Failed.
- Cancelled.
- Interrupted.
- Recoverable.
- Expired.

Small synchronous operations MAY use synchronous interfaces.

Cancellation, retries, idempotency, recovery, partial failure, and result validation MUST have explicit behavior.

---

# 8. PLUGIN RUNTIME AND COMPONENT ARCHITECTURE

The Avapardaz Adobe Audition integration MUST NOT be treated as one inseparable binary.

It may consist of multiple cooperating components with distinct responsibilities and deployment lifecycles.

## 8.1 Avapardaz Audition Panel

The panel is the primary operational interface inside Adobe Audition.

It is responsible for:

- User interaction.
- Displaying processing workflows.
- Project and media context.
- Processing configuration.
- Job monitoring.
- Result review.
- Editing decision presentation.
- User approval.
- Host-related interaction through supported interfaces.

Where CEP is used, it MUST remain a presentation and integration layer.

Heavy processing MUST NOT be implemented directly inside the panel runtime.

CEP MUST NOT become the Processing Core.

## 8.2 Host Communication Bridge

Host communication MUST be isolated from processing communication.

The host bridge is responsible for supported operations involving Adobe Audition, such as:

- Obtaining available host context.
- Reading supported project information.
- Accessing supported selection and media metadata.
- Performing supported host commands.
- Translating host objects into neutral domain representations.
- Applying supported project changes.
- Handling host-specific failures.

Use supported integration mechanisms.

Do not assume the existence of unrestricted programmatic control over Audition's internal state.

## 8.3 Native Processing Companion

A separate native companion process MAY be used where Local execution, runtime compatibility, performance, native libraries, model handling, or filesystem access justify it.

Do not force every processing operation into a separate process when it is not technically necessary.

When a companion process is used:

- It MUST communicate through explicit versioned IPC contracts.
- IPC messages MUST be validated.
- The communication boundary MUST enforce appropriate local access controls.
- The process lifecycle MUST be managed.
- Errors and cancellation MUST be propagated.
- Resource usage MUST be controlled.
- The process MUST NOT expose an unnecessarily privileged local network service.
- Runtime version compatibility MUST be explicit.

The CEP panel MUST NOT directly own native processing internals.

## 8.4 Optional Native Audio Effects

Native audio effects are a separate product component.

Where justified, implement compatible effects using supported standards such as VST3 or Audio Units.

Potential responsibilities include:

- Real-time voice enhancement.
- Noise reduction.
- Voice cleanup.
- Leveling.
- Other appropriate DSP operations.

Native effects MAY share underlying DSP algorithms and processing semantics with the main system.

They MUST NOT create incompatible independent processing rules.

Do not attempt to implement every Avapardaz workflow as a native audio effect.

## 8.5 Component Compatibility

Panel, host adapter, companion runtime, effect modules, and processing contracts MUST have explicit version compatibility rules.

A plugin component update MUST NOT silently break communication with another installed component.

Installation, upgrade, removal, recovery, and rollback behavior MUST be considered during implementation.

---

# 9. ADOBE AUDITION HOST INTEGRATION REQUIREMENTS

Adobe Audition is the primary host integration target.

All integration must be based on actual, supported, and verified host capabilities.

Potential technologies include:

- CEP.
- ExtendScript.
- Adobe Audition SDK facilities.
- Supported application commands.
- SESX interoperability.
- Supported native audio plug-in standards.
- Other verified official integration mechanisms.

No mechanism is mandatory simply because it is named here.

The coding agent MUST verify:

- Target Audition versions.
- Operating-system compatibility.
- API availability.
- Runtime requirements.
- Known restrictions.
- Distribution requirements.
- Real host behavior.

## 9.1 Host Capability Classification

Every integration feature MUST be classified accurately.

Use the following capability levels:

1. **Context Access:** Read available host, project, media, or selection context.
2. **Analysis Integration:** Analyze host-associated media.
3. **Interchange Integration:** Exchange supported media, project, and metadata representations.
4. **Project Modification:** Apply supported project changes.
5. **Interactive Synchronization:** Synchronize supported project changes or context.
6. **Real-Time Audio Integration:** Operate inside a supported real-time audio-processing context.

Do not claim a higher capability level than has been verified.

## 9.2 Host Capability Matrix

For each supported feature, record:

- Feature identifier.
- Required host operation.
- Integration mechanism.
- Minimum verified host version.
- Supported operating systems.
- Tested plugin/runtime versions.
- Host capability level.
- Known limitations.
- Fallback workflow.
- Verification evidence.

## 9.3 SESX and Project Interchange

SESX and other host-specific formats MUST be treated as host interoperability representations, not the authoritative internal domain model.

Do not assume that direct file generation or modification guarantees compatibility.

Validate:

- Correct session structure.
- Media references.
- Relative and absolute paths.
- Track relationships.
- Clip timing.
- Metadata.
- Sample-rate compatibility.
- File availability.
- Host version behavior.

Direct session interchange MUST be tested with actual target Audition versions.

A valid XML document alone does not prove a valid Audition session.

## 9.4 Unsupported Host Operations

When the host does not expose a required operation through a supported mechanism:

- Do not fabricate support.
- Do not claim unrestricted integration.
- Do not rely silently on undocumented behavior.
- Isolate the limitation in the Host Adapter.
- Evaluate supported interchange or alternative workflows.
- Provide an explicit user-facing limitation.
- Preserve a replacement path for future integration improvements.

A supported user-controlled workflow is preferable to an unstable or undocumented automation hack.

---

# 10. CANONICAL PROJECT AND MEDIA REPRESENTATION

Avapardaz MUST maintain a host-neutral representation of project and editing semantics.

Do not use Adobe Audition's internal project representation as the universal source of truth.

Where applicable, represent:

- Projects.
- Source media.
- Media identity.
- Media references.
- Tracks.
- Channels.
- Audio regions.
- Clips.
- Speech segments.
- Speaker assignments.
- Transcriptions.
- Markers.
- Time ranges.
- Gain and automation metadata.
- Processing annotations.
- Editing decisions.
- Project revisions.
- Operation history.
- Provenance.

## 10.1 Time and Audio Representation

Time representation MUST be explicit and unambiguous.

Do not mix samples, seconds, milliseconds, frames, ticks, or host-specific time units without explicit conversion.

Where appropriate, use integer sample positions associated with an explicit sample rate.

When representing external timebases, preserve the required precision and conversion metadata.

Define rules for:

- Sample rates.
- Channel layouts.
- Sample positions.
- Duration.
- Bit depth.
- Audio encoding.
- Timebase conversion.
- Resampling.
- Channel conversion.
- Synchronization.
- Media offsets.

All transformations that affect media timing or representation MUST be explicit and testable.

## 10.2 Media Identity and File References

Do not rely solely on mutable filesystem paths as permanent media identity.

Where appropriate, maintain stable media identifiers and separately resolved storage references.

Support missing, moved, renamed, or unavailable media through explicit error and recovery workflows.

Host-specific file references MUST be translated through the relevant adapter.

---

# 11. EDITING OPERATIONS, PROJECT INTEGRITY, AND REVERSIBILITY

Avapardaz MUST preserve user control and professional editing safety.

Distinguish the following operation states:

1. Source media analysis.
2. Processing result generation.
3. Editing proposal generation.
4. Preview and validation.
5. User approval.
6. Host project modification.
7. Verification of the committed result.

Do not collapse these states into one implicit operation.

## 11.1 Non-Destructive Principle

Original source media MUST NOT be destructively overwritten without explicit user authorization.

Preserve, wherever technically possible:

- Original source media.
- Original project state.
- Stable media references.
- Timeline relationships.
- User-approved edits.
- Reversible operation history.
- Processing provenance.

## 11.2 Edit Plan and Commit Boundary

Where practical, processing decisions SHOULD produce an explicit edit plan or equivalent representation before modifying the host project.

A committed modification SHOULD identify:

- The source project revision.
- The requested operation.
- The intended modifications.
- The approved changes.
- The resulting project revision.
- The execution and processing provenance.

## 11.3 Concurrency and Stale Projects

Before applying a modification, detect whether the host project has changed since the analysis or proposal was generated.

Do not apply stale edit plans blindly.

Use project revisions, timestamps, stable identifiers, or other verified consistency mechanisms.

Where conflicts are detected, reject, revalidate, or request an explicit resolution.

## 11.4 Reversibility

Use transactions, undo support, compensating actions, or other recovery mechanisms where supported.

Do not promise reversibility for host operations that cannot reliably be reversed.

When a host limitation prevents full rollback, communicate the limitation and require an appropriate confirmation before risky changes.

---

# 12. FEATURE OWNERSHIP AND CROSS-INTERFACE CAPABILITY MATRIX

Maintain an authoritative feature registry or equivalent documentation.

Every product capability MUST be classified according to its actual ownership.

Use these categories:

1. **Shared Processing Capability:** Owned by the Processing Core.
2. **Application Workflow:** Owned by application orchestration.
3. **Host Integration Capability:** Owned by a host-specific adapter.
4. **Presentation Capability:** Owned by a UI.
5. **Commercial Capability:** Owned by account, subscription, licensing, or billing services.
6. **Demonstration Capability:** A web-specific preview or demonstration.

For each processing capability, track:

- Core implementation status.
- Contract version.
- Local execution status.
- Cloud execution status.
- Processing conformance status.
- Web presentation status.
- Plugin presentation status.
- Audition host integration level.
- Project write-back status, where applicable.
- Known limitations.
- Verification evidence.

This matrix MUST prevent the false assumption that a feature is fully supported simply because it exists in one interface.

Do not claim complete Web-to-Plugin parity without evidence.

Feature parity is measured by actual supported workflows and capabilities, not by matching UI screens.

---

# 13. WEB APPLICATION ARCHITECTURAL BOUNDARY

The Web Portal is a supporting interface.

Its primary responsibilities are commercial, administrative, educational, and demonstrative.

The Web Portal MAY access shared application capabilities through appropriate interfaces.

However:

- Core processing MUST NOT depend on Web UI lifecycle.
- Local processing MUST NOT require a browser session.
- Plugin operation MUST NOT require the website for normal supported workflows.
- Web-only dependencies MUST remain outside shared processing modules.
- Browser-only implementation details MUST NOT leak into the Processing Core.

The web application SHOULD evolve toward the role of a product showcase and customer portal.

Do not blindly duplicate browser screens in the plugin.

The plugin must be designed for professional production workflows, not merely reproduce the website's navigation.

---

# 14. DEPENDENCY, TECHNOLOGY, AND RUNTIME GOVERNANCE

Before introducing a framework, dependency, SDK, library, model runtime, or service, evaluate its long-term architectural effects.

Evaluate:

- Host independence.
- UI independence.
- Local execution compatibility.
- Cloud execution compatibility.
- Native processing requirements.
- Plugin communication requirements.
- Adobe Audition compatibility.
- Operating-system compatibility.
- Packaging and distribution.
- Security and licensing.
- Performance.
- Memory consumption.
- Maintenance cost.
- Replacement and migration cost.

### Dependency placement

- UI libraries MUST remain in presentation modules.
- CEP dependencies MUST remain in plugin/presentation integration modules.
- Host-specific SDKs MUST remain in host adapters.
- Cloud-provider dependencies MUST remain in Cloud adapters or infrastructure.
- Native runtime dependencies MUST be isolated behind appropriate interfaces.
- Shared domain modules MUST NOT import platform-specific modules.

A dependency used by the existing web application MUST NOT automatically be considered suitable for the shared core or native runtime.

Do not perform large migrations solely for architectural aesthetics.

Select the smallest verified change that establishes the required boundary.

---

# 15. SECURITY, PRIVACY, LICENSING, AND DISTRIBUTION

Security and privacy are mandatory system properties.

## 15.1 Media and Project Privacy

Every Cloud transfer MUST have an explicit data-handling purpose and policy.

Define:

- What data is transferred.
- Why it is transferred.
- Where it is processed.
- Whether it is stored.
- How long it is retained.
- How it can be deleted.
- Whether source media or derived data is included.
- Which operations remain Local.

Do not transmit unnecessary media or project information.

## 15.2 IPC and Runtime Security

The plugin-to-companion communication boundary MUST use validated and versioned messages.

Local IPC MUST use appropriate operating-system protections and least-privilege access.

Do not expose unrestricted local endpoints.

Do not grant processing components filesystem or network privileges that they do not need.

## 15.3 License and Entitlement Isolation

Authentication, subscription, licensing, and payment logic MUST remain separate from the Processing Core.

Local capabilities licensed for offline use MUST remain usable under their valid offline entitlement rules.

Cloud-only operations MUST enforce appropriate authorization and quota policies.

Never treat client-side entitlement state as the only authorization control for protected Cloud services.

Keep private credentials and server secrets out of distributed plugin code.

## 15.4 Updates and Installation

Define secure installation and updating procedures for all distributed components.

Where applicable, support:

- Package integrity verification.
- Signed releases.
- Component compatibility checks.
- Version validation.
- Safe upgrade behavior.
- Recovery from failed updates.
- Rollback.
- Removal and cleanup.

A component update MUST NOT silently invalidate the compatibility of other installed components.

---

# 16. TESTING AND ARCHITECTURAL VERIFICATION

Architectural compliance MUST be verified through automated and integration testing wherever practical.

Maintain checks for:

- Dependency direction.
- Prohibited imports.
- Core isolation.
- UI separation.
- Host adapter boundaries.
- Contract validation.
- Schema compatibility.
- Local/Cloud conformance.
- Processing regression.
- Project integrity.
- IPC message validation.
- Job lifecycle.
- Cancellation and recovery.
- Licensing boundaries.
- Privacy requirements.

## 16.1 Capability Conformance Testing

Every major processing capability SHOULD have a shared conformance test suite.

Run applicable tests against Local and Cloud implementations.

Verify:

- Input interpretation.
- Operation semantics.
- Output structure.
- Error behavior.
- Execution metadata.
- Model provenance.
- Quality metrics.
- Relevant tolerances.
- Compatibility.

Use deterministic fixtures and golden datasets where appropriate.

For nondeterministic AI systems, use task-specific evaluation metrics and acceptance thresholds.

Do not use superficial mock-based tests as evidence of equivalent real-world processing quality.

## 16.2 Actual Host Integration Testing

Mocks and unit tests alone DO NOT establish actual Adobe Audition compatibility.

Test against real supported host versions and operating systems whenever practical.

Verify:

- Panel installation.
- Panel startup.
- Host communication.
- Project context access.
- Media exchange.
- Supported editing operations.
- Session interchange.
- Result commit behavior.
- Failure recovery.
- Host version compatibility.

A feature MUST NOT be advertised as fully integrated merely because the panel renders or an internal processing function succeeds.

## 16.3 Compatibility Matrix

Maintain an explicit compatibility matrix for:

- Operating systems.
- Adobe Audition versions.
- Panel versions.
- Host adapter versions.
- Native companion versions.
- Audio effect versions.
- Processing contract versions.
- Model/runtime versions.

Test supported combinations and clearly identify unsupported combinations.

---

# 17. INCREMENTAL MIGRATION AND EARLY INTEGRATION STRATEGY

Do not postpone plugin integration until the entire web application or every processing feature is completed.

Do not prematurely rewrite the existing codebase.

Use incremental migration and early integration proof.

## 17.1 Repository-First Migration

Before every substantial architectural change:

1. Inspect the relevant existing source code.
2. Map actual dependencies.
3. Identify existing contracts.
4. Locate duplicated logic.
5. Determine current processing ownership.
6. Identify plugin-blocking dependencies.
7. Identify Local/Cloud compatibility gaps.
8. Select the smallest safe migration step.

## 17.2 Early Vertical Integration Proof

Establish an early end-to-end integration path using at least one representative processing capability.

The proof SHOULD cover:

1. Launching the Avapardaz panel inside Audition.
2. Obtaining supported host context.
3. Invoking a shared application capability.
4. Dispatching processing through the Local execution path.
5. Returning a canonical processing result.
6. Displaying that result in the panel.
7. Producing a reviewable edit proposal.
8. Applying a supported project modification or verified interchange workflow.
9. Validating the resulting project state.

The proof MUST use actual integration mechanisms, not only UI mocks.

If a required host environment is unavailable, isolate the missing verification and mark it as unverified rather than claiming completion.

## 17.3 Incremental Feature Integration

Integrate features progressively as their contracts and execution paths become stable.

Do not wait for every possible Processing Core capability before integrating the plugin.

Do not migrate all processing to native technologies without demonstrated requirements.

Preserve existing working functionality during migration.

---

# 18. VERSIONING AND COMPATIBILITY MANAGEMENT

Version important shared contracts and distributed components explicitly.

This includes:

- Processing capability contracts.
- Domain schemas.
- Project representations.
- Processing result formats.
- IPC protocols.
- Plugin-to-core communication.
- Local runtime versions.
- Cloud runtime versions.
- Model versions.
- Host adapter versions.
- Native audio effect versions.

Breaking changes MUST include migration and compatibility decisions.

Previously generated projects and processing results MUST NOT be silently reinterpreted under incompatible new semantics.

The system MUST define how unsupported or obsolete versions are handled.

---

# 19. MANDATORY AI CODING AGENT PROTOCOL

All AI coding agents MUST treat this constitution as persistent project-level architectural context.

## Before implementation

The agent MUST:

- Read this constitution.
- Inspect the actual repository.
- Identify existing implementations.
- Identify the correct architectural owner of the requested capability.
- Check existing contracts and interfaces.
- Identify possible architectural conflicts.
- Avoid assuming that undocumented capabilities exist.

## During implementation

The agent MUST:

- Preserve existing valid architecture.
- Reuse existing shared functionality where appropriate.
- Avoid duplicated processing logic.
- Keep UI and host dependencies isolated.
- Preserve Local/Cloud semantics.
- Maintain contract compatibility.
- Respect data integrity and user control.
- Implement the smallest appropriate architectural change.
- Avoid speculative abstractions.

## After implementation

The agent MUST:

- Run relevant tests.
- Add or update tests for changed boundaries.
- Verify the actual implementation.
- Update affected contracts and documentation.
- Record unresolved limitations.
- Report actual evidence rather than unsupported claims.

## Autonomous engineering decisions

The agent MAY make ordinary implementation decisions autonomously when they are supported by repository evidence, established project conventions, and this constitution.

The agent MUST NOT invent product requirements or silently make material irreversible product decisions.

When a decision requires an unresolved product choice, material security judgment, legal judgment, or irreversible architectural trade-off, document the alternatives and request the necessary human decision.

Routine engineering decisions MUST NOT cause unnecessary interruptions.

---

# 20. ARCHITECTURAL EXCEPTION MANAGEMENT

An exception is permitted only when a genuine technical limitation or justified product constraint requires it.

Every exception MUST document:

1. The affected invariant.
2. The precise technical reason.
3. Repository or platform evidence.
4. Affected modules and consumers.
5. Short-term consequences.
6. Long-term architectural risks.
7. Isolation strategy.
8. Mitigation or replacement plan.
9. Removal condition, where applicable.
10. Required verification.

Exceptions MUST be limited to the smallest practical boundary.

Schedule pressure, convenience, coding habits, or the existence of previous violations are not sufficient justifications.

Temporary workarounds MUST NOT silently become permanent architecture.

---

# 21. ARCHITECTURAL PRIORITY AND CONFLICT RESOLUTION

When requirements conflict, apply this priority order:

1. Data integrity, security, and user safety.
2. Processing correctness and reliability.
3. Mandatory architectural invariants.
4. User privacy and Local-first execution.
5. Adobe Audition plugin compatibility.
6. Contract and project-data compatibility.
7. Maintainability and testability.
8. Future host extensibility.
9. Short-term implementation convenience.

This order MUST NOT be used to justify unnecessary abstractions, premature migrations, or speculative infrastructure.

Choose the simplest implementation that preserves the required architectural boundaries.

---

# 22. DEFINITION OF PROCESSING CORE READINESS

The Processing Core is sufficiently ready for broader plugin integration when:

- Major capabilities have clear architectural ownership.
- Shared processing logic is independent of Web UI.
- Shared processing logic is independent of Adobe-specific APIs.
- Processing capability contracts are explicit and versioned.
- Local and Cloud implementations follow compatible semantics.
- Execution differences are measurable and documented.
- Project and media representations are host-neutral where appropriate.
- Application workflows can invoke processing without a browser.
- Major processing operations are independently testable.
- Plugin communication boundaries are established.
- Major plugin-blocking dependencies are identified.
- At least one real end-to-end plugin integration path has been validated.
- Remaining limitations have explicit migration or mitigation plans.

These conditions do NOT require the entire product to be finished.

They do NOT require every capability to support identical hardware, models, or execution optimizations.

They do NOT require a completed web application.

They MUST NOT be used as a reason to postpone early Audition integration.

---

# 23. DEFINITION OF PLUGIN PRODUCT READINESS

The Adobe Audition integration is not considered a complete professional product merely because a panel has been installed successfully.

Product readiness requires verified support for the declared release scope, including:

- Reliable installation and activation.
- Host startup and lifecycle handling.
- Stable host communication.
- Stable panel-to-core communication.
- Supported Local and Cloud processing workflows.
- User-visible processing progress and failures.
- Project and media integrity.
- Non-destructive result review.
- Reliable result application or interchange.
- Version compatibility.
- Error recovery.
- Appropriate security and licensing.
- Documentation for known limitations.
- Real-host verification.

Unsupported workflows MUST be identified rather than hidden.

---

# 24. FINAL PERMANENT ARCHITECTURAL DIRECTIVE

Every current and future development decision MUST preserve the following target system:

**ONE AUTHORITATIVE DOMAIN AND PROCESSING SYSTEM.**

**ONE AUTHORITATIVE DEFINITION OF EACH PROCESSING CAPABILITY.**

**ONE VERSIONED CONTRACT MODEL WITH CAPABILITY-SPECIFIC SCHEMAS.**

**TWO COMPATIBLE EXECUTION ENVIRONMENTS: LOCAL AND CLOUD.**

**INDEPENDENT APPLICATION ORCHESTRATION.**

**HOST-SPECIFIC INTEGRATION THROUGH ISOLATED ADAPTERS.**

**A COMPLETE PROFESSIONAL ADOBE AUDITION PLUGIN EXPERIENCE.**

**OPTIONAL NATIVE AUDIO EFFECTS WITH CLEARLY SEPARATED RESPONSIBILITIES.**

**A SUPPORTING WEB PORTAL FOR MARKETING, DEMONSTRATION, COMMERCIAL, AND ADMINISTRATIVE WORKFLOWS.**

**A PRACTICAL PATH TO FUTURE HOST INTEGRATIONS WITHOUT REWRITING THE PROCESSING CORE.**

The Processing Core MUST NOT become Web-UI-dependent.

The Processing Core MUST NOT become Adobe-dependent.

The Web Portal MUST NOT become a structural dependency for normal plugin operation.

The Adobe Audition adapter MUST NOT become the owner of shared processing logic.

The Local and Cloud execution paths MUST NOT become incompatible processing products.

The Plugin Panel MUST NOT become a container for heavyweight processing implementation.

Native audio effects MUST NOT become a duplicate application architecture.

Host capabilities MUST be verified, not assumed.

Project integrity and user control MUST be preserved.

All migrations MUST be incremental, evidence-based, and testable.

**This constitution is permanent and mandatory. Every future implementation MUST preserve these invariants. Any newly introduced architectural violation MUST be corrected before acceptance. Existing violations MUST be documented and addressed through an explicit migration plan.**