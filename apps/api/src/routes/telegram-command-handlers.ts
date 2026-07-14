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
import { listAgentConnections } from '../services/agent-config-service.js';
import {
  makeSetupLinkUrl,
  createAndStoreSetupLinkToken,
} from '../services/setup-link-token-service.js';

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
      `After creating the connection, use the web app to assign this connection for now. /connect <agent> <id> will be available soon.`,
    );
    return lines.join('\n');
  } catch (error) {
    console.error('handleConnectSetup failed:', error);
    return 'Failed to generate setup link. Please try again later.';
  }
}
