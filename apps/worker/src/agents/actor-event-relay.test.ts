import { describe, it, expect, vi } from 'vitest';
import type { ActorEventRelayConfig } from '@herobids/domain';
import { ActorEventRelay } from './actor-event-relay.js';
import type { ConsumerNotificationFeed, ConsumerNotificationRow } from './boundary-consumer-notification-feed.js';

function makeConfig(overrides: Partial<ActorEventRelayConfig> = {}): ActorEventRelayConfig {
  return {
    enabled: true,
    pollIntervalMs: 5000,
    maxBatchSize: 100,
    maxEventAgeMs: 600_000,
    settleLagMs: 5000,
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as import('pino').Logger;
}

/** A Map-backed fake Redis supporting the lease + cursor surface the relay uses. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
      // NX only matters for the lease; the relay always holds it in tests.
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: vi.fn(async () => 1), // lease renew succeeds
  } as unknown as import('ioredis').default;
}

const SCANNER_WAKE = {
  wakeId: 'wake-1',
  source: 'scanner' as const,
  reason: 'signals ready',
  eventIds: ['e1'],
  priority: 'normal' as const,
  requestedAt: '2026-06-11T00:00:00.000Z',
  context: { scannerKind: 'signal_scoring' as const, signalCount: 2, topSymbol: 'BTC', topConfidence: 0.9, regimePass: true },
};

function row(overrides: Partial<ConsumerNotificationRow> & { type: string }): ConsumerNotificationRow {
  return {
    id: 'n-1',
    ownerId: 'owner-1',
    agentId: 'agent-1',
    botId: null,
    payload: {},
    createdAt: new Date(1_000_000),
    ...overrides,
  };
}

function makeFeed(rows: ConsumerNotificationRow[]): ConsumerNotificationFeed & { scan: ReturnType<typeof vi.fn> } {
  return { scan: vi.fn(async () => rows) };
}

function makePublishers() {
  return {
    eventPublisher: {
      emitAgentWakeStrict: vi.fn(async () => undefined),
      emitTechnicalScanCompletedStrict: vi.fn(async () => undefined),
      emitJournalEventStrict: vi.fn(async () => undefined),
      emitInstanceStatusStrict: vi.fn(async () => undefined),
    },
    userEventPublisher: { publishBotStatusStrict: vi.fn(async () => undefined) },
  };
}

function build(opts: {
  rows: ConsumerNotificationRow[];
  now: number;
  config?: Partial<ActorEventRelayConfig>;
  getActiveSession?: ReturnType<typeof vi.fn>;
  handleRuntimeFailure?: ReturnType<typeof vi.fn>;
  redis?: ReturnType<typeof makeRedis>;
}) {
  const feed = makeFeed(opts.rows);
  const publishers = makePublishers();
  const sessionManager = { handleRuntimeFailure: opts.handleRuntimeFailure ?? vi.fn(async () => undefined) };
  const agentRepo = { getActiveSession: opts.getActiveSession ?? vi.fn(async () => null) };
  const redis = opts.redis ?? makeRedis();
  const relay = new ActorEventRelay({
    config: makeConfig(opts.config),
    feed,
    eventPublisher: publishers.eventPublisher,
    userEventPublisher: publishers.userEventPublisher,
    sessionManager: sessionManager as never,
    agentRepo: agentRepo as never,
    redis,
    workerId: 'worker-1',
    logger: makeLogger(),
    now: () => opts.now,
  });
  return { relay, feed, publishers, sessionManager, agentRepo, redis };
}

// A createdAt comfortably older than the settle lag relative to `now`.
const NOW = 10_000_000;
const OLD = new Date(NOW - 60_000);

describe('ActorEventRelay', () => {
  it('republishes an agent_wake row onto the agent\'s outbound stream', async () => {
    const { relay, publishers } = build({ now: NOW, rows: [row({ type: 'agent_wake', payload: { wake: SCANNER_WAKE }, createdAt: OLD })] });
    await relay.tick();
    expect(publishers.eventPublisher.emitAgentWakeStrict).toHaveBeenCalledWith('agent-1', SCANNER_WAKE);
  });

  it('republishes a scan_completed row', async () => {
    const scan = { timestamp: 't', scanIntervalMs: 60000, signals: [] };
    const { relay, publishers } = build({ now: NOW, rows: [row({ type: 'scan_completed', payload: { scan }, createdAt: OLD })] });
    await relay.tick();
    expect(publishers.eventPublisher.emitTechnicalScanCompletedStrict).toHaveBeenCalledWith('agent-1', scan);
  });

  it('republishes a bot halt as instance status with managed bots and updatedAt', async () => {
    const { relay, publishers } = build({
      now: NOW,
      rows: [row({ type: 'bot_status', botId: 'bot-1', payload: { status: 'stopped', reason: 'bot_halted_error_limit', managedBots: [{ id: 'bot-1', status: 'stopped' }] }, createdAt: OLD })],
    });
    await relay.tick();
    expect(publishers.eventPublisher.emitInstanceStatusStrict).toHaveBeenCalledWith('agent-1', {
      status: 'stopped',
      reason: 'bot_halted_error_limit',
      managedBots: [{ id: 'bot-1', status: 'stopped' }],
      updatedAt: OLD.toISOString(),
    });
  });

  it('publishes user bot status for a user-created bot', async () => {
    const { relay, publishers } = build({
      now: NOW,
      rows: [row({ type: 'bot_status', agentId: null, botId: 'bot-9', ownerId: 'user-7', payload: { status: 'crashed', reason: 'runtime_crash', managedBots: [] }, createdAt: OLD })],
    });
    await relay.tick();
    expect(publishers.userEventPublisher.publishBotStatusStrict).toHaveBeenCalledWith('user-7', 'bot-9', 'crashed');
    expect(publishers.eventPublisher.emitInstanceStatusStrict).not.toHaveBeenCalled();
  });

  it('initialises the cursor to now minus the settle lag', async () => {
    const redis = makeRedis();
    const { relay } = build({ now: NOW, rows: [], redis });
    await relay.tick();
    const cursor = JSON.parse(redis.store.get('actor-event-relay:cursor')!);
    expect(new Date(cursor.createdAt).getTime()).toBe(NOW - 5000);
  });

  it('does not process or pass rows younger than the settle lag', async () => {
    const young = new Date(NOW - 1000); // within the 5s settle lag
    const { relay, publishers } = build({ now: NOW, rows: [row({ type: 'agent_wake', payload: { wake: SCANNER_WAKE }, createdAt: young })] });
    await relay.tick();
    expect(publishers.eventPublisher.emitAgentWakeStrict).not.toHaveBeenCalled();
  });

  it('does not advance the cursor when a republish fails', async () => {
    const redis = makeRedis();
    const { relay, publishers } = build({ now: NOW, rows: [row({ id: 'failing', type: 'agent_wake', payload: { wake: SCANNER_WAKE }, createdAt: OLD })], redis });
    (publishers.eventPublisher.emitAgentWakeStrict as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('xadd failed'));
    await relay.tick();
    // The failed row is the first handled row, so no advance occurs: the cursor
    // stays at its init value (now - settleLag), NOT at the failed row's ts/id.
    const cursor = JSON.parse(redis.store.get('actor-event-relay:cursor')!);
    expect(new Date(cursor.createdAt).getTime()).toBe(NOW - 5000);
    expect(cursor.seenIds).not.toContain('failing');
  });

  it('merges seenIds when the boundary timestamp is unchanged', async () => {
    const ts = new Date(NOW - 60_000);
    const redis = makeRedis();
    // First tick handles n-a at ts.
    const first = build({ now: NOW, rows: [row({ id: 'n-a', type: 'agent_wake', payload: { wake: SCANNER_WAKE }, createdAt: ts })], redis });
    await first.relay.tick();
    let cursor = JSON.parse(redis.store.get('actor-event-relay:cursor')!);
    expect(cursor.seenIds).toEqual(['n-a']);
    // Second tick handles n-b at the SAME ts → seenIds merged.
    const second = build({ now: NOW, rows: [row({ id: 'n-b', type: 'agent_wake', payload: { wake: SCANNER_WAKE }, createdAt: ts })], redis });
    await second.relay.tick();
    cursor = JSON.parse(redis.store.get('actor-event-relay:cursor')!);
    expect(new Set(cursor.seenIds)).toEqual(new Set(['n-a', 'n-b']));
  });

  it('skips stale wakes but delivers stale bot and journal events', async () => {
    const stale = new Date(NOW - 700_000); // older than maxEventAgeMs (600s)
    const wake = build({ now: NOW, rows: [row({ type: 'agent_wake', payload: { wake: SCANNER_WAKE }, createdAt: stale })] });
    await wake.relay.tick();
    expect(wake.publishers.eventPublisher.emitAgentWakeStrict).not.toHaveBeenCalled();

    const journal = build({ now: NOW, rows: [row({ type: 'journal_event', payload: { journalType: 'reconciliation.applied', detail: '{}' }, createdAt: stale })] });
    await journal.relay.tick();
    expect(journal.publishers.eventPublisher.emitJournalEventStrict).toHaveBeenCalled();

    const bot = build({ now: NOW, rows: [row({ type: 'bot_status', botId: 'b1', payload: { status: 'stopped', reason: 'r', managedBots: [] }, createdAt: stale })] });
    await bot.relay.tick();
    expect(bot.publishers.eventPublisher.emitInstanceStatusStrict).toHaveBeenCalled();
  });

  it('fails the live session on an agent_status crash raised during it', async () => {
    const startedAt = new Date(NOW - 120_000);
    const crashedAt = new Date(NOW - 60_000);
    const getActiveSession = vi.fn(async () => ({ id: 'session-1', startedAt }));
    const handleRuntimeFailure = vi.fn(async () => undefined);
    const { relay } = build({
      now: NOW,
      rows: [row({ type: 'agent_status', payload: { status: 'crashed', error: 'boom' }, createdAt: crashedAt })],
      getActiveSession,
      handleRuntimeFailure,
    });
    await relay.tick();
    expect(handleRuntimeFailure).toHaveBeenCalledWith('session-1', 'agent-1', 'owner-1', expect.any(Error));
  });

  it('ignores an agent_status crash from before the live session started', async () => {
    const startedAt = new Date(NOW - 30_000);
    const crashedAt = new Date(NOW - 60_000); // before the session started
    const getActiveSession = vi.fn(async () => ({ id: 'session-2', startedAt }));
    const handleRuntimeFailure = vi.fn(async () => undefined);
    const { relay } = build({
      now: NOW,
      rows: [row({ type: 'agent_status', payload: { status: 'crashed', error: 'boom' }, createdAt: crashedAt })],
      getActiveSession,
      handleRuntimeFailure,
    });
    await relay.tick();
    expect(handleRuntimeFailure).not.toHaveBeenCalled();
  });

  it('skips a malformed row and advances past it', async () => {
    const redis = makeRedis();
    const { relay, publishers } = build({ now: NOW, rows: [row({ id: 'bad', type: 'agent_wake', payload: { wake: { nonsense: true } }, createdAt: OLD })], redis });
    await relay.tick();
    expect(publishers.eventPublisher.emitAgentWakeStrict).not.toHaveBeenCalled();
    // Malformed is treated as handled → the cursor advances past it.
    const cursor = JSON.parse(redis.store.get('actor-event-relay:cursor')!);
    expect(cursor.seenIds).toContain('bad');
  });

  it('does nothing when it does not hold the lease', async () => {
    const redis = makeRedis();
    (redis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null); // NX fails
    const { relay, feed } = build({ now: NOW, rows: [row({ type: 'agent_wake', payload: { wake: SCANNER_WAKE }, createdAt: OLD })], redis });
    await relay.tick();
    expect(feed.scan).not.toHaveBeenCalled();
  });

  it('reschedules after a feed failure', async () => {
    const feed: ConsumerNotificationFeed = { scan: vi.fn(async () => { throw new Error('boundary down'); }) };
    const publishers = makePublishers();
    const relay = new ActorEventRelay({
      config: makeConfig(),
      feed,
      eventPublisher: publishers.eventPublisher,
      userEventPublisher: publishers.userEventPublisher,
      sessionManager: { handleRuntimeFailure: vi.fn() } as never,
      agentRepo: { getActiveSession: vi.fn(async () => null) } as never,
      redis: makeRedis(),
      workerId: 'worker-1',
      logger: makeLogger(),
      now: () => NOW,
    });
    // The tick swallows the feed error (does not throw) so the interval keeps firing.
    await expect(relay.tick()).resolves.toBeUndefined();
  });
});
