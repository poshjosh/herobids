import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentConnections, agentConnectionAudit, connections, agents } from '@herobids/db';
import { ok, err, type Result } from '@herobids/domain';

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
): Promise<Result<{ granted: boolean }, AgentConfigError>> {
  try {
    const result = await db.transaction(async (tx) => {
      // Verify agent exists
      const [agent] = await tx
        .select({ id: agents.id, userId: agents.userId, status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId));

      if (!agent) {
        return { kind: 'agent_not_found' as const };
      }

      // Verify agent ownership
      if (agent.userId !== userId) {
        return { kind: 'agent_not_owned' as const };
      }

      // Agent must be stopped before modifying connections
      if (agent.status !== 'stopped') {
        return { kind: 'agent_not_stopped' as const, currentStatus: agent.status };
      }

      // Verify connection ownership and activeness
      const [conn] = await tx
        .select({ id: connections.id, userId: connections.userId, status: connections.status })
        .from(connections)
        .where(eq(connections.id, connectionId));

      if (!conn) {
        return { kind: 'connection_not_found' as const };
      }

      if (conn.userId !== userId) {
        return { kind: 'connection_not_owned' as const };
      }

      if (conn.status !== 'active') {
        return { kind: 'connection_not_active' as const, connStatus: conn.status };
      }

      // Check if already granted and active
      const [existing] = await tx
        .select({ id: agentConnections.id })
        .from(agentConnections)
        .where(
          and(
            eq(agentConnections.agentId, agentId),
            eq(agentConnections.connectionId, connectionId),
            eq(agentConnections.status, 'active'),
          ),
        );

      if (existing) {
        return { kind: 'already_granted' as const }; // Idempotent
      }

      const now = new Date();
      const acId = crypto.randomUUID();

      await tx.insert(agentConnections).values({
        id: acId,
        agentId,
        connectionId,
        status: 'active',
        grantedBy: userId,
        grantedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(agentConnectionAudit).values({
        id: crypto.randomUUID(),
        agentConnectionId: acId,
        action: 'granted',
        actorType: 'user',
        actorId: userId,
        createdAt: now,
      });

      return { kind: 'granted' as const };
    });

    if (result.kind === 'agent_not_found') {
      return err({ code: 'agent.not_found', message: 'Agent not found' });
    }
    if (result.kind === 'agent_not_owned') {
      return err({ code: 'agent.not_owned', message: 'You do not own this agent' });
    }
    if (result.kind === 'agent_not_stopped') {
      return err({
        code: 'agent.not_stopped',
        message: 'Agent must be stopped before modifying connections',
        currentStatus: result.currentStatus,
      });
    }
    if (result.kind === 'connection_not_found') {
      return err({ code: 'connection.not_found', message: `Connection ${connectionId} does not exist` });
    }
    if (result.kind === 'connection_not_owned') {
      return err({ code: 'connection.not_owned', message: `Connection ${connectionId} does not belong to you` });
    }
    if (result.kind === 'connection_not_active') {
      return err({
        code: 'connection.not_active',
        message: `Connection ${connectionId} is not active (status: ${result.connStatus})`,
      });
    }

    return ok({ granted: result.kind === 'granted' || result.kind === 'already_granted' });
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
): Promise<Result<{ revoked: boolean }, AgentConfigError>> {
  try {
    const result = await db.transaction(async (tx) => {
      // Verify agent exists
      const [agent] = await tx
        .select({ id: agents.id, userId: agents.userId, status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId));

      if (!agent) {
        return { kind: 'agent_not_found' as const };
      }

      // Verify agent ownership
      if (agent.userId !== userId) {
        return { kind: 'agent_not_owned' as const };
      }

      // Agent must be stopped before modifying connections
      if (agent.status !== 'stopped') {
        return { kind: 'agent_not_stopped' as const, currentStatus: agent.status };
      }

      // Verify connection ownership
      const [conn] = await tx
        .select({ id: connections.id, userId: connections.userId })
        .from(connections)
        .where(eq(connections.id, connectionId));

      if (!conn) {
        return { kind: 'connection_not_found' as const };
      }

      if (conn.userId !== userId) {
        return { kind: 'connection_not_owned' as const };
      }

      // Find the active agent_connections row
      const [activeRow] = await tx
        .select({ id: agentConnections.id })
        .from(agentConnections)
        .where(
          and(
            eq(agentConnections.agentId, agentId),
            eq(agentConnections.connectionId, connectionId),
            eq(agentConnections.status, 'active'),
          ),
        );

      if (!activeRow) {
        return { kind: 'already_revoked' as const }; // Idempotent
      }

      const now = new Date();

      await tx
        .update(agentConnections)
        .set({
          status: 'revoked',
          revokedAt: now,
          updatedAt: now,
        })
        .where(eq(agentConnections.id, activeRow.id));

      await tx.insert(agentConnectionAudit).values({
        id: crypto.randomUUID(),
        agentConnectionId: activeRow.id,
        action: 'revoked',
        actorType: 'user',
        actorId: userId,
        createdAt: now,
      });

      return { kind: 'revoked' as const };
    });

    if (result.kind === 'agent_not_found') {
      return err({ code: 'agent.not_found', message: 'Agent not found' });
    }
    if (result.kind === 'agent_not_owned') {
      return err({ code: 'agent.not_owned', message: 'You do not own this agent' });
    }
    if (result.kind === 'agent_not_stopped') {
      return err({
        code: 'agent.not_stopped',
        message: 'Agent must be stopped before modifying connections',
        currentStatus: result.currentStatus,
      });
    }
    if (result.kind === 'connection_not_found') {
      return err({ code: 'connection.not_found', message: `Connection ${connectionId} does not exist` });
    }
    if (result.kind === 'connection_not_owned') {
      return err({ code: 'connection.not_owned', message: `Connection ${connectionId} does not belong to you` });
    }

    return ok({ revoked: result.kind === 'revoked' || result.kind === 'already_revoked' });
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

// ── Set execution mode ────────────────────────────────────────────────────

// TODO(Slice 5): Add paper/shadow alias handling.
export async function setExecutionMode(
  db: Database,
  agentId: string,
  userId: string,
  mode: 'test' | 'live',
): Promise<Result<{ mode: string }, AgentConfigError>> {
  try {
    const [agent] = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));

    if (!agent) {
      return err({ code: 'agent.not_found', message: 'Agent not found' });
    }

    // Agent must be stopped before modifying execution mode
    if (agent.status !== 'stopped') {
      return err({
        code: 'agent.not_stopped' as const,
        message: 'Agent must be stopped before modifying execution mode',
        currentStatus: agent.status,
      });
    }

    // Map 'test' and 'live' to internal execution modes
    // 'test' → 'paper' (simulated), 'live' → 'live'
    const internalMode = mode === 'test' ? 'paper' : 'live';

    await db
      .update(agents)
      .set({
        executionMode: internalMode,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    return ok({ mode: internalMode });
  } catch (cause) {
    return err({
      code: 'config.internal_error',
      message: cause instanceof Error ? cause.message : 'Unexpected error setting execution mode',
    });
  }
}
