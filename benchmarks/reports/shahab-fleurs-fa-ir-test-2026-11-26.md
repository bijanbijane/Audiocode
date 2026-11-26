# Shahab Persian ASR — FLEURS fa_ir Test Benchmark

- Run ID: `AVP-SHAHAB-FLEURS-FA-IR-TEST-001`
- Run timestamp (UTC): `2026-11-25T21:56:14.836Z`
- Dataset: `google/fleurs` / `fa_ir` / `test`
- Scored samples: **871 / 871** (complete test manifest)
- Model: `Reza2kn/Shenava-Koochik-v1.0-sherpa-onnx`
- Model SHA-256: `6a564b5541920ce1c37bbc91d22e4b3a6838648b9b327eb88997e8db1f90950d`
- Scoring profile: `FA-RELAXED-V1`
- Display normalization: `PersianNumeralAndCurrencyNormalizer.formatSpokenNumbersInDisplayLayer`
- Raw transcript preserved: `True`

## Results

| Metric | Result |
|---|---:|
| Corpus WER | **9.923%** |
| Corpus CER | **3.644%** |
| Mean utterance WER | 10.012% |
| Mean utterance CER | 3.633% |
| Word edits / reference words | 2,132 / 21,485 |
| Character edits / reference characters | 3,739 / 102,611 |
| Empty transcripts | 0 |
| Failed transcripts | 0 |

## Interpretation and limits

This is a reproducible baseline on the full FLEURS Persian test split, not a claim of state-of-the-art performance. WER/CER depend on the declared Persian normalization profile. The report does not replace human review of named entities, numbers, dialects, conversational speech, noisy audio, or domain-specific vocabulary. The per-utterance output is retained in the adjacent `.results.jsonl` file for error analysis.

## Next evaluation steps

1. Classify the highest-WER utterances into repetition, substitution, deletion, number normalization, named entity, and acoustic-noise errors.
2. Re-run the same manifest and scoring profile after each decoding or post-processing change.
3. Add a separate conversational/noisy Persian evaluation set; do not mix it into FLEURS scores.
4. Compare alternative acoustic models under the same exact test split and scoring code.
