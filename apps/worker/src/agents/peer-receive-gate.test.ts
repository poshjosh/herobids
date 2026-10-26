import { afterEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@herobids/domain';
import { PeerReceiveGate, isPeerEnvelope, type PeerReceiveGateOptions } from './peer-receive-gate.js';

const peerMessage = (text = 'ping', messageId = 'm1') => ({
  messageId,
  type: 'agent.user.message',
  initiatorType: 'agent',
  payload: { message: text, peer: { fromAgentId: 'a1', fromAgentName: 'Momo' } },
});
const userMessage = { type: 'agent.user.message', initiatorType: 'user', payload: { message: 'hi' } };
const wake = { type: 'agent.wake', payload: {} };

type SwitchState = 'open' | 'paused' | 'unreadable' | 'throws';

const OPTIONS: PeerReceiveGateOptions = { cacheMs: 0, readRetries: 2, retryBackoffMs: 250 };

function setup(state: SwitchState | Array<() => unknown>, options: Partial<PeerReceiveGateOptions> = {}, withReporter = true) {
  const getPeerMessagingState = vi.fn(async () => {
    if (Array.isArray(state)) throw new Error('use sequence');
    if (state === 'throws') throw new Error('network');
    if (state === 'unreadable') return err({ code: 'agent.platform.unavailable', message: 'down', retryable: true });
    return ok({ paused: state === 'paused' });
  });
  if (Array.isArray(state)) {
    for (const step of state) getPeerMessagingState.mockImplementationOnce(async () => step() as never);
  }
  const log = { warn: vi.fn() };
  const report = vi.fn(async () => undefined);
  let clock = 1_000;
  const wait = vi.fn(async (ms: number) => { clock += ms; });
  const gate = new PeerReceiveGate(
    { getPeerMessagingState },
    log,
    { ...OPTIONS, ...options },
    withReporter ? report : undefined,
    () => clock,
    wait,
  );
  return { gate, getPeerMessagingState, log, report, wait, advance: (ms: number) => { clock += ms; } };
}

const unavailable = () => err({ code: 'agent.platform.unavailable', message: 'down', retryable: true });
const refused = () => err({ code: 'agent.platform.unauthorized', message: 'no', retryable: false });
const notPaused = () => ok({ paused: false });

describe('isPeerEnvelope', () => {
  it('is true for an agent.user.message with payload.peer, even a malformed one', () => {
    expect(isPeerEnvelope(peerMessage())).toBe(true);
    expect(isPeerEnvelope({ type: 'agent.user.message', payload: { message: 'x', peer: 'broken' } })).toBe(true);
  });

  it('is false for ordinary user messages, other types and a missing payload', () => {
    expect(isPeerEnvelope(userMessage)).toBe(false);
    expect(isPeerEnvelope({ type: 'agent.wake', payload: { peer: {} } })).toBe(false);
    expect(isPeerEnvelope({ type: 'agent.user.message' })).toBe(false);
    expect(isPeerEnvelope({ type: 'agent.user.message', payload: null })).toBe(false);
  });
});

describe('PeerReceiveGate (DEC-56)', () => {
  it('keeps every message while the owner has not paused peer messaging', async () => {
    const { gate, report } = setup('open');
    const messages = [wake, peerMessage(), userMessage];

    expect(await gate.filter(messages)).toEqual(messages);
    expect(report).not.toHaveBeenCalled();
  });

  it('drops peer messages, and only those, while the switch is on, logs without the text, and reports each as paused', async () => {
    const { gate, log, report, getPeerMessagingState } = setup('paused');

    const kept = await gate.filter([wake, peerMessage('secret text', 'm1'), userMessage, peerMessage('more', 'm2')]);

    expect(kept).toEqual([wake, userMessage]);
    expect(getPeerMessagingState).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret text');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('more');
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ reason: 'paused', count: 2 });
    expect(report.mock.calls).toEqual([
      [{ messageId: 'm1', fromAgentId: 'a1', reason: 'paused' }],
      [{ messageId: 'm2', fromAgentId: 'a1', reason: 'paused' }],
    ]);
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret text');
  });

  it('does not retry a switch that reads as paused', async () => {
    const { gate, getPeerMessagingState, wait } = setup('paused');

    await gate.filter([peerMessage()]);

    expect(getPeerMessagingState).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it.each(['unreadable', 'throws'] as const)('retries a switch that is %s, then drops fail closed as paused_check_failed', async (state) => {
    const { gate, log, report, getPeerMessagingState, wait } = setup(state);

    expect(await gate.filter([peerMessage(), userMessage])).toEqual([userMessage]);

    expect(getPeerMessagingState).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[250], [250]]);
    expect(log.warn.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ reason: 'unreadable', attempts: 3 }),
      expect.objectContaining({ reason: 'paused_check_failed', count: 1 }),
    ]);
    expect(report).toHaveBeenCalledWith({ messageId: 'm1', fromAgentId: 'a1', reason: 'paused_check_failed' });
  });

  it('accepts the message when a retry reads the switch open', async () => {
    const { gate, getPeerMessagingState, report } = setup([unavailable, notPaused]);

    expect(await gate.filter([peerMessage()])).toHaveLength(1);
    expect(getPeerMessagingState).toHaveBeenCalledTimes(2);
    expect(report).not.toHaveBeenCalled();
  });

  it('drops with paused, not paused_check_failed, when a retry reads the switch on', async () => {
    const { gate, report } = setup([unavailable, () => ok({ paused: true })]);

    expect(await gate.filter([peerMessage()])).toEqual([]);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ reason: 'paused' }));
  });

  it('does not retry a refusal that repeating cannot change', async () => {
    const { gate, getPeerMessagingState, report } = setup([refused]);

    expect(await gate.filter([peerMessage()])).toEqual([]);
    expect(getPeerMessagingState).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ reason: 'paused_check_failed' }));
  });

  it('makes no retry when readRetries is 0', async () => {
    const { gate, getPeerMessagingState } = setup('unreadable', { readRetries: 0 });

    await gate.filter([peerMessage()]);

    expect(getPeerMessagingState).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the agent has no platform client, without retrying', async () => {
    const log = { warn: vi.fn() };
    const report = vi.fn(async () => undefined);
    const gate = new PeerReceiveGate(undefined, log, OPTIONS, report);

    expect(await gate.filter([peerMessage(), userMessage])).toEqual([userMessage]);
    expect(await gate.admits(peerMessage('x', 'm2'))).toBe(false);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ reason: 'no_platform_client' });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ reason: 'paused_check_failed' }));
  });

  it('reads the switch once per batch, and not at all when the batch has no peer message', async () => {
    const { gate, getPeerMessagingState } = setup('open');

    await gate.filter([wake, userMessage]);
    expect(getPeerMessagingState).not.toHaveBeenCalled();

    await gate.filter([peerMessage(), peerMessage(), peerMessage()]);
    expect(getPeerMessagingState).toHaveBeenCalledTimes(1);
  });

  it('allows a message that is not a peer message without reading the switch', async () => {
    const { gate, getPeerMessagingState } = setup('paused');

    expect(await gate.admits(userMessage)).toBe(true);
    expect(getPeerMessagingState).not.toHaveBeenCalled();
  });

  it('works without a reporter', async () => {
    const { gate } = setup('paused', {}, false);

    expect(await gate.filter([peerMessage()])).toEqual([]);
  });
});

