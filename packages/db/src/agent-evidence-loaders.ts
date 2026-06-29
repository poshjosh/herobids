import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import type { Database } from './index.js';
import { bots, fills, journalEvents, agentRuntimeSessions, positions } from './schema/index.js';

// ── Shared query filter type ─────────────────────────────────────────────────

export interface LoaderTimeFilter {
  from?: Date;
  to?: Date;
  /** Pre-resolved bot IDs to avoid redundant loadAgentBotIds queries. When provided, the loader skips its internal bot-ID lookup. */
  botIds?: string[];
}

// ── Agent-owned bot discovery ────────────────────────────────────────────────

/**
 * Return the IDs of all bots owned by an agent.
 * Agents own bots via `bots.creatorType = 'agent'` and `bots.creatorId = agentId`.
 */
export async function loadAgentBotIds(db: Database, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, agentId)));
  return rows.map((r) => r.id);
}

// ── Fill loaders ─────────────────────────────────────────────────────────────

/**
 * Load all fills attributable to an agent (agent-native + agent-owned bots).
 *
 * Agent-native fills: `actorType = 'agent'`, `actorId = agentId`.
 * Bot fills: `actorType = 'bot'`, `actorId IN agentBotIds`.
 */
export async function loadAgentFills(
  db: Database,
  agentId: string,
  opts?: LoaderTimeFilter,
): Promise<typeof fills.$inferSelect[]> {
  const agentBotIds = opts?.botIds ?? await loadAgentBotIds(db, agentId);

  const [agentRows, botRows] = await Promise.all([
    db
      .select()
      .from(fills)
      .where(and(
        eq(fills.actorType, 'agent'),
        eq(fills.actorId, agentId),
        ...(opts?.from ? [gte(fills.filledAt, opts.from)] : []),
        ...(opts?.to ? [lte(fills.filledAt, opts.to)] : []),
      )),
    agentBotIds.length > 0
      ? db
          .select()
          .from(fills)
          .where(and(
            eq(fills.actorType, 'bot'),
            inArray(fills.actorId, agentBotIds),
            ...(opts?.from ? [gte(fills.filledAt, opts.from)] : []),
            ...(opts?.to ? [lte(fills.filledAt, opts.to)] : []),
          ))
      : Promise.resolve([]),
  ]);

  return [...agentRows, ...botRows];
}

// ── Journal event loaders ────────────────────────────────────────────────────

/**
 * Load all journal events attributable to an agent (agent-native + agent-owned bots).
 *
 * Agent-native: `actorType = 'agent'`, `actorId = agentId`.
 * Bot: `actorType = 'bot'`, `actorId IN agentBotIds`.
 */
export async function loadAgentJournalEvents(
  db: Database,
  agentId: string,
  opts?: LoaderTimeFilter,
): Promise<typeof journalEvents.$inferSelect[]> {
  const agentBotIds = opts?.botIds ?? await loadAgentBotIds(db, agentId);

  const [agentRows, botRows] = await Promise.all([
    db
      .select()
      .from(journalEvents)
      .where(and(
        eq(journalEvents.actorType, 'agent'),
        eq(journalEvents.actorId, agentId),
        ...(opts?.from ? [gte(journalEvents.createdAt, opts.from)] : []),
        ...(opts?.to ? [lte(journalEvents.createdAt, opts.to)] : []),
      )),
    agentBotIds.length > 0
      ? db
          .select()
          .from(journalEvents)
          .where(and(
            eq(journalEvents.actorType, 'bot'),
            inArray(journalEvents.actorId, agentBotIds),
            ...(opts?.from ? [gte(journalEvents.createdAt, opts.from)] : []),
            ...(opts?.to ? [lte(journalEvents.createdAt, opts.to)] : []),
          ))
      : Promise.resolve([]),
  ]);

  return [...agentRows, ...botRows];
}

// ── Runtime session loaders ──────────────────────────────────────────────────

/**
 * Load runtime sessions for an agent.
 */
export async function loadAgentRuntimeSessions(
  db: Database,
  agentId: string,
  opts?: LoaderTimeFilter,
): Promise<typeof agentRuntimeSessions.$inferSelect[]> {
  return db
    .select()
    .from(agentRuntimeSessions)
    .where(and(
      eq(agentRuntimeSessions.agentId, agentId),
      ...(opts?.from ? [gte(agentRuntimeSessions.startedAt, opts.from)] : []),
      ...(opts?.to ? [lte(agentRuntimeSessions.startedAt, opts.to)] : []),
    ));
}

// ── Position loaders ─────────────────────────────────────────────────────────

export interface LoadPositionsOpts extends LoaderTimeFilter {
  /**
   * Snapshot timestamp: return positions that were open as of this point in time.
   * When omitted, returns ALL positions (open + closed). The caller should filter
   * by `closedAt IS NULL` for current positions.
   *
   * When `at` is provided, returns positions where openedAt <= at AND
   * (closedAt IS NULL OR closedAt > at). This gives a point-in-time snapshot.
   */
  at?: Date;
  /** Pre-resolved bot IDs to avoid redundant loadAgentBotIds queries. */
  botIds?: string[];
}

/**
 * Load positions attributable to an agent (agent-native + agent-owned bots).
 *
 * Scope-aware via `opts.at`:
 * - Omitted → returns all positions (open and closed).
 * - Provided → returns positions open at that instant (openedAt <= at, not yet closed).
 */
export async function loadAgentPositions(
  db: Database,
  agentId: string,
  opts?: LoadPositionsOpts,
): Promise<typeof positions.$inferSelect[]> {
  const agentBotIds = opts?.botIds ?? await loadAgentBotIds(db, agentId);

  const buildConditions = (actorType: 'agent' | 'bot', actorId: string | string[]) => {
    const base = actorType === 'agent'
      ? [eq(positions.actorType, 'agent'), eq(positions.actorId, actorId as string)]
      : [eq(positions.actorType, 'bot'), inArray(positions.actorId, actorId as string[])];
    if (opts?.at) {
      return [...base, lte(positions.openedAt, opts.at)];
    }
    return base;
  };

  const [agentRows, botRows] = await Promise.all([
    db
      .select()
      .from(positions)
      .where(and(...buildConditions('agent', agentId))),
    agentBotIds.length > 0
      ? db
          .select()
          .from(positions)
          .where(and(...buildConditions('bot', agentBotIds)))
      : Promise.resolve([]),
  ]);

  const allPositions = [...agentRows, ...botRows];

  // When `at` is provided, additionally filter out positions not yet opened or already closed by that time
  if (opts?.at) {
    return allPositions.filter(
      (p) => p.openedAt <= opts.at! && (p.closedAt === null || p.closedAt > opts.at!),
    );
  }

  return allPositions;
}
