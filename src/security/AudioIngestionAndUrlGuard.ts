/**
 * PHASE 14B.1 — AUDIO INGESTION SANDBOX LIMITS & STRICT ANTI-SSRF URL GUARD
 * Extends Phase 8 AudioSecurityGuard rather than duplicating magic-byte logic.
 */

import crypto from 'node:crypto';
import { AudioSecurityGuard } from './AudioSecurityGuard';
import type {
  AudioIngestionInspectionResult,
  AudioIngestionSecurityLimits,
  RemoteUrlPolicy,
  SsrfValidationDecision,
} from './SpeechSecurityContracts';

export const DEFAULT_AUDIO_SECURITY_LIMITS: AudioIngestionSecurityLimits = {
  maxUploadBytes: 200 * 1024 * 1024, // 200 MB API limit (2 GB desktop cap lives in AudioSecurityGuard)
  maxDurationSeconds: 7200, // 2h API ceiling
  maxSampleRateHz: 192000,
  minSampleRateHz: 8000,
  maxChannels: 8,
  maxDecodedSamples: 192000 * 120 * 8,
  maxCompressionExpansionRatio: AudioSecurityGuard.MAX_DECODE_EXPANSION_RATIO,
};

export const DEFAULT_REMOTE_URL_POLICY: RemoteUrlPolicy = {
  remoteFetchEnabled: false, // Secure-by-default: disabled unless explicitly opted in
  allowedHostPatterns: [],
  requireTls: true,
  maxRedirects: 0,
  maxResponseBytes: 50 * 1024 * 1024,
  requestTimeoutMs: 5000,
};

export function sanitizeAudioFilename(rawFilename: string): string {
  const base = rawFilename.replace(/\\/g, '/').split('/').pop() ?? 'audio.bin';
  const cleaned = base
    .replace(/\0/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/[^a-zA-Z0-9._\u0600-\u06FF-]/g, '_')
    .slice(0, 120);
  return cleaned || 'sanitized_audio.bin';
}

