import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { PraatTextGridAndLinguisticExporter } from '../../src/ai-engine/asr/PraatTextGridAndLinguisticExporter';
import { DetailedAsrErrorBreakdownEvaluator } from '../../src/ai-engine/evaluation/DetailedAsrErrorBreakdownEvaluator';
import { ServerSideEncryptedModelVault } from '../src/security/ServerSideEncryptedModelVault';
import { PersianTextNormalizer } from '../../src/ai-engine/PersianTextNormalizer';
import { TimeMath } from '../../src/contracts/timebase.contract';

describe('Praat TextGrid / NIST CTM Export, Detailed WER/CER & Encrypted Model Vault Suite', () => {
  it('1. PraatTextGridAndLinguisticExporter produces strictly contiguous intervals and valid NIST CTM', () => {
    const tokens = PersianTextNormalizer.buildThreeLayerTranscript([
      {
        id: 'w1',
        text: 'سلام',
        range: { start: TimeMath.secondsToFlicks(0.2), end: TimeMath.secondsToFlicks(0.6) },
        confidence: 0.96,
      },
      {
        id: 'w2',
        text: 'تست',
        range: { start: TimeMath.secondsToFlicks(1.0), end: TimeMath.secondsToFlicks(1.4) },
        confidence: 0.94,
      },
    ]);

    const textGrid = PraatTextGridAndLinguisticExporter.exportToPraatTextGrid({
      totalAudioDurationSec: 2.0,
      tokens,
    });

    // Expect 5 strictly contiguous intervals: [0..0.2], [0.2..0.6], [0.6..1.0], [1.0..1.4], [1.4..2.0]
    expect(textGrid).toContain('intervals: size = 5');
    expect(textGrid).toContain('text = "سلام"');
    expect(textGrid).toContain('text = "تست"');

    const ctm = PraatTextGridAndLinguisticExporter.exportToNistCtm('utt_01', tokens, 1);
    expect(ctm).toContain('utt_01 1 0.200 0.400 سلام 0.960');
    expect(ctm).toContain('utt_01 1 1.000 0.400 تست 0.940');
  });

  it('2. DetailedAsrErrorBreakdownEvaluator separates Substitutions, Deletions, Insertions, and computes Persian CER', () => {
    const ref = 'امروز درباره معماری نرم‌افزار صحبت می‌کنیم';
    // 1 substitution ("می‌کنم" for "می‌کنیم"), 1 deletion ("درباره"), 1 insertion ("خب")
    const hyp = 'خب امروز معماری نرم‌افزار صحبت می‌کنم';

    const report = DetailedAsrErrorBreakdownEvaluator.evaluateDetailedBreakdown(ref, hyp);
    expect(report.hits).toBe(4);
    expect(report.substitutions).toBe(1);
    expect(report.deletions).toBe(1);
    expect(report.insertions).toBe(1);
    expect(report.werPercent).toBe(50); // (1+1+1)/6 = 50%
    expect(report.cerPercent).toBeLessThan(report.werPercent);
    expect(report.topWordSubstitutions[0]).toEqual({
      expected: 'می‌کنیم',
      predicted: 'می‌کنم',
      count: 1,
    });
  });

  it('3. ServerSideEncryptedModelVault encrypts weights with AES-256-GCM envelope and rejects tampered version or bytes', () => {
    const kekHex = crypto.randomBytes(32).toString('hex');
    const vault = new ServerSideEncryptedModelVault(kekHex);
    const dummyOnnxWeights = crypto.randomBytes(1024 * 64);

    const encrypted = vault.encryptModelBytes(dummyOnnxWeights, 'fastconformer-fa', '1.2.0');
    const decrypted = vault.decryptModelBytesInMemory(encrypted, 'fastconformer-fa', '1.2.0');

    expect(Buffer.from(decrypted).equals(dummyOnnxWeights)).toBe(true);

    // Attempting to decrypt with a mismatched version must fail AAD check
    expect(() =>
      vault.decryptModelBytesInMemory(encrypted, 'fastconformer-fa', '1.3.0')
    ).toThrow();

    // Tampering with 1 byte of ciphertext must fail AuthTag check
    const tampered = new Uint8Array(encrypted);
    tampered[tampered.length - 10] ^= 0xff;
    expect(() =>
      vault.decryptModelBytesInMemory(tampered, 'fastconformer-fa', '1.2.0')
    ).toThrow();
  });
});
