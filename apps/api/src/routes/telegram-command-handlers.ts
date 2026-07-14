/**
 * Telegram slash-command handler functions for read/discovery commands.
 *
 * Each handler receives a db handle, userId, and parsed command args,
 * queries the database, and returns a plain-text string suitable for
 * Telegram delivery.
 *
 * All handlers handle the unbound-chat case (userId may be undefined in
 * the caller, but this module's functions require userId to be resolved).
 */

import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import type { AuthConfig } from '@herobids/domain';
import {
  agents,
  connections,
  agentConnections,
  agentSkills,
  skills,
  skillEntitlements,
  agentMessages,
  agentOutboundMessages,
  decisionFailures,
  agentRuntimeSessions,
  decisions,
} from '@herobids/db';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import {
  listAgentConnections,
  grantConnection,
  revokeConnection,
  setExecutionMode,
} from '../services/agent-config-service.js';
import {
  makeSetupLinkUrl,
  createAndStoreSetupLinkToken,
} from '../services/setup-link-token-service.js';
import {
  startAgent,
  pauseAgent,
  resumeAgent,
  stopAgent,
} from '../services/agent-lifecycle-service.js';
import { hasSkillCapabilityFamily } from '../routes/agent-config-helpers.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function formatTime(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function fmtNullable(value: string | null | undefined, suffix = ''): string {
  if (value == null || value === '') return '-';
  return `${value}${suffix}`;
}

function fmtPct(value: string | null | undefined): string {
  if (value == null) return '-';
  return `${value}%`;
}

function fmtUsd(value: string | null | undefined): string {
  if (value == null) return '-';
  return `$${value}`;
}

function extractStrategyPreset(unifiedConfig: unknown): string | null {
  const uc = unifiedConfig as Record<string, unknown> | null;
  const meta = uc?.['metadata'] as Record<string, unknown> | undefined;
  const preset = meta?.['strategyPreset'];
  if (typeof preset === 'string' && preset.length > 0) return preset;
  return null;
}

/**
 * Truncate text for Telegram's 4096-character sendMessage limit.
 * Truncates at the last newline before maxChars and appends a count
 * of omitted items.
 */
function truncateForTelegram(text: string, maxChars = 3800): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');

  if (lastNewline === -1) {
    return text.slice(0, maxChars - 15) + '\n...and more';
  }

  const remaining = text.slice(lastNewline + 1);
  const remainingItems = remaining.split('\n').filter((l) => l.trim().length > 0);
  const count = remainingItems.length;

  return text.slice(0, lastNewline) + `\n...and ${count} more`;
}

/**
 * Map agent message types to human-readable labels for /log output.
 */
function formatActivityLabel(type: string): string {
  if (type.startsWith('agent.decision')) return 'DECISION';
  if (type.startsWith('user')) return 'USER';
  if (type.startsWith('system')) return 'SYSTEM';
  if (type.startsWith('agent.message')) return 'AGENT';
  // Extract last segment after the last dot
  const lastDot = type.lastIndexOf('.');
  return lastDot >= 0 ? type.slice(lastDot + 1).toUpperCase() : type.toUpperCase();
}

// ── Agent name resolver ──────────────────────────────────────────────────

/** Result of resolving an agent by name. */
export type AgentNameResolution =
  | { type: 'found'; agent: typeof agents.$inferSelect }
  | { type: 'not_found' }
  | { type: 'ambiguous'; agents: Array<typeof agents.$inferSelect> };

/**
 * Resolve an agent by case-insensitive exact name, scoped to userId.
 * Supports quoted names with spaces (the tokenizer strips quotes before
 * the name reaches this function).
 *
 * Returns a discriminated union so callers can distinguish "not found"
 * from "multiple agents share the same name".
 */
export async function resolveAgentByName(
  db: Database,
  userId: string,
  name: string,
): Promise<AgentNameResolution> {
  const rows = await db.select().from(agents)
    .where(and(
      eq(agents.userId, userId),
      sql`LOWER(${agents.name}) = LOWER(${name})`,
    ))
    .limit(3);

  if (rows.length === 0) return { type: 'not_found' };
  if (rows.length > 1) return { type: 'ambiguous', agents: rows };
  return { type: 'found', agent: rows[0]! };
}

// ── handleAgents ─────────────────────────────────────────────────────────

