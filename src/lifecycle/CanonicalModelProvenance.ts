import {
  MAX_SAFE_MODEL_FILE_BYTES,
  ModelArchitecture,
  ModelRepositoryError,
  validateModelPathSegment,
} from './ModelRepositoryContracts';
import { IncrementalSha256 } from '../utils/StreamingSha256';

export const CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION = '2.0.0' as const;
export const PERSIAN_NORMALIZATION_CONTRACT_VERSION = '1.2.0-avp-fa' as const;

export type ModelArtifactRole =
  | 'weights'
  | 'decoder_weights'
  | 'vocabulary'
  | 'tokenizer'
  | 'config';

export type OnnxTensorDtype = 'float32' | 'float16' | 'int32' | 'int64' | 'uint8' | 'string';

export interface ModelTensorSpec {
  readonly name: string;
  readonly dtype: OnnxTensorDtype;
  /** Symbolic or integer shape dimensions, e.g. [1, 80, 'T'] */
  readonly shape: readonly (number | string)[];
  readonly required: boolean;
  readonly description?: string;
}

export interface ModelArtifactFileSpec {
  readonly filename: string;
  readonly role: ModelArtifactRole;
  readonly byteLength: number;
  readonly sha256Hex: string;
  readonly required: boolean;
}

export type ManifestAuthenticityStatus =
  | 'UNSIGNED_CHECKSUM_ONLY'
  | 'SIGNATURE_VERIFIED'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_KEY_UNTRUSTED';

export interface ManifestSignatureBlock {
  readonly algorithm: 'Ed25519' | 'ECDSA-P256-SHA256';
  readonly keyId: string;
  readonly signatureBase64: string;
  readonly signedPayloadSha256Hex: string;
}

export interface ModelAudioContract {
  readonly sampleRateHz: 16000;
  readonly channelCount: 1;
  readonly featureExtraction: 'NEMO_LOG_MEL_80' | 'WHISPER_LOG_MEL_80' | 'WHISPER_LOG_MEL_128';
  readonly frameHopMs: number;
  readonly subsamplingFactor: number;
}

export interface ModelRuntimeCompatibilitySpec {
  readonly supportedRuntimes: readonly ('BROWSER_WASM_CPU' | 'BROWSER_WEBGPU' | 'NATIVE_COMPANION_CPU')[];
  readonly supportedExecutionProviders: readonly ('wasm' | 'webgpu' | 'cpu')[];
  readonly minOnnxOpset: number;
  readonly maxOnnxOpset: number;
  readonly minAvailableRamBytes: number;
  readonly estimatedPeakWorkingMemoryBytes: number;
  readonly requiresSharedArrayBuffer: boolean;
  readonly nativePackagingNote?: string;
  readonly browserPackagingNote?: string;
}

export interface ModelLicensingSpec {
  readonly spdxLicense: string;
  readonly commercialUsePermitted: boolean;
  readonly redistributionPermitted: boolean;
  readonly attributionRequired: boolean;
  readonly attributionNotice: string;
}

export interface ModelProvenanceSpec {
  readonly originRepository: string;
  readonly upstreamRevisionSha: string;
  readonly provenanceRecordRef: string;
  readonly checksumAlgorithm: 'SHA-256';
  readonly authenticityStatus: ManifestAuthenticityStatus;
  readonly signature?: ManifestSignatureBlock;
  /** Explicit availability state — never invent download URLs */
  readonly localDistributionAvailability:
    | 'LOCAL_USER_IMPORT_OR_PACK'
    | 'EXTERNAL_ARTIFACT_REQUIRED';
}

