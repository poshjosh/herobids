import crypto from 'node:crypto';
import type { Database } from '@herobids/db';
import { venueAccounts, tradingBindings } from '@herobids/db';

export interface TradingProvisionResult {
  venueAccountId: string;
  bindingId: string;
}

/** Minimal database interface required for provisioning — accepts both a full Database and a PgTransaction. */
type Insertable = Pick<Database, 'insert'>;

/**
 * Provisions a venue account and trading binding for an existing connection.
 * The binding always has a non-null sourceVenueAccountId so that bots can
 * reference it directly on creation.
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
  const bindingId = crypto.randomUUID();

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

  await tx.insert(tradingBindings).values({
    id: bindingId,
    userId: opts.userId,
    connectionId: opts.connectionId,
    provider: opts.provider,
    label: opts.label,
    bindingRef: null,
    status: 'active',
    bindingProfile: { provider: opts.provider },
    sourceVenueAccountId: venueAccountId,
    createdAt: opts.now,
    updatedAt: opts.now,
  });

  return { venueAccountId, bindingId };
}
