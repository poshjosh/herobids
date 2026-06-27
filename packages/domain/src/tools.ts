import type { z } from 'zod';

/**
 * Tool category system — uses composite categories for fine-grained capability control.
 *
 * Tool names use lower snake case.
 * Prefer action-first names.
 * Prefer `verb_noun` or `verb_noun_qualifier` when possible.
 * Avoid noun-first and hyphenated names.
 * Bad: `code_execute`, `get-overview-from-market`
 * Good: `execute_code`, `get_market_overview`
 *
 * Format: `<operation>-<target>`
 * - Operation: read | write | execute
 * - Target: filesystem | database | trade | messaging | memory | market-data | config
 *
 * Categories double as capability-based security controls (rwx model).
 * A tool's category determines which capability grant an agent needs to invoke it.
 * Choose the target that matches the tool's primary domain, not its storage mechanism.
 *
 * Examples:
 * - "read-database" — list_positions, get_bot_status
 * - "write-messaging" — send_message
 * - "execute-trade" — submit_decision, create_bot
 * - "read-market-data" — search_tokens, check_regime
 * - "read-filesystem" — read_file, list_files
 * - "write-filesystem" — write_file, delete_file
 * - "execute-filesystem" — execute_code (writes then executes)
 * - "read-config" — get_schema (pure config introspection, no DB access)
 */
export type ToolCategory =
  | 'read-database'
  | 'read-memory'
  | 'read-market-data'
  | 'read-trade'
  | 'read-web'
  | 'read-config'
  | 'read-filesystem'
  | 'write-database'
  | 'write-memory'
  | 'write-messaging'
  | 'write-filesystem'
  | 'execute-trade'
  | 'execute-filesystem';

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Machine-readable error code for non-success results. */
  errorCode?: string;
  /** When true, the failure is transient (rate limit, timeout) and retrying may succeed. */
  retryable?: boolean;
  /**
   * When explicitly false, the failure is a content-level outcome (e.g. HTTP 4xx, redirect
   * blocked by policy) rather than an infrastructure fault. The circuit breaker should not
   * count these against the tool. Defaults to true (i.e. assume fault unless told otherwise).
   */
  fault?: boolean;
}

/** Bot row shape returned by bot repository queries. */
export interface ToolBotRecord {
  id: string;
  status: string;
  config: Record<string, unknown>;
  creatorType: string;
  creatorId: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
}

/** Position row shape returned by repository queries. */
export interface ToolPositionRecord {
  actorType: string;
  actorId: string;
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  openedAt: Date;
}

/** Analytics result returned by getAnalyticsByCreator. */
export interface ToolAnalyticsResult {
  botCount: number;
  openPositions: number;
  closedPositions: number;
  winningPositions: number;
  realizedPnlUsd: string;
  totalFeesUsd: string;
  recentFills: number;
  avgHoldTimeHours: number | null;
  byBot: Array<{ botId: string; status: string; recentFills: number; realizedPnlUsd: string }>;
  agentDirect: { recentFills: number; realizedPnlUsd: string } | null;
}

