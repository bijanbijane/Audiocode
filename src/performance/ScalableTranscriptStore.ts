/**
 * Scalable Large-Transcript Store with Structural Sharing, Persian-Safe Indexed Search & Incremental Persistence
 * (AVP-P11-001 Section 5)
 * - Local edits update ONLY the affected segment/token (O(1) reference swap, zero full-transcript cloning).
 * - Preserves immutable raw ASR text separately from normalized and user-corrected text.
 * - Preserves Persian ZWNJ (\u200c), Arabic/Persian character distinctions, punctuation, and code-switching.
 * - Cancels stale async searches via monotonic generation counter so old results never overwrite newer ones.
 */

export interface ScalableTranscriptToken {
  readonly tokenId: string;
  readonly segmentId: string;
  readonly startSample: number;
  readonly endSample: number;
  readonly verbatimText: string;
  readonly normalizedText: string;
  readonly userCorrectedText: string;
  readonly alignmentMethod: 'FORCED_ALIGNED' | 'ASR_TIMESTAMP' | 'APPROXIMATE' | 'UNALIGNED';
}

export interface TranscriptRangePatch {
  readonly patchId: string;
  readonly version: number;
  readonly tokenId: string;
  readonly previousUserText: string;
  readonly nextUserText: string;
  readonly timestampMs: number;
}

export interface IncrementalSearchResult {
  readonly queryId: number;
  readonly query: string;
  readonly cancelled: boolean;
  readonly matchedTokenIds: readonly string[];
}

export interface IncrementalPersistenceDelta {
  readonly version: number;
  readonly committed: boolean;
  readonly dirtyTokenIds: readonly string[];
  readonly changedTokens: readonly ScalableTranscriptToken[];
}

/**
 * Generates Persian-safe search tokens while keeping ZWNJ intact in verbatim/display layers
 * and also indexing a folded matching key for real-world Persian/Arabic input ergonomics.
 */
function buildSearchKeysForWord(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const folded = lower
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u064b-\u065f\u0670]/g, '');
  const keys = new Set<string>([lower, folded]);
  // Also index ZWNJ-split sub-parts for prefix queries without losing exact ZWNJ matching
  if (folded.includes('\u200c')) {
    for (const part of folded.split('\u200c')) {
      if (part.length >= 2) keys.add(part);
    }
  }
  // 2-char prefix keys for O(k) lookup without scanning all tokens
  const prefixes = new Set<string>();
  for (const k of keys) {
    if (k.length >= 2) prefixes.add(k.slice(0, 2));
    prefixes.add(k);
  }
  return Array.from(prefixes);
}

export class ScalableTranscriptStore {
  private readonly orderedIds: string[] = [];
  private readonly tokensById = new Map<string, ScalableTranscriptToken>();
  private readonly prefixIndex = new Map<string, Set<string>>();
  private readonly dirtyIds = new Set<string>();
  private readonly undoStack: TranscriptRangePatch[] = [];
  private readonly redoStack: TranscriptRangePatch[] = [];

  private version = 1;
  private patchSeq = 0;
  private searchGeneration = 0;
  private fullCloneCount = 0;

  constructor(initialTokens: readonly ScalableTranscriptToken[] = []) {
    for (const tok of initialTokens) {
      this.orderedIds.push(tok.tokenId);
      this.tokensById.set(tok.tokenId, tok);
      this.indexToken(tok);
    }
  }

  public getVersion(): number {
    return this.version;
  }

  public getTokenCount(): number {
    return this.orderedIds.length;
  }

  public getTokenById(tokenId: string): ScalableTranscriptToken | null {
    return this.tokensById.get(tokenId) ?? null;
  }

  public getTokenAtIndex(index: number): ScalableTranscriptToken | null {
    const id = this.orderedIds[index];
    return id ? (this.tokensById.get(id) ?? null) : null;
  }

