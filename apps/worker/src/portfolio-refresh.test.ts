import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionResultPayloadSchema, type ToolResult } from '@herobids/domain';
import { createPortfolioRefresher, isFillOrCloseMessage } from './portfolio-refresh.js';

const DEBOUNCE_MS = 3_000;
const READ_TIMEOUT_MS = 10_000;

function setup(read: () => Promise<ToolResult | null>) {
  const apply = vi.fn();
  const warn = vi.fn();
  const refresher = createPortfolioRefresher({ debounceMs: DEBOUNCE_MS, readTimeoutMs: READ_TIMEOUT_MS, read, apply, logger: { warn } });
  return { refresher, apply, warn };
}

const success = (data: unknown): ToolResult => ({ success: true, data });

describe('portfolio refresher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes portfolio once after a burst of fills', async () => {
    const read = vi.fn().mockResolvedValue(success({ ok: true }));
    const { refresher, apply } = setup(read);

    refresher.noteFill();
    await vi.advanceTimersByTimeAsync(1_000);
    refresher.noteFill();
    await vi.advanceTimersByTimeAsync(1_000);
    refresher.noteFill();
    expect(read).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ ok: true });
  });

  it('reads again for a fill that arrives after the previous burst was read', async () => {
    const read = vi.fn().mockResolvedValue(success({ ok: true }));
    const { refresher } = setup(read);

    refresher.noteFill();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    refresher.noteFill();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads at a decision wake without any fill', async () => {
    const read = vi.fn().mockResolvedValue(success({ ok: true }));
    const { refresher, apply } = setup(read);

    await refresher.refreshForWake();

    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not read again for a wake inside the debounce window of the last read', async () => {
    const read = vi.fn().mockResolvedValue(success({ ok: true }));
    const { refresher } = setup(read);

    await refresher.refreshForWake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    await refresher.refreshForWake();
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await refresher.refreshForWake();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('serves a pending fill with the wake read instead of reading twice', async () => {
    const read = vi.fn().mockResolvedValue(success({ ok: true }));
    const { refresher } = setup(read);
    await refresher.refreshForWake();

    refresher.noteFill();
    await refresher.refreshForWake();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight read between a wake and a fill refresh', async () => {
    let release: (value: ToolResult) => void = () => undefined;
    const read = vi.fn().mockImplementation(() => new Promise<ToolResult>((resolve) => { release = resolve; }));
    const { refresher, apply } = setup(read);

    const wake = refresher.refreshForWake();
    const second = refresher.refreshForWake();
    release(success({ ok: true }));
    await Promise.all([wake, second]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('warns and keeps prior state when the read fails', async () => {
    const read = vi.fn().mockResolvedValue({ success: false, error: 'boundary down', errorCode: 'boundary.transport_error' });
    const { refresher, apply, warn } = setup(read);

    await refresher.refreshForWake();

    expect(apply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns and keeps prior state when the read throws, and retries at the next wake', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(success({ ok: true }));
    const { refresher, apply, warn } = setup(read);

    await refresher.refreshForWake();
    expect(apply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    await refresher.refreshForWake();
    expect(apply).toHaveBeenCalledTimes(1);
  });


  it('reads again when a fill is noted during an in-flight read', async () => {
    const releases: Array<(value: ToolResult) => void> = [];
    const read = vi.fn().mockImplementation(() => new Promise<ToolResult>((resolve) => { releases.push(resolve); }));
    const { refresher, apply } = setup(read);

    refresher.noteFill();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(read).toHaveBeenCalledTimes(1);

    refresher.noteFill(); // arrives while the first read is still running
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(read).toHaveBeenCalledTimes(1); // timer fired mid-read; no overlapping read

    releases[0]?.(success({ n: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(read).toHaveBeenCalledTimes(2);
    releases[1]?.(success({ n: 2 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenLastCalledWith({ n: 2 });
  });

  it('does not read a second time when no fill arrived during the read', async () => {
    const read = vi.fn().mockResolvedValue(success({ ok: true }));
    const { refresher } = setup(read);

    refresher.noteFill();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('lets a wake wait for the in-flight read and then read the fill noted during it', async () => {
    const releases: Array<(value: ToolResult) => void> = [];
    const read = vi.fn().mockImplementation(() => new Promise<ToolResult>((resolve) => { releases.push(resolve); }));
    const { refresher } = setup(read);

    const firstWake = refresher.refreshForWake();
    refresher.noteFill();
    const secondWake = refresher.refreshForWake();
    releases[0]?.(success({ n: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    releases[1]?.(success({ n: 2 }));
    await Promise.all([firstWake, secondWake]);
  });

  it('warns and keeps prior state when the read exceeds the timeout, and discards the late result', async () => {
    let release: (value: ToolResult) => void = () => undefined;
    const read = vi.fn().mockImplementation(() => new Promise<ToolResult>((resolve) => { release = resolve; }));
    const { refresher, apply, warn } = setup(read);

    const wake = refresher.refreshForWake();
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await wake;
    release(success({ late: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('stays silent when there is no account to read', async () => {
    const { refresher, apply, warn } = setup(vi.fn().mockResolvedValue(null));

    await refresher.refreshForWake();

    expect(apply).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('cancels a pending fill read on dispose', async () => {
    const read = vi.fn().mockResolvedValue(success({ ok: true }));
    const { refresher } = setup(read);

    refresher.noteFill();
    refresher.dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

    expect(read).not.toHaveBeenCalled();
  });
});

const execution = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  decisionId: 'dec-1',
  planId: 'plan-1',
  orders: [{ orderId: 'o-1' }],
  fills: [{ fillId: 'f-1', price: '100', quantity: '1' }],
  positionAfter: { side: 'long', size: '1' },
  executionFailed: false,
  completedAt: '2026-11-21T10:00:00.000Z',
  ...overrides,
});
const envelope = (type: string, payload: Record<string, unknown>): Record<string, unknown> => ({
  schemaVersion: 'v1',
  messageId: 'm-1',
  agentId: 'agent-1',
  type,
  createdAt: '2026-11-21T10:00:00.000Z',
  payload,
});

describe('isFillOrCloseMessage', () => {
  it.each([
    ['an execution result with fills', envelope('instance.execution.result', ExecutionResultPayloadSchema.parse(execution())), true],
    ['an execution result closing the position', envelope('instance.execution.result', ExecutionResultPayloadSchema.parse(execution({ fills: [], positionAfter: { side: 'flat' } }))), true],
    ['an execution result with a closed position status', envelope('instance.execution.result', ExecutionResultPayloadSchema.parse(execution({ fills: [], positionAfter: { status: 'closed' } }))), true],
    ['a failed execution result that still lists fills', envelope('instance.execution.result', ExecutionResultPayloadSchema.parse(execution({ executionFailed: true }))), false],
    ['a hold that leaves the position flat with no orders', envelope('instance.execution.result', ExecutionResultPayloadSchema.parse(execution({ orders: [], fills: [], positionAfter: { side: 'flat' } }))), false],
    ['an execution result with no fills and an open position', envelope('instance.execution.result', ExecutionResultPayloadSchema.parse(execution({ fills: [] }))), false],
    ['order.filled journal event', envelope('instance.journal.event', { journalType: 'order.filled' }), true],
    ['order.partial journal event', envelope('instance.journal.event', { journalType: 'order.partial' }), true],
    ['fill.recorded journal event', envelope('instance.journal.event', { journalType: 'fill.recorded' }), true],
    ['reconciliation.match journal event', envelope('instance.journal.event', { journalType: 'reconciliation.match' }), false],
    ['status message', envelope('instance.status', {}), false],
    ['flat-bodied execution result', { type: 'instance.execution.result', ...execution() }, true],
  ])('classifies %s', (_name, message, expected) => {
    expect(isFillOrCloseMessage(message)).toBe(expected);
  });
});
