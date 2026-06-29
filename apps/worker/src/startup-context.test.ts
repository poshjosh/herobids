import { describe, expect, it, vi } from 'vitest';
import type { Database, BotRepository } from '@herobids/db';
import { resolveBotStartupContext, BotStartupError } from './startup-context.js';

function makeDbMock(connectionRows: unknown[], venueAccountRows: unknown[]) {
  const select = vi.fn()
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(connectionRows),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(venueAccountRows),
        }),
      }),
    });

  return { select } as unknown as Database;
}

describe('resolveBotStartupContext', () => {
  it('prefers the raw connectionId and resolves the venue account', async () => {
    const db = makeDbMock([
      {
        provider: 'hyperliquid',
        connectionId: 'conn-1',
        resolvedVenueAccountId: 'va-1',
        connectionStatus: 'active',
      },
    ], [
      {
        id: 'va-1',
        userId: 'user-1',
        venue: 'hyperliquid',
        label: 'Main',
        venueAccountRef: 'acct-1',
        credentialId: 'cred-1',
      },
    ]);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-1',
        userId: 'user-1',
        venueAccountId: 'va-1',
        connectionId: 'binding-bot',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const context = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-1',
      rawConfig: { connectionId: 'binding-raw', userId: 'user-1' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    });

    expect(context).toEqual({
      botId: 'bot-1',
      userId: 'user-1',
      connectionId: 'binding-raw',
      provider: 'hyperliquid',
      resolvedVenueAccountId: 'va-1',
      venueAccountRequired: true,
      venueAccount: {
        id: 'va-1',
        userId: 'user-1',
        venue: 'hyperliquid',
        label: 'Main',
        venueAccountRef: 'acct-1',
        credentialId: 'cred-1',
      },
    });
  });

  it('falls back to the persisted bot connectionId when the job payload is legacy', async () => {
    const db = makeDbMock([
      {
        provider: 'jupiter',
        connectionId: 'conn-2',
        resolvedVenueAccountId: 'va-2',
        connectionStatus: 'active',
      },
    ], [
      {
        id: 'va-2',
        userId: 'user-2',
        venue: 'jupiter',
        label: 'Solana',
        venueAccountRef: 'wallet-2',
        credentialId: 'cred-2',
      },
    ]);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-2',
        userId: 'user-2',
        venueAccountId: 'va-2',
        connectionId: 'binding-bot-2',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const context = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-2',
      rawConfig: { venueAccountId: 'va-2', userId: 'user-2' },
      venue: 'jupiter',
      venueType: 'swap',
    });

    expect(context.connectionId).toBe('binding-bot-2');
    expect(context.resolvedVenueAccountId).toBe('va-2');
    expect(context.venueAccountRequired).toBe(true);
    expect(context.venueAccount?.venueAccountRef).toBe('wallet-2');
  });

  it('fails when a required venue account is missing', async () => {
    const db = makeDbMock([
      {
        provider: 'jupiter',
        connectionId: 'conn-3',
        resolvedVenueAccountId: null,
        connectionStatus: 'active',
      },
    ], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-3',
        userId: 'user-3',
        connectionId: 'binding-3',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const err = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-3',
      rawConfig: { connectionId: 'binding-3', userId: 'user-3' },
      venue: 'jupiter',
      venueType: 'swap',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BotStartupError);
    expect((err as BotStartupError).code).toBe('missing_source_venue_account');
  });

  it('throws BotStartupError with code connection_not_found for an unknown connection', async () => {
    const db = makeDbMock([], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-4',
        userId: 'user-4',
        venueAccountId: 'va-4',
        connectionId: 'binding-unknown',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const err = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-4',
      rawConfig: { connectionId: 'binding-unknown' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BotStartupError);
    expect((err as BotStartupError).code).toBe('connection_not_found');
  });

  it('throws BotStartupError with code missing_source_venue_account for required account', async () => {
    const db = makeDbMock([
      {
        provider: 'hyperliquid',
        connectionId: 'conn-5',
        resolvedVenueAccountId: null,
        connectionStatus: 'active',
      },
    ], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-5',
        userId: 'user-5',
        connectionId: 'binding-5',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const err = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-5',
      rawConfig: { connectionId: 'binding-5' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BotStartupError);
    expect((err as BotStartupError).code).toBe('missing_source_venue_account');
  });

  it('throws connection_venue_account_mismatch when bot.venueAccountId differs from connection.resolvedVenueAccountId', async () => {
    const db = makeDbMock([
      {
        provider: 'hyperliquid',
        connectionId: 'conn-mismatch',
        resolvedVenueAccountId: 'va-correct',
        connectionStatus: 'active',
      },
    ], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-mismatch',
        userId: 'user-mismatch',
        venueAccountId: 'va-wrong',
        connectionId: 'conn-mismatch',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const err = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-mismatch',
      rawConfig: { connectionId: 'conn-mismatch' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BotStartupError);
    expect((err as BotStartupError).code).toBe('connection_venue_account_mismatch');
    expect((err as BotStartupError).message).toContain('va-wrong');
    expect((err as BotStartupError).message).toContain('va-correct');
  });

  it('throws connection_venue_account_mismatch when bot has venueAccountId but connection resolvedVenueAccountId is null', async () => {
    const db = makeDbMock([
      {
        provider: 'hyperliquid',
        connectionId: 'conn-va-null',
        resolvedVenueAccountId: null,
        connectionStatus: 'active',
      },
    ], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-va-null',
        userId: 'user-va-null',
        venueAccountId: 'va-from-bot',
        connectionId: 'conn-va-null',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const err = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-va-null',
      rawConfig: { connectionId: 'conn-va-null' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BotStartupError);
    expect((err as BotStartupError).code).toBe('connection_venue_account_mismatch');
  });

  it('throws BotStartupError with code bot_not_found when getBotById returns null', async () => {
    const db = makeDbMock([], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue(null),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const err = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-nonexistent',
      rawConfig: { connectionId: 'any' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BotStartupError);
    expect((err as BotStartupError).code).toBe('bot_not_found');
  });

  it('throws BotStartupError with code connection_not_usable when connection status is revoked', async () => {
    const db = makeDbMock([
      {
        provider: 'hyperliquid',
        connectionId: 'conn-revoked',
        resolvedVenueAccountId: 'va-1',
        connectionStatus: 'revoked',
      },
    ], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-revoked',
        userId: 'user-1',
        venueAccountId: 'va-1',
        connectionId: 'conn-revoked',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const err = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-revoked',
      rawConfig: { connectionId: 'conn-revoked' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BotStartupError);
    expect((err as BotStartupError).code).toBe('connection_not_usable');
  });
});