import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock DNS resolution so tests do not make real network calls.
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

import { resolve4, resolve6 } from 'node:dns/promises';
import { isPrivateIpv4, isPrivateIpv6, isHostPrivate } from './ssrf-guard.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── isPrivateIpv4 ───────────────────────────────────────────────────────────

describe('isPrivateIpv4', () => {
  // RFC 1918: 10.0.0.0/8
  it.each([
    '10.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '10.1.2.3',
  ])('detects RFC-1918 10.x address %s as private', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  // RFC 1918: 172.16.0.0/12
  it.each([
    '172.16.0.0',
    '172.16.0.1',
    '172.31.255.255',
    '172.20.10.5',
  ])('detects RFC-1918 172.16-31.x address %s as private', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  it('allows 172.32.0.0 (outside /12 range)', () => {
    expect(isPrivateIpv4('172.32.0.0')).toBe(false);
  });

  it('allows 172.15.255.255 (below /12 range)', () => {
    expect(isPrivateIpv4('172.15.255.255')).toBe(false);
  });

  // RFC 1918: 192.168.0.0/16
  it.each([
    '192.168.0.0',
    '192.168.0.1',
    '192.168.255.255',
    '192.168.1.100',
  ])('detects RFC-1918 192.168.x address %s as private', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  // Loopback: 127.0.0.0/8
  it.each([
    '127.0.0.1',
    '127.0.0.0',
    '127.255.255.255',
    '127.1.2.3',
  ])('detects loopback address %s as private', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  // Link-local: 169.254.0.0/16
  it.each([
    '169.254.0.0',
    '169.254.0.1',
    '169.254.255.255',
    '169.254.169.254',
  ])('detects link-local address %s as private', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  // Shared address space (RFC 6598): 100.64.0.0/10
  it.each([
    '100.64.0.0',
    '100.64.0.1',
    '100.127.255.255',
    '100.100.50.25',
  ])('detects RFC-6598 shared address %s as private', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  it('allows 100.128.0.0 (outside /10 range)', () => {
    expect(isPrivateIpv4('100.128.0.0')).toBe(false);
  });

  // "This" network: 0.0.0.0/8
  it.each([
    '0.0.0.0',
    '0.0.0.1',
    '0.255.255.255',
  ])('detects "this" network address %s as private', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  // Reserved: 240.0.0.0/4
  it.each([
    '240.0.0.0',
    '240.0.0.1',
    '255.255.255.255',
    '248.128.64.32',
  ])('detects reserved address %s as private', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  // Public IPs
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '203.0.113.50',
    '74.125.224.72',
  ])('allows public address %s', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(false);
  });
});

// ── isPrivateIpv6 ───────────────────────────────────────────────────────────

describe('isPrivateIpv6', () => {
  it('detects loopback ::1 as private', () => {
    expect(isPrivateIpv6('::1')).toBe(true);
  });

  it('detects link-local fe80:: prefix as private', () => {
    expect(isPrivateIpv6('fe80::1')).toBe(true);
    expect(isPrivateIpv6('fe80::abcd:ef01:2345:6789')).toBe(true);
  });

  it('detects unique-local fc prefix as private', () => {
    expect(isPrivateIpv6('fc00::1')).toBe(true);
    expect(isPrivateIpv6('fcab::1234')).toBe(true);
  });

  it('detects unique-local fd prefix as private', () => {
    expect(isPrivateIpv6('fd00::1')).toBe(true);
    expect(isPrivateIpv6('fd12:3456:789a::1')).toBe(true);
  });

  it('detects IPv4-mapped IPv6 with private IPv4 as private', () => {
    expect(isPrivateIpv6('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIpv6('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
  });

  it('allows IPv4-mapped IPv6 with public IPv4', () => {
    expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIpv6('::ffff:93.184.216.34')).toBe(false);
  });

  it('allows public IPv6 addresses', () => {
    expect(isPrivateIpv6('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIpv6('2607:f8b0:4004:800::200e')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isPrivateIpv6('FE80::1')).toBe(true);
    expect(isPrivateIpv6('FC00::1')).toBe(true);
    expect(isPrivateIpv6('FD00::1')).toBe(true);
    expect(isPrivateIpv6('::FFFF:192.168.1.1')).toBe(true);
  });
});

// ── isHostPrivate ───────────────────────────────────────────────────────────

describe('isHostPrivate', () => {
  // Raw IPv4 literal — no DNS lookup needed
  it('detects a raw private IPv4 literal without DNS', async () => {
    const result = await isHostPrivate('192.168.1.1');
    expect(result).toBe(true);
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });

  it('allows a raw public IPv4 literal without DNS', async () => {
    const result = await isHostPrivate('8.8.8.8');
    expect(result).toBe(false);
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });

  // Raw IPv6 literal — no DNS lookup needed
  it('detects a raw IPv6 loopback literal without DNS', async () => {
    const result = await isHostPrivate('::1');
    expect(result).toBe(true);
    expect(resolve4).not.toHaveBeenCalled();
  });

  it('detects a bracketed IPv6 literal without DNS', async () => {
    const result = await isHostPrivate('[::1]');
    expect(result).toBe(true);
    expect(resolve4).not.toHaveBeenCalled();
  });

  it('allows a raw public IPv6 literal without DNS', async () => {
    const result = await isHostPrivate('2001:4860:4860::8888');
    expect(result).toBe(false);
    expect(resolve4).not.toHaveBeenCalled();
  });

  // DNS resolution — hostname resolves to private IP
  it('blocks a hostname that resolves to a private IPv4', async () => {
    vi.mocked(resolve4).mockResolvedValue(['10.0.0.1']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const result = await isHostPrivate('evil.example.com');
    expect(result).toBe(true);
  });

  it('blocks a hostname that resolves to a private IPv6', async () => {
    vi.mocked(resolve4).mockResolvedValue([]);
    vi.mocked(resolve6).mockResolvedValue(['fe80::1']);

    const result = await isHostPrivate('internal.example.com');
    expect(result).toBe(true);
  });

  // DNS resolution — hostname resolves to public IP
  it('allows a hostname that resolves to a public IPv4', async () => {
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const result = await isHostPrivate('example.com');
    expect(result).toBe(false);
  });

  it('allows a hostname that resolves to a public IPv6', async () => {
    vi.mocked(resolve4).mockResolvedValue([]);
    vi.mocked(resolve6).mockResolvedValue(['2001:4860:4860::8888']);

    const result = await isHostPrivate('google-v6.example.com');
    expect(result).toBe(false);
  });

  // Mixed results — if any resolved IP is private, block
  it('blocks when one of multiple resolved IPs is private', async () => {
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34', '192.168.1.1']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const result = await isHostPrivate('mixed.example.com');
    expect(result).toBe(true);
  });

  // Unresolvable hostname — blocked as safety measure
  it('blocks an unresolvable hostname (no A or AAAA records)', async () => {
    vi.mocked(resolve4).mockRejectedValue(new Error('ENOTFOUND'));
    vi.mocked(resolve6).mockRejectedValue(new Error('ENOTFOUND'));

    const result = await isHostPrivate('nonexistent.invalid');
    expect(result).toBe(true);
  });

  // Partial resolution failures are tolerated
  it('allows when only v4 resolves to public and v6 fails', async () => {
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(resolve6).mockRejectedValue(new Error('ENOTFOUND'));

    const result = await isHostPrivate('v4only.example.com');
    expect(result).toBe(false);
  });

  it('allows when only v6 resolves to public and v4 fails', async () => {
    vi.mocked(resolve4).mockRejectedValue(new Error('ENOTFOUND'));
    vi.mocked(resolve6).mockResolvedValue(['2001:4860:4860::8888']);

    const result = await isHostPrivate('v6only.example.com');
    expect(result).toBe(false);
  });
});
