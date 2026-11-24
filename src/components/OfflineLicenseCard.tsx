import React, { useState } from 'react';
import { KeyRound, ShieldAlert, CheckCircle2, Lock } from 'lucide-react';
import {
  LicenseVerificationResult,
  ManifestVerificationResult,
  OfflineCryptoVerifier,
  OfflineLicenseLeasePayload,
  SignedEnvelope,
  SignedModelManifest,
} from '../security/OfflineCryptoVerifier';

interface VerificationState {
  publicKeyPreview: string;
  leaseResult: LicenseVerificationResult;
  tamperedResult: LicenseVerificationResult;
  expiredResult: LicenseVerificationResult;
  manifestResult: ManifestVerificationResult;
  revokedResult: ManifestVerificationResult;
}

export const OfflineLicenseCard: React.FC = () => {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [report, setReport] = useState<VerificationState | null>(null);

  const runLiveEd25519Verification = async () => {
    setStatus('loading');
    setErrorMsg(null);
    try {
      const [keyRes, leaseRes, manifestRes, revokedRes] = await Promise.all([
        fetch('/api/v1/crypto/public-key'),
        fetch('/api/v1/license/lease', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: 'usr_studio_ir_01',
            displayName: 'کاربر آزمایشی استودیو آواپرداز',
            deviceFingerprint: 'browser_fp_opfs_01',
            plan: 'PRO',
            graceDays: 14,
          }),
        }),
        fetch('/api/v1/models/whisper-fa-int8/manifest'),
        fetch('/api/v1/models/legacy-denoise-v0/manifest'),
      ]);

      if (!keyRes.ok || !leaseRes.ok || !manifestRes.ok || !revokedRes.ok) {
        throw new Error('خطا در دریافت پاسخ از سرویس پلتفرم');
      }

      const keyData = (await keyRes.json()) as { publicKeySpkiBase64: string };
      const leaseEnvelope = (await leaseRes.json()) as SignedEnvelope<OfflineLicenseLeasePayload>;
      const manifestEnvelope = (await manifestRes.json()) as SignedEnvelope<SignedModelManifest>;
      const revokedEnvelope = (await revokedRes.json()) as SignedEnvelope<SignedModelManifest>;

      const now = Date.now();
      const leaseResult = await OfflineCryptoVerifier.verifyOfflineLicense(
        leaseEnvelope,
        keyData.publicKeySpkiBase64,
        now,
        now,
      );

      // Simulate localStorage tampering attempt by altering base64 payload without private key
      const tamperedRaw = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(leaseEnvelope.payloadBase64), (c) => c.charCodeAt(0)),
        ),
      ) as Record<string, unknown>;
      tamperedRaw.plan = 'ENTERPRISE';
      const tamperedBytes = new TextEncoder().encode(JSON.stringify(tamperedRaw));
      let bin = '';
      tamperedBytes.forEach((b) => {
        bin += String.fromCharCode(b);
      });
      const tamperedEnvelope: SignedEnvelope<OfflineLicenseLeasePayload> = {
        ...leaseEnvelope,
        payloadBase64: btoa(bin),
      };

      const tamperedResult = await OfflineCryptoVerifier.verifyOfflineLicense(
        tamperedEnvelope,
        keyData.publicKeySpkiBase64,
        now,
        now,
      );

      // Simulate Data Hostage Prevention after 20 days offline expiration
      const expiredResult = await OfflineCryptoVerifier.verifyOfflineLicense(
        leaseEnvelope,
        keyData.publicKeySpkiBase64,
        now,
        now + 20 * 24 * 60 * 60 * 1000,
      );

      const manifestResult = await OfflineCryptoVerifier.verifyModelManifest(
        manifestEnvelope,
        keyData.publicKeySpkiBase64,
      );
      const revokedResult = await OfflineCryptoVerifier.verifyModelManifest(
        revokedEnvelope,
        keyData.publicKeySpkiBase64,
      );

      setReport({
        publicKeyPreview: `${keyData.publicKeySpkiBase64.slice(0, 20)}…`,
        leaseResult,
        tamperedResult,
        expiredResult,
        manifestResult,
        revokedResult,
      });
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'خطای ناشناخته در اعتبارسنجی رمزنگاری');
      setStatus('error');
    }
  };

  return (
    <section className="border border-[var(--avp-border)] bg-[var(--avp-surface)] rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-[var(--avp-success-text)]" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold text-[var(--avp-text)]">
              لایسنس آفلاین رمزنگاری‌شده (Ed25519) و رجیستری امضاشده مدل‌ها
            </h2>
            <p className="text-xs text-[var(--avp-text-secondary)] mt-0.5">
              اعتبارسنجی نامتقارن آفلاین در WebCrypto بدون دسترسی به اینترنت + جلوگیری از گروگان‌گیری داده پس از انقضا
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={runLiveEd25519Verification}
          disabled={status === 'loading'}
          className="avp-btn avp-btn-tonal"
        >
          <Lock className="w-3.5 h-3.5" aria-hidden="true" />
          <span>
            {status === 'loading'
              ? 'در حال اعتبارسنجی رمزنگاری...'
              : 'اعتبارسنجی آفلاین لایسنس و مانیفست مدل (Ed25519)'}
          </span>
        </button>
      </div>

      {errorMsg && (
        <div className="p-3 rounded-lg border border-[var(--avp-danger)]/40 bg-[var(--avp-danger-soft)] text-xs text-[var(--avp-danger)]">
          {errorMsg}
        </div>
      )}

      {report && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[var(--avp-text-secondary)]">امضای لایسنس معتبر</span>
              <CheckCircle2 className="w-4 h-4 text-[var(--avp-success-text)]" aria-hidden="true" />
            </div>
            <div dir="ltr" className="font-mono text-[var(--avp-success-text)] text-[11px]">
              {report.leaseResult.reason} ({report.leaseResult.payload?.plan})
            </div>
            <div className="text-[var(--avp-text-muted)] text-[11px]">
              دسترسی مدل‌ها:{' '}
              <span dir="ltr" className="font-mono text-[var(--avp-text)]">
                {report.leaseResult.allowedModelTiers.join(', ')}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[var(--avp-text-secondary)]">دفاع در برابر دستکاری Payload</span>
              <ShieldAlert className="w-4 h-4 text-[var(--avp-warning-text)]" aria-hidden="true" />
            </div>
            <div dir="ltr" className="font-mono text-[var(--avp-danger)] text-[11px]">
              {report.tamperedResult.reason}
            </div>
            <div className="text-[var(--avp-text-muted)] text-[11px]">
              نتیجه: رد امضای جعلی بدون نیاز به سرور
            </div>
          </div>

          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[var(--avp-text-secondary)]">سیاست عدم گروگان‌گیری داده</span>
              <CheckCircle2 className="w-4 h-4 text-[var(--avp-accent-text)]" aria-hidden="true" />
            </div>
            <div dir="ltr" className="font-mono text-[var(--avp-warning-text)] text-[11px]">
              {report.expiredResult.reason}
            </div>
            <div className="text-[var(--avp-text-muted)] text-[11px]">
              خروجی و گروه A باز می‌ماند:{' '}
              <span dir="ltr" className="font-mono text-[var(--avp-text)]">
                {report.expiredResult.allowedModelTiers.join(', ')}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-shell)] space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[var(--avp-text-secondary)]">رجیستری مدل ۸MB امضاشده</span>
              <CheckCircle2 className="w-4 h-4 text-[var(--avp-success-text)]" aria-hidden="true" />
            </div>
            <div dir="ltr" className="font-mono text-[var(--avp-success-text)] text-[11px]">
              whisper-fa-int8: {report.manifestResult.reason} (
              {report.manifestResult.manifest?.chunks.length ?? 0} chunks)
            </div>
            <div dir="ltr" className="font-mono text-[var(--avp-danger)] text-[11px]">
              legacy-denoise-v0: {report.revokedResult.reason}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
