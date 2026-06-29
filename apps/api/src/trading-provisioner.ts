import crypto from 'node:crypto';
import type { Database } from '@herobids/db';
import { venueAccounts } from '@herobids/db';

export interface TradingProvisionResult {
  venueAccountId: string;
}

/** Minimal database interface required for provisioning — accepts both a full Database and a PgTransaction. */
type Insertable = Pick<Database, 'insert'>;

/**
 * Provisions a venue account for a trading connection.
 * The binding concept has been absorbed into connections — connections are now
 * the directly grantable entity.
 */
export async function provisionTradingTarget(
  tx: Insertable,
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

  return { venueAccountId };
}
