import crypto from 'node:crypto';
import type { FastifyInstanceLike, PgPoolLike } from './PlatformBackendServices';

export interface AuthAndPaymentConfig {
  readonly ed25519PrivateKeyPem: string;
  readonly ed25519PublicKeyPem: string;
  readonly paymentWebhookHmacSecret: string;
  readonly accessTokenTtlSeconds?: number; // Default: 3600 seconds (1 hour)
}

/**
 * Section 103: Cryptographic Authentication (scrypt + EdDSA JWT) & Idempotent Payment Webhook Processor
 */
export class BackendAuthAndPaymentService {
  private readonly privateKeyObj: crypto.KeyObject;
  private readonly publicKeyObj: crypto.KeyObject;

  constructor(
    private readonly db: PgPoolLike,
    private readonly config: AuthAndPaymentConfig,
  ) {
    this.privateKeyObj = crypto.createPrivateKey(config.ed25519PrivateKeyPem);
    this.publicKeyObj = crypto.createPublicKey(config.ed25519PublicKeyPem);
  }

  public registerRoutes(fastify: FastifyInstanceLike): void {
    // 1. User registration with salted scrypt hash
    fastify.post<{ Body: { email: string; password: string } }>(
      '/api/v1/auth/register',
      async (request, reply) => {
        const rawEmail = request.body?.email;
        const password = request.body?.password;
        if (typeof rawEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail.trim())) {
          return reply.status(400).send({
            error: 'INVALID_EMAIL',
            messageFa: 'نشانی ایمیل معتبر نیست.',
          });
        }
        const email = rawEmail.trim().toLowerCase();
        if (typeof password !== 'string' || password.length < 10) {
          return reply.status(400).send({
            error: 'WEAK_PASSWORD',
            messageFa: 'رمز عبور باید حداقل ۱۰ کاراکتر باشد.',
          });
        }

        const passwordHash = await this.hashPasswordScrypt(password);
        try {
          const res = await this.db.query<{ id: string }>(
            `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
            [email, passwordHash],
          );
          const userId = res.rows[0].id;
          const accessToken = this.issueEdDsaJwt({ sub: userId, email });
          return reply.status(201).send({ userId, accessToken });
        } catch (err: unknown) {
          const pgCode = (err as { code?: unknown } | null)?.code;
          const errMsg = err instanceof Error ? err.message : '';
          if (
            pgCode === '23505' ||
            /unique|duplicate/i.test(errMsg)
          ) {
            return reply.status(409).send({
              error: 'EMAIL_ALREADY_EXISTS',
              messageFa: 'این ایمیل قبلاً ثبت شده است.',
            });
          }
          return reply.status(500).send({
            error: 'REGISTRATION_FAILED',
            messageFa: 'خطای داخلی هنگام ثبت حساب کاربری رخ داد.',
          });
        }
      },
    );

    // 2. User login and EdDSA-signed JWT issuance
    fastify.post<{ Body: { email: string; password: string } }>(
      '/api/v1/auth/login',
      async (request, reply) => {
        const rawEmail = request.body?.email;
        const password = request.body?.password;
        if (typeof rawEmail !== 'string' || rawEmail.trim().length === 0 || typeof password !== 'string') {
          return reply.status(400).send({ error: 'INVALID_CREDENTIALS_PAYLOAD' });
        }
        const email = rawEmail.trim().toLowerCase();

        const res = await this.db.query<{
          id: string;
          password_hash: string;
          status: string;
        }>(`SELECT id, password_hash, status FROM users WHERE email = $1`, [email]);

        if (res.rows.length === 0 || res.rows[0].status !== 'ACTIVE') {
          return reply.status(401).send({ error: 'INVALID_CREDENTIALS' });
        }

        const valid = await this.verifyPasswordScrypt(password, res.rows[0].password_hash);
        if (!valid) {
          return reply.status(401).send({ error: 'INVALID_CREDENTIALS' });
        }

        const accessToken = this.issueEdDsaJwt({ sub: res.rows[0].id, email });
        return reply.send({ userId: res.rows[0].id, accessToken });
      },
    );

    // 3. Payment Gateway Webhook with HMAC-SHA256 verification and PostgreSQL Idempotency Key
    fastify.post<{
      Headers: { 'x-gateway-signature'?: string };
      Body: {
        gatewayName: string;
        gatewayTxId: string;
        userId: string;
        planTier: 'PRO_MONTHLY' | 'PRO_ANNUAL' | 'STUDIO_ENTERPRISE';
        amountMinorUnits: number;
        currency: string;
        status: 'PAID' | 'REFUNDED';
      };
    }>('/api/v1/payments/webhook', async (request, reply) => {
      const signatureHex = request.headers['x-gateway-signature'] ?? '';
      const rawBodyCanonical = JSON.stringify(request.body);

      if (!this.verifyWebhookHmac(rawBodyCanonical, signatureHex)) {
        return reply.status(401).send({ error: 'WEBHOOK_INVALID_HMAC_SIGNATURE' });
      }

      const b = request.body;
      if (!b || typeof b !== 'object' || typeof b.userId !== 'string' || b.userId.trim().length === 0) {
        return reply.status(400).send({ error: 'WEBHOOK_INVALID_PAYLOAD' });
      }

      // On refund, immediately cancel active subscription and revoke all offline license leases
      if (b.status === 'REFUNDED') {
        await this.db.query(
          `UPDATE subscriptions SET status = 'CANCELLED' WHERE user_id = $1 AND status = 'ACTIVE'`,
          [b.userId],
        );
        await this.db.query(
          `UPDATE offline_license_leases SET revoked = TRUE WHERE user_id = $1`,
          [b.userId],
        );
        return reply.send({ processed: true, action: 'SUBSCRIPTION_AND_LEASES_REVOKED' });
      }

      if (
        b.status !== 'PAID' ||
        typeof b.gatewayName !== 'string' ||
        b.gatewayName.trim().length === 0 ||
        typeof b.gatewayTxId !== 'string' ||
        b.gatewayTxId.trim().length === 0 ||
        typeof b.currency !== 'string' ||
        b.currency.trim().length === 0 ||
        (b.planTier !== 'PRO_MONTHLY' && b.planTier !== 'PRO_ANNUAL' && b.planTier !== 'STUDIO_ENTERPRISE') ||
        typeof b.amountMinorUnits !== 'number' ||
        !Number.isSafeInteger(b.amountMinorUnits) ||
        b.amountMinorUnits <= 0
      ) {
        return reply.status(400).send({ error: 'WEBHOOK_UNSUPPORTED_OR_INVALID_PAYMENT_STATE' });
      }

      // Idempotency step: attempt insert with ON CONFLICT DO NOTHING
      const txInsert = await this.db.query<{ id: string }>(
        `INSERT INTO payment_transactions
         (user_id, gateway_name, gateway_tx_id, plan_tier, amount_minor_units, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'VERIFIED_APPLIED')
         ON CONFLICT (gateway_name, gateway_tx_id) DO NOTHING
         RETURNING id`,
        [
          b.userId,
          b.gatewayName,
          b.gatewayTxId,
          b.planTier,
          b.amountMinorUnits,
          b.currency,
        ],
      );

      if (txInsert.rows.length === 0) {
        return reply.status(200).send({
          processed: false,
          idempotentDuplicate: true,
        });
      }

      // Activate or extend subscription in PostgreSQL
      const daysToAdd = b.planTier === 'PRO_ANNUAL' ? 365 : 30;
      await this.db.query(
        `INSERT INTO subscriptions (user_id, plan_tier, status, current_period_start, current_period_end)
         VALUES ($1, $2, 'ACTIVE', NOW(), NOW() + ($3 || ' days')::interval)`,
        [b.userId, b.planTier, daysToAdd],
      );

      return reply.status(200).send({
        processed: true,
        transactionId: txInsert.rows[0].id,
        daysAdded: daysToAdd,
      });
    });
  }

  /** Hash password with scrypt (N=16384, r=8, p=1) and random 16-byte salt */
  private async hashPasswordScrypt(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
    });
    return `${salt}:${derivedKey.toString('hex')}`;
  }

  private async verifyPasswordScrypt(password: string, storedHash: string): Promise<boolean> {
    const [salt, keyHex] = storedHash.split(':');
    if (!salt || !keyHex) return false;
    const expectedBuf = Buffer.from(keyHex, 'hex');
    const derivedBuf = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
    });
    if (expectedBuf.length !== derivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, derivedBuf);
  }

  /** Issue standard JWT signed with EdDSA (Ed25519) */
  public issueEdDsaJwt(claims: { sub: string; email: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        ...claims,
        iat: now,
        exp: now + (this.config.accessTokenTtlSeconds ?? 3600),
      }),
    ).toString('base64url');

    const signingInput = `${header}.${payload}`;
    const sig = crypto
      .sign(null, Buffer.from(signingInput, 'utf8'), this.privateKeyObj)
      .toString('base64url');
    return `${signingInput}.${sig}`;
  }

  public verifyEdDsaJwt(token: string): { sub: string; email: string } {
    if (typeof token !== 'string') throw new Error('JWT_MALFORMED');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new Error('JWT_MALFORMED');
    const [header, payload, sigB64] = parts;

    let parsedHeader: { alg?: unknown; typ?: unknown };
    try {
      parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
        alg?: unknown;
        typ?: unknown;
      };
    } catch {
      throw new Error('JWT_MALFORMED');
    }
    if (!parsedHeader || typeof parsedHeader !== 'object' || parsedHeader.alg !== 'EdDSA') {
      throw new Error('JWT_UNSUPPORTED_ALG');
    }

    const ok = crypto.verify(
      null,
      Buffer.from(`${header}.${payload}`, 'utf8'),
      this.publicKeyObj,
      Buffer.from(sigB64, 'base64url'),
    );
    if (!ok) throw new Error('JWT_INVALID_SIGNATURE');

    let decoded: { sub?: unknown; email?: unknown; exp?: unknown; nbf?: unknown };
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        sub?: unknown;
        email?: unknown;
        exp?: unknown;
        nbf?: unknown;
      };
    } catch {
      throw new Error('JWT_MALFORMED');
    }

    if (
      !decoded ||
      typeof decoded !== 'object' ||
      typeof decoded.sub !== 'string' ||
      decoded.sub.length === 0 ||
      typeof decoded.email !== 'string' ||
      typeof decoded.exp !== 'number' ||
      !Number.isFinite(decoded.exp)
    ) {
      throw new Error('JWT_INVALID_CLAIMS');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof decoded.nbf === 'number' && Number.isFinite(decoded.nbf) && nowSec < decoded.nbf) {
      throw new Error('JWT_NOT_YET_VALID');
    }
    if (nowSec > decoded.exp) {
      throw new Error('JWT_EXPIRED');
    }
    return { sub: decoded.sub, email: decoded.email };
  }

  private verifyWebhookHmac(rawPayload: string, providedHex: string): boolean {
    if (
      typeof this.config.paymentWebhookHmacSecret !== 'string' ||
      this.config.paymentWebhookHmacSecret.trim().length === 0
    ) {
      return false;
    }
    if (!providedHex || !/^[0-9a-fA-F]+$/.test(providedHex) || providedHex.length % 2 !== 0) {
      return false;
    }
    const expectedHex = crypto
      .createHmac('sha256', this.config.paymentWebhookHmacSecret)
      .update(rawPayload, 'utf8')
      .digest('hex');

    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(providedHex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
