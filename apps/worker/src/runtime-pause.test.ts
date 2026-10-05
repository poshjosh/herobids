import { describe, expect, it, vi } from 'vitest';
import {
  HeldMessageQueue,
  createPauseStateTracker,
  resolvePausedTickDelay,
  resolvePausedWakeAction,
  runPauseGatedTick,
} from './runtime-pause.js';

const userMessage = (text: string) => ({ type: 'user.message', payload: { message: text } });
const snapshot = (n: number) => ({ type: 'instance.context.snapshot', payload: { price: n } });
const wake = { type: 'agent.wake', payload: { source: 'scanner', reason: 'stale' } };
const configUpdate = { type: 'agent.runtime.config_update', payload: {} };

describe('createPauseStateTracker', () => {
  it('reports a paused transition when the status becomes paused and a resumed transition when it leaves paused', async () => {
    const readStatus = vi.fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('active')
      .mockResolvedValueOnce('paused')
      .mockResolvedValueOnce('paused')
      .mockResolvedValueOnce('active');
    const tracker = createPauseStateTracker({ readStatus, onReadError: vi.fn() });

    await expect(tracker.refresh()).resolves.toEqual({ paused: false, transition: null });
    await expect(tracker.refresh()).resolves.toEqual({ paused: true, transition: 'paused' });
    await expect(tracker.refresh()).resolves.toEqual({ paused: true, transition: null });
    await expect(tracker.refresh()).resolves.toEqual({ paused: false, transition: 'resumed' });
  });

  it('keeps last-known pause state when the status read fails', async () => {
    const onReadError = vi.fn();
    const readStatus = vi.fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('paused')
      .mockRejectedValueOnce(new Error('db down'));
    const tracker = createPauseStateTracker({ readStatus, onReadError });

    await tracker.refresh();
    await expect(tracker.refresh()).resolves.toEqual({ paused: true, transition: null });
    expect(tracker.isPaused()).toBe(true);
    expect(onReadError).toHaveBeenCalledTimes(1);
  });

  it('treats the agent as not paused when no database is configured', async () => {
    const tracker = createPauseStateTracker({ readStatus: null, onReadError: vi.fn() });

    await expect(tracker.refresh()).resolves.toEqual({ paused: false, transition: null });
    expect(tracker.isPaused()).toBe(false);
  });

  it('does not treat a missing agent row as paused', async () => {
    const tracker = createPauseStateTracker({ readStatus: async () => null, onReadError: vi.fn() });

    await expect(tracker.refresh()).resolves.toEqual({ paused: false, transition: null });
  });
});

describe('resolvePausedTickDelay', () => {
  it('re-checks pause status within the configured pause poll interval when the normal tick interval is longer', () => {
    expect(resolvePausedTickDelay(900_000, 30_000)).toBe(30_000);
  });

  it('keeps the normal tick interval when it is shorter than the pause poll interval', () => {
    expect(resolvePausedTickDelay(10_000, 30_000)).toBe(10_000);
  });
});

describe('resolvePausedWakeAction', () => {
  it('ACKs and ignores market wake signals while paused without scheduling an early tick', () => {
    expect(resolvePausedWakeAction('agent.wake')).toBe('suppress');
  });

  it('only flags user messages while paused', () => {
    expect(resolvePausedWakeAction('user.message')).toBe('flag_user_message');
    expect(resolvePausedWakeAction('agent.user.message')).toBe('flag_user_message');
  });

  it('passes other envelopes through', () => {
    expect(resolvePausedWakeAction('instance.context.snapshot')).toBe('pass_through');
  });
});

describe('HeldMessageQueue', () => {
  it('holds outbound messages read while paused and drains them in original order', () => {
    const queue = new HeldMessageQueue(100);
    queue.push([snapshot(1), userMessage('hi')]);
    queue.push([snapshot(2)]);

    expect(queue.drain()).toEqual([snapshot(1), userMessage('hi'), snapshot(2)]);
  });

  it('drains each held message exactly once', () => {
    const queue = new HeldMessageQueue(100);
    queue.push([snapshot(1)]);

    expect(queue.drain()).toHaveLength(1);
    expect(queue.drain()).toHaveLength(0);
    expect(queue.size).toBe(0);
  });

  it('drops wake envelopes read while paused so the first resumed tick carries no stale market wake', () => {
    const queue = new HeldMessageQueue(100);
    const result = queue.push([wake, snapshot(1), wake]);

    expect(result.droppedWakes).toBe(2);
    expect(queue.drain().some((m) => m['type'] === 'agent.wake')).toBe(false);
  });

  it('retains user messages and config updates when the held-message queue overflows', () => {
    const queue = new HeldMessageQueue(3);
    queue.push([snapshot(1), userMessage('first'), snapshot(2)]);
    const result = queue.push([configUpdate, snapshot(3), userMessage('second')]);

    const drained = queue.drain();
    expect(result.droppedOverflow).toBe(3);
    expect(drained).toEqual([userMessage('first'), configUpdate, userMessage('second')]);
  });

  it('drops the oldest non-priority messages first on overflow', () => {
    const queue = new HeldMessageQueue(2);
    queue.push([snapshot(1), snapshot(2), snapshot(3)]);

    expect(queue.drain()).toEqual([snapshot(2), snapshot(3)]);
  });
});

