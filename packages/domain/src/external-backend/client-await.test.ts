import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalBackendClient, type ExternalBackendClientConfig, type InvokeAndAwaitInput } from './client.js';
import type { ExternalBackendFailureCode, ExternalBackendSubject } from './contract.js';
import { deriveRequestId } from './request-id.js';
import type { TransportSelectorOptions } from './transports/select-transport.js';
import type { ExternalBackendTransport, TransportOutcome } from './transports/transport.js';

// Fake transports replace the selector module (P3-21): no constructor injection,
// so nothing transport-typed reaches the client's public surface.
const selection = vi.hoisted(() => {
  const state: { transport?: ExternalBackendTransport; options: TransportSelectorOptions[] } = { options: [] };
  return state;
});

vi.mock(import('./transports/select-transport.js'), () => ({
  createTransportSelector: (options: TransportSelectorOptions) => {
    selection.options.push(options);
    return () => {
      if (!selection.transport) throw new Error('no fake transport installed');
      return selection.transport;
    };
  },
}));

const CONFIG: ExternalBackendClientConfig = {
  baseUrl: 'http://boundary.unit.test/',
  consumerId: 'herobids',
  keyId: 'current',
  hmacSecret: 'unit-secret',
  requestTimeoutMs: 1_000,
};
const SUBJECT: ExternalBackendSubject = { ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } };
const REQUEST_ID = deriveRequestId({
  consumerId: CONFIG.consumerId,
  ownerId: SUBJECT.ownerId,
  toolName: 'submit_decision',
  idempotencyKey: 'dec-1',
});

const LOST: TransportOutcome = { kind: 'transport_error', message: 'request to boundary failed' };
const RUNNING: TransportOutcome = { kind: 'in_progress', requestId: REQUEST_ID, correlationId: 'corr-1' };
const SUCCESS: TransportOutcome = {
  kind: 'terminal',
  result: { contractVersion: '1.0', requestId: REQUEST_ID, correlationId: 'corr-1', outcome: { kind: 'success', payload: { ok: true } } },
};

function failed(code: ExternalBackendFailureCode, retryable = false): TransportOutcome {
  return {
    kind: 'terminal',
    result: { contractVersion: '1.0', requestId: REQUEST_ID, correlationId: 'corr-1', outcome: { kind: 'failure', code, message: 'm', retryable } },
  };
}

/** Install a scripted fake transport; `statusLookup: false` models a transport without one (MCP, D15). */
function installTransport({ statusLookup }: { statusLookup: boolean }) {
  const invoke = vi.fn<ExternalBackendTransport['invoke']>(async () => {
    throw new Error('unscripted invoke');
  });
  const lookupStatus = vi.fn<NonNullable<ExternalBackendTransport['lookupStatus']>>(async () => {
    throw new Error('unscripted lookupStatus');
  });
  selection.transport = statusLookup ? { invoke, lookupStatus } : { invoke };
  return { invoke, lookupStatus };
}

function write(overrides: Partial<InvokeAndAwaitInput> = {}): InvokeAndAwaitInput {
  return {
    toolName: 'submit_decision',
    payload: { instrumentId: 'BTC', intent: 'go_long' },
    subject: SUBJECT,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    idempotencyKey: 'dec-1',
    ...overrides,
  };
}

/** The fields that must be identical on every attempt of one logical write. */
function writeIdentity(invocation: Parameters<ExternalBackendTransport['invoke']>[0] | undefined) {
  if (!invocation) throw new Error('expected an invocation');
  const { requestId, idempotencyKey, correlationId, deadlineAt, toolName, payload, subject, caller } = invocation;
  return { requestId, idempotencyKey, correlationId, deadlineAt, toolName, payload, subject, caller };
}

