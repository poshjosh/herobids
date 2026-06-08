/**
 * Agent container entry point.
 *
 * This module runs inside the per-agent Docker container.
 * It reads config from environment variables, connects to Redis Streams,
 * and runs the agent reasoning loop.
 *
 * Does NOT import trading-actor, BullMQ worker, or bot execution code.
 */

import Redis from 'ioredis';
import crypto from 'node:crypto';
import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import { AGENT_MESSAGE_TYPES, BASE_SKILL, BOT_MANAGEMENT_SKILL, RISK_MONITORING_SKILL } from '@herobids/domain';
import type { RuntimeDescriptor, SkillDefinition } from '@herobids/domain';
import { callLlmProvider } from '@herobids/llm';
import { buildCapabilityGrants, buildCapabilityPolicyEngine } from './agents/capability-policy.js';
import { SandboxEnforcer } from './agents/sandbox-enforcer.js';
import {
  buildSystemPrompt as composeSystemPrompt,
  buildTickUserContext,
  createRuntimeCompositionState,
  getVisibleToolNames,
  type RuntimeCompositionState,
} from './runtime-composition.js';

const execFileAsync = promisify(execFileCb);

const logger = pino({ name: 'agent-runtime', level: process.env['LOG_LEVEL'] ?? 'info' });

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const AGENT_ID = process.env['AGENT_ID'];
const SESSION_ID = process.env['SESSION_ID'];
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const AGENT_CONFIG_RAW = process.env['AGENT_CONFIG'] ?? '{}';
// TOOL_POLICY is forwarded into the container and enforced here for direct-tier tools.
// Brokered tools are also enforced by the broker, but the container adds a second gate.
const TOOL_POLICY_RAW = process.env['TOOL_POLICY'] ?? '{}';
const LLM_MODEL = process.env['LLM_MODEL'] ?? 'claude-sonnet-4-5';
const LLM_PROVIDER = process.env['LLM_PROVIDER'];
const LLM_BASE_URL = process.env['LLM_BASE_URL'];
const LLM_MAX_TOKENS = parseInt(process.env['LLM_MAX_TOKENS'] ?? '4096', 10);
const LLM_TIMEOUT_MS = parseInt(process.env['LLM_TIMEOUT_MS'] ?? '60000', 10);
const TICK_INTERVAL_MS = parseInt(process.env['TICK_INTERVAL_MS'] ?? '900000', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '5000', 10);
// 0 = unlimited (the default). Set to a positive number of milliseconds to impose
// a hard wall-clock cap on any single agent session.
const SANDBOX_MAX_WALL_CLOCK_MS = parseInt(process.env['SANDBOX_MAX_WALL_CLOCK_MS'] ?? '0', 10);

if (!AGENT_ID || !SESSION_ID) {
  logger.fatal({ AGENT_ID, SESSION_ID }, 'AGENT_ID and SESSION_ID env vars are required');
  process.exit(1);
}

if (!LLM_PROVIDER) {
  logger.fatal('LLM_PROVIDER env var is required');
  process.exit(1);
}

const LLM_API_KEY_RESOLVED =
  process.env[`LLM_API_KEY_${LLM_PROVIDER.toUpperCase()}`] ||
  process.env['LLM_API_KEY'];
// Local providers (e.g. Ollama) don't need an API key when LLM_BASE_URL is set.
if (!LLM_API_KEY_RESOLVED && !LLM_BASE_URL) {
  logger.fatal({ provider: LLM_PROVIDER }, 'No API key found for LLM provider — set LLM_API_KEY or LLM_API_KEY_<PROVIDER>');
  process.exit(1);
}

interface AgentConfig {
  prompt?: string;
  goal?: string;
  skillIds?: string[];
  executionMode?: string;
  dailyTokenBudget?: number;
  dailyLossLimit?: string;
  maxBots?: number;
  maxSlippageBps?: number;
  telegramChatId?: string;
  runtimeDescriptor?: RuntimeDescriptor;
}

let agentConfig: AgentConfig;
function parseToolPolicy(rawPolicy: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawPolicy) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    logger.warn('Failed to parse TOOL_POLICY — using defaults');
  }
  return {};
}

// SandboxEnforcer enforces the session wall-clock limit in-process. All other
// sandbox limits (network, download) require hooking the network layer inside
// the container process and are enforced by the container runtime (cgroups/ulimits).
const sandboxEnforcer = new SandboxEnforcer({ maxWallClockMs: SANDBOX_MAX_WALL_CLOCK_MS });