  /** Virtualized range slice — O(windowSize), never clones full transcript */
  public getVisibleSlice(startIndex: number, endIndexExclusive: number): readonly ScalableTranscriptToken[] {
    const start = Math.max(0, startIndex);
    const end = Math.min(this.orderedIds.length, endIndexExclusive);
    const slice: ScalableTranscriptToken[] = [];
    for (let i = start; i < end; i += 1) {
      const tok = this.tokensById.get(this.orderedIds[i]);
      if (tok) slice.push(tok);
    }
    return slice;
  }

  /**
   * Local O(1) edit updating ONLY the target token while preserving immutable verbatimText
   * and original sample coordinates. Never clones unaffected tokens.
   */
  public editTokenUserText(tokenId: string, nextUserText: string): TranscriptRangePatch | null {
    const existing = this.tokensById.get(tokenId);
    if (!existing) return null;
    if (existing.userCorrectedText === nextUserText) return null;

    this.deindexToken(existing);
    const updated: ScalableTranscriptToken = {
      ...existing,
      // verbatimText, startSample, endSample remain strictly untouched
      userCorrectedText: nextUserText,
    };
    this.tokensById.set(tokenId, updated);
    this.indexToken(updated);

    this.version += 1;
    this.patchSeq += 1;
    const patch: TranscriptRangePatch = {
      patchId: `tpatch_${this.patchSeq}`,
      version: this.version,
      tokenId,
      previousUserText: existing.userCorrectedText,
      nextUserText,
      timestampMs: Date.now(),
    };
    this.undoStack.push(patch);
    this.redoStack.length = 0;
    this.dirtyIds.add(tokenId);
    return patch;
  }

  public undo(): boolean {
    const patch = this.undoStack.pop();
    if (!patch) return false;
    const existing = this.tokensById.get(patch.tokenId);
    if (!existing) return false;

    this.deindexToken(existing);
    const restored: ScalableTranscriptToken = {
      ...existing,
      userCorrectedText: patch.previousUserText,
    };
    this.tokensById.set(patch.tokenId, restored);
    this.indexToken(restored);
    this.version += 1;
    this.dirtyIds.add(patch.tokenId);
    this.redoStack.push(patch);
    return true;
  }

  public redo(): boolean {
    const patch = this.redoStack.pop();
    if (!patch) return false;
    const existing = this.tokensById.get(patch.tokenId);
    if (!existing) return false;

    this.deindexToken(existing);
    const reapplied: ScalableTranscriptToken = {
      ...existing,
      userCorrectedText: patch.nextUserText,
    };
    this.tokensById.set(patch.tokenId, reapplied);
    this.indexToken(reapplied);
    this.version += 1;
    this.dirtyIds.add(patch.tokenId);
    this.undoStack.push(patch);
    return true;
  }

  /**
   * Indexed synchronous lookup using the 2-char/token prefix index.
   */
  public searchIndexedSync(query: string): readonly string[] {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    const folded = trimmed.replace(/ي/g, 'ی').replace(/ك/g, 'ک');
    const lookupKey = folded.length >= 2 ? folded.slice(0, 2) : folded;
    const candidates = this.prefixIndex.get(lookupKey) ?? this.prefixIndex.get(folded);
    if (!candidates || candidates.size === 0) return [];

    const matches: string[] = [];
    for (const id of candidates) {
      const tok = this.tokensById.get(id);
      if (!tok) continue;
      const hayRaw = tok.verbatimText.toLowerCase();
      const hayUser = tok.userCorrectedText.toLowerCase();
      const hayFold = hayUser.replace(/ي/g, 'ی').replace(/ك/g, 'ک');
      if (hayRaw.includes(trimmed) || hayUser.includes(trimmed) || hayFold.includes(folded)) {
        matches.push(id);
      }
    }
    return matches;
  }

  /**
   * Incremental async cancellable search: automatically cancels any older in-flight search
   * and guarantees stale search results can never overwrite a newer query.
   */
  public async searchIncrementalAsync(
    query: string,
    options?: { readonly yieldEvery?: number; readonly delayStepMs?: number },
  ): Promise<IncrementalSearchResult> {
    const myGen = ++this.searchGeneration;
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return { queryId: myGen, query, cancelled: false, matchedTokenIds: [] };
    }

