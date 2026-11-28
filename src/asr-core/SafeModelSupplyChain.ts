/**
 * AVAPARDAZ — HARDENED MODEL SUPPLY-CHAIN DOWNLOAD, EXTRACTION & ATOMIC ACTIVATION (PHASE 1A.1)
 *
 * Security invariants:
 * - HTTPS-only network downloads with explicit documented host allowlist (zero invented hosts).
 * - Full redirect validation on every hop: blocks HTTP downgrades, non-allowlisted hosts,
 *   literal private/loopback IPs, and DNS-resolved private/loopback/link-local IPs (SSRF defense).
 * - Strips sensitive headers (Authorization, Cookie, Proxy-Authorization, X-Api-Key) on host change.
 * - Enforces byte ceilings both before (Content-Length) and DURING streaming (never trusts Content-Length alone).
 * - Enforces connect timeout, total download timeout, and real AbortSignal cancellation with cleanup.
 * - Verifies byte length, SHA-256 digest, and optional cryptographic signature before promoting .part file.
 * - Safe member-by-member tar.bz2 extraction (NEVER tarfile.extractall(), NEVER unsafe `tar -xjf` fallback):
 *   blocks absolute paths, `..` traversal, symlinks, hardlinks, devices, FIFOs, root escape, duplicates,
 *   file-count bombs, and streaming decompressed-size Tar Bombs.
 * - Atomic directory activation with rollback preserving any previously healthy installed model.
 */

import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Explicit allowlist grounded strictly in the real documented model/runtime URLs
 * in `LocalSherpaNeuralEngine.ts` (`github.com/k2-fsa/sherpa-onnx/releases/download/...`)
 * and GitHub Releases asset redirect hosts.
 */
export const ALLOWED_MODEL_DOWNLOAD_HOSTS: readonly string[] = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export type ModelSupplyChainErrorCode =
  | 'DOWNLOAD_INVALID_URL'
  | 'DOWNLOAD_INSECURE_PROTOCOL'
  | 'DOWNLOAD_URL_CREDENTIALS_FORBIDDEN'
  | 'DOWNLOAD_HOST_NOT_ALLOWED'
  | 'DOWNLOAD_PRIVATE_IP_BLOCKED'
  | 'DOWNLOAD_DNS_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'DOWNLOAD_HTTP_ERROR'
  | 'DOWNLOAD_MAX_BYTES_EXCEEDED'
  | 'DOWNLOAD_BYTE_LENGTH_MISMATCH'
  | 'DOWNLOAD_SHA256_MISMATCH'
  | 'DOWNLOAD_SIGNATURE_INVALID'
  | 'DOWNLOAD_TIMEOUT'
  | 'DOWNLOAD_ABORTED'
  | 'TAR_PATH_TRAVERSAL_BLOCKED'
  | 'TAR_SYMLINK_FORBIDDEN'
  | 'TAR_HARDLINK_FORBIDDEN'
  | 'TAR_SPECIAL_FILE_FORBIDDEN'
  | 'TAR_ESCAPE_ROOT_BLOCKED'
  | 'TAR_DUPLICATE_ENTRY_BLOCKED'
  | 'TAR_MANIFEST_MISMATCH'
  | 'TAR_TOO_MANY_FILES'
  | 'TAR_BOMB_LIMIT_EXCEEDED'
  | 'TAR_EXTRACTION_FAILED'
  | 'SAFE_TAR_EXTRACTOR_UNAVAILABLE'
  | 'ATOMIC_ACTIVATION_VALIDATION_FAILED'
  | 'ATOMIC_ACTIVATION_FAILED';

export class ModelSupplyChainError extends Error {
  public readonly code: ModelSupplyChainErrorCode;

  constructor(code: ModelSupplyChainErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ModelSupplyChainError';
    this.code = code;
  }
}

export interface DnsLookupEntry {
  readonly address: string;
  readonly family: number;
}

export type SafeDnsLookupFn = (hostname: string) => Promise<readonly DnsLookupEntry[]>;

export interface SafeDownloadOptions {
  readonly allowedHosts?: readonly string[];
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly expectedBytes?: number;
  readonly expectedSha256Hex?: string;
  readonly verifySignature?: (sha256Hex: string, filePath: string) => boolean | Promise<boolean>;
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly dnsLookup?: SafeDnsLookupFn;
  /** Test-only TLS agent (e.g. for local self-signed HTTPS integration tests). */
  readonly httpsAgent?: https.Agent;
  /**
   * Explicit local test escape hatch: permits connecting to a specific loopback host
   * (still HTTPS-only and still subject to redirect, maxBytes, timeout, and abort checks).
   * NEVER enabled by default in production.
   */
  readonly allowLoopbackForTestHost?: string | readonly string[];
}

