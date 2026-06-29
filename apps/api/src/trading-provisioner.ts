import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { connections, venueAccounts } from '@herobids/db';

export interface TradingProvisionResult {
  venueAccountId: string;
}

/** Minimal database interface required for provisioning — accepts both a full Database and a PgTransaction. */
type TxClient = Pick<Database, 'insert' | 'update'>;

/**
 * Provisions a venue account for a trading connection.
 * The binding concept has been absorbed into connections — connections are now
 * the directly grantable entity.
 */
export async function provisionTradingTarget(
  tx: TxClient,
  opts: {
    userId: string;
    connectionId: string;
    provider: string;
    label: string;
    credentialId: string | null;
    now: Date;
  },
): Promise<TradingProvisionResult> {
  const venueAccountId = crypto.randomUUID();

  await tx.insert(venueAccounts).values({
    id: venueAccountId,
    userId: opts.userId,
    venue: opts.provider,
    label: opts.label,
    venueAccountRef: null,
    credentialId: opts.credentialId,
    createdAt: opts.now,
    updatedAt: opts.now,
  });

  await tx
    .update(connections)
    .set({ resolvedVenueAccountId: venueAccountId, updatedAt: opts.now })
    .where(eq(connections.id, opts.connectionId));

  return { venueAccountId };
}
