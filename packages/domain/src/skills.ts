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
 * Provides memory, messaging, and cost-awareness tools.
 * NOT stored in DB; merged into any agent's capability set at tick time.
 */
export const BASE_SKILL: SkillDefinition = {
  id: 'base',
  name: 'Base',
  description: 'Core tools: memory, messaging, and cost tracking. Auto-injected into every agent.',
  instructions: `You have access to core tools.

- Use \`set_memory\` to persist a value by key across ticks.
- Use \`get_memory\` to retrieve a previously stored value by key.
- Use \`list_memory_keys\` to list all stored memory keys.
- Use \`delete_memory\` to remove one or more memory keys.
- Use \`publish_artifact\` to publish structured outputs.
- Use \`send_message\` to communicate important updates, alerts, or status reports to the user. Set messageClass to "alert" or "reminder" for urgency. Set emailDelivery to "if_allowed" to request email fanout (policy permitting). Use contextRef to link the message to a specific context.`,
  requiredTools: ['send_message', 'publish_artifact', 'set_memory', 'get_memory', 'list_memory_keys', 'delete_memory'],
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
- Use \`send_message\` to report actions, status, or issues to the user.`,
  requiredTools: ['create_bot', 'stop_bot', 'start_bot', 'adjust_bot_config', 'list_bots', 'get_bot_status', 'get_analytics', 'list_positions', 'send_message'],
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
  instructions: `You have access to trading tools.

- Use \`submit_decision\` to submit a trade intent for a specific instrument.
- Use \`list_positions\` to inspect current open positions.
- Use \`get_analytics\` to inspect recent trading outcomes and exposure.
- Use \`check_regime\` to assess current market conditions.
- Use \`search_tokens\` to find a token by name or symbol.
- Use \`discover_tokens\` to explore available trading candidates.
- Use \`get_funding_rates\` to inspect perpetual funding conditions.
- Use \`get_market_overview\` to inspect broad market state.
- Use \`get_price\` for focused price checks.
- Use \`watch_token\`, \`list_watches\`, \`remove_watch\`, and \`check_watches\` to maintain and inspect watch-based monitoring.`,
  requiredTools: ['submit_decision', 'list_positions', 'get_analytics', 'check_regime', 'search_tokens', 'discover_tokens', 'get_funding_rates', 'get_market_overview', 'get_price', 'watch_token', 'list_watches', 'remove_watch', 'check_watches'],
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
- Use \`watch_token\`, \`list_watches\`, \`remove_watch\`, and \`check_watches\` to maintain and inspect watch-based monitoring.
- Use \`send_message\` to alert the user.
- Use \`publish_artifact\` to publish structured monitoring outputs.`,
  requiredTools: ['send_message', 'publish_artifact', 'list_positions', 'get_analytics', 'get_price', 'watch_token', 'list_watches', 'remove_watch', 'check_watches'],
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
 * `programming` skill — runs sandboxed code execution tasks.
 */
export const PROGRAMMING_SKILL: SkillDefinition = {
  id: 'programming',
  name: 'Programming',
  description: 'Run sandboxed code for analysis, calculations, and implementation support.',
  instructions: `You have access to programming tools.

- Use \`execute_code\` to run sandboxed JavaScript for analysis, calculations, and implementation support.
- Use \`send_message\` to report findings or ask for clarification when needed.
- Use \`publish_artifact\` when a structured output is more useful than plain text.`,
  requiredTools: ['execute_code', 'send_message', 'publish_artifact'],
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
- Use \`complete_task\` to mark a task as completed by its ID.
- Use \`schedule_reminder\` to schedule a one-shot reminder at a specific datetime. The reminder will wake you at the scheduled time with structured context.`,
  requiredTools: ['create_task', 'list_tasks', 'complete_task', 'schedule_reminder'],
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
  reminder: [],     // base only — sends scheduled alerts
  custom: [],       // user configures skills manually
};

/** All seeded system skills (excluding base which is auto-injected). */
export const SYSTEM_SKILLS: SkillDefinition[] = [
  BOT_MANAGEMENT_SKILL,
  TRADING_SKILL,
  RISK_MONITORING_SKILL,
  PROGRAMMING_SKILL,
  WEB_ACCESS_SKILL,
  TASK_MANAGEMENT_SKILL,
];