    const folded = trimmed.replace(/ي/g, 'ی').replace(/ك/g, 'ک');
    const lookupKey = folded.length >= 2 ? folded.slice(0, 2) : folded;
    const candidateIds = Array.from(
      this.prefixIndex.get(lookupKey) ?? this.prefixIndex.get(folded) ?? [],
    );

    const rawYield = options?.yieldEvery ?? 250;
    const yieldEvery = Number.isFinite(rawYield) ? Math.max(25, Math.floor(rawYield)) : 250;
    const rawDelay = options?.delayStepMs ?? 0;
    const delayStepMs = Number.isFinite(rawDelay) ? Math.max(0, rawDelay) : 0;
    const matchedTokenIds: string[] = [];

    for (let i = 0; i < candidateIds.length; i += 1) {
      if (this.searchGeneration !== myGen) {
        return { queryId: myGen, query, cancelled: true, matchedTokenIds: [] };
      }
      const id = candidateIds[i];
      const tok = this.tokensById.get(id);
      if (tok) {
        const hayRaw = tok.verbatimText.toLowerCase();
        const hayUser = tok.userCorrectedText.toLowerCase();
        const hayFold = hayUser.replace(/ي/g, 'ی').replace(/ك/g, 'ک');
        if (hayRaw.includes(trimmed) || hayUser.includes(trimmed) || hayFold.includes(folded)) {
          matchedTokenIds.push(id);
        }
      }
      if ((i + 1) % yieldEvery === 0) {
        await new Promise((r) => setTimeout(r, delayStepMs));
      }
    }

    if (this.searchGeneration !== myGen) {
      return { queryId: myGen, query, cancelled: true, matchedTokenIds: [] };
    }
    return { queryId: myGen, query, cancelled: false, matchedTokenIds };
  }

  /**
   * Produces a bounded incremental persistence delta containing ONLY dirty tokens
   * without serializing the entire transcript after every edit.
   */
  public buildIncrementalPersistenceDelta(): IncrementalPersistenceDelta {
    const dirtyTokenIds = Array.from(this.dirtyIds);
    const changedTokens: ScalableTranscriptToken[] = [];
    for (const id of dirtyTokenIds) {
      const tok = this.tokensById.get(id);
      if (tok) changedTokens.push(tok);
    }
    return {
      version: this.version,
      committed: false,
      dirtyTokenIds,
      changedTokens,
    };
  }

  public markDeltaCommitted(committedTokenIds: readonly string[]): void {
    for (const id of committedTokenIds) {
      this.dirtyIds.delete(id);
    }
  }

  public getDirtyTokenCount(): number {
    return this.dirtyIds.size;
  }

  public getFullCloneCountForDiagnostics(): number {
    return this.fullCloneCount;
  }

  private indexToken(tok: ScalableTranscriptToken): void {
    const keys = new Set<string>([
      ...buildSearchKeysForWord(tok.verbatimText),
      ...buildSearchKeysForWord(tok.userCorrectedText),
    ]);
    for (const key of keys) {
      let bucket = this.prefixIndex.get(key);
      if (!bucket) {
        bucket = new Set<string>();
        this.prefixIndex.set(key, bucket);
      }
      bucket.add(tok.tokenId);
    }
  }

  private deindexToken(tok: ScalableTranscriptToken): void {
    const keys = new Set<string>([
      ...buildSearchKeysForWord(tok.verbatimText),
      ...buildSearchKeysForWord(tok.userCorrectedText),
    ]);
    for (const key of keys) {
      const bucket = this.prefixIndex.get(key);
      if (!bucket) continue;
      bucket.delete(tok.tokenId);
      if (bucket.size === 0) {
        this.prefixIndex.delete(key);
      }
    }
  }
}
