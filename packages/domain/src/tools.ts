// Platform-facing tool surface. The trading-clean tool contract (ToolResult,
// record types, ToolCategory, ToolDefinition, category helpers, the generic
// AgentTool, and the trading TradingToolContext) lives in
// ./trading/tool-contract.ts. This module defines the platform superset
// `ToolContext` (trading context + agent/platform fields) and the mixed
// platform-facing tool-name registry.

import type { TradingToolContext, ToolCategory, AgentTool as TradingContractAgentTool } from './trading/tool-contract.js';

/**
 * Full platform tool execution context. Extends the trading-clean
 * {@link TradingToolContext} with the agent/platform-only fields (reasoning
 * phase, permission level, capability engine, skills, unified-agent config,
 * external skill provider, usage billing). Structurally identical to the
 * pre-split `ToolContext`.
 */
export interface ToolContext extends TradingToolContext {
  /** Which decision phase is executing this tool call */
  phase: 'scout' | 'judge';
  /** Agent permission level — controls tool visibility and sandbox behavior. */
  permissionLevel: import('./config/schema.js').PermissionLevel;
  /** Capability policy enforcement */
  capabilityEngine?: {
    checkAccess: (capability: string, agentId: string, sessionId: string) => {
      reason: 'kill_switch_active' | 'unknown_capability' | 'capability_disabled'
        | 'capability_never_allowed' | 'rate_limit_exceeded' | 'max_concurrent_exceeded';
      retryAfterMs?: number;
      limit?: number;
      used?: number;
      message: string;
    } | undefined;
    recordStart: (capability: string, sessionId: string) => void;
    recordEnd: (capability: string, sessionId: string, telemetry: { capability: string; agentId: string; sessionId: string; timestamp: string; durationMs: number; inputSummary: string; outputSummary: string; success: boolean; errorCode?: string }) => void;
    getGrant: (capability: string) => { limits?: { maxInvocations?: number; maxPerMinute?: number; maxConcurrent?: number; timeoutMs?: number; maxResponseBytes?: number; maxTotalDownloadBytes?: number } } | undefined;
  };
  /** Agent config operations for reading and updating the agent's unified config at runtime. */
  agentConfigOps?: {
    getCurrentConfig(): Promise<import('./config/schema.js').UnifiedAgentConfig | null>;
    persistConfig(newConfig: import('./config/schema.js').UnifiedAgentConfig | null, executionMode?: string): Promise<void>;
    appendJournal(type: string, payload: Record<string, unknown>): Promise<void>;
    notifyActorConfigUpdate(newConfig: import('./config/schema.js').UnifiedAgentConfig | null): Promise<void>;
    getLlmTickCount(): number;
  };
  /** External skill provider for search/browse (optional — absent when external skills are disabled) */
  externalSkillProvider?: import('./ports/external-skill-provider.js').ExternalSkillProvider;
  /** Skill catalog operations for list_skills and search_skills. */
  skillOps?: {
    listAssigned(): Promise<Array<{ id: string; slug: string; name: string; description: string; dependsOn: string[] }>>;
    listAvailable(): Promise<Array<{ id: string; slug: string; name: string; description: string; dependsOn: string[] }>>;
    search(query: string, limit?: number): Promise<Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      isAssigned: boolean;
      dependsOn: string[];
    }>>;
  };
  /**
   * Called by add_skills/remove_skills after the broker confirms the DB write.
   * Re-resolves the runtime descriptor from DB and applies it to the live
   * runtime state, refreshing tool visibility and the system prompt.
   * Returns the updated list of assigned skill IDs (excluding base).
   */
  onSkillsChanged?: () => Promise<string[]>;
  /** Usage billing service for recording metered events (browser sessions, etc.). */
  usageBilling?: {
    recordBrowserSession(input: { durationMs: number; browserSessionId: string }): void;
  };
}

/**
 * Platform-facing tool contract. Re-declares the trading-owned generic
 * {@link TradingContractAgentTool} with the default context bound to the full
 * platform {@link ToolContext}, so platform tool files that annotate `: AgentTool`
 * (importing this name from the domain barrel) keep the full platform context on
 * their `execute` ctx. This is the single `AgentTool` exported from the barrel;
 * trading tools bind the context explicitly via `AgentTool<TradingToolContext>`
 * (or the `TradingAgentTool` alias). Structurally identical to the trading
 * contract's generic — no field or behaviour change.
 */
export interface AgentTool<Ctx extends TradingToolContext = ToolContext>
  extends TradingContractAgentTool<Ctx> {}

