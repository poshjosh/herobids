import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { venueAccounts, bots, connections, agentCredentials } from '@herobids/db';

export interface CredentialDependents {
  venueAccountIds: string[];
  runningInstanceIds: string[];
  /** Active (non-revoked) connections that reference this credential. */
  activeConnectionIds: string[];
  /** Agent credential links that reference this credential (includes label for display). */
  blockingAgentCredentials: Array<{ id: string; label: string | null }>;
}

/**
 * Lists active connections, venue accounts, agent credential links, and running bots
 * that depend on a credential.
 *
 * Behaviour notes:
 * - `runningInstanceIds` reflects bots linked **via venue accounts** belonging to this
 *   credential. Active connections that happen to have running bots are NOT included.
 * - `activeConnectionIds` only counts connections with `status = 'active'`. Revoked
 *   connections do not block deletion (FK is ON DELETE SET NULL).
 * - `blockingAgentCredentialIds` captures agent_credentials rows referencing this
 *   credential. These must be unlinked before the credential can be deleted.
 *
 * Used by rotate (to restart running bots) and delete (to block if in-use).
 */
export async function findCredentialDependents(db: Database, credentialId: string): Promise<CredentialDependents> {
  // Find active connections linked to this credential — revoked connections are allowed
  // because the FK is now ON DELETE SET NULL, so deleting the credential nullifies them.
  const linkedConnections = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(
      eq(connections.credentialId, credentialId),
      eq(connections.status, 'active'),
    ));

  const activeConnectionIds = linkedConnections.map((c) => c.id);

  // Find agent_credentials that reference this credential
  const linkedAgentCredentials = await db
    .select({ id: agentCredentials.id, agentId: agentCredentials.agentId, label: agentCredentials.label })
    .from(agentCredentials)
    .where(eq(agentCredentials.credentialId, credentialId));

  const blockingAgentCredentials = linkedAgentCredentials.map((a) => ({ id: a.id, label: a.label }));

  // Find all venue accounts linked to this credential
  const linkedAccounts = await db
    .select({ id: venueAccounts.id })
    .from(venueAccounts)
    .where(eq(venueAccounts.credentialId, credentialId));

  const venueAccountIds = linkedAccounts.map((a) => a.id);

  if (venueAccountIds.length === 0 && activeConnectionIds.length === 0 && blockingAgentCredentials.length === 0) {
    return { venueAccountIds: [], runningInstanceIds: [], activeConnectionIds: [], blockingAgentCredentials: [] };
  }

  let runningInstanceIds: string[] = [];
  if (venueAccountIds.length > 0) {
    const runningBots = await db
      .select({ id: bots.id })
      .from(bots)
      .where(and(
        eq(bots.status, 'running'),
        inArray(bots.venueAccountId, venueAccountIds),
      ));
    runningInstanceIds = runningBots.map((b) => b.id);
  }

  return { venueAccountIds, runningInstanceIds, activeConnectionIds, blockingAgentCredentials };
}