export class AudioIngestionAndUrlGuard {
  /**
   * Deep inspection of untrusted audio bytes, container magic bytes, declared geometry,
   * decompression bomb expansion limits, and sample-count caps.
   */
  public static inspectUploadedAudio(params: {
    filename: string;
    bytes: Uint8Array;
    declaredSampleRateHz: number;
    declaredChannels: number;
    declaredDurationSeconds: number;
    limits?: Partial<AudioIngestionSecurityLimits>;
  }): AudioIngestionInspectionResult {
    const limits: AudioIngestionSecurityLimits = { ...DEFAULT_AUDIO_SECURITY_LIMITS, ...params.limits };
    const sanitizedFilename = sanitizeAudioFilename(params.filename);
    const sha256 = crypto.createHash('sha256').update(params.bytes).digest('hex');

    if (
      !Number.isFinite(limits.maxUploadBytes) ||
      limits.maxUploadBytes < 0 ||
      params.bytes.byteLength > limits.maxUploadBytes
    ) {
      return {
        accepted: false,
        detectedContainer: null,
        sanitizedFilename,
        sampleRateHz: params.declaredSampleRateHz,
        channels: params.declaredChannels,
        durationSeconds: params.declaredDurationSeconds,
        decodedSampleCount: 0,
        byteSize: params.bytes.byteLength,
        sha256,
        rejectionCode: 'UPLOAD_SIZE_LIMIT_EXCEEDED',
        rejectionReason: `Payload ${params.bytes.byteLength} bytes exceeds max ${limits.maxUploadBytes} bytes.`,
      };
    }

    let container: AudioIngestionInspectionResult['detectedContainer'] = null;
    try {
      container = AudioSecurityGuard.verifyMagicBytes(params.bytes.subarray(0, 16), params.bytes.byteLength);
    } catch (err) {
      return {
        accepted: false,
        detectedContainer: null,
        sanitizedFilename,
        sampleRateHz: params.declaredSampleRateHz,
        channels: params.declaredChannels,
        durationSeconds: params.declaredDurationSeconds,
        decodedSampleCount: 0,
        byteSize: params.bytes.byteLength,
        sha256,
        rejectionCode: 'SPOOFED_OR_UNSUPPORTED_MAGIC_BYTES',
        rejectionReason: AudioSecurityGuard.sanitizeErrorForTelemetry(String(err)),
      };
    }

    // Structural RIFF/WAV header size check against truncated/craftbomb RIFF payloads
    if (container === 'WAV') {
      if (params.bytes.byteLength < 44) {
        return {
          accepted: false,
          detectedContainer: container,
          sanitizedFilename,
          sampleRateHz: params.declaredSampleRateHz,
          channels: params.declaredChannels,
          durationSeconds: params.declaredDurationSeconds,
          decodedSampleCount: 0,
          byteSize: params.bytes.byteLength,
          sha256,
          rejectionCode: 'MALFORMED_TRUNCATED_WAV_HEADER',
          rejectionReason: 'WAV container header smaller than 44 bytes.',
        };
      }
      const view = new DataView(params.bytes.buffer, params.bytes.byteOffset, params.bytes.byteLength);
      const declaredRiffSize = view.getUint32(4, true);
      if (declaredRiffSize > params.bytes.byteLength * 4 && declaredRiffSize > 100_000_000) {
        return {
          accepted: false,
          detectedContainer: container,
          sanitizedFilename,
          sampleRateHz: params.declaredSampleRateHz,
          channels: params.declaredChannels,
          durationSeconds: params.declaredDurationSeconds,
          decodedSampleCount: 0,
          byteSize: params.bytes.byteLength,
          sha256,
          rejectionCode: 'MALFORMED_WAV_RIFF_LENGTH',
          rejectionReason: `Declared RIFF chunk length (${declaredRiffSize}) vastly exceeds payload size.`,
        };
      }
    }

    if (
      !Number.isFinite(params.declaredSampleRateHz) ||
      params.declaredSampleRateHz < limits.minSampleRateHz ||
      params.declaredSampleRateHz > limits.maxSampleRateHz
    ) {
      return {
        accepted: false,
        detectedContainer: container,
        sanitizedFilename,
        sampleRateHz: params.declaredSampleRateHz,
        channels: params.declaredChannels,
        durationSeconds: params.declaredDurationSeconds,
        decodedSampleCount: 0,
        byteSize: params.bytes.byteLength,
        sha256,
        rejectionCode: 'SAMPLE_RATE_OUT_OF_BOUNDS',
        rejectionReason: `Sample rate ${params.declaredSampleRateHz} Hz outside [${limits.minSampleRateHz}..${limits.maxSampleRateHz}].`,
      };
    }

    if (
      !Number.isInteger(params.declaredChannels) ||
      params.declaredChannels < 1 ||
      params.declaredChannels > limits.maxChannels
    ) {
      return {
        accepted: false,
        detectedContainer: container,
        sanitizedFilename,
        sampleRateHz: params.declaredSampleRateHz,
        channels: params.declaredChannels,
        durationSeconds: params.declaredDurationSeconds,
        decodedSampleCount: 0,
        byteSize: params.bytes.byteLength,
        sha256,
        rejectionCode: 'CHANNEL_COUNT_OUT_OF_BOUNDS',
        rejectionReason: `Channel count ${params.declaredChannels} outside [1..${limits.maxChannels}].`,
      };
    }

    if (
      !Number.isFinite(params.declaredDurationSeconds) ||
      !Number.isFinite(limits.maxDurationSeconds) ||
      params.declaredDurationSeconds > limits.maxDurationSeconds ||
      params.declaredDurationSeconds <= 0
    ) {
      return {
        accepted: false,
        detectedContainer: container,
        sanitizedFilename,
        sampleRateHz: params.declaredSampleRateHz,
        channels: params.declaredChannels,
        durationSeconds: params.declaredDurationSeconds,
        decodedSampleCount: 0,
        byteSize: params.bytes.byteLength,
        sha256,
        rejectionCode: 'DURATION_LIMIT_EXCEEDED',
        rejectionReason: `Duration ${params.declaredDurationSeconds}s exceeds ceiling (${limits.maxDurationSeconds}s).`,
      };
    }

    const decodedSampleCount = Math.round(
      params.declaredDurationSeconds * params.declaredSampleRateHz * params.declaredChannels
    );
    if (
      !Number.isFinite(decodedSampleCount) ||
      !Number.isFinite(limits.maxDecodedSamples) ||
      decodedSampleCount > limits.maxDecodedSamples
    ) {
      return {
        accepted: false,
        detectedContainer: container,
        sanitizedFilename,
        sampleRateHz: params.declaredSampleRateHz,
        channels: params.declaredChannels,
        durationSeconds: params.declaredDurationSeconds,
        decodedSampleCount,
        byteSize: params.bytes.byteLength,
        sha256,
        rejectionCode: 'DECODED_SAMPLE_CAP_EXCEEDED',
        rejectionReason: `Decoded samples ${decodedSampleCount} exceeds memory guard ${limits.maxDecodedSamples}.`,
      };
    }

    try {
      AudioSecurityGuard.assertSafeDecodedDuration(
        params.declaredDurationSeconds,
        params.bytes.byteLength,
        params.declaredSampleRateHz,
        params.declaredChannels
      );
    } catch (err) {
      return {
        accepted: false,
        detectedContainer: container,
        sanitizedFilename,
        sampleRateHz: params.declaredSampleRateHz,
        channels: params.declaredChannels,
        durationSeconds: params.declaredDurationSeconds,
        decodedSampleCount,
        byteSize: params.bytes.byteLength,
        sha256,
        rejectionCode: 'DECOMPRESSION_BOMB_DETECTED',
        rejectionReason: AudioSecurityGuard.sanitizeErrorForTelemetry(String(err)),
      };
    }

    return {
      accepted: true,
      detectedContainer: container,
      sanitizedFilename,
      sampleRateHz: params.declaredSampleRateHz,
      channels: params.declaredChannels,
      durationSeconds: params.declaredDurationSeconds,
      decodedSampleCount,
      byteSize: params.bytes.byteLength,
      sha256,
      rejectionCode: null,
      rejectionReason: null,
    };
  }