export interface ToolContext {
  agentId: string;
  sessionId: string;
  /** Which decision phase is executing this tool call */
  phase: 'scout' | 'judge';
  /** Redis client for agent memory, watches, and pub/sub */
  redis: {
    hset: (key: string, field: string, value: string) => Promise<number>;
    hget: (key: string, field: string) => Promise<string | null>;
    hgetall: (key: string) => Promise<Record<string, string> | null>;
    hdel: (key: string, ...fields: string[]) => Promise<number>;
    publish: (channel: string, message: string) => Promise<number>;
    /** Blocking list pop — used to await async decision replies. Returns [key, value] or null on timeout. */
    blpop: (key: string, timeoutSeconds: number) => Promise<[string, string] | null>;
    /** Redis SET operations — used by watch tools for notified-watch dedup. */
    smembers: (key: string) => Promise<string[]>;
    sadd: (key: string, ...members: string[]) => Promise<number>;
    srem: (key: string, ...members: string[]) => Promise<number>;
    expire: (key: string, seconds: number) => Promise<number>;
  };
  /** Publish agent protocol message to inbound stream */
  publishToInbound: (type: string, payload: Record<string, unknown>) => Promise<void>;
  /** Optional database repository for direct bot queries */
  botRepo?: {
    getBotsByCreator: (creatorType: string, creatorId: string, since?: Date) => Promise<ToolBotRecord[]>;
    getBotById: (botId: string) => Promise<ToolBotRecord | null>;
    markBotStopped: (botId: string) => Promise<void>;
    markBotRunning: (botId: string) => Promise<void>;
    restoreBotRuntimeState: (state: { botId: string; status: string; startedAt: Date | null; stoppedAt: Date | null }) => Promise<void>;
    updateBotConfig: (botId: string, config: Record<string, unknown>) => Promise<void>;
    getAnalyticsByCreator: (creatorType: string, creatorId: string, since: Date, botId?: string) => Promise<ToolAnalyticsResult>;
    getOpenPositionsByCreator: (creatorType: string, creatorId: string, botId?: string) => Promise<ToolPositionRecord[]>;
  };
  /** Optional market data registry */
  marketDataRegistry?: {
    dexscreener: {
      search: (query: string) => Promise<{
        data: unknown[];
        meta: {
          freshness: {
            source: string;
            fetchedAt: string;
            ageMs: number;
            ttlMs: number;
            isStale: boolean;
            expiresAt: string;
          };
        };
      }>;
      searchConfig: unknown;
    };
    binance: { candles: (symbol: string, opts?: { interval?: string; limit?: number }) => Promise<{ data: unknown[] }> };
  };
  /** Market data telemetry hooks */
  recordMarketDataAttempt?: (provider: string) => void;
  recordMarketDataRejection?: (provider: string, opts?: { priority?: 'execution' | 'discovery' }) => void;
  /** Resolved market data config — enables shared token safety policy in search tools */
  marketDataConfig?: Record<string, unknown>;
  /** Capability policy enforcement */
  capabilityEngine?: {
    checkAccess: (capability: string, agentId: string, sessionId: string) => string | undefined;
    recordStart: (capability: string, sessionId: string) => void;
    recordEnd: (capability: string, sessionId: string, telemetry: { capability: string; agentId: string; sessionId: string; timestamp: string; durationMs: number; inputSummary: string; outputSummary: string; success: boolean; errorCode?: string }) => void;
    getGrant: (capability: string) => { limits?: { maxInvocations?: number; maxPerMinute?: number; maxConcurrent?: number; timeoutMs?: number; maxResponseBytes?: number; maxTotalDownloadBytes?: number } } | undefined;
  };
  /** Session metrics for tool execution */
  sessionMetrics?: {
    decisionsSubmitted: number;
  };
  /**
   * Price service for non-execution price lookups: valuation, watch thresholds,
   * and discovery enrichment. NOT used for live trade sizing or swap execution.
   */
  priceService?: {
    getPrice(symbol: string, chain: string, address?: string): Promise<{
      ok: boolean;
      data?: { priceUsd: number; source: 'execution' | 'oracle' | 'cached'; fetchedAt: string; stale: boolean };
      error?: { code: string; message: string };
    }>;
  };
  /** Agent risk contract operations for reading and adjusting runtime risk limits. */
  riskContractOps?: {
    getContract(): Promise<import('./agent-risk-contract.js').ResolvedAgentRiskContract>;
    adjustOverrides(overrides: Record<string, number | null>): Promise<{ ok: boolean; error?: string; contract?: import('./agent-risk-contract.js').ResolvedAgentRiskContract }>;
  };
  /** Agent config operations for reading and updating the agent's unified config at runtime. */
  agentConfigOps?: {
    getCurrentConfig(): Promise<import('./config/schema.js').UnifiedAgentConfig | null>;
    persistConfig(newConfig: import('./config/schema.js').UnifiedAgentConfig | null, executionMode?: string): Promise<void>;
    appendJournal(type: string, payload: Record<string, unknown>): Promise<void>;
    notifyActorConfigUpdate(newConfig: import('./config/schema.js').UnifiedAgentConfig | null): Promise<void>;
    getLlmTickCount(): number;
  };
  /** Instrument repository for find_instrument lookups. */
  instrumentRepo?: {
    search(opts: { query: string; venue?: string; limit?: number }): Promise<Array<{
      id: string;
      symbol: string;
      base: string;
      quote: string;
      type: string;
      venue: string;
      tickSize: string;
      lotSize: string;
    }>>;
  };
  /** Agent repository for get_account_summary (capital, etc.). */
  agentRepo?: {
    getAgent(agentId: string): Promise<{ capital: string | null } | null>;
  };
}

export interface AgentTool {
  name: string;
  description: string;
  /** Zod schema for runtime validation */
  parametersSchema: z.ZodType;
  /** JSON Schema for LLM function calling (derived from parametersSchema) */
  parameters: Record<string, unknown>;
  /** Composite category (e.g., "execute-trade", "read-database") */
  category: ToolCategory;
  /**
   * Optional prompt-facing usage notes rendered near this tool's name in the
   * system prompt. Keep concise — argument-level semantics that cannot be
   * derived from the JSON schema alone.
   */
  promptGuidance?: string;
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Provider-neutral tool definition for LLM tool calling */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  promptGuidance?: string;
}

export const KNOWN_AGENT_TOOL_NAMES = [
  'adjust_bot_config',
  'adjust_risk_limits',
  'browse_url',
  'check_regime',
  'check_watches',
  'complete_task',
  'create_bot',
  'create_task',
  'delete_file',
  'delete_memory',
  'discover_tokens',
  'execute_code',
  'find_instrument',
  'get_account_summary',
  'get_analytics',
  'get_bot_status',
  'get_funding_rates',
  'get_market_overview',
  'get_memory',
  'get_price',
  'get_risk_limits',
  'get_schema',
  'list_bots',
  'list_files',
  'list_memory_keys',
  'list_positions',
  'list_tasks',
  'list_watches',
  'publish_artifact',
  'read_document',
  'read_file',
  'remove_watch',
  'resolve_bot',
  'resolve_task',
  'resolve_watch',
  'schedule_reminder',
  'search_tokens',
  'search_web',
  'send_message',
  'set_memory',
  'start_bot',
  'stat_file',
  'stop_bot',
  'submit_decision',
  'watch_token',
  'write_file',
] as const;

export type AgentToolName = typeof KNOWN_AGENT_TOOL_NAMES[number];

export function isKnownAgentToolName(toolName: string): toolName is AgentToolName {
  return (KNOWN_AGENT_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function findUnknownSkillTools(requiredTools: string[]): string[] {
  return [...new Set(requiredTools.filter((toolName) => !isKnownAgentToolName(toolName)))].sort();
}

/** Helper to check if a category implies read-only access */
export function isReadOnlyCategory(category: ToolCategory): boolean {
  return category.startsWith('read-');
}

/** Extract operation from composite category (e.g., "execute-trade" → "execute") */
export function getCategoryOperation(category: ToolCategory): 'read' | 'write' | 'execute' {
  if (category.startsWith('read-')) return 'read';
  if (category.startsWith('write-')) return 'write';
  return 'execute';
}

/** Extract target from composite category (e.g., "execute-trade" → "trade") */
export function getCategoryTarget(category: ToolCategory): string {
  const parts = category.split('-');
  return parts.slice(1).join('-');
}
