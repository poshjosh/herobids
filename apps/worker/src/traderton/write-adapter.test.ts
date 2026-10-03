import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTradertonClient,
  type InvokeToolInput,
  type TradertonClientResult,
  type TradertonSubject,
} from '@herobids/domain/traderton';
import {
  createSubjectBoundWriteBoundary,
  createTradertonSideEffectBoundary,
  type TradertonSideEffectBoundary,
} from './write-adapter.js';

const SUBJECT: TradertonSubject = { ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } };

const TRANSPORT_ERROR: TradertonClientResult = {
  kind: 'transport_error',
  requestId: 'req-1',
  retryable: true,
  message: 'request to boundary failed',
};
const SUCCESS: TradertonClientResult = { kind: 'success', requestId: 'req-1', correlationId: 'corr-1', payload: { ok: true } };

/** A real client whose network methods are scripted per test (never reaches fetch). */
function makeClient() {
  const client = createTradertonClient({
    baseUrl: 'http://boundary.unit.test',
    consumerId: 'herobids',
    keyId: 'current',
    hmacSecret: 'unit-secret',
    requestTimeoutMs: 1_000,
  });
  const invoke = vi.spyOn(client, 'invoke').mockImplementation(async () => {
    throw new Error('unscripted invoke');
  });
  const poll = vi.spyOn(client, 'poll').mockImplementation(async () => {
    throw new Error('unscripted poll');
  });
  return { client, invoke, poll };
}

