import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '@herobids/db';
import { agentConnections, agentConnectionAudit, connections, agents } from '@herobids/db';
import { ok, err, type Result } from '@herobids/domain';
import {
  loadActiveTradingProfileConnections,
} from '../agents/trading-profile-reconciliation-adapter.js';
import type {
  TradingProfileConnection,
} from '../agents/trading-profile-reconciliation.js';
import { proposeTradingProfiles } from '../agents/trading-profile-reconciliation.js';
import type { TradingProfileReconciliationSaga } from '../agents/trading-profile-reconciliation-saga.js';

/**
 * Agent config service — single-operation connection lifecycle management.
 *
 * Used by Telegram slash commands (/connect, /disconnect) and other
 * single-operation contexts. Each function validates ownership and agent
 * state independently before mutating.
 *
 * NOTE: The HTTP PATCH /agents/:id route handles connectionIds as a batch
 * declarative sync (diff/add/revoke) inside its own transaction. That
 * implementation is intentionally separate from grantConnection/revokeConnection
 * because the PATCH route must validate and sync the full connection set
 * atomically within the same transaction that updates all other agent fields.
 */

// ── Error types ───────────────────────────────────────────────────────────

export type AgentConfigError =
  | { code: 'agent.not_found'; message: string }
  | { code: 'agent.not_owned'; message: string }
  | { code: 'connection.not_found'; message: string }
  | { code: 'connection.not_owned'; message: string }
  | { code: 'connection.not_active'; message: string }
  | { code: 'agent.not_stopped'; message: string; currentStatus: string }
  | { code: 'config.internal_error'; message: string };

type PreparedConnectionChange = {
  kind: 'ready';
  actorId: string;
  connection: { id: string; userId: string; status: string; venueAccountId: string | null };
  priorConnections: TradingProfileConnection[];
  existing: boolean;
  activeGrant: { id: string } | undefined;
} | {
  kind: 'agent_not_found' | 'agent_not_owned' | 'connection_not_found' | 'connection_not_owned';
} | {
  kind: 'agent_not_stopped';
  currentStatus: string;
} | {
  kind: 'connection_not_active';
  connStatus: string;
};

async function prepareConnectionChange(
  db: Database,
  agentId: string,
  connectionId: string,
  userId: string,
  operation: 'grant' | 'revoke',
): Promise<PreparedConnectionChange> {
  const [agent] = await db.select({
    id: agents.id,
    userId: agents.userId,
    status: agents.status,
  }).from(agents).where(eq(agents.id, agentId));
  if (!agent) return { kind: 'agent_not_found' };
  if (agent.userId !== userId) return { kind: 'agent_not_owned' };
  if (agent.status !== 'stopped') return { kind: 'agent_not_stopped', currentStatus: agent.status };

  const [connection] = await db.select({
    id: connections.id,
    userId: connections.userId,
    status: connections.status,
    venueAccountId: connections.resolvedVenueAccountId,
  }).from(connections).where(eq(connections.id, connectionId));
  if (!connection) return { kind: 'connection_not_found' };
  if (connection.userId !== userId) return { kind: 'connection_not_owned' };
  if (operation === 'grant' && connection.status !== 'active') {
    return { kind: 'connection_not_active', connStatus: connection.status };
  }

  const [activeGrant] = await db.select({ id: agentConnections.id }).from(agentConnections).where(and(
    eq(agentConnections.agentId, agentId),
    eq(agentConnections.connectionId, connectionId),
    eq(agentConnections.status, 'active'),
  ));
  return {
    kind: 'ready',
    actorId: agent.id,
    connection,
    priorConnections: await loadActiveTradingProfileConnections(db, agentId),
    existing: activeGrant !== undefined,
    activeGrant,
  };
}