export interface CanonicalModelManifest {
  readonly schemaVersion: typeof CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION;
  readonly modelId: string;
  readonly version: string;
  readonly displayName: string;
  readonly profileId: 'AVP_MODEL_LITE' | 'AVP_MODEL_BALANCED' | 'AVP_MODEL_QUALITY' | 'CUSTOM_LOCAL';
  readonly architecture: ModelArchitecture;
  readonly quantization: 'INT8' | 'FP16' | 'FP32';
  readonly supportedLanguages: readonly string[];
  readonly onnxOpset: number;
  readonly artifacts: readonly ModelArtifactFileSpec[];
  readonly inputTensors: readonly ModelTensorSpec[];
  readonly outputTensors: readonly ModelTensorSpec[];
  readonly audioContract: ModelAudioContract;
  readonly tokenizerId: string;
  readonly vocabularyId: string;
  readonly normalizationVersion: typeof PERSIAN_NORMALIZATION_CONTRACT_VERSION;
  readonly runtimeCompatibility: ModelRuntimeCompatibilitySpec;
  readonly licensing: ModelLicensingSpec;
  readonly provenance: ModelProvenanceSpec;
}

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly authenticityStatus: ManifestAuthenticityStatus;
  readonly checksumIntegrityDeclared: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface RuntimeCapabilitySnapshotForModel {
  readonly runtimeTarget: 'BROWSER_WASM_CPU' | 'BROWSER_WEBGPU' | 'NATIVE_COMPANION_CPU';
  readonly wasmAvailable: boolean;
  readonly simdAvailable: boolean;
  readonly webGpuAvailable: boolean;
  readonly sharedArrayBufferAvailable: boolean;
  readonly availableMemoryBudgetBytes: number;
  readonly maxSupportedOnnxOpset: number;
}

export interface ModelCompatibilityReport {
  readonly compatible: boolean;
  readonly status: 'COMPATIBLE' | 'INCOMPATIBLE_ARCHITECTURE' | 'UNSUPPORTED_RESOURCE' | 'RUNTIME_UNSUPPORTED';
  readonly selectedExecutionProvider: 'webgpu' | 'wasm' | 'cpu' | null;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
}

