import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentMessages, agents } from '@herobids/db';

export const TICK_STARTED_TYPE = 'agent.tick.started';

export interface ReceiptCandidate {
  id: string;
  createdAt: Date;
}

/**
 * Whether the agent's runtime has taken each sent user message into a tick. A tick reports the user message IDs it read
 * in `agent.tick.started`, which the runtime emits before its skip gates. So `true` means the message reached a tick's
 * input, not that the model read it or replied. Per message: `true` when a tick lists its ID, `false` when none has yet,
 * and `null` when the stored history does not reach back to the message, so the state is unknown.
 */
export async function userMessageReceiptState(
  db: Database,
  agentId: string,
  messages: ReceiptCandidate[],
): Promise<Map<string, boolean | null>> {
  const states = new Map<string, boolean | null>();
  if (messages.length === 0) return states;

  const oldest = messages.reduce<Date | null>(
    (earliest, message) => (earliest === null || message.createdAt < earliest ? message.createdAt : earliest),
    null,
  );

  // Nothing is stored before the agent exists, and no code path prunes agent_messages. So the agent's creation time is the
  // start of its tick history. Reading it is a primary-key lookup, not a scan of the agent's heartbeats.
  const [agent] = await db.select({ createdAt: agents.createdAt })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const historyStart = agent?.createdAt ?? null;

  const ticks = await db.select({ userMessageIds: sql<unknown>`${agentMessages.payload} -> 'userMessageIds'` })
    .from(agentMessages)
    .where(and(
      eq(agentMessages.agentId, agentId),
      eq(agentMessages.type, TICK_STARTED_TYPE),
      gte(agentMessages.createdAt, oldest ?? new Date(0)),
    ));

  const received = new Set<string>();
  for (const tick of ticks) {
    const ids = tick.userMessageIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string') received.add(id);
    }
  }

  for (const message of messages) {
    if (historyStart === null || message.createdAt < historyStart) {
      states.set(message.id, null);
    } else {
      states.set(message.id, received.has(message.id));
    }
  }
  return states;
}
