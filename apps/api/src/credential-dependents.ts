import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { venueAccounts, bots } from '@herobids/db';

export interface CredentialDependents {
  venueAccountIds: string[];
  runningInstanceIds: string[];
}

/**
 * Lists venue accounts and running bots that depend on a credential.
 * Used by rotate (to restart running bots) and delete (to block if in-use).
 */
export async function findCredentialDependents(db: Database, credentialId: string): Promise<CredentialDependents> {
  // Find all venue accounts linked to this credential
  const linkedAccounts = await db
    .select({ id: venueAccounts.id })
    .from(venueAccounts)
    .where(eq(venueAccounts.credentialId, credentialId));

  const venueAccountIds = linkedAccounts.map((a) => a.id);

  if (venueAccountIds.length === 0) {
    return { venueAccountIds: [], runningInstanceIds: [] };
  }

  // Find running bots that use those venue accounts
  const runningBots = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(
      eq(bots.status, 'running'),
      inArray(bots.venueAccountId, venueAccountIds),
    ));

  const runningInstanceIds = runningBots.map((b) => b.id);

  return { venueAccountIds, runningInstanceIds };
}
