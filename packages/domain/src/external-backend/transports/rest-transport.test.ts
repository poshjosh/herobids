import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signInvoke, signStatus, type SigningIdentity } from '../sign.js';
import { EXTERNAL_BACKEND_INVOKE_PATH, type ExternalBackendToolResultV1 } from '../contract.js';
import { RestTransport } from './rest-transport.js';
import type { TransportInvocation } from './transport.js';

const BASE_URL = 'http://boundary.unit.test';
const IDENTITY: SigningIdentity = { consumerId: 'herobids', keyId: 'current', secret: 'unit-secret' };
const ATTEMPT = { timeoutMs: 1_234 };
const STATUS_ATTEMPT = { timeoutMs: 1_234, deadlineAt: '2026-10-03T12:00:30.000Z' };

const INVOCATION: TransportInvocation = {
  contractVersion: '1.0',
  requestId: 'req-1',
  idempotencyKey: 'key-1',
  correlationId: 'corr-1',
  issuedAt: '2026-10-03T12:00:00.000Z',
  deadlineAt: '2026-10-03T12:00:30.000Z',
  caller: { consumerId: 'herobids', keyId: 'current' },
  subject: { ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } },
  toolName: 'submit_decision',
  payload: { instrumentId: 'BTC' },
};

const RESULT: ExternalBackendToolResultV1 = {
  contractVersion: '1.0',
  requestId: 'req-1',
  correlationId: 'corr-1',
  outcome: { kind: 'success', payload: { ok: true } },
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function respondWith(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

function transport(): RestTransport {
  return new RestTransport({ baseUrl: BASE_URL, identity: IDENTITY });
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RestTransport.invoke', () => {
  it('maps a terminal tool result to a terminal outcome', async () => {
    respondWith(RESULT);

    expect(await transport().invoke(INVOCATION, ATTEMPT)).toEqual({ kind: 'terminal', result: RESULT });
  });

  it('maps an in_progress status to in_progress', async () => {
    respondWith({ contractVersion: '1.0', requestId: 'req-1', correlationId: 'corr-1', state: 'in_progress' });

    expect(await transport().invoke(INVOCATION, ATTEMPT)).toEqual({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
  });

  it('unwraps a terminal status into its result', async () => {
    respondWith({ contractVersion: '1.0', requestId: 'req-1', correlationId: 'corr-1', state: 'terminal', result: RESULT });

    expect(await transport().invoke(INVOCATION, ATTEMPT)).toEqual({ kind: 'terminal', result: RESULT });
  });

  it('accepts a success outcome whose payload key is absent', async () => {
    const body = { contractVersion: '1.0', requestId: 'req-1', correlationId: 'corr-1', outcome: { kind: 'success' } };
    respondWith(body);

    expect(await transport().invoke(INVOCATION, ATTEMPT)).toEqual({ kind: 'terminal', result: body });
  });

  it('reports an unrecognised body as a transport error', async () => {
    respondWith({ contractVersion: '1.0', requestId: 'req-1', correlationId: 'corr-1', state: 'queued' });

    expect(await transport().invoke(INVOCATION, ATTEMPT)).toEqual({
      kind: 'transport_error',
      message: 'boundary returned an unrecognised response',
    });
  });

  it('signs the invoke body bytes it sends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:01.000Z'));
    respondWith(RESULT);
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await transport().invoke(INVOCATION, ATTEMPT);

    const expected = signInvoke(IDENTITY, EXTERNAL_BACKEND_INVOKE_PATH, INVOCATION);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}${EXTERNAL_BACKEND_INVOKE_PATH}`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(expected.rawBody);
    expect(init?.headers).toEqual(expected.headers);
    expect(timeout).toHaveBeenCalledWith(ATTEMPT.timeoutMs);
  });
});

describe('RestTransport.lookupStatus', () => {
  it('maps an in_progress status to in_progress and a terminal status to its result', async () => {
    respondWith({ contractVersion: '1.0', requestId: 'req-1', correlationId: 'corr-1', state: 'in_progress' });
    respondWith({ contractVersion: '1.0', requestId: 'req-1', correlationId: 'corr-1', state: 'terminal', result: RESULT });

    expect(await transport().lookupStatus('req-1', STATUS_ATTEMPT)).toEqual({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
    expect(await transport().lookupStatus('req-1', STATUS_ATTEMPT)).toEqual({ kind: 'terminal', result: RESULT });
  });

  it('status lookup returns a not_found tool result as terminal instead of looping', async () => {
    const notFound: ExternalBackendToolResultV1 = {
      contractVersion: '1.0',
      requestId: 'req-1',
      correlationId: '',
      outcome: { kind: 'failure', code: 'not_found.resource', message: 'no invocation for requestId: req-1', retryable: false },
    };
    respondWith(notFound);

    expect(await transport().lookupStatus('req-1', STATUS_ATTEMPT)).toEqual({ kind: 'terminal', result: notFound });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an unrecognised status body as a transport error', async () => {
    respondWith({ contractVersion: '1.0', requestId: 'req-1', correlationId: 'corr-1', state: 'terminal', result: {} });

    expect(await transport().lookupStatus('req-1', STATUS_ATTEMPT)).toEqual({
      kind: 'transport_error',
      message: 'boundary returned an unrecognised status response',
    });
  });

  it('signs the status request over the bare path with an empty body and the attempt deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:01.000Z'));
    respondWith(RESULT);
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await transport().lookupStatus('req/1', STATUS_ATTEMPT);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/internal/v1/invocations/req%2F1`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual(
      signStatus(IDENTITY, '/internal/v1/invocations/req%2F1', { deadlineAt: STATUS_ATTEMPT.deadlineAt }),
    );
    expect(timeout).toHaveBeenCalledWith(STATUS_ATTEMPT.timeoutMs);
  });
});

describe('RestTransport transport errors', () => {
  const failures: ReadonlyArray<[string, () => void, string, string]> = [
    ['a rejected fetch', () => fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED')), 'request to boundary failed', 'status request to boundary failed'],
    ['a non-2xx status', () => respondWith({}, 503), 'boundary returned status 503', 'boundary returned status 503'],
    [
      'an unreadable body',
      () => fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 })),
      'boundary returned an unreadable response',
      'boundary returned an unreadable status response',
    ],
  ];

  it.each(failures)(
    'reports a transport error with the original message for %s',
    async (_label, arrange, invokeMessage, statusMessage) => {
      arrange();
      expect(await transport().invoke(INVOCATION, ATTEMPT)).toEqual({ kind: 'transport_error', message: invokeMessage });
      arrange();
      expect(await transport().lookupStatus('req-1', STATUS_ATTEMPT)).toEqual({ kind: 'transport_error', message: statusMessage });
    },
  );
});
