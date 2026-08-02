#!/usr/bin/env npx tsx
/**
 * repair-agent-execution-defaults.ts
 *
 * One-time data repair: backfills executionDefaults.mode for all existing
 * trading-capable agents whose executionDefaults is null or missing a mode.
 *
 * Backfill rule:
 *   - Has active/granted trading connection → 'shadow'
 *   - No trading connection → 'paper'
 *
 * Idempotent — safe to run multiple times. Running after a successful repair
 * will find 0 agents to fix.
 *
 * Only touches trading-capable agents (agents assigned to skills whose
 * capability_families includes 'trading').
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/ts/repair-agent-execution-defaults.ts
 */

import { createDatabase, closeDatabase, agents, agentSkills, skills, agentConnections, connections } from '@herobids/db';
import { eq, isNull, and, inArray, sql, or } from 'drizzle-orm';

// Providers whose connections are trading-capable (mirrors PROVIDER_CATEGORIES in @herobids/domain).
const TRADING_PROVIDERS = ['hyperliquid', 'bybit', '1inch', 'jupiter'] as const;

async function main() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[repair-agent-execution-defaults] DATABASE_URL is required.');
    process.exit(1);
  }

  const db = createDatabase(databaseUrl);

  try {
    // ── Step 1: Find all skill IDs whose capability_families includes 'trading' ──
    const tradingSkillRows = await db
      .select({ id: skills.id, name: skills.name })
      .from(skills)
      .where(sql`${skills.capabilityFamilies} @> ARRAY['trading']`);

    const tradingSkillIds = tradingSkillRows.map((r) => r.id);

    if (tradingSkillIds.length === 0) {
      console.log('[repair-agent-execution-defaults] No trading skills found. Nothing to repair.');
      return;
    }

    console.log(
      `[repair-agent-execution-defaults] Found ${tradingSkillIds.length} trading skill(s):`,
      tradingSkillRows.map((r) => r.name).join(', '),
    );

    // ── Step 2: Find trading-capable agents (assigned to any trading skill) ──
    const agentSkillRows = await db
      .selectDistinct({ agentId: agentSkills.agentId })
      .from(agentSkills)
      .where(inArray(agentSkills.skillId, tradingSkillIds));

    const tradingAgentIds = agentSkillRows.map((r) => r.agentId);

    if (tradingAgentIds.length === 0) {
      console.log('[repair-agent-execution-defaults] No trading-capable agents found. Nothing to repair.');
      return;
    }

    console.log(`[repair-agent-execution-defaults] Found ${tradingAgentIds.length} trading-capable agent(s).`);

    // ── Step 3: Find affected agents (null executionDefaults or missing mode) ──
    const affectedAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        userId: agents.userId,
        executionDefaults: agents.executionDefaults,
      })
      .from(agents)
      .where(
        and(
          inArray(agents.id, tradingAgentIds),
          or(
            isNull(agents.executionDefaults),
            sql`${agents.executionDefaults}->>'mode' IS NULL`,
          ),
        ),
      );

    const totalTrading = tradingAgentIds.length;
    const alreadyOk = totalTrading - affectedAgents.length;
    console.log(
      `[repair-agent-execution-defaults] ${affectedAgents.length} agent(s) need repair ` +
      `(${alreadyOk} already OK, skipped).`,
    );

    if (affectedAgents.length === 0) {
      console.log('[repair-agent-execution-defaults] Nothing to repair. Done.');
      return;
    }

    // ── Step 4: Resolve mode per agent and update ──
    let shadowCount = 0;
    let paperCount = 0;

    for (const agent of affectedAgents) {
      // Check if this agent has any active trading connections
      const tradingConnectionRows = await db
        .select({ id: agentConnections.id })
        .from(agentConnections)
        .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
        .where(
          and(
            eq(agentConnections.agentId, agent.id),
            eq(agentConnections.status, 'active'),
            inArray(connections.provider, TRADING_PROVIDERS as unknown as string[]),
          ),
        )
        .limit(1);

      const hasTradingConnection = tradingConnectionRows.length > 0;
      const resolvedMode = hasTradingConnection ? 'shadow' : 'paper';

      // Merge with existing executionDefaults (preserve fields like slippageBps)
      const existingDefaults = (agent.executionDefaults as Record<string, unknown> | null) ?? {};
      const newDefaults = { ...existingDefaults, mode: resolvedMode };

      await db
        .update(agents)
        .set({ executionDefaults: newDefaults as NonNullable<typeof agent.executionDefaults> })
        .where(eq(agents.id, agent.id));

      if (hasTradingConnection) {
        shadowCount++;
      } else {
        paperCount++;
      }

      const before =
        agent.executionDefaults == null
          ? 'null'
          : `{ mode: <missing> }`;
      console.log(
        `[repair-agent-execution-defaults]   ${agent.name} (${agent.id.slice(0, 8)}…): ` +
        `${before} → mode=${resolvedMode}` +
        (hasTradingConnection ? ' (has active trading connection)' : ''),
      );
    }

    // ── Step 5: Print summary ──
    console.log('');
    console.log('[repair-agent-execution-defaults] ── Summary ──');
    console.log(`[repair-agent-execution-defaults]   Trading-capable agents: ${totalTrading}`);
    console.log(`[repair-agent-execution-defaults]   Already OK (skipped):  ${alreadyOk}`);
    console.log(`[repair-agent-execution-defaults]   Repaired:              ${affectedAgents.length}`);
    console.log(`[repair-agent-execution-defaults]     → shadow: ${shadowCount}`);
    console.log(`[repair-agent-execution-defaults]     → paper:  ${paperCount}`);
    console.log('[repair-agent-execution-defaults] Done.');
  } finally {
    await closeDatabase(db);
  }
}

main().catch((err) => {
  console.error('[repair-agent-execution-defaults] Fatal error:', err);
  process.exit(1);
});