function write(overrides: Partial<Parameters<TradertonSideEffectBoundary['invokeAndAwait']>[0]> = {}) {
  return {
    toolName: 'submit_decision',
    payload: { instrumentId: 'BTC', intent: 'go_long' },
    subject: SUBJECT,
    deadlineMs: 30_000,
    idempotencyKey: 'dec-1',
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createTradertonSideEffectBoundary.invokeAndAwait', () => {
  it("re-issues once with the same key, requestId, payload and deadline when the first attempt's outcome is unknown", async () => {
    const { client, invoke, poll } = makeClient();
    // Cloned at call time: a later mutation of a shared input object must not
    // make the two attempts compare equal after the fact.
    const sent: InvokeToolInput[] = [];
    invoke.mockImplementation(async (input) => {
      sent.push(structuredClone(input));
      return sent.length === 1 ? TRANSPORT_ERROR : SUCCESS;
    });

    const result = await createTradertonSideEffectBoundary(client).invokeAndAwait(write());

    expect(result).toEqual(SUCCESS);
    expect(invoke).toHaveBeenCalledTimes(2);
    const [first, second] = sent;
    expect(second).toEqual(first);
    expect(first).toMatchObject({ idempotencyKey: 'dec-1', payload: { instrumentId: 'BTC', intent: 'go_long' }, subject: SUBJECT });
    expect(typeof first?.deadlineAt).toBe('string');
    expect(typeof first?.correlationId).toBe('string');
    // The client derives the same requestId for both attempts from the key.
    if (!first || !second) throw new Error('expected two invoke calls');
    expect(client.buildEnvelope(second).requestId).toBe(client.buildEnvelope(first).requestId);
    expect(poll).not.toHaveBeenCalled();
  });

  it('does not re-issue after a terminal failure, even a retryable one', async () => {
    const { client, invoke } = makeClient();
    const retryableFailure: TradertonClientResult = {
      kind: 'failure',
      requestId: 'req-1',
      correlationId: 'corr-1',
      code: 'upstream.transient',
      message: 'venue busy',
      retryable: true,
    };
    invoke.mockResolvedValueOnce(retryableFailure);

    const result = await createTradertonSideEffectBoundary(client).invokeAndAwait(write());

    expect(result).toEqual(retryableFailure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not re-issue once the deadline has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { client, invoke } = makeClient();
    invoke.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 60_000);
      return TRANSPORT_ERROR;
    });

    const result = await createTradertonSideEffectBoundary(client).invokeAndAwait(write());

    expect(result).toEqual(TRANSPORT_ERROR);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps the original transport error when the re-issue reports deadline.expired', async () => {
    const { client, invoke } = makeClient();
    invoke.mockResolvedValueOnce(TRANSPORT_ERROR).mockResolvedValueOnce({
      kind: 'failure',
      requestId: 'req-1',
      correlationId: 'corr-1',
      code: 'deadline.expired',
      message: 'request deadline has passed',
      retryable: false,
    });

    const result = await createTradertonSideEffectBoundary(client).invokeAndAwait(write());

    expect(result).toEqual(TRANSPORT_ERROR);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('polls the requestId returned by an in_progress re-issue until terminal', async () => {
    const { client, invoke, poll } = makeClient();
    invoke
      .mockResolvedValueOnce(TRANSPORT_ERROR)
      .mockResolvedValueOnce({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
    poll.mockResolvedValueOnce(SUCCESS);

    const result = await createTradertonSideEffectBoundary(client).invokeAndAwait(write());

    expect(result).toEqual(SUCCESS);
    expect(poll).toHaveBeenCalledTimes(1);
    const deadlineAt = invoke.mock.calls[0]?.[0].deadlineAt;
    expect(poll).toHaveBeenCalledWith('req-1', { deadlineAt, correlationId: 'corr-1' });
  });

  it('reports an unknown outcome, not a rejection, when the write is still running at the deadline', async () => {
    const { client, invoke, poll } = makeClient();
    invoke.mockResolvedValue({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
    // What the client's poll synthesises when its loop reaches the deadline.
    poll.mockResolvedValueOnce({
      kind: 'failure',
      requestId: 'req-1',
      correlationId: 'corr-1',
      code: 'deadline.expired',
      message: 'deadline passed before the invocation reached a terminal outcome',
      retryable: false,
    });

    const result = await createTradertonSideEffectBoundary(client).invokeAndAwait(write());

    expect(result).toEqual({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['not_found.resource', 'authentication.invalid_caller'] as const)(
    'treats the %s status-lookup answer as an unknown outcome of the running write',
    async (code) => {
      const { client, invoke, poll } = makeClient();
      invoke.mockResolvedValue({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
      poll.mockResolvedValueOnce({ kind: 'failure', requestId: 'req-1', correlationId: '', code, message: 'lookup', retryable: false });

      const result = await createTradertonSideEffectBoundary(client).invokeAndAwait(write());

      expect(result).toEqual({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
    },
  );

  it("returns a polled write's stored terminal failure verbatim", async () => {
    const { client, invoke, poll } = makeClient();
    const stored: TradertonClientResult = {
      kind: 'failure',
      requestId: 'req-1',
      correlationId: 'corr-1',
      code: 'validation.invalid_payload',
      message: 'bot not found',
      retryable: false,
    };
    invoke.mockResolvedValue({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });
    poll.mockResolvedValueOnce(stored);

    const result = await createTradertonSideEffectBoundary(client).invokeAndAwait(write());

    expect(result).toEqual(stored);
  });

  it('rejects an empty idempotency key without calling the boundary', async () => {
    const { client, invoke, poll } = makeClient();
    const boundary = createTradertonSideEffectBoundary(client);
    const expected = { kind: 'failure', code: 'validation.invalid_payload', retryable: false, message: 'idempotencyKey must be non-empty' };

    const awaited = await boundary.invokeAndAwait(write({ idempotencyKey: '' }));
    const single = await boundary.invoke({ toolName: 'submit_decision', payload: {}, subject: SUBJECT, idempotencyKey: '' });

    expect(awaited).toMatchObject(expected);
    expect(single).toMatchObject(expected);
    expect(invoke).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });
});

describe('createSubjectBoundWriteBoundary', () => {
  it('subject-bound write boundary mints a distinct idempotency key per tool write and binds the subject', async () => {
    const invokeAndAwait = vi.fn<TradertonSideEffectBoundary['invokeAndAwait']>(async () => SUCCESS);
    const boundary: TradertonSideEffectBoundary = {
      invoke: vi.fn<TradertonSideEffectBoundary['invoke']>(async () => SUCCESS),
      invokeAndAwait,
    };
    const toolWrite = createSubjectBoundWriteBoundary(boundary, SUBJECT);

    await toolWrite.invokeAndAwait({ toolName: 'adjust_risk_limits', payload: { maxOpenPositions: 3 }, deadlineMs: 30_000 });
    await toolWrite.invokeAndAwait({ toolName: 'adjust_risk_limits', payload: { maxOpenPositions: 3 }, deadlineMs: 30_000 });

    expect(invokeAndAwait).toHaveBeenCalledTimes(2);
    const [first, second] = [invokeAndAwait.mock.calls[0]?.[0], invokeAndAwait.mock.calls[1]?.[0]];
    expect(first).toMatchObject({ toolName: 'adjust_risk_limits', payload: { maxOpenPositions: 3 }, subject: SUBJECT, deadlineMs: 30_000 });
    expect(typeof first?.idempotencyKey).toBe('string');
    expect(first?.idempotencyKey).not.toBe('');
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });
});
