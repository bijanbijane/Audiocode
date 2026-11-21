# SHAHAB SDK Architecture (SHAHAB-022 — API v1.0.0)

- **Layering:** `Host Application -> Host Adapter -> SHAHAB SDK (src/shahab/sdk/ShahabSdk.ts) -> SHAHAB Engine -> Runtime Adapter -> Frozen Model`
- **Entry Gate (SHAHAB-021):** `NO_GO_REQUIRES_ENGINEERING_FIXES` — blocked production release capabilities remain explicitly unavailable.
- **Packaging Form:** In-process TypeScript SDK module with host-neutral JSON-serializable request/result/event/error schemas and zero UI or Adobe dependencies.
- **Non-Duplication:** Wraps existing `SHAHABFrozenModelAdapter`, `SHAHABIncrementalStreamingSession`, `SHAHABCapabilityNegotiationEngine`, `SHAHABJobStateMachine`, and `SHAHABPersianFidelity`.