export interface SafeDownloadResult {
  readonly destPath: string;
  readonly byteLength: number;
  readonly sha256Hex: string;
  readonly finalUrl: string;
  readonly redirectCount: number;
}

export interface SafeTarExtractOptions {
  readonly maxFiles?: number;
  readonly maxSingleFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly allowExecutablesInBin?: boolean;
  /** Materialize only relative symlinks whose source and target are regular files in the same lib directory. */
  readonly allowRelativeLibrarySymlinks?: boolean;
  /** Optional strict allowlist of normalized relative file paths permitted in archive. */
  readonly allowedRelativePaths?: readonly string[];
  readonly timeoutMs?: number;
  readonly pythonBin?: string;
}

export interface SafeTarExtractResult {
  readonly destDir: string;
  readonly extractedFiles: readonly string[];
  readonly totalBytes: number;
}

const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let val = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number.parseInt(p, 10);
    if (n < 0 || n > 255) return null;
    val = (val << 8) | n;
  }
  return val >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // fail-closed
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  // 0.0.0.0/8 (current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC1918)
  if (a === 10) return true;
  // 100.64.0.0/10 (CGNAT RFC6598)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local / Cloud Metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 168) return true;
  // 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved/Broadcast)
  if (a >= 224) return true;
  return false;
}

/**
 * Returns true if an IPv4 or IPv6 address is private, loopback, link-local,
 * multicast, reserved, or unparseable (fail-closed SSRF guard).
 */
export function isPrivateOrLoopbackIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version === 6) {
    const noZone = ip.split('%')[0];
    if (noZone === '::1' || noZone === '::' || noZone === '0:0:0:0:0:0:0:1' || noZone === '0:0:0:0:0:0:0:0') {
      return true;
    }
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (noZone.startsWith('::ffff:')) {
      const rest = noZone.slice(7);
      if (net.isIP(rest) === 4) {
        return isPrivateIpv4(rest);
      }
      const hexParts = rest.split(':');
      if (hexParts.length === 2) {
        const hi = Number.parseInt(hexParts[0], 16);
        const lo = Number.parseInt(hexParts[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          return isPrivateIpv4(v4);
        }
      }
      return true;
    }
    // Unique local fc00::/7 (fc.. / fd..), link-local fe80::/10 (fe80..febf), multicast ff00::/8
    const firstHextet = noZone.split(':')[0];
    const firstVal = Number.parseInt(firstHextet || '0', 16);
    if (!Number.isFinite(firstVal)) return true;
    if ((firstVal & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((firstVal & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((firstVal & 0xff00) === 0xff00) return true; // ff00::/8
    return false;
  }
  return true;
}

async function defaultDnsLookup(hostname: string): Promise<readonly DnsLookupEntry[]> {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
}

export async function validateModelDownloadUrl(
  rawUrl: string,
  options?: Pick<SafeDownloadOptions, 'allowedHosts' | 'dnsLookup' | 'allowLoopbackForTestHost'>,
): Promise<{
  readonly parsedUrl: URL;
  readonly pinnedAddress: DnsLookupEntry;
}> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ModelSupplyChainError('DOWNLOAD_INVALID_URL', `Invalid download URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new ModelSupplyChainError(
      'DOWNLOAD_INSECURE_PROTOCOL',
      `Only HTTPS is permitted for model downloads (received ${parsed.protocol}).`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new ModelSupplyChainError(
      'DOWNLOAD_URL_CREDENTIALS_FORBIDDEN',
      'Embedded credentials in model download URLs are forbidden.',
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  const allowLoopbackHosts = options?.allowLoopbackForTestHost
    ? (Array.isArray(options.allowLoopbackForTestHost)
        ? options.allowLoopbackForTestHost
        : [options.allowLoopbackForTestHost]
      ).map((h) => h.trim().toLowerCase())
    : [];
  const isPermittedLoopbackTest = allowLoopbackHosts.includes(bareHost);

  const allowedSet = new Set(
    (options?.allowedHosts ?? ALLOWED_MODEL_DOWNLOAD_HOSTS).map((h) => h.trim().toLowerCase()),
  );
  if (!allowedSet.has(bareHost) && !isPermittedLoopbackTest) {
    throw new ModelSupplyChainError(
      'DOWNLOAD_HOST_NOT_ALLOWED',
      `Download host "${bareHost}" is not in the explicit model allowlist.`,
    );
  }

  // Block literal IP addresses (unless explicitly opted into controlled loopback test)
  const ipVer = net.isIP(bareHost);
  if (ipVer !== 0) {
    if (!isPermittedLoopbackTest) {
      throw new ModelSupplyChainError(
        'DOWNLOAD_PRIVATE_IP_BLOCKED',
        `Direct IP host "${bareHost}" is forbidden for model downloads.`,
      );
    }
    return {
      parsedUrl: parsed,
      pinnedAddress: { address: bareHost, family: ipVer },
    };
  }

  const lookupFn = options?.dnsLookup ?? defaultDnsLookup;
  let addresses: readonly DnsLookupEntry[];
  try {
    addresses = await lookupFn(bareHost);
  } catch (err) {
    throw new ModelSupplyChainError(
      'DOWNLOAD_DNS_FAILED',
      `DNS lookup failed for "${bareHost}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!addresses || addresses.length === 0) {
    throw new ModelSupplyChainError('DOWNLOAD_DNS_FAILED', `No DNS records resolved for "${bareHost}".`);
  }

  for (const addr of addresses) {
    if (!isPermittedLoopbackTest && isPrivateOrLoopbackIp(addr.address)) {
      throw new ModelSupplyChainError(
        'DOWNLOAD_PRIVATE_IP_BLOCKED',
        `Resolved IP "${addr.address}" for host "${bareHost}" is private or loopback.`,
      );
    }
  }

  return {
    parsedUrl: parsed,
    pinnedAddress: addresses[0],
  };
}

function stripSensitiveHeadersOnHostChange(
  headers: Readonly<Record<string, string>>,
  prevHost: string | null,
  nextHost: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const changed = prevHost !== null && prevHost.toLowerCase() !== nextHost.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (changed && SENSITIVE_REDIRECT_HEADERS.has(k.toLowerCase())) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Hardened HTTPS model downloader with strict allowlist, redirect validation,
 * SSRF/private-IP blocking, byte ceiling (header + streaming), connect/total timeouts,
 * real AbortSignal cancellation, SHA-256 verification, and atomic .part promotion.
 */
export async function downloadFileWithRedirects(
  url: string,
  destPath: string,
  options?: SafeDownloadOptions,
): Promise<SafeDownloadResult> {
  const maxRedirects = Math.max(0, options?.maxRedirects ?? 5);
  const maxBytes = Math.max(1, options?.maxBytes ?? 200 * 1024 * 1024); // 200 MiB default ceiling
  const connectTimeoutMs = Math.max(50, options?.connectTimeoutMs ?? 15_000);
  const totalTimeoutMs = Math.max(100, options?.totalTimeoutMs ?? 180_000);
  const startedAtMs = Date.now();

  if (options?.signal?.aborted) {
    throw new ModelSupplyChainError('DOWNLOAD_ABORTED', 'Model download cancelled before start.');
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;

  const cleanupPart = () => {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  let currentUrl = url;
  let prevHost: string | null = null;
  let currentHeaders: Record<string, string> = {
    'User-Agent': 'avapardaz-native-asr-installer/1.1',
    ...(options?.headers ?? {}),
  };

  try {
    for (let redirectCount = 0; ; redirectCount++) {
      if (options?.signal?.aborted) {
        throw new ModelSupplyChainError('DOWNLOAD_ABORTED', 'Model download cancelled by caller.');
      }
      const remainingTotalMs = totalTimeoutMs - (Date.now() - startedAtMs);
      if (remainingTotalMs <= 0) {
        throw new ModelSupplyChainError('DOWNLOAD_TIMEOUT', 'Total model download timeout exceeded.');
      }

      const { parsedUrl, pinnedAddress } = await validateModelDownloadUrl(currentUrl, options);
      currentHeaders = stripSensitiveHeadersOnHostChange(currentHeaders, prevHost, parsedUrl.host);
      prevHost = parsedUrl.host;

      const hopResult = await new Promise<
        | { readonly kind: 'redirect'; readonly location: string }
        | { readonly kind: 'done'; readonly byteLength: number; readonly sha256Hex: string }
      >((resolve, reject) => {
        let settled = false;
        let outStream: fs.WriteStream | null = null;
        let reqRef: ReturnType<typeof https.get> | null = null;
        let totalTimer: ReturnType<typeof setTimeout> | null = null;
        let connectTimer: ReturnType<typeof setTimeout> | null = null;

        const finishErr = (err: Error) => {
          if (settled) return;
          settled = true;
          if (totalTimer) clearTimeout(totalTimer);
          if (connectTimer) clearTimeout(connectTimer);
          options?.signal?.removeEventListener('abort', onAbort);
          try {
            reqRef?.destroy();
          } catch {
            // ignore
          }
          const finalizeReject = () => {
            cleanupPart();
            reject(err);
          };
          if (outStream && !outStream.closed) {
            let done = false;
            const onStreamClosed = () => {
              if (done) return;
              done = true;
              finalizeReject();
            };
            outStream.once('close', onStreamClosed);
            setTimeout(onStreamClosed, 30);
            try {
              outStream.destroy();
            } catch {
              onStreamClosed();
            }
          } else {
            finalizeReject();
          }
        };

        const finishOk = (
          val:
            | { readonly kind: 'redirect'; readonly location: string }
            | { readonly kind: 'done'; readonly byteLength: number; readonly sha256Hex: string },
        ) => {
          if (settled) return;
          settled = true;
          if (totalTimer) clearTimeout(totalTimer);
          if (connectTimer) clearTimeout(connectTimer);
          options?.signal?.removeEventListener('abort', onAbort);
          resolve(val);
        };

        const onAbort = () => {
          finishErr(new ModelSupplyChainError('DOWNLOAD_ABORTED', 'Model download aborted.'));
        };
        if (options?.signal) {
          if (options.signal.aborted) {
            onAbort();
            return;
          }
          options.signal.addEventListener('abort', onAbort, { once: true });
        }

        totalTimer = setTimeout(() => {
          finishErr(new ModelSupplyChainError('DOWNLOAD_TIMEOUT', 'Total model download timeout exceeded.'));
        }, Math.max(10, remainingTotalMs));

        connectTimer = setTimeout(() => {
          finishErr(new ModelSupplyChainError('DOWNLOAD_TIMEOUT', 'Model download connect timeout exceeded.'));
        }, Math.min(connectTimeoutMs, Math.max(10, remainingTotalMs)));

        const req = https.get(
          {
            protocol: parsedUrl.protocol,
            hostname: parsedUrl.hostname,
            port: parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : 443,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            servername: net.isIP(parsedUrl.hostname) === 0 ? parsedUrl.hostname : undefined,
            headers: currentHeaders,
            agent: options?.httpsAgent,
            lookup: (_host, opts, cb) => {
              if (typeof opts === 'object' && opts !== null && opts.all) {
                (cb as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(null, [
                  { address: pinnedAddress.address, family: pinnedAddress.family },
                ]);
              } else {
                cb(null, pinnedAddress.address, pinnedAddress.family);
              }
            },
          },
          (res) => {
            if (connectTimer) {
              clearTimeout(connectTimer);
              connectTimer = null;
            }
            const status = res.statusCode ?? 0;

            if (status >= 300 && status < 400 && res.headers.location) {
              res.resume();
              if (redirectCount >= maxRedirects) {
                finishErr(
                  new ModelSupplyChainError(
                    'TOO_MANY_REDIRECTS',
                    `Exceeded maximum redirects (${maxRedirects}) downloading model.`,
                  ),
                );
                return;
              }
              let nextUrl: string;
              try {
                nextUrl = new URL(res.headers.location, parsedUrl).toString();
              } catch {
                finishErr(
                  new ModelSupplyChainError('DOWNLOAD_INVALID_URL', 'Invalid redirect Location header.'),
                );
                return;
              }
              finishOk({ kind: 'redirect', location: nextUrl });
              return;
            }

            if (status !== 200) {
              res.resume();
              finishErr(
                new ModelSupplyChainError(
                  'DOWNLOAD_HTTP_ERROR',
                  `Unexpected HTTP status ${status} downloading model.`,
                ),
              );
              return;
            }

            // Pre-check Content-Length if present (never trusted alone; enforced again during streaming)
            const rawCl = res.headers['content-length'];
            if (typeof rawCl === 'string' && rawCl.trim().length > 0) {
              const declaredBytes = Number.parseInt(rawCl, 10);
              if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
                finishErr(
                  new ModelSupplyChainError(
                    'DOWNLOAD_MAX_BYTES_EXCEEDED',
                    `Declared Content-Length (${declaredBytes}) exceeds limit (${maxBytes}).`,
                  ),
                );
                res.destroy();
                return;
              }
            }

            const hasher = crypto.createHash('sha256');
            let receivedBytes = 0;
            const out = fs.createWriteStream(partPath, { flags: 'w', mode: 0o600 });
            outStream = out;

            res.on('data', (chunk: Buffer) => {
              if (settled) return;
              receivedBytes += chunk.byteLength;
              if (receivedBytes > maxBytes) {
                finishErr(
                  new ModelSupplyChainError(
                    'DOWNLOAD_MAX_BYTES_EXCEEDED',
                    `Streamed download exceeded maxBytes ceiling (${maxBytes}).`,
                  ),
                );
                res.destroy();
                return;
              }
              hasher.update(chunk);
              if (!out.write(chunk)) {
                res.pause();
                out.once('drain', () => {
                  if (!settled) res.resume();
                });
              }
            });

            res.on('aborted', () => {
              finishErr(
                new ModelSupplyChainError('DOWNLOAD_ABORTED', 'Remote server aborted download stream.'),
              );
            });
            res.on('error', (err) => {
              finishErr(
                new ModelSupplyChainError(
                  'DOWNLOAD_HTTP_ERROR',
                  `Stream error: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
            });
            out.on('error', (err) => {
              finishErr(
                new ModelSupplyChainError(
                  'DOWNLOAD_HTTP_ERROR',
                  `Disk write error: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
            });
            res.on('end', () => {
              if (settled) return;
              out.end(() => {
                if (settled) return;
                finishOk({
                  kind: 'done',
                  byteLength: receivedBytes,
                  sha256Hex: hasher.digest('hex'),
                });
              });
            });
          },
        );

        reqRef = req;
        req.on('error', (err) => {
          finishErr(
            new ModelSupplyChainError(
              'DOWNLOAD_HTTP_ERROR',
              `Network request error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        });
      });

      if (hopResult.kind === 'redirect') {
        currentUrl = hopResult.location;
        continue;
      }

      if (hopResult.byteLength <= 0) {
        throw new ModelSupplyChainError('DOWNLOAD_BYTE_LENGTH_MISMATCH', 'Downloaded model archive is empty.');
      }
      if (options?.expectedBytes !== undefined && hopResult.byteLength !== options.expectedBytes) {
        throw new ModelSupplyChainError(
          'DOWNLOAD_BYTE_LENGTH_MISMATCH',
          `Expected ${options.expectedBytes} bytes, received ${hopResult.byteLength}.`,
        );
      }
      if (
        options?.expectedSha256Hex &&
        hopResult.sha256Hex.toLowerCase() !== options.expectedSha256Hex.trim().toLowerCase()
      ) {
        throw new ModelSupplyChainError(
          'DOWNLOAD_SHA256_MISMATCH',
          `Downloaded archive SHA-256 mismatch (expected ${options.expectedSha256Hex.toLowerCase()}, got ${hopResult.sha256Hex}).`,
        );
      }
      if (options?.verifySignature) {
        const sigOk = await options.verifySignature(hopResult.sha256Hex, partPath);
        if (!sigOk) {
          throw new ModelSupplyChainError(
            'DOWNLOAD_SIGNATURE_INVALID',
            'Downloaded model archive failed cryptographic signature verification.',
          );
        }
      }

      // Atomic promotion from verified .part file -> final destPath
      fs.renameSync(partPath, destPath);
      return {
        destPath,
        byteLength: hopResult.byteLength,
        sha256Hex: hopResult.sha256Hex,
        finalUrl: currentUrl,
        redirectCount,
      };
    }
  } catch (err) {
    cleanupPart();
    try {
      fs.rmSync(destPath, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Member-by-member Python streaming tar.bz2 extractor.
 * NEVER calls `tarfile.extractall()` and NEVER falls back to unsafe `tar -xjf`.
 */
const SAFE_TAR_BZ2_PYTHON_SCRIPT = `
import json, os, posixpath, stat, sys, tarfile

archive_path = sys.argv[1]
dest_dir = sys.argv[2]
max_files = int(sys.argv[3])
max_single_bytes = int(sys.argv[4])
max_total_bytes = int(sys.argv[5])
allow_exec_bin = sys.argv[6] == "1"
allow_relative_library_symlinks = sys.argv[7] == "1"
allowed_paths_json = sys.argv[8]
allowed_paths = set(json.loads(allowed_paths_json)) if allowed_paths_json else None

def fail(code, msg):
    sys.stderr.write(f"{code}: {msg}\\n")
    sys.exit(2)

os.makedirs(dest_dir, exist_ok=True)
root_real = os.path.realpath(dest_dir)
seen_files = set()
extracted_files = []
file_count = 0
total_bytes = 0
pending_library_symlinks = []

def assert_no_symlink_components(base_real, rel_parts):
    cur = base_real
    for part in rel_parts:
        cur = os.path.join(cur, part)
        if os.path.lexists(cur) and os.path.islink(cur):
            fail("TAR_ESCAPE_ROOT_BLOCKED", f"Symlink component encountered: {part}")

with tarfile.open(archive_path, "r:bz2") as tf:
    for member in tf:
        raw_name = member.name
        if not raw_name or "\\x00" in raw_name or "\\\\" in raw_name:
            fail("TAR_PATH_TRAVERSAL_BLOCKED", f"Illegal archive entry name: {raw_name!r}")

        if member.issym():
            if not allow_relative_library_symlinks:
                fail("TAR_SYMLINK_FORBIDDEN", f"Symlink entry forbidden: {raw_name}")
            if raw_name.startswith("/") or (len(raw_name) >= 2 and raw_name[1] == ":"):
                fail("TAR_PATH_TRAVERSAL_BLOCKED", f"Absolute symlink path forbidden: {raw_name}")
            if not member.linkname or "\\x00" in member.linkname or "\\\\" in member.linkname or member.linkname.startswith("/") or (len(member.linkname) >= 2 and member.linkname[1] == ":"):
                fail("TAR_PATH_TRAVERSAL_BLOCKED", f"Illegal symlink target: {member.linkname!r}")
            raw_parts = [p for p in raw_name.split("/") if p not in ("", ".")]
            link_parts = [p for p in member.linkname.split("/") if p not in ("", ".")]
            if any(p == ".." for p in raw_parts + link_parts):
                fail("TAR_PATH_TRAVERSAL_BLOCKED", f"Parent traversal in symlink: {raw_name} -> {member.linkname}")
            if len(raw_parts) < 2 or raw_parts[-2] != "lib" or not link_parts:
                fail("TAR_SYMLINK_FORBIDDEN", f"Only same-directory lib symlinks are allowed: {raw_name}")
            rel_norm = posixpath.join(*raw_parts)
            target_rel = posixpath.normpath(posixpath.join(posixpath.dirname(rel_norm), *link_parts))
            if posixpath.dirname(target_rel) != posixpath.dirname(rel_norm) or target_rel == rel_norm:
                fail("TAR_SYMLINK_FORBIDDEN", f"Symlink target must remain in the same lib directory: {raw_name}")
            target_path = os.path.realpath(os.path.join(root_real, *target_rel.split("/")))
            try:
                common = os.path.commonpath([root_real, target_path])
            except ValueError:
                fail("TAR_ESCAPE_ROOT_BLOCKED", f"Symlink escapes root: {raw_name}")
            if common != root_real or target_path == root_real:
                fail("TAR_ESCAPE_ROOT_BLOCKED", f"Symlink escapes root: {raw_name}")
            if rel_norm in seen_files:
                fail("TAR_DUPLICATE_ENTRY_BLOCKED", f"Duplicate archive entry: {rel_norm}")
            seen_files.add(rel_norm)
            file_count += 1
            if file_count > max_files:
                fail("TAR_TOO_MANY_FILES", f"Archive exceeds max file count ({max_files})")
            if allowed_paths is not None and rel_norm not in allowed_paths:
                fail("TAR_MANIFEST_MISMATCH", f"Unexpected symlink not in manifest: {rel_norm}")
            pending_library_symlinks.append((rel_norm, target_rel))
            continue
        if member.islnk():
            fail("TAR_HARDLINK_FORBIDDEN", f"Hardlink entry forbidden: {raw_name}")
        if member.ischr() or member.isblk() or member.isfifo() or member.isdev():
            fail("TAR_SPECIAL_FILE_FORBIDDEN", f"Special device/FIFO entry forbidden: {raw_name}")
        if not (member.isfile() or member.isdir()):
            fail("TAR_SPECIAL_FILE_FORBIDDEN", f"Unsupported tar entry type: {raw_name}")

        if raw_name.startswith("/") or (len(raw_name) >= 2 and raw_name[1] == ":"):
            fail("TAR_PATH_TRAVERSAL_BLOCKED", f"Absolute path forbidden: {raw_name}")

        # Split raw segments BEFORE normalization so sneaky "a/../b" or ".." is rejected explicitly
        raw_parts = [p for p in raw_name.split("/") if p not in ("", ".")]
        if any(p == ".." for p in raw_parts):
            fail("TAR_PATH_TRAVERSAL_BLOCKED", f"Parent traversal (..) forbidden: {raw_name}")

        if not raw_parts:
            if member.isdir():
                continue
            fail("TAR_PATH_TRAVERSAL_BLOCKED", f"Empty file path: {raw_name}")

        rel_norm = posixpath.join(*raw_parts)
        target_path = os.path.realpath(os.path.join(root_real, *raw_parts))
        try:
            common = os.path.commonpath([root_real, target_path])
        except ValueError:
            fail("TAR_ESCAPE_ROOT_BLOCKED", f"Entry escapes root: {raw_name}")
        if common != root_real or target_path == root_real:
            fail("TAR_ESCAPE_ROOT_BLOCKED", f"Entry resolves outside root: {raw_name}")

        if member.isdir():
            assert_no_symlink_components(root_real, raw_parts)
            os.makedirs(target_path, exist_ok=True)
            continue

        # Regular file checks
        file_count += 1
        if file_count > max_files:
            fail("TAR_TOO_MANY_FILES", f"Archive exceeds max file count ({max_files})")

        if rel_norm in seen_files:
            fail("TAR_DUPLICATE_ENTRY_BLOCKED", f"Duplicate archive entry: {rel_norm}")
        seen_files.add(rel_norm)

        if allowed_paths is not None and rel_norm not in allowed_paths:
            fail("TAR_MANIFEST_MISMATCH", f"Unexpected entry not in manifest: {rel_norm}")

        if member.size < 0 or member.size > max_single_bytes:
            fail("TAR_BOMB_LIMIT_EXCEEDED", f"Entry exceeds max single file bytes: {rel_norm}")
        if total_bytes + member.size > max_total_bytes:
            fail("TAR_BOMB_LIMIT_EXCEEDED", f"Archive exceeds max total uncompressed bytes ({max_total_bytes})")

        parent_parts = raw_parts[:-1]
        assert_no_symlink_components(root_real, parent_parts)
        parent_dir = os.path.join(root_real, *parent_parts) if parent_parts else root_real
        os.makedirs(parent_dir, exist_ok=True)

        assert_no_symlink_components(root_real, raw_parts)
        src = tf.extractfile(member)
        if src is None:
            fail("TAR_EXTRACTION_FAILED", f"Failed to read regular file stream: {rel_norm}")

        written_for_member = 0
        with open(target_path, "wb") as dst:
            while True:
                buf = src.read(65536)
                if not buf:
                    break
                written_for_member += len(buf)
                total_bytes += len(buf)
                if written_for_member > max_single_bytes or total_bytes > max_total_bytes:
                    fail("TAR_BOMB_LIMIT_EXCEEDED", f"Streamed uncompressed size exceeded ceiling on {rel_norm}")
                dst.write(buf)

        # Strip setuid/setgid/sticky bits; permit +x ONLY under bin/ when explicitly allowed
        is_in_bin = ("bin" in raw_parts[:-1]) and bool(member.mode & 0o111)
        safe_mode = 0o755 if (allow_exec_bin and is_in_bin) else 0o644
        os.chmod(target_path, safe_mode)
        extracted_files.append(rel_norm)

# Materialize narrowly-scoped lib symlink aliases as regular files. This avoids
# preserving filesystem links in the installed runtime while retaining expected dylib names.
for rel_link, rel_target in pending_library_symlinks:
    target_abs = os.path.realpath(os.path.join(root_real, *rel_target.split("/")))
    try:
        common = os.path.commonpath([root_real, target_abs])
    except ValueError:
        fail("TAR_ESCAPE_ROOT_BLOCKED", f"Symlink target escapes root: {rel_link}")
    if common != root_real or not os.path.isfile(target_abs) or os.path.islink(target_abs):
        fail("TAR_SYMLINK_FORBIDDEN", f"Symlink target must be an extracted regular file: {rel_link} -> {rel_target}")
    link_abs = os.path.join(root_real, *rel_link.split("/"))
    if os.path.lexists(link_abs):
        fail("TAR_DUPLICATE_ENTRY_BLOCKED", f"Symlink destination already exists: {rel_link}")
    target_size = os.path.getsize(target_abs)
    if target_size > max_single_bytes or total_bytes + target_size > max_total_bytes:
        fail("TAR_BOMB_LIMIT_EXCEEDED", f"Materialized symlink exceeds extraction byte limits: {rel_link}")
    with open(target_abs, "rb") as src, open(link_abs, "xb") as dst:
        while True:
            buf = src.read(65536)
            if not buf:
                break
            total_bytes += len(buf)
            if total_bytes > max_total_bytes:
                fail("TAR_BOMB_LIMIT_EXCEEDED", f"Materialized symlink exceeded total byte limit: {rel_link}")
            dst.write(buf)
    os.chmod(link_abs, 0o644)
    extracted_files.append(rel_link)

print(json.dumps({"extractedFiles": extracted_files, "totalBytes": total_bytes}))
`;

const KNOWN_TAR_ERROR_CODES: readonly ModelSupplyChainErrorCode[] = [
  'TAR_PATH_TRAVERSAL_BLOCKED',
  'TAR_SYMLINK_FORBIDDEN',
  'TAR_HARDLINK_FORBIDDEN',
  'TAR_SPECIAL_FILE_FORBIDDEN',
  'TAR_ESCAPE_ROOT_BLOCKED',
  'TAR_DUPLICATE_ENTRY_BLOCKED',
  'TAR_MANIFEST_MISMATCH',
  'TAR_TOO_MANY_FILES',
  'TAR_BOMB_LIMIT_EXCEEDED',
  'TAR_EXTRACTION_FAILED',
];

/**
 * Safely extracts a `.tar.bz2` archive into a controlled directory member-by-member.
 * Never invokes `tarfile.extractall()` and never falls back to unsafe `tar -xjf`.
 * Cleans up partial extracted output on any validation or extraction error.
 */
export async function extractTarBz2Safe(
  archivePath: string,
  destDir: string,
  options?: SafeTarExtractOptions,
): Promise<SafeTarExtractResult> {
  const maxFiles = Math.max(1, options?.maxFiles ?? 256);
  const maxSingleFileBytes = Math.max(1024, options?.maxSingleFileBytes ?? 128 * 1024 * 1024);
  const maxTotalBytes = Math.max(1024, options?.maxTotalBytes ?? 256 * 1024 * 1024);
  const allowExecBin = options?.allowExecutablesInBin ? '1' : '0';
  const allowRelativeLibrarySymlinks = options?.allowRelativeLibrarySymlinks ? '1' : '0';
  const allowedJson = options?.allowedRelativePaths ? JSON.stringify(options.allowedRelativePaths) : '';
  const timeoutMs = Math.max(1_000, options?.timeoutMs ?? 120_000);
  const pythonBin = options?.pythonBin ?? 'python3';

  fs.mkdirSync(destDir, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(destDir, '.avp-tar-stage-'));

  try {
    const { stdout } = await execFileAsync(
      pythonBin,
      [
        '-c',
        SAFE_TAR_BZ2_PYTHON_SCRIPT,
        archivePath,
        stageRoot,
        String(maxFiles),
        String(maxSingleFileBytes),
        String(maxTotalBytes),
        allowExecBin,
        allowRelativeLibrarySymlinks,
        allowedJson,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    const parsed = JSON.parse(stdout.trim()) as {
      extractedFiles?: string[];
      totalBytes?: number;
    };

    // Move validated top-level entries from isolated stageRoot into destDir
    for (const entry of fs.readdirSync(stageRoot)) {
      const from = path.join(stageRoot, entry);
      const to = path.join(destDir, entry);
      if (fs.existsSync(to)) {
        fs.rmSync(to, { recursive: true, force: true });
      }
      fs.renameSync(from, to);
    }

    return {
      destDir,
      extractedFiles: parsed.extractedFiles ?? [],
      totalBytes: parsed.totalBytes ?? 0,
    };
  } catch (err: unknown) {
    // Never fall back to unsafe `tar -xjf`! Fail closed and clean up staging directory.
    const e = err as { code?: string | number; stderr?: string; message?: string };
    if (e?.code === 'ENOENT') {
      throw new ModelSupplyChainError(
        'SAFE_TAR_EXTRACTOR_UNAVAILABLE',
        `Safe tar extractor (${pythonBin}) is unavailable; refusing unsafe tar fallback.`,
      );
    }
    const stderr = typeof e?.stderr === 'string' ? e.stderr : e?.message ?? String(err);
    for (const knownCode of KNOWN_TAR_ERROR_CODES) {
      if (stderr.includes(knownCode)) {
        throw new ModelSupplyChainError(knownCode, stderr.trim());
      }
    }
    throw new ModelSupplyChainError('TAR_EXTRACTION_FAILED', stderr.trim() || 'Archive extraction failed.');
  } finally {
    try {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Atomically activates a validated staged directory into `targetDir`,
 * preserving any previously healthy installation on failure and removing temporary artifacts.
 */
export async function activateDirectoryAtomically(params: {
  readonly stagedDir: string;
  readonly targetDir: string;
  readonly validateStaged: (stagedDir: string) => boolean | Promise<boolean>;
}): Promise<void> {
  const { stagedDir, targetDir, validateStaged } = params;
  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true });

  const suffix = `${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  const siblingStage = path.join(parentDir, `.avp-promote-${suffix}`);
  const backupDir = path.join(parentDir, `.avp-backup-${suffix}`);
  let movedOldToBackup = false;

  try {
    const valid = await validateStaged(stagedDir);
    if (!valid) {
      throw new ModelSupplyChainError(
        'ATOMIC_ACTIVATION_VALIDATION_FAILED',
        'Staged model directory failed integrity or structure validation before activation.',
      );
    }

    // Place staged directory on same filesystem as targetDir for atomic rename
    try {
      fs.renameSync(stagedDir, siblingStage);
    } catch {
      fs.cpSync(stagedDir, siblingStage, { recursive: true, verbatimSymlinks: false });
      fs.rmSync(stagedDir, { recursive: true, force: true });
    }

    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      movedOldToBackup = true;
    }

    fs.renameSync(siblingStage, targetDir);

    if (movedOldToBackup && fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  } catch (err) {
    // Roll back to previous healthy installation if it was moved aside
    if (movedOldToBackup && fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
      try {
        fs.renameSync(backupDir, targetDir);
      } catch {
        // best-effort rollback
      }
    }
    try {
      fs.rmSync(siblingStage, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (err instanceof ModelSupplyChainError) throw err;
    throw new ModelSupplyChainError(
      'ATOMIC_ACTIVATION_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }
}
