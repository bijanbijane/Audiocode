# SHAHAB–Adobe Audition Integration Architecture (SHAHAB-024)

- **Selected Pattern:** `Adobe Audition -> User-Controlled WAV Export -> AdobeAuditionHostAdapter (Companion) -> SHAHAB-022 SDK -> SHAHAB Engine -> Audition Markers CSV / SRT / JSON Sidecar -> User Import into Audition Markers Panel`
- **Core Isolation:** ZERO Adobe dependencies inside `src/shahab/sdk/` or neural core; ZERO real-time audio-callback inference; ZERO memory injection or private API usage.
