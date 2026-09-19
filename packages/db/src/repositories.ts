import { eq, and } from 'drizzle-orm';
import type { Database } from './index.js';
import { connections } from './schema/index.js';

/**
 * Connection-scoped ownership verification.
 *
 * The former `BotRepository` was reduced to this single method after the bot
 * lifecycle / analytics methods were removed with the trading tables. It no
 * longer references bots at all — it only verifies that a `connections` row
 * exists and belongs to the given user (a platform-side authz gate).
 */
export class ConnectionOwnershipRepository {
  constructor(private readonly db: Database) {}

  /**
   * Confirm that a connection exists and belongs to the given user.
   * Used by the broker before creating a bot on behalf of an agent.
   */
  async isConnectionOwnedBy(connectionId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.userId, userId)));
    return !!row;
  }
}