export const KNOWN_AGENT_TOOL_NAMES = [
  'add_skills',
  'adjust_bot_config',
  'adjust_risk_limits',
  'change_strategy_preset',
  'assess_strategy_preset',
  'browse_interactive',
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
  'execute_shell',
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
  'list_app_docs',
  'list_bots',
  'list_files',
  'list_memory_keys',
  'list_positions',
  'list_skills',
  'list_tasks',
  'list_watches',
  'make_http_request',
  'publish_artifact',
  'read_app_docs',
  'read_document',
  'read_file',
  'remove_skills',
  'remove_watch',
  'resolve_bot',
  'resolve_task',
  'resolve_watch',
  'schedule_reminder',
  'search_app_docs',
  'search_skills',
  'search_tokens',
  'search_web',
  'send_email',
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

/** Catalog entry: category + description for each known agent tool. */
export interface ToolCatalogEntry {
  category: ToolCategory;
  description: string;
}

/**
 * Static catalog of all agent tools with category and description.
 * Used by the API discovery endpoint and worker drift checks.
 * Must stay in sync with the worker tool registry — enforced at startup
 * by assertToolCatalogMatchesRegistry().
 */
export const TOOL_CATALOG: Record<string, ToolCatalogEntry> = {
  // execute-trade
  submit_decision:     { category: 'execute-trade',       description: 'Submit a trade decision for a specific instrument. In direct mode, accepted decisions execute immediately. In approval_required mode, the decision is recorded and sent to the user for approval — no trade executes until the user responds with /yes <code> or /no <code>.' },
  create_bot:          { category: 'execute-trade',       description: 'Create and start a new trading bot with its own strategy and risk parameters.' },

  // read-database
  get_analytics:       { category: 'read-database',       description: 'Get trading analytics: total trades, win rate, P&L, fees, per-bot/agent-direct breakdown.' },
  list_positions:      { category: 'read-database',       description: 'List open positions owned by this agent (bot-created + direct).' },
  list_bots:           { category: 'read-database',       description: 'List bots created by this agent, optionally filtered by creation date.' },
  get_bot_status:      { category: 'read-database',       description: 'Get detailed status for a specific bot: config, runtime state, timestamps.' },
  get_account_summary: { category: 'read-database',       description: "Agent's trading account summary: capital, equity, open positions, P&L, risk limits." },
  get_risk_limits:     { category: 'read-database',       description: 'Get effective risk limits: which are mutable vs locked, plus runtime state.' },
  find_instrument:     { category: 'read-database',       description: 'Find a tradable instrument by symbol/name. Returns instrumentId (venue-submittable), id (DB internal), symbol, base, quote, type, venue.' },
  resolve_bot:         { category: 'read-database',       description: 'Resolve a bot name/symbol to its bot ID for stop/start/config operations.' },
  list_skills:         { category: 'read-database',       description: 'List skills assigned to this agent and skills available to add.' },
  search_skills:       { category: 'read-database',       description: 'Search for skills by keyword across the platform catalog and the external skill registry.' },
  // write-database
  stop_bot:            { category: 'write-database',      description: 'Stop a running bot. Positions remain open unless manually closed.' },
  start_bot:           { category: 'write-database',      description: 'Start a stopped bot. Resumes trading per its configuration.' },
  adjust_bot_config:   { category: 'write-database',      description: 'Update configuration for a specific bot. Changes merged and take effect next tick.' },
  adjust_risk_limits:  { category: 'write-database',      description: 'Adjust mutable risk limits. Only operator-default-derived limits can be changed.' },
  change_strategy_preset: { category: 'write-database', description: 'Apply a strategy preset change using an exact assessment artifact reference from assess_strategy_preset. Supports: entries_only (future entries only) and entries_and_tighten_existing (tighten stops on open positions). Records the transition event for audit.' },
  add_skills:          { category: 'write-database',      description: 'Add skills to this agent from the skill catalog. Skills become available immediately.' },
  remove_skills:       { category: 'write-database',      description: 'Remove skills from this agent. Tools from removed skills become unavailable immediately.' },

  // read-market-data
  search_tokens:       { category: 'read-market-data',    description: 'Search for tokens by name/symbol on DEX aggregators. Returns liquidity, price, safety metadata, network.' },
  discover_tokens:     { category: 'read-market-data',    description: 'Discover trending/popular tokens from aggregated market data sources.' },
  check_regime:        { category: 'read-market-data',    description: 'Evaluate market regime using EMA alignment, ADX, VWAP, and structure filters.' },
  get_funding_rates:   { category: 'read-market-data',    description: 'Get current funding rates for perpetual contracts.' },
  get_market_overview: { category: 'read-market-data',    description: 'Aggregated market overview: top movers, volume leaders, market breadth metrics.' },
  assess_strategy_preset: { category: 'read-database', description: 'Request a billable market preset assessment for one or more trading symbols. Returns ranked presets, confidence, market summary, and the exact transition reference for change_strategy_preset.' },
  get_price:           { category: 'read-market-data',    description: 'Look up current price of a token. Hyperliquid perps use mark price; DEX tokens use oracle price.' },

  // read-web
  search_web:          { category: 'read-web',            description: 'Search the internet using Tavily. Returns top results with titles, URLs, text extracts.' },
  browse_url:          { category: 'read-web',            description: 'Fetch and read contents of a web page. HTTPS only; private IPs/loopback blocked.' },
  browse_interactive:  { category: 'read-web',            description: 'Interactive browser automation: open pages, click elements, fill forms, take screenshots, read accessibility trees. Requires a browser pool session.' },
  make_http_request:   { category: 'read-web',            description: 'Make structured HTTP requests (GET/POST/PUT/PATCH/DELETE/HEAD) to external APIs. Returns status, headers, and truncated body.' },
  read_document:       { category: 'read-web',            description: 'Fetch and extract text from a document URL (currently PDF). HTTPS only; SSRF protected.' },

  // read-config
  get_schema:          { category: 'read-config',         description: "Fetch JSON Schema for named config parameters or tool sub-schemas. Call with name='all' to list all." },
  search_app_docs:     { category: 'read-config',         description: 'Search platform docs, schemas, and mappings. Returns ranked results with excerpts.' },
  list_app_docs:       { category: 'read-config',         description: 'List all available documentation pages, schemas, and reference materials.' },
  read_app_docs:       { category: 'read-config',         description: 'Read a specific documentation page or schema by its path ID.' },

  // read-memory
  get_memory:          { category: 'read-memory',         description: 'Retrieve a stored memory value by key. Returns found/not-found.' },
  list_memory_keys:    { category: 'read-memory',         description: 'List all keys stored in agent memory.' },
  list_tasks:          { category: 'read-memory',         description: 'List tasks; filter by status (pending/completed/all).' },
  list_watches:        { category: 'read-memory',         description: 'List all active price watches registered by this agent.' },
  resolve_watch:       { category: 'read-memory',         description: 'Resolve a price watch to its ID by searching note text or symbol.' },
  resolve_task:        { category: 'read-memory',         description: "Resolve a task title to its task ID. Use this before calling complete_task when you don't have the exact task UUID." },

  // write-memory
  set_memory:          { category: 'write-memory',        description: 'Store a value in agent memory by key. Persists across ticks and restarts.' },
  delete_memory:       { category: 'write-memory',        description: 'Delete one or more memory keys.' },
  create_task:         { category: 'write-memory',        description: 'Create a durable task with title, optional notes, and optional due datetime.' },
  complete_task:       { category: 'write-memory',        description: 'Mark a task as completed by its ID.' },
  schedule_reminder:   { category: 'write-memory',        description: 'Schedule a one-shot reminder at a specific absolute datetime (ISO 8601 UTC).' },
  watch_token:         { category: 'write-memory',        description: 'Register a price watch. Fires when price crosses a threshold in specified direction.' },
  remove_watch:        { category: 'write-memory',        description: 'Remove a price watch by its ID.' },
  check_watches:       { category: 'write-memory',        description: 'Evaluate all active price watches against current prices. Optionally auto-remove triggered.' },

  // write-messaging
  send_message:        { category: 'write-messaging',     description: 'Send a message to the user via the platform messaging system. For user-directed communication only — use send_email for email delivery.' },
  send_email:          { category: 'write-messaging',     description: 'Send an email via a connected email account. Supports cc, bcc, and optional fromConnectionId.' },
  publish_artifact:    { category: 'write-messaging',     description: 'Publish an artifact (analysis result, chart, report) for user review.' },

  // read-filesystem
  read_file:           { category: 'read-filesystem',     description: 'Read contents of a file in the agent workspace.' },
  list_files:          { category: 'read-filesystem',     description: 'List files and directories in the agent workspace.' },
  stat_file:           { category: 'read-filesystem',     description: 'Get metadata about a file/directory: exists, type, size, modification time.' },

  // write-filesystem
  write_file:          { category: 'write-filesystem',    description: 'Create or overwrite a file in the agent workspace.' },
  delete_file:         { category: 'write-filesystem',    description: 'Delete a file from the agent workspace.' },

  // execute-filesystem
  execute_code:        { category: 'execute-filesystem',  description: 'Execute JavaScript (Node.js) or Python code in a workspace-backed environment. Supports optional package installation.' },
  execute_shell:       { category: 'execute-filesystem',  description: 'Execute arbitrary shell commands in the agent workspace. Available at standard and full permission levels.' },
};

/** Look up a tool's catalog entry by name. Returns undefined for unknown tools. */
export function getToolCatalogEntry(name: string): ToolCatalogEntry | undefined {
  return TOOL_CATALOG[name];
}

/** Human-readable labels for tool categories. Used by API and UI. */
export const TOOL_CATEGORY_LABELS: Record<string, string> = {
  'execute-trade':       'Trade Execution',
  'read-database':       'Database (Read)',
  'write-database':      'Database (Write)',
  'read-market-data':    'Market Data (Read)',
  'read-web':            'Web Access (Read)',
  'read-config':         'Configuration (Read)',
  'read-memory':         'Memory (Read)',
  'write-memory':        'Memory (Write)',
  'write-messaging':     'Messaging',
  'read-filesystem':     'Filesystem (Read)',
  'write-filesystem':    'Filesystem (Write)',
  'execute-filesystem':  'Code Execution',
};
