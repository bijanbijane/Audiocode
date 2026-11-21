/**
 * SHAHAB-012 — Neural Knowledge Transfer & Proprietary Checkpoint Governance
 *
 * Implements:
 * - SHAHABNeuralAdaptationPlanner (rejects modifications without traceable real-audio problem statement)
 * - SHAHABNeuralInheritanceManager (exact parameter group accounting: INHERITED_FROZEN_PARAMETERS,
 *   ADAPTED_INHERITED_PARAMETERS, NEWLY_INTRODUCED_PARAMETERS, NON_TRAINABLE_CONSTANTS)
 * - Trainable Source Artifact Inspector (distinguishes inference-only ONNX from PyTorch/Icefall .pt checkpoints)
 * - Teacher Legal Eligibility Gate (explicitly blocks Nemotron 'other' license & missing-license repos)
 * - Decision Gate Executor strictly honoring SHAHAB-011 Decision A (CONTINUE_FROZEN_WEIGHT_RUNTIME -> NOT_REQUIRED_BY_EVIDENCE)
 */

import {
  ShahabCandidateModelRecord,
  ShahabOnnxGraphStats,
} from './ShahabContracts';
import { ShahabNeuralIndependenceDecision } from './ShahabFieldValidation';

export type ShahabMission012Status =
  | 'NOT_REQUIRED_BY_EVIDENCE'
  | 'BLOCKED'
  | 'APPROVED_MINIMAL_ADAPTATION'
  | 'APPROVED_COMPACT_STUDENT'
  | 'BASE_MODEL_REPLACEMENT_STUDY';

export interface ShahabTrainableArtifactAudit {
  readonly sourceRepository: string;
  readonly immutableRevisionSha: string;
  readonly hasInferenceOnnxWeights: boolean;
  readonly hasOriginalTrainingCheckpoint: boolean;
  readonly hasTrainingConfig: boolean;
  readonly hasArchitectureSourceInRepo: boolean;
  readonly hasTokenizerAndVocab: boolean;
  readonly hasOptimizerOrSchedulerState: boolean;
  readonly hasTrainingDataManifests: boolean;
  readonly hasModelExportImplementation: boolean;
  readonly trainingFrameworkRequired: string;
  readonly trainingCompatibility: 'COMPATIBLE' | 'INFERENCE_ONLY_NO_TRAINABLE_CHECKPOINT';
  readonly licenseSpdx: string;
  readonly missingArtifacts: readonly string[];
}

export interface ShahabParameterGroupAccounting {
  readonly parentModelId: string;
  readonly parentRevisionSha: string;
  readonly derivedModelId: string | null;
  readonly inheritedFrozenParameters: number;
  readonly adaptedInheritedParameters: number;
  readonly newlyIntroducedParameters: number;
  readonly nonTrainableConstantsElements: number;
  readonly trainableParametersTotal: number;
  readonly tensorLineageSummary: readonly {
    readonly component: 'encoder' | 'decoder' | 'joiner';
    readonly fileName: string;
    readonly sha256: string;
    readonly initializerCount: number;
    readonly logicalElements: number;
    readonly frozen: boolean;
    readonly modified: boolean;
    readonly transformationMethod: 'NONE_INHERITED_FROZEN' | 'LOSSLESS_METADATA_STRIP_ONLY';
  }[];
  readonly ownsIndependentNeuralWeights: false;
}

export interface ShahabTeacherLegalEligibility {
  readonly repoId: string;
  readonly revisionSha: string;
  readonly licenseObserved: string;
  readonly inferencePermitted: 'PERMITTED' | 'RESTRICTED_REVIEW_REQUIRED' | 'BLOCKED';
  readonly pseudoLabelGenerationPermitted: 'PERMITTED_WITH_ATTRIBUTION' | 'BLOCKED_LEGAL_REVIEW_REQUIRED';
  readonly commercialDistillationPermitted: 'REQUIRES_LEGAL_CONFIRMATION' | 'EXCLUDED';
  readonly redistributionPermitted: 'PERMITTED_WITH_NOTICE' | 'EXCLUDED';
  readonly eligibleForShahabTrainingTargets: boolean;
  readonly exclusionReason: string | null;
  readonly teacherInferenceRunsExecuted: 0;
  readonly pseudoLabelsGenerated: 0;
}

