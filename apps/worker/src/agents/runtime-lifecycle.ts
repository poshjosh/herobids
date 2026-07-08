import type { RuntimeResourceProfile, RuntimeLaunchConfig } from '@herobids/domain';

// ── Agent Env Config ────────────────────────────────────────────────────────

/**
 * Configuration needed to build agent runtime environment variables.
 * This is HeroBids lifecycle logic — the same set of env vars is injected
 * regardless of whether the runtime runs via Docker, Nomad, or ECS.
 */
export interface AgentEnvConfig {
  redisUrl: string;
  databaseUrl?: string;
  agentRuntimeConfigJson: string;
  llmProvider?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  llmMaxTokens?: number;
  llmTimeoutMs?: number;
  llmTickIntervalMs?: number;
  llmHeartbeatIntervalMs?: number;
  llmServerCostUsdPerHour?: number;
  llmTradingHoursJson?: string;
  marketDataConfigJson?: string;
  marketDataDexscreenerBaseUrl?: string;
  marketDataDexscreenerRpm?: number;
  marketDataBinanceBaseUrl?: string;
  marketDataBinanceRpm?: number;
  marketDataTimeoutMs?: number;
  /** Providers YAML serialised to JSON, forwarded to agent for rate-card seeding. */
  providersYamlJson?: string;
}

// ── Env Building ────────────────────────────────────────────────────────────

/**
 * Build agent runtime environment variables from HeroBids config.
 *
 * This is shared lifecycle logic — env var injection is the same regardless
 * of the scheduler backend. Each adapter transforms the returned key-value
 * map into its native format (Docker string array, Nomad env map, etc.).
 */