describe('runPauseGatedTick', () => {
  function buildDeps(statuses: Array<string | Error>, reads: Array<Array<Record<string, unknown>>> = []) {
    const readStatus = vi.fn<() => Promise<string | null>>();
    for (const status of statuses) {
      if (status instanceof Error) readStatus.mockRejectedValueOnce(status);
      else readStatus.mockResolvedValueOnce(status);
    }
    const readOutboundMessages = vi.fn<() => Promise<Array<Record<string, unknown>>>>();
    for (const batch of reads) readOutboundMessages.mockResolvedValueOnce(batch);
    readOutboundMessages.mockResolvedValue([]);
    const heldMessages = new HeldMessageQueue(100);
    // The active tick body drains held messages ahead of fresh ones, as agent.ts does.
    const processed: Array<Record<string, unknown>> = [];
    const runActiveTick = vi.fn(async (_options: { resumed: boolean }) => {
      processed.push(...heldMessages.drain());
    });
    const deps = {
      tracker: createPauseStateTracker({ readStatus, onReadError: vi.fn() }),
      heldMessages,
      runActiveTick,
      isSessionExpired: vi.fn(() => false),
      shutdownExpired: vi.fn(async () => undefined),
      readOutboundMessages,
      emitPausedSkip: vi.fn(),
      onPauseEntered: vi.fn(),
      onHeldOverflow: vi.fn(),
      onPausedReadError: vi.fn(),
    };
    return { deps, processed };
  }

  it('does not dispatch the LLM or run tick gates while the agent is paused', async () => {
    const { deps } = buildDeps(['paused', 'paused']);

    await expect(runPauseGatedTick(deps)).resolves.toBe('paused');
    await runPauseGatedTick(deps);

    // The active tick body (tickCount++, gates, backoff, LLM dispatch) never runs.
    expect(deps.runActiveTick).not.toHaveBeenCalled();
  });

  it('emits a tick_skipped activity event with gate paused and logs the pause transition once', async () => {
    const { deps } = buildDeps(['paused', 'paused', 'paused']);

    await runPauseGatedTick(deps);
    await runPauseGatedTick(deps);
    await runPauseGatedTick(deps);

    expect(deps.emitPausedSkip).toHaveBeenCalledTimes(3);
    expect(deps.onPauseEntered).toHaveBeenCalledTimes(1);
  });

  it('still enforces wall-clock expiry while paused', async () => {
    const { deps } = buildDeps(['paused']);
    deps.isSessionExpired.mockReturnValue(true);

    await runPauseGatedTick(deps);

    expect(deps.shutdownExpired).toHaveBeenCalledTimes(1);
    expect(deps.runActiveTick).not.toHaveBeenCalled();
  });

  it('keeps consuming the outbound stream while paused', async () => {
    const { deps } = buildDeps(['paused'], [[snapshot(1)]]);

    await runPauseGatedTick(deps);

    expect(deps.readOutboundMessages).toHaveBeenCalledTimes(1);
    expect(deps.heldMessages.size).toBe(1);
  });

  it('holds outbound messages read while paused and processes them in order on the first resumed tick', async () => {
    const { deps, processed } = buildDeps(
      ['paused', 'paused', 'active'],
      [[snapshot(1), userMessage('are you there?')], [configUpdate, snapshot(2)]],
    );

    await runPauseGatedTick(deps);
    await runPauseGatedTick(deps);
    await runPauseGatedTick(deps);

    expect(deps.runActiveTick).toHaveBeenCalledTimes(1);
    expect(deps.runActiveTick).toHaveBeenCalledWith({ resumed: true });
    expect(processed).toEqual([snapshot(1), userMessage('are you there?'), configUpdate, snapshot(2)]);
  });

  it('applies each held runtime message exactly once', async () => {
    const { deps, processed } = buildDeps(['paused', 'active', 'active'], [[snapshot(1)]]);

    await runPauseGatedTick(deps);
    await runPauseGatedTick(deps);
    await runPauseGatedTick(deps);

    expect(processed).toEqual([snapshot(1)]);
    expect(deps.runActiveTick).toHaveBeenNthCalledWith(2, { resumed: false });
  });

  it('keeps last-known pause state and skips decision work when the status read fails while paused', async () => {
    const { deps } = buildDeps(['paused', new Error('db down')]);

    await runPauseGatedTick(deps);
    await expect(runPauseGatedTick(deps)).resolves.toBe('paused');

    expect(deps.runActiveTick).not.toHaveBeenCalled();
  });

  it('runs the active tick unchanged for an agent that is not paused', async () => {
    const { deps } = buildDeps(['active']);

    await expect(runPauseGatedTick(deps)).resolves.toBe('active');

    expect(deps.runActiveTick).toHaveBeenCalledWith({ resumed: false });
    expect(deps.readOutboundMessages).not.toHaveBeenCalled();
    expect(deps.emitPausedSkip).not.toHaveBeenCalled();
  });
});