try {
  agentConfig = JSON.parse(AGENT_CONFIG_RAW) as AgentConfig;
} catch {
  logger.fatal({ AGENT_CONFIG_RAW }, 'Failed to parse AGENT_CONFIG');
  process.exit(1);
}

const agentGoal = agentConfig.prompt ?? agentConfig.goal ?? 'No goal provided';
const skillIds = agentConfig.skillIds ?? [];
const initialToolPolicy = agentConfig.runtimeDescriptor?.toolPolicy ?? parseToolPolicy(TOOL_POLICY_RAW);

// ---------------------------------------------------------------------------
// Skill resolution
// ---------------------------------------------------------------------------

const ALL_SKILLS_BY_ID: Record<string, SkillDefinition> = {
  base: BASE_SKILL,
  'bot-management': BOT_MANAGEMENT_SKILL,
  'risk-monitoring': RISK_MONITORING_SKILL,
};

function resolveSkills(ids: string[]): SkillDefinition[] {
  return ids
    .map((id) => ALL_SKILLS_BY_ID[id])
    .filter((s): s is SkillDefinition => s !== undefined);
}

const activeSkills = resolveSkills(skillIds);
// Base skill is always injected at runtime
const allActiveSkills = [BASE_SKILL, ...activeSkills];

function buildFallbackRuntimeDescriptor(): RuntimeDescriptor {
  const resolvedSkills = allActiveSkills.map((skill) => ({
    ...skill,
    capabilityFamilies: skill.id === 'bot-management' || skill.id === 'risk-monitoring' ? ['trading'] : [],
    bindingRequirements: (skill.id === 'bot-management' || skill.id === 'risk-monitoring'
      ? { trading: { minBindings: 1, requireReady: true } }
      : {}) as Record<string, { minBindings: number; requireReady: boolean }>,
    requiredContextBlocks: skill.id === 'bot-management' || skill.id === 'risk-monitoring'
      ? ['corePlatformContext', 'tradingContext']
      : ['corePlatformContext'],
    promptRendererHints: skill.id === 'bot-management' || skill.id === 'risk-monitoring'
      ? ['readiness-summary', 'trading']
      : ['core-system'],
  })) as SkillDefinition[];

  return {
    schemaVersion: 'v1',
    agentId: AGENT_ID!,
    goal: agentGoal,
    executionMode: agentConfig.executionMode ?? 'paper',
    resolvedSkills,
    grantedBindingsByFamily: {},
    defaultBindingByFamily: {},
    readinessByFamily: {},
    toolPolicy: initialToolPolicy,
    guardrails: {
      dailyTokenBudget: agentConfig.dailyTokenBudget ?? null,
      dailyLossLimit: agentConfig.dailyLossLimit ?? null,
      maxBots: agentConfig.maxBots ?? null,
      maxSlippageBps: agentConfig.maxSlippageBps ?? null,
    },
    budgets: {
      maxHistoryMessages: 20,
      maxRecentToolMessages: 6,
      maxToolResultChars: 4_000,
      maxVisibleToolSchemas: 16,
      maxContextBlockChars: 4_000,
    },
  };
}

const runtimeDescriptor = agentConfig.runtimeDescriptor ?? buildFallbackRuntimeDescriptor();
const runtimeState: RuntimeCompositionState = createRuntimeCompositionState(runtimeDescriptor);
const sessionMetrics = runtimeState.metrics;
let capabilityEngine = buildCapabilityPolicyEngine(runtimeState.runtimeDescriptor.toolPolicy);

// The runtime-authorised tool set is derived from the active runtime descriptor.
// It is re-evaluated on each tick so refresh messages can tighten or expand access.
function allowedTools(): Set<string> {
  return new Set(getVisibleToolNames(runtimeState));
}

function refreshCapabilityPolicy(): void {
  capabilityEngine.replaceGrants(buildCapabilityGrants(runtimeState.runtimeDescriptor.toolPolicy));
}

// ---------------------------------------------------------------------------
// Redis Streams transport
// ---------------------------------------------------------------------------

const parsedRedisUrl = new URL(REDIS_URL);
const redis = new Redis({
  host: parsedRedisUrl.hostname || 'localhost',
  port: parseInt(parsedRedisUrl.port || '6379', 10),
  ...(parsedRedisUrl.password && { password: decodeURIComponent(parsedRedisUrl.password) }),
  ...(parsedRedisUrl.protocol === 'rediss:' && { tls: {} }),
  lazyConnect: false,
  maxRetriesPerRequest: 3,
});

