import type { RuntimeResourceProfile, RuntimeLaunchConfig, SharedServicesConfig } from '@herobids/domain';

// ── Agent Env Config ────────────────────────────────────────────────────────

/**
 * Configuration needed to build agent runtime environment variables.
 * This is OpenAIdom lifecycle logic — the same set of env vars is injected
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
  /** OpenRouter provider controls (JSON) forwarded to agent for privacy enforcement. */
  openRouterProviderControlsJson?: string;
  /** Serialised external skills config (JSON) forwarded to agent containers. */
  externalSkillsConfigJson?: string;
  /** Browser pool URL forwarded to agent containers when browser pool is enabled. */
  browserPoolUrl?: string;
  /** Browserless API key forwarded to agent containers when browser pool is enabled. */
  browserPoolApiKey?: string;
  /**
   * Pre-resolved IP address for the browser pool hostname.
   * Docker service names (e.g. `browserless`) cannot resolve inside the sandbox
   * network namespace which uses public DNS. The caller resolves the hostname
   * to an IP before calling `buildAgentEnv()` so iptables rules work correctly.
   */
  browserPoolResolvedHost?: string;
  /**
   * Optional: Shared services cluster addresses for agent runtime connectivity.
   * When provided, REDIS_URL and DATABASE_URL are constructed from these
   * addresses instead of using the worker's own connection strings. This
   * ensures agent containers on remote Nomad nodes can reach shared services
   * via private IPs rather than local Compose service names.
   */
  sharedServices?: SharedServicesConfig;
}

// ── Env Building ────────────────────────────────────────────────────────────