  /**
   * Strict Anti-SSRF validator for optional remote URL ingestion.
   * Disabled by default; even when enabled, unconditionally blocks private, loopback,
   * CGNAT, link-local, IPv6 local, and cloud metadata addresses.
   */
  public static validateRemoteAudioFetchUrl(
    rawUrl: string,
    policy: RemoteUrlPolicy = DEFAULT_REMOTE_URL_POLICY
  ): SsrfValidationDecision {
    if (!policy.remoteFetchEnabled) {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: null,
        blockedReasonCode: 'REMOTE_FETCH_DISABLED',
        explanation: 'Remote URL audio ingestion is disabled by default security policy.',
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: null,
        blockedReasonCode: 'INVALID_URL',
        explanation: 'Malformed remote media URL.',
      };
    }

    const scheme = parsed.protocol.toLowerCase();
    if (policy.requireTls ? scheme !== 'https:' : scheme !== 'https:' && scheme !== 'http:') {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: parsed.hostname,
        blockedReasonCode: 'UNSUPPORTED_SCHEME',
        explanation: `URL scheme '${scheme}' is forbidden; TLS https: is required.`,
      };
    }

    // Reject embedded credentials in URL (user:pass@host)
    if (parsed.username || parsed.password) {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: parsed.hostname,
        blockedReasonCode: 'INVALID_URL',
        explanation: 'Embedded URL credentials are not permitted.',
      };
    }

    const port = parsed.port ? Number(parsed.port) : scheme === 'https:' ? 443 : 80;
    if (port !== 443 && (policy.requireTls || port !== 80)) {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: parsed.hostname,
        blockedReasonCode: 'RESTRICTED_PORT',
        explanation: `Port ${port} is blocked; only standard TLS port 443 is allowed.`,
      };
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!host) {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: null,
        blockedReasonCode: 'INVALID_URL',
        explanation: 'URL must contain a valid hostname.',
      };
    }

    // Block known metadata and internal hostnames explicitly (after trailing-dot FQDN normalization)
    if (
      host === 'metadata.google.internal' ||
      host === 'metadata.goog' ||
      host === 'metadata' ||
      host === 'instance-data' ||
      host.endsWith('.internal') ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.localdomain')
    ) {
      const isMeta = host.includes('metadata') || host === 'instance-data';
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: host,
        blockedReasonCode: isMeta ? 'CLOUD_METADATA_ENDPOINT' : 'PRIVATE_OR_LOOPBACK_IP',
        explanation: `Blocked internal/metadata hostname: ${host}`,
      };
    }

    const classifyIpv4 = (candidate: string): 'INVALID' | 'METADATA' | 'PRIVATE' | 'PUBLIC' | null => {
      const ipv4Match = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (!ipv4Match) return null;
      const octets = ipv4Match.slice(1).map((x) => Number(x));
      if (octets.some((o) => o < 0 || o > 255)) return 'INVALID';
      const [a, b, c] = octets;
      if (a === 169 && b === 254) return 'METADATA';
      const isPrivateOrLocal =
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224;
      return isPrivateOrLocal ? 'PRIVATE' : 'PUBLIC';
    };

    // Block IPv4 loopback, private, link-local, metadata, CGNAT, and 0.0.0.0/8
    const v4Class = classifyIpv4(host);
    if (v4Class === 'INVALID') {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: host,
        blockedReasonCode: 'INVALID_URL',
        explanation: 'Invalid IPv4 literal.',
      };
    }
    if (v4Class === 'METADATA') {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: host,
        blockedReasonCode: 'CLOUD_METADATA_ENDPOINT',
        explanation: 'Blocked link-local / cloud instance metadata IP (169.254.0.0/16).',
      };
    }
    if (v4Class === 'PRIVATE') {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: host,
        blockedReasonCode: 'PRIVATE_OR_LOOPBACK_IP',
        explanation: `Blocked private/loopback/reserved IPv4 address (${host}).`,
      };
    }

    // Block numeric decimal/hex/octal encoded IPv4 bypass tricks (e.g. 2130706433, 0x7f000001, 017700000001)
    if (/^(?:\d+|0x[0-9a-f]+|0[0-7]+)$/i.test(host)) {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: host,
        blockedReasonCode: 'PRIVATE_OR_LOOPBACK_IP',
        explanation: 'Numeric/hexadecimal/octal IPv4 host literal bypasses are blocked.',
      };
    }

    // Block IPv6 local/loopback/ULA/link-local/multicast/NAT64/IPv4-mapped literals
    // Only apply IPv6 rules when host is actually an IPv6 literal (contains ':') so public domains like fcdn.* are never misclassified
    if (host.includes(':')) {
      const decodeMappedPair = (hiHex: string, loHex: string): string => {
        const hi = parseInt(hiHex, 16);
        const lo = parseInt(loHex, 16);
        return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      };

      const v4MappedDotted = host.match(/^(?:::ffff:|0:0:0:0:0:ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/);
      if (v4MappedDotted) {
        const mappedClass = classifyIpv4(v4MappedDotted[1]);
        if (mappedClass !== 'PUBLIC') {
          return {
            allowed: false,
            normalizedUrl: null,
            resolvedHost: host,
            blockedReasonCode: mappedClass === 'METADATA' ? 'CLOUD_METADATA_ENDPOINT' : 'PRIVATE_OR_LOOPBACK_IP',
            explanation: `Blocked IPv4-mapped/NAT64 internal IPv6 literal (${host}).`,
          };
        }
      }

      const v4MappedHex = host.match(
        /^(?:::ffff:|0:0:0:0:0:ffff:|64:ff9b::|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
      );
      if (v4MappedHex) {
        const mappedClass = classifyIpv4(decodeMappedPair(v4MappedHex[1], v4MappedHex[2]));
        if (mappedClass !== 'PUBLIC') {
          return {
            allowed: false,
            normalizedUrl: null,
            resolvedHost: host,
            blockedReasonCode: mappedClass === 'METADATA' ? 'CLOUD_METADATA_ENDPOINT' : 'PRIVATE_OR_LOOPBACK_IP',
            explanation: `Blocked hex-encoded IPv4-mapped/NAT64 internal IPv6 literal (${host}).`,
          };
        }
      }

      const firstGroup = host.split(':')[0] || '0';
      const firstVal = parseInt(firstGroup, 16);
      const isPrivateV6 =
        host === '::1' ||
        host === '::' ||
        host === '0:0:0:0:0:0:0:1' ||
        host === '0:0:0:0:0:0:0:0' ||
        host.startsWith('100::') ||
        (!Number.isNaN(firstVal) &&
          ((firstVal & 0xfe00) === 0xfc00 || // fc00::/7 Unique Local
            (firstVal & 0xffc0) === 0xfe80 || // fe80::/10 Link-Local
            (firstVal & 0xffc0) === 0xfec0 || // fec0::/10 Deprecated Site-Local
            (firstVal & 0xff00) === 0xff00)); // ff00::/8 Multicast

      if (isPrivateV6) {
        return {
          allowed: false,
          normalizedUrl: null,
          resolvedHost: host,
          blockedReasonCode: 'PRIVATE_OR_LOOPBACK_IP',
          explanation: `Blocked internal IPv6 literal (${host}).`,
        };
      }
    }

    // Require allowlisted host match when allowlist is configured
    const hostAllowed =
      policy.allowedHostPatterns.length > 0 &&
      policy.allowedHostPatterns.some((pattern) => {
        const clean = pattern.trim().toLowerCase().replace(/\.+$/, '');
        if (!clean) return false;
        if (clean.startsWith('*.')) {
          const suffix = clean.slice(1);
          return !host.startsWith('.') && host.endsWith(suffix) && host.length > suffix.length;
        }
        return host === clean;
      });

    if (!hostAllowed) {
      return {
        allowed: false,
        normalizedUrl: null,
        resolvedHost: host,
        blockedReasonCode: 'HOSTNAME_NOT_ALLOWLISTED',
        explanation: `Host '${host}' is not in the tenant remote audio allowlist.`,
      };
    }

    return {
      allowed: true,
      normalizedUrl: parsed.toString(),
      resolvedHost: host,
      blockedReasonCode: null,
      explanation: `Allowed allowlisted HTTPS media endpoint '${host}'.`,
    };
  }
}
