import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { venueAccounts, tradingInstances } from '@herobids/db';

export interface CredentialDependents {
  venueAccountIds: string[];
  runningInstanceIds: string[];
}

/**
 * Lists venue accounts and running trading instances that depend on a credential.
 * Used by rotate (to restart running instances) and delete (to block if in-use).
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

  // Find running trading instances that use those venue accounts (filtered in SQL)
  const runningInstances = await db
    .select({ id: tradingInstances.id })
    .from(tradingInstances)
    .where(and(
      eq(tradingInstances.status, 'running'),
      inArray(tradingInstances.venueAccountId, venueAccountIds),
    ));

  const runningInstanceIds = runningInstances.map((inst) => inst.id);

  return { venueAccountIds, runningInstanceIds };
}
