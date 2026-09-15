import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  connections,
  agentConnections,
  agents,
} from '@herobids/db';
import type { TradertonClient } from '@herobids/domain/traderton';
import { createLogger } from './logger.js';

const logger = createLogger('provider-links');

/**
 * Extract a tool-level errorCode from a boundary failure. The dispatcher maps a
 * copied tool's `errorCode` (e.g. `provision.in_use`, `not_found.resource`)
 * onto the closed wire `code` (usually `validation.invalid_payload`) and carries
 * the original under `details.errorCode`. Branch on this to preserve the tool's
 * semantics (fail-closed on dependents, idempotent on already-gone).
 */
function toolErrorCode(details: Record<string, unknown> | undefined): string | undefined {
  const code = details?.['errorCode'];
  return typeof code === 'string' ? code : undefined;
}

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
  /**
   * Bots whose connectionId references this connection. ALWAYS `[]` (c4.9f):
   * the authoritative bot guard is the boundary `deprovision_venue_account`
   * call in {@link deleteProviderLink} (Traderton owns the bots). Kept as a
   * field for wire/type compat with the `blocked` result shape.
   */
  connectionBotIds: string[];
  /**
   * Bots whose venueAccountId references the linked venue account. ALWAYS `[]`
   * (c4.9f) — see {@link connectionBotIds}.
   */
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

  // Bots are NOT read locally (c4.9f): the authoritative bot guard is the
  // boundary `deprovision_venue_account` call in deleteProviderLink, which
  // fail-closes on `provision.in_use` (Traderton owns the bots). The bot-id
  // fields survive as always-`[]` for wire/type compat with the blocked shape.
  return {
    connectionId: conn.id,
    credentialId: conn.credentialId,
    venueAccountId: conn.resolvedVenueAccountId,
    activeAgentConnectionIds: activeGrants.map((g) => g.id),
    connectionBotIds: [],
    venueAccountBotIds: [],
  };
}

/**
 * Deletes a guided provider link. herobids owns the PLATFORM half (the
 * `connections` + `agent_connections` rows); the venue account + its credential
 * live behind the Traderton boundary and are removed via `deprovision_venue_account`
 * (L3-P1b).
 *
 * Eligibility: the connection must have `resolvedVenueAccountId !== null`.
 *
 * ORDERING DECISION (fail-closed, no partial state):
 *   1. Resolve dependents + block locally on the herobids-owned dependent
 *      (active agent grants). Bots are NOT read locally (c4.9f) — the boundary
 *      deprovision below is the authoritative bot guard.
 *   2. Boundary-deprovision the venue account. Traderton fail-closes on ITS
 *      dependents (any bot referencing the account) → `provision.in_use`, which
 *      we surface as `blocked` — the local connection is STILL INTACT, so a
 *      blocked delete leaves herobids fully consistent. `not_found.resource` is
 *      treated as already-gone (idempotent) so a retry after a partial delete
 *      still converges.
 *   3. ONLY after the boundary teardown succeeds (or reports already-gone) do we
 *      delete the local connection + revoked agent_connections rows.
 *
 * This order is chosen so a boundary `in_use` failure never leaves an orphaned
 * connection whose venue account we failed to remove; the reverse order
 * (connection first) would strand the venue account on an `in_use` failure with
 * no local connection to reconcile against.
 */
export async function deleteProviderLink(
  db: Database,
  connectionId: string,
  userId: string,
  tradertonClient?: TradertonClient,
): Promise<DeleteProviderLinkResult> {
  // 1. Load the connection and check eligibility.
  const resources = await resolveProviderLinkDependents(db, connectionId, userId);
  if (!resources) return { kind: 'not_found' };

  if (resources.venueAccountId === null) {
    return { kind: 'not_eligible', connectionId };
  }

  // Collect the herobids-owned platform blocker (active agent grants). Bots are
  // NOT pre-checked locally (c4.9f) — the boundary `deprovision_venue_account`
  // (step 5) is the authoritative bot guard and returns `blocked` on
  // `provision.in_use`.
  const blockingAgentIds = await resolveBlockingAgentLabels(db, connectionId);

  // 2-4. Block on the active agent grants (platform-owned dependent). The
  // bot arrays are empty here — the boundary carries the bot guard.
  if (blockingAgentIds.length > 0) {
    return {
      kind: 'blocked',
      connectionId,
      blockingAgentIds,
      blockingConnectionBotIds: [],
      blockingVenueAccountBotIds: [],
    };
  }

  const venueAccountId = resources.venueAccountId;

  // 5. Boundary teardown FIRST (fail-closed): remove the venue account + its
  //    credential behind the boundary. A `provision.in_use` here means a
  //    Traderton-owned bot still references the account → surface as blocked with
  //    the local connection untouched. `not_found.resource` → already gone
  //    (idempotent), continue to the local delete.
  const deprovisionResult = tradertonClient
    ? await tradertonClient.invoke({
        toolName: 'deprovision_venue_account',
        payload: { venueAccountId },
        subject: { ownerId: userId, actor: { type: 'user', id: userId } },
        deadlineMs: 30_000,
        idempotencyKey: `deprovision:${venueAccountId}`,
      })
    : { kind: 'transport_error' as const, requestId: '', retryable: true as const, message: 'trading boundary not configured' };

  if (deprovisionResult.kind === 'transport_error' || deprovisionResult.kind === 'in_progress') {
    return {
      kind: 'fault',
      code: 'precondition.not_ready',
      message: 'Trading service is unavailable — the provider link was not deleted.',
    };
  }
  if (deprovisionResult.kind === 'failure') {
    const errorCode = toolErrorCode(deprovisionResult.details);
    if (errorCode === 'provision.in_use') {
      // A Traderton-owned bot references the venue account. Preserve
      // fail-closed-on-dependents. The local connection is intact (we have not
      // touched it), so herobids stays consistent.
      return {
        kind: 'blocked',
        connectionId,
        blockingAgentIds: [],
        blockingConnectionBotIds: [],
        blockingVenueAccountBotIds: [],
      };
    }
    if (errorCode !== 'not_found.resource') {
      // Any other failure — do not delete the local connection.
      logger.error({ connectionId, venueAccountId, code: deprovisionResult.code, errorCode }, 'deprovision_venue_account failed');
      return {
        kind: 'fault',
        code: deprovisionResult.code,
        message: deprovisionResult.message,
      };
    }
    // not_found.resource → the venue account is already gone. Fall through to
    // remove the local connection so the overall delete converges.
  }

  // 6. Local platform half — delete revoked agent_connections + the connection.
  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(agentConnections)
        .where(
          and(
            eq(agentConnections.connectionId, connectionId),
            eq(agentConnections.status, 'revoked'),
          ),
        );

      await tx.delete(connections).where(eq(connections.id, connectionId));
    });
  } catch (err: unknown) {
    // The boundary rows are already gone; a local FK race (a concurrent grant/bot
    // appeared) leaves the connection in place. Report a retryable fault.
    const pgErr = err as { code?: string };
    if (pgErr.code === '23503') {
      logger.error({ connectionId, venueAccountId }, 'connection delete raced with a concurrent dependent');
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
      credential: resources.credentialId !== null,
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
