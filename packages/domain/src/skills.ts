/**
 * System skill definitions — seeded at deploy time.
 * Each skill defines what tools and context sections an agent can access.
 *
 * The `base` skill is auto-injected at runtime and NOT stored in the DB.
 * All other skills are stored as rows in the `skills` table.
 */

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  requiredTools: string[];
  capabilityFamilies: string[];
  bindingRequirements: Record<string, {
    minBindings: number;
    requireReady: boolean;
  }>;
  contextRequirements: string[];
  requiredContextBlocks: string[];
  promptRendererHints: string[];
  requiredGuardrails: string[];
  suggestedTickIntervalMs: number;
  visibility: 'public' | 'private';
}

/**
 * `base` skill — auto-injected at runtime for every agent.
 * Provides memory, messaging, cost-awareness, and introspection tools.
 * NOT stored in DB; merged into any agent's capability set at tick time.
 */
export const BASE_SKILL: SkillDefinition = {
  id: 'base',
  name: 'Base',
  description: 'Core tools: memory, messaging, cost tracking, schema fetching, and account summary. Auto-injected into every agent.',
  instructions: `You have access to core tools.

- Use \`set_memory\` to persist a value by key across ticks.
- Use \`get_memory\` to retrieve a previously stored value by key.
- Use \`list_memory_keys\` to list all stored memory keys.
- Use \`delete_memory\` to remove one or more memory keys.
- Use \`publish_artifact\` to publish structured outputs.
- Use \`send_message\` to communicate important updates, alerts, or status reports to the user. Set messageClass to "alert" or "reminder" for urgency. Set emailDelivery to "if_allowed" to request email fanout (policy permitting). Use contextRef to link the message to a specific context.
- Use \`get_risk_limits\` to inspect your effective risk limits, including which are mutable and which are locked by the creator.
- Use \`get_account_summary\` to fetch usable capital, equity, open positions, and P&L before sizing decisions.
- Use \`get_schema\` to fetch JSON Schema for a named config parameter or tool sub-schema. Call with name="all" to list available schemas before constructing config payloads.`,
  requiredTools: ['send_message', 'publish_artifact', 'set_memory', 'get_memory', 'list_memory_keys', 'delete_memory', 'get_risk_limits', 'get_account_summary', 'get_schema'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000, // 15 minutes
  visibility: 'public',
};

/**
 * `bot-management` skill — used by the `trading` preset.
 * Allows the agent to create, start, stop, and monitor bots.
 */
export const BOT_MANAGEMENT_SKILL: SkillDefinition = {
  id: 'bot-management',
  name: 'Bot Management',
  description: 'Create, start, stop, and monitor trading bots.',
  instructions: `You have access to bot-management tools.

- Use \`create_bot\` to create a trading bot.
- Use \`list_bots\` to inspect existing bots.
- Use \`get_bot_status\` to inspect a bot's current state.
- Use \`start_bot\` to start a bot.
- Use \`stop_bot\` to stop a bot.
- Use \`adjust_bot_config\` to update a bot's configuration.
- Use \`get_analytics\` to inspect bot performance.
- Use \`list_positions\` to inspect open positions tied to managed bots.
- Use \`resolve_bot\` to find a bot ID by name or symbol before calling stop_bot, start_bot, get_bot_status, or adjust_bot_config when you don't have the UUID.
- Use \`send_message\` to report actions, status, or issues to the user.`,
  requiredTools: ['create_bot', 'stop_bot', 'start_bot', 'adjust_bot_config', 'list_bots', 'get_bot_status', 'get_analytics', 'list_positions', 'resolve_bot', 'send_message'],
  capabilityFamilies: ['trading'],
  bindingRequirements: {
    trading: {
      minBindings: 1,
      requireReady: true,
    },
  },
  contextRequirements: ['bot_statuses', 'positions', 'costs'],
  requiredContextBlocks: ['corePlatformContext', 'tradingContext'],
  promptRendererHints: ['readiness-summary', 'trading'],
  requiredGuardrails: ['token-budget', 'daily-loss', 'bot-limit'],
  suggestedTickIntervalMs: 900_000, // 15 minutes
  visibility: 'public',
};

/**
 * `trading` skill — used for direct trade decisions and state inspection.
 */
export const TRADING_SKILL: SkillDefinition = {
  id: 'trading',
  name: 'Trading',
  description: 'Submit trade decisions and inspect trading state.',
  instructions: `You have access to trading tools, grouped by workflow phase.

## Observe — gather market context
- Use \`get_market_overview\` to inspect broad market state.
- Use \`check_regime\` to assess current market conditions.
- Use \`get_price\` for focused price checks.
- Use \`get_funding_rates\` to inspect perpetual funding conditions.
- Use \`search_tokens\` to find a token by name or symbol.
- Use \`discover_tokens\` to explore available trading candidates.

## Assess — check your risk and position before acting
- Use \`get_risk_limits\` to inspect your effective risk limits and their sources. If you are blocked (e.g. daily loss limit exceeded), DO NOT submit any trade — wait for the cooldown to expire.
- Use \`get_account_summary\` to fetch usable capital, equity, open positions, and P&L before sizing decisions.
- Use \`get_analytics\` to inspect recent trading outcomes and exposure.
- Use \`list_positions\` to inspect current open positions.
- Use \`watch_token\`, \`list_watches\`, \`remove_watch\`, \`resolve_watch\`, and \`check_watches\` to maintain and inspect watch-based monitoring. Use resolve_watch to find a watch ID by note or symbol before calling remove_watch.

## Decide — act only when the signal is clear
- Use \`find_instrument\` to resolve an instrumentId by symbol, name, or pair before calling submit_decision. Filter by venue (e.g. venue="jupiter" for Solana, venue="hyperliquid" for perpetuals).
- Use \`submit_decision\` to submit a trade intent for a specific instrument. Only call this after completing the Observe and Assess phases above.
- Use \`adjust_risk_limits\` to adjust mutable (default-derived) risk limits within operator ceilings.`,
  requiredTools: ['get_market_overview', 'check_regime', 'get_price', 'get_funding_rates', 'search_tokens', 'discover_tokens', 'get_risk_limits', 'get_account_summary', 'get_analytics', 'list_positions', 'watch_token', 'list_watches', 'remove_watch', 'resolve_watch', 'check_watches', 'find_instrument', 'submit_decision', 'adjust_risk_limits'],
  capabilityFamilies: ['trading'],
  bindingRequirements: {
    trading: {
      minBindings: 1,
      requireReady: true,
    },
  },
  contextRequirements: ['positions', 'fills', 'analytics', 'costs'],
  requiredContextBlocks: ['corePlatformContext', 'tradingContext'],
  promptRendererHints: ['readiness-summary', 'trading'],
  requiredGuardrails: ['token-budget', 'daily-loss'],
  suggestedTickIntervalMs: 300_000,
  visibility: 'public',
};

/**
 * `risk-monitoring` skill — watches positions and alerts on drawdowns.
 */
export const RISK_MONITORING_SKILL: SkillDefinition = {
  id: 'risk-monitoring',
  name: 'Risk Monitoring',
  description: 'Watch open positions and alert the user when risk thresholds are approaching.',
  instructions: `You have access to risk-monitoring and alerting tools.

- Use \`list_positions\` to inspect current open positions and exposure.
- Use \`get_analytics\` to inspect realized and unrealized performance context.
- Use \`get_price\` for focused price checks.
- Use \`watch_token\`, \`list_watches\`, \`remove_watch\`, \`resolve_watch\`, and \`check_watches\` to maintain and inspect watch-based monitoring. Use resolve_watch to find a watch ID by note or symbol before calling remove_watch.
- Use \`send_message\` to alert the user.
- Use \`publish_artifact\` to publish structured monitoring outputs.
- Use \`get_risk_limits\` to inspect effective risk limits and sources.
- Use \`adjust_risk_limits\` to adjust mutable risk limits within operator ceilings.`,
  requiredTools: ['send_message', 'publish_artifact', 'list_positions', 'get_analytics', 'get_price', 'watch_token', 'list_watches', 'remove_watch', 'resolve_watch', 'check_watches', 'get_risk_limits', 'adjust_risk_limits'],
  capabilityFamilies: ['trading'],
  bindingRequirements: {
    trading: {
      minBindings: 1,
      requireReady: true,
    },
  },
  contextRequirements: ['positions', 'fills', 'analytics'],
  requiredContextBlocks: ['corePlatformContext', 'tradingContext'],
  promptRendererHints: ['readiness-summary', 'trading'],
  requiredGuardrails: ['token-budget', 'daily-loss'],
  suggestedTickIntervalMs: 300_000, // 5 minutes
  visibility: 'public',
};

/**
 * `programming` skill — code execution tools.
 */
export const PROGRAMMING_SKILL: SkillDefinition = {
  id: 'programming',
  name: 'Programming',
  description: 'Code execution tools',
  instructions: `You have access to programming tools for code-driven automation, external API calls etc.

- Use \`execute_code\` to run JavaScript or Python for custom automation, external API calls, analysis, data processing etc.
- The tool supports JavaScript/Node.js and Python runtimes as well as optional dependency installation.
- The tool returns stdout/stderr so you can inspect execution results directly.
- Code can access the public internet.`,
  requiredTools: ['execute_code'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
};

/**
 * `file-management` skill — workspace file read, write, list, and delete.
 */
export const FILE_MANAGEMENT_SKILL: SkillDefinition = {
  id: 'file-management',
  name: 'File Management',
  description: 'Manage a per-agent workspace for intermediate files and outputs.',
  instructions: `You have access to workspace file-management tools.

- Use \`write_file\` to create or overwrite a file under the agent workspace.
- Use \`read_file\` to inspect file contents.
- Use \`list_files\` to inspect workspace directories and discover available files.
- Use \`delete_file\` to remove files you no longer need.
- Use \`stat_file\` to check if a path exists, whether it is a file or directory, and its size before calling read_file, list_files, or delete_file.

Workspace rules:
- Workspace files persist across ticks in the same runtime.
- Workspace files do not persist across runtime restarts.
- The \`sandbox\` directory is reserved for code execution internals.
- For data that must survive runtime restarts, memory tools from the base skill are the durable storage path.`,
  requiredTools: ['write_file', 'read_file', 'list_files', 'delete_file', 'stat_file'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
};

/**
 * `web-access` skill — internet search, URL reading, and document fetching.
 */
export const WEB_ACCESS_SKILL: SkillDefinition = {
  id: 'web-access',
  name: 'Web Access',
  description: 'Search the internet, read web pages, and fetch documents for research and information gathering.',
  instructions: `You have access to internet research tools.

- Use \`search_web(query)\` to search the internet. Returns a list of results with titles, URLs, and text extracts.
- Use \`browse_url(url)\` to fetch and read the contents of a specific web page. Only \`https://\` URLs are allowed.
- Use \`read_document(url)\` to fetch and extract text from a document URL (e.g. PDF). Only \`https://\` URLs are allowed.
- Use \`send_message\` to share findings with the user.
- Use \`publish_artifact\` when findings are substantial enough to warrant a structured output.`,
  requiredTools: ['search_web', 'browse_url', 'read_document', 'send_message', 'publish_artifact'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
};

/**
 * `task-management` skill — durable task tracking and reminder scheduling.
 */
export const TASK_MANAGEMENT_SKILL: SkillDefinition = {
  id: 'task-management',
  name: 'Task Management',
  description: 'Create, track, and complete durable tasks; schedule one-shot reminders.',
  instructions: `You have access to task management tools.

- Use \`create_task\` to create a durable task with a title, optional notes, and optional due datetime.
- Use \`list_tasks\` to list your current tasks and their status.
- Use \`resolve_task\` to find a task ID by title before calling complete_task when you don't have the exact UUID.
- Use \`complete_task\` to mark a task as completed by its ID.
- Use \`schedule_reminder\` to schedule a one-shot reminder at a specific datetime. The reminder will reach you at the scheduled time with structured context. Scheduling a reminder is not the reminder itself; when the reminder arrives, you may need to take action (e.g send a notification) based on the structured context.`,
  requiredTools: ['create_task', 'list_tasks', 'resolve_task', 'complete_task', 'schedule_reminder'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs', 'session_elapsed'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
};

/**
 * Preset → skill ID mapping.
 * When a user selects a preset in the UI, this is what gets stored as skillIds.
 */
export const SKILL_PRESET_MAP: Record<string, string[]> = {
  trading: ['bot-management', 'trading'],
  'direct-trading': ['trading'],
  'personal-assistant': ['task-management', 'web-access'],
  custom: [],       // user configures skills manually
};

/** All seeded system skills (excluding base which is auto-injected). */
export const SYSTEM_SKILLS: SkillDefinition[] = [
  BOT_MANAGEMENT_SKILL,
  TRADING_SKILL,
  RISK_MONITORING_SKILL,
  PROGRAMMING_SKILL,
  FILE_MANAGEMENT_SKILL,
  WEB_ACCESS_SKILL,
  TASK_MANAGEMENT_SKILL,
];
