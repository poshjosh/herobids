import { eq } from 'drizzle-orm';
import { connections, venueAccounts } from '@herobids/db';
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
      | 'missing_connection_id'
      | 'connection_not_found'
      | 'connection_not_usable'
      | 'connection_venue_account_mismatch'
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
  connectionId: string;
  provider: string;
  resolvedVenueAccountId: string | null;
  /** True when the resolved provider requires a venue account for execution. */
  venueAccountRequired: boolean;
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

function resolveConnectionId(bot: NonNullable<BotRow>, rawConfig: Record<string, unknown>): string {
  return readStringValue(rawConfig, 'connectionId') ?? bot.connectionId ?? '';
}

export async function resolveBotStartupContext(params: ResolveBotStartupContextParams): Promise<BotStartupContext> {
  const bot = await params.botRepo.getBotById(params.botId);
  if (!bot) {
    throw new BotStartupError('bot_not_found', `Bot ${params.botId} not found — cannot resolve startup context`);
  }

  const connectionId = resolveConnectionId(bot, params.rawConfig);
  if (!connectionId) {
    throw new BotStartupError('missing_connection_id', `Bot ${params.botId} has no connectionId in job config or persisted bot row — refusing to start`);
  }

  const [connRow] = await params.db
    .select({
      provider: connections.provider,
      connectionStatus: connections.status,
      resolvedVenueAccountId: connections.resolvedVenueAccountId,
    })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  if (!connRow) {
    throw new BotStartupError('connection_not_found', `Connection ${connectionId} not found — cannot start bot ${params.botId}`);
  }

  if (connRow.connectionStatus !== 'active') {
    throw new BotStartupError('connection_not_usable', `Connection ${connectionId} is not usable for startup — status is "${connRow.connectionStatus}" (expected "active")`);
  }

  // Validate that the bot's venue account matches the connection's resolved venue account.
  // A mismatch means the bot was created before the connection model was updated and could
  // silently trade against the wrong account.
  const botVenueAccountId: string | null = bot.venueAccountId ?? null;
  const connResolvedVaId = connRow.resolvedVenueAccountId ?? null;
  if (botVenueAccountId !== connResolvedVaId) {
    throw new BotStartupError(
      'connection_venue_account_mismatch',
      `Bot ${params.botId} venue account (${botVenueAccountId ?? 'none'}) does not match connection ${connectionId} resolved venue account (${connResolvedVaId ?? 'none'}). The bot must be recreated with the correct connection.`,
    );
  }

  // Look up venue account using the connection's resolved venue account as the authoritative source
  const [vaRow] = await params.db
    .select({
      id: venueAccounts.id,
      userId: venueAccounts.userId,
      venue: venueAccounts.venue,
      label: venueAccounts.label,
      venueAccountRef: venueAccounts.venueAccountRef,
      credentialId: venueAccounts.credentialId,
    })
    .from(venueAccounts)
    .where(eq(venueAccounts.id, connRow.resolvedVenueAccountId ?? ''))
    .limit(1);

  const resolvedVenueAccountId = vaRow?.id ?? null;
  const needsVenueAccount = requiresSourceVenueAccount(params.venue, params.venueType);

  if (!resolvedVenueAccountId && needsVenueAccount) {
    throw new BotStartupError('missing_source_venue_account', `Bot ${params.botId} has no venue account — cannot start ${params.venueType} bot`);
  }

  let venueAccount: VenueAccountStartupRow | null = null;
  if (resolvedVenueAccountId) {
    if (!vaRow) {
      if (needsVenueAccount) {
        throw new BotStartupError('source_venue_account_not_found', `Venue account ${resolvedVenueAccountId} not found — cannot start bot ${params.botId}`);
      }
    } else {
      venueAccount = vaRow;
    }
  }

  return {
    botId: params.botId,
    userId: bot.userId,
    connectionId,
    provider: connRow.provider,
    resolvedVenueAccountId,
    venueAccountRequired: needsVenueAccount,
    venueAccount,
  };
}