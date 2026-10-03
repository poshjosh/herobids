import { describe, expect, it } from 'vitest';
import { signRequest, type SigningIdentity } from '../sign.js';
import { createSigningFetch } from './mcp-signing-fetch.js';

const IDENTITY: SigningIdentity = { consumerId: 'herobids', keyId: 'current', secret: 'unit-secret' };
const MCP_PATH = '/internal/v1/mcp';
const BASE = 'http://boundary.unit.test';
const DEADLINE_AT = new Date(Date.now() + 30_000).toISOString();

const SIGNED_HEADER_NAMES = [
  'content-type',
  'x-traderton-consumer-id',
  'x-traderton-key-id',
  'x-traderton-timestamp',
  'x-traderton-signature',
  'x-request-deadline-at',
] as const;

describe('createSigningFetch', () => {
  it('produces exactly the headers signRequest produces for the same bytes', async () => {
    let seen: Headers | undefined;
    let seenBody: unknown;
    const signingFetch = createSigningFetch({
      identity: IDENTITY,
      signedPath: MCP_PATH,
      deadlineAt: DEADLINE_AT,
      signal: AbortSignal.timeout(10_000),
      fetchImpl: async (_input, init) => {
        seen = new Headers(init?.headers);
        seenBody = init?.body;
        return new Response(null, { status: 202 });
      },
    });

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't' } });
    await signingFetch(new URL(MCP_PATH, BASE), { method: 'POST', body });

    // The body is forwarded unchanged (the bytes that were hashed).
    expect(seenBody).toBe(body);
    const timestamp = seen?.get('x-traderton-timestamp') ?? '';
    const expected = signRequest(IDENTITY, {
      method: 'POST',
      path: MCP_PATH,
      rawBody: Buffer.from(body, 'utf8'),
      timestamp,
      deadlineAt: DEADLINE_AT,
    });
    const actual = Object.fromEntries(SIGNED_HEADER_NAMES.map((name) => [name, seen?.get(name)]));
    expect(actual).toStrictEqual(expected);
  });

  it('refuses to sign a request for a path other than the MCP path', async () => {
    const signingFetch = createSigningFetch({
      identity: IDENTITY,
      signedPath: MCP_PATH,
      deadlineAt: DEADLINE_AT,
      signal: AbortSignal.timeout(10_000),
    });
    await expect(signingFetch(new URL('/elsewhere', BASE), { method: 'POST', body: '{}' })).rejects.toThrow(
      /refusing to sign/,
    );
  });

  it('throws on a non-string request body', async () => {
    const signingFetch = createSigningFetch({
      identity: IDENTITY,
      signedPath: MCP_PATH,
      deadlineAt: DEADLINE_AT,
      signal: AbortSignal.timeout(10_000),
    });
    await expect(
      signingFetch(new URL(MCP_PATH, BASE), { method: 'POST', body: new Uint8Array([123, 125]) }),
    ).rejects.toThrow(TypeError);
  });

  it('aborts the request when the exchange signal fires', async () => {
    const exchange = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const signingFetch = createSigningFetch({
      identity: IDENTITY,
      signedPath: MCP_PATH,
      deadlineAt: DEADLINE_AT,
      signal: exchange.signal,
      fetchImpl: async (_input, init) => {
        seenSignal = init?.signal ?? undefined;
        return new Response(null, { status: 202 });
      },
    });

    await signingFetch(new URL(MCP_PATH, BASE), { method: 'POST', body: '{}', signal: new AbortController().signal });
    expect(seenSignal?.aborted).toBe(false);
    exchange.abort();
    expect(seenSignal?.aborted).toBe(true);
  });
});
