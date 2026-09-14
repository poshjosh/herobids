import type { FastifyInstance } from 'fastify';
import type { Database } from '@herobids/db';
import type { TradertonClient, TradertonSubject } from '@herobids/domain/traderton';
import { ReconciliationEventQuerySchema } from '../schemas.js';
import { errorPayload } from '../error-payload.js';
import { createTradertonReadBoundary, loadBoundaryObject } from './exports-traderton.js';

/** Fallback read deadline when the operator boundary timeout is not supplied. */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

export async function reconciliationRoutes(
  app: FastifyInstance,
  _db: Database,
  tradertonReadClient?: TradertonClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  const readDeadlineMs = tradertonReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  // Query reconciliation events for a bot's venue account. Sourced over the
  // Traderton read boundary (c4.2): `reconciliation_events` is a Traderton
  // trading table (venue-account-scoped), so the bot→venueAccount resolution AND
  // the event read happen server-side via `get_owner_bot_reconciliation_events`.
  // The tool owner-verifies the bot (unowned/absent → not_found.resource → 404).
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/bots/:id/reconciliation-events',
    async (request, reply) => {
      const { id } = request.params;

      const parsed = ReconciliationEventQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      if (!tradertonReadClient) {
        return reply.status(503).send(errorPayload(
          'precondition.not_ready',
          'Trading service is unavailable — reconciliation events could not be read.',
        ));
      }
      const subject: TradertonSubject = { ownerId: request.userId, actor: { type: 'user', id: request.userId } };
      const boundary = createTradertonReadBoundary(tradertonReadClient, subject, readDeadlineMs);
      const loaded = await loadBoundaryObject(boundary, 'get_owner_bot_reconciliation_events', {
        botId: id,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        since: parsed.data.since,
      });
      if (!loaded.ok) {
        if (loaded.error.code === 'not_found.resource') {
          return reply.status(404).send({ error: 'not_found' });
        }
        return reply.status(loaded.error.status).send(errorPayload(loaded.error.code, loaded.error.message));
      }

      // The tool returns { ok, botId, venueAccountId, events } — surface the same
      // { botId, venueAccountId, events } shape the old endpoint returned.
      return reply.send({
        botId: id,
        venueAccountId: loaded.data['venueAccountId'] ?? null,
        events: loaded.data['events'] ?? [],
      });
    },
  );
}
