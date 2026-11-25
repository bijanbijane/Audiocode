import path from 'node:path';
import { generateAndPersistShahab028To030Artifacts } from '../src/shahab/ShahabEditingSuiteArtifacts.ts';

const workspaceRoot = process.cwd();
const out = generateAndPersistShahab028To030Artifacts({
  workspaceRoot,
  docsDir: path.join(workspaceRoot, 'docs', 'shahab'),
});

console.log(
  JSON.stringify(
    {
      shahab028: {
        status: out.audioIntelState.finalStatus,
        evaluation: out.audioIntelState.referenceEvaluation,
      },
      shahab029: {
        status: out.editDecisionState.finalStatus,
        planId: (out.editDecisionState.samplePlan as any).planId,
        summary: (out.editDecisionState.samplePlan as any).summary,
      },
      shahab030: {
        status: out.renderState.finalStatus,
        validation: (out.renderState.finalRenderSummary as any).validation,
        finalRenderPath: path.relative(workspaceRoot, out.finalRenderPath),
      },
    },
    null,
    2,
  ),
);