export async function handleAgents(db: Database, userId: string): Promise<string> {
  try {
    const rows = await db.select({
      name: agents.name,
      status: agents.status,
    }).from(agents)
      .where(eq(agents.userId, userId))
      .orderBy(agents.createdAt);

    if (rows.length === 0) {
      return "You don't have any agents yet. Create one at https://herobids.com/agents";
    }

    return truncateForTelegram(rows.map((r) => `${r.name}: ${r.status}`).join('\n'));
  } catch (error) {
    console.error('handleAgents failed:', error);
    return 'Failed to list agents. Please try again later.';
  }
}

// ── handleStatus ─────────────────────────────────────────────────────────

export async function handleStatus(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    // No args → summarize all caller-owned agents
    if (args.length === 0) {
      const rows = await db.select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        pauseState: agents.pauseState,
      }).from(agents)
        .where(eq(agents.userId, userId))
        .orderBy(agents.createdAt);

      if (rows.length === 0) {
        return 'No agents found.';
      }

      // Get last session for all agents in one query
      const agentIds = rows.map((r) => r.id);
      const sessionRows = await db.select({
        agentId: agentRuntimeSessions.agentId,
        status: agentRuntimeSessions.status,
        startedAt: agentRuntimeSessions.startedAt,
        stoppedAt: agentRuntimeSessions.stoppedAt,
      }).from(agentRuntimeSessions)
        .where(inArray(agentRuntimeSessions.agentId, agentIds))
        .orderBy(desc(agentRuntimeSessions.startedAt));

      // Build map: agentId → most recent session
      const latestSessionByAgent = new Map<string, typeof sessionRows[number]>();
      for (const s of sessionRows) {
        if (!latestSessionByAgent.has(s.agentId)) {
          latestSessionByAgent.set(s.agentId, s);
        }
      }

      const lines: string[] = ['Your agents:', ''];
      for (const agent of rows) {
        const session = latestSessionByAgent.get(agent.id);
        const extras: string[] = [];

        if (agent.status === 'paused' && agent.pauseState?.reason) {
          extras.push(`paused: ${agent.pauseState.reason}`);
        }
        if (session && session.status !== 'stopped' && session.status !== 'crashed') {
          extras.push(`session: ${session.status}`);
        }

        const detail = extras.length > 0 ? ` (${extras.join(', ')})` : '';
        lines.push(`${agent.name}: ${agent.status}${detail}`);
      }

      return truncateForTelegram(lines.join('\n'));
    }

    // One arg → detailed status for matching agent
    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }
    const agent = resolved.agent;

    // Get last session
    const [session] = await db.select({
      status: agentRuntimeSessions.status,
      startedAt: agentRuntimeSessions.startedAt,
    }).from(agentRuntimeSessions)
      .where(eq(agentRuntimeSessions.agentId, agent.id))
      .orderBy(desc(agentRuntimeSessions.startedAt))
      .limit(1);

    // Count decisions in current session timeframe (or last 24h if no session).
    // Includes decisions submitted by the agent directly AND decisions from
    // bots that this agent created.
    const decisionSince = session?.startedAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [countRow] = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM decisions
      WHERE created_at >= ${decisionSince}
        AND (
          (actor_type = 'agent' AND actor_id = ${agent.id})
          OR
          (actor_type = 'bot' AND actor_id IN (
            SELECT id FROM bots WHERE creator_type = 'agent' AND creator_id = ${agent.id}
          ))
        )
    `);
    const decisionCount = (countRow as { count: number } | undefined)?.count ?? 0;

    const lines: string[] = [
      `${agent.name}:`,
      `Status: ${agent.status}`,
      `Last session: ${session?.startedAt ? session.startedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-'}`,
      `Decisions this session: ${decisionCount}`,
      `Pause reason: ${agent.pauseState?.reason ?? '-'}`,
    ];

    return lines.join('\n');
  } catch (error) {
    console.error('handleStatus failed:', error);
    return 'Failed to get status. Please try again later.';
  }
}

// ── handleInfo ────────────────────────────────────────────────────────────

