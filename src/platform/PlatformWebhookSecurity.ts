/**
 * AVP-PLATFORM-CONTROL-PLANE-AUTHORIZATION-011
 * Webhook Destination Security, SSRF Prevention & Event Subscription Validation.
 *
 * Enforces strict HTTPS, DNS all-address public-IP verification, private/loopback/
 * link-local/metadata/ULA rejection, and explicit development-only sandbox allowlisting.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import {
  ALL_PUBLIC_WEBHOOK_EVENTS,
  type PublicWebhookEventType,
} from './PlatformContractsAndSchemas';

export const MAX_WEBHOOK_ENDPOINTS_PER_ORGANIZATION = 25;

export const DEFAULT_DEV_SANDBOX_WEBHOOK_HOSTS: readonly string[] = Object.freeze([
  'sandbox.avapardaz.local',
]);

export interface DnsAddressRecord {
  readonly address: string;
  readonly family: number;
}

export type WebhookDnsLookupFn = (hostname: string) => Promise<readonly DnsAddressRecord[]>;

export interface WebhookUrlValidationResult {
  readonly valid: boolean;
  readonly normalizedUrl?: string;
  readonly resolvedAddresses?: readonly string[];
  readonly reasonCode?: string;
  readonly message?: string;
}

const FORBIDDEN_HOST_SUFFIXES = ['.local', '.internal', '.test', '.localhost', '.home.arpa'];

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

export function isPrivateOrNonPublicIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return true;
  const [a, b, c] = octets;

  // 0.0.0.0/8 (unspecified / "this network")
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC1918)
  if (a === 10) return true;
  // 100.64.0.0/10 (CGNAT RFC6598)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved / Broadcast 255.255.255.255)
  if (a >= 224) return true;

  return false;
}

function expandIpv6ToWords(rawIp: string): number[] | null {
  const zoneIdx = rawIp.indexOf('%');
  const ip = (zoneIdx >= 0 ? rawIp.slice(0, zoneIdx) : rawIp).toLowerCase();

  // Handle IPv4-embedded suffix (e.g. ::ffff:127.0.0.1)
  let normalized = ip;
  const lastColon = ip.lastIndexOf(':');
  if (lastColon >= 0 && ip.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4Octets(ip.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    normalized = `${ip.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(':');
    const out: number[] = [];
    for (const t of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(t)) return null;
      out.push(parseInt(t, 16));
    }
    return out;
  };

  const left = parsePart(halves[0]);
  if (!left) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const right = parsePart(halves[1]);
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

export function isPrivateOrNonPublicIpv6(ip: string): boolean {
  const words = expandIpv6ToWords(ip);
  if (!words) return true;

  // :: (unspecified)
  if (words.every((w) => w === 0)) return true;
  // ::1 (loopback)
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;

  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    const v4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
    return isPrivateOrNonPublicIpv4(v4);
  }

  // fc00::/7 (Unique Local Addresses - ULA)
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (Link-local)
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  // fec0::/10 (Deprecated site-local)
  if ((words[0] & 0xffc0) === 0xfec0) return true;
  // ff00::/8 (Multicast)
  if ((words[0] & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 (Documentation)
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
  // 64:ff9b::/96 (NAT64 well-known prefix -> check embedded IPv4)
  if (
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0
  ) {
    const v4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
    return isPrivateOrNonPublicIpv4(v4);
  }

  return false;
}

export function isPrivateOrNonPublicIp(address: string): boolean {
  const cleaned = address.trim().replace(/^\[|\]$/g, '');
  const ipVersion = net.isIP(cleaned);
  if (ipVersion === 4) return isPrivateOrNonPublicIpv4(cleaned);
  if (ipVersion === 6) return isPrivateOrNonPublicIpv6(cleaned);
  return true;
}

async function defaultDnsLookup(hostname: string): Promise<readonly DnsAddressRecord[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
}

function getAllowedDevHosts(explicitHosts?: readonly string[]): ReadonlySet<string> {
  if (explicitHosts && explicitHosts.length > 0) {
    return new Set(explicitHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  }
  const envAllow = process.env.PLATFORM_DEV_WEBHOOK_ALLOWLIST;
  if (envAllow && envAllow.trim().length > 0) {
    return new Set(
      envAllow
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  return new Set(DEFAULT_DEV_SANDBOX_WEBHOOK_HOSTS);
}

/**
 * Validates a webhook destination URL against SSRF, private-network, and scheme rules.
 *
 * Production:
 * - Strictly requires HTTPS, rejects credentials/fragments, rejects localhost/internal/unqualified
 *   hostnames, rejects non-public IP literals, resolves DNS with `{ all: true }`, and rejects
 *   if ANY resolved IP is non-public (including mixed public/private DNS responses).
 *
 * Development:
 * - Permits explicitly allowlisted sandbox destinations (never active in production) and
 *   otherwise enforces the same public-HTTPS checks.
 */
