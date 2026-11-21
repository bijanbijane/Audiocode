/**
 * AVAPARDAZ — PERSIAN LINGUISTIC QUALITY, EVIDENCE-BASED CORRECTION & LEXICAL FIDELITY SUITE
 * Missions: AVP-P0-009 (Persian Linguistic Fidelity),
 *           AVP-P0-010 (Evidence-Based Correction & 19 Adversarial Regression Cases),
 *           AVP-P0-012 (Lexical Fidelity, Proper-Noun Preservation & Indexed Domain Vocabulary)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySafePersianZwnjToken,
  buildCanonicalPersianTranscriptSegment,
  evaluatePersianTranscriptCorpus,
  formatDigitsByPolicy,
  normalizeUnicodeScriptAware,
} from './PersianLinguisticQualityEngine';
import {
  PERSIAN_ASR_ERROR_TAXONOMY_V1,
  HumanInTheLoopCorrectionLedger,
  RuleBasedPersianMorphologyInspector,
  computeCorrectionQualityMetrics,
  detectMeaningCriticalTokens,
  evaluateProposedCorrection,
  type CorrectionEvaluationCase,
} from './PersianEvidenceCorrectionEngine';
import {
  VersionedPersianVocabularyManager,
  analyzePersianLexicalFidelity,
} from './PersianLexicalDisambiguationEngine';

test('AVP-P0-009: deterministic script-aware Unicode/ZWNJ normalization, VERBATIM colloquial preservation, non-destructive punctuation, and alignment fidelity', () => {
  assert.equal(normalizeUnicodeScriptAware('كِتابـــهاي يار'), 'کتابهای یار');
  assert.equal(applySafePersianZwnjToken('میروم'), 'می\u200cروم');
  assert.equal(applySafePersianZwnjToken('نمی‌شود'), 'نمی\u200cشود');
  assert.equal(applySafePersianZwnjToken('میوه'), 'میوه');
  assert.equal(applySafePersianZwnjToken('کتابخانه'), 'کتابخانه');

  assert.equal(formatDigitsByPolicy('سال 1404 و ۲۵۰', 'PERSIAN_DIGITS'), 'سال ۱۴۰۴ و ۲۵۰');
  assert.equal(formatDigitsByPolicy('سال ۱۴۰۴ و 250', 'LATIN_DIGITS'), 'سال 1404 و 250');

  const verbatim = buildCanonicalPersianTranscriptSegment({
    segmentId: 'seg-v1',
    mode: 'VERBATIM',
    rawTokens: [
      { tokenId: 't1', text: 'من', startSec: 0.0, endSec: 0.2, providerConfidence: 0.94 },
      { tokenId: 't2', text: 'میخوام', startSec: 0.25, endSec: 0.6, providerConfidence: 0.91 },
      { tokenId: 't3', text: 'برم', startSec: 0.65, endSec: 0.9, providerConfidence: 0.93 },
    ],
  });
  assert.equal(verbatim.rawText, 'من میخوام برم');
  assert.equal(verbatim.normalizedText, 'من میخوام برم');

  const light = buildCanonicalPersianTranscriptSegment({
    segmentId: 'seg-l1',
    mode: 'LIGHT_NORMALIZED',
    enableNonDestructivePunctuation: true,
    rawTokens: [
      { tokenId: 't1', text: 'من', startSec: 0.0, endSec: 0.2 },
      { tokenId: 't2', text: 'می', startSec: 0.22, endSec: 0.35 },
      { tokenId: 't3', text: 'روم', startSec: 0.36, endSec: 0.65 },
      { tokenId: 't4', text: 'تهران', startSec: 1.5, endSec: 1.9 },
    ],
  });
  assert.equal(light.rawText, 'من می روم تهران');
  assert.ok(light.normalizedText.includes('می\u200cروم'));
  const joinedTok = light.alignedTokens.find((t) => t.normalizedText === 'می\u200cروم');
  assert.ok(joinedTok, 'Expected MANY_TO_ONE joined token for می‌روم');
  assert.equal(joinedTok.mappingKind, 'MANY_TO_ONE');
  assert.equal(joinedTok.alignmentStatus, 'APPROXIMATE_DERIVED');
  assert.deepEqual(joinedTok.sourceTokenIds, ['t2', 't3']);
  assert.equal(joinedTok.providerConfidence, undefined);
  assert.ok(light.punctuationAnnotations.length >= 1);

  const emptyReport = evaluatePersianTranscriptCorpus([]);
  assert.equal(emptyReport.status, 'BLOCKED_MISSING_HUMAN_CORPUS');

  const evalReport = evaluatePersianTranscriptCorpus([
    {
      sampleId: 'fa-eval-1',
      referenceText: 'من می‌روم به جلسه ۱۴۰۴ درباره API',
      hypothesisText: 'من می روم به جلسه 1404 درباره API',
      referenceProvenance: 'HUMAN_VERIFIED',
    },
  ]);
  assert.equal(evalReport.status, 'EVALUATED');
  assert.ok(evalReport.normalizedWer! <= evalReport.rawWer!);
});

test('AVP-P0-010: 25-category Persian Error Taxonomy, 6-tier Evidence Hierarchy, meaning-critical protection, and all 19 adversarial regression cases', () => {
  assert.equal(Object.keys(PERSIAN_ASR_ERROR_TAXONOMY_V1).length, 25);

  const morph = new RuleBasedPersianMorphologyInspector();
  const analyzed = morph.analyze('می‌رفتم');
  assert.equal(analyzed.hasContinuousPrefix, true);

  assert.ok(detectMeaningCriticalTokens('نمی‌شود', []).includes('NEGATION'));
  assert.ok(detectMeaningCriticalTokens('همه', []).includes('QUANTIFIER'));
  assert.ok(detectMeaningCriticalTokens('۲۵۰', []).includes('NUMBER'));
  assert.ok(detectMeaningCriticalTokens('نباید', []).includes('MODAL'));

  const adversarialCases: {
    readonly id: string;
    readonly original: string;
    readonly proposed: string;
    readonly category: keyof typeof PERSIAN_ASR_ERROR_TAXONOMY_V1;
    readonly properNames?: string[];
    readonly isNegation?: boolean;
    readonly isColloquial?: boolean;
  }[] = [
    { id: 'adv-01-neg-remove', original: 'نمی‌شود', proposed: 'می‌شود', category: 'MORPH_NEGATION_PREFIX', isNegation: true },
    { id: 'adv-02-neg-insert', original: 'می‌شود', proposed: 'نمی‌شود', category: 'MORPH_NEGATION_PREFIX', isNegation: true },
    { id: 'adv-03-darad-nadarad', original: 'ندارد', proposed: 'دارد', category: 'MORPH_NEGATION_PREFIX', isNegation: true },
    { id: 'adv-04-bayad-nabayad', original: 'باید', proposed: 'نباید', category: 'MORPH_NEGATION_PREFIX', isNegation: true },
    { id: 'adv-05-quantifier', original: 'همه', proposed: 'هیچ‌کدام', category: 'LEX_NUMBER_OR_QUANTIFIER' },
    { id: 'adv-06-comparative', original: 'بیشتر', proposed: 'کمتر', category: 'LEX_DOMAIN_VOCABULARY' },
    { id: 'adv-07-directional', original: 'قبل', proposed: 'بعد', category: 'LEX_DOMAIN_VOCABULARY' },
    { id: 'adv-08-colloquial', original: 'میخوام', proposed: 'می‌خواهم', category: 'MORPH_VERB_INFLECTION', isColloquial: true },
    { id: 'adv-09-proper-name', original: 'آرشام', proposed: 'آرامش', category: 'LEX_PROPER_NAME_SUBSTITUTION', properNames: ['آرشام'] },
    { id: 'adv-10-number', original: '۴۵۰', proposed: '۵۴۰', category: 'LEX_NUMBER_OR_QUANTIFIER' },
    { id: 'adv-11-currency', original: 'تومان', proposed: 'ریال', category: 'LEX_NUMBER_OR_QUANTIFIER' },
    { id: 'adv-12-date', original: '۱۴۰۴', proposed: '۱۴۰۳', category: 'LEX_NUMBER_OR_QUANTIFIER' },
    { id: 'adv-13-homophone', original: 'خوار', proposed: 'خار', category: 'LEX_HOMOPHONE' },
    { id: 'adv-14-incomplete', original: 'برنام...', proposed: 'برنامه‌ریزی', category: 'DISC_INCOMPLETE_PHRASE' },
    { id: 'adv-15-repetition', original: 'بله بله', proposed: 'بله', category: 'DISC_REPEATED_WORD' },
    { id: 'adv-16-self-repair', original: 'فردا نه پس‌فردا', proposed: 'پس‌فردا', category: 'DISC_FALSE_START_OR_SELF_CORRECTION' },
    { id: 'adv-17-speaker-boundary', original: 'سلام خب', proposed: 'سلام خوب', category: 'DISC_SPEAKER_BOUNDARY' },
    { id: 'adv-18-entity-domain', original: 'سرویس', proposed: 'سرور', category: 'LEX_TECHNICAL_TERM' },
    { id: 'adv-19-missing-confidence', original: 'آزمایش', proposed: 'آموزش', category: 'PHON_SIMILAR_PHONEME' },
  ];

  const evalCases: CorrectionEvaluationCase[] = [];
  for (const c of adversarialCases) {
    const decision = evaluateProposedCorrection({
      proposalId: c.id,
      segmentId: 'seg-adv',
      transcriptRevision: 1,
      tokenIds: ['tok-1'],
      crossesSpeakerBoundary: c.category === 'DISC_SPEAKER_BOUNDARY',
      isColloquialSpokenSource: Boolean(c.isColloquial),
      originalText: c.original,
      proposedText: c.proposed,
      category: c.category,
      evidence: [
        {
          evidenceId: `${c.id}-ling`,
          tier: 'LINGUISTIC',
          polarity: 'SUPPORTING',
          source: 'lm-plausibility-only',
          summary: 'More frequent phrase in written corpus.',
        },
        {
          evidenceId: `${c.id}-ac`,
          tier: 'DIRECT_ACOUSTIC',
          polarity: 'CONTRADICTORY',
          source: 'acoustic-waveform-alignment',
          summary: 'Recognized speech clearly matches original spoken phonemes.',
        },
      ],
      knownProperNames: c.properNames ?? [],
      confidence: {
        providerSource: 'UNAVAILABLE',
        calibrationDatasetQualified: false,
      },
    });

    assert.equal(
      decision.safeToAutoApply,
      false,
      `Adversarial case ${c.id} MUST NEVER auto-apply! Got outcome=${decision.outcome}`,
    );
    assert.equal(decision.confidenceProvenance.providerSource, 'UNAVAILABLE');
    evalCases.push({
      caseId: c.id,
      category: c.category,
      isTrueErrorInAudio: false,
      altersSpokenMeaning: true,
      isNegationCase: Boolean(c.isNegation),
      isColloquialPreservationCase: Boolean(c.isColloquial),
      decision,
    });
  }

  const safeZwnj = evaluateProposedCorrection({
    proposalId: 'safe-zwnj-1',
    segmentId: 'seg-1',
    transcriptRevision: 1,
    tokenIds: ['tok-2'],
    originalText: 'میروم',
    proposedText: 'می‌روم',
    category: 'TEXT_ZWNJ_ERROR',
    evidence: [
      {
        evidenceId: 'ev-zwnj-1',
        tier: 'LINGUISTIC',
        polarity: 'SUPPORTING',
        source: 'fa-zwnj-rule',
        summary: 'Deterministic Persian mi-prefix half-space rule.',
      },
    ],
    confidence: {
      providerSource: 'UNAVAILABLE',
      calibrationDatasetQualified: false,
    },
  });
  assert.equal(safeZwnj.outcome, 'SAFE_NORMALIZATION');

  const ledger = new HumanInTheLoopCorrectionLedger('من میروم تهران');
  ledger.registerDecision({ ...safeZwnj, decisionId: 'dec-stale', transcriptRevision: 99 });
  const stale = ledger.acceptDecision('dec-stale');
  assert.equal(stale.ok, false);
  assert.equal(stale.errorCode, 'STALE_TRANSCRIPT_REVISION');

  ledger.registerDecision({ ...safeZwnj, transcriptRevision: ledger.getState().revision });
  const applied = ledger.acceptDecision(safeZwnj.decisionId);
  assert.equal(applied.ok, true);
  assert.equal(ledger.getState().currentText, 'من می‌روم تهران');
  assert.equal(ledger.undo(), true);
  assert.equal(ledger.getState().currentText, 'من میروم تهران');
  assert.equal(ledger.redo(), true);
  assert.equal(ledger.getState().currentText, 'من می‌روم تهران');
  ledger.revertToOriginal();
  assert.equal(ledger.getState().currentText, 'من میروم تهران');

  const metrics = computeCorrectionQualityMetrics(evalCases);
  assert.equal(metrics.falseAutoCorrectionRate, 0);
  assert.equal(metrics.meaningChangingAutoCorrectionCount, 0);
  assert.equal(metrics.negationAutoCorruptions, 0);
  assert.equal(metrics.colloquialPreservationRate, 1);
});

test('AVP-P0-012: versioned O(1)-indexed domain vocabulary (10k entries benchmark), unverified guess quarantine, proper-noun & acronym protection, and non-destructive compound analysis', () => {
  const vocab = new VersionedPersianVocabularyManager();

  // Add verified proper noun & technical term
  vocab.upsertConfirmedEntry({
    entryId: 'pn-1',
    canonicalDisplayForm: 'آواپرداز',
    acceptedAlternatives: ['اوا پرداز'],
    languageScript: 'fa',
    entityKind: 'ORGANIZATION_OR_BRAND',
    domain: 'audio-editing',
    provenance: 'USER_CONFIRMED_VOCAB',
    userVerified: true,
  });

  // Repeated unverified machine guesses MUST stay quarantined and NEVER promote automatically
  for (let k = 0; k < 5; k++) {
    vocab.recordUnverifiedMachineGuess('حدس‌ماشینی');
  }
  assert.equal(vocab.lookupBySurface('حدس‌ماشینی').length, 0);
  assert.equal(vocab.getUnverifiedGuessCount('حدس‌ماشینی'), 5);

  // Scale benchmark: 10,000 entries indexed lookup stays fast (<200ms for 1,000 lookups)
  for (let i = 0; i < 10_000; i++) {
    vocab.upsertConfirmedEntry({
      entryId: `bulk-${i}`,
      canonicalDisplayForm: `اصطلاح${i}`,
      languageScript: 'fa',
      entityKind: 'SOFTWARE_OR_TECHNICAL',
      domain: 'general',
      provenance: 'PROJECT_DOMAIN_VOCAB',
      userVerified: true,
    });
  }
  assert.equal(vocab.getEntryCount(), 10_001);
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    const hits = vocab.lookupBySurface(`اصطلاح${i * 9}`);
    assert.equal(hits.length, 1);
  }
  const lookupMs = performance.now() - t0;
  assert.ok(lookupMs < 200, `1,000 indexed lookups took ${lookupMs.toFixed(1)}ms`);

  const exportedJson = vocab.exportPackageJson();
  assert.ok(exportedJson.includes('آواپرداز'));

  const analysis = analyzePersianLexicalFidelity({
    segmentId: 'seg-lex-1',
    transcriptRevision: 1,
    vocabulary: vocab,
    tokens: [
      { tokenId: 't1', text: 'API' },
      { tokenId: 't2', text: 'v2.0.0' },
      { tokenId: 't3', text: 'آواپرداز' },
      { tokenId: 't4', text: 'بررسی' },
      { tokenId: 't5', text: 'کرد' },
    ],
  });
  assert.ok(analysis.protectedIdentifiers.includes('API'));
  assert.ok(analysis.protectedIdentifiers.includes('v2.0.0'));
  assert.deepEqual(analysis.preservedOriginalTokens, ['API', 'v2.0.0', 'آواپرداز', 'بررسی', 'کرد']);
  assert.ok(analysis.compoundAnnotations.some((c) => c.unitKind === 'LIGHT_VERB_CONSTRUCTION' && !c.mutatesCanonicalTokens));
});
