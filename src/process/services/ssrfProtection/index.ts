/**
 * @license Apache-2.0
 * SSRF protection — validates URLs before agent-initiated requests.
 * Blocks private IPs, dangerous schemes, and DNS rebinding attacks.
 * Inspired by NVIDIA NemoClaw's SSRF defense layer.
 */

import dns from 'dns';
import { URL } from 'url';
import net from 'net';

// ── Blocked IP ranges (RFC1918, loopback, link-local, CGNAT) ─────────────────

/** IPv4 CIDR ranges that are never reachable by agents */
const PRIVATE_IPV4_RANGES: Array<{ network: number; mask: number; label: string }> = [
  { network: 0x7f000000, mask: 0xff000000, label: '127.0.0.0/8 (loopback)' },
  { network: 0x0a000000, mask: 0xff000000, label: '10.0.0.0/8 (private)' },
  { network: 0xac100000, mask: 0xfff00000, label: '172.16.0.0/12 (private)' },
  { network: 0xc0a80000, mask: 0xffff0000, label: '192.168.0.0/16 (private)' },
  { network: 0xa9fe0000, mask: 0xffff0000, label: '169.254.0.0/16 (link-local)' },
  { network: 0x64400000, mask: 0xffc00000, label: '100.64.0.0/10 (CGNAT)' },
  { network: 0x00000000, mask: 0xff000000, label: '0.0.0.0/8 (unspecified)' },
];

/** IPv6 prefixes that are never reachable by agents */
const PRIVATE_IPV6_PREFIXES = ['::1', '::', 'fe80:', 'fc00:', 'fd00:', '::ffff:', '0:0:0:0:0:0:0:0', '0:0:0:0:0:0:0:1'];

/** URL schemes that agents may use (all others blocked) */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// ── Core validation functions ────────────────────────────────────────────────

/** Convert IPv4 dotted string to 32-bit integer */
function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Check if an IPv4 address falls within any private range */
function isPrivateIPv4(ip: string): string | null {
  const addr = ipv4ToInt(ip);
  for (const range of PRIVATE_IPV4_RANGES) {
    if ((addr & range.mask) === range.network) {
      return range.label;
    }
  }
  return null;
}

/** Check if an IPv6 address is private/link-local/loopback/unspecified */
function isPrivateIPv6(ip: string): string | null {
  const normalized = ip.toLowerCase().trim();

  // Exact match: all-zeros (unspecified address)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') {
    return ':: (unspecified IPv6)';
  }

  // Exact match: loopback
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return '::1 (loopback IPv6)';
  }

  // Prefix match: link-local, unique-local, IPv4-mapped
  const prefixRules = ['fe80:', 'fc00:', 'fd00:', '::ffff:'];
  for (const prefix of prefixRules) {
    if (normalized.startsWith(prefix)) {
      return `${prefix} (private IPv6)`;
    }
  }

  return null;
}

/**
 * Extract IPv4 from IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1).
 * Returns the IPv4 part if mapped, null otherwise.
 */
function extractMappedIPv4(ip: string): string | null {
  const match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return match ? match[1] : null;
}

/**
 * Check if an IP address is private (IPv4 or IPv6).
 */
export function isPrivateIp(ip: string): boolean {
  // Handle IPv4-mapped IPv6
  const mappedV4 = extractMappedIPv4(ip);
  if (mappedV4) return isPrivateIPv4(mappedV4) !== null;

  if (net.isIPv4(ip)) return isPrivateIPv4(ip) !== null;
  if (net.isIPv6(ip)) return isPrivateIPv6(ip) !== null;
  return false;
}

/**
 * Validate a URL for SSRF safety.
 * Checks scheme, parses hostname, and optionally validates IP if hostname is numeric.
 */
export function validateUrl(url: string): { safe: boolean; reason?: string } {
  // Must be a valid URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: `Invalid URL: ${url}` };
  }

  // Scheme check
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { safe: false, reason: `Blocked scheme: ${parsed.protocol} (only http/https allowed)` };
  }

  // Empty hostname
  if (!parsed.hostname) {
    return { safe: false, reason: 'Empty hostname' };
  }

  // If hostname is a raw IP, validate immediately
  if (net.isIP(parsed.hostname)) {
    if (isPrivateIp(parsed.hostname)) {
      return { safe: false, reason: `Connections to internal networks are not allowed (${parsed.hostname})` };
    }
  }

  // Block common metadata endpoints
  const metadataHosts = ['metadata.google.internal', 'metadata.aws.internal', '169.254.169.254'];
  if (metadataHosts.includes(parsed.hostname)) {
    return { safe: false, reason: `Blocked metadata endpoint: ${parsed.hostname}` };
  }

  return { safe: true };
}

/**
 * Resolve a hostname via DNS and validate all returned IP addresses.
 * Catches DNS rebinding attacks where a hostname resolves to a private IP.
 */
export async function validateDnsResolution(
  hostname: string
): Promise<{ safe: boolean; resolvedIps: string[]; reason?: string }> {
  // Skip DNS resolution for raw IPs
  if (net.isIP(hostname)) {
    const priv = isPrivateIp(hostname);
    return {
      safe: !priv,
      resolvedIps: [hostname],
      reason: priv ? `Connections to internal networks are not allowed (${hostname})` : undefined,
    };
  }

  return new Promise((resolve) => {
    dns.resolve(hostname, (err, addresses) => {
      if (err) {
        // DNS failure — block to be safe
        resolve({ safe: false, resolvedIps: [], reason: `DNS resolution failed for ${hostname}: ${err.code}` });
        return;
      }

      const resolvedIps = addresses;
      for (const ip of resolvedIps) {
        if (isPrivateIp(ip)) {
          resolve({
            safe: false,
            resolvedIps,
            reason: `DNS rebinding detected: ${hostname} resolved to private IP ${ip}`,
          });
          return;
        }
      }

      resolve({ safe: true, resolvedIps });
    });
  });
}

/**
 * Full SSRF validation pipeline: URL validation + optional DNS check.
 */
export async function validateUrlFull(url: string): Promise<{ safe: boolean; reason?: string }> {
  const urlCheck = validateUrl(url);
  if (!urlCheck.safe) return urlCheck;

  const parsed = new URL(url);
  if (!net.isIP(parsed.hostname)) {
    const dnsCheck = await validateDnsResolution(parsed.hostname);
    if (!dnsCheck.safe) return { safe: false, reason: dnsCheck.reason };
  }

  return { safe: true };
}
