import { describe, expect, it, vi } from 'vitest';
import type { Database, BotRepository } from '@herobids/db';
import { resolveBotStartupContext, BotStartupError } from './startup-context.js';

function makeDbMock(bindingRows: unknown[], venueAccountRows: unknown[]) {
  let selectCall = 0;
  const select = vi.fn().mockImplementation(() => {
    selectCall += 1;
    if (selectCall === 1) {
      return {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(bindingRows),
            }),
          }),
        }),
      };
    }

    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(venueAccountRows),
        }),
      }),
    };
  });

  return { select } as unknown as Database;
}

describe('resolveBotStartupContext', () => {
  it('prefers the raw tradingBindingId and resolves the source venue account', async () => {
    const db = makeDbMock([
      {
        provider: 'hyperliquid',
        connectionId: 'conn-1',
        sourceVenueAccountId: 'va-1',
        bindingStatus: 'active',
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
        venueAccountId: 'va-legacy',
        tradingBindingId: 'binding-bot',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const context = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-1',
      rawConfig: { tradingBindingId: 'binding-raw', userId: 'user-1' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    });

    expect(context).toEqual({
      botId: 'bot-1',
      userId: 'user-1',
      tradingBindingId: 'binding-raw',
      provider: 'hyperliquid',
      connectionId: 'conn-1',
      sourceVenueAccountId: 'va-1',
      sourceVenueAccountRequired: true,
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

  it('falls back to the persisted bot tradingBindingId when the job payload is legacy', async () => {
    const db = makeDbMock([
      {
        provider: 'jupiter',
        connectionId: 'conn-2',
        sourceVenueAccountId: 'va-2',
        bindingStatus: 'active',
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
        tradingBindingId: 'binding-bot-2',
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

    expect(context.tradingBindingId).toBe('binding-bot-2');
    expect(context.sourceVenueAccountId).toBe('va-2');
    expect(context.sourceVenueAccountRequired).toBe(true);
    expect(context.venueAccount?.venueAccountRef).toBe('wallet-2');
  });

  it('fails when a required source venue account is missing', async () => {
    const db = makeDbMock([
      {
        provider: 'jupiter',
        connectionId: 'conn-3',
        sourceVenueAccountId: null,
        bindingStatus: 'active',
        connectionStatus: 'active',
      },
    ], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-3',
        userId: 'user-3',
        venueAccountId: 'va-3',
        tradingBindingId: 'binding-3',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    await expect(resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-3',
      rawConfig: { tradingBindingId: 'binding-3', userId: 'user-3' },
      venue: 'jupiter',
      venueType: 'swap',
    })).rejects.toThrow('missing sourceVenueAccountId');
  });

  it('throws BotStartupError with code binding_not_found for an unknown binding', async () => {
    const db = makeDbMock([], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-4',
        userId: 'user-4',
        venueAccountId: 'va-4',
        tradingBindingId: 'binding-unknown',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const err = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-4',
      rawConfig: { tradingBindingId: 'binding-unknown' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BotStartupError);
    expect((err as BotStartupError).code).toBe('binding_not_found');
  });

  it('throws BotStartupError with code missing_source_venue_account for required account', async () => {
    const db = makeDbMock([
      {
        provider: 'hyperliquid',
        connectionId: 'conn-5',
        sourceVenueAccountId: null,
        bindingStatus: 'active',
        connectionStatus: 'active',
      },
    ], []);
    const botRepo = {
      getBotById: vi.fn().mockResolvedValue({
        id: 'bot-5',
        userId: 'user-5',
        venueAccountId: 'va-5',
        tradingBindingId: 'binding-5',
      }),
    } satisfies Pick<BotRepository, 'getBotById'>;

    const err = await resolveBotStartupContext({
      db,
      botRepo,
      botId: 'bot-5',
      rawConfig: { tradingBindingId: 'binding-5' },
      venue: 'hyperliquid',
      venueType: 'orderbook',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BotStartupError);
    expect((err as BotStartupError).code).toBe('missing_source_venue_account');
  });
});