import { describe, expect, it } from 'vitest';
import {
  isDisallowedIpAddress,
  validateWebhookDestinationUrl,
  validateWebhookEventSubscriptions,
  type WebhookDnsLookupFn,
} from '../PlatformWebhookSecurity';

describe('AVP-011 PlatformWebhookSecurity SSRF & Destination Validation', () => {
  const publicDns: WebhookDnsLookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
  const mixedDns: WebhookDnsLookupFn = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.15', family: 4 },
  ];
  const metadataDns: WebhookDnsLookupFn = async () => [{ address: '169.254.169.254', family: 4 }];
  const ipv6LoopbackDns: WebhookDnsLookupFn = async () => [{ address: '::1', family: 6 }];
  const failingDns: WebhookDnsLookupFn = async () => {
    throw new Error('ENOTFOUND');
  };

  it('detects all private, loopback, link-local, metadata, CGNAT, multicast, and IPv6 ULA/mapped addresses', () => {
    const forbidden = [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:10.0.0.5',
    ];
    for (const ip of forbidden) {
      expect(isDisallowedIpAddress(ip), `Expected ${ip} to be disallowed`).toBe(true);
    }
    expect(isDisallowedIpAddress('93.184.216.34')).toBe(false);
    expect(isDisallowedIpAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('rejects non-HTTPS, embedded credentials, localhost, private IPs, and .local domains in production', async () => {
    const cases = [
      'http://hooks.example.com/asr',
      'https://user:pass@hooks.example.com/asr',
      'https://localhost/hooks',
      'https://127.0.0.1/hooks',
      'https://10.1.2.3/hooks',
      'https://192.168.1.50/hooks',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hooks',
      'https://[fc00::1]/hooks',
      'https://sandbox.avapardaz.local/hooks/asr',
    ];
    for (const url of cases) {
      const res = await validateWebhookDestinationUrl({
        rawUrl: url,
        isProduction: true,
        dnsLookup: publicDns,
      });
      expect(res.valid, `Expected ${url} to be rejected in production`).toBe(false);
    }
  });

  it('rejects mixed public+private DNS answers, metadata DNS answers, IPv6 loopback DNS, and DNS lookup failures', async () => {
    expect(
      (
        await validateWebhookDestinationUrl({
          rawUrl: 'https://rebind.example.com/hook',
          isProduction: true,
          dnsLookup: mixedDns,
        })
      ).valid
    ).toBe(false);

    expect(
      (
        await validateWebhookDestinationUrl({
          rawUrl: 'https://meta.example.com/hook',
          isProduction: true,
          dnsLookup: metadataDns,
        })
      ).valid
    ).toBe(false);

    expect(
      (
        await validateWebhookDestinationUrl({
          rawUrl: 'https://v6local.example.com/hook',
          isProduction: true,
          dnsLookup: ipv6LoopbackDns,
        })
      ).valid
    ).toBe(false);

    expect(
      (
        await validateWebhookDestinationUrl({
          rawUrl: 'https://unresolvable.example.com/hook',
          isProduction: true,
          dnsLookup: failingDns,
        })
      ).valid
    ).toBe(false);
  });

  it('accepts valid HTTPS public endpoints and explicitly allowlisted dev sandbox host in non-production', async () => {
    const okProd = await validateWebhookDestinationUrl({
      rawUrl: 'https://hooks.example.com/asr-events',
      isProduction: true,
      dnsLookup: publicDns,
    });
    expect(okProd.valid).toBe(true);

    const okDev = await validateWebhookDestinationUrl({
      rawUrl: 'https://sandbox.avapardaz.local/hooks/asr',
      isProduction: false,
      dnsLookup: failingDns, // Allowlisted dev host does not require public DNS
    });
    expect(okDev.valid).toBe(true);
  });

  it('validates webhook event subscriptions strictly against known events', () => {
    expect(validateWebhookEventSubscriptions(['transcription.completed']).valid).toBe(true);
    expect(validateWebhookEventSubscriptions([]).valid).toBe(false);
    expect(validateWebhookEventSubscriptions(['unknown.event']).valid).toBe(false);
  });
});
