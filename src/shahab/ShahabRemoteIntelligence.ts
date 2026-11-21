/**
 * SHAHAB-003 — Remote Model Intelligence and Lazy Repository Access
 *
 * Implements:
 * - SHAHABHuggingFaceProvider
 * - SHAHABGitHubProvider
 * - SHAHABRevisionResolver
 * - SHAHABRemoteFileInspector
 * - SHAHABRepositoryResolver
 *
 * Strict Rules:
 * - Remote metadata inspection ONLY (zero weight downloads, zero git clones, zero git lfs pull).
 * - Public API discovery requires no embedded tokens or credentials.
 * - Never treats `main`/`master` as immutable; resolves to exact 40-char commit SHA.
 * - Enforces retries, timeout, rate-limit handling, and strict host allowlist (SSRF protection).
 * - Keeps Nemotron subject to an explicit legal-use gate.
 */

import type {
  ShahabCandidateModelRecord,
  ShahabEvidenceStatus,
  ShahabRemoteFileEntry,
  ShahabThirdPartyReuseItem,
} from './ShahabContracts';

const ALLOWED_REMOTE_HOSTS = new Set([
  'huggingface.co',
  'api.github.com',
  'raw.githubusercontent.com',
]);

export interface RemoteFetchOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class ShahabRemoteFetchError extends Error {
  public readonly code: 'HOST_NOT_ALLOWED' | 'TIMEOUT' | 'RATE_LIMITED' | 'HTTP_ERROR' | 'NETWORK_ERROR';
  public readonly statusCode?: number;

  constructor(
    code: 'HOST_NOT_ALLOWED' | 'TIMEOUT' | 'RATE_LIMITED' | 'HTTP_ERROR' | 'NETWORK_ERROR',
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = 'ShahabRemoteFetchError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function assertAllowedRemoteUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') {
    throw new ShahabRemoteFetchError('HOST_NOT_ALLOWED', `Only HTTPS remote endpoints are allowed: ${rawUrl}`);
  }
  if (!ALLOWED_REMOTE_HOSTS.has(parsed.hostname)) {
    throw new ShahabRemoteFetchError(
      'HOST_NOT_ALLOWED',
      `Host "${parsed.hostname}" is outside SHAHAB allowlist (${Array.from(ALLOWED_REMOTE_HOSTS).join(', ')}).`,
    );
  }
  return parsed;
}

async function fetchWithResilience(
  url: string,
  headers: Record<string, string>,
  opts: RemoteFetchOptions = {},
): Promise<Response> {
  assertAllowedRemoteUrl(url);
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxRetries = opts.maxRetries ?? 2;
  const retryBaseDelayMs = opts.retryBaseDelayMs ?? 350;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchFn(url, {
        headers: {
          'User-Agent': 'AVAPARDAZ-SHAHAB-RemoteIntelligence/1.0',
          ...headers,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (resp.status === 429 || (resp.status === 403 && resp.headers.get('x-ratelimit-remaining') === '0')) {
        lastError = new ShahabRemoteFetchError(
          'RATE_LIMITED',
          `Remote API rate limited (${resp.status}) for ${url}`,
          resp.status,
        );
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, retryBaseDelayMs * (attempt + 1)));
          continue;
        }
        throw lastError;
      }

      if (resp.status >= 500 && attempt < maxRetries) {
        lastError = new ShahabRemoteFetchError('HTTP_ERROR', `Upstream ${resp.status} for ${url}`, resp.status);
        await new Promise((r) => setTimeout(r, retryBaseDelayMs * (attempt + 1)));
        continue;
      }

      return resp;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ShahabRemoteFetchError) {
        throw err;
      }
      const isAbort = err instanceof Error && err.name === 'AbortError';
      lastError = new ShahabRemoteFetchError(
        isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
        isAbort ? `Timeout after ${timeoutMs}ms fetching ${url}` : `Network error: ${String(err)}`,
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryBaseDelayMs * (attempt + 1)));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new ShahabRemoteFetchError('NETWORK_ERROR', `Failed fetching ${url}`);
}

export function isImmutableCommitSha(rev: string | null | undefined): boolean {
  return typeof rev === 'string' && /^[a-f0-9]{40}$/i.test(rev.trim());
}

