import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents } from '@herobids/db';
import type { TradertonClient, TradertonSubject } from '@herobids/domain/traderton';
import { JournalQuerySchema } from '../schemas.js';
import { errorPayload } from '../error-payload.js';
import {
  createTradertonReadBoundary,
  loadAgentEvidence,
  toJournalRow,
  toPositionRow,
  type JournalRow as ReadJournalRow,
  type PositionRow as ReadPositionRow,
} from './exports-traderton.js';

/** Fallback read deadline when the operator boundary timeout is not supplied. */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

const boundaryUnconfiguredError = {
  status: 503,
  code: 'precondition.not_ready',
  message: 'Trading service is unavailable — the read could not be produced.',
} as const;

export async function journalRoutes(
  app: FastifyInstance,
  db: Database,
  tradertonReadClient?: TradertonClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  const readDeadlineMs = tradertonReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  // Query journal events for a specific bot or agent. Sourced over the Traderton
  // read boundary (c4.2):
  //   - bot   → `get_owner_bot_journal` owner-scopes by the subject owner, so the
  //             `actorId` (a bot id) is verified as OWNED server-side.
  //   - agent → `get_agent_journal_events` resolves the agent actor + its owned
  //             bots server-side (agent-native journal always has actorType
  //             'agent'; a bot-scoped read would return nothing for them).
  // The agent vs bot disambiguation uses the platform `agents` table (still
  // local): if `actorId` is an OWNED agent, take the agent branch; else the bot
  // branch. An unowned/absent bot returns not_found.resource → 404, preserving
  // the endpoint's "ownership-scoped filter to prevent cross-user leaks" contract.
  app.get('/journal', async (request, reply) => {
    const parsed = JournalQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Require an ownership-scoped filter to prevent cross-user data leaks
    if (!parsed.data.actorId) {
      return reply.status(400).send({ error: 'validation_error', message: 'actorId filter is required' });
    }

    if (!tradertonReadClient) {
      return reply.status(boundaryUnconfiguredError.status).send(
        errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
      );
    }

    // Disambiguate agent vs bot: `actorId` that resolves to an OWNED agent takes
    // the agent-scoped branch (the agent may or may not own bots; its own
    // journal events are actorType='agent' and only served by the agent tool).
    const [ownedAgent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, parsed.data.actorId))
      .limit(1);

    let loaded: Awaited<ReturnType<typeof loadAgentEvidence<ReadJournalRow>>>;
    if (ownedAgent) {
      const agentSubject: TradertonSubject = { ownerId: request.userId, actor: { type: 'agent', id: parsed.data.actorId } };
      const boundary = createTradertonReadBoundary(tradertonReadClient, agentSubject, readDeadlineMs);
      // get_agent_journal_events returns ALL agent events (native + owned bots)
      // with only from/to time filters — `type` is not server-filterable here,
      // so apply it in-app (matching the old local soft-filter semantics).
      loaded = await loadAgentEvidence<ReadJournalRow>(
        boundary,
        'get_agent_journal_events',
        {},
        'events',
        toJournalRow,
      );
      if (loaded.ok && parsed.data.type) {
        loaded = { ok: true, rows: loaded.rows.filter((r) => r.type === parsed.data.type) };
      }
    } else {
      const subject: TradertonSubject = { ownerId: request.userId, actor: { type: 'user', id: request.userId } };
      const boundary = createTradertonReadBoundary(tradertonReadClient, subject, readDeadlineMs);
      loaded = await loadAgentEvidence<ReadJournalRow>(
        boundary,
        'get_owner_bot_journal',
        // Drop an empty `type` — herobids' schema allows type:'' (ignored by the
        // old local query) but the tool's schema is `.min(1)`, so `?type=` would
        // otherwise 502. `|| undefined` reproduces the old "ignore empty type".
        { botId: parsed.data.actorId, type: parsed.data.type || undefined, limit: parsed.data.limit, offset: parsed.data.offset },
        'events',
        toJournalRow,
      );
    }

    if (!loaded.ok) {
      if (loaded.error.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(loaded.error.status).send(errorPayload(loaded.error.code, loaded.error.message));
    }

    return reply.send({ events: loaded.rows });
  });
}

export async function positionRoutes(
  app: FastifyInstance,
  _db: Database,
  tradertonReadClient?: TradertonClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  const readDeadlineMs = tradertonReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  /**
   * Load a bot's positions over the boundary. `get_owner_bot_positions` returns
   * ALL positions (open + closed) for an OWNED bot; an unowned/absent bot returns
   * not_found.resource → 404 (the old local `bots where id,userId` ownership
   * check now lives in the tool). The `/open` variant filters closedAt in-app.
   */
  const loadBotPositions = async (
    reply: FastifyReply,
    userId: string,
    botId: string,
  ): Promise<ReadPositionRow[] | null> => {
    if (!tradertonReadClient) {
      void reply.status(boundaryUnconfiguredError.status).send(
        errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
      );
      return null;
    }
    const subject: TradertonSubject = { ownerId: userId, actor: { type: 'user', id: userId } };
    const boundary = createTradertonReadBoundary(tradertonReadClient, subject, readDeadlineMs);
    const loaded = await loadAgentEvidence<ReadPositionRow>(
      boundary,
      'get_owner_bot_positions',
      { botId },
      'positions',
      toPositionRow,
    );
    if (!loaded.ok) {
      if (loaded.error.code === 'not_found.resource') {
        void reply.status(404).send({ error: 'not_found' });
      } else {
        void reply.status(loaded.error.status).send(errorPayload(loaded.error.code, loaded.error.message));
      }
      return null;
    }
    return loaded.rows;
  };

  // List positions for a bot (all — open + closed)
  app.get<{ Params: { botId: string } }>('/bots/:botId/positions', async (request, reply) => {
    const { botId } = request.params;
    const positions = await loadBotPositions(reply, request.userId, botId);
    if (positions === null) return reply;
    return reply.send({ botId, positions });
  });

  // Open positions only — filter closedAt in-app (the tool returns all positions).
  app.get<{ Params: { botId: string } }>('/bots/:botId/positions/open', async (request, reply) => {
    const { botId } = request.params;
    const positions = await loadBotPositions(reply, request.userId, botId);
    if (positions === null) return reply;
    const open = positions.filter((p) => p.closedAt === null);
    return reply.send({ botId, positions: open });
  });
}
