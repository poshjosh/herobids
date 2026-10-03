import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createExternalBackendClient,
  type ExternalBackendClientResult,
  type ExternalBackendSubject,
} from '@herobids/domain/external-backend';
import {
  createSubjectBoundWriteBoundary,
  createTradertonSideEffectBoundary,
  type TradertonSideEffectBoundary,
} from './write-adapter.js';

const SUBJECT: ExternalBackendSubject = { ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } };

const TRANSPORT_ERROR: ExternalBackendClientResult = {
  kind: 'transport_error',
  requestId: 'req-1',
  retryable: true,
  message: 'request to boundary failed',
};
const SUCCESS: ExternalBackendClientResult = { kind: 'success', requestId: 'req-1', correlationId: 'corr-1', payload: { ok: true } };

/** A real client whose call methods are scripted per test (never reaches a transport). */
function makeClient() {
  const client = createExternalBackendClient({
    baseUrl: 'http://boundary.unit.test',
    consumerId: 'herobids',
    keyId: 'current',
    hmacSecret: 'unit-secret',
    requestTimeoutMs: 1_000,
  });
  const invoke = vi.spyOn(client, 'invoke').mockImplementation(async () => {
    throw new Error('unscripted invoke');
  });
  const invokeAndAwait = vi.spyOn(client, 'invokeAndAwait').mockImplementation(async () => {
    throw new Error('unscripted invokeAndAwait');
  });
  return { client, invoke, invokeAndAwait };
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
  it("invokeAndAwait delegates with a deadline derived from deadlineMs and the caller's idempotency key", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
    const { client, invokeAndAwait } = makeClient();
    invokeAndAwait.mockResolvedValueOnce(SUCCESS);

    const result = await createTradertonSideEffectBoundary(client).invokeAndAwait(
      write({ requestId: 'req-explicit', correlationId: 'corr-explicit' }),
    );

    expect(result).toBe(SUCCESS);
    expect(invokeAndAwait).toHaveBeenCalledTimes(1);
    expect(invokeAndAwait).toHaveBeenCalledWith({
      toolName: 'submit_decision',
      payload: { instrumentId: 'BTC', intent: 'go_long' },
      subject: SUBJECT,
      deadlineAt: '2026-10-03T12:00:30.000Z',
      requestId: 'req-explicit',
      idempotencyKey: 'dec-1',
      correlationId: 'corr-explicit',
    });
  });

  it('returns the client result verbatim, including an unknown outcome', async () => {
    const { client, invokeAndAwait } = makeClient();
    const unknown: ExternalBackendClientResult = { kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' };
    invokeAndAwait.mockResolvedValueOnce(TRANSPORT_ERROR).mockResolvedValueOnce(unknown);
    const boundary = createTradertonSideEffectBoundary(client);

    expect(await boundary.invokeAndAwait(write())).toBe(TRANSPORT_ERROR);
    expect(await boundary.invokeAndAwait(write())).toBe(unknown);
  });

  it('rejects an empty idempotency key without calling the boundary', async () => {
    const { client, invoke, invokeAndAwait } = makeClient();
    const boundary = createTradertonSideEffectBoundary(client);
    const expected = { kind: 'failure', code: 'validation.invalid_payload', retryable: false, message: 'idempotencyKey must be non-empty' };

    const awaited = await boundary.invokeAndAwait(write({ idempotencyKey: '' }));
    const single = await boundary.invoke({ toolName: 'submit_decision', payload: {}, subject: SUBJECT, idempotencyKey: '' });

    expect(awaited).toMatchObject(expected);
    expect(single).toMatchObject(expected);
    expect(invoke).not.toHaveBeenCalled();
    expect(invokeAndAwait).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only idempotency key without calling the boundary', async () => {
    const { client, invoke, invokeAndAwait } = makeClient();
    const boundary = createTradertonSideEffectBoundary(client);
    const expected = { kind: 'failure', code: 'validation.invalid_payload', retryable: false, message: 'idempotencyKey must be non-empty' };

    const awaited = await boundary.invokeAndAwait(write({ idempotencyKey: ' \t\n' }));
    const single = await boundary.invoke({ toolName: 'submit_decision', payload: {}, subject: SUBJECT, idempotencyKey: '   ' });

    expect(awaited).toMatchObject(expected);
    expect(single).toMatchObject(expected);
    expect(invoke).not.toHaveBeenCalled();
    expect(invokeAndAwait).not.toHaveBeenCalled();
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
