import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { ExternalBackendClient, type ExternalBackendClientConfig } from './client.js';
import { deriveRequestId } from './request-id.js';
import type {
  ExternalBackendToolResultV1,
  ExternalBackendToolInvocationStatusV1,
  ExternalBackendSubject,
} from './contract.js';

const CONFIG: ExternalBackendClientConfig = {
  baseUrl: 'http://boundary.test',
  consumerId: 'herobids',
  keyId: 'current',
  hmacSecret: 'test-secret',
  requestTimeoutMs: 10_000,
};

const SUBJECT: ExternalBackendSubject = {
  ownerId: 'owner-1',
  actor: { type: 'agent', id: 'agent-1' },
};

/** Build a fetch Response-like object with a JSON body. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function client(): ExternalBackendClient {
  return new ExternalBackendClient(CONFIG);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ExternalBackendClient.invoke — envelope', () => {
  it('emits a well-formed ExternalBackendToolInvocationV1 with matching signed headers', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        contractVersion: '1.0',
        requestId: 'r',
        correlationId: 'c',
        outcome: { kind: 'success', payload: {} },
      } satisfies ExternalBackendToolResultV1),
    );

    await client().invoke({ toolName: 'get_positions', payload: { symbol: 'BTC' }, subject: SUBJECT });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://boundary.test/internal/v1/tools:invoke');
    expect(init.method).toBe('POST');

    const envelope = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(envelope['contractVersion']).toBe('1.0');
    expect(typeof envelope['requestId']).toBe('string');
    expect(typeof envelope['idempotencyKey']).toBe('string');
    expect(typeof envelope['correlationId']).toBe('string');
    expect(typeof envelope['issuedAt']).toBe('string');
    expect(typeof envelope['deadlineAt']).toBe('string');
    expect(envelope['caller']).toEqual({ consumerId: 'herobids', keyId: 'current' });
    expect(envelope['subject']).toEqual(SUBJECT);
    expect(envelope['toolName']).toBe('get_positions');
    expect(envelope['payload']).toEqual({ symbol: 'BTC' });

    const headers = init.headers as Record<string, string>;
    // Header caller fields match the body caller exactly.
    expect(headers['x-traderton-consumer-id']).toBe(envelope['caller']!['consumerId' as never]);
    expect(headers['x-traderton-key-id']).toBe('current');
    // x-request-deadline-at equals body.deadlineAt.
    expect(headers['x-request-deadline-at']).toBe(envelope['deadlineAt']);

    // The signed bytes are the wire bytes: recompute the signature over init.body.
    const canonical = `POST\n/internal/v1/tools:invoke\n${headers['x-traderton-timestamp']}\n${createHash('sha256').update(Buffer.from(init.body as string, 'utf8')).digest('hex')}`;
    const expected = 'sha256=' + createHmac('sha256', CONFIG.hmacSecret).update(canonical).digest('hex');
    expect(headers['x-traderton-signature']).toBe(expected);
  });

  it('reuses caller-supplied requestId/idempotencyKey for retry idempotency', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        contractVersion: '1.0',
        requestId: 'fixed-req',
        correlationId: 'fixed-corr',
        outcome: { kind: 'success', payload: {} },
      } satisfies ExternalBackendToolResultV1),
    );

    await client().invoke({
      toolName: 't',
      payload: {},
      subject: SUBJECT,
      requestId: 'fixed-req',
      idempotencyKey: 'fixed-idem',
      correlationId: 'fixed-corr',
    });

    const envelope = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(envelope['requestId']).toBe('fixed-req');
    expect(envelope['idempotencyKey']).toBe('fixed-idem');
    expect(envelope['correlationId']).toBe('fixed-corr');
  });

  it('derives a stable requestId from the idempotency key when no requestId is supplied', async () => {
    fetchMock.mockImplementation(async () => freshSuccessResponse());

    await client().invoke({ toolName: 'submit_decision', payload: {}, subject: SUBJECT, idempotencyKey: 'dec-1' });
    await client().invoke({ toolName: 'submit_decision', payload: {}, subject: SUBJECT, idempotencyKey: 'dec-1' });

    const [first, second] = [sentEnvelope(0), sentEnvelope(1)];
    const expected = deriveRequestId({
      consumerId: CONFIG.consumerId,
      ownerId: SUBJECT.ownerId,
      toolName: 'submit_decision',
      idempotencyKey: 'dec-1',
    });
    expect(first['requestId']).toBe(expected);
    expect(second['requestId']).toBe(expected);
    expect(first['idempotencyKey']).toBe('dec-1');
    // correlationId is per call, not per key.
    expect(first['correlationId']).not.toBe(second['correlationId']);
  });

  it('derives the requestId from whatever key it sends, even an empty one', async () => {
    fetchMock.mockImplementation(async () => freshSuccessResponse());

    await client().invoke({ toolName: 'submit_decision', payload: {}, subject: SUBJECT, idempotencyKey: '' });

    const sent = sentEnvelope(0);
    expect(sent['idempotencyKey']).toBe('');
    expect(sent['requestId']).toBe(
      deriveRequestId({ consumerId: CONFIG.consumerId, ownerId: SUBJECT.ownerId, toolName: 'submit_decision', idempotencyKey: '' }),
    );
  });

  it('mints fresh identifiers per call when no idempotency key is supplied', async () => {
    fetchMock.mockImplementation(async () => freshSuccessResponse());

    await client().invoke({ toolName: 'get_positions', payload: {}, subject: SUBJECT });
    await client().invoke({ toolName: 'get_positions', payload: {}, subject: SUBJECT });

    const [first, second] = [sentEnvelope(0), sentEnvelope(1)];
    expect(first['requestId']).not.toBe(second['requestId']);
    expect(first['idempotencyKey']).not.toBe(second['idempotencyKey']);
    expect(first['requestId']).not.toBe(first['idempotencyKey']);
  });
});

/** A fresh success Response per call (a Response body can be read only once). */
function freshSuccessResponse(): Response {
  const body: ExternalBackendToolResultV1 = {
    contractVersion: '1.0',
    requestId: 'r',
    correlationId: 'c',
    outcome: { kind: 'success', payload: {} },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

/** The envelope the client sent on its `index`-th fetch call. */
function sentEnvelope(index: number): Record<string, unknown> {
  const init: RequestInit | undefined = fetchMock.mock.calls[index]?.[1];
  const parsed: unknown = JSON.parse(String(init?.body));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('fetch body is not an envelope');
  return Object.fromEntries(Object.entries(parsed));
}

describe('ExternalBackendClient.invoke — response mapping', () => {
  it('maps a success envelope to a success result carrying the payload', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        contractVersion: '1.0',
        requestId: 'r1',
        correlationId: 'c1',
        outcome: { kind: 'success', payload: { positions: [] } },
      } satisfies ExternalBackendToolResultV1),
    );

    const result = await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.payload).toEqual({ positions: [] });
      expect(result.requestId).toBe('r1');
      expect(result.correlationId).toBe('c1');
    }
  });

  it('preserves the code and retryable flag of a typed failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        contractVersion: '1.0',
        requestId: 'r2',
        correlationId: 'c2',
        outcome: {
          kind: 'failure',
          code: 'validation.invalid_payload',
          message: 'bad payload',
          retryable: false,
          details: { field: 'symbol' },
        },
      } satisfies ExternalBackendToolResultV1),
    );

    const result = await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.code).toBe('validation.invalid_payload');
      expect(result.retryable).toBe(false);
      expect(result.message).toBe('bad payload');
      expect(result.details).toEqual({ field: 'symbol' });
    }
  });

  it('surfaces an in-progress status returned by invoke as in_progress', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        contractVersion: '1.0',
        requestId: 'r3',
        correlationId: 'c3',
        state: 'in_progress',
      } satisfies ExternalBackendToolInvocationStatusV1),
    );

    const result = await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT });

    expect(result.kind).toBe('in_progress');
    if (result.kind === 'in_progress') {
      expect(result.requestId).toBe('r3');
    }
  });

  it('maps a terminal status wrapper returned by invoke to its inner result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        contractVersion: '1.0',
        requestId: 'r4',
        correlationId: 'c4',
        state: 'terminal',
        result: {
          contractVersion: '1.0',
          requestId: 'r4',
          correlationId: 'c4',
          outcome: { kind: 'success', payload: { ok: true } },
        },
      } satisfies ExternalBackendToolInvocationStatusV1),
    );

    const result = await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT });
    expect(result.kind).toBe('success');
  });

  it('returns a distinct retryable transport error when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT });

    expect(result.kind).toBe('transport_error');
    if (result.kind === 'transport_error') {
      expect(result.retryable).toBe(true);
      // No boundary internals / stack traces leaked.
      expect(result.message).not.toContain('ECONNREFUSED');
    }
  });

  it('returns a transport error on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 503));
    const result = await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT });
    expect(result.kind).toBe('transport_error');
  });

  it.each<[string, unknown]>([
    ['a null body', null],
    ['a number body', 42],
    ['an empty object', {}],
    ['a terminal status with no result', { contractVersion: '1.0', requestId: 'r', correlationId: 'c', state: 'terminal' }],
    ['a status with an unknown state', { contractVersion: '1.0', requestId: 'r', correlationId: 'c', state: 'queued' }],
    [
      'a failure outcome with no code',
      { contractVersion: '1.0', requestId: 'r', correlationId: 'c', outcome: { kind: 'failure', message: 'm', retryable: false } },
    ],
    [
      'a failure outcome with a non-boolean retryable',
      { contractVersion: '1.0', requestId: 'r', correlationId: 'c', outcome: { kind: 'failure', code: 'upstream.transient', message: 'm', retryable: 'yes' } },
    ],
    ['a status with no requestId', { contractVersion: '1.0', correlationId: 'c', state: 'in_progress' }],
    ['a result with a non-string correlationId', { contractVersion: '1.0', requestId: 'r', correlationId: 7, outcome: { kind: 'success', payload: {} } }],
    ['an outcome of unknown kind', { contractVersion: '1.0', requestId: 'r', correlationId: 'c', outcome: { kind: 'partial' } }],
  ])('maps %s returned by invoke to a transport error without throwing', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

    const result = await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT, requestId: 'req-x' });

    expect(result).toEqual({
      kind: 'transport_error',
      requestId: 'req-x',
      retryable: true,
      message: 'boundary returned an unrecognised response',
    });
  });

  it('maps a success outcome whose payload key is absent to a success result', async () => {
    // The backend's successResult(identity, undefined) serialises without `payload`.
    const body = { contractVersion: '1.0', requestId: 'r', correlationId: 'c', outcome: { kind: 'success' } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

    const result = await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT, requestId: 'req-x' });

    expect(result).toEqual({ kind: 'success', requestId: 'r', correlationId: 'c', payload: undefined });
  });
});

