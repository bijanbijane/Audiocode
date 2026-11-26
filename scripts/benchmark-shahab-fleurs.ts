#!/usr/bin/env node
/**
 * Reproducible Persian SHAHAB ASR evaluation against the held-out Google FLEURS fa_ir test split.
 * Audio inference is executed separately by the offline Sherpa worker; this script only scores
 * hypotheses. It never reads or writes model weights and never injects reference text into ASR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWithProfile } from '../src/asr-core/CoreNormalizationAndLanguage';
import { computePersianWerCer } from '../src/asr-core/ModelQualificationPipeline';
import { PersianNumeralAndCurrencyNormalizer } from '../src/ai-engine/PersianNumeralAndCurrencyNormalizer';

interface DatasetRow {
  readonly filename: string;
  readonly rawReference: string;
  readonly normalizedReference: string;
}
interface WorkerResult {
  readonly type: string;
  readonly requestId?: string;
  readonly ok?: boolean;
  readonly text?: string;
  readonly error?: string;
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function applyPersianDisplayItN(text: string): string {
  const words = normalizeWithProfile(text, 'FA-RELAXED-V1').split(/\s+/).filter(Boolean);
  const tokens = words.map((word, index) => ({
    tokenId: `fleurs_eval_${index}`,
    trackId: 'fleurs-fa-ir-test',
    originalText: word,
    normalizedText: word,
    displayText: word,
    range: { start: index, end: index + 1 },
    confidence: 1,
  }));
  return PersianNumeralAndCurrencyNormalizer
    .formatSpokenNumbersInDisplayLayer(tokens)
    .map((token) => token.displayText)
    .join(' ');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.manifest ?? '/tmp/avp-fleurs-fa-test-full/manifest-pcm16.json';
  const resultsPath = args.results ?? '/tmp/avp-fleurs-fa-test-full/results.jsonl';
  const outputPath = args.output ?? '/tmp/avp-fleurs-fa-test-full/metrics.json';
  const modelId = args.model ?? 'Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx';
  const modelSha256 = args['model-sha256'] ?? '6a564b5541920ce1c37bbc91d22e4b3a6838648b9b327eb88997e8db1f90950d';

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DatasetRow[];
  const results = fs.readFileSync(resultsPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkerResult)
    .filter((row) => row.type === 'result');
  const resultMap = new Map(results.map((row) => [row.requestId ?? '', row]));
  if (manifest.length === 0 || results.length !== manifest.length) {
    throw new Error(`DATASET_RESULT_COUNT_MISMATCH: manifest=${manifest.length}, results=${results.length}`);
  }

  let wordEdits = 0;
  let referenceWords = 0;
  let charEdits = 0;
  let referenceChars = 0;
  let emptyTranscripts = 0;
  let failedTranscripts = 0;
  let summedUtteranceWer = 0;
  let summedUtteranceCer = 0;
  const perSample: Array<Record<string, unknown>> = [];

  for (let index = 0; index < manifest.length; index += 1) {
    const row = manifest[index];
    const requestId = `fleurs-fa-test-${String(index).padStart(3, '0')}`;
    const hypothesis = resultMap.get(requestId);
    if (!hypothesis || hypothesis.ok !== true) {
      failedTranscripts += 1;
      perSample.push({ filename: row.filename, requestId, failed: true, error: hypothesis?.error ?? 'MISSING_RESULT' });
      continue;
    }
    const rawText = hypothesis.text ?? '';
    if (!rawText.trim()) emptyTranscripts += 1;
    const displayText = applyPersianDisplayItN(rawText);
    const score = computePersianWerCer(row.normalizedReference, displayText);
    wordEdits += score.wordEdits;
    referenceWords += score.referenceWords;
    charEdits += score.charEdits;
    referenceChars += score.referenceChars;
    summedUtteranceWer += score.wer;
    summedUtteranceCer += score.cer;
    perSample.push({
      filename: row.filename,
      requestId,
      wordEdits: score.wordEdits,
      referenceWords: score.referenceWords,
      wer: score.wer,
      charEdits: score.charEdits,
      referenceChars: score.referenceChars,
      cer: score.cer,
      rawReference: row.rawReference,
      normalizedReference: row.normalizedReference,
      rawHypothesis: rawText,
      displayHypothesisAfterItN: displayText,
    });
  }

  const scoredSamples = manifest.length - failedTranscripts;
  const summary = {
    benchmarkId: 'AVP-SHAHAB-FLEURS-FA-IR-TEST-001',
    generatedAtUtc: new Date().toISOString(),
    dataset: {
      id: 'google/fleurs',
      config: 'fa_ir',
      split: 'test',
      selection: 'all manifest rows supplied to the benchmark; this report does not score partial subsets as full test results',
      totalSamples: manifest.length,
      scoredSamples,
    },
    model: { modelId, sha256: modelSha256 },
    scoring: {
      profile: 'FA-RELAXED-V1',
      displayItN: 'PersianNumeralAndCurrencyNormalizer.formatSpokenNumbersInDisplayLayer',
      rawTranscriptPreserved: true,
    },
    metrics: {
      corpusWER: wordEdits / Math.max(1, referenceWords),
      corpusCER: charEdits / Math.max(1, referenceChars),
      wordEdits,
      referenceWords,
      charEdits,
      referenceCharacters: referenceChars,
      meanUtteranceWER: summedUtteranceWer / Math.max(1, scoredSamples),
      meanUtteranceCER: summedUtteranceCer / Math.max(1, scoredSamples),
      emptyTranscripts,
      failedTranscripts,
    },
    perSample,
  };

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ outputPath, ...summary.metrics, samples: scoredSamples }, null, 2)}\n`);
  if (failedTranscripts > 0) process.exitCode = 2;
}

main();
