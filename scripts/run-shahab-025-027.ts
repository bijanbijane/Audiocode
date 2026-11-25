import { runAndPersistShahab025To027 } from '../src/shahab/ShahabSpeechPrepArtifacts.ts';

const out = runAndPersistShahab025To027(process.cwd());
console.log(
  JSON.stringify(
    {
      shahab025: {
        status: out.alignmentState.finalStatus,
        capability: out.alignmentState.capabilities.capabilityStatus,
        honestSegGranularity: out.alignmentState.sampleRuns.honestSegmentAnchoredRun.effectiveGranularity,
        ctcBoundaryMaeMs: out.alignmentState.sampleRuns.controlledCtcViterbiRun.evaluationMetrics.boundaryMaeMs,
      },
      shahab026: {
        status: out.diarizationState.finalStatus,
        capability: out.diarizationState.capabilities.capabilityStatus,
        speakers: out.diarizationState.sampleRun.detectedSpeakerCount,
        overlapMs: out.diarizationState.sampleRun.overlapDurationMs,
        controlledDer: out.diarizationState.sampleRun.controlledFixtureMetrics.diarizationErrorRate,
      },
      shahab027: {
        status: out.subtitleState.finalStatus,
        cues: out.subtitleState.sampleDocument.cues.length,
        qaErrors: out.subtitleState.sampleDocument.qaReport.errorCount,
        srtRoundTrip: out.subtitleState.exports.srt.roundTripPassed,
        vttRoundTrip: out.subtitleState.exports.webvtt.roundTripPassed,
        ttmlRoundTrip: out.subtitleState.exports.ttml.roundTripPassed,
      },
    },
    null,
    2,
  ),
);