beforeEach(() => {
  selection.transport = undefined;
  selection.options.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ExternalBackendClient.invokeAndAwait — unknown first outcome', () => {
  it("re-issues once with the same key, requestId, payload and deadline when the first attempt's outcome is unknown", async () => {
    const { invoke, lookupStatus } = installTransport({ statusLookup: true });
    invoke.mockResolvedValueOnce(LOST).mockResolvedValueOnce(SUCCESS);

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write());

    expect(result).toEqual({ kind: 'success', requestId: REQUEST_ID, correlationId: 'corr-1', payload: { ok: true } });
    expect(invoke).toHaveBeenCalledTimes(2);
    const [first, second] = [invoke.mock.calls[0], invoke.mock.calls[1]];
    expect(writeIdentity(second?.[0])).toEqual(writeIdentity(first?.[0]));
    expect(first?.[0]).toMatchObject({ requestId: REQUEST_ID, idempotencyKey: 'dec-1', payload: { instrumentId: 'BTC', intent: 'go_long' } });
    // One correlationId is minted for the whole logical write.
    expect(typeof first?.[0].correlationId).toBe('string');
    expect(first?.[1]).toEqual({ timeoutMs: CONFIG.requestTimeoutMs });
    expect(lookupStatus).not.toHaveBeenCalled();
  });

  it('does not re-issue after a terminal failure, even a retryable one', async () => {
    const { invoke } = installTransport({ statusLookup: true });
    invoke.mockResolvedValueOnce(failed('upstream.transient', true));

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write());

    expect(result).toMatchObject({ kind: 'failure', code: 'upstream.transient', retryable: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not re-issue once the deadline has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { invoke } = installTransport({ statusLookup: true });
    invoke.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 60_000);
      return LOST;
    });

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write());

    expect(result).toEqual({ kind: 'transport_error', requestId: REQUEST_ID, retryable: true, message: 'request to boundary failed' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps the original transport error when the re-issue reports deadline.expired', async () => {
    const { invoke } = installTransport({ statusLookup: true });
    invoke.mockResolvedValueOnce(LOST).mockResolvedValueOnce(failed('deadline.expired'));

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write());

    expect(result).toEqual({ kind: 'transport_error', requestId: REQUEST_ID, retryable: true, message: 'request to boundary failed' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each(['authentication.invalid_caller', 'not_found.resource'] as const)(
    'keeps the original transport error when the re-issue reports the pre-dispatch %s',
    async (code) => {
      const { invoke, lookupStatus } = installTransport({ statusLookup: true });
      invoke.mockResolvedValueOnce(LOST).mockResolvedValueOnce(failed(code));

      const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write());

      expect(result).toMatchObject({ kind: 'transport_error', requestId: REQUEST_ID });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(lookupStatus).not.toHaveBeenCalled();
    },
  );

  it.each(['validation.invalid_payload', 'authorization.denied', 'upstream.transient'] as const)(
    'returns the re-issue failure %s because it is a stored or decided write outcome',
    async (code) => {
      const { invoke, lookupStatus } = installTransport({ statusLookup: true });
      invoke.mockResolvedValueOnce(LOST).mockResolvedValueOnce(failed(code));

      const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write());

      expect(result).toMatchObject({ kind: 'failure', code, retryable: false });
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(lookupStatus).not.toHaveBeenCalled();
    },
  );
});