export function classifyRemoteFile(filePath: string): {
  readonly category: ShahabRemoteFileEntry['category'];
  readonly requiredForInference: boolean;
} {
  const lower = filePath.toLowerCase();
  const base = lower.split('/').pop() ?? lower;

  if (base === 'license' || base.startsWith('license.') || base === 'notice') {
    return { category: 'license', requiredForInference: true };
  }
  if (base === 'readme.md' || lower.endsWith('.md')) {
    return { category: 'documentation', requiredForInference: false };
  }
  if (base === 'tokens.txt' || base.endsWith('tokens.txt')) {
    return { category: 'tokens', requiredForInference: true };
  }
  if (base.endsWith('.model') || base.includes('tokenizer') || base === 'vocab.json' || base === 'merges.txt') {
    return { category: 'tokenizer', requiredForInference: true };
  }
  if (base.endsWith('.int8.onnx')) {
    return { category: 'weights_int8', requiredForInference: true };
  }
  if (base.endsWith('.onnx')) {
    // Distinguish FP32 onnx when int8 exists; caller may refine per repo
    return { category: 'weights_fp32', requiredForInference: false };
  }
  if (base.endsWith('.safetensors') || base.endsWith('.bin') || base.endsWith('.pt') || base.endsWith('.nemo')) {
    return { category: 'weights_other', requiredForInference: true };
  }
  if (base.endsWith('.json') || base.endsWith('.yaml') || base.endsWith('.yml')) {
    return { category: 'config', requiredForInference: base.includes('config') };
  }
  if (base.endsWith('.py')) {
    return { category: 'script', requiredForInference: false };
  }
  if (base.endsWith('.wav') || base.endsWith('.mp3') || base.endsWith('.flac') || base.endsWith('.ogg')) {
    return { category: 'sample_audio', requiredForInference: false };
  }
  return { category: 'other', requiredForInference: false };
}

export interface HuggingFaceModelApiResponse {
  readonly id?: string;
  readonly sha?: string;
  readonly gated?: boolean | string;
  readonly cardData?: {
    readonly license?: string;
    readonly language?: string | string[];
    readonly base_model?: string | string[];
    readonly datasets?: string[];
  };
  readonly siblings?: readonly {
    readonly rfilename: string;
    readonly size?: number;
    readonly lfs?: {
      readonly size?: number;
      readonly sha256?: string;
      readonly oid?: string;
    };
  }[];
}

export class SHAHABHuggingFaceProvider {
  constructor(private readonly options: RemoteFetchOptions = {}) {}

  public async fetchModelMetadata(repoId: string): Promise<HuggingFaceModelApiResponse> {
    const cleanId = repoId.replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/$/, '');
    const url = `https://huggingface.co/api/models/${cleanId}?blobs=true`;
    const resp = await fetchWithResilience(url, { Accept: 'application/json' }, this.options);
    if (!resp.ok) {
      throw new ShahabRemoteFetchError(
        'HTTP_ERROR',
        `Hugging Face API returned HTTP ${resp.status} for ${cleanId}`,
        resp.status,
      );
    }
    return (await resp.json()) as HuggingFaceModelApiResponse;
  }

  public async fetchTextFile(repoId: string, revision: string, relativePath: string): Promise<string | null> {
    const cleanId = repoId.replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/$/, '');
    const url = `https://huggingface.co/${cleanId}/raw/${encodeURIComponent(revision)}/${relativePath}`;
    const resp = await fetchWithResilience(url, { Accept: 'text/plain' }, this.options);
    if (!resp.ok) return null;
    const text = await resp.text();
    return text.slice(0, 16_384);
  }
}

export interface GitHubRepoApiResponse {
  readonly full_name?: string;
  readonly default_branch?: string;
  readonly description?: string;
  readonly license?: { readonly spdx_id?: string; readonly name?: string } | null;
  readonly size?: number; // KiB
  readonly stargazers_count?: number;
}

export class SHAHABGitHubProvider {
  constructor(private readonly options: RemoteFetchOptions = {}) {}

  public async fetchRepoMetadata(repoId: string): Promise<GitHubRepoApiResponse> {
    const cleanId = repoId.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    const url = `https://api.github.com/repos/${cleanId}`;
    const resp = await fetchWithResilience(
      url,
      { Accept: 'application/vnd.github+json' },
      this.options,
    );
    if (!resp.ok) {
      throw new ShahabRemoteFetchError(
        'HTTP_ERROR',
        `GitHub API returned HTTP ${resp.status} for ${cleanId}`,
        resp.status,
      );
    }
    return (await resp.json()) as GitHubRepoApiResponse;
  }