describe('PeerReceiveGate switch cache', () => {
  it('shares one read between a wake check and the tick that follows within cacheMs', async () => {
    const { gate, getPeerMessagingState, advance } = setup('open', { cacheMs: 2_000 });

    expect(await gate.admits(peerMessage())).toBe(true);
    advance(1_999);
    expect(await gate.filter([peerMessage('again', 'm2')])).toHaveLength(1);

    expect(getPeerMessagingState).toHaveBeenCalledTimes(1);
  });

  it('reads again once cacheMs has passed, so a switch turned on after the last read takes effect', async () => {
    const getPeerMessagingState = vi.fn()
      .mockResolvedValueOnce(ok({ paused: false }))
      .mockResolvedValueOnce(ok({ paused: true }));
    let clock = 0;
    const gate = new PeerReceiveGate({ getPeerMessagingState }, { warn: vi.fn() }, { ...OPTIONS, cacheMs: 2_000 }, undefined, () => clock);

    expect(await gate.admits(peerMessage())).toBe(true);
    clock = 2_000;
    expect(await gate.admits(peerMessage())).toBe(false);
    expect(getPeerMessagingState).toHaveBeenCalledTimes(2);
  });

  it('caches a paused verdict too', async () => {
    const { gate, getPeerMessagingState } = setup('paused', { cacheMs: 2_000 });

    await gate.admits(peerMessage());
    await gate.admits(peerMessage('x', 'm2'));

    expect(getPeerMessagingState).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed read: the next check reads again', async () => {
    const { gate, getPeerMessagingState } = setup([unavailable, unavailable, unavailable, notPaused], { cacheMs: 2_000 });

    expect(await gate.admits(peerMessage())).toBe(false);
    expect(await gate.admits(peerMessage('x', 'm2'))).toBe(true);
    expect(getPeerMessagingState).toHaveBeenCalledTimes(4);
  });

  it('makes concurrent checks share one in-flight read', async () => {
    let release: (value: unknown) => void = () => undefined;
    const getPeerMessagingState = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const gate = new PeerReceiveGate({ getPeerMessagingState: getPeerMessagingState as never }, { warn: vi.fn() }, OPTIONS);

    const wakeCheck = gate.admits(peerMessage());
    const tickCheck = gate.filter([peerMessage('x', 'm2')]);
    release(ok({ paused: false }));

    expect(await wakeCheck).toBe(true);
    expect(await tickCheck).toHaveLength(1);
    expect(getPeerMessagingState).toHaveBeenCalledTimes(1);
  });
});

