import { createLogger } from '../logger.js';
import { callLlmWithRetry } from '../runtime-errors.js';
import { stripReasoningContent, type LlmProviderConfig, type LlmRequest } from '@herobids/llm';
import type { EvaluationArtifactStore } from '@herobids/domain';
import type { ResolvedNarrativeLlmConfig } from '@herobids/db';

const logger = createLogger('generate-narrative');

// ── Public types ────────────────────────────────────────────────────────────

export interface NarrativeGenerationResult {
  /** The generated narrative text (null if generation failed) */
  text: string | null;
  /** Metadata for provenance — always present, even on failure */
  metadata: NarrativeGenerationMetadata;
}

export interface NarrativeGenerationMetadata {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrlUsed?: string;
  tokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  generated: boolean;
  error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function baseMetadata(config: ResolvedNarrativeLlmConfig): NarrativeGenerationMetadata {
  return {
    enabled: true,
    provider: config.provider,
    model: config.model,
    baseUrlUsed: config.baseUrl,
    tokensUsed: 0,
    latencyMs: 0,
    generated: false,
  };
}

async function readJsonArtifact(store: EvaluationArtifactStore, runId: string, name: string): Promise<unknown> {
  const data = await store.read(runId, name);
  if (!data) return null;
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
}

async function readTextArtifact(store: EvaluationArtifactStore, runId: string, name: string): Promise<string | null> {
  const data = await store.read(runId, name);
  if (!data) return null;
  return new TextDecoder().decode(data);
}

// ── Per-artifact summarizers ───────────────────────────────────────────────

const MAX_ARTIFACT_CHARS = 8_000;
const CONTAINER_LOGS_TAIL_CHARS = 2_000;

function summarizeJournal(journal: unknown): string {
  if (!Array.isArray(journal) || journal.length === 0) {
    return 'No journal events recorded.';
  }

  const events = journal as Array<Record<string, unknown>>;
  const totalEvents = events.length;

  // Group by event type prefix (e.g. "agent.tick.skipped" → "agent.tick")
  const typeCounts = new Map<string, number>();
  for (const e of events) {
    const type = typeof e['type'] === 'string' ? e['type'] : 'unknown';
    const prefix = type.split('.').slice(0, 2).join('.');
    typeCounts.set(prefix, (typeCounts.get(prefix) ?? 0) + 1);
  }

  const sortedTypes = [...typeCounts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `  - ${type}: ${count}`);

  // Extract error-level events (level >= 50 or type contains "error"/"failure")
  const errorEvents = events.filter((e) => {
    const level = e['level'];
    const type = typeof e['type'] === 'string' ? e['type'] : '';
    return (typeof level === 'number' && level >= 50) || type.includes('error') || type.includes('failure');
  });

  let errorSection = '';
  if (errorEvents.length > 0) {
    const errorLines = errorEvents.slice(0, 10).map((e) => {
      const msg = typeof e['msg'] === 'string' ? e['msg'] : '';
      const error = e['error'] ?? e['err'];
      const errorStr = typeof error === 'string' ? error : error ? JSON.stringify(error).slice(0, 200) : '';
      return `  - [${e['type']}] ${msg}${errorStr ? ` — ${errorStr}` : ''}`;
    });
    errorSection = `\nError events (${errorEvents.length} total, showing first 10):\n${errorLines.join('\n')}`;
  }

  // Recent events sample (last 5)
  const recent = events.slice(-5).map((e) => {
    const type = e['type'] ?? 'unknown';
    const msg = typeof e['msg'] === 'string' ? e['msg'] : '';
    return `  - [${type}] ${msg}`;
  });

  return [
    `Total events: ${totalEvents}`,
    `By type prefix:`,
    ...sortedTypes,
    `\nMost recent events:`,
    ...recent,
    errorSection,
  ].join('\n');
}

function summarizeContainerLogs(raw: string | null): string {
  if (!raw) return 'Container logs not available.';
  if (raw.length <= CONTAINER_LOGS_TAIL_CHARS) {
    return `Container logs (${raw.length} chars):\n${raw}`;
  }
  return `Container logs (last ${CONTAINER_LOGS_TAIL_CHARS} of ${raw.length} chars):\n...\n${raw.slice(-CONTAINER_LOGS_TAIL_CHARS)}`;
}

function summarizeRedisSnapshot(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return 'Redis snapshot not available.';
  const allKeys = Object.keys(snapshot as Record<string, unknown>);
  if (allKeys.length === 0) return 'Redis snapshot empty.';

  // High-signal keys shown in full: agent memory (retry loops, error patterns),
  // watches (coverage gaps, stale checks), and prompts (capability surface).
  // Stream keys are noted but not expanded — their values are opaque channel refs.
  const HIGH_SIGNAL = ['agent:memory:', 'agent:watches:', 'agent:prompt:'];
  const MEDIUM_SIGNAL = ['agent:wake:prefs:', 'agent:watches:summary:', 'rate-limit:', 'reminder:', 'session:'];
  const STREAM = ['agent:inbound:', 'agent:outbound:'];

  const snapshotObj = snapshot as Record<string, unknown>;

  const highSignal = allKeys.filter((k) => HIGH_SIGNAL.some((p) => k.startsWith(p)));
  const mediumSignal = allKeys.filter((k) => MEDIUM_SIGNAL.some((p) => k.startsWith(p)));
  const streamKeys = allKeys.filter((k) => STREAM.some((p) => k.startsWith(p)));
  const other = allKeys.length - highSignal.length - mediumSignal.length - streamKeys.length;

  const formatValue = (k: string, maxChars: number): string => {
    const val = snapshotObj[k];
    if (typeof val === 'string') {
      return val.length <= maxChars ? val : val.slice(0, maxChars) + '...';
    }
    const json = JSON.stringify(val);
    return json.length <= maxChars ? json : json.slice(0, maxChars) + '...';
  };

  const lines: string[] = [];

  if (highSignal.length > 0) {
    lines.push('### Agent State (high signal)');
    for (const k of highSignal) {
      lines.push(`  ${k}:`);
      lines.push(`    ${formatValue(k, k.startsWith('agent:memory:') ? 2000 : 500)}`);
    }
    lines.push('');
  }

  if (streamKeys.length > 0) {
    lines.push(`### Stream channels: ${streamKeys.length} key(s) — connection state omitted (opaque channel refs)`);
    lines.push('');
  }

  if (mediumSignal.length > 0) {
    lines.push('### Operational state');
    for (const k of mediumSignal) {
      lines.push(`  ${k}: ${formatValue(k, 200)}`);
    }
    lines.push('');
  }

  lines.unshift(`Total keys: ${allKeys.length} (high-signal: ${highSignal.length}, operational: ${mediumSignal.length}, streams: ${streamKeys.length}${other > 0 ? `, other: ${other}` : ''})`);

  return lines.filter((l) => l !== '' || lines.indexOf(l) === lines.length - 1 || lines[lines.indexOf(l) + 1] !== '').join('\n');
}

function truncateIfNeeded(text: string): string {
  if (text.length <= MAX_ARTIFACT_CHARS) return text;
  return text.slice(0, MAX_ARTIFACT_CHARS) + `\n\n[... truncated from ${text.length} chars for length ...]`;
}

// ── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Build a narrative prompt from raw evaluation evidence.
 * Reads artifacts directly from the store so the LLM forms an independent opinion
 * rather than paraphrasing the deterministic scorecard.
 */
async function buildEvidenceNarrativePrompt(
  store: EvaluationArtifactStore,
  runId: string,
): Promise<string> {
  // Read all evidence artifacts
  const [agentMeta, sessions, fills, positions, costs, journal, containerLogs, redisSnapshot] = await Promise.all([
    readJsonArtifact(store, runId, 'agent-metadata.json'),
    readJsonArtifact(store, runId, 'sessions.json'),
    readJsonArtifact(store, runId, 'fills.json'),
    readJsonArtifact(store, runId, 'positions.json'),
    readJsonArtifact(store, runId, 'costs.json'),
    readJsonArtifact(store, runId, 'journal.json'),
    readTextArtifact(store, runId, 'container-logs.txt'),
    readJsonArtifact(store, runId, 'redis-snapshot.json'),
  ]);

  const agentMetaStr = agentMeta
    ? truncateIfNeeded(JSON.stringify(agentMeta, null, 2))
    : 'Not available.';

  const sessionsStr = sessions
    ? truncateIfNeeded(JSON.stringify(sessions, null, 2))
    : 'Not available.';

  const fillsStr = fills
    ? truncateIfNeeded(JSON.stringify(fills, null, 2))
    : 'Not available.';

  const positionsStr = positions
    ? truncateIfNeeded(JSON.stringify(positions, null, 2))
    : 'Not available.';

  const costsStr = costs
    ? truncateIfNeeded(JSON.stringify(costs, null, 2))
    : 'Not available.';

  const journalSummary = summarizeJournal(journal);
  const containerLogsSummary = summarizeContainerLogs(containerLogs);
  const redisSummary = summarizeRedisSnapshot(redisSnapshot);

  return `You are an expert trading system auditor. Review the following raw evidence from an agent evaluation session and provide your independent assessment.

## Agent Metadata
${agentMetaStr}

## Sessions
${sessionsStr}

## Trading Activity
### Fills
${fillsStr}
### Positions
${positionsStr}

## Journal Summary
${journalSummary}

## Cost Data
${costsStr}

## Container Logs
${containerLogsSummary}

## Redis Snapshot
${redisSummary}

---

Provide a commentary in Markdown format. Be direct and actionable. Do NOT use headings, lists, or code blocks — just plain paragraph text. Do NOT preface with "Here is the commentary" or similar.

Consider:
- What prompted any trading decisions? Wake signals, tool call results, or other triggers?
- How often did the scout hold vs escalate to the judge?
- Are there anomalies? For example: stuck trades, missing lifecycle events, rate-limit hits, restrictions being bypassed?
- Is market data flowing? Any fetch failures or degraded providers?
- Are there unexpected errors for example in container, redis, fills etc.?
- Does agent memory record repeated tool failures, error messages, or retry loops?
- Are protective watches (stop_loss/take_profit) properly linked to their target position, or is the agent struggling with coverage attachment?
- Is there evidence of a platform-side bug preventing the agent from completing a task?
- What improvement/improvements could have the biggest impact?`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate LLM-powered evaluation narrative commentary from raw evidence.
 *
 * Best-effort: returns metadata on any failure so the evaluation can succeed
 * with the deterministic report alone.
 *
 * Reads evidence artifacts directly from the store so the LLM forms an
 * independent opinion rather than paraphrasing the deterministic scorecard.
 */
export async function generateEvaluationNarrative(
  narrativeConfig: ResolvedNarrativeLlmConfig,
  store: EvaluationArtifactStore,
  runId: string,
): Promise<NarrativeGenerationResult> {
  const meta = baseMetadata(narrativeConfig);

  const llmConfig: LlmProviderConfig = {
    provider: narrativeConfig.provider,
    model: narrativeConfig.model,
    maxTokens: narrativeConfig.maxTokens,
    timeoutMs: narrativeConfig.timeoutMs,
    baseUrl: narrativeConfig.baseUrl,
    openRouterProviderControls: narrativeConfig.openRouterProviderControls,
  };

  let prompt: string;
  try {
    prompt = await buildEvidenceNarrativePrompt(store, runId);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.warn({ err: message }, 'Could not build evidence narrative prompt — skipping commentary');
    meta.error = message;
    return { text: null, metadata: meta };
  }

  const request: LlmRequest = {
    messages: [
      { role: 'user', content: prompt },
    ],
    maxTokens: narrativeConfig.maxTokens,
    temperature: 0,
    toolChoice: 'none',
  };

  try {
    logger.info(
      { provider: narrativeConfig.provider, model: narrativeConfig.model },
      'Calling LLM for evaluation narrative',
    );

    const { result } = await callLlmWithRetry(llmConfig, request, {
      maxRetries: 1,
      timeoutBackoffMs: [5_000],
    });

    if (!result.ok) {
      logger.warn(
        { error: result.error },
        'Narrative LLM call failed — continuing without commentary',
      );
      meta.error = result.error.message;
      return { text: null, metadata: meta };
    }

    const narrative = stripReasoningContent(result.data.content).trim();
    if (!narrative) {
      logger.warn('Narrative LLM returned empty content');
      meta.error = 'LLM returned empty content';
      return { text: null, metadata: meta };
    }

    meta.provider = result.data.provider;
    meta.model = result.data.model;
    meta.tokensUsed = result.data.tokensUsed;
    meta.inputTokens = result.data.inputTokens;
    meta.outputTokens = result.data.outputTokens;
    meta.latencyMs = result.data.latencyMs;
    meta.generated = true;

    logger.info(
      {
        provider: meta.provider,
        model: meta.model,
        tokensUsed: meta.tokensUsed,
        latencyMs: meta.latencyMs,
      },
      'Narrative generated successfully',
    );

    return { text: narrative, metadata: meta };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.warn(
      { err: message },
      'Narrative generation threw — continuing without commentary',
    );
    meta.error = message;
    return { text: null, metadata: meta };
  }
}
