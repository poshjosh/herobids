import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExternalBackendRegistrySchema,
  ResolvedExternalBackendSchema,
  resolveExternalBackend,
  type ResolvedExternalBackend,
} from '@herobids/domain';
import { buildAgentExternalBackendPorts, type AgentExternalBackendPortsLogger } from './agent-ports.js';

const SECRET = 'unit-hmac-secret';
const INVOKE_URL = 'http://backend.unit.test/internal/v1/tools:invoke';

/** The payload exactly as the worker builds it: registry → resolveExternalBackend → JSON.stringify. */
function resolvedPayload(): ResolvedExternalBackend {
  const registry = ExternalBackendRegistrySchema.parse({
    'unit-backend': {
      endpoint: { baseUrl: 'http://backend.unit.test', requestTimeoutMs: 5_000 },
      caller: { consumerId: 'unit-consumer', keyId: 'unit-key', hmacSecretRef: 'UNIT_BACKEND_SECRET' },
      approvedSourceSkillRefs: ['owner/repo/skill'],
    },
  });
  const resolved = resolveExternalBackend(registry, 'unit-backend', { UNIT_BACKEND_SECRET: SECRET });
  if (!resolved.ok) throw new Error(`fixture did not resolve: ${resolved.error.code}`);
  return resolved.data;
}

function makeLogger() {
  const info = vi.fn<AgentExternalBackendPortsLogger['info']>();
  const warn = vi.fn<AgentExternalBackendPortsLogger['warn']>();
  // Serialise Error messages too (as pino does), so a logged parse error would be caught.
  const logged = () => JSON.stringify([info.mock.calls, warn.mock.calls], (_key, value: unknown) =>
    value instanceof Error ? { message: value.message } : value);
  return { logger: { info, warn }, info, warn, logged };
}

interface CapturedRequest {
  url: string;
  headers: Headers;
  rawBody: string;
  body: Record<string, unknown>;
}

/** Stub fetch with a backend that answers every invoke with a terminal success. */
function stubBackend(): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    requests.push({ url: String(url), headers: new Headers(init?.headers), rawBody, body });
    return new Response(JSON.stringify({
      contractVersion: '1.0',
      requestId: body['requestId'],
      correlationId: body['correlationId'],
      outcome: { kind: 'success', payload: { echoed: body['toolName'] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return requests;
}

function expectSignedWithSecret(request: CapturedRequest): void {
  const timestamp = request.headers.get('x-traderton-timestamp') ?? '';
  const bodyDigest = createHash('sha256').update(request.rawBody).digest('hex');
  const canonical = `POST\n/internal/v1/tools:invoke\n${timestamp}\n${bodyDigest}`;
  expect(request.headers.get('x-traderton-signature')).toBe(
    `sha256=${createHmac('sha256', SECRET).update(canonical).digest('hex')}`,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildAgentExternalBackendPorts', () => {
  it("round-trips the worker's resolved payload into read and write ports bound to the agent subject", async () => {
    const payload = resolvedPayload();
    const rawConfigJson = JSON.stringify(payload);
    expect(ResolvedExternalBackendSchema.parse(JSON.parse(rawConfigJson))).toEqual(payload);
    const requests = stubBackend();
    const { logger, logged } = makeLogger();

    const ports = buildAgentExternalBackendPorts({ rawConfigJson, ownerId: 'owner-1', agentId: 'agent-1', logger });

    await expect(ports.read?.invoke({ toolName: 'get_price', payload: { symbol: 'BTC' } }))
      .resolves.toEqual({ kind: 'success', data: { echoed: 'get_price' } });
    await expect(ports.write?.invokeAndAwait({ toolName: 'set_risk_limits', payload: {}, deadlineMs: 5_000 }))
      .resolves.toMatchObject({ kind: 'success', payload: { echoed: 'set_risk_limits' } });

    expect(requests).toHaveLength(2);
    const subject = { ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } };
    for (const request of requests) {
      expect(request.url).toBe(INVOKE_URL);
      expect(request.headers.get('x-traderton-consumer-id')).toBe('unit-consumer');
      expect(request.headers.get('x-traderton-key-id')).toBe('unit-key');
      expect(request.body['subject']).toEqual(subject);
      expectSignedWithSecret(request);
    }
    expect(requests[1]?.body['idempotencyKey']).toEqual(expect.any(String));
    expect(requests[1]?.body['idempotencyKey']).not.toBe('');
    expect(logged()).not.toContain(SECRET);
  });

  it('returns no ports when the payload is absent, invalid or the agent has no owner', () => {
    const validJson = JSON.stringify(resolvedPayload());
    const cases: Array<{ rawConfigJson: string | undefined; ownerId: string; logs: 'info' | 'warn'; reason?: string }> = [
      { rawConfigJson: undefined, ownerId: 'owner-1', logs: 'info' },
      { rawConfigJson: '', ownerId: 'owner-1', logs: 'info' },
      // Unparseable input carrying the secret: JSON.parse's message echoes it verbatim.
      { rawConfigJson: SECRET, ownerId: 'owner-1', logs: 'warn', reason: 'invalid_json' },
      { rawConfigJson: JSON.stringify({ definition: {}, hmacSecret: SECRET }), ownerId: 'owner-1', logs: 'warn', reason: 'invalid_schema' },
      { rawConfigJson: validJson, ownerId: '', logs: 'info' },
    ];
    for (const testCase of cases) {
      const { logger, info, warn, logged } = makeLogger();

      const ports = buildAgentExternalBackendPorts({
        rawConfigJson: testCase.rawConfigJson,
        ownerId: testCase.ownerId,
        agentId: 'agent-1',
        logger,
      });

      expect(ports).toEqual({ read: undefined, write: undefined });
      expect((testCase.logs === 'warn' ? warn : info)).toHaveBeenCalledTimes(1);
      if (testCase.reason !== undefined) {
        expect(warn.mock.calls[0]?.[0]).toMatchObject({ reason: testCase.reason });
      }
      expect(logged()).not.toContain(SECRET);
    }
  });
});
