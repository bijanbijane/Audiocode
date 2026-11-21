# SHAHAB Resource Ownership Policy

- **Audio Buffers:** Copied on ingest (`COPIED_ON_INGEST_IMMUTABLE`); host retains ownership of its source buffers.
- **Engine & Sessions:** Explicit `dispose()` / `disposeJob()` / `disposeStreamingSession()` release WASM sessions and event listeners; post-dispose calls throw `ENGINE_DISPOSED`.
