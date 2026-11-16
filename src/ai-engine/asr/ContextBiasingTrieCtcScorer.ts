import { PersianLanguageModelScorer } from './PersianCtcPrefixBeamSearchDecoder';
import { PersianTextNormalizer } from '../PersianTextNormalizer';
import { CustomPersianLexiconManager } from '../CustomPersianLexiconManager';

interface TrieNode {
  children: Map<string, TrieNode>;
  isEndOfHotword: boolean;
  boostWeight: number;
}

/**
 * Section 120: Context-Biasing Prefix Trie CTC Scorer (Contextual Shallow Fusion)
 * Guides CTC beam search toward domain proper nouns, brand names, and technical terms
 * while penalizing homophone misspellings without model retraining.
 */
export class ContextBiasingTrieCtcScorer implements PersianLanguageModelScorer {
  private readonly root: TrieNode = {
    children: new Map(),
    isEndOfHotword: false,
    boostWeight: 0,
  };
  private readonly hotwordSet = new Set<string>();
  private readonly phoneticSkeletonToHotword = new Map<string, string>();

  constructor(
    private readonly baseLanguageModel: PersianLanguageModelScorer,
    hotwords: { phrase: string; boostLogProb?: number }[] = [],
  ) {
    for (const hw of hotwords) {
      this.registerHotword(hw.phrase, hw.boostLogProb ?? 2.8);
    }
  }

  /**
   * 1. Register a domain proper noun or technical term into the prefix Trie
   */
  public registerHotword(rawPhrase: string, boostLogProb: number = 2.8): void {
    const words = PersianTextNormalizer.normalizeTokenText(rawPhrase)
      .split(/\s+/)
      .filter(Boolean);

    for (const word of words) {
      this.hotwordSet.add(word);
      const skel = CustomPersianLexiconManager.toPersianPhoneticSkeleton(word);
      this.phoneticSkeletonToHotword.set(skel, word);

      let node = this.root;
      for (const ch of word) {
        let next = node.children.get(ch);
        if (!next) {
          next = { children: new Map(), isEndOfHotword: false, boostWeight: 0 };
          node.children.set(ch, next);
        }
        node = next;
      }
      node.isEndOfHotword = true;
      node.boostWeight = Math.max(node.boostWeight, boostLogProb);
    }
  }

  /**
   * 2. Combined scoring: Base Persian LM + Prefix Trie Hotword Boost + Homophone Misspelling Penalty
   */
  public scoreWordTransitionLogProb(prevWord: string | null, currentWord: string): number {
    const baseScore = this.baseLanguageModel.scoreWordTransitionLogProb(
      prevWord,
      currentWord,
    );
    const normWord = PersianTextNormalizer.normalizeTokenText(currentWord);

    const exactBoost = this.lookupExactTrieBoost(normWord);
    if (exactBoost > 0) {
      return baseScore + exactBoost;
    }

    // Penalize homophone misspellings of registered hotwords (e.g. «تباتبایی» vs «طباطبایی»)
    const skel = CustomPersianLexiconManager.toPersianPhoneticSkeleton(normWord);
    const matchedHotword = this.phoneticSkeletonToHotword.get(skel);
    if (matchedHotword && matchedHotword !== normWord) {
      return baseScore - 1.25;
    }

    return baseScore;
  }

  public isKnownPersianWord(word: string): boolean {
    const norm = PersianTextNormalizer.normalizeTokenText(word);
    return this.hotwordSet.has(norm) || this.baseLanguageModel.isKnownPersianWord(norm);
  }

  /**
   * 3. Partial prefix depth bonus during character-by-character decoding
   */
  public getPartialPrefixDepthBonus(partialWord: string): number {
    let node = this.root;
    let depth = 0;
    for (const ch of partialWord) {
      const next = node.children.get(ch);
      if (!next) return 0;
      node = next;
      depth++;
    }
    return depth >= 2 ? 0.35 : 0;
  }

  private lookupExactTrieBoost(word: string): number {
    let node = this.root;
    for (const ch of word) {
      const next = node.children.get(ch);
      if (!next) return 0;
      node = next;
    }
    return node.isEndOfHotword ? node.boostWeight : 0;
  }
}