const INBOUND_STREAM = `agent:inbound:${AGENT_ID}`;
const OUTBOUND_STREAM = `agent:outbound:${AGENT_ID}`;
const CONSUMER_GROUP = 'agent-runtime';
const CONSUMER_NAME = `agent-${AGENT_ID}-${process.pid}`;

async function publishToInbound(type: string, payload: Record<string, unknown>): Promise<void> {
  const envelope = {
    schemaVersion: 'v1',
    messageId: crypto.randomUUID(),
    correlationId: SESSION_ID!,
    initiatorType: 'agent',
    initiatorId: AGENT_ID!,
    agentId: AGENT_ID!,
    type,
    createdAt: new Date().toISOString(),
    payload,
  };
  await redis.xadd(INBOUND_STREAM, '*', 'envelope', JSON.stringify(envelope));
}

async function sendHeartbeat(status: 'starting' | 'ready' | 'busy' | 'degraded'): Promise<void> {
  try {
    await publishToInbound(AGENT_MESSAGE_TYPES.RUNTIME_HEARTBEAT, {
      sessionId: SESSION_ID!,
      status,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to send heartbeat');
  }
}

// At startup, claim any entries in the PEL that were delivered to a previous
// container incarnation (different PID → different consumer name) but never
// acknowledged before that container died. We steal entries idle > 30 s and
// ACK them immediately. The agent will receive fresh context on its first tick;
// stale snapshots / feedback from the previous run do not need to be replayed.
async function drainStalePendingEntries(): Promise<void> {
  const IDLE_THRESHOLD_MS = 30_000;
  let cursor = '0-0';
  let recovered = 0;

  // Ensure the group exists before claiming.
  await redis.xgroup('CREATE', OUTBOUND_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM').catch((err: unknown) => {
    if (err instanceof Error && !err.message.includes('BUSYGROUP')) throw err;
  });

  for (;;) {
    const result = await redis.xautoclaim(
      OUTBOUND_STREAM, CONSUMER_GROUP, CONSUMER_NAME,
      IDLE_THRESHOLD_MS, cursor, 'COUNT', 100,
    ) as [string, Array<[string, string[]]>, string[]];

    const [nextCursor, entries] = result;

    for (const [msgId] of entries) {
      await redis.xack(OUTBOUND_STREAM, CONSUMER_GROUP, msgId).catch(() => { /* ignore */ });
      recovered++;
    }

    if (nextCursor === '0-0') break;
    cursor = nextCursor;
  }

  if (recovered > 0) {
    logger.warn({ recovered }, 'ACKed stale pending entries from previous container incarnation');
  }
}

// Read pending messages from the outbound stream (platform → agent)
async function readOutboundMessages(): Promise<Array<Record<string, unknown>>> {
  try {
    // Create group if not exists. Use '0' (oldest message) so any messages the platform
    // published before the container's first read (e.g. initial context snapshot) are not lost.
    await redis.xgroup('CREATE', OUTBOUND_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM').catch((err: unknown) => {
      if (err instanceof Error && !err.message.includes('BUSYGROUP')) throw err;
    });

    const result = await redis.xreadgroup(
      'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
      'COUNT', '10',
      'BLOCK', '0',
      'STREAMS', OUTBOUND_STREAM, '>',
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result) return [];

    const messages: Array<Record<string, unknown>> = [];
    for (const [, entries] of result) {
      for (const [msgId, fields] of entries) {
        const envelopeIdx = fields.indexOf('envelope');
        if (envelopeIdx >= 0 && fields[envelopeIdx + 1]) {
          try {
            const envelope = JSON.parse(fields[envelopeIdx + 1]!) as Record<string, unknown>;
            messages.push(envelope);
          } catch {
            // Skip malformed
          }
        }
        // Acknowledge the message
        await redis.xack(OUTBOUND_STREAM, CONSUMER_GROUP, msgId).catch(() => { /* ignore */ });
      }
    }
    return messages;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

function parseToolCalls(llmResponse: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let i = 0;

  // Depth-tracking scanner: handles nested objects inside `args` that the old
  // flat regex /[^{}]/ could not match (e.g. create_bot's config sub-object).
  while (i < llmResponse.length) {
    const start = llmResponse.indexOf('{', i);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let j = start; j < llmResponse.length; j++) {
      const ch = llmResponse[j]!;
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }

    if (end === -1) break; // Unclosed brace — stop scanning

    const candidate = llmResponse.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate) as { tool?: string; args?: Record<string, unknown> };
      if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
        calls.push({ tool: parsed.tool, args: parsed.args });
      }
    } catch {
      // Not a valid JSON object or not a tool call — skip
    }

    i = end + 1;
  }

  return calls;
}

