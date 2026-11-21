# SHAHAB–Avapardaz Job Orchestration (SHAHAB-023)

Submits jobs through `ShahabSdkEngine.submitTranscription` with project-scoped idempotency keys, truthful stage + `processedAudioSec / totalAudioSec` progress (`fakePercentageDisplayed = false`), and cancellation propagation.
