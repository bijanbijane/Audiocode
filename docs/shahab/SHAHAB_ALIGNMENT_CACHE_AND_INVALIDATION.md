# SHAHAB-025 Alignment Cache & Revision Invalidation

- **Identity Key:** SHA-256 over `audioSha256`, `sampleRange`, `transcriptSha256`, `transcriptRevisionId`, `transcriptLayer`, `alignerId`, `alignerRevision`, `normalizationPolicyVersion`, and `contractVersion`.
- **Invalidation Triggers:** Transcript revision change, audio revision change, aligner version change, or manual invalidation. All invalidations are recorded in `invalidationLog`.