export async function handleInfo(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (args.length === 0) {
      return 'Usage: /info <agent name>';
    }

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }
    const agent = resolved.agent;

    // Fetch skills, session, and connection count in parallel
    const [skillRows, [session], [connCount]] = await Promise.all([
      db.select({ name: skills.name })
        .from(agentSkills)
        .innerJoin(skills, eq(agentSkills.skillId, skills.id))
        .where(eq(agentSkills.agentId, agent.id))
        .orderBy(agentSkills.orderIndex),

      db.select({
        status: agentRuntimeSessions.status,
        startedAt: agentRuntimeSessions.startedAt,
      }).from(agentRuntimeSessions)
        .where(eq(agentRuntimeSessions.agentId, agent.id))
        .orderBy(desc(agentRuntimeSessions.startedAt))
        .limit(1),

      db.select({
        count: sql<number>`COUNT(*)::int`,
      }).from(agentConnections)
        .where(and(
          eq(agentConnections.agentId, agent.id),
          eq(agentConnections.status, 'active'),
        )),
    ]);

    const strategyPreset = extractStrategyPreset(agent.unifiedConfig);

    // Only show capital for trading agents (executionMode set and not 'paper')
    const capitalDisplay = agent.executionMode && agent.executionMode !== 'paper'
      ? fmtUsd(agent.capital)
      : 'n/a';

    const lines: string[] = [
      `${agent.name}:`,
      `Status: ${agent.status}`,
      `Execution mode: ${agent.executionMode}`,
      `Capital: ${capitalDisplay}`,
      `Daily loss limit: ${fmtUsd(agent.dailyLossLimit)}`,
      `Max drawdown: ${fmtPct(agent.maxDrawdownPct)}`,
      `Max position size: ${fmtPct(agent.maxPositionSizePct)}`,
      `Stop loss: ${fmtPct(agent.stopLossPct)}`,
      `Style: ${fmtNullable(agent.style)}`,
      `Strategy preset: ${fmtNullable(strategyPreset)}`,
      `Skills: ${skillRows.length > 0 ? skillRows.map((s) => s.name).join(', ') : '-'}`,
      `Last session: ${session?.startedAt ? session.startedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-'}${session ? ` (${session.status})` : ''}`,
      `Pause reason: ${agent.pauseState?.reason ?? '-'}`,
      `Connections: ${connCount?.count ?? 0} active`,
    ];

    return lines.join('\n');
  } catch (error) {
    console.error('handleInfo failed:', error);
    return 'Failed to get agent info. Please try again later.';
  }
}

// ── handleSkills ──────────────────────────────────────────────────────────

export async function handleSkills(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    // With agent name → list skills assigned to that agent
    if (args.length > 0) {
      const resolved = await resolveAgentByName(db, userId, args[0]!);
      if (resolved.type === 'not_found') {
        return `Agent "${args[0]}" not found.`;
      }
      if (resolved.type === 'ambiguous') {
        const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
        return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
      }
      const agent = resolved.agent;

      const rows = await db.select({
        name: skills.name,
        id: skills.id,
      }).from(agentSkills)
        .innerJoin(skills, eq(agentSkills.skillId, skills.id))
        .where(eq(agentSkills.agentId, agent.id))
        .orderBy(agentSkills.orderIndex);

      if (rows.length === 0) {
        return `${agent.name} has no skills assigned.`;
      }

      return rows.map((r) => `${r.name} (${r.id})`).join('\n');
    }

    // No args → list all skills available to the user
    const [skillRows, entitlementRows] = await Promise.all([
      db.select({
        id: skills.id,
        name: skills.name,
        authorId: skills.authorId,
        publicationStatus: skills.publicationStatus,
        priceCents: skills.priceCents,
      }).from(skills).orderBy(skills.name),

      db.select({ skillId: skillEntitlements.skillId })
        .from(skillEntitlements)
        .where(and(
          eq(skillEntitlements.userId, userId),
          sql`${skillEntitlements.revokedAt} IS NULL`,
        )),
    ]);

    const entitledIds = new Set(entitlementRows.map((r) => r.skillId));

    const availableSkills = skillRows.filter((skill) => {
      if (skill.authorId === null) return true;        // system skill
      if (skill.authorId === userId) return true;      // user's own
      if (entitledIds.has(skill.id)) return true;      // entitled
      return skill.publicationStatus === 'published' && skill.priceCents === 0; // free published
    });

    if (availableSkills.length === 0) {
      return 'No skills available.';
    }

    return truncateForTelegram(availableSkills.map((s) => `${s.name} (${s.id})`).join('\n'));
  } catch (error) {
    console.error('handleSkills failed:', error);
    return 'Failed to list skills. Please try again later.';
  }
}

