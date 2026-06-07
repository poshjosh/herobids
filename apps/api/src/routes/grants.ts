import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, connections, capabilityGrants } from '@herobids/db';
import { CreateGrantSchema, RevokeGrantSchema } from '../schemas.js';
import {
  createGrant,
  revokeGrant,
  getGrantAudit,
  assertConnectionOwnership,
  assertGrantOwnership,
} from '../grant-service.js';

export async function grantRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // POST /agents/:agentId/grants — create a capability grant for an agent
  app.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/grants',
    async (request, reply) => {
      const { agentId } = request.params;
      const parsed = CreateGrantSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      // Verify agent belongs to the authenticated user
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      // Verify connection belongs to the authenticated user
      const conn = await assertConnectionOwnership(db, parsed.data.connectionId, request.userId);
      if (!conn) {
        return reply.status(400).send({
          error: 'connection.not_found',
          message: `Connection ${parsed.data.connectionId} does not exist`,
        });
      }
      if (conn.status === 'revoked') {
        return reply.status(409).send({ error: 'connection.revoked' });
      }

      let grantId: string;
      try {
        grantId = await createGrant(db, {
          agentId,
          connectionId: parsed.data.connectionId,
          capabilityFamily: parsed.data.capabilityFamily,
          grantedBy: request.userId,
        });
      } catch (err: unknown) {
        // Unique constraint violation — duplicate active grant.
        // Check the structured PG error code rather than the message string so
        // this can't regress silently under driver or message-format changes.
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          return reply.status(409).send({ error: 'grant.duplicate' });
        }
        throw err;
      }

      const [grant] = await db
        .select()
        .from(capabilityGrants)
        .where(eq(capabilityGrants.id, grantId));

      return reply.status(201).send(grant);
    },
  );

  // GET /agents/:agentId/grants — list grants for an agent
  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/grants',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await db
        .select({
          grant: capabilityGrants,
          connection: {
            id: connections.id,
            provider: connections.provider,
            label: connections.label,
            status: connections.status,
          },
        })
        .from(capabilityGrants)
        .innerJoin(connections, eq(capabilityGrants.connectionId, connections.id))
        .where(eq(capabilityGrants.agentId, agentId));

      return reply.send({
        grants: rows.map((r) => ({ ...r.grant, connection: r.connection })),
      });
    },
  );

  // GET /agents/:agentId/grants/:grantId — inspect a single grant
  app.get<{ Params: { agentId: string; grantId: string } }>(
    '/agents/:agentId/grants/:grantId',
    async (request, reply) => {
      const { agentId, grantId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const grantWithConn = await assertGrantOwnership(db, grantId, request.userId);
      if (!grantWithConn || grantWithConn.agentId !== agentId) {
        return reply.status(404).send({ error: 'grant.not_found' });
      }

      return reply.send(grantWithConn);
    },
  );

  // DELETE /agents/:agentId/grants/:grantId — revoke a grant
  app.delete<{ Params: { agentId: string; grantId: string } }>(
    '/agents/:agentId/grants/:grantId',
    async (request, reply) => {
      const { agentId, grantId } = request.params;
      const parsed = RevokeGrantSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const grantWithConn = await assertGrantOwnership(db, grantId, request.userId);
      if (!grantWithConn || grantWithConn.agentId !== agentId) {
        return reply.status(404).send({ error: 'grant.not_found' });
      }

      const revoked = await revokeGrant(db, {
        grantId,
        actorType: 'user',
        actorId: request.userId,
        reason: parsed.data.reason,
      });

      if (!revoked) {
        return reply.status(409).send({ error: 'grant.already_revoked' });
      }

      return reply.status(204).send();
    },
  );

  // GET /agents/:agentId/grants/:grantId/audit — full audit trail for a grant
  app.get<{ Params: { agentId: string; grantId: string } }>(
    '/agents/:agentId/grants/:grantId/audit',
    async (request, reply) => {
      const { agentId, grantId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const grantWithConn = await assertGrantOwnership(db, grantId, request.userId);
      if (!grantWithConn || grantWithConn.agentId !== agentId) {
        return reply.status(404).send({ error: 'grant.not_found' });
      }

      const auditEntries = await getGrantAudit(db, grantId);
      return reply.send({ audit: auditEntries });
    },
  );
}
