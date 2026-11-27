import type { LocalNeuralTranscriptionResult } from '../../asr-core/LocalSherpaNeuralEngine';
import type { CompanionJobRecord } from './LocalCompanionService';
import {
  mapLocalNeuralResultToCepTranscriptDto,
  type CepTranscriptResultV1,
} from './CepTranscriptDto';

export type CompanionJobResponse = Omit<CompanionJobRecord, 'result'> & {
  readonly result: LocalNeuralTranscriptionResult | CepTranscriptResultV1 | null;
};

/**
 * Applies the host-specific result DTO only at the Adobe Audition CEP boundary.
 * Web and native Companion consumers keep the original inference result shape.
 */
export function mapCompanionJobResultForExecutionMode(
  job: CompanionJobRecord,
  executionMode: 'audition-cep',
): Omit<CompanionJobRecord, 'result'> & { readonly result: CepTranscriptResultV1 | null };
export function mapCompanionJobResultForExecutionMode(
  job: CompanionJobRecord,
  executionMode: 'native-companion' | 'web-client' | undefined,
): CompanionJobRecord;
export function mapCompanionJobResultForExecutionMode(
  job: CompanionJobRecord,
  executionMode: 'native-companion' | 'audition-cep' | 'web-client' | undefined,
): CompanionJobResponse {
  if (executionMode !== 'audition-cep' || job.result === null) {
    return job;
  }
  return {
    ...job,
    result: mapLocalNeuralResultToCepTranscriptDto(job.result),
  };
}