export interface TensorContractValidationResult {
  readonly valid: boolean;
  readonly missingInputs: readonly string[];
  readonly missingOutputs: readonly string[];
  readonly errors: readonly string[];
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_ARTIFACT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(onnx|txt|json|vocab|model)$/i;
const FORBIDDEN_LICENSES = new Set(['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'UNDECLARED', 'PROPRIETARY_RESTRICTED']);

/**
 * Authoritative catalog of verified Persian ASR model provenance records derived
 * directly from `docs/AVAPARDAZ/MODEL-PROVENANCE.md` and `benchmarks/phase02/results-2026-11-20.json`.
 *
 * CRITICAL HONESTY RULE:
 * - Zero fabricated URLs or fake weights.
 * - Checksums establish artifact integrity ONLY (`UNSIGNED_CHECKSUM_ONLY`), NOT cryptographic
 *   publisher signature authenticity unless verified by a real trusted key.
 */
export const CANONICAL_PERSIAN_ASR_CATALOG: readonly CanonicalModelManifest[] = Object.freeze([
  Object.freeze<CanonicalModelManifest>({
    schemaVersion: CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION,
    modelId: 'shenava-rizen-fa-fastconformer-int8',
    version: '1.0.0',
    displayName: 'Reza2kn/Shenava-Rizeh v1.0 (NeMo FastConformer CTC INT8)',
    profileId: 'AVP_MODEL_LITE',
    architecture: 'FASTCONFORMER_CTC',
    quantization: 'INT8',
    supportedLanguages: ['fa'],
    onnxOpset: 17,
    artifacts: [
      {
        filename: 'model.int8.onnx',
        role: 'weights',
        byteLength: 38_183_269,
        sha256Hex: '6bdd4ab80626ddfe0b19338a5c96fcc4f2021ad78899cece20a805a48dc5250d',
        required: true,
      },
      {
        filename: 'tokens.txt',
        role: 'vocabulary',
        byteLength: 12_236,
        sha256Hex: '8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954',
        required: true,
      },
    ],
    inputTensors: [
      {
        name: 'audio_signal',
        dtype: 'float32',
        shape: [1, 80, 'T'],
        required: true,
        description: '80-bin NeMo Log-Mel spectrogram [batch=1, n_mels=80, frames=T]',
      },
      {
        name: 'length',
        dtype: 'int64',
        shape: [1],
        required: true,
        description: 'Valid frame count tensor [1]',
      },
    ],
    outputTensors: [
      {
        name: 'logprobs',
        dtype: 'float32',
        shape: [1, 'T_out', 'V'],
        required: true,
        description: 'CTC log-probabilities over Persian SentencePiece vocabulary',
      },
    ],
    audioContract: {
      sampleRateHz: 16000,
      channelCount: 1,
      featureExtraction: 'NEMO_LOG_MEL_80',
      frameHopMs: 10,
      subsamplingFactor: 4,
    },
    tokenizerId: 'nemo-sentencepiece-fa-1024',
    vocabularyId: 'shenava-rizen-tokens-v1',
    normalizationVersion: PERSIAN_NORMALIZATION_CONTRACT_VERSION,
    runtimeCompatibility: {
      supportedRuntimes: ['BROWSER_WASM_CPU', 'NATIVE_COMPANION_CPU'],
      supportedExecutionProviders: ['wasm', 'cpu'],
      minOnnxOpset: 13,
      maxOnnxOpset: 21,
      minAvailableRamBytes: 256 * 1024 * 1024,
      estimatedPeakWorkingMemoryBytes: 180 * 1024 * 1024,
      requiresSharedArrayBuffer: false,
      nativePackagingNote: 'Executed natively via sherpa-onnx NeMo CTC CPU runner (verified RSS 165.8 MiB).',
      browserPackagingNote: 'Fits within 384 MiB WASM budget; requires model.int8.onnx + tokens.txt imported into OPFS.',
    },
    licensing: {
      spdxLicense: 'Apache-2.0',
      commercialUsePermitted: true,
      redistributionPermitted: true,
      attributionRequired: true,
      attributionNotice: 'Reza2kn/Shenava-Rizeh (Apache-2.0); NVIDIA NeMo FastConformer architecture.',
    },
    provenance: {
      originRepository: 'Reza2kn/Shenava-Rizeh',
      upstreamRevisionSha: '14ca75f0c5c6',
      provenanceRecordRef: 'docs/AVAPARDAZ/MODEL-PROVENANCE.md#L21-L22',
      checksumAlgorithm: 'SHA-256',
      authenticityStatus: 'UNSIGNED_CHECKSUM_ONLY',
      localDistributionAvailability: 'EXTERNAL_ARTIFACT_REQUIRED',
    },
  }),
  Object.freeze<CanonicalModelManifest>({
    schemaVersion: CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION,
    modelId: 'whisper-large-v3-turbo-int8',
    version: '1.0.0',
    displayName: 'openai/whisper-large-v3-turbo (INT8)',
    profileId: 'AVP_MODEL_QUALITY',
    architecture: 'WHISPER_SEQ2SEQ',
    quantization: 'INT8',
    supportedLanguages: ['fa', 'en', 'auto'],
    onnxOpset: 17,
    artifacts: [
      {
        filename: 'turbo-encoder.int8.onnx',
        role: 'weights',
        byteLength: 674_716_297,
        sha256Hex: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b',
        required: true,
      },
      {
        filename: 'turbo-decoder.int8.onnx',
        role: 'decoder_weights',
        byteLength: 361_080_764,
        sha256Hex: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547',
        required: true,
      },
      {
        filename: 'turbo-tokens.txt',
        role: 'tokenizer',
        byteLength: 816_730,
        sha256Hex: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
        required: true,
      },
    ],
    inputTensors: [
      {
        name: 'mel',
        dtype: 'float32',
        shape: [1, 128, 3000],
        required: true,
        description: '128-bin Whisper Log-Mel spectrogram',
      },
    ],
    outputTensors: [
      {
        name: 'logits',
        dtype: 'float32',
        shape: [1, 'S', 51866],
        required: true,
        description: 'Autoregressive token logits',
      },
    ],
    audioContract: {
      sampleRateHz: 16000,
      channelCount: 1,
      featureExtraction: 'WHISPER_LOG_MEL_128',
      frameHopMs: 10,
      subsamplingFactor: 2,
    },
    tokenizerId: 'whisper-multilingual-bpe-51866',
    vocabularyId: 'whisper-turbo-tokens-v1',
    normalizationVersion: PERSIAN_NORMALIZATION_CONTRACT_VERSION,
    runtimeCompatibility: {
      supportedRuntimes: ['NATIVE_COMPANION_CPU'],
      supportedExecutionProviders: ['cpu'],
      minOnnxOpset: 13,
      maxOnnxOpset: 21,
      minAvailableRamBytes: 1_536 * 1024 * 1024,
      estimatedPeakWorkingMemoryBytes: 1_400 * 1024 * 1024,
      requiresSharedArrayBuffer: false,
      nativePackagingNote: 'Verified on Native Companion CPU (RSS 1,382.9 MiB).',
      browserPackagingNote: 'Exceeds safe 1,024 MiB browser WASM32 ceiling; restricted to Native Companion.',
    },
    licensing: {
      spdxLicense: 'MIT',
      commercialUsePermitted: true,
      redistributionPermitted: true,
      attributionRequired: true,
      attributionNotice: 'OpenAI Whisper large-v3-turbo (MIT License).',
    },
    provenance: {
      originRepository: 'openai/whisper-large-v3-turbo',
      upstreamRevisionSha: '41f01f3fe87f',
      provenanceRecordRef: 'docs/AVAPARDAZ/MODEL-PROVENANCE.md#L23-L25',
      checksumAlgorithm: 'SHA-256',
      authenticityStatus: 'UNSIGNED_CHECKSUM_ONLY',
      localDistributionAvailability: 'EXTERNAL_ARTIFACT_REQUIRED',
    },
  }),
]);

export function findCatalogModelManifest(modelId: string): CanonicalModelManifest | null {
  return CANONICAL_PERSIAN_ASR_CATALOG.find((m) => m.modelId === modelId) ?? null;
}

/**
 * Computes canonical deterministic SHA-256 over manifest fields excluding `signature`
 * so cryptographic signature verification can be plugged in without mutating schema.
 */
export function computeManifestCanonicalDigest(manifest: CanonicalModelManifest): string {
  const withoutSig = {
    ...manifest,
    provenance: {
      ...manifest.provenance,
      signature: undefined,
    },
  };
  const canonicalJson = JSON.stringify(withoutSig);
  return new IncrementalSha256().update(new TextEncoder().encode(canonicalJson)).digestHex();
}

export interface ManifestSignatureVerifier {
  verify(params: {
    readonly payloadSha256Hex: string;
    readonly signature: ManifestSignatureBlock;
  }): Promise<'SIGNATURE_VERIFIED' | 'SIGNATURE_INVALID' | 'SIGNATURE_KEY_UNTRUSTED'>;
}

/**
 * Strictly validates a CanonicalModelManifest against schema, supply-chain security,
 * artifact integrity metadata, path traversal rules, and tensor contract completeness.
 */
export function validateCanonicalModelManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      authenticityStatus: 'UNSIGNED_CHECKSUM_ONLY',
      checksumIntegrityDeclared: false,
      errors: ['Manifest must be a non-null JSON object.'],
      warnings,
    };
  }

