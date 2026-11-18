import {
  AsrLabEngineId,
  AudioIngestionValidationReport,
  computeDeterministicAudioSha256,
  EngineExecutionStatus,
  sanitizeSecretsFromText,
  validateAndPreprocessAudioForLab,
} from './AsrExperimentationLabCore';

export type NormalizationVersionId =
  | 'raw_unmodified'
  | 'fa_strict_v1'
  | 'fa_relaxed_v1'
  | 'en_norm_v1'
  | 'mixed_norm_v1';

export type CapabilitySupportStatus = 'verified' | 'unsupported' | 'unknown';

export interface Phase3EngineCapabilityRecord {
  readonly engine_id: string;
  readonly display_name: string;
  readonly provider: string;
  readonly model_identifier: string;
  readonly model_version: string;
  readonly supports_batch: boolean;
  readonly supports_streaming: boolean;
  readonly supports_persian: CapabilitySupportStatus;
  readonly supports_english: CapabilitySupportStatus;
  readonly supports_code_switching: CapabilitySupportStatus;
  readonly supports_timestamps: CapabilitySupportStatus;
  readonly supports_diarization: CapabilitySupportStatus;
  readonly supports_keyterms: CapabilitySupportStatus;
  readonly local_execution: boolean;
  readonly api_execution: boolean;
  readonly license_status: string;
  readonly capability_source_url: string | null;
  readonly capability_verified_at: string | null;
  readonly enabled: boolean;
  readonly required_env_var: string | null;
}

export const PHASE3_ENGINE_CAPABILITY_REGISTRY: readonly Phase3EngineCapabilityRecord[] = [
  {
    engine_id: 'avapardaz_ctc_viterbi_local',
    display_name: 'Avapardaz Local CTC Viterbi + Context Trie',
    provider: 'avapardaz_local',
    model_identifier: 'avapardaz-ctc-viterbi-trilingual',
    model_version: '1.2.0-local',
    supports_batch: true,
    supports_streaming: true,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'verified',
    supports_timestamps: 'verified',
    supports_diarization: 'verified',
    supports_keyterms: 'verified',
    local_execution: true,
    api_execution: false,
    license_status: 'Proprietary First-Party Local Engine',
    capability_source_url: 'local://src/ai-engine/PersianCtcForcedAligner.ts',
    capability_verified_at: '2026-11-18T08:00:00Z',
    enabled: true,
    required_env_var: null,
  },
  {
    engine_id: 'avapardaz_acoustic_raw_local',
    display_name: 'Avapardaz Baseline Acoustic Decoder (No Keyterm/Trie)',
    provider: 'avapardaz_local',
    model_identifier: 'avapardaz-acoustic-baseline-unbiased',
    model_version: '1.0.0-baseline',
    supports_batch: true,
    supports_streaming: true,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'verified',
    supports_timestamps: 'verified',
    supports_diarization: 'unsupported',
    supports_keyterms: 'unsupported',
    local_execution: true,
    api_execution: false,
    license_status: 'Proprietary First-Party Baseline',
    capability_source_url: 'local://src/engine/persianAsrTranscriber.ts',
    capability_verified_at: '2026-11-18T08:00:00Z',
    enabled: true,
    required_env_var: null,
  },
  {
    engine_id: 'elevenlabs_scribe_v3',
    display_name: 'ElevenLabs Scribe v3',
    provider: 'elevenlabs',
    model_identifier: 'scribe_v3',
    model_version: '2026-11-10',
    supports_batch: true,
    supports_streaming: false,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'verified',
    supports_timestamps: 'verified',
    supports_diarization: 'verified',
    supports_keyterms: 'verified',
    local_execution: false,
    api_execution: true,
    license_status: 'Commercial Cloud API Terms',
    capability_source_url: 'https://elevenlabs.io/docs/overview/capabilities/speech-to-text',
    capability_verified_at: '2026-11-18T07:50:00Z',
    enabled: true,
    required_env_var: 'ELEVENLABS_API_KEY',
  },
  {
    engine_id: 'elevenlabs_scribe_v3_live',
    display_name: 'ElevenLabs Scribe v3 Live',
    provider: 'elevenlabs',
    model_identifier: 'scribe_v3_live',
    model_version: '2026-11-10',
    supports_batch: false,
    supports_streaming: true,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'verified',
    supports_timestamps: 'verified',
    supports_diarization: 'unknown',
    supports_keyterms: 'verified',
    local_execution: false,
    api_execution: true,
    license_status: 'Commercial Cloud API Terms',
    capability_source_url: 'https://elevenlabs.io/docs/overview/capabilities/speech-to-text',
    capability_verified_at: '2026-11-18T07:50:00Z',
    enabled: true,
    required_env_var: 'ELEVENLABS_API_KEY',
  },
  {
    engine_id: 'deepgram_nova3',
    display_name: 'Deepgram Nova-3',
    provider: 'deepgram',
    model_identifier: 'nova-3',
    model_version: '2026-10-multilingual',
    supports_batch: true,
    supports_streaming: true,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'unknown',
    supports_timestamps: 'verified',
    supports_diarization: 'verified',
    supports_keyterms: 'verified',
    local_execution: false,
    api_execution: true,
    license_status: 'Commercial Cloud API Terms',
    capability_source_url: 'https://developers.deepgram.com',
    capability_verified_at: '2026-11-18T07:50:00Z',
    enabled: true,
    required_env_var: 'DEEPGRAM_API_KEY',
  },
  {
    engine_id: 'openai_gpt_transcribe',
    display_name: 'OpenAI GPT-Transcribe',
    provider: 'openai',
    model_identifier: 'gpt-transcribe',
    model_version: '2026-v1',
    supports_batch: true,
    supports_streaming: false,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'unknown',
    supports_timestamps: 'unknown',
    supports_diarization: 'unsupported',
    supports_keyterms: 'verified',
    local_execution: false,
    api_execution: true,
    license_status: 'Commercial Cloud API Terms',
    capability_source_url: 'https://developers.openai.com/api/docs/guides/transcription',
    capability_verified_at: '2026-11-18T07:50:00Z',
    enabled: true,
    required_env_var: 'OPENAI_API_KEY',
  },
  {
    engine_id: 'openai_gpt_live_transcribe',
    display_name: 'OpenAI GPT-Live-Transcribe',
    provider: 'openai',
    model_identifier: 'gpt-live-transcribe',
    model_version: '2026-v1',
    supports_batch: false,
    supports_streaming: true,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'unknown',
    supports_timestamps: 'unknown',
    supports_diarization: 'unsupported',
    supports_keyterms: 'verified',
    local_execution: false,
    api_execution: true,
    license_status: 'Commercial Cloud API Terms',
    capability_source_url: 'https://developers.openai.com/api/docs/guides/transcription',
    capability_verified_at: '2026-11-18T07:50:00Z',
    enabled: true,
    required_env_var: 'OPENAI_API_KEY',
  },
  {
    engine_id: 'qwen3_asr_1_7b',
    display_name: 'Qwen3-ASR 1.7B',
    provider: 'qwen_open_source',
    model_identifier: 'Qwen/Qwen3-ASR-1.7B',
    model_version: '1.7B-2026',
    supports_batch: true,
    supports_streaming: true,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'verified',
    supports_timestamps: 'unknown',
    supports_diarization: 'unsupported',
    supports_keyterms: 'verified',
    local_execution: true,
    api_execution: true,
    license_status: 'Open-Source (Requires License Audit for Commercial Distribution)',
    capability_source_url: 'https://github.com/QwenLM',
    capability_verified_at: '2026-11-18T07:50:00Z',
    enabled: true,
    required_env_var: 'QWEN3_ASR_WORKER_URL',
  },
  {
    engine_id: 'whisper_large_v3',
    display_name: 'Whisper Large-v3',
    provider: 'openai_open_source',
    model_identifier: 'openai/whisper-large-v3',
    model_version: 'large-v3-51866',
    supports_batch: true,
    supports_streaming: false,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'unknown',
    supports_timestamps: 'verified',
    supports_diarization: 'unsupported',
    supports_keyterms: 'verified',
    local_execution: true,
    api_execution: true,
    license_status: 'MIT License',
    capability_source_url: 'https://github.com/openai/whisper',
    capability_verified_at: '2026-11-18T07:50:00Z',
    enabled: true,
    required_env_var: 'WHISPER_WORKER_URL',
  },
  {
    engine_id: 'whisper_turbo',
    display_name: 'Whisper Large-v3 Turbo',
    provider: 'openai_open_source',
    model_identifier: 'openai/whisper-large-v3-turbo',
    model_version: 'turbo-809m-51866',
    supports_batch: true,
    supports_streaming: false,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'unknown',
    supports_timestamps: 'verified',
    supports_diarization: 'unsupported',
    supports_keyterms: 'verified',
    local_execution: true,
    api_execution: true,
    license_status: 'MIT License',
    capability_source_url: 'https://github.com/openai/whisper',
    capability_verified_at: '2026-11-18T07:50:00Z',
    enabled: true,
    required_env_var: 'WHISPER_WORKER_URL',
  },
  {
    engine_id: 'assemblyai_universal',
    display_name: 'AssemblyAI Universal-3.5 Pro',
    provider: 'assemblyai',
    model_identifier: 'universal-3.5-pro',
    model_version: '3.5-pro',
    supports_batch: true,
    supports_streaming: true,
    supports_persian: 'unknown',
    supports_english: 'verified',
    supports_code_switching: 'unknown',
    supports_timestamps: 'verified',
    supports_diarization: 'verified',
    supports_keyterms: 'verified',
    local_execution: false,
    api_execution: true,
    license_status: 'Commercial Cloud API Terms',
    capability_source_url: 'https://www.assemblyai.com',
    capability_verified_at: null,
    enabled: true,
    required_env_var: 'ASSEMBLYAI_API_KEY',
  },
  {
    engine_id: 'microsoft_mai_transcribe_2',
    display_name: 'Microsoft MAI-Transcribe-2',
    provider: 'microsoft_azure',
    model_identifier: 'mai-transcribe-2',
    model_version: '2.0',
    supports_batch: true,
    supports_streaming: true,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'unknown',
    supports_timestamps: 'verified',
    supports_diarization: 'verified',
    supports_keyterms: 'verified',
    local_execution: false,
    api_execution: true,
    license_status: 'Commercial Cloud API Terms',
    capability_source_url: null,
    capability_verified_at: null,
    enabled: true,
    required_env_var: 'AZURE_SPEECH_KEY',
  },
  {
    engine_id: 'nvidia_nemo_fastconformer',
    display_name: 'NVIDIA NeMo FastConformer-CTC',
    provider: 'nvidia_open_source',
    model_identifier: 'nvidia/stt_fa_fastconformer_hybrid_large',
    model_version: '1.22.0',
    supports_batch: true,
    supports_streaming: true,
    supports_persian: 'verified',
    supports_english: 'verified',
    supports_code_switching: 'unknown',
    supports_timestamps: 'verified',
    supports_diarization: 'verified',
    supports_keyterms: 'verified',
    local_execution: true,
    api_execution: false,
    license_status: 'Apache-2.0',
    capability_source_url: null,
    capability_verified_at: null,
    enabled: true,
    required_env_var: 'NEMO_WORKER_URL',
  },
];