export function buildAgentEnv(
  agentId: string,
  sessionId: string,
  agentConfigJson: string,
  toolPolicyJson: string,
  config: AgentEnvConfig,
  processEnv?: NodeJS.ProcessEnv,
): Record<string, string> {
  const envOut: Record<string, string> = {
    REDIS_URL: config.redisUrl,
    AGENT_ID: agentId,
    SESSION_ID: sessionId,
    AGENT_CONFIG: agentConfigJson,
    TOOL_POLICY: toolPolicyJson,
    AGENT_RUNTIME_CONFIG_JSON: config.agentRuntimeConfigJson,
    AGENT_WORKSPACE_ROOT: '/workspace',
  };

  if (config.llmProvider) envOut['LLM_PROVIDER'] = config.llmProvider;
  if (config.llmBaseUrl) envOut['LLM_BASE_URL'] = config.llmBaseUrl;
  if (config.llmModel) envOut['LLM_MODEL'] = config.llmModel;
  if (config.llmMaxTokens != null) envOut['LLM_MAX_TOKENS'] = String(config.llmMaxTokens);
  if (config.llmTimeoutMs != null) envOut['LLM_TIMEOUT_MS'] = String(config.llmTimeoutMs);
  if (config.llmTickIntervalMs != null) envOut['TICK_INTERVAL_MS'] = String(config.llmTickIntervalMs);
  if (config.llmHeartbeatIntervalMs != null) envOut['HEARTBEAT_INTERVAL_MS'] = String(config.llmHeartbeatIntervalMs);
  if (config.llmServerCostUsdPerHour != null) envOut['LLM_SERVER_COST_USD_PER_HOUR'] = String(config.llmServerCostUsdPerHour);
  if (config.llmTradingHoursJson) envOut['TRADING_HOURS_JSON'] = config.llmTradingHoursJson;
  if (config.marketDataConfigJson) envOut['MARKET_DATA_CONFIG_JSON'] = config.marketDataConfigJson;

  if (config.marketDataDexscreenerBaseUrl && config.marketDataBinanceBaseUrl) {
    envOut['MARKET_DATA_CONFIGURED'] = '1';
  }
  if (config.marketDataDexscreenerBaseUrl) envOut['DEXSCREENER_BASE_URL'] = config.marketDataDexscreenerBaseUrl;
  if (config.marketDataDexscreenerRpm != null) envOut['DEXSCREENER_RPM'] = String(config.marketDataDexscreenerRpm);
  if (config.marketDataBinanceBaseUrl) envOut['BINANCE_BASE_URL'] = config.marketDataBinanceBaseUrl;
  if (config.marketDataBinanceRpm != null) envOut['BINANCE_RPM'] = String(config.marketDataBinanceRpm);
  if (config.marketDataTimeoutMs != null) envOut['MARKET_DATA_TIMEOUT_MS'] = String(config.marketDataTimeoutMs);

  // Database URL — fail fast if unavailable (required for agent tool behaviour).
  const dbUrl = config.databaseUrl ?? (processEnv ?? process.env)['DATABASE_URL'];
  if (!dbUrl) {
    throw new Error(
      `DATABASE_URL not available — agent container ${agentId} cannot launch. ` +
      'Direct DB access is required for list_bots, get_bot_status, and other agent tools.',
    );
  }
  envOut['DATABASE_URL'] = dbUrl;

  // LLM API keys — forwarded from worker environment.
  const resolvedEnv = processEnv ?? process.env;
  for (const key of ['LLM_API_KEY', 'LLM_API_KEY_DEEPSEEK', 'LLM_API_KEY_OPENROUTER', 'LLM_API_KEY_ANTHROPIC', 'LLM_API_KEY_OPENAI']) {
    if (resolvedEnv[key]) envOut[key] = resolvedEnv[key]!;
  }

  // Tavily API key for web search tool — optional.
  if (resolvedEnv['TAVILY_API_KEY']) envOut['TAVILY_API_KEY'] = resolvedEnv['TAVILY_API_KEY']!;

  // Usage billing — forwarded to agent containers for LLM event recording.
  if (resolvedEnv['USAGE_BILLING_RATE_CARD']) envOut['USAGE_BILLING_RATE_CARD'] = resolvedEnv['USAGE_BILLING_RATE_CARD']!;
  if (resolvedEnv['USAGE_BILLING_RUNTIME_WINDOW_MS']) envOut['USAGE_BILLING_RUNTIME_WINDOW_MS'] = resolvedEnv['USAGE_BILLING_RUNTIME_WINDOW_MS']!;

  // Providers YAML — forward for per-model rate-card seeding inside the container.
  if (config.providersYamlJson) envOut['PROVIDERS_YAML'] = config.providersYamlJson;

  return envOut;
}

// ── Labels ──────────────────────────────────────────────────────────────────

/**
 * Build standard agent runtime metadata labels.
 * Adapters attach these as scheduler-native metadata (Docker labels, Nomad meta, etc.).
 */
export function buildAgentLabels(agentId: string, sessionId: string): Record<string, string> {
  return {
    'herobids.role': 'agent',
    'herobids.agentId': agentId,
    'herobids.sessionId': sessionId,
  };
}

// ── Launch Config Builder ───────────────────────────────────────────────────

/**
 * Assemble a complete, scheduler-neutral launch config from HeroBids agent data.
 * Returns a `RuntimeLaunchConfig` that any `RuntimePort` adapter can consume.
 */
export function buildRuntimeLaunchConfig(params: {
  agentId: string;
  sessionId: string;
  image: string;
  agentConfigJson: string;
  toolPolicyJson: string;
  envConfig: AgentEnvConfig;
  resources: RuntimeResourceProfile;
  network?: string;
}): RuntimeLaunchConfig {
  return {
    agentId: params.agentId,
    sessionId: params.sessionId,
    image: params.image,
    env: buildAgentEnv(
      params.agentId,
      params.sessionId,
      params.agentConfigJson,
      params.toolPolicyJson,
      params.envConfig,
    ),
    labels: buildAgentLabels(params.agentId, params.sessionId),
    resources: params.resources,
    network: params.network,
  };
}
