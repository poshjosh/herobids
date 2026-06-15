import { eq } from 'drizzle-orm';
import { connections, tradingBindings, venueAccounts } from '@herobids/db';
import type { BotRepository, Database } from '@herobids/db';

type BotRow = Awaited<ReturnType<BotRepository['getBotById']>>;

export interface VenueAccountStartupRow {
  id: string;
  userId: string;
  venue: string;
  label: string;
  venueAccountRef: string | null;
  credentialId: string | null;
}

export class BotStartupError extends Error {
  constructor(
    public readonly code:
      | 'bot_not_found'
      | 'missing_trading_binding_id'
      | 'binding_not_found'
      | 'binding_not_usable'
      | 'missing_source_venue_account'
      | 'source_venue_account_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'BotStartupError';
  }
}

export interface BotStartupContext {
  botId: string;
  userId: string;
  tradingBindingId: string;
  provider: string;
  connectionId: string;
  sourceVenueAccountId: string | null;
  /** True when the resolved provider requires a source venue account for execution. */
  sourceVenueAccountRequired: boolean;
  venueAccount: VenueAccountStartupRow | null;
}

export interface ResolveBotStartupContextParams {
  db: Database;
  botRepo: Pick<BotRepository, 'getBotById'>;
  botId: string;
  rawConfig: Record<string, unknown>;
  venue: string;
  venueType: 'orderbook' | 'swap';
}

function readStringValue(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiresSourceVenueAccount(venue: string, venueType: 'orderbook' | 'swap'): boolean {
  if (venueType === 'orderbook') return true;

  const normalizedVenue = venue.toLowerCase();
  return normalizedVenue === 'jupiter' || normalizedVenue === '1inch';
}

function resolveTradingBindingId(bot: NonNullable<BotRow>, rawConfig: Record<string, unknown>): string {
  // Only accept genuine tradingBindingId values — do NOT fall back to venueAccountId
  // as a surrogate, since a venue-account ID is not a valid trading-binding ID and
  // would cause misleading lookup failures in resolveBotStartupContext.
  return readStringValue(rawConfig, 'tradingBindingId')
    ?? bot.tradingBindingId
    ?? '';
}

export async function resolveBotStartupContext(params: ResolveBotStartupContextParams): Promise<BotStartupContext> {
  const bot = await params.botRepo.getBotById(params.botId);
  if (!bot) {
    throw new BotStartupError('bot_not_found', `Bot ${params.botId} not found — cannot resolve startup context`);
  }

  const tradingBindingId = resolveTradingBindingId(bot, params.rawConfig);
  if (!tradingBindingId) {
    throw new BotStartupError('missing_trading_binding_id', `Bot ${params.botId} has no tradingBindingId in job config or persisted bot row — refusing to start`);
  }

  const [bindingRow] = await params.db
    .select({
      provider: tradingBindings.provider,
      connectionId: tradingBindings.connectionId,
      sourceVenueAccountId: tradingBindings.sourceVenueAccountId,
      bindingStatus: tradingBindings.status,
      connectionStatus: connections.status,
    })
    .from(tradingBindings)
    .innerJoin(connections, eq(tradingBindings.connectionId, connections.id))
    .where(eq(tradingBindings.id, tradingBindingId))
    .limit(1);

  if (!bindingRow) {
    throw new BotStartupError('binding_not_found', `Trading binding ${tradingBindingId} not found — cannot start bot ${params.botId}`);
  }

  if (bindingRow.bindingStatus !== 'active' || bindingRow.connectionStatus !== 'active') {
    throw new BotStartupError('binding_not_usable', `Trading binding ${tradingBindingId} is not usable for startup — binding or connection is inactive`);
  }

  const sourceVenueAccountId = bindingRow.sourceVenueAccountId;
  const needsSourceVenueAccount = requiresSourceVenueAccount(params.venue, params.venueType);
  if (!sourceVenueAccountId && needsSourceVenueAccount) {
    throw new BotStartupError('missing_source_venue_account', `Trading binding ${tradingBindingId} is missing sourceVenueAccountId — cannot start ${params.venueType} bot ${params.botId}`);
  }

  let venueAccount: VenueAccountStartupRow | null = null;
  if (sourceVenueAccountId) {
    const [venueAccountRow] = await params.db
      .select({
        id: venueAccounts.id,
        userId: venueAccounts.userId,
        venue: venueAccounts.venue,
        label: venueAccounts.label,
        venueAccountRef: venueAccounts.venueAccountRef,
        credentialId: venueAccounts.credentialId,
      })
      .from(venueAccounts)
      .where(eq(venueAccounts.id, sourceVenueAccountId))
      .limit(1);

    if (!venueAccountRow) {
      if (needsSourceVenueAccount) {
        throw new BotStartupError('source_venue_account_not_found', `Source venue account ${sourceVenueAccountId} not found — cannot start bot ${params.botId}`);
      }
    } else {
      venueAccount = venueAccountRow;
    }
  }

  return {
    botId: params.botId,
    userId: bot.userId,
    tradingBindingId,
    provider: bindingRow.provider,
    connectionId: bindingRow.connectionId,
    sourceVenueAccountId,
    sourceVenueAccountRequired: needsSourceVenueAccount,
    venueAccount,
  };
}