  public async resolveBranchCommitSha(repoId: string, branch: string): Promise<string | null> {
    const cleanId = repoId.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    const url = `https://api.github.com/repos/${cleanId}/commits/${encodeURIComponent(branch)}`;
    const resp = await fetchWithResilience(
      url,
      { Accept: 'application/vnd.github+json' },
      this.options,
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { sha?: string };
    return isImmutableCommitSha(data.sha) ? data.sha! : null;
  }

  public async fetchRootContents(repoId: string, ref: string): Promise<readonly { name: string; path: string; size: number; type: string; download_url: string | null }[]> {
    const cleanId = repoId.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    const url = `https://api.github.com/repos/${cleanId}/contents?ref=${encodeURIComponent(ref)}`;
    const resp = await fetchWithResilience(
      url,
      { Accept: 'application/vnd.github+json' },
      this.options,
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as unknown;
    return Array.isArray(data) ? data : [];
  }

  public async fetchLicenseText(repoId: string): Promise<{ spdxId: string | null; excerpt: string | null }> {
    const cleanId = repoId.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    const url = `https://api.github.com/repos/${cleanId}/license`;
    const resp = await fetchWithResilience(
      url,
      { Accept: 'application/vnd.github+json' },
      this.options,
    );
    if (!resp.ok) return { spdxId: null, excerpt: null };
    const data = (await resp.json()) as {
      license?: { spdx_id?: string };
      content?: string;
      encoding?: string;
    };
    let excerpt: string | null = null;
    if (data.content && data.encoding === 'base64') {
      excerpt = Buffer.from(data.content.replace(/\n/g, ''), 'base64')
        .toString('utf-8')
        .slice(0, 600);
    }
    return {
      spdxId: data.license?.spdx_id ?? null,
      excerpt,
    };
  }
}

/**
 * Resolves mutable branch references (`main`, `master`) to immutable 40-char commit SHAs.
 */
export class SHAHABRevisionResolver {
  constructor(
    private readonly hf: SHAHABHuggingFaceProvider,
    private readonly gh: SHAHABGitHubProvider,
  ) {}

  public async resolveImmutableRevision(
    sourceKind: 'huggingface' | 'github',
    repoId: string,
    branchHint?: string,
  ): Promise<{ readonly branch: string | null; readonly commitSha: string | null; readonly verified: boolean }> {
    if (sourceKind === 'huggingface') {
      const meta = await this.hf.fetchModelMetadata(repoId);
      const sha = isImmutableCommitSha(meta.sha) ? meta.sha! : null;
      return { branch: branchHint ?? 'main', commitSha: sha, verified: sha !== null };
    }
    const meta = await this.gh.fetchRepoMetadata(repoId);
    const branch = branchHint ?? meta.default_branch ?? 'main';
    const sha = await this.gh.resolveBranchCommitSha(repoId, branch);
    return { branch, commitSha: sha, verified: sha !== null };
  }
}

/**
 * Builds file manifests strictly from remote metadata APIs (zero file downloads).
 */
export class SHAHABRemoteFileInspector {
  public inspectHuggingFaceFiles(
    repoId: string,
    revisionSha: string,
    siblings: HuggingFaceModelApiResponse['siblings'],
  ): {
    readonly files: ShahabRemoteFileEntry[];
    readonly totalRepoBytes: number | null;
    readonly selectedInferencePackageBytes: number | null;
    readonly hasStandaloneLicenseFile: boolean;
  } {
    if (!Array.isArray(siblings) || siblings.length === 0) {
      return {
        files: [],
        totalRepoBytes: null,
        selectedInferencePackageBytes: null,
        hasStandaloneLicenseFile: false,
      };
    }

    const hasInt8Variants = siblings.some((s) => s.rfilename.toLowerCase().endsWith('.int8.onnx'));
    const files: ShahabRemoteFileEntry[] = [];
    let totalRepoBytes = 0;
    let knownTotalCount = 0;
    let selectedInferenceBytes = 0;
    let knownSelectedCount = 0;
    let hasStandaloneLicenseFile = false;

    for (const s of siblings) {
      const sizeBytes =
        typeof s.lfs?.size === 'number'
          ? s.lfs.size
          : typeof s.size === 'number'
            ? s.size
            : null;
      const sha256LfsOid =
        typeof s.lfs?.sha256 === 'string'
          ? s.lfs.sha256
          : typeof s.lfs?.oid === 'string'
            ? s.lfs.oid
            : null;

      const classified = classifyRemoteFile(s.rfilename);
      // If repository contains both FP32 and INT8 ONNX files (like Persian Zipformer),
      // mark ONLY INT8 + tokens + tokenizer/config + license as requiredForInference
      const requiredForInference =
        classified.category === 'weights_fp32' && hasInt8Variants
          ? false
          : classified.requiredForInference;

      if (classified.category === 'license') {
        hasStandaloneLicenseFile = true;
      }

      if (sizeBytes !== null) {
        totalRepoBytes += sizeBytes;
        knownTotalCount++;
        if (requiredForInference) {
          selectedInferenceBytes += sizeBytes;
          knownSelectedCount++;
        }
      }

      files.push({
        path: s.rfilename,
        sizeBytes,
        sha256LfsOid,
        downloadUrl: `https://huggingface.co/${repoId}/resolve/${revisionSha}/${s.rfilename}`,
        category: classified.category,
        requiredForInference,
      });
    }

    return {
      files,
      totalRepoBytes: knownTotalCount > 0 ? totalRepoBytes : null,
      selectedInferencePackageBytes: knownSelectedCount > 0 ? selectedInferenceBytes : null,
      hasStandaloneLicenseFile,
    };
  }
}

export interface TargetRepositorySpec {
  readonly candidateId: string;
  readonly displayName: string;
  readonly sourceKind: 'huggingface' | 'github';
  readonly repoId: string;
  readonly architecture: string;
  readonly modelFamily: string;
  readonly reportedParamsFromCardHint: string | null;
  readonly supportedRuntimes: readonly string[];
  readonly audioConfig: {
    readonly sampleRateHz: number | null;
    readonly channels: number | null;
    readonly featureDim: number | null;
    readonly note: string;
  };
  readonly requiresLegalGate?: boolean;
  readonly legalGateNote?: string;
}

export const SHAHAB_TARGET_REPOSITORIES: readonly TargetRepositorySpec[] = Object.freeze([
  {
    candidateId: 'persian-zipformer-asr',
    displayName: 'Persian Zipformer-Transducer ASR (ramin-mahmoodi)',
    sourceKind: 'huggingface',
    repoId: 'ramin-mahmoodi/persian-zipformer-asr',
    architecture: 'pruned_transducer_stateless7 (Zipformer2-Transducer)',
    modelFamily: 'Zipformer-Transducer (k2-fsa / icefall)',
    reportedParamsFromCardHint: '~65.3M (publisher README)',
    supportedRuntimes: ['sherpa-onnx', 'onnxruntime-web (WASM/CPU)', 'onnxruntime-node/cpu'],
    audioConfig: {
      sampleRateHz: 16000,
      channels: 1,
      featureDim: 80,
      note: '16kHz mono, 80-dim Kaldi log-mel FBANK (25ms window, 10ms hop), 1024 BPE tokens.',
    },
  },
  {
    candidateId: 'sherpa-onnx',
    displayName: 'k2-fsa/sherpa-onnx (Runtime & Inference Ecosystem)',
    sourceKind: 'github',
    repoId: 'k2-fsa/sherpa-onnx',
    architecture: 'Multi-architecture ONNX Speech Runtime (Transducer/CTC/Whisper/VAD)',
    modelFamily: 'Runtime Framework',
    reportedParamsFromCardHint: null,
    supportedRuntimes: ['C++', 'Python', 'Node.js', 'WebAssembly', 'Android', 'iOS'],
    audioConfig: {
      sampleRateHz: 16000,
      channels: 1,
      featureDim: 80,
      note: 'Reference C++/WASM kaldi-native-fbank + offline/online transducer decoding.',
    },
  },
  {
    candidateId: 'icefall',
    displayName: 'k2-fsa/icefall (Zipformer / Transducer Training & Export Recipes)',
    sourceKind: 'github',
    repoId: 'k2-fsa/icefall',
    architecture: 'pruned_transducer_stateless7 / Zipformer2 Reference Code',
    modelFamily: 'Training & Export Framework',
    reportedParamsFromCardHint: null,
    supportedRuntimes: ['PyTorch', 'k2', 'ONNX Export'],
    audioConfig: {
      sampleRateHz: 16000,
      channels: 1,
      featureDim: 80,
      note: 'Reference Zipformer2 encoder/decoder/joiner definitions & ONNX export scripts.',
    },
  },
  {
    candidateId: 'taraneh-persian-asr-repo',
    displayName: 'areffarhadi/persian-asr (Taraneh Persian ASR Codebase)',
    sourceKind: 'github',
    repoId: 'areffarhadi/persian-asr',
    architecture: 'Persian ASR Inference / Evaluation Suite (Taraneh)',
    modelFamily: 'Persian ASR Suite',
    reportedParamsFromCardHint: null,
    supportedRuntimes: ['PyTorch', 'Transformers'],
    audioConfig: {
      sampleRateHz: 16000,
      channels: 1,
      featureDim: null,
      note: 'Repository codebase for Taraneh Qwen/Whisper Persian ASR checkpoints.',
    },
  },
  {
    candidateId: 'qwen3-asr-repo',
    displayName: 'QwenLM/Qwen3-ASR (Upstream Multimodal ASR)',
    sourceKind: 'github',
    repoId: 'QwenLM/Qwen3-ASR',
    architecture: 'Qwen3-ASR Transformer Audio-LM',
    modelFamily: 'Qwen3-ASR',
    reportedParamsFromCardHint: '0.6B / 1.7B family (upstream repo)',
    supportedRuntimes: ['PyTorch', 'vLLM', 'Transformers (GPU-oriented)'],
    audioConfig: {
      sampleRateHz: 16000,
      channels: 1,
      featureDim: 128,
      note: 'Heavy LLM-backed ASR architecture; exceeds local browser WASM & lightweight CPU footprint.',
    },
  },
  {
    candidateId: 'taraneh-q06b',
    displayName: 'areffarhadi/Taraneh-Q0.6B',
    sourceKind: 'huggingface',
    repoId: 'areffarhadi/Taraneh-Q0.6B',
    architecture: 'Qwen3-ASR 0.6B Fine-Tuned Persian',
    modelFamily: 'Taraneh / Qwen3-ASR',
    reportedParamsFromCardHint: '~0.6B (repository naming / card)',
    supportedRuntimes: ['PyTorch', 'Transformers (GPU/Heavy CPU)'],
    audioConfig: {
      sampleRateHz: 16000,
      channels: 1,
      featureDim: 128,
      note: 'PyTorch safetensors weights (~1.5+ GB); no ready ONNX INT8 browser/edge bundle.',
    },
  },
  {
    candidateId: 'taraneh-q17b',
    displayName: 'areffarhadi/Taraneh-Q1.7B',
    sourceKind: 'huggingface',
    repoId: 'areffarhadi/Taraneh-Q1.7B',
    architecture: 'Qwen3-ASR 1.7B Fine-Tuned Persian',
    modelFamily: 'Taraneh / Qwen3-ASR',
    reportedParamsFromCardHint: '~1.7B (repository naming / card)',
    supportedRuntimes: ['PyTorch', 'Transformers (GPU-oriented)'],
    audioConfig: {
      sampleRateHz: 16000,
      channels: 1,
      featureDim: 128,
      note: 'Multi-gigabyte PyTorch safetensors checkpoint; unsuitable for lightweight local CPU/WASM core.',
    },
  },
  {
    candidateId: 'taraneh-wlarge',
    displayName: 'areffarhadi/Taraneh-WLarge',
    sourceKind: 'huggingface',
    repoId: 'areffarhadi/Taraneh-WLarge',
    architecture: 'Whisper-Large Fine-Tuned Persian (Seq2Seq)',
    modelFamily: 'Taraneh / Whisper',
    reportedParamsFromCardHint: '~1.55B (Whisper-large architecture)',
    supportedRuntimes: ['PyTorch', 'Transformers', 'CTranslate2/ONNX after export'],
    audioConfig: {
      sampleRateHz: 16000,
      channels: 1,
      featureDim: 128,
      note: 'Large non-streaming encoder-decoder checkpoint; exceeds local browser memory ceiling.',
    },
  },
  {
    candidateId: 'nemotron-asr-streaming-farsi',
    displayName: 'mehdi-hf/nemotron-asr-streaming-farsi',
    sourceKind: 'huggingface',
    repoId: 'mehdi-hf/nemotron-asr-streaming-farsi',
    architecture: 'NeMo Cache-Aware FastConformer / Nemotron Streaming Farsi',
    modelFamily: 'NVIDIA Nemotron / NeMo',
    reportedParamsFromCardHint: 'NOT_MEASURED (subject to legal gate)',
    supportedRuntimes: ['NVIDIA NeMo', 'ONNX (after legal clearance)'],
    audioConfig: {
      sampleRateHz: 16000,
      channels: 1,
      featureDim: 80,
      note: 'Streaming NeMo candidate; strictly gated pending NVIDIA/model license clearance.',
    },
    requiresLegalGate: true,
    legalGateNote:
      'LEGAL_GATE_REQUIRED: License is "other"/NVIDIA-derived. Do NOT download weights or use outputs as commercial distillation targets without explicit legal clearance (SHAHAB-003 §1 & §6).',
  },
]);

/**
 * Orchestrates metadata-only discovery across all 9 SHAHAB-003 repositories,
 * produces candidate records with pinned commit SHAs, and builds the third-party
 * source-code reuse inventory (sherpa-onnx & icefall).
 */
export class SHAHABRepositoryResolver {
  public readonly hf: SHAHABHuggingFaceProvider;
  public readonly gh: SHAHABGitHubProvider;
  public readonly revisionResolver: SHAHABRevisionResolver;
  public readonly fileInspector: SHAHABRemoteFileInspector;

  constructor(options: RemoteFetchOptions = {}) {
    this.hf = new SHAHABHuggingFaceProvider(options);
    this.gh = new SHAHABGitHubProvider(options);
    this.revisionResolver = new SHAHABRevisionResolver(this.hf, this.gh);
    this.fileInspector = new SHAHABRemoteFileInspector();
  }

  public async inspectTarget(
    spec: TargetRepositorySpec,
    environmentId: string,
  ): Promise<ShahabCandidateModelRecord> {
    const nowUtc = new Date().toISOString();
    const upstreamUrl =
      spec.sourceKind === 'huggingface'
        ? `https://huggingface.co/${spec.repoId}`
        : `https://github.com/${spec.repoId}`;

    try {
      if (spec.sourceKind === 'huggingface') {
        const meta = await this.hf.fetchModelMetadata(spec.repoId);
        const sha = isImmutableCommitSha(meta.sha) ? meta.sha! : null;
        const inspected = this.fileInspector.inspectHuggingFaceFiles(
          spec.repoId,
          sha ?? 'main',
          meta.siblings,
        );
        const rawLicense = meta.cardData?.license ?? null;
        const licenseSpdx =
          rawLicense === 'apache-2.0'
            ? 'Apache-2.0'
            : rawLicense === 'mit'
              ? 'MIT'
              : rawLicense;

        let licenseTextExcerpt: string | null = null;
        const licFile = inspected.files.find((f) => f.category === 'license');
        if (licFile && sha) {
          licenseTextExcerpt = (await this.hf.fetchTextFile(spec.repoId, sha, licFile.path))?.slice(0, 500) ?? null;
        }

        let licenseStatus: ShahabCandidateModelRecord['licenseStatus'] = 'MISSING_OR_AMBIGUOUS';
        let legalGateNote = 'License metadata missing or unverified.';
        if (spec.requiresLegalGate || rawLicense === 'other') {
          licenseStatus = 'LEGAL_GATE_REQUIRED';
          legalGateNote =
            spec.legalGateNote ??
            'License declared as "other"; requires manual legal review before artifact use or distillation.';
        } else if (licenseSpdx === 'Apache-2.0' || licenseSpdx === 'MIT') {
          licenseStatus = inspected.hasStandaloneLicenseFile
            ? 'PERMISSIVE_CLEAR'
            : 'PERMISSIVE_NO_STANDALONE_FILE';
          legalGateNote = inspected.hasStandaloneLicenseFile
            ? `Permissive ${licenseSpdx} license verified with standalone license file in repository.`
            : `Permissive ${licenseSpdx} declared in README/card metadata, but standalone LICENSE file is absent at pinned commit ${sha ?? 'unknown'}.`;
        }

        const limitations: string[] = [];
        if (!inspected.hasStandaloneLicenseFile) {
          limitations.push('Upstream repository omits standalone LICENSE file (declared in README/card only).');
        }
        if (spec.requiresLegalGate) {
          limitations.push('Blocked behind SHAHAB-003 legal-use gate; weights not acquired.');
        }
        if (inspected.files.some((f) => f.category === 'weights_fp32') && inspected.files.some((f) => f.category === 'weights_int8')) {
          limitations.push('Contains both FP32 and INT8 ONNX graphs; FP32 weights excluded from minimum inference package.');
        }

        return {
          candidateId: spec.candidateId,
          displayName: spec.displayName,
          sourceKind: 'huggingface',
          repoId: spec.repoId,
          upstreamUrl,
          defaultBranch: 'main',
          pinnedRevisionSha: sha,
          revisionStatus: sha ? 'VERIFIED' : 'BLOCKED',
          architecture: spec.architecture,
          modelFamily: spec.modelFamily,
          reportedParameters: {
            value: spec.reportedParamsFromCardHint,
            unit: 'parameters',
            method: 'upstream_model_card_metadata',
            source: upstreamUrl,
            timestampUtc: nowUtc,
            environment: environmentId,
            status: spec.reportedParamsFromCardHint ? 'REPORTED' : 'NOT_MEASURED',
          },
          licenseSpdx,
          licenseFilePresent: inspected.hasStandaloneLicenseFile,
          licenseTextExcerpt,
          licenseStatus,
          legalGateNote,
          totalRepositoryBytes: inspected.totalRepoBytes,
          selectedInferencePackageBytes: inspected.selectedInferencePackageBytes,
          fileCount: inspected.files.length,
          files: inspected.files,
          supportedRuntimes: spec.supportedRuntimes,
          audioConfig: spec.audioConfig,
          knownLimitations: limitations,
          inspectedAtUtc: nowUtc,
          inspectionStatus: 'REPORTED',
        };
      }

      // GitHub repository metadata inspection
      const meta = await this.gh.fetchRepoMetadata(spec.repoId);
      const branch = meta.default_branch ?? 'main';
      const sha = await this.gh.resolveBranchCommitSha(spec.repoId, branch);
      const lic = await this.gh.fetchLicenseText(spec.repoId);
      const rootItems = sha ? await this.gh.fetchRootContents(spec.repoId, sha) : [];
      const files: ShahabRemoteFileEntry[] = rootItems.slice(0, 40).map((item) => {
        const cls = classifyRemoteFile(item.path);
        return {
          path: item.path,
          sizeBytes: item.type === 'file' ? item.size : null,
          sha256LfsOid: null,
          downloadUrl: item.download_url ?? `${upstreamUrl}/blob/${sha ?? branch}/${item.path}`,
          category: cls.category,
          requiredForInference: false,
        };
      });

      const licenseSpdx = lic.spdxId ?? meta.license?.spdx_id ?? null;
      const hasLicFile = Boolean(lic.excerpt || rootItems.some((f) => /^license/i.test(f.name)));
      const licenseStatus: ShahabCandidateModelRecord['licenseStatus'] =
        licenseSpdx === 'Apache-2.0' || licenseSpdx === 'MIT' || licenseSpdx === 'BSD-3-Clause'
          ? hasLicFile
            ? 'PERMISSIVE_CLEAR'
            : 'PERMISSIVE_NO_STANDALONE_FILE'
          : 'MISSING_OR_AMBIGUOUS';

      return {
        candidateId: spec.candidateId,
        displayName: spec.displayName,
        sourceKind: 'github',
        repoId: spec.repoId,
        upstreamUrl,
        defaultBranch: branch,
        pinnedRevisionSha: sha,
        revisionStatus: sha ? 'VERIFIED' : 'BLOCKED',
        architecture: spec.architecture,
        modelFamily: spec.modelFamily,
        reportedParameters: {
          value: spec.reportedParamsFromCardHint,
          unit: 'parameters',
          method: 'upstream_github_metadata',
          source: upstreamUrl,
          timestampUtc: nowUtc,
          environment: environmentId,
          status: spec.reportedParamsFromCardHint ? 'REPORTED' : 'NOT_MEASURED',
        },
        licenseSpdx,
        licenseFilePresent: hasLicFile,
        licenseTextExcerpt: lic.excerpt,
        licenseStatus,
        legalGateNote:
          licenseStatus === 'PERMISSIVE_CLEAR'
            ? `Permissive ${licenseSpdx} license verified via GitHub /license endpoint.`
            : 'License file absent or undeclared via GitHub API; treat source code reuse as restricted until verified.',
        totalRepositoryBytes: typeof meta.size === 'number' ? meta.size * 1024 : null,
        selectedInferencePackageBytes: null,
        fileCount: files.length,
        files,
        supportedRuntimes: spec.supportedRuntimes,
        audioConfig: spec.audioConfig,
        knownLimitations:
          licenseStatus === 'MISSING_OR_AMBIGUOUS'
            ? ['GitHub repository has no detected SPDX license file; do not copy code into SHAHAB.']
            : ['Source repository inspected remotely only; not cloned into workspace.'],
        inspectedAtUtc: nowUtc,
        inspectionStatus: 'REPORTED',
      };
    } catch (err) {
      return {
        candidateId: spec.candidateId,
        displayName: spec.displayName,
        sourceKind: spec.sourceKind,
        repoId: spec.repoId,
        upstreamUrl,
        defaultBranch: null,
        pinnedRevisionSha: null,
        revisionStatus: 'BLOCKED',
        architecture: spec.architecture,
        modelFamily: spec.modelFamily,
        reportedParameters: {
          value: null,
          unit: 'parameters',
          method: 'remote_api_failed',
          source: upstreamUrl,
          timestampUtc: nowUtc,
          environment: environmentId,
          status: 'BLOCKED',
        },
        licenseSpdx: null,
        licenseFilePresent: false,
        licenseTextExcerpt: null,
        licenseStatus: spec.requiresLegalGate ? 'LEGAL_GATE_REQUIRED' : 'MISSING_OR_AMBIGUOUS',
        legalGateNote: `Remote inspection failed: ${err instanceof Error ? err.message : String(err)}`,
        totalRepositoryBytes: null,
        selectedInferencePackageBytes: null,
        fileCount: null,
        files: [],
        supportedRuntimes: spec.supportedRuntimes,
        audioConfig: spec.audioConfig,
        knownLimitations: [`Remote fetch error: ${err instanceof Error ? err.message : String(err)}`],
        inspectedAtUtc: nowUtc,
        inspectionStatus: 'BLOCKED',
      };
    }
  }

  public async discoverAllTargets(environmentId: string): Promise<{
    readonly candidates: ShahabCandidateModelRecord[];
    readonly thirdPartyReuseInventory: ShahabThirdPartyReuseItem[];
  }> {
    const candidates: ShahabCandidateModelRecord[] = [];
    for (const spec of SHAHAB_TARGET_REPOSITORIES) {
      candidates.push(await this.inspectTarget(spec, environmentId));
    }

    const sherpa = candidates.find((c) => c.candidateId === 'sherpa-onnx');
    const icefall = candidates.find((c) => c.candidateId === 'icefall');

    const thirdPartyReuseInventory: ShahabThirdPartyReuseItem[] = [
      {
        componentId: 'sherpa-onnx-transducer-spec',
        upstreamRepo: 'k2-fsa/sherpa-onnx',
        pinnedCommitSha: sherpa?.pinnedRevisionSha ?? null,
        licenseSpdx: sherpa?.licenseSpdx ?? 'Apache-2.0',
        targetPathOrModule: 'sherpa-onnx/csrc/offline-transducer-model.cc & offline-transducer-modified-beam-search-decoder.cc',
        reuseCategory: 'transducer_inference',
        technicalFeasibility: 'NARROW_ADAPTATION',
        copyrightAndNoticeObligation: 'Apache-2.0 — retain copyright notice and license attribution in NOTICE.',
        assessmentNote:
          'Defines exact stateless7 3-graph contract (encoder x/x_lens -> encoder_out; decoder y[N,2] -> decoder_out; joiner -> logit[N,1024]) and modified beam search algorithm.',
      },
      {
        componentId: 'sherpa-onnx-kaldi-fbank',
        upstreamRepo: 'k2-fsa/sherpa-onnx',
        pinnedCommitSha: sherpa?.pinnedRevisionSha ?? null,
        licenseSpdx: sherpa?.licenseSpdx ?? 'Apache-2.0',
        targetPathOrModule: 'kaldi-native-fbank (16kHz, 80-bin, Povey window 25ms/10ms, pre-emph 0.97)',
        reuseCategory: 'runtime_integration',
        technicalFeasibility: 'NARROW_ADAPTATION',
        copyrightAndNoticeObligation: 'Apache-2.0 — preserve attribution for Kaldi-compatible FBANK feature specification.',
        assessmentNote:
          'SHAHAB implements pure TypeScript Kaldi-compatible 80-bin FBANK matching sherpa-onnx defaults so both Browser WASM and Node runtimes run identically without native binary dependency.',
      },
      {
        componentId: 'sherpa-onnx-native-binary',
        upstreamRepo: 'k2-fsa/sherpa-onnx',
        pinnedCommitSha: sherpa?.pinnedRevisionSha ?? null,
        licenseSpdx: sherpa?.licenseSpdx ?? 'Apache-2.0',
        targetPathOrModule: 'sherpa-onnx-offline / sherpa-onnx-node',
        reuseCategory: 'language_bindings',
        technicalFeasibility: 'DIRECT_DEPENDENCY',
        copyrightAndNoticeObligation: 'Apache-2.0 — ship unmodified LICENSE & NOTICE with desktop Companion installer.',
        assessmentNote:
          'Recommended pinned native runtime for Desktop Companion on macOS/Windows/Linux; absent in current Linux sandbox container, where onnxruntime-web WASM provides verified local execution.',
      },
      {
        componentId: 'sherpa-onnx-vad',
        upstreamRepo: 'k2-fsa/sherpa-onnx',
        pinnedCommitSha: sherpa?.pinnedRevisionSha ?? null,
        licenseSpdx: sherpa?.licenseSpdx ?? 'Apache-2.0',
        targetPathOrModule: 'sherpa-onnx Silero-VAD interface',
        reuseCategory: 'vad',
        technicalFeasibility: 'REFERENCE_ONLY',
        copyrightAndNoticeObligation: 'Apache-2.0 / MIT (Silero VAD).',
        assessmentNote:
          'Avapardaz already provides SileroVadOnnxRunner; SHAHAB reuses existing Avapardaz VAD/audio profiler rather than duplicating.',
      },
      {
        componentId: 'icefall-stateless7-recipe',
        upstreamRepo: 'k2-fsa/icefall',
        pinnedCommitSha: icefall?.pinnedRevisionSha ?? null,
        licenseSpdx: icefall?.licenseSpdx ?? 'Apache-2.0',
        targetPathOrModule: 'egs/librispeech/ASR/pruned_transducer_stateless7/export-onnx.py',
        reuseCategory: 'model_loading',
        technicalFeasibility: 'REFERENCE_ONLY',
        copyrightAndNoticeObligation: 'Apache-2.0 — reference specification only; zero code copied.',
        assessmentNote:
          'Confirms Zipformer2 subsampling factor (4x on 10ms frames = 40ms encoder frame stride), context_size=2, and blank_id=0.',
      },
      {
        componentId: 'icefall-streaming-cache-layout',
        upstreamRepo: 'k2-fsa/icefall',
        pinnedCommitSha: icefall?.pinnedRevisionSha ?? null,
        licenseSpdx: icefall?.licenseSpdx ?? 'Apache-2.0',
        targetPathOrModule: 'pruned_transducer_stateless7_streaming (cached_len / cached_avg / cached_key / cached_val / cached_conv)',
        reuseCategory: 'streaming_state',
        technicalFeasibility: 'REFERENCE_ONLY',
        copyrightAndNoticeObligation: 'Apache-2.0 — reference only.',
        assessmentNote:
          'Verified that acquired persian-zipformer-asr encoder.int8.onnx is an OFFLINE stateless7 graph (inputs: x, x_lens only — no cached_key/cached_conv inputs), so true chunked streaming state is NOT supported by this exported graph; SHAHABStreamingStateCache records this explicitly.',
      },
    ];

    return { candidates, thirdPartyReuseInventory };
  }
}
