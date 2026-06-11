import crypto from 'node:crypto';
import { eq, and, lt } from 'drizzle-orm';
import type { Database } from './index.js';
import { tokenSafetyOverrides } from './schema/index.js';

export interface IssueOverrideParams {
  actorType: string;
  actorId: string;
  botId?: string;
  venueAccountId: string;
  network: string;
  tokenAddress: string;
  reasonCodes: string[];
  expiresAt: Date;
  meta?: Record<string, unknown>;
}

export interface TokenSafetyOverrideRow {
  id: string;
  actorType: string;
  actorId: string;
  botId: string | null;
  venueAccountId: string;
  network: string;
  tokenAddress: string;
  reasonCodes: string[];
  status: string;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedBy: string | null;
  meta: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export class TokenSafetyOverrideRepository {
  constructor(private readonly db: Database) {}

  async issue(params: IssueOverrideParams): Promise<TokenSafetyOverrideRow> {
    const id = crypto.randomUUID();
    const [row] = await this.db.insert(tokenSafetyOverrides).values({
      id,
      actorType: params.actorType,
      actorId: params.actorId,
      botId: params.botId ?? null,
      venueAccountId: params.venueAccountId,
      network: params.network,
      tokenAddress: params.tokenAddress,
      reasonCodes: params.reasonCodes,
      status: 'active',
      expiresAt: params.expiresAt,
      meta: params.meta ?? null,
    }).returning();
    return row as TokenSafetyOverrideRow;
  }

  async fetchActive(
    id: string,
    actorType: string,
    actorId: string,
    network: string,
    tokenAddress: string,
    venueAccountId: string,
  ): Promise<TokenSafetyOverrideRow | null> {
    const [row] = await this.db
      .select()
      .from(tokenSafetyOverrides)
      .where(
        and(
          eq(tokenSafetyOverrides.id, id),
          eq(tokenSafetyOverrides.actorType, actorType),
          eq(tokenSafetyOverrides.actorId, actorId),
          eq(tokenSafetyOverrides.network, network),
          eq(tokenSafetyOverrides.tokenAddress, tokenAddress),
          eq(tokenSafetyOverrides.venueAccountId, venueAccountId),
          eq(tokenSafetyOverrides.status, 'active'),
        ),
      )
      .limit(1);

    if (!row) return null;

    // Expire lazily on read
    if (new Date(row.expiresAt) < new Date()) {
      await this.db
        .update(tokenSafetyOverrides)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(tokenSafetyOverrides.id, id));
      return null;
    }

    return row as TokenSafetyOverrideRow;
  }

  async consume(id: string, consumedById: string): Promise<boolean> {
    const now = new Date();
    const result = await this.db
      .update(tokenSafetyOverrides)
      .set({
        status: 'consumed',
        consumedAt: now,
        consumedBy: consumedById,
        updatedAt: now,
      })
      .where(
        and(
          eq(tokenSafetyOverrides.id, id),
          eq(tokenSafetyOverrides.status, 'active'),
        ),
      )
      .returning({ id: tokenSafetyOverrides.id });

    return result.length > 0;
  }

  async expireStale(): Promise<number> {
    const now = new Date();
    const result = await this.db
      .update(tokenSafetyOverrides)
      .set({ status: 'expired', updatedAt: now })
      .where(
        and(
          eq(tokenSafetyOverrides.status, 'active'),
          lt(tokenSafetyOverrides.expiresAt, now),
        ),
      )
      .returning({ id: tokenSafetyOverrides.id });

    return result.length;
  }
}