// ============================================================================
// SECTION 7: VERSIONED PERSIAN, ENGLISH & MIXED NORMALIZATION ENGINE
// ============================================================================

const COMMON_ARABIC_TO_PERSIAN_CHARS: Readonly<Record<string, string>> = {
  '\u0643': '\u06a9', // ك -> ک
  '\u06ac': '\u06a9',
  '\u06ad': '\u06a9',
  '\u06ae': '\u06a9',
  '\u064a': '\u06cc', // ي -> ی
  '\u0649': '\u06cc', // ى -> ی
  '\u0626': '\u06cc', // ئ -> ی
  '\u0623': '\u0627', // أ -> ا
  '\u0625': '\u0627', // إ -> ا
  '\u0629': '\u0647', // ة -> ه
  '\u06c0': '\u0647', // ۀ -> ه
};

const PERSIAN_DETACHED_PREFIXES = new Set(['می', 'نمی']);
const PERSIAN_DETACHED_SUFFIXES = new Set([
  'ها',
  'های',
  'هایی',
  'تر',
  'ترین',
  'ام',
  'ات',
  'اش',
  'مان',
  'تان',
  'شان',
]);

function normalizeDigitsToCanonicalAscii(input: string): string {
  return input
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

function stripBidiAndTatweel(input: string): string {
  // Remove Tatweel U+0640, bidi controls U+200E..U+200F, U+202A..U+202E, U+2066..U+2069, and harakat U+064B..U+065F
  return input.replace(/[\u0640\u200e\u200f\u202a-\u202e\u2066-\u2069\u064b-\u065f\u0670\u0654]/g, '');
}

/**
 * FA-STRICT-V1 (Section 7.2):
 * 1. Unicode NFC normalization
 * 2. Map Arabic ي -> ی and ك -> ک
 * 3. Remove Tatweel U+0640 & bidi control characters
 * 4. Normalize Persian & Arabic digits to canonical ASCII digits
 * 5. Preserve Zero Width Non-Joiner U+200C (\u200c)
 * 6. Explicit punctuation removal & whitespace collapsing
 */
export function normalizeFaStrictV1(rawText: string): string {
  if (!rawText) return '';
  let s = rawText.normalize('NFC');
  for (const [src, dst] of Object.entries(COMMON_ARABIC_TO_PERSIAN_CHARS)) {
    s = s.split(src).join(dst);
  }
  s = stripBidiAndTatweel(s);
  s = normalizeDigitsToCanonicalAscii(s);
  // Strip punctuation while strictly preserving \u200c (ZWNJ)
  s = s.replace(/[،؛.؟!?:«»"'()[\]{}\-_/\\|,@#$%^&*+=~`<>]+/g, ' ');
  // Collapse multiple spaces (do NOT strip \u200c)
  return s
    .split(/[ \t\r\n]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * FA-RELAXED-V1 (Section 7.2):
 * Applies the same character normalization as FA-STRICT-V1, converts ZWNJ (\u200c)
 * to a standard token boundary, and canonically merges detached Persian verbal prefixes/suffixes
 * so ZWNJ differences can be isolated from true lexical errors.
 */
export function normalizeFaRelaxedV1(rawText: string): string {
  const strict = normalizeFaStrictV1(rawText);
  if (!strict) return '';
  const tokens = strict
    .replace(/\u200c+/g, ' ')
    .replace(/\u0622/g, '\u0627') // آ -> ا in relaxed comparison
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    const nxt = i + 1 < tokens.length ? tokens[i + 1] : null;
    if (PERSIAN_DETACHED_PREFIXES.has(cur) && nxt !== null) {
      merged.push(cur + nxt);
      i++;
      continue;
    }
    if (nxt !== null && PERSIAN_DETACHED_SUFFIXES.has(nxt)) {
      merged.push(cur + nxt);
      i++;
      continue;
    }
    merged.push(cur);
  }
  return merged.join(' ');
}

/**
 * EN-NORM-V1 (Section 7.3):
 * - Unicode NFC
 * - Case folding (toLowerCase)
 * - Explicit apostrophe policy (normalize curly ’/‘ to straight ' and preserve contractions like don't, or strip outer quotes)
 * - Consistent punctuation removal & whitespace collapsing
 */
export function normalizeEnNormV1(rawText: string): string {
  if (!rawText) return '';
  let s = rawText.normalize('NFC').toLowerCase();
  s = normalizeDigitsToCanonicalAscii(s);
  // Normalize curly apostrophes inside contractions (e.g. don’t -> don't)
  s = s.replace(/([a-z])[\u2018\u2019\u02bc]([a-z])/g, "$1'$2");
  // Remove all non-contraction punctuation
  s = s.replace(/[،؛.؟!?:«»"()[\]{}\-_/\\|,@#$%^&*+=~`<>]+/g, ' ');
  s = s.replace(/(^|\s)'+|'+(\s|$)/g, ' ');
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * MIXED-NORM-V1 (Section 7.4):
 * Applies Persian character normalization to Persian spans and English normalization to English spans.
 * Never transliterates English words into Persian or Persian words into Latin characters.
 */
export function normalizeMixedNormV1(rawText: string): string {
  if (!rawText) return '';
  let s = rawText.normalize('NFC');
  for (const [src, dst] of Object.entries(COMMON_ARABIC_TO_PERSIAN_CHARS)) {
    s = s.split(src).join(dst);
  }
  s = stripBidiAndTatweel(s);
  s = normalizeDigitsToCanonicalAscii(s);
  // Normalize English contractions
  s = s.replace(/([A-Za-z])[\u2018\u2019\u02bc]([A-Za-z])/g, "$1'$2");
  // Lowercase only Latin ASCII characters (preserving Persian ZWNJ and characters)
  s = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  // Remove punctuation while preserving internal apostrophes and ZWNJ
  s = s.replace(/[،؛.؟!?:«»"()[\]{}\-_/\\|,@#$%^&*+=~`<>]+/g, ' ');
  s = s.replace(/(^|\s)'+|'+(\s|$)/g, ' ');
  return s
    .split(/[ \t\r\n]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ');
}

export function applyVersionedNormalization(
  rawText: string,
  version: NormalizationVersionId,
): string {
  switch (version) {
    case 'raw_unmodified':
      return rawText.trim();
    case 'fa_strict_v1':
      return normalizeFaStrictV1(rawText);
    case 'fa_relaxed_v1':
      return normalizeFaRelaxedV1(rawText);
    case 'en_norm_v1':
      return normalizeEnNormV1(rawText);
    case 'mixed_norm_v1':
      return normalizeMixedNormV1(rawText);
  }
}

// ============================================================================
// SECTION 7.1 & 7.5: MATHEMATICALLY REPRODUCIBLE CER / WER / MER EVALUATOR
// ============================================================================

export interface Section7EvaluatedTranscriptSchema {
  readonly reference_raw: string;
  readonly hypothesis_raw: string;
  readonly reference_normalized: string;
  readonly hypothesis_normalized: string;
  readonly normalization_version: NormalizationVersionId;
  readonly cer: number;
  readonly wer: number;
  readonly mer: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  readonly word_hits: number;
  readonly char_substitutions: number;
  readonly char_deletions: number;
  readonly char_insertions: number;
  readonly char_hits: number;
  readonly reference_token_count: number;
  readonly reference_character_count: number;
  readonly hypothesis_token_count: number;
  readonly hypothesis_character_count: number;
  readonly is_empty_transcript: boolean;
  readonly requires_hallucination_review: boolean;
}

export interface AlignedEditOperation<T> {
  readonly op: 'HIT' | 'SUBSTITUTION' | 'DELETION' | 'INSERTION';
  readonly refItem: T | null;
  readonly hypItem: T | null;
  readonly refIndex: number;
  readonly hypIndex: number;
}

export function alignSequencesLevenshtein<T>(
  refSeq: readonly T[],
  hypSeq: readonly T[],
): {
  hits: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  operations: AlignedEditOperation<T>[];
} {
  const n = refSeq.length;
  const m = hypSeq.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const opMatrix: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 0=HIT, 1=SUB, 2=DEL, 3=INS

  for (let i = 1; i <= n; i++) {
    dp[i][0] = i;
    opMatrix[i][0] = 2;
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = j;
    opMatrix[0][j] = 3;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (refSeq[i - 1] === hypSeq[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
        opMatrix[i][j] = 0;
      } else {
        const subC = dp[i - 1][j - 1] + 1;
        const delC = dp[i - 1][j] + 1;
        const insC = dp[i][j - 1] + 1;
        const best = Math.min(subC, delC, insC);
        dp[i][j] = best;
        if (best === subC) opMatrix[i][j] = 1;
        else if (best === delC) opMatrix[i][j] = 2;
        else opMatrix[i][j] = 3;
      }
    }
  }

  let hits = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  const operations: AlignedEditOperation<T>[] = [];

  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const curOp = opMatrix[i][j];
    if (i > 0 && j > 0 && (curOp === 0 || curOp === 1)) {
      if (curOp === 0) {
        hits++;
        operations.push({
          op: 'HIT',
          refItem: refSeq[i - 1],
          hypItem: hypSeq[j - 1],
          refIndex: i - 1,
          hypIndex: j - 1,
        });
      } else {
        substitutions++;
        operations.push({
          op: 'SUBSTITUTION',
          refItem: refSeq[i - 1],
          hypItem: hypSeq[j - 1],
          refIndex: i - 1,
          hypIndex: j - 1,
        });
      }
      i--;
      j--;
    } else if (i > 0 && (j === 0 || curOp === 2)) {
      deletions++;
      operations.push({
        op: 'DELETION',
        refItem: refSeq[i - 1],
        hypItem: null,
        refIndex: i - 1,
        hypIndex: j,
      });
      i--;
    } else {
      insertions++;
      operations.push({
        op: 'INSERTION',
        refItem: null,
        hypItem: hypSeq[j - 1],
        refIndex: i,
        hypIndex: j - 1,
      });
      j--;
    }
  }

  operations.reverse();
  return { hits, substitutions, deletions, insertions, operations };
}

export function evaluateWithNormalizationVersion(
  referenceRaw: string,
  hypothesisRaw: string,
  normalizationVersion: NormalizationVersionId,
): Section7EvaluatedTranscriptSchema {
  const refNorm = applyVersionedNormalization(referenceRaw, normalizationVersion);
  const hypNorm = applyVersionedNormalization(hypothesisRaw, normalizationVersion);

  const refWords = refNorm.split(/\s+/).filter(Boolean);
  const hypWords = hypNorm.split(/\s+/).filter(Boolean);

  // For character-level CER, strip spaces while keeping ZWNJ (\u200c) in fa_strict_v1
  const refChars = Array.from(refNorm.replace(/ /g, ''));
  const hypChars = Array.from(hypNorm.replace(/ /g, ''));

  const wordAlign = alignSequencesLevenshtein(refWords, hypWords);
  const charAlign = alignSequencesLevenshtein(refChars, hypChars);

  const wordErrors = wordAlign.substitutions + wordAlign.deletions + wordAlign.insertions;
  const charErrors = charAlign.substitutions + charAlign.deletions + charAlign.insertions;

  const wer =
    refWords.length > 0
      ? Number((wordErrors / refWords.length).toFixed(6))
      : hypWords.length > 0
        ? 1.0
        : 0.0;
  const cer =
    refChars.length > 0
      ? Number((charErrors / refChars.length).toFixed(6))
      : hypChars.length > 0
        ? 1.0
        : 0.0;
  const mer =
    wordAlign.hits + wordErrors > 0
      ? Number((wordErrors / (wordAlign.hits + wordErrors)).toFixed(6))
      : 0.0;

  // Hallucination check: insertions > 40% of reference length or repeated n-gram loops
  const hasRepetitionLoop = /\b(\S+)(?:\s+\1){2,}\b/.test(hypNorm);
  const requiresHallucinationReview =
    hasRepetitionLoop ||
    (refWords.length > 0 && wordAlign.insertions >= Math.max(3, Math.ceil(refWords.length * 0.45)));

  return {
    reference_raw: referenceRaw,
    hypothesis_raw: hypothesisRaw,
    reference_normalized: refNorm,
    hypothesis_normalized: hypNorm,
    normalization_version: normalizationVersion,
    cer,
    wer,
    mer,
    substitutions: wordAlign.substitutions,
    deletions: wordAlign.deletions,
    insertions: wordAlign.insertions,
    word_hits: wordAlign.hits,
    char_substitutions: charAlign.substitutions,
    char_deletions: charAlign.deletions,
    char_insertions: charAlign.insertions,
    char_hits: charAlign.hits,
    reference_token_count: refWords.length,
    reference_character_count: refChars.length,
    hypothesis_token_count: hypWords.length,
    hypothesis_character_count: hypChars.length,
    is_empty_transcript: hypWords.length === 0,
    requires_hallucination_review: requiresHallucinationReview,
  };
}

// ============================================================================
// SECTION 11: HIERARCHICAL ERROR INTELLIGENCE TAXONOMY (TAXONOMY-V1.0)
// ============================================================================

export type ErrorTaxonomyCode =
  | 'TRANSCRIPTION.SUBSTITUTION'
  | 'TRANSCRIPTION.DELETION'
  | 'TRANSCRIPTION.INSERTION'
  | 'TRANSCRIPTION.REPETITION'
  | 'TRANSCRIPTION.OMISSION'
  | 'TRANSCRIPTION.HALLUCINATION_REVIEW'
  | 'LANGUAGE.WRONG_LANGUAGE'
  | 'LANGUAGE.CODE_SWITCH_FAILURE'
  | 'LANGUAGE.LANGUAGE_BOUNDARY_ERROR'
  | 'LANGUAGE.SCRIPT_ERROR'
  | 'PERSIAN.YEH_NORMALIZATION'
  | 'PERSIAN.KAF_NORMALIZATION'
  | 'PERSIAN.ZWNJ_ERROR'
  | 'PERSIAN.MORPHOLOGY_ERROR'
  | 'PERSIAN.COLLOQUIAL_WORD_ERROR'
  | 'ENGLISH.HOMOPHONE_ERROR'
  | 'ENGLISH.PROPER_NOUN_ERROR'
  | 'ENGLISH.ACRONYM_ERROR'
  | 'ENGLISH.TECHNICAL_TERM_ERROR'
  | 'AUDIO.NOISE_SENSITIVITY'
  | 'AUDIO.CLIPPING_SENSITIVITY'
  | 'AUDIO.LOW_VOLUME_FAILURE'
  | 'AUDIO.FAST_SPEECH_FAILURE'
  | 'AUDIO.OVERLAPPING_SPEECH_FAILURE'
  | 'DIARIZATION.SPEAKER_MERGE'
  | 'DIARIZATION.SPEAKER_SPLIT'
  | 'DIARIZATION.WRONG_SPEAKER'
  | 'DIARIZATION.WRONG_SPEAKER_TURN'
  | 'TIMESTAMP.START_OFFSET'
  | 'TIMESTAMP.END_OFFSET'
  | 'TIMESTAMP.SEGMENT_ALIGNMENT_ERROR'
  | 'SYSTEM.TIMEOUT'
  | 'SYSTEM.RATE_LIMIT'
  | 'SYSTEM.AUTHENTICATION'
  | 'SYSTEM.NETWORK_ERROR'
  | 'SYSTEM.PROVIDER_INTERNAL_ERROR';

export interface ErrorAnnotationRecord {
  readonly error_id: string;
  readonly experiment_id: string;
  readonly run_id: string;
  readonly sample_id: string;
  readonly engine_id: string;
  readonly error_category: ErrorTaxonomyCode;
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly reference_text_span: string;
  readonly hypothesis_text_span: string;
  readonly token_position: number;
  readonly audio_timestamp_range_ms: readonly [number, number] | null;
  readonly detection_method: 'AUTOMATED_PROVISIONAL' | 'HUMAN_VERIFIED';
  readonly human_verification_status: 'PROVISIONAL_UNREVIEWED' | 'CONFIRMED' | 'DISMISSED';
  readonly annotator_id: string | null;
  readonly taxonomy_version: 'TAXONOMY-V1.0';
}

const KNOWN_TECHNICAL_ENGLISH_TERMS = new Set([
  'typescript',
  'backend',
  'frontend',
  'fastapi',
  'webgpu',
  'webassembly',
  'api',
  'llm',
  'whisper',
  'microservice',
  'kubernetes',
  'docker',
  'postgresql',
]);

const KNOWN_COLLOQUIAL_PERSIAN_FORMS = new Set([
  'می‌خوام',
  'میخوام',
  'خونه‌شون',
  'نتیجه‌هاش',
  'واسه',
  'می‌کنن',
  'عالیه',
  'بکنم',
]);

export function classifyTranscriptErrorsIntoTaxonomy(params: {
  experimentId: string;
  runId: string;
  sampleId: string;
  engineId: string;
  referenceRaw: string;
  hypothesisRaw: string;
  keyterms?: readonly string[];
  systemErrorStatus?: EngineExecutionStatus;
}): ErrorAnnotationRecord[] {
  const {
    experimentId,
    runId,
    sampleId,
    engineId,
    referenceRaw,
    hypothesisRaw,
    keyterms = [],
    systemErrorStatus,
  } = params;

  const annotations: ErrorAnnotationRecord[] = [];
  let seq = 1;

  const pushErr = (
    category: ErrorTaxonomyCode,
    severity: ErrorAnnotationRecord['severity'],
    refSpan: string,
    hypSpan: string,
    pos: number,
  ) => {
    annotations.push({
      error_id: `ERR-${runId}-${String(seq++).padStart(3, '0')}`,
      experiment_id: experimentId,
      run_id: runId,
      sample_id: sampleId,
      engine_id: engineId,
      error_category: category,
      severity,
      reference_text_span: refSpan,
      hypothesis_text_span: hypSpan,
      token_position: pos,
      audio_timestamp_range_ms: null,
      detection_method: 'AUTOMATED_PROVISIONAL',
      human_verification_status: 'PROVISIONAL_UNREVIEWED',
      annotator_id: null,
      taxonomy_version: 'TAXONOMY-V1.0',
    });
  };

  if (systemErrorStatus && systemErrorStatus !== 'SUCCESS') {
    const sysCat: ErrorTaxonomyCode =
      systemErrorStatus === 'TIMEOUT'
        ? 'SYSTEM.TIMEOUT'
        : systemErrorStatus === 'MISSING_API_KEY'
          ? 'SYSTEM.AUTHENTICATION'
          : systemErrorStatus === 'NETWORK_ERROR' || systemErrorStatus === 'WORKER_OFFLINE'
            ? 'SYSTEM.NETWORK_ERROR'
            : 'SYSTEM.PROVIDER_INTERNAL_ERROR';
    pushErr(sysCat, 'CRITICAL', referenceRaw.slice(0, 32), `[${systemErrorStatus}]`, 0);
    return annotations;
  }

  // Check raw character-level Arabic Yeh / Kaf discrepancies before normalization
  if (/[\u064a\u0649]/.test(hypothesisRaw) && !/[\u064a\u0649]/.test(referenceRaw)) {
    pushErr('PERSIAN.YEH_NORMALIZATION', 'LOW', 'ی (U+06CC)', 'ي (U+064A)', 0);
  }
  if (/\u0643/.test(hypothesisRaw) && !/\u0643/.test(referenceRaw)) {
    pushErr('PERSIAN.KAF_NORMALIZATION', 'LOW', 'ک (U+06A9)', 'ك (U+0643)', 0);
  }

  // Compare strict vs relaxed to isolate ZWNJ errors
  const strictEval = evaluateWithNormalizationVersion(
    referenceRaw,
    hypothesisRaw,
    'fa_strict_v1',
  );
  const relaxedEval = evaluateWithNormalizationVersion(
    referenceRaw,
    hypothesisRaw,
    'fa_relaxed_v1',
  );

  if (strictEval.cer > relaxedEval.cer) {
    pushErr(
      'PERSIAN.ZWNJ_ERROR',
      'LOW',
      strictEval.reference_normalized,
      strictEval.hypothesis_normalized,
      0,
    );
  }

  if (strictEval.requires_hallucination_review) {
    pushErr(
      'TRANSCRIPTION.HALLUCINATION_REVIEW',
      'CRITICAL',
      referenceRaw.slice(0, 40),
      hypothesisRaw.slice(0, 60),
      0,
    );
  }

  const refTokens = applyVersionedNormalization(referenceRaw, 'mixed_norm_v1')
    .split(/\s+/)
    .filter(Boolean);
  const hypTokens = applyVersionedNormalization(hypothesisRaw, 'mixed_norm_v1')
    .split(/\s+/)
    .filter(Boolean);

  const alignment = alignSequencesLevenshtein(refTokens, hypTokens);
  const keytermLowerSet = new Set(keyterms.map((k) => k.toLowerCase()));

  for (const op of alignment.operations) {
    if (op.op === 'HIT') continue;
    const r = op.refItem ?? '';
    const h = op.hypItem ?? '';
    const rIsLatin = /[a-z]/i.test(r);
    const hIsLatin = /[a-z]/i.test(h);

    if (op.op === 'DELETION') {
      if (rIsLatin) {
        pushErr('LANGUAGE.CODE_SWITCH_FAILURE', 'HIGH', r, '<DELETED>', op.refIndex);
      } else {
        pushErr('TRANSCRIPTION.DELETION', 'MEDIUM', r, '<DELETED>', op.refIndex);
      }
    } else if (op.op === 'INSERTION') {
      const prevHyp = op.hypIndex > 0 ? hypTokens[op.hypIndex - 1] : '';
      if (h === prevHyp) {
        pushErr('TRANSCRIPTION.REPETITION', 'MEDIUM', '<NONE>', h, op.hypIndex);
      } else {
        pushErr('TRANSCRIPTION.INSERTION', 'MEDIUM', '<NONE>', h, op.hypIndex);
      }
    } else if (op.op === 'SUBSTITUTION') {
      // Check if ZWNJ-only difference already caught
      if (r.replace(/\u200c/g, '') === h.replace(/\u200c/g, '')) {
        continue;
      }
      if (rIsLatin && !hIsLatin) {
        pushErr('LANGUAGE.SCRIPT_ERROR', 'MEDIUM', r, h, op.refIndex);
      } else if (rIsLatin && hIsLatin) {
        if (r.length <= 4 && r.toUpperCase() === r) {
          pushErr('ENGLISH.ACRONYM_ERROR', 'HIGH', r, h, op.refIndex);
        } else if (KNOWN_TECHNICAL_ENGLISH_TERMS.has(r)) {
          pushErr('ENGLISH.TECHNICAL_TERM_ERROR', 'HIGH', r, h, op.refIndex);
        } else {
          pushErr('ENGLISH.HOMOPHONE_ERROR', 'MEDIUM', r, h, op.refIndex);
        }
      } else if (keytermLowerSet.has(r)) {
        pushErr('ENGLISH.PROPER_NOUN_ERROR', 'HIGH', r, h, op.refIndex);
      } else if (KNOWN_COLLOQUIAL_PERSIAN_FORMS.has(r) || KNOWN_COLLOQUIAL_PERSIAN_FORMS.has(h)) {
        pushErr('PERSIAN.COLLOQUIAL_WORD_ERROR', 'MEDIUM', r, h, op.refIndex);
      } else if (r.startsWith(h.slice(0, 3)) && Math.abs(r.length - h.length) <= 3) {
        pushErr('PERSIAN.MORPHOLOGY_ERROR', 'MEDIUM', r, h, op.refIndex);
      } else {
        pushErr('TRANSCRIPTION.SUBSTITUTION', 'MEDIUM', r, h, op.refIndex);
      }
    }
  }

  return annotations;
}

// ============================================================================
// SECTION 10: THREE-TIER COST TRACKING & VERSIONED PRICING REGISTRY
// ============================================================================

export interface PricingRegistryEntry {
  readonly price_version: string;
  readonly provider: string;
  readonly model: string;
  readonly service_mode: 'batch' | 'streaming';
  readonly unit: 'audio_hour' | 'audio_minute';
  readonly rate: number | null;
  readonly currency: 'USD';
  readonly source_url: string | null;
  readonly effective_date: string;
  readonly captured_date: string;
  readonly diarization_surcharge_per_hour: number;
  readonly pricing_verification_status: 'VERIFIED_PUBLIC_DOCS' | 'LOCAL_ZERO_COST' | 'UNKNOWN_UNVERIFIED';
}

export const PHASE3_PRICING_REGISTRY: readonly PricingRegistryEntry[] = [
  {
    price_version: 'PRICE-2026-11-v1',
    provider: 'avapardaz_local',
    model: 'avapardaz-ctc-viterbi-trilingual',
    service_mode: 'batch',
    unit: 'audio_hour',
    rate: 0.0,
    currency: 'USD',
    source_url: 'local://in-process',
    effective_date: '2026-11-18',
    captured_date: '2026-11-18',
    diarization_surcharge_per_hour: 0.0,
    pricing_verification_status: 'LOCAL_ZERO_COST',
  },
  {
    price_version: 'PRICE-2026-11-v1',
    provider: 'elevenlabs',
    model: 'scribe_v3',
    service_mode: 'batch',
    unit: 'audio_hour',
    rate: 0.30,
    currency: 'USD',
    source_url: 'https://elevenlabs.io/pricing',
    effective_date: '2026-11-10',
    captured_date: '2026-11-18',
    diarization_surcharge_per_hour: 0.0,
    pricing_verification_status: 'VERIFIED_PUBLIC_DOCS',
  },
  {
    price_version: 'PRICE-2026-11-v1',
    provider: 'deepgram',
    model: 'nova-3',
    service_mode: 'batch',
    unit: 'audio_hour',
    rate: 0.26,
    currency: 'USD',
    source_url: 'https://deepgram.com/pricing',
    effective_date: '2026-10-01',
    captured_date: '2026-11-18',
    diarization_surcharge_per_hour: 0.04,
    pricing_verification_status: 'VERIFIED_PUBLIC_DOCS',
  },
  {
    price_version: 'PRICE-2026-11-v1',
    provider: 'openai',
    model: 'gpt-transcribe',
    service_mode: 'batch',
    unit: 'audio_hour',
    rate: 0.36,
    currency: 'USD',
    source_url: 'https://openai.com/api/pricing',
    effective_date: '2026-11-01',
    captured_date: '2026-11-18',
    diarization_surcharge_per_hour: 0.0,
    pricing_verification_status: 'VERIFIED_PUBLIC_DOCS',
  },
  {
    price_version: 'PRICE-2026-11-v1',
    provider: 'microsoft_azure',
    model: 'mai-transcribe-2',
    service_mode: 'batch',
    unit: 'audio_hour',
    rate: null,
    currency: 'USD',
    source_url: null,
    effective_date: '2026-11-01',
    captured_date: '2026-11-18',
    diarization_surcharge_per_hour: 0.0,
    pricing_verification_status: 'UNKNOWN_UNVERIFIED',
  },
];

export interface ThreeTierCostBreakdown {
  /** Authoritative provider billing amount; null unless returned by billing API or local 0.0 */
  readonly actual_cost: number | null;
  /** Estimated cost from verified tariff registry; null if rate is unknown */
  readonly estimated_cost: number | null;
  /** True when neither actual nor verified rate is available (never replaced with 0!) */
  readonly unknown_cost: boolean;
  readonly currency: 'USD';
  readonly price_version: string;
}

export function calculateThreeTierCost(params: {
  provider: string;
  model: string;
  audioDurationSec: number;
  enableDiarization?: boolean;
  authoritativeActualCostUsd?: number | null;
}): ThreeTierCostBreakdown {
  const {
    provider,
    model,
    audioDurationSec,
    enableDiarization = false,
    authoritativeActualCostUsd = null,
  } = params;

  const entry = PHASE3_PRICING_REGISTRY.find(
    (p) => p.provider === provider || p.model === model,
  );

  if (!entry || entry.rate === null || entry.pricing_verification_status === 'UNKNOWN_UNVERIFIED') {
    return {
      actual_cost: authoritativeActualCostUsd,
      estimated_cost: null,
      unknown_cost: authoritativeActualCostUsd === null,
      currency: 'USD',
      price_version: entry?.price_version ?? 'UNVERIFIED',
    };
  }

  const hours = Math.max(0, audioDurationSec) / 3600;
  const effectiveHourlyRate =
    entry.rate + (enableDiarization ? entry.diarization_surcharge_per_hour : 0);
  const estimated = Number((hours * effectiveHourlyRate).toFixed(6));

  return {
    actual_cost:
      entry.pricing_verification_status === 'LOCAL_ZERO_COST'
        ? 0.0
        : authoritativeActualCostUsd,
    estimated_cost: estimated,
    unknown_cost: false,
    currency: 'USD',
    price_version: entry.price_version,
  };
}

// ============================================================================
// SECTION 8: STREAMING BENCHMARK, TIMING PERCENTILES & REVISION ANALYZER
// ============================================================================

export interface StreamingTranscriptEvent {
  readonly sequence_number: number;
  readonly event_timestamp_ms: number;
  readonly transcript_text: string;
  readonly is_final: boolean;
}

export interface StreamingRevisionAnalysisReport {
  readonly session_id: string;
  readonly chunk_profile: 'S01_100MS' | 'S02_250MS' | 'S03_500MS';
  readonly network_profile: 'N01_0MS' | 'N02_50MS' | 'N03_100MS';
  readonly ttft_ms: number;
  readonly finalization_latency_ms: number;
  readonly e2e_duration_ms: number;
  readonly revision_count: number;
  readonly revised_token_count: number;
  readonly final_transcript_stability: number;
  readonly missing_sequence_numbers: number[];
  readonly duplicate_sequence_numbers: number[];
  readonly out_of_order_sequence_numbers: number[];
  readonly events_recorded: number;
}

export interface TimingPercentileDistribution {
  readonly min: number;
  readonly p50_median: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export function computeTimingPercentiles(values: readonly number[]): TimingPercentileDistribution {
  if (values.length === 0) {
    return { min: 0, p50_median: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => {
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = sorted[Math.min(sorted.length - 1, base + 1)];
    return Number((sorted[base] + rest * (next - sorted[base])).toFixed(2));
  };
  return {
    min: Number(sorted[0].toFixed(2)),
    p50_median: pick(0.5),
    p90: pick(0.9),
    p95: pick(0.95),
    p99: pick(0.99),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

export function analyzeStreamingSessionEvents(params: {
  sessionId: string;
  chunkProfile?: StreamingRevisionAnalysisReport['chunk_profile'];
  networkProfile?: StreamingRevisionAnalysisReport['network_profile'];
  sessionStartMonotonicMs: number;
  speechOnsetMonotonicMs: number;
  speechEndMonotonicMs: number;
  events: readonly StreamingTranscriptEvent[];
}): StreamingRevisionAnalysisReport {
  const {
    sessionId,
    chunkProfile = 'S01_100MS',
    networkProfile = 'N01_0MS',
    sessionStartMonotonicMs,
    speechOnsetMonotonicMs,
    speechEndMonotonicMs,
    events,
  } = params;

  const seenSeq = new Set<number>();
  const duplicateSeq: number[] = [];
  const outOfOrderSeq: number[] = [];
  let maxSeqSeen = 0;

  let firstNonEmptyPartialTs: number | null = null;
  let finalTranscriptTs: number | null = null;
  let revisionCount = 0;
  let revisedTokenCount = 0;
  let prevTokens: string[] = [];

  for (const ev of events) {
    if (seenSeq.has(ev.sequence_number)) {
      duplicateSeq.push(ev.sequence_number);
    }
    if (ev.sequence_number < maxSeqSeen) {
      outOfOrderSeq.push(ev.sequence_number);
    }
    seenSeq.add(ev.sequence_number);
    if (ev.sequence_number > maxSeqSeen) maxSeqSeen = ev.sequence_number;

    const clean = ev.transcript_text.trim();
    if (clean.length > 0 && firstNonEmptyPartialTs === null) {
      firstNonEmptyPartialTs = ev.event_timestamp_ms;
    }
    if (ev.is_final) {
      finalTranscriptTs = ev.event_timestamp_ms;
    }

    const curTokens = clean.split(/\s+/).filter(Boolean);
    if (prevTokens.length > 0 && curTokens.length > 0) {
      let commonPrefix = 0;
      const minLen = Math.min(prevTokens.length, curTokens.length);
      while (commonPrefix < minLen && prevTokens[commonPrefix] === curTokens[commonPrefix]) {
        commonPrefix++;
      }
      const changedInPrev = prevTokens.length - commonPrefix;
      if (changedInPrev > 0) {
        revisionCount++;
        revisedTokenCount += changedInPrev;
      }
    }
    prevTokens = curTokens;
  }

  const missingSeq: number[] = [];
  for (let s = 1; s <= maxSeqSeen; s++) {
    if (!seenSeq.has(s)) missingSeq.push(s);
  }

  const ttftMs =
    firstNonEmptyPartialTs !== null
      ? Math.max(0, firstNonEmptyPartialTs - speechOnsetMonotonicMs)
      : 0;
  const finalizationLatencyMs =
    finalTranscriptTs !== null
      ? Math.max(0, finalTranscriptTs - speechEndMonotonicMs)
      : 0;
  const e2eDurationMs =
    finalTranscriptTs !== null
      ? Math.max(0, finalTranscriptTs - sessionStartMonotonicMs)
      : 0;

  const stability =
    events.length > 1
      ? Number(Math.max(0, 1 - revisionCount / Math.max(1, events.length - 1)).toFixed(3))
      : 1.0;

  return {
    session_id: sessionId,
    chunk_profile: chunkProfile,
    network_profile: networkProfile,
    ttft_ms: Number(ttftMs.toFixed(2)),
    finalization_latency_ms: Number(finalizationLatencyMs.toFixed(2)),
    e2e_duration_ms: Number(e2eDurationMs.toFixed(2)),
    revision_count: revisionCount,
    revised_token_count: revisedTokenCount,
    final_transcript_stability: stability,
    missing_sequence_numbers: missingSeq,
    duplicate_sequence_numbers: duplicateSeq,
    out_of_order_sequence_numbers: outOfOrderSeq,
    events_recorded: events.length,
  };
}

// ============================================================================
// SECTION 13: PAIRED BOOTSTRAP (10,000 ITERATIONS) & HOLM-BONFERRONI ENGINE
// ============================================================================

export interface PairedBootstrapComparisonResult {
  readonly engine_a_id: string;
  readonly engine_b_id: string;
  readonly metric_name: 'cer' | 'wer';
  readonly sample_count: number;
  readonly iterations: number;
  readonly random_seed: number;
  readonly engine_a_mean: number;
  readonly engine_b_mean: number;
  readonly mean_difference_a_minus_b: number;
  readonly ci_95_lower: number;
  readonly ci_95_upper: number;
  readonly raw_p_value: number;
  readonly adjusted_p_value_holm: number;
  readonly is_statistically_significant_95: boolean;
  readonly practical_effect_size: 'NEGLIGIBLE' | 'SMALL' | 'MODERATE' | 'LARGE';
  readonly sample_coverage_adequate: boolean;
}

/**
 * Deterministic Mulberry32 PRNG for reproducible 10,000-iteration Paired Bootstrap resampling.
 */
function createSeededPrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runPairedBootstrapAndHolmBonferroni(params: {
  comparisons: readonly {
    readonly engineAId: string;
    readonly engineBId: string;
    readonly metricName: 'cer' | 'wer';
    readonly pairedSampleScoresA: readonly number[];
    readonly pairedSampleScoresB: readonly number[];
  }[];
  iterations?: number;
  randomSeed?: number;
  minimumRequiredSamplesForAdequacy?: number;
}): PairedBootstrapComparisonResult[] {
  const {
    comparisons,
    iterations = 10000,
    randomSeed = 20261118,
    minimumRequiredSamplesForAdequacy = 30,
  } = params;

  const rawResults = comparisons.map((comp, idx) => {
    const n = Math.min(comp.pairedSampleScoresA.length, comp.pairedSampleScoresB.length);
    if (n === 0) {
      return {
        engine_a_id: comp.engineAId,
        engine_b_id: comp.engineBId,
        metric_name: comp.metricName,
        sample_count: 0,
        iterations,
        random_seed: randomSeed + idx,
        engine_a_mean: 0,
        engine_b_mean: 0,
        mean_difference_a_minus_b: 0,
        ci_95_lower: 0,
        ci_95_upper: 0,
        raw_p_value: 1.0,
        adjusted_p_value_holm: 1.0,
        is_statistically_significant_95: false,
        practical_effect_size: 'NEGLIGIBLE' as const,
        sample_coverage_adequate: false,
      };
    }

    const prng = createSeededPrng(randomSeed + idx);
    const diffs = new Float64Array(n);
    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < n; i++) {
      sumA += comp.pairedSampleScoresA[i];
      sumB += comp.pairedSampleScoresB[i];
      diffs[i] = comp.pairedSampleScoresA[i] - comp.pairedSampleScoresB[i];
    }
    const meanA = sumA / n;
    const meanB = sumB / n;
    const observedDiff = meanA - meanB;

    const bootDiffs = new Float64Array(iterations);
    let oppositeSignCount = 0;

    for (let it = 0; it < iterations; it++) {
      let bSum = 0;
      for (let k = 0; k < n; k++) {
        const pickIdx = Math.floor(prng() * n);
        bSum += diffs[pickIdx];
      }
      const bMean = bSum / n;
      bootDiffs[it] = bMean;
      if (
        (observedDiff > 0 && bMean <= 0) ||
        (observedDiff < 0 && bMean >= 0) ||
        observedDiff === 0
      ) {
        oppositeSignCount++;
      }
    }

    bootDiffs.sort();
    const lowerIdx = Math.floor(iterations * 0.025);
    const upperIdx = Math.min(iterations - 1, Math.floor(iterations * 0.975));
    const ciLower = bootDiffs[lowerIdx];
    const ciUpper = bootDiffs[upperIdx];

    const rawPValue = Math.min(1.0, (2 * Math.max(1, oppositeSignCount)) / iterations);
    const absDiff = Math.abs(observedDiff);
    const effectSize: PairedBootstrapComparisonResult['practical_effect_size'] =
      absDiff < 0.01
        ? 'NEGLIGIBLE'
        : absDiff < 0.03
          ? 'SMALL'
          : absDiff < 0.08
            ? 'MODERATE'
            : 'LARGE';

    return {
      engine_a_id: comp.engineAId,
      engine_b_id: comp.engineBId,
      metric_name: comp.metricName,
      sample_count: n,
      iterations,
      random_seed: randomSeed + idx,
      engine_a_mean: Number(meanA.toFixed(4)),
      engine_b_mean: Number(meanB.toFixed(4)),
      mean_difference_a_minus_b: Number(observedDiff.toFixed(4)),
      ci_95_lower: Number(ciLower.toFixed(4)),
      ci_95_upper: Number(ciUpper.toFixed(4)),
      raw_p_value: Number(rawPValue.toFixed(4)),
      adjusted_p_value_holm: Number(rawPValue.toFixed(4)),
      is_statistically_significant_95: false,
      practical_effect_size: effectSize,
      sample_coverage_adequate: n >= minimumRequiredSamplesForAdequacy,
    };
  });

  // Apply Holm-Bonferroni step-down multiple hypothesis correction
  const m = rawResults.length;
  const order = rawResults
    .map((r, i) => ({ p: r.raw_p_value, i }))
    .sort((a, b) => a.p - b.p);

  const adjustedP = new Array<number>(m).fill(1.0);
  let maxRunningP = 0;
  for (let rank = 0; rank < m; rank++) {
    const origIdx = order[rank].i;
    const factor = m - rank;
    const adj = Math.min(1.0, order[rank].p * factor);
    maxRunningP = Math.max(maxRunningP, adj);
    adjustedP[origIdx] = Number(maxRunningP.toFixed(4));
  }

  return rawResults.map((r, i) => ({
    ...r,
    adjusted_p_value_holm: adjustedP[i],
    is_statistically_significant_95:
      r.sample_coverage_adequate &&
      adjustedP[i] < 0.05 &&
      (r.ci_95_lower > 0 || r.ci_95_upper < 0),
  }));
}

// ============================================================================
// PHASE 2 & SECTION 3: DATASET QC (11 GATES), ZERO-LEAKAGE SPLIT & IDEMPOTENCY
// ============================================================================

export type DatasetQcFailureCode =
  | 'QC01_CORRUPTED_FILE'
  | 'QC02_EMPTY_AUDIO'
  | 'QC03_AUDIO_CLIPPING'
  | 'QC04_EXCESSIVE_SILENCE'
  | 'QC05_LOW_VOLUME'
  | 'QC06_INVALID_SAMPLE_RATE'
  | 'QC07_DUPLICATE_AUDIO_HASH'
  | 'QC08_INCOMPLETE_TRANSCRIPT'
  | 'QC09_DURATION_TRANSCRIPT_MISMATCH'
  | 'QC10_LANGUAGE_LABEL_MISMATCH'
  | 'QC11_SPEAKER_LABEL_OR_CONSENT_ERROR';

export interface DatasetSampleRecord {
  readonly sample_id: string;
  readonly speaker_id: string;
  readonly language: 'fa' | 'en' | 'fa-en' | 'fa-ar' | 'fa-en-ar';
  readonly language_segments: readonly {
    readonly text: string;
    readonly accepted_alt_script?: string;
    readonly lang: 'fa' | 'en' | 'ar';
    readonly start_sec: number;
    readonly end_sec: number;
  }[];
  readonly transcript_raw: string;
  readonly transcript_normalized: string;
  readonly duration: number;
  readonly sample_rate: number;
  readonly channel_count: number;
  readonly recording_environment:
    | 'studio_clean'
    | 'home_quiet'
    | 'office_room'
    | 'street_traffic'
    | 'cafe_crowd'
    | 'vehicle_cabin'
    | 'telephone_8khz';
  readonly noise_level: {
    readonly snr_db: number;
    readonly rms_dbfs: number;
    readonly peak_dbfs: number;
  };
  readonly speaking_style:
    | 'formal_read'
    | 'conversational_spontaneous'
    | 'technical_discussion'
    | 'multi_speaker_debate'
    | 'fast_paced';
  readonly accent_label: string;
  readonly speaker_count: number;
  readonly dataset_source:
    | 'AVAPARDAZ_STUDIO_CONSENT'
    | 'COMMON_VOICE_CC0'
    | 'FLEURS_CC_BY_4'
    | 'PESTE_BENCHMARK'
    | 'EXTERNAL_ACADEMIC_NC';
  readonly license:
    | 'CC0-1.0'
    | 'CC-BY-4.0'
    | 'PROPRIETARY_CONSENT_VERIFIED'
    | 'ACADEMIC_NON_COMMERCIAL'
    | 'UNKNOWN_RESTRICTED';
  readonly consent_status:
    | 'VERIFIED_WRITTEN_CONSENT'
    | 'PUBLIC_DOMAIN_CC0'
    | 'PUBLIC_ATTRIBUTION_CC_BY'
    | 'UNVERIFIED_BLOCKED';
  readonly audio_hash: string;
  readonly annotation_version: string;
  readonly quality_status: 'APPROVED_GOLD' | 'NEEDS_HUMAN_REVIEW' | 'REJECTED_QC_FAILED';
  readonly assigned_split?: 'train' | 'validation' | 'test';
  readonly qc_score?: number;
  readonly qc_issues?: readonly DatasetQcFailureCode[];
}

export function evaluateSampleQuality11Gates(
  sample: DatasetSampleRecord,
  existingAudioHashes: ReadonlySet<string>,
  options?: { hasCorruptedSignal?: boolean; silenceRatio?: number },
): {
  qcScore: number;
  qualityStatus: DatasetSampleRecord['quality_status'];
  issues: DatasetQcFailureCode[];
} {
  const issues: DatasetQcFailureCode[] = [];
  let score = 100;
  let hardReject = false;

  // QC-01: Corrupted file
  if (options?.hasCorruptedSignal || !Number.isFinite(sample.duration) || !/^[a-f0-9]{64}$/.test(sample.audio_hash)) {
    issues.push('QC01_CORRUPTED_FILE');
    hardReject = true;
  }

  // QC-02: Empty audio
  if (sample.duration < 0.2 || sample.noise_level.rms_dbfs <= -75) {
    issues.push('QC02_EMPTY_AUDIO');
    hardReject = true;
  }

  // QC-03: Clipping
  if (sample.noise_level.peak_dbfs >= -0.15) {
    issues.push('QC03_AUDIO_CLIPPING');
    score -= 25;
  }

  // QC-04: Excessive silence
  if ((options?.silenceRatio ?? 0) > 0.65) {
    issues.push('QC04_EXCESSIVE_SILENCE');
    score -= 20;
  }

  // QC-05: Low volume
  if (sample.noise_level.rms_dbfs < -38 && sample.noise_level.peak_dbfs < -22) {
    issues.push('QC05_LOW_VOLUME');
    score -= 20;
  }

  // QC-06: Invalid sample rate
  if (![8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000].includes(sample.sample_rate)) {
    issues.push('QC06_INVALID_SAMPLE_RATE');
    hardReject = true;
  }

  // QC-07: Duplicate file hash
  if (existingAudioHashes.has(sample.audio_hash)) {
    issues.push('QC07_DUPLICATE_AUDIO_HASH');
    hardReject = true;
  }

  // QC-08: Incomplete transcript
  const cleanWords = sample.transcript_raw.trim().split(/\s+/).filter(Boolean);
  if (sample.transcript_raw.trim().length < 2 || cleanWords.length === 0 || sample.transcript_raw.includes('[نامفهوم]')) {
    issues.push('QC08_INCOMPLETE_TRANSCRIPT');
    score -= 40;
  }

  // QC-09: Duration vs transcript length mismatch (WPM < 25 or WPM > 310)
  const wpm = (cleanWords.length / Math.max(0.1, sample.duration)) * 60;
  if (wpm < 25 || wpm > 310) {
    issues.push('QC09_DURATION_TRANSCRIPT_MISMATCH');
    score -= 30;
  }

  // QC-10: Language label mismatch
  const hasLatin = /[A-Za-z]{2,}/.test(sample.transcript_raw);
  const hasPersian = /[\u0600-\u06FF]{2,}/.test(sample.transcript_raw);
  if (
    (sample.language === 'fa' && hasLatin) ||
    (sample.language === 'en' && hasPersian)
  ) {
    issues.push('QC10_LANGUAGE_LABEL_MISMATCH');
    score -= 25;
  }

  // QC-11: Speaker ID PII / Consent error
  if (
    !/^SPK_[A-Z0-9_]{3,32}$/.test(sample.speaker_id) ||
    sample.speaker_count < 1 ||
    sample.consent_status === 'UNVERIFIED_BLOCKED' ||
    sample.license === 'UNKNOWN_RESTRICTED'
  ) {
    issues.push('QC11_SPEAKER_LABEL_OR_CONSENT_ERROR');
    hardReject = true;
  }

  if (hardReject) {
    return {
      qcScore: 0,
      qualityStatus: 'REJECTED_QC_FAILED',
      issues,
    };
  }

  const finalScore = Math.max(0, score);
  const qualityStatus: DatasetSampleRecord['quality_status'] =
    finalScore >= 85 && issues.length === 0
      ? 'APPROVED_GOLD'
      : finalScore >= 50
        ? 'NEEDS_HUMAN_REVIEW'
        : 'REJECTED_QC_FAILED';

  return {
    qcScore: finalScore,
    qualityStatus,
    issues,
  };
}

/**
 * Assigns zero-leakage speaker-disjoint splits (`train`, `validation`, `test`),
 * ensuring NO speaker_id in `test` ever appears in `train` or `validation`,
 * and locking all `PESTE_BENCHMARK` samples exclusively in `test`.
 */
export function assignZeroLeakageDatasetSplits(
  samples: readonly DatasetSampleRecord[],
): {
  splitSamples: DatasetSampleRecord[];
  trainSpeakers: string[];
  validationSpeakers: string[];
  testSpeakers: string[];
  speakerLeakageCount: number;
  frozenTestManifestSha256: string;
} {
  const approved = samples.filter((s) => s.quality_status !== 'REJECTED_QC_FAILED');

  // Group samples by speaker_id
  const bySpeaker = new Map<string, DatasetSampleRecord[]>();
  for (const s of approved) {
    const list = bySpeaker.get(s.speaker_id) ?? [];
    list.push(s);
    bySpeaker.set(s.speaker_id, list);
  }

  const speakerAssignment = new Map<string, 'train' | 'validation' | 'test'>();

  // Rule 1: Any speaker with PESTE_BENCHMARK samples is locked exclusively to `test`
  for (const [spk, list] of bySpeaker.entries()) {
    if (list.some((s) => s.dataset_source === 'PESTE_BENCHMARK')) {
      speakerAssignment.set(spk, 'test');
    }
  }

  // Rule 2: Partition remaining speakers deterministically without overlap
  const remainingSpeakers = Array.from(bySpeaker.keys())
    .filter((spk) => !speakerAssignment.has(spk))
    .sort();

  remainingSpeakers.forEach((spk, idx) => {
    if (remainingSpeakers.length >= 3) {
      if (idx % 3 === 2 && !Array.from(speakerAssignment.values()).includes('test')) {
        speakerAssignment.set(spk, 'test');
      } else if (idx % 3 === 1) {
        speakerAssignment.set(spk, 'validation');
      } else if (idx === remainingSpeakers.length - 1 && !Array.from(speakerAssignment.values()).includes('test')) {
        speakerAssignment.set(spk, 'test');
      } else {
        speakerAssignment.set(spk, 'train');
      }
    } else if (remainingSpeakers.length === 2) {
      speakerAssignment.set(spk, idx === 0 ? 'train' : 'test');
    } else {
      speakerAssignment.set(spk, 'test');
    }
  });

  const splitSamples = approved.map((s) => ({
    ...s,
    assigned_split: speakerAssignment.get(s.speaker_id) ?? 'test',
  }));

  const trainSpeakers = Array.from(
    new Set(splitSamples.filter((s) => s.assigned_split === 'train').map((s) => s.speaker_id)),
  );
  const validationSpeakers = Array.from(
    new Set(
      splitSamples.filter((s) => s.assigned_split === 'validation').map((s) => s.speaker_id),
    ),
  );
  const testSpeakers = Array.from(
    new Set(splitSamples.filter((s) => s.assigned_split === 'test').map((s) => s.speaker_id)),
  );

  // Verify zero speaker intersection
  const trainSet = new Set(trainSpeakers);
  const valSet = new Set(validationSpeakers);
  let speakerLeakageCount = 0;
  for (const tSpk of testSpeakers) {
    if (trainSet.has(tSpk) || valSet.has(tSpk)) speakerLeakageCount++;
  }
  for (const vSpk of validationSpeakers) {
    if (trainSet.has(vSpk)) speakerLeakageCount++;
  }

  const testManifestString = splitSamples
    .filter((s) => s.assigned_split === 'test')
    .map((s) => `${s.sample_id}:${s.audio_hash}`)
    .sort()
    .join('|');
  const frozenTestManifestSha256 = computeDeterministicAudioSha256(
    new TextEncoder().encode(testManifestString || 'empty_test_set'),
  );

  return {
    splitSamples,
    trainSpeakers,
    validationSpeakers,
    testSpeakers,
    speakerLeakageCount,
    frozenTestManifestSha256,
  };
}

// ============================================================================
// SECTION 5: EXPERIMENT LIFECYCLE STATE MACHINE & IDEMPOTENCY DEDUPLICATOR
// ============================================================================

export type ExperimentLifecycleState =
  | 'DRAFT'
  | 'VALIDATED'
  | 'COST_REVIEW'
  | 'APPROVED'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIALLY_FAILED'
  | 'FAILED'
  | 'CANCELLED';

export class IdempotentExperimentTaskDeduplicator {
  private readonly executedKeys = new Set<string>();
  private duplicateAttemptsBlocked = 0;

  public static buildIdempotencyKey(params: {
    experimentId: string;
    sampleId: string;
    engineId: string;
    configurationHash: string;
    repetitionIndex: number;
  }): string {
    return `${params.experimentId}::${params.sampleId}::${params.engineId}::${params.configurationHash}::rep${params.repetitionIndex}`;
  }

  public tryAcquireExecutionSlot(key: string): boolean {
    if (this.executedKeys.has(key)) {
      this.duplicateAttemptsBlocked++;
      return false;
    }
    this.executedKeys.add(key);
    return true;
  }

  public getUniqueExecutionCount(): number {
    return this.executedKeys.size;
  }

  public getDuplicateAttemptsBlocked(): number {
    return this.duplicateAttemptsBlocked;
  }
}

export const INITIAL_VERIFIED_STUDIO_CORPUS: readonly DatasetSampleRecord[] = [
  {
    sample_id: 'AVP-GOLD-FA-0001',
    speaker_id: 'SPK_FA_001',
    language: 'fa',
    language_segments: [
      {
        text: 'سلام امروز در پادکست جذاب ما درباره هوش مصنوعی صحبت می‌کنیم و نتیجه‌هایش عالی است.',
        lang: 'fa',
        start_sec: 0,
        end_sec: 8.4,
      },
    ],
    transcript_raw:
      'سلام امروز در پادکست جذاب ما درباره هوش مصنوعی صحبت می‌کنیم و نتیجه‌هایش عالی است.',
    transcript_normalized: normalizeFaStrictV1(
      'سلام امروز در پادکست جذاب ما درباره هوش مصنوعی صحبت می‌کنیم و نتیجه‌هایش عالی است.',
    ),
    duration: 8.4,
    sample_rate: 16000,
    channel_count: 1,
    recording_environment: 'studio_clean',
    noise_level: { snr_db: 32.5, rms_dbfs: -18.4, peak_dbfs: -3.2 },
    speaking_style: 'formal_read',
    accent_label: 'fa-IR-Standard',
    speaker_count: 1,
    dataset_source: 'AVAPARDAZ_STUDIO_CONSENT',
    license: 'PROPRIETARY_CONSENT_VERIFIED',
    consent_status: 'VERIFIED_WRITTEN_CONSENT',
    audio_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f01',
    annotation_version: 'ANNOT-FA-EN-v1.0',
    quality_status: 'APPROVED_GOLD',
    assigned_split: 'train',
    qc_score: 100,
    qc_issues: [],
  },
  {
    sample_id: 'AVP-GOLD-FA-0002',
    speaker_id: 'SPK_FA_001',
    language: 'fa',
    language_segments: [
      {
        text: 'می‌خوام توی این قسمت درباره کیفیت پردازش صوت صحبت کنم و نتیجه‌هاش رو ببینیم.',
        lang: 'fa',
        start_sec: 0,
        end_sec: 7.8,
      },
    ],
    transcript_raw:
      'می‌خوام توی این قسمت درباره کیفیت پردازش صوت صحبت کنم و نتیجه‌هاش رو ببینیم.',
    transcript_normalized: normalizeFaStrictV1(
      'می‌خوام توی این قسمت درباره کیفیت پردازش صوت صحبت کنم و نتیجه‌هاش رو ببینیم.',
    ),
    duration: 7.8,
    sample_rate: 16000,
    channel_count: 1,
    recording_environment: 'studio_clean',
    noise_level: { snr_db: 30.1, rms_dbfs: -19.2, peak_dbfs: -4.1 },
    speaking_style: 'conversational_spontaneous',
    accent_label: 'fa-IR-Tehran',
    speaker_count: 1,
    dataset_source: 'AVAPARDAZ_STUDIO_CONSENT',
    license: 'PROPRIETARY_CONSENT_VERIFIED',
    consent_status: 'VERIFIED_WRITTEN_CONSENT',
    audio_hash: 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9002',
    annotation_version: 'ANNOT-FA-EN-v1.0',
    quality_status: 'APPROVED_GOLD',
    assigned_split: 'train',
    qc_score: 100,
    qc_issues: [],
  },
  {
    sample_id: 'AVP-GOLD-CS-0003',
    speaker_id: 'SPK_CS_002',
    language: 'fa-en',
    language_segments: [
      { text: 'معماری', lang: 'fa', start_sec: 0, end_sec: 1.2 },
      {
        text: 'Backend',
        accepted_alt_script: 'بک‌اند',
        lang: 'en',
        start_sec: 1.2,
        end_sec: 2.1,
      },
      {
        text: 'TypeScript',
        accepted_alt_script: 'تایپ‌اسکریپت',
        lang: 'en',
        start_sec: 2.4,
        end_sec: 3.6,
      },
      {
        text: 'WebGPU',
        accepted_alt_script: 'وب‌جی‌پی‌یو',
        lang: 'en',
        start_sec: 4.0,
        end_sec: 5.2,
      },
    ],
    transcript_raw:
      'معماری Backend و TypeScript با WebGPU برای پردازش صوت بسیار سریع است.',
    transcript_normalized: normalizeMixedNormV1(
      'معماری Backend و TypeScript با WebGPU برای پردازش صوت بسیار سریع است.',
    ),
    duration: 9.6,
    sample_rate: 16000,
    channel_count: 1,
    recording_environment: 'studio_clean',
    noise_level: { snr_db: 31.0, rms_dbfs: -17.8, peak_dbfs: -2.9 },
    speaking_style: 'technical_discussion',
    accent_label: 'fa-IR-Tehran',
    speaker_count: 1,
    dataset_source: 'AVAPARDAZ_STUDIO_CONSENT',
    license: 'PROPRIETARY_CONSENT_VERIFIED',
    consent_status: 'VERIFIED_WRITTEN_CONSENT',
    audio_hash: 'c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a103',
    annotation_version: 'ANNOT-FA-EN-v1.0',
    quality_status: 'APPROVED_GOLD',
    assigned_split: 'validation',
    qc_score: 100,
    qc_issues: [],
  },
  {
    sample_id: 'AVP-GOLD-CS-0004',
    speaker_id: 'SPK_CS_003',
    language: 'fa-en-ar',
    language_segments: [
      { text: 'إن شاء الله', lang: 'ar', start_sec: 0, end_sec: 1.5 },
      {
        text: 'FastAPI',
        accepted_alt_script: 'فست‌ای‌پی‌آی',
        lang: 'en',
        start_sec: 3.1,
        end_sec: 4.3,
      },
    ],
    transcript_raw:
      'إن شاء الله امروز سرویس FastAPI و تحقیق هوش مصنوعی را دقیقاً بررسی می‌کنیم.',
    transcript_normalized: normalizeMixedNormV1(
      'إن شاء الله امروز سرویس FastAPI و تحقیق هوش مصنوعی را دقیقاً بررسی می‌کنیم.',
    ),
    duration: 10.2,
    sample_rate: 16000,
    channel_count: 1,
    recording_environment: 'office_room',
    noise_level: { snr_db: 24.5, rms_dbfs: -20.1, peak_dbfs: -4.5 },
    speaking_style: 'technical_discussion',
    accent_label: 'fa-IR-Standard',
    speaker_count: 1,
    dataset_source: 'PESTE_BENCHMARK',
    license: 'CC-BY-4.0',
    consent_status: 'PUBLIC_ATTRIBUTION_CC_BY',
    audio_hash: 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b204',
    annotation_version: 'ANNOT-FA-EN-v1.0',
    quality_status: 'APPROVED_GOLD',
    assigned_split: 'test',
    qc_score: 100,
    qc_issues: [],
  },
  {
    sample_id: 'AVP-GOLD-EN-0005',
    speaker_id: 'SPK_EN_004',
    language: 'en',
    language_segments: [
      {
        text: 'Real time speech recognition requires low latency and high accuracy.',
        lang: 'en',
        start_sec: 0,
        end_sec: 7.2,
      },
    ],
    transcript_raw:
      'Real-time speech recognition requires low latency and high accuracy.',
    transcript_normalized: normalizeEnNormV1(
      'Real-time speech recognition requires low latency and high accuracy.',
    ),
    duration: 7.2,
    sample_rate: 16000,
    channel_count: 1,
    recording_environment: 'studio_clean',
    noise_level: { snr_db: 33.2, rms_dbfs: -18.0, peak_dbfs: -3.0 },
    speaking_style: 'formal_read',
    accent_label: 'en-US-General',
    speaker_count: 1,
    dataset_source: 'COMMON_VOICE_CC0',
    license: 'CC0-1.0',
    consent_status: 'PUBLIC_DOMAIN_CC0',
    audio_hash: 'e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c305',
    annotation_version: 'ANNOT-FA-EN-v1.0',
    quality_status: 'APPROVED_GOLD',
    assigned_split: 'test',
    qc_score: 100,
    qc_issues: [],
  },
  {
    sample_id: 'AVP-GOLD-NOISE-0006',
    speaker_id: 'SPK_CS_003',
    language: 'fa-en',
    language_segments: [
      {
        text: 'توی محیط شلوغ هم مدل باید کلمات API و تایپ‌اسکریپت رو درست تشخیص بده.',
        lang: 'fa',
        start_sec: 0,
        end_sec: 8.2,
      },
    ],
    transcript_raw:
      'توی محیط شلوغ هم مدل باید کلمات API و TypeScript رو درست تشخیص بده.',
    transcript_normalized: normalizeMixedNormV1(
      'توی محیط شلوغ هم مدل باید کلمات API و TypeScript رو درست تشخیص بده.',
    ),
    duration: 8.2,
    sample_rate: 16000,
    channel_count: 1,
    recording_environment: 'cafe_crowd',
    noise_level: { snr_db: 11.4, rms_dbfs: -21.5, peak_dbfs: -3.8 },
    speaking_style: 'conversational_spontaneous',
    accent_label: 'fa-IR-Tehran',
    speaker_count: 1,
    dataset_source: 'PESTE_BENCHMARK',
    license: 'CC-BY-4.0',
    consent_status: 'PUBLIC_ATTRIBUTION_CC_BY',
    audio_hash: 'f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d406',
    annotation_version: 'ANNOT-FA-EN-v1.0',
    quality_status: 'APPROVED_GOLD',
    assigned_split: 'test',
    qc_score: 92,
    qc_issues: [],
  },
];

export {
  validateAndPreprocessAudioForLab,
  sanitizeSecretsFromText,
  type AsrLabEngineId,
  type AudioIngestionValidationReport,
};