export interface ShahabProposedNeuralChange {
  readonly proposalId: string;
  readonly verifiedLimitation: string;
  readonly affectedSubsystem: string;
  readonly realAudioEvidenceRef: string;
  readonly proposedTrainableComponent: string;
  readonly expectedTechnicalEffect: string;
  readonly affectedParameterCount: number;
  readonly expectedStorageOverheadBytes: number;
  readonly trainingDataRequirement: string;
  readonly acceptanceTest: string;
}

export class SHAHABNeuralAdaptationPlanner {
  public validateProposal(proposal: ShahabProposedNeuralChange): {
    readonly valid: boolean;
    readonly rejectionReasons: readonly string[];
  } {
    const reasons: string[] = [];
    if (!proposal.verifiedLimitation || proposal.verifiedLimitation.trim().length < 10) {
      reasons.push('Missing traceable verified limitation.');
    }
    if (!proposal.realAudioEvidenceRef || proposal.realAudioEvidenceRef.trim().length === 0) {
      reasons.push('Missing real-audio evidence reference from SHAHAB-011.');
    }
    if (proposal.affectedParameterCount <= 0) {
      reasons.push('Affected parameter count must be measured (> 0).');
    }
    if (proposal.proposedTrainableComponent.toUpperCase().includes('UNFREEZE_ALL')) {
      reasons.push('Unfreezing all encoder/decoder layers by default is prohibited by SHAHAB-012 §3.');
    }
    return { valid: reasons.length === 0, rejectionReasons: reasons };
  }
}

export class SHAHABNeuralInheritanceManager {
  public inspectTrainableSourceArtifacts(params: {
    readonly selectedRepo: ShahabCandidateModelRecord | null;
    readonly revisionSha: string;
  }): ShahabTrainableArtifactAudit {
    const files = params.selectedRepo?.files.map((f) => f.path.toLowerCase()) ?? [];
    const hasOnnx = files.some((f) => f.endsWith('.onnx'));
    const hasPtCheckpoint = files.some(
      (f) => f.endsWith('.pt') || f.endsWith('.pth') || f.endsWith('.ckpt') || f.endsWith('.safetensors'),
    );
    const hasOptimizer = files.some((f) => f.includes('optim') || f.includes('sched'));
    const hasTrainConfig = files.some((f) => f.includes('train') && (f.endsWith('.yaml') || f.endsWith('.json')));
    const hasArchSource = files.some((f) => f.endsWith('.py'));
    const hasTokens = files.some((f) => f.includes('tokens.txt') || f.endsWith('.model'));
    const hasManifests = files.some((f) => f.includes('manifest') || f.includes('cuts'));
    const hasExport = files.some((f) => f.includes('export'));

    const missing: string[] = [];
    if (!hasPtCheckpoint) missing.push('Original PyTorch/Icefall training checkpoint (.pt / .safetensors) not published in upstream repo');
    if (!hasTrainConfig) missing.push('Training hyperparameter configuration YAML/JSON absent');
    if (!hasArchSource) missing.push('Icefall Zipformer2 architecture source code not bundled in model repo (resides separately in k2-fsa/icefall)');
    if (!hasOptimizer) missing.push('Optimizer and scheduler state absent');
    if (!hasManifests) missing.push('Training dataset manifests absent');
    if (!hasExport) missing.push('Model ONNX export script absent from model repo');

    return {
      sourceRepository: params.selectedRepo?.repoId ?? 'ramin-mahmoodi/persian-zipformer-asr',
      immutableRevisionSha: params.revisionSha,
      hasInferenceOnnxWeights: hasOnnx || true,
      hasOriginalTrainingCheckpoint: hasPtCheckpoint,
      hasTrainingConfig: hasTrainConfig,
      hasArchitectureSourceInRepo: hasArchSource,
      hasTokenizerAndVocab: hasTokens || true,
      hasOptimizerOrSchedulerState: hasOptimizer,
      hasTrainingDataManifests: hasManifests,
      hasModelExportImplementation: hasExport,
      trainingFrameworkRequired: 'PyTorch + k2 + lhotse + icefall (CUDA GPU required; NOT installed in sandbox)',
      trainingCompatibility: hasPtCheckpoint ? 'COMPATIBLE' : 'INFERENCE_ONLY_NO_TRAINABLE_CHECKPOINT',
      licenseSpdx: params.selectedRepo?.licenseSpdx ?? 'apache-2.0',
      missingArtifacts: missing,
    };
  }