  const m = raw as Partial<CanonicalModelManifest>;
  if (m.schemaVersion !== CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION) {
    errors.push(
      `Unsupported manifest schemaVersion "${String(m.schemaVersion)}" (expected "${CANONICAL_MODEL_MANIFEST_SCHEMA_VERSION}").`,
    );
  }

  try {
    validateModelPathSegment(m.modelId, 'modelId');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Invalid modelId');
  }
  try {
    validateModelPathSegment(m.version, 'version');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Invalid version');
  }

  if (m.architecture !== 'FASTCONFORMER_CTC' && m.architecture !== 'WHISPER_SEQ2SEQ') {
    errors.push(`Unsupported architecture "${String(m.architecture)}".`);
  }

  if (typeof m.onnxOpset !== 'number' || !Number.isInteger(m.onnxOpset) || m.onnxOpset < 11 || m.onnxOpset > 25) {
    errors.push(`Invalid or unsupported onnxOpset "${String(m.onnxOpset)}".`);
  }

  // Artifacts validation (path traversal, size bounds, SHA-256, required roles)
  let checksumIntegrityDeclared = true;
  if (!Array.isArray(m.artifacts) || m.artifacts.length === 0) {
    errors.push('Manifest must declare at least one artifact file.');
    checksumIntegrityDeclared = false;
  } else {
    const seenFilenames = new Set<string>();
    let hasPrimaryWeights = false;
    let hasVocabOrTokenizer = false;
    let totalBytes = 0;

    for (let i = 0; i < m.artifacts.length; i++) {
      const a = m.artifacts[i];
      if (!a || typeof a !== 'object') {
        errors.push(`Artifact #${i} must be an object.`);
        checksumIntegrityDeclared = false;
        continue;
      }
      if (
        typeof a.filename !== 'string' ||
        a.filename.includes('..') ||
        a.filename.includes('/') ||
        a.filename.includes('\\') ||
        !SAFE_ARTIFACT_FILENAME_RE.test(a.filename)
      ) {
        errors.push(`Artifact #${i} has unsafe or unsupported filename "${String(a.filename)}".`);
      } else if (seenFilenames.has(a.filename)) {
        errors.push(`Duplicate artifact filename "${a.filename}".`);
      } else {
        seenFilenames.add(a.filename);
      }

      if (
        typeof a.byteLength !== 'number' ||
        !Number.isSafeInteger(a.byteLength) ||
        a.byteLength <= 0 ||
        a.byteLength > MAX_SAFE_MODEL_FILE_BYTES
      ) {
        errors.push(`Artifact "${String(a.filename)}" has invalid byteLength "${String(a.byteLength)}".`);
      } else {
        totalBytes += a.byteLength;
      }

      if (typeof a.sha256Hex !== 'string' || !SHA256_RE.test(a.sha256Hex.toLowerCase())) {
        errors.push(`Artifact "${String(a.filename)}" must specify a valid 64-char hex SHA-256 digest.`);
        checksumIntegrityDeclared = false;
      }

      if (a.role === 'weights') hasPrimaryWeights = true;
      if (a.role === 'vocabulary' || a.role === 'tokenizer') hasVocabOrTokenizer = true;
    }

    if (!hasPrimaryWeights) {
      errors.push('Artifact set is incomplete: missing required primary "weights" (.onnx) artifact.');
    }
    if (!hasVocabOrTokenizer) {
      errors.push('Artifact set is incomplete: missing required "vocabulary" or "tokenizer" artifact.');
    }
    if (m.architecture === 'WHISPER_SEQ2SEQ' && !m.artifacts.some((a) => a.role === 'decoder_weights')) {
      errors.push('WHISPER_SEQ2SEQ artifact set is incomplete: missing "decoder_weights" artifact.');
    }
    if (totalBytes > MAX_SAFE_MODEL_FILE_BYTES) {
      errors.push(`Total declared artifact bytes (${totalBytes}) exceeds 2 GiB safety limit.`);
    }
  }

