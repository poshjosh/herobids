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
  description: 'Core runtime tools: memory, messaging, and cost tracking. Auto-injected into every agent.',
  instructions: `You are a helpful autonomous agent. You have access to a memory store and can send messages to the user.
Always be concise, accurate, and act within your stated constraints.
Track your costs and report progress towards your goal.

To persist a note across ticks, call set_memory:
{"tool": "set_memory", "args": {"key": "<key>", "value": "<value>"}}`,
  requiredTools: ['send_message', 'artifact_publish', 'set_memory'],
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
  instructions: `You can create trading bots on behalf of the user.
When the user wants to trade, use create_bot to set up a bot with appropriate strategy and risk parameters.
Always start bots in paper mode first unless the user has explicitly requested live trading.
Never expose technical venue details (symbols like BTC-PERP) to the user — use plain language.`,
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
  description: 'Submit direct trade decisions and inspect trading state.',
  instructions: `You have access to direct trading tools.
- Use \`submit_decision\` to submit a trade intent for a specific instrument.
- Use \`check_regime\` to assess whether market conditions are favorable before trading.
  BTC is the default benchmark; other symbols can be specified.
- Use \`list_positions\` to check current open positions.
- Use \`search_tokens\` to find a token by name or symbol when you need its on-chain address.
  This is primarily used when preparing Jupiter DEX trades.`,
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
  instructions: `Monitor open positions and P&L continuously.
Alert the user via send_message when:
- Unrealized loss exceeds 5% of allocated capital
- A position has been open longer than the user's stated time horizon
- Market volatility spikes significantly
Use get_price for focused price checks and the watch_* tools to maintain threshold-based monitoring between ticks.`,
  requiredTools: ['send_message', 'artifact_publish', 'list_positions', 'get_analytics', 'get_price', 'watch_token', 'list_watches', 'remove_watch', 'check_watches'],
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
];