async function revalidateConnectionChange(
  tx: DatabaseTransaction,
  prepared: Extract<PreparedConnectionChange, { kind: 'ready' }>,
  operation: 'grant' | 'revoke',
): Promise<void> {
  const [agent] = await tx.select({ userId: agents.userId, status: agents.status }).from(agents)
    .where(eq(agents.id, prepared.actorId));
  if (!agent || agent.userId !== prepared.connection.userId || agent.status !== 'stopped') {
    throw new Error('agent changed before connection mutation could be committed');
  }
  const [connection] = await tx.select({ userId: connections.userId, status: connections.status }).from(connections)
    .where(eq(connections.id, prepared.connection.id));
  if (!connection || connection.userId !== prepared.connection.userId || (operation === 'grant' && connection.status !== 'active')) {
    throw new Error('connection changed before mutation could be committed');
  }
  const [activeGrant] = await tx.select({ id: agentConnections.id }).from(agentConnections).where(and(
    eq(agentConnections.agentId, prepared.actorId),
    eq(agentConnections.connectionId, prepared.connection.id),
    eq(agentConnections.status, 'active'),
  ));
  if ((operation === 'grant' && activeGrant) || (operation === 'revoke' && activeGrant?.id !== prepared.activeGrant?.id)) {
    throw new Error('agent connection changed before mutation could be committed');
  }
  const currentConnections = await loadActiveTradingProfileConnections(tx, prepared.actorId);
  if (JSON.stringify(currentConnections) !== JSON.stringify(prepared.priorConnections)) {
    throw new Error('agent connections changed before mutation could be committed');
  }
}

function grantError(prepared: Exclude<PreparedConnectionChange, { kind: 'ready' }>, connectionId: string): Result<{ granted: boolean }, AgentConfigError> {
  switch (prepared.kind) {
    case 'agent_not_found': return err({ code: 'agent.not_found', message: 'Agent not found' });
    case 'agent_not_owned': return err({ code: 'agent.not_owned', message: 'You do not own this agent' });
    case 'agent_not_stopped': return err({ code: 'agent.not_stopped', message: 'Agent must be stopped before modifying connections', currentStatus: prepared.currentStatus });
    case 'connection_not_found': return err({ code: 'connection.not_found', message: `Connection ${connectionId} does not exist` });
    case 'connection_not_owned': return err({ code: 'connection.not_owned', message: `Connection ${connectionId} does not belong to you` });
    case 'connection_not_active': return err({ code: 'connection.not_active', message: `Connection ${connectionId} is not active (status: ${prepared.connStatus})` });
  }
}

function revokeError(prepared: Exclude<PreparedConnectionChange, { kind: 'ready' }>, connectionId: string): Result<{ revoked: boolean }, AgentConfigError> {
  if (prepared.kind === 'connection_not_active') return err({ code: 'config.internal_error', message: 'Unexpected inactive connection preflight' });
  return grantError(prepared, connectionId) as Result<{ revoked: boolean }, AgentConfigError>;
}

// ── Grant connection ──────────────────────────────────────────────────────

/**
 * Grant a connection to an agent (insert agent_connections row).
 * Idempotent: if already granted and active, returns success without changes.
 * Agent must be in stopped status.
 */
export async function grantConnection(
  db: Database,
  agentId: string,
  connectionId: string,
  userId: string,
  profileReconciliationSaga: TradingProfileReconciliationSaga,
): Promise<Result<{ granted: boolean }, AgentConfigError>> {
  try {
    const prepared = await prepareConnectionChange(db, agentId, connectionId, userId, 'grant');
    if (prepared.kind !== 'ready') return grantError(prepared, connectionId);
    if (prepared.existing) return ok({ granted: true });

    const assignmentId = crypto.randomUUID();
    const grantedAt = new Date();
    await profileReconciliationSaga.executeStaged({
      ownerId: userId,
      actorId: agentId,
      localMutationId: crypto.randomUUID(),
      preparePlannerInput: async () => {
        const profiles = await profileReconciliationSaga.readCurrentProfiles(userId, agentId, prepared.priorConnections);
        const proposedConnections = [
            ...prepared.priorConnections.map((connection) => ({ ...connection, isDefault: false })),
            { connectionId, venueAccountId: prepared.connection.venueAccountId, active: true, ready: true, isDefault: true },
        ];
        return {
          prior: { profiles, connections: prepared.priorConnections },
          proposed: { profiles: proposeTradingProfiles({ actorId: agentId, priorProfiles: profiles, priorConnections: prepared.priorConnections, proposedConnections, changes: {} }), connections: proposedConnections },
        };
      },
      commitLocal: async (tx, markLocalCommitted) => {
        await revalidateConnectionChange(tx, prepared, 'grant');
        await tx.insert(agentConnections).values({
          id: assignmentId, agentId, connectionId, status: 'active', grantedBy: userId,
          grantedAt, createdAt: grantedAt, updatedAt: grantedAt,
        });
        await tx.insert(agentConnectionAudit).values({
          id: crypto.randomUUID(), agentConnectionId: assignmentId, action: 'granted',
          actorType: 'user', actorId: userId, createdAt: grantedAt,
        });
        await markLocalCommitted();
        return { kind: 'granted' as const };
      },
    });

    return ok({ granted: true });
  } catch (cause) {
    return err({
      code: 'config.internal_error',
      message: cause instanceof Error ? cause.message : 'Unexpected error granting connection',
    });
  }
}