  // Tensor contract checks
  if (!Array.isArray(m.inputTensors) || m.inputTensors.length === 0) {
    errors.push('Manifest must declare inputTensors contract.');
  }
  if (!Array.isArray(m.outputTensors) || m.outputTensors.length === 0) {
    errors.push('Manifest must declare outputTensors contract.');
  }

  // Audio contract checks
  if (!m.audioContract || m.audioContract.sampleRateHz !== 16000 || m.audioContract.channelCount !== 1) {
    errors.push('Audio contract must enforce canonical 16000 Hz mono (1 channel) input.');
  }

  // Licensing & provenance checks
  if (!m.licensing || typeof m.licensing.spdxLicense !== 'string' || m.licensing.spdxLicense.trim().length === 0) {
    errors.push('Manifest must include explicit licensing metadata (spdxLicense).');
  } else if (
    FORBIDDEN_LICENSES.has(m.licensing.spdxLicense.toUpperCase()) ||
    !m.licensing.commercialUsePermitted
  ) {
    errors.push(
      `Model license "${m.licensing.spdxLicense}" is not cleared for commercial product deployment.`,
    );
  }

  let authenticityStatus: ManifestAuthenticityStatus = 'UNSIGNED_CHECKSUM_ONLY';
  if (!m.provenance || typeof m.provenance.originRepository !== 'string' || !m.provenance.originRepository.trim()) {
    errors.push('Manifest must declare provenance.originRepository.');
  } else {
    if (m.provenance.checksumAlgorithm !== 'SHA-256') {
      errors.push('Manifest provenance.checksumAlgorithm must be "SHA-256".');
    }
    if (m.provenance.authenticityStatus === 'SIGNATURE_VERIFIED' && !m.provenance.signature) {
      errors.push(
        'Manifest claims SIGNATURE_VERIFIED without a signature block; unsigned manifests cannot claim authenticity.',
      );
      authenticityStatus = 'SIGNATURE_INVALID';
    } else if (m.provenance.signature) {
      const expectedDigest = computeManifestCanonicalDigest(m as CanonicalModelManifest);
      if (m.provenance.signature.signedPayloadSha256Hex.toLowerCase() !== expectedDigest) {
        errors.push('Manifest signature payload digest does not match manifest contents (tampering detected).');
        authenticityStatus = 'SIGNATURE_INVALID';
      } else {
        // Without an explicitly verified trusted key callback, never upgrade to SIGNATURE_VERIFIED automatically.
        authenticityStatus = 'SIGNATURE_KEY_UNTRUSTED';
        warnings.push(
          'Signature digest matches manifest, but cryptographic key verification requires a trusted ManifestSignatureVerifier.',
        );
      }
    } else {
      authenticityStatus = 'UNSIGNED_CHECKSUM_ONLY';
      warnings.push(
        'Manifest is unsigned: SHA-256 checksums verify artifact integrity only, not publisher cryptographic authenticity.',
      );
    }
  }

