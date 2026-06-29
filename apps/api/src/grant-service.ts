import crypto from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { connections, capabilityGrants, capabilityGrantAudit } from '@herobids/db';
import type { PlatformActorType } from '@herobids/domain';

export interface GrantCreateInput {
  agentId: string;
  connectionId: string;
  capabilityFamily: string;
  grantedBy: string;       // userId
}

export interface GrantRevokeInput {
  grantId: string;
  actorType: PlatformActorType;
  actorId: string;
  reason?: string;
}

/**
 * Create a new capability grant.
 *
 * The grant insert and audit row are written in a single transaction so the
 * audit trail can never be missing for a committed state change.
 *
 * Callers must validate agent/connection ownership before calling this.
 */
export async function createGrant(
  db: Database,
  input: GrantCreateInput,
): Promise<string> {
  const now = new Date();
  const grantId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(capabilityGrants).values({
      id: grantId,
      agentId: input.agentId,
      connectionId: input.connectionId,
      capabilityFamily: input.capabilityFamily,
      status: 'active',
      grantedBy: input.grantedBy,
      grantedAt: now,
      revokedAt: null,
      meta: null,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(capabilityGrantAudit).values({
      id: crypto.randomUUID(),
      grantId,
      action: 'granted',
      actorType: 'user',
      actorId: input.grantedBy,
      reason: null,
      detail: { connectionId: input.connectionId, capabilityFamily: input.capabilityFamily },
      createdAt: now,
    });
  });

  return grantId;
}

/**
 * Revoke an existing capability grant.
 *
 * The status update and audit row are written in a single transaction.
 * The row is retained — never deleted.
 * Returns false if the grant did not exist or was already revoked.
 */
export async function revokeGrant(
  db: Database,
  input: GrantRevokeInput,
): Promise<boolean> {
  let revoked = false;
  const now = new Date();

  await db.transaction(async (tx) => {
    // Conditional update: only touches the row when it is still active.
    // Two concurrent revokes can both enter the transaction, but only one
    // will observe a non-empty `updated` list and proceed to write the
    // audit row — preventing duplicate audit entries without a SELECT FOR UPDATE.
    const updated = await tx
      .update(capabilityGrants)
      .set({ status: 'revoked', revokedAt: now, updatedAt: now })
      .where(and(eq(capabilityGrants.id, input.grantId), eq(capabilityGrants.status, 'active')))
      .returning({ id: capabilityGrants.id });

    if (updated.length === 0) {
      // Grant did not exist or was already revoked — no-op.
      return;
    }

    await tx.insert(capabilityGrantAudit).values({
      id: crypto.randomUUID(),
      grantId: input.grantId,
      action: 'revoked',
      actorType: input.actorType,
      actorId: input.actorId,
      reason: input.reason ?? null,
      detail: null,
      createdAt: now,
    });

    revoked = true;
  });

  return revoked;
}

/**
 * Fetch the audit trail for a grant (oldest first).
 */
export async function getGrantAudit(
  db: Database,
  grantId: string,
): Promise<typeof capabilityGrantAudit.$inferSelect[]> {
  return db
    .select()
    .from(capabilityGrantAudit)
    .where(eq(capabilityGrantAudit.grantId, grantId))
    .orderBy(capabilityGrantAudit.createdAt);
}

/**
 * Fetch the audit trail for a connection (oldest first).
 */
export async function getBindingAudit(
  db: Database,
  connectionId: string,
  agentId: string,
): Promise<typeof capabilityGrantAudit.$inferSelect[]> {
  const grants = await db
    .select({ id: capabilityGrants.id })
    .from(capabilityGrants)
    .where(and(eq(capabilityGrants.connectionId, connectionId), eq(capabilityGrants.agentId, agentId)));

  if (grants.length === 0) {
    return [];
  }

  const grantIds = grants.map((grant) => grant.id);
  return db
    .select()
    .from(capabilityGrantAudit)
    .where(inArray(capabilityGrantAudit.grantId, grantIds))
    .orderBy(capabilityGrantAudit.createdAt);
}

/**
 * Verify that a connection belongs to a user.
 */
export async function assertConnectionOwnership(
  db: Database,
  connectionId: string,
  userId: string,
): Promise<typeof connections.$inferSelect | null> {
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.userId, userId)));
  return conn ?? null;
}

/**
 * Verify that a grant belongs to an agent owned by a user.
 * Returns the grant + connection row if the ownership chain is valid.
 */
export async function assertGrantOwnership(
  db: Database,
  grantId: string,
  userId: string,
): Promise<(typeof capabilityGrants.$inferSelect & { connection: typeof connections.$inferSelect }) | null> {
  // Join via connection → userId to validate the whole ownership chain.
  const rows = await db
    .select({
      grant: capabilityGrants,
      connection: connections,
    })
    .from(capabilityGrants)
    .innerJoin(connections, eq(capabilityGrants.connectionId, connections.id))
    .where(and(eq(capabilityGrants.id, grantId), eq(connections.userId, userId)));

  if (!rows[0]) return null;
  return { ...rows[0].grant, connection: rows[0].connection };
}

/**
 * Verify that a connection belongs to a user and return it with its connection metadata.
 */
export async function assertBindingOwnership(
  db: Database,
  connectionId: string,
  userId: string,
): Promise<(typeof connections.$inferSelect) | null> {
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.userId, userId)));

  return conn ?? null;
}