/**
 * Build agent runtime environment variables from OpenAIdom config.
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
  // Resolve Redis URL: prefer shared-services cluster address, fall back to worker's URL.
  // sharedServices is always populated via config defaults (default.yaml → SharedServicesConfigSchema).
  // The fallback exists for programmatic callers that construct AgentEnvConfig manually (e.g., tests).
  const redisUrl = config.sharedServices
    ? `redis://${config.sharedServices.redisHost}:${config.sharedServices.redisPort}`
    : config.redisUrl;

  // Resolve Database URL: prefer shared-services cluster address, fall back to worker's URL or env.
  const resolvedEnv = processEnv ?? process.env;
  const databaseUrl = config.sharedServices
    ? `postgres://${config.sharedServices.postgresUser}:${config.sharedServices.postgresPassword}@${config.sharedServices.postgresHost}:${config.sharedServices.postgresPort}/${config.sharedServices.postgresDatabase}`
    : (config.databaseUrl ?? resolvedEnv['DATABASE_URL']);

  if (!databaseUrl) {
    throw new Error(
      `DATABASE_URL not available — agent container ${agentId} cannot launch. ` +
      'Direct DB access is required for list_bots, get_bot_status, and other agent tools.',
    );
  }

  const envOut: Record<string, string> = {
    REDIS_URL: redisUrl,
    DATABASE_URL: databaseUrl,
    AGENT_ID: agentId,
    SESSION_ID: sessionId,
    AGENT_CONFIG: agentConfigJson,
    TOOL_POLICY: toolPolicyJson,
    AGENT_RUNTIME_CONFIG_JSON: config.agentRuntimeConfigJson,
    AGENT_WORKSPACE_ROOT: '/workspace',
  };

  // Forward NODE_ENV so agent containers inherit the worker's environment
  // classification (development → pretty logs + debug level, etc.).
  const nodeEnv = resolvedEnv['NODE_ENV'];
  if (nodeEnv) envOut['NODE_ENV'] = nodeEnv;

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

  // LLM API keys — forwarded from worker environment.
  for (const key of ['LLM_API_KEY', 'LLM_API_KEY_DEEPSEEK', 'LLM_API_KEY_OPENROUTER', 'LLM_API_KEY_ANTHROPIC', 'LLM_API_KEY_OPENAI']) {
    if (resolvedEnv[key]) envOut[key] = resolvedEnv[key]!;
  }

  // Tavily API key for web search tool — optional.
  if (resolvedEnv['TAVILY_API_KEY']) envOut['TAVILY_API_KEY'] = resolvedEnv['TAVILY_API_KEY']!;

  // Scrapfly API key for Forex Factory Cloudflare bypass — optional.
  if (resolvedEnv['SCRAPFLY_API_KEY']) envOut['SCRAPFLY_API_KEY'] = resolvedEnv['SCRAPFLY_API_KEY']!;

  // Usage billing — forwarded to agent containers for LLM event recording.
  if (resolvedEnv['USAGE_BILLING_RATE_CARD']) envOut['USAGE_BILLING_RATE_CARD'] = resolvedEnv['USAGE_BILLING_RATE_CARD']!;
  if (resolvedEnv['USAGE_BILLING_RUNTIME_WINDOW_MS']) envOut['USAGE_BILLING_RUNTIME_WINDOW_MS'] = resolvedEnv['USAGE_BILLING_RUNTIME_WINDOW_MS']!;

  // Providers YAML — forward for per-model rate-card seeding inside the container.
  if (config.providersYamlJson) envOut['PROVIDERS_YAML'] = config.providersYamlJson;

  // OpenRouter provider controls — forward for privacy enforcement inside the container.
  if (config.openRouterProviderControlsJson) envOut['OPENROUTER_PROVIDER_CONTROLS'] = config.openRouterProviderControlsJson;

  // Credential encryption key — needed by the agent for venue account and Gmail OAuth token decryption.
  if (resolvedEnv['CREDENTIAL_ENCRYPTION_KEY']) envOut['CREDENTIAL_ENCRYPTION_KEY'] = resolvedEnv['CREDENTIAL_ENCRYPTION_KEY']!;

  // Gmail OAuth integration — forwarded so agents can use the send_email tool.
  if (resolvedEnv['GMAIL_CLIENT_ID']) envOut['GMAIL_CLIENT_ID'] = resolvedEnv['GMAIL_CLIENT_ID']!;
  if (resolvedEnv['GMAIL_CLIENT_SECRET']) envOut['GMAIL_CLIENT_SECRET'] = resolvedEnv['GMAIL_CLIENT_SECRET']!;
  if (resolvedEnv['GMAIL_REDIRECT_URI']) envOut['GMAIL_REDIRECT_URI'] = resolvedEnv['GMAIL_REDIRECT_URI']!;
  if (resolvedEnv['GMAIL_DAILY_SEND_LIMIT']) envOut['GMAIL_DAILY_SEND_LIMIT'] = resolvedEnv['GMAIL_DAILY_SEND_LIMIT']!;

  // External skills config — forwarded so agents can use the search_skills tool.
  if (config.externalSkillsConfigJson) envOut['EXTERNAL_SKILLS_CONFIG_JSON'] = config.externalSkillsConfigJson;

  // Browser pool URL — forwarded so agents can use the browse_interactive tool.
  if (config.browserPoolUrl) {
    envOut['BROWSER_POOL_URL'] = config.browserPoolUrl;

    // agent-browser CLI — connect via CDP (Chrome DevTools Protocol).
    // The browserPool URL is an HTTP endpoint; the CDP websocket is at the same host.
    // agent-browser reads cdp from AGENT_BROWSER_CONFIG or --cdp flag.
    //
    // IMPORTANT: Use the pre-resolved IP (not the Docker hostname) for the CDP URL.
    // The sandbox network namespace (sandbox-exec.sh) replaces Docker's DNS with
    // public nameservers (8.8.8.8), so Docker-internal hostnames like "browser-pool"
    // are unresolvable inside the sandbox. The resolved IP is already allowlisted
    // in SANDBOX_ALLOWED_HOSTS for the same reason.
    const browserUrl = new URL(config.browserPoolUrl);
    const sandboxHost = config.browserPoolResolvedHost ?? browserUrl.hostname;
    const cdpUrl = `ws://${sandboxHost}:${browserUrl.port || '3000'}`;
    envOut['AGENT_BROWSER_CDP_URL'] = cdpUrl;

    // Use pre-resolved IP for sandbox allowlist (Docker hostnames can't resolve inside sandbox).
    // Fall back to hostname extraction if no pre-resolved value (e.g. when URL is already an IP).
    envOut['SANDBOX_ALLOWED_HOSTS'] = sandboxHost;
  }
  if (config.browserPoolApiKey) {
    envOut['BROWSERLESS_API_KEY'] = config.browserPoolApiKey;
  }

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
 * Assemble a complete, scheduler-neutral launch config from OpenAIdom agent data.
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