// ── Revoke connection ─────────────────────────────────────────────────────

/**
 * Revoke a connection from an agent.
 * Idempotent: if already revoked or never granted, returns success.
 * Agent must be in stopped status.
 */
export async function revokeConnection(
  db: Database,
  agentId: string,
  connectionId: string,
  userId: string,
  profileReconciliationSaga: TradingProfileReconciliationSaga,
): Promise<Result<{ revoked: boolean }, AgentConfigError>> {
  try {
    const prepared = await prepareConnectionChange(db, agentId, connectionId, userId, 'revoke');
    if (prepared.kind !== 'ready') return revokeError(prepared, connectionId);
    const activeGrant = prepared.activeGrant;
    if (!activeGrant) return ok({ revoked: true });

    const revokedAt = new Date();
    await profileReconciliationSaga.executeStaged({
      ownerId: userId,
      actorId: agentId,
      localMutationId: crypto.randomUUID(),
      preparePlannerInput: async () => {
        const profiles = await profileReconciliationSaga.readCurrentProfiles(userId, agentId, prepared.priorConnections);
        const proposedConnections = prepared.priorConnections.filter((connection) => connection.connectionId !== connectionId);
        return {
          prior: { profiles, connections: prepared.priorConnections },
          proposed: { profiles: proposeTradingProfiles({ actorId: agentId, priorProfiles: profiles, priorConnections: prepared.priorConnections, proposedConnections, changes: {} }), connections: proposedConnections },
        };
      },
      commitLocal: async (tx, markLocalCommitted) => {
        await revalidateConnectionChange(tx, prepared, 'revoke');
        await tx.update(agentConnections).set({ status: 'revoked', revokedAt, updatedAt: revokedAt })
          .where(eq(agentConnections.id, activeGrant.id));
        await tx.insert(agentConnectionAudit).values({
          id: crypto.randomUUID(), agentConnectionId: activeGrant.id, action: 'revoked',
          actorType: 'user', actorId: userId, createdAt: revokedAt,
        });
        await markLocalCommitted();
        return { kind: 'revoked' as const };
      },
    });

    return ok({ revoked: true });
  } catch (cause) {
    return err({
      code: 'config.internal_error',
      message: cause instanceof Error ? cause.message : 'Unexpected error revoking connection',
    });
  }
}

// ── List agent connections ────────────────────────────────────────────────

export async function listAgentConnections(
  db: Database,
  agentId: string,
  userId: string,
): Promise<Result<Array<{ connectionId: string; label: string; provider: string }>, AgentConfigError>> {
  try {
    // Verify agent ownership
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));

    if (!agent) {
      return err({ code: 'agent.not_found', message: 'Agent not found' });
    }

    const rows = await db
      .select({
        connectionId: connections.id,
        label: connections.label,
        provider: connections.provider,
      })
      .from(agentConnections)
      .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
      .where(
        and(
          eq(agentConnections.agentId, agentId),
          eq(agentConnections.status, 'active'),
          eq(connections.userId, userId),
        ),
      );

    return ok(
      rows.map((r) => ({
        connectionId: r.connectionId,
        label: r.label,
        provider: r.provider,
      })),
    );
  } catch (cause) {
    return err({
      code: 'config.internal_error',
      message: cause instanceof Error ? cause.message : 'Unexpected error listing agent connections',
    });
  }
}