async function executeTool(call: ToolCall): Promise<void> {
  // Hard runtime gate: reject any tool not declared in the active skill set.
  // The model was only told about allowed tools, but we enforce it here too so
  // a jailbreak or prompt injection cannot invoke undeclared capabilities.
  if (!allowedTools().has(call.tool)) {
    logger.warn({ tool: call.tool, agentId: AGENT_ID }, 'Tool not in active skill set — ignoring');
    return;
  }

  logger.info({ tool: call.tool, args: call.args }, 'Executing tool');

  switch (call.tool) {
    case 'send_message': {
      await publishToInbound(AGENT_MESSAGE_TYPES.SEND_MESSAGE, {
        body: call.args['body'] as string ?? 'No message body',
        subject: call.args['subject'] as string | undefined,
      });
      break;
    }

    case 'set_memory': {
      const key = call.args['key'];
      const value = call.args['value'];
      if (typeof key === 'string' && key.length > 0 && value !== undefined) {
        await redis.hset(`agent:memory:${AGENT_ID}`, key, JSON.stringify(value));
        logger.debug({ key }, 'Memory entry set');
      }
      break;
    }

    case 'artifact_publish': {
      await publishToInbound(AGENT_MESSAGE_TYPES.ARTIFACT_PUBLISH, {
        artifactId: crypto.randomUUID(),
        artifactType: call.args['artifactType'] as string ?? 'text',
        contentType: call.args['contentType'] as string ?? 'text/plain',
        summary: call.args['summary'] as string ?? '',
        location: call.args['location'],
        metadata: call.args['metadata'],
      });
      break;
    }

    case 'decision_submit': {
      sessionMetrics.decisionsSubmitted++;
      await publishToInbound(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, {
        decisionId: crypto.randomUUID(),
        instrumentId: call.args['instrumentId'] as string ?? '',
        intent: call.args['intent'] as string ?? 'go_flat',
        targetSize: call.args['targetSize'] as string ?? '0',
        limitPrice: call.args['limitPrice'] as string | undefined,
        rationaleSummary: call.args['rationaleSummary'] as string ?? 'Agent decision',
        confidence: call.args['confidence'] as number | undefined,
      });
      break;
    }

    case 'create_bot': {
      await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        venueAccountId: call.args['venueAccountId'] as string | undefined,
        config: call.args['config'] as Record<string, unknown> | undefined,
        rationale: call.args['rationale'] as string | undefined,
      });
      break;
    }

    case 'code_execute': {
      // Enforce capability policy before executing — rate limit, concurrency, and enable/disable.
      const policyDenied = capabilityEngine.checkAccess('code_execute', AGENT_ID!, SESSION_ID!);
      if (policyDenied) {
        addToHistory('user', `code_execute denied by capability policy: ${policyDenied}`);
        logger.warn({ agentId: AGENT_ID, reason: policyDenied }, 'code_execute denied by capability policy');
        break;
      }
      capabilityEngine.recordStart('code_execute', SESSION_ID!);
      const codeStartMs = Date.now();
      let codeSuccess = false;

      // Code execution runs locally inside this container — no broker round-trip needed.
      // In Docker mode, sandbox-exec.sh provides network namespace isolation (blocks RFC 1918,
      // allows public internet, uses public DNS). Falls back to direct node in stub/dev mode.
      const code = call.args['code'] as string ?? '';
      const description = call.args['description'] as string | undefined;
      const SANDBOX_SCRIPT = '/usr/local/bin/sandbox-exec.sh';
      const SANDBOX_DIR = '/tmp/agent-sandbox';
      const scriptPath = `${SANDBOX_DIR}/script.js`;
      // Read limits from the effective capability grant so operator/user policy changes
      // govern execution timeout and output size, not just rate/concurrency.
      const codeGrant = capabilityEngine.getGrant('code_execute');
      const TIMEOUT_MS = codeGrant?.limits?.timeoutMs ?? 60_000;
      const MAX_OUTPUT = codeGrant?.limits?.maxResponseBytes ?? (50 * 1024);

      let stdout = '';
      let stderr = '';
      let success = false;

      try {
        await rm(SANDBOX_DIR, { recursive: true, force: true });
        await mkdir(SANDBOX_DIR, { recursive: true });
        await writeFile(scriptPath, code, 'utf8');

        const hasSandbox = await access(SANDBOX_SCRIPT).then(() => true).catch(() => false);
        let sandboxBin: string;
        let sandboxArgs: string[];
        if (hasSandbox) {
          // sandbox-exec.sh passes $@ to `exec ip netns exec <ns> "$@"`,
          // so args become the full command inside the namespace.
          sandboxBin = SANDBOX_SCRIPT;
          sandboxArgs = ['node', scriptPath];
        } else {
          sandboxBin = 'node';
          sandboxArgs = [scriptPath];
        }

        const result = await execFileAsync(sandboxBin, sandboxArgs, {
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT * 2,
          env: hasSandbox
            ? { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TIMEOUT: String(Math.ceil(TIMEOUT_MS / 1000)) }
            : process.env,
        });
        stdout = String(result.stdout || '').slice(0, MAX_OUTPUT);
        success = true;
        codeSuccess = true;
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        stdout = String(execErr.stdout || '').slice(0, MAX_OUTPUT);
        stderr = String(execErr.stderr || execErr.message || 'execution failed').slice(0, 10 * 1024);
      } finally {
        capabilityEngine.recordEnd('code_execute', SESSION_ID!, {
          capability: 'code_execute',
          agentId: AGENT_ID!,
          sessionId: SESSION_ID!,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - codeStartMs,
          inputSummary: `${code.length} bytes`,
          outputSummary: success ? `${stdout.length} bytes` : `error: ${stderr.slice(0, 100)}`,
          success: codeSuccess,
        });
        // Per-execution stdout is already bounded by MAX_OUTPUT (derived from
        // the capability grant's maxResponseBytes). Session-level download budget
        // enforcement would require hooking the network layer inside the sandbox
        // process — out of scope for the in-process SandboxEnforcer.
      }

      const label = description ? ` (${description})` : '';
      const resultContent = success
        ? `code_execute${label} result:\n${stdout || '(no output)'}`
        : `code_execute${label} failed:\nstderr: ${stderr}\nstdout: ${stdout || '(no output)'}`;
      addToHistory('user', resultContent);
      break;
    }

    default:
      logger.warn({ tool: call.tool }, 'Unknown tool — ignoring');
  }
}

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const conversationHistory: ConversationMessage[] = [];

