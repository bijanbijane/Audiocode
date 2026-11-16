import { describe, it, expect } from 'vitest';
import { DynamicLengthBatchedCtcRunner } from '../../src/ai-engine/asr/DynamicLengthBatchedCtcRunner';
import { PersianCtcPrefixBeamSearchDecoder } from '../../src/ai-engine/asr/PersianCtcPrefixBeamSearchDecoder';
import { PreAsrInputSanityValidator } from '../../src/ai-engine/asr/PreAsrInputSanityValidator';
import { BackendBillingInvoiceAndUsageLedger } from '../src/billing/BackendBillingInvoiceAndUsageLedger';
import {
  OrtRuntimeProvider,
  OrtSessionLike,
  OrtTensorLike,
} from '../../src/ai-engine/asr/UnifiedOnnxPersianAsrEngine';
import { VadSpeechSegment } from '../../src/ai-engine/asr/SileroVadOnnxRunner';
import { PgPoolLike } from '../src/PlatformBackendServices';
import { TimeMath } from '../../src/contracts/timebase.contract';

describe('Dynamic-Length Batched CTC, Signal Sanity & Immutable Billing Ledger Suite', () => {
  it('1. DynamicLengthBatchedCtcRunner groups VAD segments by length, executes [B, 80, T_max], and restores original order', async () => {
    const vocab = ['<blk>', ' ', 'س', 'ل', 'ا', 'م', 'خ', 'و', 'ب'];
    const ctcDecoder = new PersianCtcPrefixBeamSearchDecoder(vocab, 0, ' ');

    const observedBatchShapes: (readonly number[])[] = [];
    const mockOrt: OrtRuntimeProvider = {
      createTensor: (type, data, dims) => ({ type, data, dims } as OrtTensorLike),
      createSession: async (): Promise<OrtSessionLike> => ({
        run: async (feeds): Promise<Record<string, OrtTensorLike>> => {
          const melDims = feeds['audio_signal'].dims;
          observedBatchShapes.push(melDims);
          const B = melDims[0];
          const T_mel = melDims[2];
          const T_out = Math.ceil(T_mel / 4);
          const V = vocab.length;
          const outData = new Float32Array(B * T_out * V).fill(-10);

          // Simulate word "سلام" in early frames for each batch item
          const seq = [2, 3, 4, 5]; // س ل ا م
          for (let b = 0; b < B; b++) {
            for (let t = 0; t < Math.min(T_out, seq.length); t++) {
              outData[(b * T_out + t) * V + seq[t]] = 0.0;
            }
            for (let t = seq.length; t < T_out; t++) {
              outData[(b * T_out + t) * V + 0] = 0.0; // <blk>
            }
          }

          return {
            logprobs: { type: 'float32', dims: [B, T_out, V], data: outData },
          };
        },
      }),
    };

    const runner = new DynamicLengthBatchedCtcRunner(mockOrt, ctcDecoder, {
      maxBatchSize: 4,
      maxBatchTotalFrames: 5000,
      maxAllowedPaddingRatio: 0.25,
      encoderSubsamplingFactor: 4,
      melHopDurationSec: 0.01,
    });
    await runner.loadModel('mock_ctc', ['cpu']);

    // Three segments in non-sorted length order: 5s, 1s, 1.1s
    // Expect 1s and 1.1s to be grouped into a 2-item batch (B=2) and 5s in a separate batch (B=1)
    const pcm = new Float32Array(16000 * 10);
    const segments: VadSpeechSegment[] = [
      {
        startSample16k: 0,
        endSample16k: 16000 * 5,
        range: { start: 0, end: TimeMath.secondsToFlicks(5) },
        peakSpeechProb: 0.95,
      },
      {
        startSample16k: 16000 * 6,
        endSample16k: 16000 * 7,
        range: { start: TimeMath.secondsToFlicks(6), end: TimeMath.secondsToFlicks(7) },
        peakSpeechProb: 0.92,
      },
      {
        startSample16k: 16000 * 8,
        endSample16k: 16000 * 9 + 1600,
        range: { start: TimeMath.secondsToFlicks(8), end: TimeMath.secondsToFlicks(9.1) },
        peakSpeechProb: 0.93,
      },
    ];

    const res = await runner.transcribeVadSegmentsBatched(pcm, segments);

    expect(res.batchesExecuted).toBe(2);
    expect(observedBatchShapes[0][0]).toBe(2);
    expect(res.averagePaddingWasteRatio).toBeLessThan(0.15);
    expect(res.tokens).toHaveLength(3);
    // Original timeline chronological order must be preserved (5s segment first, then 6s, then 8s)
    expect(res.tokens[0].range.start).toBeLessThan(res.tokens[1].range.start);
    expect(res.tokens[1].range.start).toBeLessThan(res.tokens[2].range.start);
  });

  it('2. PreAsrInputSanityValidator repairs severe DC offset in-place and flags silent feeds', () => {
    const biasedSignal = new Float32Array(1600);
    for (let i = 0; i < biasedSignal.length; i++) {
      biasedSignal[i] = 0.5 + 0.1 * Math.sin((2 * Math.PI * 200 * i) / 16000);
    }

    const report = PreAsrInputSanityValidator.validateAndSanitizeForAsr(biasedSignal);
    expect(report.safeForAsrInference).toBe(true);
    expect(report.anomaliesDetected).toContain('SEVERE_DC_OFFSET_FIXED');

    const meanAfter =
      biasedSignal.reduce((a, b) => a + b, 0) / biasedSignal.length;
    expect(Math.abs(meanAfter)).toBeLessThan(0.005);

    const silentReport = PreAsrInputSanityValidator.validateAndSanitizeForAsr(
      new Float32Array(1600)
    );
    expect(silentReport.safeForAsrInference).toBe(false);
    expect(silentReport.anomaliesDetected).toContain('DIGITAL_SILENCE_EMPTY');
  });

  it('3. BackendBillingInvoiceAndUsageLedger generates idempotent immutable invoices with SHA-256 snapshot seal', async () => {
    const invoicesByTx = new Map<string, Record<string, unknown>>();

    const mockDb: PgPoolLike = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        if (sql.includes('SELECT invoice_id, invoice_number')) {
          const row = invoicesByTx.get(params[0] as string);
          return { rows: (row ? [row] : []) as unknown as T[], rowCount: row ? 1 : 0 };
        }
        if (sql.includes("nextval('billing_invoice_seq')")) {
          return { rows: [{ seq_val: '1042' }] as unknown as T[], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO billing_invoices')) {
          const row = {
            invoice_id: 'inv_uuid_1042',
            invoice_number: params[0],
            subtotal_minor_units: params[5],
            tax_minor_units: params[7],
            total_minor_units: params[8],
            currency: params[4],
            snapshot_sha256_hex: params[10],
            issued_at: new Date(),
          };
          invoicesByTx.set(params[2] as string, row);
          return { rows: [row] as unknown as T[], rowCount: 1 };
        }
        return { rows: [] as unknown as T[], rowCount: 0 };
      },
    };

    const billing = new BackendBillingInvoiceAndUsageLedger(mockDb, 1000); // 10% VAT
    const inv1 = await billing.issueImmutableInvoiceForPayment({
      userId: 'usr_1',
      paymentTransactionId: 'pay_tx_777',
      planTier: 'PRO_MONTHLY',
      totalPaidMinorUnits: 5_500_000,
      currency: 'IRR',
      buyerLegalNameFa: 'استودیو پادکست پارس',
      fiscalYearPrefix: '1405',
    });

    expect(inv1.invoiceNumber).toBe('INV-1405-001042');
    expect(inv1.subtotalMinorUnits).toBe(5_000_000);
    expect(inv1.taxMinorUnits).toBe(500_000);
    expect(inv1.snapshotSha256Hex).toHaveLength(64);

    // Calling again for the same transaction must return the exact same invoice (Idempotent)
    const inv2 = await billing.issueImmutableInvoiceForPayment({
      userId: 'usr_1',
      paymentTransactionId: 'pay_tx_777',
      planTier: 'PRO_MONTHLY',
      totalPaidMinorUnits: 5_500_000,
      currency: 'IRR',
      buyerLegalNameFa: 'استودیو پادکست پارس',
    });
    expect(inv2.invoiceId).toBe(inv1.invoiceId);
  });
});