describe('ExternalBackendClient.invokeAndAwait — in_progress through a status lookup', () => {
  it('polls the requestId returned by an in_progress re-issue until terminal', async () => {
    const { invoke, lookupStatus } = installTransport({ statusLookup: true });
    // The backend reports the running row's own requestId; it must be the one polled.
    const running: TransportOutcome = { kind: 'in_progress', requestId: 'req-running', correlationId: 'corr-1' };
    invoke.mockResolvedValueOnce(LOST).mockResolvedValueOnce(running);
    lookupStatus.mockResolvedValueOnce(SUCCESS);
    const input = write();

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(input);

    expect(result).toMatchObject({ kind: 'success', payload: { ok: true } });
    expect(lookupStatus).toHaveBeenCalledTimes(1);
    expect(lookupStatus).toHaveBeenCalledWith('req-running', { timeoutMs: CONFIG.requestTimeoutMs, deadlineAt: input.deadlineAt });
  });

  it('refuses a write without a usable deadline before sending anything', async () => {
    const { invoke } = installTransport({ statusLookup: false });

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write({ deadlineAt: 'not-a-date' }));

    expect(result).toMatchObject({ kind: 'failure', code: 'validation.invalid_payload', retryable: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not re-issue back to back when given a non-positive resolution interval', async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = installTransport({ statusLookup: false });
      invoke.mockResolvedValue(RUNNING);
      const deadlineAt = new Date(Date.now() + 10_000).toISOString();

      const pending = new ExternalBackendClient(CONFIG).invokeAndAwait(write({ deadlineAt }), { pollIntervalMs: 0 });
      await vi.advanceTimersByTimeAsync(2_500);

      // First invoke + one re-issue per default 1 s interval, not thousands.
      expect(invoke.mock.calls.length).toBeLessThanOrEqual(4);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({ kind: 'in_progress' });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves in_progress through the transport's status lookup when it has one", async () => {
    const { invoke, lookupStatus } = installTransport({ statusLookup: true });
    invoke.mockResolvedValueOnce(RUNNING);
    lookupStatus.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(SUCCESS);

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write(), { pollIntervalMs: 1 });

    expect(result).toMatchObject({ kind: 'success', payload: { ok: true } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(lookupStatus).toHaveBeenCalledTimes(2);
  });

  it('reports an unknown outcome, not a rejection, when the write is still running at the deadline', async () => {
    const { invoke, lookupStatus } = installTransport({ statusLookup: true });
    invoke.mockResolvedValue(RUNNING);
    lookupStatus.mockResolvedValue(RUNNING);

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(
      write({ deadlineAt: new Date(Date.now() + 50).toISOString() }),
      { pollIntervalMs: 5 },
    );

    expect(result).toEqual({ kind: 'in_progress', requestId: REQUEST_ID, correlationId: 'corr-1' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['not_found.resource', 'authentication.invalid_caller'] as const)(
    'treats the %s status-lookup answer as an unknown outcome of the running write',
    async (code) => {
      const { invoke, lookupStatus } = installTransport({ statusLookup: true });
      invoke.mockResolvedValue(RUNNING);
      lookupStatus.mockResolvedValueOnce(failed(code));

      const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write());

      expect(result).toEqual({ kind: 'in_progress', requestId: REQUEST_ID, correlationId: 'corr-1' });
    },
  );

  it("returns a polled write's stored terminal failure verbatim", async () => {
    const { invoke, lookupStatus } = installTransport({ statusLookup: true });
    invoke.mockResolvedValue(RUNNING);
    lookupStatus.mockResolvedValueOnce(failed('validation.invalid_payload'));

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write());

    expect(result).toEqual({
      kind: 'failure',
      requestId: REQUEST_ID,
      correlationId: 'corr-1',
      code: 'validation.invalid_payload',
      message: 'm',
      retryable: false,
    });
  });
});

describe('ExternalBackendClient.invokeAndAwait — in_progress without a status lookup', () => {
  it('resolves in_progress by re-issuing the same invocation when the transport has no status lookup', async () => {
    const { invoke } = installTransport({ statusLookup: false });
    invoke.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(SUCCESS);

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write(), { pollIntervalMs: 1 });

    expect(result).toMatchObject({ kind: 'success', payload: { ok: true } });
    expect(invoke).toHaveBeenCalledTimes(3);
    const identities = invoke.mock.calls.map(([invocation]) => writeIdentity(invocation));
    expect(identities[1]).toEqual(identities[0]);
    expect(identities[2]).toEqual(identities[0]);
  });

  it('stops re-issuing at the deadline and reports the write as an unknown outcome', async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = installTransport({ statusLookup: false });
      const deadlineAt = new Date(Date.now() + 50).toISOString();
      const issuedAt: number[] = [];
      invoke.mockImplementation(async () => {
        issuedAt.push(Date.now());
        return RUNNING;
      });

      const pending = new ExternalBackendClient(CONFIG).invokeAndAwait(write({ deadlineAt }), { pollIntervalMs: 10 });
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(result).toEqual({ kind: 'in_progress', requestId: REQUEST_ID, correlationId: 'corr-1' });
      expect(issuedAt.length).toBeGreaterThan(1);
      // T0.6 R1: never re-issued once the deadline has passed.
      for (const at of issuedAt) expect(at).toBeLessThan(Date.parse(deadlineAt));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-issue when the deadline has already passed as the first attempt reports in_progress', async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = installTransport({ statusLookup: false });
      const deadlineAt = new Date(Date.now() + 5).toISOString();
      invoke.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 10); // the first attempt outlives the deadline
        return RUNNING;
      });

      const pending = new ExternalBackendClient(CONFIG).invokeAndAwait(write({ deadlineAt }));
      await vi.advanceTimersByTimeAsync(10);

      await expect(pending).resolves.toMatchObject({ kind: 'in_progress' });
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['deadline.expired', 'not_found.resource', 'authentication.invalid_caller'] as const)(
    'treats a %s re-issue answer as an unknown outcome of the running write',
    async (code) => {
      const { invoke } = installTransport({ statusLookup: false });
      invoke.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(failed(code));

      const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write(), { pollIntervalMs: 1 });

      expect(result).toEqual({ kind: 'in_progress', requestId: REQUEST_ID, correlationId: 'corr-1' });
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );

  it("returns a re-issue's stored terminal failure verbatim", async () => {
    const { invoke } = installTransport({ statusLookup: false });
    invoke.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(failed('validation.invalid_payload'));

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write(), { pollIntervalMs: 1 });

    expect(result).toMatchObject({ kind: 'failure', code: 'validation.invalid_payload', retryable: false });
  });

  it('surfaces a lost re-issue as a transport error, as a lost status lookup is', async () => {
    const { invoke } = installTransport({ statusLookup: false });
    invoke.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(LOST);

    const result = await new ExternalBackendClient(CONFIG).invokeAndAwait(write(), { pollIntervalMs: 1 });

    expect(result).toEqual({ kind: 'transport_error', requestId: REQUEST_ID, retryable: true, message: 'request to boundary failed' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('ExternalBackendClient.poll — status lookup capability', () => {
  it('poll reports a typed unsupported failure when the transport has no status lookup', async () => {
    const { invoke } = installTransport({ statusLookup: false });

    const result = await new ExternalBackendClient(CONFIG).poll('req-9', {
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      correlationId: 'corr-9',
    });

    expect(result).toEqual({
      kind: 'failure',
      requestId: 'req-9',
      correlationId: 'corr-9',
      code: 'precondition.not_ready',
      message: 'status lookup is not supported by this backend transport; re-issue the invocation with the same idempotency key',
      retryable: false,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('labels a lost status lookup with the polled requestId', async () => {
    const { lookupStatus } = installTransport({ statusLookup: true });
    lookupStatus.mockResolvedValueOnce({ kind: 'transport_error', message: 'status request to boundary failed' });

    const result = await new ExternalBackendClient(CONFIG).poll('req-9', { deadlineAt: new Date(Date.now() + 5_000).toISOString() });

    expect(result).toEqual({ kind: 'transport_error', requestId: 'req-9', retryable: true, message: 'status request to boundary failed' });
  });
});

describe('ExternalBackendClient — transport selection', () => {
  it('selects the default rest protocol over the trimmed base URL when the config names none', () => {
    installTransport({ statusLookup: true });

    new ExternalBackendClient(CONFIG);

    expect(selection.options).toEqual([
      {
        baseUrl: 'http://boundary.unit.test',
        identity: { consumerId: 'herobids', keyId: 'current', secret: 'unit-secret' },
        protocol: 'rest',
        toolProtocolOverrides: undefined,
        mcpPath: undefined,
      },
    ]);
  });

  it('passes the configured protocol, per-tool overrides and mcpPath to the selector', () => {
    installTransport({ statusLookup: true });

    new ExternalBackendClient({ ...CONFIG, protocol: 'mcp', toolProtocolOverrides: { get_quote: 'rest' }, mcpPath: '/mcp' });

    expect(selection.options[0]).toMatchObject({ protocol: 'mcp', toolProtocolOverrides: { get_quote: 'rest' }, mcpPath: '/mcp' });
  });
});