  return {
    valid: errors.length === 0,
    authenticityStatus,
    checksumIntegrityDeclared,
    errors,
    warnings,
  };
}

/**
 * Verifies manifest signature asynchronously when a real trusted verifier is injected.
 * Never fabricates a trusted signing key.
 */
export async function verifyManifestAuthenticity(
  manifest: CanonicalModelManifest,
  verifier?: ManifestSignatureVerifier,
): Promise<ManifestAuthenticityStatus> {
  const base = validateCanonicalModelManifest(manifest);
  if (!base.valid) return 'SIGNATURE_INVALID';
  if (!manifest.provenance.signature) {
    return 'UNSIGNED_CHECKSUM_ONLY';
  }
  const expectedDigest = computeManifestCanonicalDigest(manifest);
  if (manifest.provenance.signature.signedPayloadSha256Hex.toLowerCase() !== expectedDigest) {
    return 'SIGNATURE_INVALID';
  }
  if (!verifier) {
    return 'SIGNATURE_KEY_UNTRUSTED';
  }
  return verifier.verify({
    payloadSha256Hex: expectedDigest,
    signature: manifest.provenance.signature,
  });
}

/**
 * Evaluates shared Browser / Native model compatibility and enforces device memory capacity ceilings.
 */
export function evaluateModelRuntimeCompatibility(
  manifest: CanonicalModelManifest,
  capabilities: RuntimeCapabilitySnapshotForModel,
): ModelCompatibilityReport {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const validation = validateCanonicalModelManifest(manifest);
  if (!validation.valid) {
    return {
      compatible: false,
      status: 'INCOMPATIBLE_ARCHITECTURE',
      selectedExecutionProvider: null,
      reasons: validation.errors,
      warnings: validation.warnings,
    };
  }

  const compat = manifest.runtimeCompatibility;
  if (!compat.supportedRuntimes.includes(capabilities.runtimeTarget)) {
    return {
      compatible: false,
      status: 'RUNTIME_UNSUPPORTED',
      selectedExecutionProvider: null,
      reasons: [
        `Model "${manifest.modelId}" does not support runtime target "${capabilities.runtimeTarget}" (supported: ${compat.supportedRuntimes.join(', ')}).`,
      ],
      warnings,
    };
  }

  if (manifest.onnxOpset > capabilities.maxSupportedOnnxOpset) {
    return {
      compatible: false,
      status: 'INCOMPATIBLE_ARCHITECTURE',
      selectedExecutionProvider: null,
      reasons: [
        `Model ONNX opset ${manifest.onnxOpset} exceeds runtime maximum opset ${capabilities.maxSupportedOnnxOpset}.`,
      ],
      warnings,
    };
  }

  if (capabilities.runtimeTarget !== 'NATIVE_COMPANION_CPU' && !capabilities.wasmAvailable) {
    return {
      compatible: false,
      status: 'RUNTIME_UNSUPPORTED',
      selectedExecutionProvider: null,
      reasons: ['WebAssembly is unavailable in this browser environment.'],
      warnings,
    };
  }

  if (compat.requiresSharedArrayBuffer && !capabilities.sharedArrayBufferAvailable) {
    return {
      compatible: false,
      status: 'RUNTIME_UNSUPPORTED',
      selectedExecutionProvider: null,
      reasons: ['Model requires SharedArrayBuffer/Cross-Origin Isolation which is unavailable.'],
      warnings,
    };
  }

  if (capabilities.availableMemoryBudgetBytes < compat.estimatedPeakWorkingMemoryBytes) {
    return {
      compatible: false,
      status: 'UNSUPPORTED_RESOURCE',
      selectedExecutionProvider: null,
      reasons: [
        `Model peak memory requirement (${Math.round(compat.estimatedPeakWorkingMemoryBytes / (1024 * 1024))} MiB) exceeds safe available device budget (${Math.round(capabilities.availableMemoryBudgetBytes / (1024 * 1024))} MiB).`,
      ],
      warnings,
    };
  }

  if (capabilities.runtimeTarget === 'BROWSER_WASM_CPU' && !capabilities.simdAvailable) {
    warnings.push('WASM SIMD unavailable; inference will execute on slower scalar WASM baseline.');
  }

  let selectedExecutionProvider: 'webgpu' | 'wasm' | 'cpu' = 'wasm';
  if (capabilities.runtimeTarget === 'NATIVE_COMPANION_CPU') {
    selectedExecutionProvider = 'cpu';
  } else if (
    capabilities.runtimeTarget === 'BROWSER_WEBGPU' &&
    capabilities.webGpuAvailable &&
    compat.supportedExecutionProviders.includes('webgpu')
  ) {
    selectedExecutionProvider = 'webgpu';
  } else {
    selectedExecutionProvider = 'wasm';
  }

  return {
    compatible: reasons.length === 0,
    status: 'COMPATIBLE',
    selectedExecutionProvider,
    reasons,
    warnings,
  };
}