// ── handleLog ─────────────────────────────────────────────────────────────

export async function handleLog(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (args.length === 0) {
      return 'Usage: /log <agent name>';
    }

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }
    const agent = resolved.agent;

    // Single UNION ALL query so the 10 most recent entries across all sources
    // are returned regardless of which source dominates.
    type LogRow = {
      source: 'msg' | 'outbound' | 'failure';
      raw_type: string;
      subject: string | null;
      body_text: string | null;
      failure_msg: string | null;
      created_at: Date;
    };

    const logRows = await db.execute(sql`
      SELECT 'msg' AS source, type AS raw_type, NULL::text AS subject, NULL::text AS body_text, NULL::text AS failure_msg, created_at
      FROM agent_messages WHERE agent_id = ${agent.id}
      UNION ALL
      SELECT 'outbound', authored_by, subject, body, NULL, created_at
      FROM agent_outbound_messages WHERE agent_id = ${agent.id}
      UNION ALL
      SELECT 'failure', failure_code, NULL, NULL, failure_message, failed_at
      FROM decision_failures WHERE actor_type = 'agent' AND actor_id = ${agent.id}
      ORDER BY created_at DESC
      LIMIT 10
    `) as unknown as LogRow[];

    if (logRows.length === 0) {
      return `${agent.name} has no recent activity.`;
    }

    // Map to display entries with human-readable labels (descending order from SQL)
    const entries = logRows.map((row) => {
      const time = formatTime(new Date(row.created_at));
      if (row.source === 'msg') {
        const label = formatActivityLabel(row.raw_type);
        return `[${time}] ${label}`;
      }
      if (row.source === 'outbound') {
        const desc = row.subject ?? truncate(row.body_text ?? '', 80);
        const prefix = row.raw_type === 'platform' ? 'ALERT' : 'AGENT';
        return `[${time}] ${prefix}: ${desc}`;
      }
      // failure
      return `[${time}] ERR: ${row.raw_type} — ${truncate(row.failure_msg ?? '', 60)}`;
    });

    // Take 5 most recent, then reverse for chronological order (oldest first)
    const recent = entries.slice(0, 5).reverse();

    return [`${agent.name} — recent activity:`, ...recent].join('\n');
  } catch (error) {
    console.error('handleLog failed:', error);
    return 'Failed to get activity log. Please try again later.';
  }
}

// ── handleConnections ─────────────────────────────────────────────────────

export async function handleConnections(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    // With agent name → list connections assigned to that agent
    if (args.length > 0) {
      const resolved = await resolveAgentByName(db, userId, args[0]!);
      if (resolved.type === 'not_found') {
        return `Agent "${args[0]}" not found.`;
      }
      if (resolved.type === 'ambiguous') {
        const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
        return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
      }
      const agent = resolved.agent;

      const result = await listAgentConnections(db, agent.id, userId);
      if (!result.ok) {
        return `Failed to list connections: ${result.error.message}`;
      }

      if (result.value.length === 0) {
        return `${agent.name} has no connections assigned.`;
      }

      return result.value.map((c) =>
        `${c.provider}: ${c.label} (${c.connectionId.slice(0, 8)}...)`,
      ).join('\n');
    }

    // No args → list user's active connections
    const rows = await db.select({
      id: connections.id,
      label: connections.label,
      provider: connections.provider,
    }).from(connections)
      .where(and(
        eq(connections.userId, userId),
        eq(connections.status, 'active'),
      ))
      .orderBy(connections.provider, connections.label);

    if (rows.length === 0) {
      return 'You have no active connections.';
    }

    return truncateForTelegram(rows.map((c) =>
      `${c.provider}: ${c.label} (${c.id.slice(0, 8)}...)`,
    ).join('\n'));
  } catch (error) {
    console.error('handleConnections failed:', error);
    return 'Failed to list connections. Please try again later.';
  }
}

// ── handleConnectSetup ────────────────────────────────────────────────────

/**
 * Handle `/connect <agent>` with no connection ID argument.
 *
 * If the user has no active connections, generates a one-time auto-login setup
 * link and returns it. If the user already has active connections, lists them.
 * The target agent must be stopped.
 */
