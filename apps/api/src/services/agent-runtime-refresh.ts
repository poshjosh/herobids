import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, buildRuntimeDescriptor, resolveRuntimeCapabilityDescriptor } from '@herobids/db';
import { AGENT_STREAM_MAXLEN, readSkillPresetId, type RuntimeBudgetPolicy } from '@herobids/domain';

/** Publishes a fresh runtime descriptor so a running agent picks up connection/readiness changes. */
export async function publishAgentRuntimeRefresh(
  db: Database,
  redis: Redis,
  budgets: RuntimeBudgetPolicy,
  agentId: string,
): Promise<void> {
  const [agentRow] = await db
    .select({
      id: agents.id,
      name: agents.name,
      prompt: agents.prompt,
      toolPolicy: agents.toolPolicy,
      maxBots: agents.maxBots,
      unifiedConfig: agents.unifiedConfig,
    })
    .from(agents)
    .where(eq(agents.id, agentId));

  if (!agentRow) {
    return;
  }

  const capabilityDescriptor = await resolveRuntimeCapabilityDescriptor(db, agentId);
  const runtimeDescriptor = buildRuntimeDescriptor({
    agentId,
    name: agentRow.name,
    skillPresetId: readSkillPresetId(agentRow.unifiedConfig),
    goal: agentRow.prompt,
    executionMode: undefined,
    toolPolicy: (agentRow.toolPolicy as Record<string, unknown> | null) ?? {},
    dailyMaxLossPct: null,
    maxDrawdownPct: null,
    maxBots: agentRow.maxBots,
    budgets,
    capabilityDescriptor,
  });

  await redis.xadd(
    `agent:outbound:${agentId}`,
    'MAXLEN',
    '~',
    AGENT_STREAM_MAXLEN,
    '*',
    'envelope',
    JSON.stringify({
      schemaVersion: 'v1',
      messageId: crypto.randomUUID(),
      correlationId: agentId,
      initiatorType: 'system',
      initiatorId: agentId,
      agentId,
      type: 'agent.runtime.config_update',
      createdAt: new Date().toISOString(),
      payload: { reason: 'readiness_changed', runtimeDescriptor },
    }),
  );
}