export async function validateWebhookDestinationUrl(params: {
  readonly url: unknown;
  readonly isProduction: boolean;
  readonly allowedDevHosts?: readonly string[];
  readonly dnsLookup?: WebhookDnsLookupFn;
}): Promise<WebhookUrlValidationResult> {
  if (typeof params.url !== 'string' || params.url.trim().length === 0) {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_URL_REQUIRED',
      message: 'Webhook URL must be a non-empty string.',
    };
  }

  const rawUrl = params.url.trim();
  if (rawUrl.length > 2048 || /[\u0000-\u001f\u007f]/.test(rawUrl)) {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_URL_MALFORMED',
      message: 'Webhook URL contains control characters or exceeds maximum length.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_URL_MALFORMED',
      message: 'Webhook URL is not a valid URL.',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_HTTPS_REQUIRED',
      message: 'Webhook destination must use HTTPS.',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_CREDENTIALS_FORBIDDEN',
      message: 'Webhook URL must not contain embedded username or password.',
    };
  }

  if (parsed.hash) {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_FRAGMENT_FORBIDDEN',
      message: 'Webhook URL must not contain a fragment (#).',
    };
  }

  const rawHost = parsed.hostname.toLowerCase();
  const normalizedHost = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
  const unbracketedHost = normalizedHost.replace(/^\[|\]$/g, '');

  if (!unbracketedHost) {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_HOST_MISSING',
      message: 'Webhook URL must include a valid host.',
    };
  }

  // Explicitly configured development-only sandbox allowlist (NEVER applied in production)
  if (!params.isProduction) {
    const devHosts = getAllowedDevHosts(params.allowedDevHosts);
    if (devHosts.has(unbracketedHost)) {
      return {
        valid: true,
        normalizedUrl: parsed.toString(),
        resolvedAddresses: [],
      };
    }
  }

  if (unbracketedHost === 'localhost' || unbracketedHost.endsWith('.localhost')) {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_LOCALHOST_FORBIDDEN',
      message: 'Localhost webhook destinations are forbidden.',
    };
  }

  for (const suffix of FORBIDDEN_HOST_SUFFIXES) {
    if (unbracketedHost.endsWith(suffix)) {
      return {
        valid: false,
        reasonCode: 'WEBHOOK_PRIVATE_DOMAIN_FORBIDDEN',
        message: `Internal or reserved domain suffix '${suffix}' is forbidden for webhooks.`,
      };
    }
  }

  // Check if host is a direct IP literal (v4 or v6)
  const literalIpVersion = net.isIP(unbracketedHost);
  if (literalIpVersion === 4 || literalIpVersion === 6) {
    if (isPrivateOrNonPublicIp(unbracketedHost)) {
      return {
        valid: false,
        reasonCode: 'WEBHOOK_PRIVATE_IP_FORBIDDEN',
        message: 'Private, loopback, link-local, metadata, or reserved IP webhook destinations are forbidden.',
      };
    }
    return {
      valid: true,
      normalizedUrl: parsed.toString(),
      resolvedAddresses: [unbracketedHost],
    };
  }

  // Reject unqualified single-label hostnames (e.g. "redis", "metadata", "intranet")
  if (!unbracketedHost.includes('.')) {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_UNQUALIFIED_HOST_FORBIDDEN',
      message: 'Unqualified hostnames are forbidden for webhook destinations.',
    };
  }

  // Resolve ALL DNS addresses and verify every single returned address is strictly public
  const lookupFn = params.dnsLookup ?? defaultDnsLookup;
  let records: readonly DnsAddressRecord[];
  try {
    records = await lookupFn(unbracketedHost);
  } catch {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_DNS_LOOKUP_FAILED',
      message: 'Webhook hostname could not be resolved via DNS.',
    };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return {
      valid: false,
      reasonCode: 'WEBHOOK_DNS_EMPTY',
      message: 'Webhook hostname resolved to no IP addresses.',
    };
  }

  const resolvedAddresses: string[] = [];
  for (const rec of records) {
    const addr = typeof rec?.address === 'string' ? rec.address.trim() : '';
    if (!addr || isPrivateOrNonPublicIp(addr)) {
      return {
        valid: false,
        reasonCode: 'WEBHOOK_DNS_PRIVATE_ADDRESS_FORBIDDEN',
        message: 'Webhook hostname resolved to a private, loopback, link-local, or non-public IP address.',
      };
    }
    resolvedAddresses.push(addr);
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
    resolvedAddresses,
  };
}

export function validateWebhookEventSubscriptions(
  rawEvents: unknown,
):
  | { readonly valid: true; readonly events: PublicWebhookEventType[] }
  | { readonly valid: false; readonly message: string } {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return {
      valid: false,
      message: 'eventSubscriptions must be a non-empty array of valid webhook event types.',
    };
  }
  const seen = new Set<PublicWebhookEventType>();
  const validated: PublicWebhookEventType[] = [];
  for (const ev of rawEvents) {
    if (typeof ev !== 'string' || !ALL_PUBLIC_WEBHOOK_EVENTS.has(ev as PublicWebhookEventType)) {
      return {
        valid: false,
        message: `Unrecognized webhook event type '${String(ev)}'.`,
      };
    }
    const typed = ev as PublicWebhookEventType;
    if (seen.has(typed)) {
      return {
        valid: false,
        message: `Duplicate webhook event subscription '${typed}'.`,
      };
    }
    seen.add(typed);
    validated.push(typed);
  }
  return { valid: true, events: validated };
}