export async function handleConnectSetup(
  db: Database,
  redis: Redis,
  authConfig: AuthConfig,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (args.length === 0) {
      return 'Usage: /connect <agent name>';
    }

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }
    const agent = resolved.agent;

    // Target agent must be stopped
    if (agent.status !== 'stopped') {
      return `Cannot change connections: ${agent.name} is ${agent.status}. Stop the agent first.`;
    }

    // Query user's active connections
    const userConnections = await db.select({
      id: connections.id,
      label: connections.label,
      provider: connections.provider,
      status: connections.status,
    }).from(connections)
      .where(and(
        eq(connections.userId, userId),
        eq(connections.status, 'active'),
      ))
      .orderBy(connections.provider, connections.label);

    // If user has active connections, list them
    if (userConnections.length > 0) {
      const lines = [
        `You have these active connections:`,
        ...userConnections.map((c) => `  ${c.id.slice(0, 8)}... — ${c.provider}: ${c.label}`),
        '',
        `Use /connect ${agent.name} <id> or /connect ${agent.name} "label" to pick one.`,
        'To create a new connection, use /connections to see the full list or open the web app.',
      ];
      return lines.join('\n');
    }

    // Check whether the user has any connections at all (inactive)
    const [anyConnection] = await db.select({ id: connections.id }).from(connections)
      .where(eq(connections.userId, userId))
      .limit(1);
    const hasInactiveNote = anyConnection
      ? '\nYou have connections but none are active. Visit the web app to manage them, or create a new one below.'
      : '';

    // Rate-limit setup link generation — per-user cooldown
    const cooldownSecs = authConfig.loginLinkResendCooldownSecs ?? 60;
    const cooldownKey = `auth:setup-link:cooldown:${userId}`;
    const cooldownTtl = await redis.ttl(cooldownKey);
    if (cooldownTtl > 0) {
      return `Please wait ${cooldownTtl}s before requesting another link.`;
    }

    // No active connections — generate a one-time setup link
    const token = await createAndStoreSetupLinkToken(
      redis,
      userId,
      authConfig.loginLinkTtlSecs,
    );

    // Apply cooldown after successful token creation
    await redis.set(cooldownKey, '1', 'EX', cooldownSecs);

    const setupUrl = makeSetupLinkUrl(token, authConfig.publicBaseUrl);
    const ttlMinutes = Math.round(authConfig.loginLinkTtlSecs / 60);

    const lines = [
      `🔗 Open this link to connect a platform for ${agent.name}:`,
      setupUrl.toString(),
      '',
      `This link logs you in automatically and opens the connection form.`,
      `Expires in ${ttlMinutes} minutes — do not share this link.`,
    ];
    if (hasInactiveNote) lines.push(hasInactiveNote);
    lines.push(
      '',
      `After creating the connection, use /connect ${agent.name} <id> to assign it to ${agent.name}.`,
    );
    return lines.join('\n');
  } catch (error) {
    console.error('handleConnectSetup failed:', error);
    return 'Failed to generate setup link. Please try again later.';
  }
}

// ── handleStart ───────────────────────────────────────────────────────────

export async function handleStart(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (!userId) return 'Please bind your Telegram account first.';
    if (args.length === 0) return 'Usage: /start <agent name>';

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }

    const result = await startAgent(db, resolved.agent.id, userId);

    if (result.ok) {
      return `Started ${resolved.agent.name}.`;
    }

    const err_ = result.error;
    if (err_.code === 'agent.not_found' || err_.code === 'agent.not_owned') {
      return `Agent "${args[0]}" not found.`;
    }
    if (err_.code === 'agent.invalid_status') {
      return `Cannot start ${resolved.agent.name} because it is ${err_.currentStatus}.`;
    }
    if (err_.code === 'agent.model_selection_incomplete') {
      return `Cannot start ${resolved.agent.name}: model selection is incomplete. Complete setup in the web app.`;
    }
    return `Failed to start ${resolved.agent.name}. Please try again.`;
  } catch (error) {
    console.error('handleStart failed:', error);
    return 'Failed to start agent. Please try again later.';
  }
}

// ── handlePause ───────────────────────────────────────────────────────────

