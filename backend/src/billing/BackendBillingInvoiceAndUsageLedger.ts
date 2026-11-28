import crypto from 'node:crypto';
import type { FastifyInstanceLike, PgPoolLike } from '../PlatformBackendServices';

export interface IssuedInvoiceRecord {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly userId: string;
  readonly subtotalMinorUnits: number;
  readonly taxMinorUnits: number;
  readonly totalMinorUnits: number;
  readonly currency: string;
  readonly snapshotSha256Hex: string;
  readonly issuedAtIso: string;
}

export class BackendBillingInvoiceAndUsageLedger {
  constructor(
    private readonly db: PgPoolLike,
    private readonly defaultVatBasisPoints: number = 1000 // Default 10.00% VAT
  ) {
    if (!Number.isInteger(defaultVatBasisPoints) || defaultVatBasisPoints < 0 || defaultVatBasisPoints > 10000) {
      throw new Error('INVALID_VAT_BASIS_POINTS');
    }
  }

  /**
   * 1. Issues an immutable, idempotent financial invoice for a verified payment transaction.
   */
  public async issueImmutableInvoiceForPayment(params: {
    userId: string;
    paymentTransactionId: string;
    planTier: string;
    totalPaidMinorUnits: number;
    currency: string;
    buyerLegalNameFa: string;
    fiscalYearPrefix?: string;
  }): Promise<IssuedInvoiceRecord> {
    if (
      typeof params.userId !== 'string' ||
      params.userId.trim().length === 0 ||
      typeof params.paymentTransactionId !== 'string' ||
      params.paymentTransactionId.trim().length === 0 ||
      typeof params.currency !== 'string' ||
      params.currency.trim().length === 0 ||
      typeof params.totalPaidMinorUnits !== 'number' ||
      !Number.isSafeInteger(params.totalPaidMinorUnits) ||
      params.totalPaidMinorUnits <= 0
    ) {
      throw new Error('INVALID_INVOICE_PAYMENT_PARAMS');
    }
    // Return existing invoice if already issued for this payment transaction (Idempotency)
    const fetchExistingInvoice = async () => {
      const existing = await this.db.query<{
        invoice_id: string;
        invoice_number: string;
        user_id?: string;
        subtotal_minor_units: string;
        tax_minor_units: string;
        total_minor_units: string;
        currency: string;
        snapshot_sha256_hex: string;
        issued_at: Date;
      }>(
        `SELECT invoice_id, invoice_number, user_id, subtotal_minor_units, tax_minor_units,
                total_minor_units, currency, snapshot_sha256_hex, issued_at
         FROM billing_invoices
         WHERE payment_transaction_id = $1`,
        [params.paymentTransactionId]
      );
      if (existing.rows.length === 0) return null;
      const r = existing.rows[0];
      if (typeof r.user_id === 'string' && r.user_id !== params.userId) {
        throw new Error('INVOICE_PAYMENT_OWNER_MISMATCH');
      }
      return {
        invoiceId: r.invoice_id,
        invoiceNumber: r.invoice_number,
        userId: typeof r.user_id === 'string' ? r.user_id : params.userId,
        subtotalMinorUnits: Number(r.subtotal_minor_units),
        taxMinorUnits: Number(r.tax_minor_units),
        totalMinorUnits: Number(r.total_minor_units),
        currency: r.currency,
        snapshotSha256Hex: r.snapshot_sha256_hex,
        issuedAtIso: new Date(r.issued_at).toISOString(),
      };
    };

    const existingInvoice = await fetchExistingInvoice();
    if (existingInvoice) {
      return existingInvoice;
    }

    // Separate subtotal and VAT in integer minor units to prevent floating-point drift
    const vatRate = this.defaultVatBasisPoints / 10000;
    const subtotalMinor = Math.round(params.totalPaidMinorUnits / (1 + vatRate));
    const taxMinor = params.totalPaidMinorUnits - subtotalMinor;

    const seqRes = await this.db.query<{ seq_val: string }>(
      `SELECT nextval('billing_invoice_seq')::text AS seq_val`
    );
    const seqNum = seqRes.rows[0]?.seq_val ?? String(Date.now());
    const yearTag = params.fiscalYearPrefix ?? String(new Date().getFullYear());
    const invoiceNumber = `INV-${yearTag}-${seqNum.padStart(6, '0')}`;

    const snapshotObj = {
      invoiceNumber,
      userId: params.userId,
      paymentTransactionId: params.paymentTransactionId,
      buyerLegalNameFa: params.buyerLegalNameFa,
      planTier: params.planTier,
      currency: params.currency,
      subtotalMinorUnits: subtotalMinor,
      taxRateBasisPoints: this.defaultVatBasisPoints,
      taxMinorUnits: taxMinor,
      totalMinorUnits: params.totalPaidMinorUnits,
    };

    const snapshotJson = JSON.stringify(snapshotObj);
    const snapshotSha256Hex = crypto
      .createHash('sha256')
      .update(snapshotJson, 'utf8')
      .digest('hex');

    let insRes: { rows: { invoice_id: string; issued_at: Date }[]; rowCount: number | null };
    try {
      insRes = await this.db.query<{ invoice_id: string; issued_at: Date }>(
        `INSERT INTO billing_invoices
         (invoice_number, user_id, payment_transaction_id, plan_tier, currency,
          subtotal_minor_units, tax_rate_bps, tax_minor_units, total_minor_units,
          immutable_snapshot_json, snapshot_sha256_hex)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         RETURNING invoice_id, issued_at`,
        [
          invoiceNumber,
          params.userId,
          params.paymentTransactionId,
          params.planTier,
          params.currency,
          subtotalMinor,
          this.defaultVatBasisPoints,
          taxMinor,
          params.totalPaidMinorUnits,
          snapshotJson,
          snapshotSha256Hex,
        ]
      );
    } catch (err: unknown) {
      const pgCode = (err as { code?: unknown } | null)?.code;
      const errMsg = err instanceof Error ? err.message : '';
      if (pgCode === '23505' || /unique|duplicate/i.test(errMsg)) {
        const raced = await fetchExistingInvoice();
        if (raced) return raced;
      }
      throw err;
    }

    return {
      invoiceId: insRes.rows[0].invoice_id,
      invoiceNumber,
      userId: params.userId,
      subtotalMinorUnits: subtotalMinor,
      taxMinorUnits: taxMinor,
      totalMinorUnits: params.totalPaidMinorUnits,
      currency: params.currency,
      snapshotSha256Hex,
      issuedAtIso: new Date(insRes.rows[0].issued_at).toISOString(),
    };
  }

  public registerRoutes(fastify: FastifyInstanceLike): void {
    fastify.get<{ Params: { userId: string } }>(
      '/api/v1/billing/users/:userId/invoices',
      async (request, reply) => {
        const targetUserId = request.params?.userId;
        if (typeof targetUserId !== 'string' || targetUserId.trim().length === 0) {
          return reply.status(400).send({ error: 'INVALID_USER_ID' });
        }
        if (!request.authenticatedUserId) {
          return reply.status(401).send({ error: 'UNAUTHORIZED' });
        }
        if (request.authenticatedUserId !== targetUserId) {
          return reply.status(403).send({ error: 'FORBIDDEN_INVOICE_IDOR_MISMATCH' });
        }

        const res = await this.db.query(
          `SELECT invoice_id, invoice_number, plan_tier, currency,
                  subtotal_minor_units, tax_minor_units, total_minor_units,
                  snapshot_sha256_hex, issued_at
           FROM billing_invoices
           WHERE user_id = $1
           ORDER BY issued_at DESC`,
          [targetUserId]
        );
        return reply.send({ invoices: res.rows });
      }
    );
  }
}
