import { eq, and } from 'drizzle-orm';
import type { Database } from './index.js';
import { connections } from './schema/index.js';

/**
 * Repository for bot-related ownership checks.
 *
 * Reduced to the single method still called by the platform: connection
 * ownership verification against the KEEP `connections` table. All bot
 * lifecycle / analytics methods were removed with the trading tables.
 */
export class BotRepository {
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
