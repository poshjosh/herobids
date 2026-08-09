import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  connections,
  venueAccounts,
  userCredentials,
  agentConnections,
  bots,
  agents,
} from '@herobids/db';

/**
 * Linked resources resolved for a guided trading connection
 * (connection where `resolvedVenueAccountId` is non-null).
 */
export interface ProviderLinkResources {
  connectionId: string;
  credentialId: string | null;
  venueAccountId: string | null;
  /** Active agent_connections rows referencing this connection. */
  activeAgentConnectionIds: string[];
  /** Bots whose connectionId references this connection. */
  connectionBotIds: string[];
  /** Bots whose venueAccountId references the linked venue account. */
  venueAccountBotIds: string[];
}

/**
 * Outcome of a cascade delete attempt for a guided provider link.
 */
export type DeleteProviderLinkResult =
  | {
      kind: 'ok';
      connectionId: string;
      deleted: {
        connection: boolean;
        venueAccount: boolean;
        credential: boolean;
      };
    }
  | {
      kind: 'blocked';
      connectionId: string;
      blockingAgentIds: string[];
      blockingConnectionBotIds: string[];
      blockingVenueAccountBotIds: string[];
    }
  | { kind: 'not_found' }
  | { kind: 'not_eligible'; connectionId: string }
  | { kind: 'fault'; code: string; message: string };

/**
 * Resolves the linked resources and blockers for a guided trading connection.
 *
 * Returns `null` if the connection does not exist or belongs to a different user.
 */
export async function resolveProviderLinkDependents(
  db: Database,
  connectionId: string,
  userId: string,
): Promise<ProviderLinkResources | null> {
  const [conn] = await db
    .select({
      id: connections.id,
      credentialId: connections.credentialId,
      resolvedVenueAccountId: connections.resolvedVenueAccountId,
    })
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.userId, userId)));

  if (!conn) return null;

  // Resolve active agent grants on this connection.
  const activeGrants = await db
    .select({ id: agentConnections.id })
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.connectionId, connectionId),
        eq(agentConnections.status, 'active'),
      ),
    );

  // Resolve bots referencing this connection directly.
  const connBots = await db
    .select({ id: bots.id })
    .from(bots)
    .where(eq(bots.connectionId, connectionId));

  // Resolve bots referencing the linked venue account (if any).
  let venueAccountBotIds: string[] = [];
  if (conn.resolvedVenueAccountId) {
    const vaBots = await db
      .select({ id: bots.id })
      .from(bots)
      .where(eq(bots.venueAccountId, conn.resolvedVenueAccountId));
    venueAccountBotIds = vaBots.map((b) => b.id);
  }

  return {
    connectionId: conn.id,
    credentialId: conn.credentialId,
    venueAccountId: conn.resolvedVenueAccountId,
    activeAgentConnectionIds: activeGrants.map((g) => g.id),
    connectionBotIds: connBots.map((b) => b.id),
    venueAccountBotIds,
  };
}

/**
 * Deletes a guided provider link (connection, linked venue account, and linked
 * credential) in a single transaction.
 *
 * Eligibility: the connection must have `resolvedVenueAccountId !== null`.
 *
 * Blocking rules:
 * - Active agent_connections on the connection.
 * - Bots referencing the connection.
 * - Bots referencing the linked venue account.
 */
export async function deleteProviderLink(
  db: Database,
  connectionId: string,
  userId: string,
): Promise<DeleteProviderLinkResult> {
  // 1. Load the connection and check eligibility.
  const resources = await resolveProviderLinkDependents(db, connectionId, userId);
  if (!resources) return { kind: 'not_found' };

  if (resources.venueAccountId === null) {
    return { kind: 'not_eligible', connectionId };
  }

  // Collect blocker IDs.
  const blockingAgentIds = await resolveBlockingAgentLabels(
    db,
    connectionId,
  );

  const blockingConnectionBotIds = resources.connectionBotIds;
  const blockingVenueAccountBotIds = resources.venueAccountBotIds;

  // 2-4. Block if anything is in use.
  if (
    blockingAgentIds.length > 0 ||
    blockingConnectionBotIds.length > 0 ||
    blockingVenueAccountBotIds.length > 0
  ) {
    return {
      kind: 'blocked',
      connectionId,
      blockingAgentIds,
      blockingConnectionBotIds,
      blockingVenueAccountBotIds,
    };
  }

  const venueAccountId = resources.venueAccountId;
  const credentialId = resources.credentialId;

  try {
    await db.transaction(async (tx) => {
      // 5. Clean up revoked agent_connections rows.
      await tx
        .delete(agentConnections)
        .where(
          and(
            eq(agentConnections.connectionId, connectionId),
            eq(agentConnections.status, 'revoked'),
          ),
        );

      // 6. Delete the connection.
      // connections.credentialId FK → SET NULL (so safe before credential delete).
      // connections.resolvedVenueAccountId FK → SET NULL (so safe before venue account delete).
      await tx.delete(connections).where(eq(connections.id, connectionId));

      // 7. Delete the linked venue account.
      // venue_accounts.credentialId FK → RESTRICT, so this must happen before
      // credential deletion. Since the connection is already gone (SET NULL on
      // resolvedVenueAccountId), we can safely delete the venue account.
      await tx.delete(venueAccounts).where(eq(venueAccounts.id, venueAccountId));

      // 8. Delete the linked credential (if any).
      if (credentialId) {
        await tx.delete(userCredentials).where(eq(userCredentials.id, credentialId));
      }
    });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === '23503') {
      // FK violation — a concurrent grant or bot appeared between check and delete.
      const freshResources = await resolveProviderLinkDependents(
        db,
        connectionId,
        userId,
      );
      if (!freshResources || freshResources.venueAccountId === null) {
        return { kind: 'not_found' };
      }

      const freshBlockingAgents = await resolveBlockingAgentLabels(
        db,
        connectionId,
      );

      if (
        freshBlockingAgents.length > 0 ||
        freshResources.connectionBotIds.length > 0 ||
        freshResources.venueAccountBotIds.length > 0
      ) {
        return {
          kind: 'blocked',
          connectionId,
          blockingAgentIds: freshBlockingAgents,
          blockingConnectionBotIds: freshResources.connectionBotIds,
          blockingVenueAccountBotIds: freshResources.venueAccountBotIds,
        };
      }

      // If the re-check shows no blockers, the FK may have been a transient race.
      // Treat as a fault so the caller can retry.
      return {
        kind: 'fault',
        code: 'provider_link.delete_race',
        message: 'Deletion failed due to a concurrent change. Please try again.',
      };
    }
    throw err;
  }

  return {
    kind: 'ok',
    connectionId,
    deleted: {
      connection: true,
      venueAccount: true,
      credential: credentialId !== null,
    },
  };
}

/**
 * Resolves blocking agent labels for UI display.
 */
async function resolveBlockingAgentLabels(
  db: Database,
  connectionId: string,
): Promise<string[]> {
  const activeGrants = await db
    .select({ agentId: agentConnections.agentId })
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.connectionId, connectionId),
        eq(agentConnections.status, 'active'),
      ),
    );

  if (activeGrants.length === 0) return [];

  const agentIds = [...new Set(activeGrants.map((g) => g.agentId))];
  const agentRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(inArray(agents.id, agentIds));

  return agentRows.map((a) => a.id);
}