function addToHistory(role: 'user' | 'assistant', content: string): void {
  conversationHistory.push({ role, content });
  // Keep only the most recent messages
  while (conversationHistory.length > runtimeState.runtimeDescriptor.budgets.maxHistoryMessages) {
    conversationHistory.shift();
  }
}

// ---------------------------------------------------------------------------
// Main reasoning loop
// ---------------------------------------------------------------------------

let running = true;
let tickCount = 0;
// Prevents concurrent tick execution when an LLM call takes longer than TICK_INTERVAL_MS.
let tickInFlight = false;
// Hoisted so both runTick() and the heartbeat interval can trigger a clean shutdown.
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Unified shutdown path used by expiry, SIGTERM, and SIGINT.
 * Idempotent: clears timers (safe to call even if never set), drains Redis, exits.
 */
async function shutdown(reason: string): Promise<void> {
  logger.info({ reason }, 'Agent runtime shutting down');
  running = false;
  clearInterval(heartbeatTimer);
  clearInterval(tickTimer);
  await sendHeartbeat('starting').catch(() => { /* ignore */ }); // reuse 'starting' to signal transition
  await redis.quit().catch(() => { /* ignore */ });
  process.exit(0);
}

async function runTick(): Promise<void> {
  tickCount++;
  logger.info({ tickCount }, 'Agent tick starting');

  // Check session wall-clock expiry before each tick.
  if (sandboxEnforcer.isExpired(SESSION_ID!)) {
    await shutdown('wall_clock_expired');
    return; // unreachable — process.exit() called in shutdown()
  }

  await sendHeartbeat('busy');

  try {
    // Read incoming platform messages (context snapshots, decisions, etc.)
    const incomingMessages = await Promise.race([
      readOutboundMessages(),
      new Promise<Array<Record<string, unknown>>>((resolve) => setTimeout(() => resolve([]), 2000)),
    ]);

    // Build context for this tick.
    let userContext = buildTickUserContext(runtimeState, incomingMessages);
    refreshCapabilityPolicy();
    if (tickCount === 1) {
      userContext += '\n\nThis is your first tick. Start working towards your goal.';
    }

    addToHistory('user', userContext);

    // Build the prompt
    const systemPrompt = composeSystemPrompt(runtimeState);
    // Persist the compiled prompt so the API can serve GET /agents/:id/prompt
    redis.set(`agent:prompt:${AGENT_ID}`, systemPrompt, 'EX', 3600).catch((err: unknown) => {
      logger.warn({ err }, 'Failed to persist system prompt to Redis');
    });
    const messages: ConversationMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
    ];

    // Call the LLM
    const llmResult = await callLlmProvider(
      {
        provider: LLM_PROVIDER!,
        model: LLM_MODEL,
        maxTokens: LLM_MAX_TOKENS,
        timeoutMs: LLM_TIMEOUT_MS,
        baseUrl: LLM_BASE_URL,
      },
      {
        messages,
        maxTokens: LLM_MAX_TOKENS,
        temperature: 0.3,
      },
    );

    if (!llmResult.ok) {
      logger.error({ error: llmResult.error }, 'LLM call failed');
      await sendHeartbeat('degraded');
      addToHistory('assistant', `[LLM error: ${llmResult.error.message}]`);
      return;
    }

    const assistantResponse = llmResult.data.content;
    addToHistory('assistant', assistantResponse);

    logger.info({ tokensUsed: llmResult.data.tokensUsed, latencyMs: llmResult.data.latencyMs }, 'LLM response received');
    logger.debug({ response: assistantResponse.slice(0, 500) }, 'LLM response preview');

    // Parse and execute tool calls
    const toolCalls = parseToolCalls(assistantResponse);
    for (const call of toolCalls) {
      await executeTool(call);
    }

    await sendHeartbeat('ready');
  } catch (err) {
    logger.error({ err }, 'Tick failed');
    await sendHeartbeat('degraded');
  }
}