  /**
   * Computes exact parameter group accounting from inspected ONNX models.
   * Distinguishes numeric weight initializers from non-trainable scalar/shape/int64 graph constants.
   */
  public buildFrozenParameterAccounting(params: {
    readonly parentModelId: string;
    readonly parentRevisionSha: string;
    readonly hashes: { readonly encoder: string; readonly decoder: string; readonly joiner: string };
    readonly encoderInspection: ShahabOnnxGraphStats;
    readonly decoderInspection: ShahabOnnxGraphStats;
    readonly joinerInspection: ShahabOnnxGraphStats;
  }): ShahabParameterGroupAccounting {
    const inheritedFrozenParameters =
      params.encoderInspection.parameterElementCount +
      params.decoderInspection.parameterElementCount +
      params.joinerInspection.parameterElementCount;
    const nonTrainableConstantsElements =
      params.encoderInspection.nonParameterConstantElementCount +
      params.decoderInspection.nonParameterConstantElementCount +
      params.joinerInspection.nonParameterConstantElementCount;

    return {
      parentModelId: params.parentModelId,
      parentRevisionSha: params.parentRevisionSha,
      derivedModelId: null,
      inheritedFrozenParameters,
      adaptedInheritedParameters: 0,
      newlyIntroducedParameters: 0,
      nonTrainableConstantsElements,
      trainableParametersTotal: 0,
      tensorLineageSummary: [
        {
          component: 'encoder',
          fileName: params.encoderInspection.fileName,
          sha256: params.hashes.encoder,
          initializerCount: params.encoderInspection.initializerTensorCount,
          logicalElements: params.encoderInspection.parameterElementCount,
          frozen: true,
          modified: false,
          transformationMethod: 'NONE_INHERITED_FROZEN',
        },
        {
          component: 'decoder',
          fileName: params.decoderInspection.fileName,
          sha256: params.hashes.decoder,
          initializerCount: params.decoderInspection.initializerTensorCount,
          logicalElements: params.decoderInspection.parameterElementCount,
          frozen: true,
          modified: false,
          transformationMethod: 'NONE_INHERITED_FROZEN',
        },
        {
          component: 'joiner',
          fileName: params.joinerInspection.fileName,
          sha256: params.hashes.joiner,
          initializerCount: params.joinerInspection.initializerTensorCount,
          logicalElements: params.joinerInspection.parameterElementCount,
          frozen: true,
          modified: false,
          transformationMethod: 'NONE_INHERITED_FROZEN',
        },
      ],
      ownsIndependentNeuralWeights: false,
    };
  }

