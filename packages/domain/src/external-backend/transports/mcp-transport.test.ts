// Promoted leg B (Phase 3 T2.1 gate 1 → T2.3): the McpTransport drives the REAL
// client SDK over the signing fetch against a stubbed `fetch` that answers like
// the stateless legacy backend (initialize / 202 / 405 GET / tools/call). It
// proves the signed frames, the wire mapping, the decode of success/failure/
// in_progress, the error mapping, the attempt-timeout bound and client cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { SigningIdentity } from '../sign.js';
import type { TransportInvocation } from './transport.js';
import { McpTransport } from './mcp-transport.js';

const IDENTITY: SigningIdentity = { consumerId: 'herobids', keyId: 'current', secret: 'unit-secret' };
const MCP_PATH = '/internal/v1/mcp';
const BASE = 'http://boundary.unit.test';

interface RecordedFrame {
  method: string;
  path: string;
  rpcMethod: string | undefined;
  body: string;
  headers: Record<string, string>;
}

/** The envelope fields the client carries in params._meta. */
function envelope(overrides: Partial<TransportInvocation> = {}): TransportInvocation {
  const now = Date.now();
  return {
    contractVersion: '1.0',
    requestId: `req-${now}`,
    idempotencyKey: 'idem-1',
    correlationId: 'corr-ü-🚀',
    issuedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 30_000).toISOString(),
    caller: { consumerId: IDENTITY.consumerId, keyId: IDENTITY.keyId },
    subject: { ownerId: 'owner-1', actor: { type: 'agent', id: 'actor-1' } },
    toolName: 'get_operator_defaults',
    payload: {},
    ...overrides,
  };
}

function rpcMethodOf(parsed: unknown): string | undefined {
  return typeof parsed === 'object' && parsed !== null && 'method' in parsed && typeof (parsed as { method: unknown }).method === 'string'
    ? (parsed as { method: string }).method
    : undefined;
}
function rpcIdOf(parsed: unknown): unknown {
  return typeof parsed === 'object' && parsed !== null && 'id' in parsed ? (parsed as { id: unknown }).id : undefined;
}

interface ServerBehaviour {
  /** What the tools/call frame returns in its JSON-RPC `result` (or an error / rejection). */
  toolsCall: (callFrame: unknown) => { result: unknown } | { error: { code: number; message: string; data?: unknown } } | 'hang';
}

/** A fetch stub that answers the legacy MCP frame sequence. Records every frame. */
function stubMcpServer(behaviour: ServerBehaviour, frames: RecordedFrame[]): typeof fetch {
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    const parsed: unknown = body.length > 0 ? JSON.parse(body) : undefined;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    frames.push({ method, path: url.pathname, rpcMethod: rpcMethodOf(parsed), body, headers });

    if (method !== 'POST') {
      // The SDK's standalone SSE GET → 405 "no stream".
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }
    const rpcMethod = rpcMethodOf(parsed);
    if (rpcMethod === 'initialize') {
      return jsonRpc(rpcIdOf(parsed), {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'unit-recorder', version: '0.0.0' },
      });
    }
    if (rpcMethod?.startsWith('notifications/')) {
      return new Response(null, { status: 202 });
    }
    // tools/call
    const outcome = behaviour.toolsCall(parsed);
    if (outcome === 'hang') {
      return new Promise<Response>(() => {
        /* never resolves — the exchange timeout must win */
      });
    }
    if ('error' in outcome) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpcIdOf(parsed), error: outcome.error }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return jsonRpc(rpcIdOf(parsed), outcome.result);
  };
}

function jsonRpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function successToolResult(id: TransportInvocation): unknown {
  const body = { contractVersion: '1.0', requestId: id.requestId, correlationId: id.correlationId, outcome: { kind: 'success', payload: { ok: true } } };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

function transport(): McpTransport {
  return new McpTransport({ baseUrl: BASE, mcpPath: MCP_PATH, identity: IDENTITY });
}

let frames: RecordedFrame[];

beforeEach(() => {
  frames = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('McpTransport — signing and framing', () => {
  it('signs every POST over its exact body bytes with the MCP path and sends the envelope in params._meta', async () => {
    const inv = envelope();
    vi.stubGlobal('fetch', stubMcpServer({ toolsCall: () => ({ result: successToolResult(inv) }) }, frames));

    const outcome = await transport().invoke(inv, { timeoutMs: 10_000 });
    expect(outcome.kind).toBe('terminal');

    // Frame sequence: initialize, notifications/initialized, GET (405), tools/call.
    expect(frames.map((f) => `${f.method} ${f.rpcMethod ?? ''}`.trim())).toEqual([
      'POST initialize',
      'POST notifications/initialized',
      'GET',
      'POST tools/call',
    ]);

    for (const frame of frames.filter((f) => f.method === 'POST')) {
      const timestamp = frame.headers['x-traderton-timestamp'] ?? '';
      const canonical = `POST\n${MCP_PATH}\n${timestamp}\n${createHash('sha256').update(Buffer.from(frame.body, 'utf8')).digest('hex')}`;
      const expected = 'sha256=' + createHmac('sha256', IDENTITY.secret).update(canonical).digest('hex');
      expect(frame.headers['x-traderton-signature']).toBe(expected);
      // Deadline header on every frame equals the envelope deadline.
      expect(frame.headers['x-request-deadline-at']).toBe(inv.deadlineAt);
      expect(frame.path).toBe(MCP_PATH);
    }

    const call = frames.find((f) => f.rpcMethod === 'tools/call');
    const callFrame = JSON.parse(call?.body ?? '{}') as { params?: { name?: string; arguments?: unknown; _meta?: unknown } };
    expect(callFrame.params?.name).toBe('get_operator_defaults');
    expect(callFrame.params?.arguments).toEqual({});
    expect(callFrame.params?._meta).toEqual({
      contractVersion: inv.contractVersion,
      requestId: inv.requestId,
      idempotencyKey: inv.idempotencyKey,
      correlationId: inv.correlationId,
      issuedAt: inv.issuedAt,
      deadlineAt: inv.deadlineAt,
      caller: inv.caller,
      subject: inv.subject,
    });
  });

  it('rejects a non-object payload without any network request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const outcome = await transport().invoke(envelope({ payload: 'not-an-object' }), { timeoutMs: 10_000 });

    expect(outcome).toEqual({ kind: 'transport_error', message: 'mcp arguments must be an object' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('McpTransport — outcome decoding', () => {
  it('maps a success tools/call result to terminal', async () => {
    const inv = envelope();
    vi.stubGlobal('fetch', stubMcpServer({ toolsCall: () => ({ result: successToolResult(inv) }) }, frames));

    const outcome = await transport().invoke(inv, { timeoutMs: 10_000 });
    expect(outcome).toMatchObject({ kind: 'terminal', result: { outcome: { kind: 'success' } } });
  });

  it('maps an isError failure result to a terminal failure with the closed code intact', async () => {
    const inv = envelope();
    const body = { contractVersion: '1.0', requestId: inv.requestId, correlationId: inv.correlationId, outcome: { kind: 'failure', code: 'rate_limit.exceeded', message: 'slow down', retryable: true } };
    vi.stubGlobal('fetch', stubMcpServer({ toolsCall: () => ({ result: { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true } }) }, frames));

    const outcome = await transport().invoke(inv, { timeoutMs: 10_000 });
    expect(outcome).toMatchObject({ kind: 'terminal', result: { outcome: { kind: 'failure', code: 'rate_limit.exceeded', retryable: true } } });
  });

  it('maps an in_progress structuredContent to in_progress', async () => {
    const inv = envelope();
    const status = { contractVersion: '1.0', requestId: inv.requestId, correlationId: inv.correlationId, state: 'in_progress' };
    vi.stubGlobal('fetch', stubMcpServer({ toolsCall: () => ({ result: { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status } }) }, frames));

    const outcome = await transport().invoke(inv, { timeoutMs: 10_000 });
    expect(outcome).toEqual({ kind: 'in_progress', requestId: inv.requestId, correlationId: inv.correlationId });
  });

  it('treats a malformed structuredContent as an unreadable response', async () => {
    const inv = envelope();
    vi.stubGlobal('fetch', stubMcpServer({ toolsCall: () => ({ result: { content: [{ type: 'text', text: '{}' }], structuredContent: { nonsense: true } } }) }, frames));

    const outcome = await transport().invoke(inv, { timeoutMs: 10_000 });
    expect(outcome).toEqual({ kind: 'transport_error', message: 'boundary returned an unreadable response' });
  });

  it('maps a JSON-RPC error carrying a failure envelope to that terminal failure', async () => {
    const inv = envelope();
    const failure = { contractVersion: '1.0', requestId: inv.requestId, correlationId: inv.correlationId, outcome: { kind: 'failure', code: 'authentication.invalid_caller', message: 'bad caller', retryable: false } };
    vi.stubGlobal('fetch', stubMcpServer({ toolsCall: () => ({ error: { code: -32000, message: 'bad caller', data: failure } }) }, frames));

    const outcome = await transport().invoke(inv, { timeoutMs: 10_000 });
    expect(outcome).toMatchObject({ kind: 'terminal', result: { outcome: { kind: 'failure', code: 'authentication.invalid_caller', retryable: false } } });
  });
});

describe('McpTransport — failures never throw', () => {
  it('maps a refused connection to transport_error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const outcome = await transport().invoke(envelope(), { timeoutMs: 10_000 });
    expect(outcome.kind).toBe('transport_error');
    if (outcome.kind === 'transport_error') expect(outcome.message).not.toContain('fetch failed');
  });

  it('maps a non-2xx initialize to transport_error carrying the status', async () => {
    vi.stubGlobal('fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
      return new Response('upstream down', { status: 503 });
    });

    const outcome = await transport().invoke(envelope(), { timeoutMs: 10_000 });
    expect(outcome).toEqual({ kind: 'transport_error', message: 'boundary returned status 503' });
  });

  it('bounds connect and call together by the attempt timeout without hanging', async () => {
    const inv = envelope();
    vi.stubGlobal('fetch', stubMcpServer({ toolsCall: () => 'hang' }, frames));

    const started = Date.now();
    const outcome = await transport().invoke(inv, { timeoutMs: 150 });
    const elapsed = Date.now() - started;

    expect(outcome.kind).toBe('transport_error');
    expect(elapsed).toBeLessThan(2_000); // the exchange timeout fired, we did not hang
  });
});

describe('McpTransport — cleanup', () => {
  it('closes the client after every invocation (a second invoke on the same transport still works)', async () => {
    const inv = envelope();
    vi.stubGlobal('fetch', stubMcpServer({ toolsCall: () => ({ result: successToolResult(inv) }) }, frames));
    const t = transport();

    const first = await t.invoke(inv, { timeoutMs: 10_000 });
    const second = await t.invoke(envelope({ requestId: 'req-2' }), { timeoutMs: 10_000 });

    expect(first.kind).toBe('terminal');
    expect(second.kind).toBe('terminal');
    // Two full exchanges recorded (4 frames each): the client was reusable.
    expect(frames.filter((f) => f.rpcMethod === 'tools/call')).toHaveLength(2);
    expect(frames.filter((f) => f.rpcMethod === 'initialize')).toHaveLength(2);
  });
});