export async function handlePause(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (!userId) return 'Please bind your Telegram account first.';
    if (args.length === 0) return 'Usage: /pause <agent name>';

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }

    const result = await pauseAgent(db, resolved.agent.id, userId);

    if (result.ok) {
      return `Paused ${resolved.agent.name}.`;
    }

    const err_ = result.error;
    if (err_.code === 'agent.not_found' || err_.code === 'agent.not_owned') {
      return `Agent "${args[0]}" not found.`;
    }
    if (err_.code === 'agent.invalid_status') {
      return `Cannot pause ${resolved.agent.name} because it is ${err_.currentStatus}.`;
    }
    return `Failed to pause ${resolved.agent.name}. Please try again.`;
  } catch (error) {
    console.error('handlePause failed:', error);
    return 'Failed to pause agent. Please try again later.';
  }
}

// ── handleResume ──────────────────────────────────────────────────────────

export async function handleResume(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (!userId) return 'Please bind your Telegram account first.';
    if (args.length === 0) return 'Usage: /resume <agent name>';

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }

    const result = await resumeAgent(db, resolved.agent.id, userId);

    if (result.ok) {
      return `Resumed ${resolved.agent.name}.`;
    }

    const err_ = result.error;
    if (err_.code === 'agent.not_found' || err_.code === 'agent.not_owned') {
      return `Agent "${args[0]}" not found.`;
    }
    if (err_.code === 'agent.invalid_status') {
      return `Cannot resume ${resolved.agent.name} because it is not paused. Current status: ${err_.currentStatus}.`;
    }
    return `Failed to resume ${resolved.agent.name}. Please try again.`;
  } catch (error) {
    console.error('handleResume failed:', error);
    return 'Failed to resume agent. Please try again later.';
  }
}

// ── handleStop ────────────────────────────────────────────────────────────

export async function handleStop(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (!userId) return 'Please bind your Telegram account first.';
    if (args.length === 0) return 'Usage: /stop <agent name>';

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }

    const result = await stopAgent(db, resolved.agent.id, userId);

    if (result.ok) {
      return `Stopped ${resolved.agent.name}.`;
    }

    const err_ = result.error;
    if (err_.code === 'agent.not_found' || err_.code === 'agent.not_owned') {
      return `Agent "${args[0]}" not found.`;
    }
    return `Failed to stop ${resolved.agent.name}. Please try again.`;
  } catch (error) {
    console.error('handleStop failed:', error);
    return 'Failed to stop agent. Please try again later.';
  }
}

// ── handleRestart ─────────────────────────────────────────────────────────

export async function handleRestart(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (!userId) return 'Please bind your Telegram account first.';
    if (args.length === 0) return 'Usage: /restart <agent name>';

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents.map((a) => `${a.name} (${a.id.slice(0, 8)}...)`).join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }

    const agent = resolved.agent;

    // Step 1: Stop
    const stopResult = await stopAgent(db, agent.id, userId);
    if (!stopResult.ok) {
      const err_ = stopResult.error;
      if (err_.code === 'agent.not_found' || err_.code === 'agent.not_owned') {
        return `Agent "${args[0]}" not found.`;
      }
      return `Failed to stop ${agent.name}. Please try again.`;
    }

    // Step 2: Poll for stopped status
    let settled = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const [row] = await db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, agent.id));
      if (row?.status === 'stopped') {
        settled = true;
        break;
      }
    }

    if (!settled) {
      return `Stopping ${agent.name}... still stopping. Check /status and try /start when ready.`;
    }

    // Step 3: Start
    const startResult = await startAgent(db, agent.id, userId);
    if (startResult.ok) {
      return `Started ${agent.name}.`;
    }

    const startErr = startResult.error;
    if (startErr.code === 'agent.model_selection_incomplete') {
      return `Cannot start ${agent.name}: model selection is incomplete. Complete setup in the web app.`;
    }
    if (startErr.code === 'agent.invalid_status') {
      return `Cannot start ${agent.name} because it is ${startErr.currentStatus}.`;
    }
    return `Failed to start ${agent.name}. Please try again.`;
  } catch (error) {
    console.error('handleRestart failed:', error);
    return 'Failed to restart agent. Please try again later.';
  }
}

// ── Connection resolution utility ────────────────────────────────────────

/**
 * Resolve a connection by ID or label for a given user.
 *
 * Resolution order:
 * 1. Exact UUID match on connections.id
 * 2. Case-insensitive exact match on connections.label
 * 3. Unique case-insensitive prefix match on connections.label (only if idOrLabel is >= 3 chars)
 */

type ConnectionRow = typeof connections.$inferSelect;

