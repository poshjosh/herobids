import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AlertsConfig } from '@herobids/domain';
import { AlertDispatcher } from './alert-dispatcher.js';
import type { JournalEventRow } from './alert-policy.js';

// --- helpers ---

function makeConfig(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    enabled: true,
    dispatchIntervalMs: 60_000,
    defaultCooldownMs: 300_000,
    maxBatchSize: 20,
    maxRetries: 3,
    telegram: {
      botToken: 'test-token',
      channels: [
        { chatId: '123', eventPrefixes: ['execution.', 'risk.'], minSeverity: 'warn' },
      ],
    },
    ...overrides,
  };
}

function makeEvent(overrides: Partial<JournalEventRow> = {}): JournalEventRow {
  return {
    id: 'evt-1',
    botId: 'inst-1',
    type: 'execution.failure',
    payload: { message: 'timeout' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('pino').Logger;
}

function makeDeliveryRepo(overrides: Partial<import('@herobids/db').AlertDeliveryRepository> = {}) {
  return {
    insert: vi.fn().mockResolvedValue('delivery-1'),
    insertBatch: vi.fn().mockResolvedValue(undefined),
    existsFor: vi.fn().mockResolvedValue(false),
    getPending: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markAttemptFailed: vi.fn().mockResolvedValue(undefined),
    getRecent: vi.fn().mockResolvedValue([]),
    getRecentDeliveredAfter: vi.fn().mockResolvedValue([]),
    wasEventDelivered: vi.fn().mockResolvedValue(false),
    getLastDeliveredAt: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as import('@herobids/db').AlertDeliveryRepository;
}

function makeJournal(events: JournalEventRow[] = []) {
  return {
    scanAfter: vi.fn().mockResolvedValue(events),
    getById: vi.fn().mockResolvedValue(null),
    getByIds: vi.fn().mockResolvedValue([]),
  } as unknown as import('@herobids/db').PgJournal;
}

// --- Telegram client tests ---

describe('TelegramClient', () => {
  it('attaches ForceReply markup when provided to sendText', async () => {
    const { TelegramClient, forceReply } = await import('./telegram-client.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 42 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TelegramClient('test-token');
    const result = await client.sendText('chat-123', 'Reply here', forceReply());
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://api.telegram.org/bottest-token/sendMessage', expect.objectContaining({ method: 'POST' }));
    expect(body).toEqual(expect.objectContaining({
      chat_id: 'chat-123',
      text: 'Reply here',
      reply_markup: forceReply(),
    }));
    vi.unstubAllGlobals();
  });

  it('registers the Telegram webhook with the configured secret token', async () => {
    const { TelegramClient } = await import('./telegram-client.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TelegramClient('test-token');
    const result = await client.setWebhook('https://example.com/telegram/webhook', 'secret-123');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as string);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://api.telegram.org/bottest-token/setWebhook', expect.objectContaining({ method: 'POST' }));
    expect(body).toEqual({
      url: 'https://example.com/telegram/webhook',
      secret_token: 'secret-123',
    });
    vi.unstubAllGlobals();
  });

  it('returns ok on successful API call', async () => {
    const { TelegramClient } = await import('./telegram-client.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 42 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TelegramClient('test-token');
    const result = await client.sendAlert('chat-123', makeEvent());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.messageId).toBe(42);
    }
    vi.unstubAllGlobals();
  });

  it('returns err on HTTP failure', async () => {
    const { TelegramClient } = await import('./telegram-client.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('Bad Request'),
      json: vi.fn(),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TelegramClient('test-token');
    const result = await client.sendAlert('chat-123', makeEvent());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('telegram.http_error');
    }
    vi.unstubAllGlobals();
  });

  it('returns err on Telegram API error (ok: false)', async () => {
    const { TelegramClient } = await import('./telegram-client.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({ ok: false, description: 'chat not found' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new TelegramClient('test-token');
    const result = await client.sendAlert('chat-123', makeEvent());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('telegram.api_error');
      expect(result.error.message).toBe('chat not found');
    }
    vi.unstubAllGlobals();
  });

  it('returns err on network failure', async () => {
    const { TelegramClient } = await import('./telegram-client.js');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const client = new TelegramClient('test-token');
    const result = await client.sendAlert('chat-123', makeEvent());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('telegram.network_error');
    }
    vi.unstubAllGlobals();
  });
});

// --- AlertDispatcher integration tests ---

describe('AlertDispatcher', () => {
  beforeEach(() => {
    // Mock fetch for Telegram API
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not start when disabled', async () => {
    const journal = makeJournal();
    const deliveryRepo = makeDeliveryRepo();
    const logger = makeLogger();

    const dispatcher = new AlertDispatcher(
      makeConfig({ enabled: false }),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
    );
    dispatcher.start();

    // No scan should have been called
    expect(journal.scanAfter).not.toHaveBeenCalled();
  });

  it('dispatches a single event on tick', async () => {
    const event = makeEvent({ id: 'evt-1', type: 'execution.failure' });
    const journal = makeJournal([event]);
    const deliveryRepo = makeDeliveryRepo({
      insert: vi.fn().mockResolvedValue('delivery-1'),
    });
    const logger = makeLogger();

    const dispatcher = new AlertDispatcher(
      makeConfig(),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
    );

    // Directly call the private tick via prototype cast
    await (dispatcher as unknown as { tick(): Promise<void> }).tick();

    expect(deliveryRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ journalEventId: 'evt-1', channel: 'telegram', destination: '123' }),
    );
    expect(deliveryRepo.markDelivered).toHaveBeenCalledWith('delivery-1');
  });

  it('skips duplicate events when insert returns null', async () => {
    const event = makeEvent({ id: 'evt-1', type: 'execution.failure' });
    const journal = makeJournal([event]);
    // null = duplicate
    const deliveryRepo = makeDeliveryRepo({
      insert: vi.fn().mockResolvedValue(null),
    });
    const logger = makeLogger();

    const dispatcher = new AlertDispatcher(
      makeConfig(),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
    );

    await (dispatcher as unknown as { tick(): Promise<void> }).tick();

    // markDelivered should NOT be called — already delivered or pending
    expect(deliveryRepo.markDelivered).not.toHaveBeenCalled();
  });

  it('marks delivery failed when Telegram HTTP call fails', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
      json: vi.fn(),
    }));

    const event = makeEvent({ id: 'evt-fail', type: 'execution.failure' });
    const journal = makeJournal([event]);
    const deliveryRepo = makeDeliveryRepo({
      insert: vi.fn().mockResolvedValue('delivery-fail'),
    });
    const logger = makeLogger();

    const dispatcher = new AlertDispatcher(
      makeConfig(),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
    );

    await (dispatcher as unknown as { tick(): Promise<void> }).tick();

    expect(deliveryRepo.markAttemptFailed).toHaveBeenCalledWith('delivery-fail', expect.any(String), expect.any(Number));
    expect(deliveryRepo.markDelivered).not.toHaveBeenCalled();
  });

  it('advances cursor on each tick', async () => {
    const events = [
      makeEvent({ id: 'evt-a', type: 'execution.failure', createdAt: new Date('2026-01-01T00:00:00Z') }),
      makeEvent({ id: 'evt-b', type: 'execution.failure', createdAt: new Date('2026-01-01T00:00:01Z') }),
    ];
    // First tick returns events; second tick returns empty
    const journal = makeJournal();
    (journal.scanAfter as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(events)
      .mockResolvedValueOnce([]);

    const deliveryRepo = makeDeliveryRepo();
    const logger = makeLogger();

    const dispatcher = new AlertDispatcher(
      makeConfig(),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
    );

    await (dispatcher as unknown as { tick(): Promise<void> }).tick();
    await (dispatcher as unknown as { tick(): Promise<void> }).tick();

    const secondCall = (journal.scanAfter as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0].cursor).toEqual({
      seenIds: ['evt-b'],
      createdAt: new Date('2026-01-01T00:00:01Z'),
    });
  });

  it('retries pending deliveries on tick', async () => {
    const pending = {
      id: 'delivery-pending',
      journalEventId: 'evt-retry',
      channel: 'telegram',
      destination: '123',
      status: 'failed',
      attempts: 1,
      lastError: 'timeout',
      claimedAt: null,
      deliveredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const journalEvent = makeEvent({ id: 'evt-retry', type: 'execution.failure' });
    const journal = makeJournal([]);
    (journal.getById as ReturnType<typeof vi.fn>).mockResolvedValue(journalEvent);

    const deliveryRepo = makeDeliveryRepo({
      getPending: vi.fn().mockResolvedValue([pending]),
    });
    const logger = makeLogger();

    const dispatcher = new AlertDispatcher(
      makeConfig(),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
    );

    await (dispatcher as unknown as { tick(): Promise<void> }).tick();

    expect(journal.getById).toHaveBeenCalledWith('evt-retry');
    expect(deliveryRepo.markDelivered).toHaveBeenCalledWith('delivery-pending');
  });

  it('applies cooldown: suppresses same event type within cooldown window', async () => {
    // Two events of the same type in same batch
    const events = [
      makeEvent({ id: 'evt-1', type: 'execution.failure', createdAt: new Date('2026-01-01T00:00:00Z') }),
      makeEvent({ id: 'evt-2', type: 'execution.failure', createdAt: new Date('2026-01-01T00:00:01Z') }),
    ];
    const journal = makeJournal(events);
    const insertSpy = vi.fn().mockResolvedValue('delivery-id');
    const deliveryRepo = makeDeliveryRepo({ insert: insertSpy });
    const logger = makeLogger();

    const dispatcher = new AlertDispatcher(
      makeConfig({ defaultCooldownMs: 300_000 }),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
    );

    await (dispatcher as unknown as { tick(): Promise<void> }).tick();

    // Only 1 delivery per type per cooldown window
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('seeds cooldowns from the latest deliveredAt even when getByIds returns unordered rows', async () => {
    const olderDeliveredAt = new Date('2026-01-01T00:04:00Z');
    const newerDeliveredAt = new Date('2026-01-01T00:05:00Z');
    const olderEvent = makeEvent({ id: 'evt-older', createdAt: new Date('2026-01-01T00:00:00Z') });
    const newerEvent = makeEvent({ id: 'evt-newer', createdAt: new Date('2026-01-01T00:00:30Z') });

    const journal = makeJournal();
    (journal.getByIds as ReturnType<typeof vi.fn>).mockResolvedValue([olderEvent, newerEvent]);

    const deliveryRepo = makeDeliveryRepo({
      getRecentDeliveredAfter: vi.fn().mockResolvedValue([
        {
          id: 'delivery-newer',
          journalEventId: 'evt-newer',
          channel: 'telegram',
          destination: '123',
          status: 'delivered',
          attempts: 1,
          lastError: null,
          claimedAt: null,
          deliveredAt: newerDeliveredAt,
          createdAt: new Date('2026-01-01T00:00:35Z'),
          updatedAt: newerDeliveredAt,
        },
        {
          id: 'delivery-older',
          journalEventId: 'evt-older',
          channel: 'telegram',
          destination: '123',
          status: 'delivered',
          attempts: 1,
          lastError: null,
          claimedAt: null,
          deliveredAt: olderDeliveredAt,
          createdAt: new Date('2026-01-01T00:00:05Z'),
          updatedAt: olderDeliveredAt,
        },
      ]),
    });
    const logger = makeLogger();

    const dispatcher = new AlertDispatcher(
      makeConfig(),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
    );

    await (dispatcher as unknown as { seedCooldownsFromDb(): Promise<void> }).seedCooldownsFromDb();

    const cooldowns = (dispatcher as unknown as { cooldowns: Map<string, number> }).cooldowns;
    expect(cooldowns.get('inst-1:execution.failure')).toBe(newerDeliveredAt.getTime());
  });
});

// --- Redis singleton lease tests ---

describe('AlertDispatcher Redis lease', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not dispatch when another worker holds the Redis lease', async () => {
    const event = makeEvent();
    const journal = makeJournal([event]);
    const deliveryRepo = makeDeliveryRepo();
    const logger = makeLogger();

    // Mock Redis: NX set fails (another worker holds lease)
    const redisMock = {
      set: vi.fn().mockResolvedValue(null), // null = not acquired
      eval: vi.fn().mockResolvedValue(1),
    } as unknown as import('ioredis').default;

    const dispatcher = new AlertDispatcher(
      makeConfig(),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
      redisMock,
      'worker-2',
    );

    await (dispatcher as unknown as { tick(): Promise<void> }).tick();

    // Should not scan events since lease not acquired
    expect(journal.scanAfter).not.toHaveBeenCalled();
    expect(deliveryRepo.insert).not.toHaveBeenCalled();
  });

  it('dispatches when this worker holds the Redis lease', async () => {
    const event = makeEvent({ id: 'evt-held', type: 'execution.failure' });
    const journal = makeJournal([event]);
    const deliveryRepo = makeDeliveryRepo();
    const logger = makeLogger();

    // Mock Redis: NX set succeeds
    const redisMock = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
    } as unknown as import('ioredis').default;

    const dispatcher = new AlertDispatcher(
      makeConfig(),
      journal as unknown as import('@herobids/db').PgJournal,
      deliveryRepo,
      logger,
      redisMock,
      'worker-1',
    );

    await (dispatcher as unknown as { tick(): Promise<void> }).tick();

    expect(journal.scanAfter).toHaveBeenCalled();
    expect(deliveryRepo.insert).toHaveBeenCalled();
  });
});