describe('PeerReceiveGate deadline', () => {
  afterEach(() => vi.useRealTimers());

  it('fails closed when a read runs over maxWaitMs, so a stalled read cannot hold the tick', async () => {
    vi.useFakeTimers();
    const getPeerMessagingState = vi.fn(() => new Promise<never>(() => undefined));
    const log = { warn: vi.fn() };
    const report = vi.fn(async () => undefined);
    const gate = new PeerReceiveGate({ getPeerMessagingState }, log, { ...OPTIONS, maxWaitMs: 2_000 }, report);

    const filtering = gate.filter([peerMessage(), userMessage]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await filtering).toEqual([userMessage]);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ reason: 'paused_check_failed' }));
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ failure: 'timeout' });
  });

  it('returns the read when it finishes inside maxWaitMs and clears the timer', async () => {
    vi.useFakeTimers();
    const gate = new PeerReceiveGate({ getPeerMessagingState: async () => ok({ paused: false }) }, { warn: vi.fn() }, { ...OPTIONS, maxWaitMs: 2_000 });

    expect(await gate.admits(peerMessage())).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PeerReceiveGate drop reports', () => {
  it('reports one drop once, even when the wake and the tick both drop it', async () => {
    const { gate, report } = setup('paused');

    await gate.admits(peerMessage('x', 'm1'));
    await gate.filter([peerMessage('x', 'm1')]);

    expect(report).toHaveBeenCalledTimes(1);
  });

  it('survives a failing report: the message is still dropped, and the failure is logged without the text', async () => {
    const { gate, report, log } = setup('paused');
    report.mockRejectedValue(new Error('redis down'));

    expect(await gate.filter([peerMessage('secret text')])).toEqual([]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret text');
    expect(log.warn.mock.calls.some((call) => String(call[1]).includes('could not be reported'))).toBe(true);
  });

  it('drops a peer envelope too malformed to name its row, and reports nothing for it', async () => {
    const { gate, report } = setup('paused');
    const malformed = { type: 'agent.user.message', payload: { message: 'x', peer: 'broken' } };

    expect(await gate.filter([malformed])).toEqual([]);
    expect(report).not.toHaveBeenCalled();
  });
});