export async function resolveConnectionByIdOrLabel(
  db: Database,
  userId: string,
  idOrLabel: string,
): Promise<
  | { type: 'found'; connection: ConnectionRow }
  | { type: 'not_found' }
  | { type: 'ambiguous'; matches: ConnectionRow[] }
> {
  // 1. Try exact ID match
  const [byId] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, idOrLabel), eq(connections.userId, userId)))
    .limit(1);

  if (byId) {
    return { type: 'found', connection: byId };
  }

  // 2. Try case-insensitive label match
  const byLabel = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        sql`LOWER(${connections.label}) = LOWER(${idOrLabel})`,
      ),
    )
    .orderBy(connections.label);

  if (byLabel.length === 1) {
    return { type: 'found', connection: byLabel[0]! };
  }

  if (byLabel.length > 1) {
    return { type: 'ambiguous', matches: byLabel };
  }

  // 3. Try unique prefix match (only if idOrLabel >= 3 chars to avoid false positives)
  if (idOrLabel.length >= 3) {
    const escapedInput = idOrLabel.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const byPrefix = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.userId, userId),
          sql`LOWER(${connections.label}) LIKE LOWER(${`${escapedInput}%`})`,
        ),
      )
      .orderBy(connections.label);

    if (byPrefix.length === 1) {
      return { type: 'found', connection: byPrefix[0]! };
    }

    if (byPrefix.length > 1) {
      return { type: 'ambiguous', matches: byPrefix };
    }
  }

  return { type: 'not_found' };
}

// ── handleMode ────────────────────────────────────────────────────────────

export async function handleMode(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (args.length === 0) {
      return 'Usage: /mode <agent name> [test|live|paper|shadow]';
    }

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents
        .map((a) => `${a.name} (${a.id.slice(0, 8)}...)`)
        .join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }
    const agent = resolved.agent;

    // Read-only: show current execution mode
    if (args.length === 1) {
      const mode = agent.executionMode;
      if (mode === 'shadow') {
        return `${agent.name} execution mode: live (shadow)`;
      }
      // Map internal modes to display values
      const displayMode = mode === 'paper' ? 'test' : mode;
      if (displayMode && displayMode !== 'test') {
        return `${agent.name} execution mode: ${displayMode}`;
      }
      if (displayMode === 'test') {
        return `${agent.name} execution mode: test (simulated)`;
      }
      return `${agent.name} execution mode: not applicable`;
    }

    // Set mode
    const rawMode = args[1]!.toLowerCase();
    const validModes = ['test', 'live', 'paper', 'shadow'];
    if (!validModes.includes(rawMode)) {
      return `Invalid mode "${args[1]}". Use test, live, paper, or shadow.`;
    }

    // Normalize: paper/shadow → test, live → live
    const normalizedMode = rawMode === 'paper' || rawMode === 'shadow' ? 'test' : 'live';

    // Validate agent is stopped
    if (agent.status !== 'stopped') {
      return `Cannot change execution mode: ${agent.name} is ${agent.status}. Stop the agent first.`;
    }

    // Validate the agent has trading skills
    const skillRows = await db
      .select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agent.id));
    const skillIds = skillRows.map((r) => r.skillId);
    if (!hasSkillCapabilityFamily(skillIds, 'trading')) {
      return `Cannot set execution mode: ${agent.name} does not have trading skills.`;
    }

    const result = await setExecutionMode(db, agent.id, userId, normalizedMode);

    if (result.ok) {
      const displayMode = normalizedMode === 'test' ? 'test (simulated)' : 'live';
      return `${agent.name} execution mode set to ${displayMode}.`;
    }

    const err_ = result.error;
    if (err_.code === 'agent.not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    return `Failed to set execution mode for ${agent.name}. Please try again.`;
  } catch (error) {
    console.error('handleMode failed:', error);
    return 'Failed to set execution mode. Please try again later.';
  }
}

// ── handleConnect (with ID/label) ─────────────────────────────────────────