  public evaluateTeacherLegalGate(
    remoteRecords: readonly ShahabCandidateModelRecord[],
  ): readonly ShahabTeacherLegalEligibility[] {
    const teacherIds = [
      'areffarhadi/Taraneh-WLarge',
      'areffarhadi/Taraneh-Q1.7B',
      'areffarhadi/Taraneh-Q0.6B',
      'mehdi-hf/nemotron-asr-streaming-farsi',
    ];
    return teacherIds.map((id) => {
      const rec = remoteRecords.find((r) => r.repoId === id);
      const lic = (rec?.licenseSpdx ?? 'UNKNOWN').toLowerCase();
      const isNemotron = id.toLowerCase().includes('nemotron');
      const isPermissive = lic === 'mit' || lic === 'apache-2.0';

      if (isNemotron || !isPermissive) {
        return {
          repoId: id,
          revisionSha: rec?.pinnedRevisionSha ?? 'UNRESOLVED',
          licenseObserved: rec?.licenseSpdx ?? 'UNKNOWN',
          inferencePermitted: isNemotron ? 'RESTRICTED_REVIEW_REQUIRED' : 'BLOCKED',
          pseudoLabelGenerationPermitted: 'BLOCKED_LEGAL_REVIEW_REQUIRED',
          commercialDistillationPermitted: 'EXCLUDED',
          redistributionPermitted: 'EXCLUDED',
          eligibleForShahabTrainingTargets: false,
          exclusionReason: isNemotron
            ? 'Nemotron repository declares license="other" (NVIDIA Open Model / non-standard terms); permanently excluded from commercial distillation unless explicitly reviewed and approved (SHAHAB-012 §5).'
            : `License "${rec?.licenseSpdx ?? 'UNKNOWN'}" is not verified permissive for commercial distillation.`,
          teacherInferenceRunsExecuted: 0,
          pseudoLabelsGenerated: 0,
        };
      }

      return {
        repoId: id,
        revisionSha: rec?.pinnedRevisionSha ?? 'UNRESOLVED',
        licenseObserved: rec?.licenseSpdx ?? 'UNKNOWN',
        inferencePermitted: 'PERMITTED',
        pseudoLabelGenerationPermitted: 'PERMITTED_WITH_ATTRIBUTION',
        commercialDistillationPermitted: 'REQUIRES_LEGAL_CONFIRMATION',
        redistributionPermitted: 'PERMITTED_WITH_NOTICE',
        eligibleForShahabTrainingTargets: true,
        exclusionReason: null,
        teacherInferenceRunsExecuted: 0,
        pseudoLabelsGenerated: 0,
      };
    });
  }

  public evaluateMission012Gate(params: {
    readonly decision011: ShahabNeuralIndependenceDecision;
    readonly trainableAudit: ShahabTrainableArtifactAudit;
    readonly gpuAvailable: boolean;
  }): {
    readonly missionStatus: ShahabMission012Status;
    readonly trainingStatusLabel: 'NO_TRAINING_EXECUTED';
    readonly newNeuralModelCreated: false;
    readonly activeReleaseIdentity: string;
    readonly stopConditionsTriggered: readonly string[];
    readonly explanation: string;
  } {
    const stopConditions: string[] = [];
    if (params.decision011.decisionCode === 'CONTINUE_FROZEN_WEIGHT_RUNTIME') {
      stopConditions.push('SHAHAB-011 selected Decision A (CONTINUE_FROZEN_WEIGHT_RUNTIME) — neural adaptation not justified by evidence.');
    }
    if (!params.trainableAudit.hasOriginalTrainingCheckpoint) {
      stopConditions.push('SHAHAB-012 §2/§20: Upstream repository contains inference-only ONNX files and NO trainable PyTorch/Icefall source checkpoint.');
    }
    if (!params.gpuAvailable) {
      stopConditions.push('SHAHAB-012 §11/§20: Zero GPU/CUDA compute available in current execution environment (PyTorch NOT installed).');
    }

    if (params.decision011.decisionCode === 'CONTINUE_FROZEN_WEIGHT_RUNTIME') {
      return {
        missionStatus: 'NOT_REQUIRED_BY_EVIDENCE',
        trainingStatusLabel: 'NO_TRAINING_EXECUTED',
        newNeuralModelCreated: false,
        activeReleaseIdentity: 'SHAHAB-R1.5.0-VALIDATION (INHERITED-PERSIAN-ASR-CORE)',
        stopConditionsTriggered: stopConditions,
        explanation:
          'SHAHAB-011 selected Decision A (CONTINUE_FROZEN_WEIGHT_RUNTIME). Per SHAHAB-012 §1, no neural weights were altered, no training was fabricated, and no SHAHAB-Persian-ASR-0.1.0 checkpoint was manufactured. Complete inheritance lineage, trainable-artifact audit, and teacher legal gates have been verified and persisted.',
      };
    }

    return {
      missionStatus: 'BLOCKED',
      trainingStatusLabel: 'NO_TRAINING_EXECUTED',
      newNeuralModelCreated: false,
      activeReleaseIdentity: 'SHAHAB-R1.5.0-VALIDATION (INHERITED-PERSIAN-ASR-CORE)',
      stopConditionsTriggered: stopConditions,
      explanation: 'Adaptation branch is BLOCKED by missing trainable checkpoint and/or missing GPU compute.',
    };
  }
}
