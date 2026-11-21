# SHAHAB–Avapardaz Native Integration Architecture (SHAHAB-023)

- **Boundary:** `AvapardazShahabAdapter` (`src/shahab/adapters/AvapardazShahabAdapter.ts`) consumes ONLY `SHAHAB-022` SDK (`src/shahab/sdk/ShahabSdk.ts`).
- **Ownership Map:**
  - **Project**: `LoadedStudioProject / ProjectDocument` (src/engine/audioFixtures.ts & src/contracts/project-schema.contract.ts) -> Owner: `AVAPARDAZ_PRODUCT`
  - **Asset**: `AssetIdentityRecord` (src/project-core/ProjectLifecycleAndMigrationEngine.ts) -> Owner: `AVAPARDAZ_PRODUCT`
  - **Timeline & Timebase**: `FlickRange (705,600,000 flicks/sec)` (src/engine/timebase.ts & src/contracts/v1_2.ts) -> Owner: `AVAPARDAZ_PRODUCT`
  - **Track & Clip**: `Track / TimelineTrack` (src/contracts/v1_2.ts) -> Owner: `AVAPARDAZ_PRODUCT`
  - **Transcript Editor UI**: `TranscriptPanel & PersianWordToken` (src/components/TranscriptPanel.tsx) -> Owner: `AVAPARDAZ_PRODUCT`
  - **Undo / Redo History**: `TimelineHistoryManager` (src/engine/timeline.ts) -> Owner: `AVAPARDAZ_PRODUCT`
  - **Linguistic Authority (P0-009/010/012)**: `PersianLinguisticQualityEngine / PersianEvidenceCorrectionEngine / PersianLexicalDisambiguationEngine` (src/asr-core/) -> Owner: `AVAPARDAZ_PRODUCT`
  - **Execution Mode & Privacy**: `ExecutionModePreferenceStore / AudioSecurityGuard` (src/processing-engine/ExecutionModePreferenceStore.ts) -> Owner: `AVAPARDAZ_PRODUCT`
  - **Speech Recognition Core**: `ShahabSdkEngine (SHAHAB-022)` (src/shahab/sdk/ShahabSdk.ts) -> Owner: `SHAHAB_ENGINE`
  - **Job & Provenance Link**: `projectId + assetId + mediaRevision + jobId` (src/shahab/adapters/AvapardazShahabAdapter.ts) -> Owner: `SHARED_CORRELATION_ID`
