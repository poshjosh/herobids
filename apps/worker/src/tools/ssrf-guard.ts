import { resolve4, resolve6 } from 'node:dns/promises';

// RFC 1918 + loopback + link-local CIDR ranges blocked for SSRF prevention.
const PRIVATE_RANGES: Array<{ prefix: number[]; bits: number }> = [
  { prefix: [10], bits: 8 },
  { prefix: [172, 16], bits: 12 },
  { prefix: [192, 168], bits: 16 },
  { prefix: [127], bits: 8 },
  { prefix: [169, 254], bits: 16 },
  { prefix: [100, 64], bits: 10 }, // Shared address space (RFC 6598)
  { prefix: [0], bits: 8 },         // "This" network
  { prefix: [240], bits: 4 },       // Reserved
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

export function isPrivateIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  for (const range of PRIVATE_RANGES) {
    const mask = ~((1 << (32 - range.bits)) - 1) >>> 0;
    const base = ipv4ToInt(range.prefix.concat(Array(4 - range.prefix.length).fill(0) as number[]).join('.'));
    if ((ipInt & mask) === (base & mask)) return true;
  }
  return false;
}

const PRIVATE_IPV6_PREFIXES = ['::1', 'fe80:', 'fc', 'fd'];

export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) — extract the IPv4 part and check it
  const ipv4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped?.[1]) {
    return isPrivateIpv4(ipv4Mapped[1]);
  }
  return PRIVATE_IPV6_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix));
}

export async function isHostPrivate(hostname: string): Promise<boolean> {
  // If the hostname is a raw IPv4 literal, check it directly without DNS.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return isPrivateIpv4(hostname);
  }
  // If the hostname is a raw IPv6 literal (with or without brackets), check directly.
  const ipv6Literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (ipv6Literal.includes(':')) {
    return isPrivateIpv6(ipv6Literal);
  }

  const results: string[] = [];
  try {
    const v4 = await resolve4(hostname);
    results.push(...v4);
  } catch {
    // hostname may not have A records
  }
  try {
    const v6 = await resolve6(hostname);
    results.push(...v6);
  } catch {
    // hostname may not have AAAA records
  }
  if (results.length === 0) {
    // Cannot resolve hostname — block as a safety measure
    return true;
  }
  return results.some((ip) => (ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip)));
}