describe('ExternalBackendClient.poll', () => {
  it('resolves to the terminal result once the status endpoint reports terminal', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          contractVersion: '1.0',
          requestId: 'rp',
          correlationId: 'cp',
          state: 'in_progress',
        } satisfies ExternalBackendToolInvocationStatusV1),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          contractVersion: '1.0',
          requestId: 'rp',
          correlationId: 'cp',
          state: 'terminal',
          result: {
            contractVersion: '1.0',
            requestId: 'rp',
            correlationId: 'cp',
            outcome: { kind: 'success', payload: { done: true } },
          },
        } satisfies ExternalBackendToolInvocationStatusV1),
      );

    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const result = await client().poll('rp', { deadlineAt, pollIntervalMs: 1 });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.payload).toEqual({ done: true });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('signs the status request with an empty body over the bare path', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        contractVersion: '1.0',
        requestId: 'rp',
        correlationId: 'cp',
        state: 'terminal',
        result: {
          contractVersion: '1.0',
          requestId: 'rp',
          correlationId: 'cp',
          outcome: { kind: 'success', payload: {} },
        },
      } satisfies ExternalBackendToolInvocationStatusV1),
    );

    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    await client().poll('rp', { deadlineAt, pollIntervalMs: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://boundary.test/internal/v1/invocations/rp');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    const canonical = `GET\n/internal/v1/invocations/rp\n${headers['x-traderton-timestamp']}\n${createHash('sha256').update(Buffer.alloc(0)).digest('hex')}`;
    const expected = 'sha256=' + createHmac('sha256', CONFIG.hmacSecret).update(canonical).digest('hex');
    expect(headers['x-traderton-signature']).toBe(expected);
  });

  it('poll returns not_found.resource immediately when the boundary has no record of the requestId', async () => {
    const notFound: ExternalBackendToolResultV1 = {
      contractVersion: '1.0',
      requestId: 'unknown-req',
      correlationId: '',
      outcome: {
        kind: 'failure',
        code: 'not_found.resource',
        message: 'no invocation for requestId: unknown-req',
        retryable: false,
      },
    };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(notFound), { status: 200 }));

    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const result = await client().poll('unknown-req', { deadlineAt, pollIntervalMs: 1 });

    expect(result).toMatchObject({ kind: 'failure', code: 'not_found.resource', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('poll maps an unrecognised status body to a transport error', async () => {
    const unrecognisedBodies: unknown[] = [
      {},
      null,
      { outcome: null },
      { contractVersion: '1.0', requestId: 'rp', correlationId: 'cp', state: 'terminal', result: {} },
      { contractVersion: '1.0', requestId: 'rp', correlationId: 'cp', outcome: { kind: 'failure', message: 'm', retryable: false } },
    ];
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();

    for (const body of unrecognisedBodies) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

      const result = await client().poll('rp', { deadlineAt, pollIntervalMs: 1 });

      expect(result).toEqual({
        kind: 'transport_error',
        requestId: 'rp',
        retryable: true,
        message: 'boundary returned an unrecognised status response',
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(unrecognisedBodies.length);
  });

  it('poll stops with a transport error on an unknown state instead of polling to the deadline', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ contractVersion: '1.0', requestId: 'rp', correlationId: 'cp', state: 'queued' }), {
          status: 200,
        }),
    );

    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const result = await client().poll('rp', { deadlineAt, pollIntervalMs: 1 });

    expect(result).toEqual({
      kind: 'transport_error',
      requestId: 'rp',
      retryable: true,
      message: 'boundary returned an unrecognised status response',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a deadline error once the deadline passes', async () => {
    // Deadline already in the past → the poll returns before issuing a request.
    const deadlineAt = new Date(Date.now() - 1_000).toISOString();
    const result = await client().poll('rp', { deadlineAt, pollIntervalMs: 1 });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.code).toBe('deadline.expired');
      expect(result.retryable).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// IV-2: the per-attempt transport timeout is min(requestTimeoutMs, deadlineAt −
// now), falling back to requestTimeoutMs once the deadline has passed. Observed
// through the exact value the REST transport hands AbortSignal.timeout.
describe('ExternalBackendClient — per-attempt timeout bounded by the deadline (IV-2)', () => {
  let timeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  });
  afterEach(() => {
    timeoutSpy.mockRestore();
  });

  function lastTimeoutArg(): number {
    const calls = timeoutSpy.mock.calls;
    const last = calls[calls.length - 1];
    if (!last) throw new Error('AbortSignal.timeout was never called');
    return last[0] as number;
  }

  it('bounds each attempt by the time remaining to the deadline', async () => {
    fetchMock.mockResolvedValueOnce(freshSuccessResponse());
    // Deadline 2s out, well inside the 10s requestTimeoutMs.
    const deadlineAt = new Date(Date.now() + 2_000).toISOString();

    await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT, deadlineAt });

    const budget = lastTimeoutArg();
    expect(budget).toBeLessThanOrEqual(2_000);
    expect(budget).toBeGreaterThan(1_000); // not clipped to requestTimeoutMs, not zero
  });

  it('uses requestTimeoutMs when the deadline is further away', async () => {
    fetchMock.mockResolvedValueOnce(freshSuccessResponse());
    // Deadline 60s out — much further than the 10s requestTimeoutMs.
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();

    await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT, deadlineAt });

    expect(lastTimeoutArg()).toBe(CONFIG.requestTimeoutMs);
  });

  it('sends an already-expired invocation with the full attempt budget so the backend answers deadline.expired', async () => {
    fetchMock.mockResolvedValueOnce(freshSuccessResponse());
    const deadlineAt = new Date(Date.now() - 1_000).toISOString();

    await client().invoke({ toolName: 't', payload: {}, subject: SUBJECT, deadlineAt });

    // The request IS sent (the backend owns the deadline verdict), and the
    // attempt is given the full budget rather than being clipped to <= 0.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastTimeoutArg()).toBe(CONFIG.requestTimeoutMs);
  });
});