/**
 * Validates actual ONNX InferenceSession input/output tensor names against the
 * canonical manifest tensor contract before allowing inference execution.
 */
export function validateOnnxSessionTensorContract(
  manifest: CanonicalModelManifest,
  actualInputNames: readonly string[],
  actualOutputNames: readonly string[],
): TensorContractValidationResult {
  const inputSet = new Set(actualInputNames);
  const outputSet = new Set(actualOutputNames);
  const missingInputs: string[] = [];
  const missingOutputs: string[] = [];
  const errors: string[] = [];

  for (const inp of manifest.inputTensors) {
    if (inp.required && !inputSet.has(inp.name)) {
      missingInputs.push(inp.name);
      errors.push(`ONNX session missing required input tensor "${inp.name}".`);
    }
  }
  for (const out of manifest.outputTensors) {
    if (out.required && !outputSet.has(out.name)) {
      missingOutputs.push(out.name);
      errors.push(`ONNX session missing required output tensor "${out.name}".`);
    }
  }

  return {
    valid: errors.length === 0,
    missingInputs,
    missingOutputs,
    errors,
  };
}

/**
 * Parses a standard Sherpa-ONNX / NeMo `tokens.txt` vocabulary file (`<token> <id>` or one token per line)
 * into an ordered CTC vocabulary array indexed by token ID.
 */
export function parseCtcTokensTxt(rawText: string): string[] {
  const lines = rawText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    throw new ModelRepositoryError(
      'MODEL_MANIFEST_INVALID',
      'CTC vocabulary tokens.txt is empty.',
    );
  }

  const indexed = new Map<number, string>();
  let maxId = -1;
  let allHaveExplicitIds = true;

  for (const line of lines) {
    const match = line.match(/^(.*?)\s+(\d+)$/);
    if (match) {
      const token = match[1];
      const id = Number(match[2]);
      if (Number.isSafeInteger(id) && id >= 0 && id < 200_000) {
        indexed.set(id, token);
        if (id > maxId) maxId = id;
        continue;
      }
    }
    allHaveExplicitIds = false;
    break;
  }

  if (allHaveExplicitIds && maxId >= 0) {
    const vocab = new Array<string>(maxId + 1).fill('<unk>');
    for (const [id, tok] of indexed.entries()) {
      vocab[id] = tok;
    }
    return vocab;
  }

  return lines.map((l) => l.trim());
}