async function main(): Promise<void> {
  logger.info({ agentId: AGENT_ID, sessionId: SESSION_ID, model: LLM_MODEL, skillIds: runtimeDescriptor.resolvedSkills.map((skill) => skill.id).filter((id) => id !== 'base') }, 'Agent runtime starting');
  runtimeState.sessionStartMs = Date.now();

  // Connect to Redis
  await redis.ping();
  logger.info('Redis connected');

  // Drain any entries left pending in the PEL by a previous container incarnation.
  await drainStalePendingEntries();

  // Register session with the sandbox enforcer so wall-clock and budget tracking begins.
  sandboxEnforcer.registerSession(SESSION_ID!);

  // Signal starting
  await sendHeartbeat('starting');

  // Wait for Redis to be fully ready before first tick
  await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  await sendHeartbeat('ready');

  // Heartbeat interval — keep the session alive between ticks.
  // Also checks wall-clock expiry so shutdown is timely even across long tick gaps.
  heartbeatTimer = setInterval(() => {
    if (sandboxEnforcer.isExpired(SESSION_ID!)) {
      logger.warn({ sessionId: SESSION_ID }, 'Session wall-clock limit exceeded — shutting down');
      void shutdown('wall_clock_expired');
      return;
    }
    void sendHeartbeat('ready').catch((err: unknown) => logger.warn({ err }, 'Heartbeat error'));
  }, HEARTBEAT_INTERVAL_MS);

  // Main reasoning loop — serialized: skip the interval fire if the previous tick
  // is still in flight (slow LLM response, long tool chain, etc.).
  tickTimer = setInterval(async () => {
    if (!running || tickInFlight) return;
    tickInFlight = true;
    try {
      await runTick();
    } catch (err) {
      logger.error({ err }, 'Uncaught error in tick — continuing');
    } finally {
      tickInFlight = false;
    }
  }, TICK_INTERVAL_MS);

  // Run the first tick immediately — hold the in-flight flag so the interval
  // timer cannot start a concurrent tick if the first one takes longer than TICK_INTERVAL_MS.
  tickInFlight = true;
  try {
    await runTick();
  } finally {
    tickInFlight = false;
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Agent runtime crashed');
  process.exit(1);
});
