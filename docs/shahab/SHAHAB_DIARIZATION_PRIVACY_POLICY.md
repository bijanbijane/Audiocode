# SHAHAB-026 Biometric & Privacy Governance Policy

- Explicit user consent required (`privacy.explicitUserConsentGranted === true`); denied requests fail closed.
- Ephemeral acoustic/embedding vectors are zero-filled and purged immediately after clustering (`embeddingsRetained: false`).
- Operational diagnostics contain zero raw audio samples and zero embedding vectors.
