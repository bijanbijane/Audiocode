# SHAHAB-026 SDK Contract

Exposed on `ShahabSdkEngine` (`src/shahab/sdk/ShahabSdk.ts`):
- `inspectDiarizationCapabilities()`
- `createDiarizationRequest(input)`
- `submitDiarization(requestIdOrInput)`
- `getDiarizationStatus(requestId)`
- `getDiarizationResult(requestId)`
- `cancelDiarization(requestId)`
- `reviseSpeakerAssignment(requestId, operation)`
- `undoLastSpeakerRevision(requestId)`
- `disposeDiarizationResult(requestId)`
- `attributeTranscriptWithDiarization(alignment, diarization, granularity)`