export async function handleConnect(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (args.length < 2) {
      return 'Usage: /connect <agent name> <connection ID or label>';
    }

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents
        .map((a) => `${a.name} (${a.id.slice(0, 8)}...)`)
        .join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }
    const agent = resolved.agent;

    // Agent must be stopped before modifying connections
    if (agent.status !== 'stopped') {
      return `Cannot change connections: ${agent.name} is ${agent.status}. Stop the agent first.`;
    }

    const idOrLabel = args[1]!;

    const connResolved = await resolveConnectionByIdOrLabel(db, userId, idOrLabel);

    if (connResolved.type === 'not_found') {
      return `Connection "${idOrLabel}" not found.`;
    }

    if (connResolved.type === 'ambiguous') {
      const lines = [
        `Multiple connections match "${idOrLabel}":`,
        ...connResolved.matches.map(
          (c) => `  ${c.id.slice(0, 8)}... — ${c.label}`,
        ),
        `Use the connection ID instead: /connect ${agent.name} ${connResolved.matches[0]!.id}`,
      ];
      return lines.join('\n');
    }

    const result = await grantConnection(db, agent.id, connResolved.connection.id, userId);

    if (result.ok) {
      return `Connection granted to ${agent.name}.`;
    }

    const err_ = result.error;
    if (err_.code === 'agent.not_found' || err_.code === 'agent.not_owned') {
      return `Agent "${args[0]}" not found.`;
    }
    if (err_.code === 'agent.not_stopped') {
      return `Cannot change connections: ${agent.name} is ${err_.currentStatus}. Stop the agent first.`;
    }
    if (err_.code === 'connection.not_found') {
      return `Connection "${idOrLabel}" not found.`;
    }
    if (err_.code === 'connection.not_owned') {
      return `Connection "${idOrLabel}" does not belong to you.`;
    }
    if (err_.code === 'connection.not_active') {
      return `Connection "${idOrLabel}" is not active. Activate it first in the web app.`;
    }
    return `Failed to grant connection to ${agent.name}. Please try again.`;
  } catch (error) {
    console.error('handleConnect failed:', error);
    return 'Failed to grant connection. Please try again later.';
  }
}

// ── handleDisconnect ──────────────────────────────────────────────────────

export async function handleDisconnect(
  db: Database,
  userId: string,
  args: string[],
): Promise<string> {
  try {
    if (args.length < 2) {
      return 'Usage: /disconnect <agent name> <connection ID or label>';
    }

    const resolved = await resolveAgentByName(db, userId, args[0]!);
    if (resolved.type === 'not_found') {
      return `Agent "${args[0]}" not found.`;
    }
    if (resolved.type === 'ambiguous') {
      const names = resolved.agents
        .map((a) => `${a.name} (${a.id.slice(0, 8)}...)`)
        .join(', ');
      return `Multiple agents named "${args[0]}". Use a unique name or check the web app.\nMatches: ${names}`;
    }
    const agent = resolved.agent;

    // Agent must be stopped before modifying connections
    if (agent.status !== 'stopped') {
      return `Cannot change connections: ${agent.name} is ${agent.status}. Stop the agent first.`;
    }

    const idOrLabel = args[1]!;

    const connResolved = await resolveConnectionByIdOrLabel(db, userId, idOrLabel);

    if (connResolved.type === 'not_found') {
      return `Connection "${idOrLabel}" not found.`;
    }

    if (connResolved.type === 'ambiguous') {
      const lines = [
        `Multiple connections match "${idOrLabel}":`,
        ...connResolved.matches.map(
          (c) => `  ${c.id.slice(0, 8)}... — ${c.label}`,
        ),
        `Use the connection ID instead: /disconnect ${agent.name} ${connResolved.matches[0]!.id}`,
      ];
      return lines.join('\n');
    }

    const result = await revokeConnection(db, agent.id, connResolved.connection.id, userId);

    if (result.ok) {
      return `Connection revoked from ${agent.name}.`;
    }

    const err_ = result.error;
    if (err_.code === 'agent.not_found' || err_.code === 'agent.not_owned') {
      return `Agent "${args[0]}" not found.`;
    }
    if (err_.code === 'agent.not_stopped') {
      return `Cannot change connections: ${agent.name} is ${err_.currentStatus}. Stop the agent first.`;
    }
    if (err_.code === 'connection.not_found') {
      return `Connection "${idOrLabel}" not found.`;
    }
    if (err_.code === 'connection.not_owned') {
      return `Connection "${idOrLabel}" does not belong to you.`;
    }
    return `Failed to revoke connection from ${agent.name}. Please try again.`;
  } catch (error) {
    console.error('handleDisconnect failed:', error);
    return 'Failed to revoke connection. Please try again later.';
  }
}
