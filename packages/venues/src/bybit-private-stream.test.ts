import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BybitPrivateStream } from './bybit-private-stream.js';

interface MockWsInstance {
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  pong: ReturnType<typeof vi.fn>;
  readyState: number;
}

let latestWsInstance: MockWsInstance | undefined;

vi.mock('ws', () => {
  const MockWebSocket = vi.fn(() => {
    const instance: MockWsInstance = {
      handlers: new Map(),
      send: vi.fn(),
      close: vi.fn(),
      pong: vi.fn(),
      readyState: 1,
    };
    (instance as Record<string, unknown>)['on'] = (event: string, handler: (...args: unknown[]) => void) => {
      if (!instance.handlers.has(event)) {
        instance.handlers.set(event, []);
      }
      instance.handlers.get(event)!.push(handler);
    };
    latestWsInstance = instance;
    return instance;
  });

  (MockWebSocket as unknown as Record<string, unknown>)['OPEN'] = 1;
  return { default: MockWebSocket, __esModule: true };
});

function trigger(event: string, ...args: unknown[]): void {
  for (const handler of latestWsInstance?.handlers.get(event) ?? []) {
    handler(...args);
  }
}

function triggerMessage(payload: unknown): void {
  trigger('message', { toString: () => JSON.stringify(payload) });
}

describe('BybitPrivateStream', () => {
  beforeEach(() => {
    latestWsInstance = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to order, execution, position, and wallet after auth', async () => {
    const stream = new BybitPrivateStream({
      wsUrl: 'wss://fake.test/private',
      apiKey: 'api-key',
      secret: 'secret',
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30_000,
      maxReconnectAttempts: 5,
    }, {});

    const connectPromise = stream.connect();
    trigger('open');

    expect(latestWsInstance?.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(latestWsInstance!.send.mock.calls[0]![0] as string)).toEqual({
      op: 'auth',
      args: ['api-key', expect.any(Number), expect.any(String)],
    });

    triggerMessage({ op: 'auth', success: true });
    await expect(connectPromise).resolves.toEqual({ ok: true, data: undefined });

    expect(latestWsInstance?.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(latestWsInstance!.send.mock.calls[1]![0] as string)).toEqual({
      op: 'subscribe',
      args: ['order', 'execution', 'position', 'wallet'],
    });
  });

  it('responds to websocket ping messages with a pong op', async () => {
    const stream = new BybitPrivateStream({
      wsUrl: 'wss://fake.test/private',
      apiKey: 'api-key',
      secret: 'secret',
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30_000,
      maxReconnectAttempts: 5,
    }, {});

    const connectPromise = stream.connect();
    trigger('open');
    triggerMessage({ op: 'auth', success: true });
    await connectPromise;

    latestWsInstance!.send.mockClear();
    triggerMessage({ op: 'ping' });

    expect(JSON.parse(latestWsInstance!.send.mock.calls[0]![0] as string)).toEqual({ op: 'pong' });
  });

  it('closes the socket when pongs stop arriving', async () => {
    vi.useFakeTimers();

    const stream = new BybitPrivateStream({
      wsUrl: 'wss://fake.test/private',
      apiKey: 'api-key',
      secret: 'secret',
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30_000,
      maxReconnectAttempts: 5,
    }, {});

    const connectPromise = stream.connect();
    trigger('open');
    triggerMessage({ op: 'auth', success: true });
    await connectPromise;

    await vi.advanceTimersByTimeAsync(54_000);

    expect(latestWsInstance?.close).toHaveBeenCalledWith(4000, 'heartbeat timeout');
  });
});