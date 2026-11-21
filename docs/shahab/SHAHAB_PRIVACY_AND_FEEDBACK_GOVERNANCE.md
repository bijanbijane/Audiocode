# SHAHAB Privacy & Human Feedback Governance (SHAHAB-014)

- External telemetry is **OFF by default**.
- Operational events reject raw audio, transcripts, personal vocabulary, and personal file paths via `assertNoSensitiveOperationalPayload()`.
- User editing corrections enter `CONSENT_PENDING` and can NEVER enter research/evaluation datasets without explicit research consent, human review, zero unresolved conflict, and leakage verification.
