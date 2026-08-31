import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildAgentEnv,
  buildAgentLabels,
  buildRuntimeLaunchConfig,
} from './runtime-lifecycle.js';
import type { AgentEnvConfig, RuntimeResourceProfile, SharedServicesConfig } from '@herobids/domain';

const BASE_ENV_CONFIG: AgentEnvConfig = {
  redisUrl: 'redis://localhost:6379',
  databaseUrl: 'postgres://localhost:5432/herobids',
  agentRuntimeConfigJson: JSON.stringify({ budgets: { maxHistoryMessages: 20 } }),
  llmProvider: 'openrouter',
  llmBaseUrl: 'https://api.openrouter.ai/v1',
  llmModel: 'gpt-4o',
  llmMaxTokens: 4096,
  llmTimeoutMs: 30000,
  llmTickIntervalMs: 5000,
  llmHeartbeatIntervalMs: 10000,
  llmServerCostUsdPerHour: 0.5,
  llmTradingHoursJson: JSON.stringify({ enabled: true }),
  marketDataConfigJson: JSON.stringify({ dexscreener: { rpm: 60 } }),
  marketDataDexscreenerBaseUrl: 'https://api.dexscreener.com',
  marketDataDexscreenerRpm: 60,
  marketDataBinanceBaseUrl: 'https://api.binance.com',
  marketDataBinanceRpm: 30,
  marketDataTimeoutMs: 10000,
};

const RESOURCES: RuntimeResourceProfile = {
  memoryLimitMb: 512,
  cpuShares: 256,
  maxProcesses: 10,
  tempStorageMb: 100,
  maxWallClockMs: 3600000,
};

describe('buildAgentEnv', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env['LLM_API_KEY'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['SCRAPFLY_API_KEY'];
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('includes required base env vars', () => {
    const env = buildAgentEnv(
      'agent-1',
      'sess-1',
      JSON.stringify({ mode: 'test' }),
      JSON.stringify({ allow: ['*'] }),
      BASE_ENV_CONFIG,
    );

    expect(env['REDIS_URL']).toBe('redis://localhost:6379');
    expect(env['AGENT_ID']).toBe('agent-1');
    expect(env['SESSION_ID']).toBe('sess-1');
    expect(env['AGENT_CONFIG']).toBe(JSON.stringify({ mode: 'test' }));
    expect(env['TOOL_POLICY']).toBe(JSON.stringify({ allow: ['*'] }));
    expect(env['AGENT_RUNTIME_CONFIG_JSON']).toBe(BASE_ENV_CONFIG.agentRuntimeConfigJson);
    expect(env['AGENT_WORKSPACE_ROOT']).toBe('/workspace');
  });

  it('includes LLM config when provided', () => {
    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);

    expect(env['LLM_PROVIDER']).toBe('openrouter');
    expect(env['LLM_BASE_URL']).toBe('https://api.openrouter.ai/v1');
    expect(env['LLM_MODEL']).toBe('gpt-4o');
    expect(env['LLM_MAX_TOKENS']).toBe('4096');
    expect(env['LLM_TIMEOUT_MS']).toBe('30000');
  });

  it('omits optional LLM fields when absent', () => {
    const config: AgentEnvConfig = {
      redisUrl: 'redis://localhost:6379',
      databaseUrl: 'postgres://localhost:5432/herobids',
      agentRuntimeConfigJson: '{}',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);

    expect(env['LLM_PROVIDER']).toBeUndefined();
    expect(env['LLM_BASE_URL']).toBeUndefined();
    expect(env['LLM_MODEL']).toBeUndefined();
  });

  it('includes DATABASE_URL from config', () => {
    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);
    expect(env['DATABASE_URL']).toBe('postgres://localhost:5432/herobids');
  });

  it('throws when DATABASE_URL is missing entirely', () => {
    const config: AgentEnvConfig = {
      redisUrl: 'redis://localhost:6379',
      agentRuntimeConfigJson: '{}',
      // databaseUrl omitted
    };
    delete process.env['DATABASE_URL'];

    expect(() => buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config))
      .toThrow(/DATABASE_URL not available/);
  });

  it('falls back to process.env DATABASE_URL', () => {
    process.env['DATABASE_URL'] = 'postgres://env:5432/db';
    const config: AgentEnvConfig = {
      redisUrl: 'redis://localhost:6379',
      agentRuntimeConfigJson: '{}',
      // databaseUrl omitted — should fall back to env
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['DATABASE_URL']).toBe('postgres://env:5432/db');
  });

  it('forwards LLM API keys from process.env', () => {
    process.env['LLM_API_KEY'] = 'sk-test-key';

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);
    expect(env['LLM_API_KEY']).toBe('sk-test-key');
  });

  it('forwards Tavily API key from process.env when present', () => {
    process.env['TAVILY_API_KEY'] = 'tvly-test';

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);
    expect(env['TAVILY_API_KEY']).toBe('tvly-test');
  });

  it('omits Tavily API key when not in env', () => {
    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);
    expect(env['TAVILY_API_KEY']).toBeUndefined();
  });

  it('forwards Scrapfly API key from process.env when present', () => {
    process.env['SCRAPFLY_API_KEY'] = 'scrapfly-test-key';

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);
    expect(env['SCRAPFLY_API_KEY']).toBe('scrapfly-test-key');
  });

  it('omits Scrapfly API key when not in env', () => {
    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);
    expect(env['SCRAPFLY_API_KEY']).toBeUndefined();
  });

  it('sets MARKET_DATA_CONFIGURED when both DexScreener and Binance are present', () => {
    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);
    expect(env['MARKET_DATA_CONFIGURED']).toBe('1');
  });

  it('omits MARKET_DATA_CONFIGURED when providers are missing', () => {
    const config: AgentEnvConfig = {
      redisUrl: 'redis://localhost:6379',
      databaseUrl: 'postgres://localhost:5432/herobids',
      agentRuntimeConfigJson: '{}',
    };
    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['MARKET_DATA_CONFIGURED']).toBeUndefined();
  });

  it('includes usage billing env vars when available', () => {
    process.env['USAGE_BILLING_RATE_CARD'] = JSON.stringify({ gpt4o: 5 });
    process.env['USAGE_BILLING_RUNTIME_WINDOW_MS'] = '60000';

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);
    expect(env['USAGE_BILLING_RATE_CARD']).toBe(JSON.stringify({ gpt4o: 5 }));
    expect(env['USAGE_BILLING_RUNTIME_WINDOW_MS']).toBe('60000');
  });

  it('includes providers YAML when configured', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      providersYamlJson: JSON.stringify({ providers: { openai: {} } }),
    };
    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['PROVIDERS_YAML']).toBe(JSON.stringify({ providers: { openai: {} } }));
  });

  it('includes EXTERNAL_SKILLS_CONFIG_JSON when externalSkillsConfigJson is set', () => {
    const externalSkillsJson = JSON.stringify({
      baseUrl: 'http://mastra.local:3456',
      searchApiBaseUrl: 'https://skills.sh',
      searchTimeoutMs: 5000,
      browseTimeoutMs: 5000,
      statsTimeoutMs: 3000,
    });
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      externalSkillsConfigJson: externalSkillsJson,
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['EXTERNAL_SKILLS_CONFIG_JSON']).toBe(externalSkillsJson);
  });

  it('omits EXTERNAL_SKILLS_CONFIG_JSON when externalSkillsConfigJson is undefined', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      // externalSkillsConfigJson not set
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['EXTERNAL_SKILLS_CONFIG_JSON']).toBeUndefined();
  });

  it('includes OPENROUTER_PROVIDER_CONTROLS when openRouterProviderControlsJson is set', () => {
    const controlsJson = JSON.stringify({ dataPolicy: 'deny-all' });
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      openRouterProviderControlsJson: controlsJson,
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['OPENROUTER_PROVIDER_CONTROLS']).toBe(controlsJson);
  });

  it('omits OPENROUTER_PROVIDER_CONTROLS when openRouterProviderControlsJson is undefined', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      // openRouterProviderControlsJson not set
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['OPENROUTER_PROVIDER_CONTROLS']).toBeUndefined();
  });

  it('constructs REDIS_URL from sharedServices when provided', () => {
    const sharedServices: SharedServicesConfig = {
      redisHost: 'redis.internal',
      redisPort: 6380,
      postgresHost: 'pg.internal',
      postgresPort: 5432,
      postgresUser: 'herobids',
      postgresPassword: 'secret',
      postgresDatabase: 'herobids',
    };

    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      sharedServices,
      // redisUrl should be ignored when sharedServices is set
      redisUrl: 'redis://should-be-ignored:6379',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['REDIS_URL']).toBe('redis://redis.internal:6380');
  });

  it('constructs DATABASE_URL from sharedServices when provided', () => {
    const sharedServices: SharedServicesConfig = {
      redisHost: 'redis.internal',
      redisPort: 6379,
      postgresHost: '10.0.0.50',
      postgresPort: 5433,
      postgresUser: 'appuser',
      postgresPassword: 's3cr3t',
      postgresDatabase: 'herobids_prod',
    };

    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      sharedServices,
      // databaseUrl should be ignored when sharedServices is set
      databaseUrl: 'postgres://should-be-ignored:5432/herobids',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['DATABASE_URL']).toBe('postgres://appuser:s3cr3t@10.0.0.50:5433/herobids_prod');
  });

  it('skips databaseUrl fallback when sharedServices is provided', () => {
    // When sharedServices is present, DATABASE_URL is built from sharedServices.
    // The config.databaseUrl / process.env fallback path is never entered,
    // so a missing databaseUrl in config should NOT throw.
    const sharedServices: SharedServicesConfig = {
      redisHost: 'redis.shared',
      redisPort: 6379,
      postgresHost: 'pg.shared',
      postgresPort: 5432,
      postgresUser: 'herobids',
      postgresPassword: 'herobids',
      postgresDatabase: 'herobids',
    };

    const config: AgentEnvConfig = {
      redisUrl: 'redis://localhost:6379',
      agentRuntimeConfigJson: '{}',
      sharedServices,
      // databaseUrl intentionally omitted
    };
    delete process.env['DATABASE_URL'];

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['DATABASE_URL']).toBe('postgres://herobids:herobids@pg.shared:5432/herobids');
    expect(env['REDIS_URL']).toBe('redis://redis.shared:6379');
  });

  // ── Browser pool env vars ───────────────────────────────────────────────

  it('omits browser pool env vars when browserPoolUrl is not set', () => {
    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', BASE_ENV_CONFIG);
    expect(env['BROWSER_POOL_URL']).toBeUndefined();
    expect(env['AGENT_BROWSER_CDP_URL']).toBeUndefined();
    expect(env['SANDBOX_ALLOWED_HOSTS']).toBeUndefined();
    expect(env['BROWSERLESS_API_KEY']).toBeUndefined();
  });

  it('sets browser pool env vars when browserPoolUrl is set', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolUrl: 'http://browserless:3000',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['BROWSER_POOL_URL']).toBe('http://browserless:3000');
    // Falls back to hostname when no resolved IP is provided
    expect(env['AGENT_BROWSER_CDP_URL']).toBe('ws://browserless:3000');
    expect(env['SANDBOX_ALLOWED_HOSTS']).toBe('browserless');
  });

  it('extracts hostname from browserPoolUrl with port for SANDBOX_ALLOWED_HOSTS', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolUrl: 'http://browser.internal:8080',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['AGENT_BROWSER_CDP_URL']).toBe('ws://browser.internal:8080');
    expect(env['SANDBOX_ALLOWED_HOSTS']).toBe('browser.internal');
  });

  it('defaults to port 3000 in CDP URL when browserPoolUrl has no explicit port', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolUrl: 'http://browserless',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['AGENT_BROWSER_CDP_URL']).toBe('ws://browserless:3000');
    expect(env['SANDBOX_ALLOWED_HOSTS']).toBe('browserless');
  });

  it('passes IP address through for SANDBOX_ALLOWED_HOSTS when URL uses IP', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolUrl: 'http://172.18.0.5:3000',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['SANDBOX_ALLOWED_HOSTS']).toBe('172.18.0.5');
  });

  it('uses browserPoolResolvedHost for SANDBOX_ALLOWED_HOSTS when provided', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolUrl: 'http://browserless:3000',
      browserPoolResolvedHost: '172.18.0.5',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['SANDBOX_ALLOWED_HOSTS']).toBe('172.18.0.5');
    // CDP URL must use the resolved IP so agent-browser works inside the sandbox
    // (sandbox DNS can't resolve Docker hostnames)
    expect(env['AGENT_BROWSER_CDP_URL']).toBe('ws://172.18.0.5:3000');
  });

  it('falls back to hostname extraction when browserPoolResolvedHost is not set', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolUrl: 'http://browserless:3000',
      // browserPoolResolvedHost intentionally omitted
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['SANDBOX_ALLOWED_HOSTS']).toBe('browserless');
  });

  it('omits BROWSERLESS_API_KEY when browserPoolApiKey is not set', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolUrl: 'http://browserless:3000',
      // browserPoolApiKey intentionally omitted
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['BROWSERLESS_API_KEY']).toBeUndefined();
  });

  it('sets BROWSERLESS_API_KEY when browserPoolApiKey is provided', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolUrl: 'http://browserless:3000',
      browserPoolApiKey: 'my-api-key',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['BROWSERLESS_API_KEY']).toBe('my-api-key');
  });

  it('sets BROWSERLESS_API_KEY even without browserPoolUrl', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolApiKey: 'standalone-key',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['BROWSERLESS_API_KEY']).toBe('standalone-key');
    // Without browserPoolUrl, the other browser vars should be absent
    expect(env['AGENT_BROWSER_CDP_URL']).toBeUndefined();
    expect(env['SANDBOX_ALLOWED_HOSTS']).toBeUndefined();
  });

  it('sets all browser pool env vars when both url and apiKey are provided', () => {
    const config: AgentEnvConfig = {
      ...BASE_ENV_CONFIG,
      browserPoolUrl: 'http://browserless.prod:3000',
      browserPoolApiKey: 'prod-key-123',
    };

    const env = buildAgentEnv('agent-1', 'sess-1', '{}', '{}', config);
    expect(env['BROWSER_POOL_URL']).toBe('http://browserless.prod:3000');
    // Falls back to hostname when no resolved IP is provided
    expect(env['AGENT_BROWSER_CDP_URL']).toBe('ws://browserless.prod:3000');
    expect(env['SANDBOX_ALLOWED_HOSTS']).toBe('browserless.prod');
    expect(env['BROWSERLESS_API_KEY']).toBe('prod-key-123');
  });
});

describe('buildAgentLabels', () => {
  it('returns standard agent labels', () => {
    const labels = buildAgentLabels('agent-1', 'sess-1');
    expect(labels['herobids.role']).toBe('agent');
    expect(labels['herobids.agentId']).toBe('agent-1');
    expect(labels['herobids.sessionId']).toBe('sess-1');
  });
});

describe('buildRuntimeLaunchConfig', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env['LLM_API_KEY'];
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('assembles a complete launch config with env and labels', () => {
    const config = buildRuntimeLaunchConfig({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      image: 'herobids-agent:latest',
      agentConfigJson: JSON.stringify({ mode: 'test' }),
      toolPolicyJson: JSON.stringify({ allow: ['*'] }),
      envConfig: BASE_ENV_CONFIG,
      resources: RESOURCES,
      network: 'herobids_default',
    });

    expect(config.agentId).toBe('agent-1');
    expect(config.sessionId).toBe('sess-1');
    expect(config.image).toBe('herobids-agent:latest');
    expect(config.env['REDIS_URL']).toBe('redis://localhost:6379');
    expect(config.env['AGENT_ID']).toBe('agent-1');
    expect(config.labels['herobids.role']).toBe('agent');
    expect(config.resources.memoryLimitMb).toBe(512);
    expect(config.resources.cpuShares).toBe(256);
    expect(config.network).toBe('herobids_default');
  });

  it('uses the env and labels built by the shared functions', () => {
    const config = buildRuntimeLaunchConfig({
      agentId: 'agent-x',
      sessionId: 'sess-x',
      image: 'test-image:latest',
      agentConfigJson: '{}',
      toolPolicyJson: '{}',
      envConfig: BASE_ENV_CONFIG,
      resources: RESOURCES,
    });

    // Env is built by buildAgentEnv — verify key fields are present.
    expect(config.env['AGENT_ID']).toBe('agent-x');
    expect(config.env['SESSION_ID']).toBe('sess-x');
    expect(config.env['REDIS_URL']).toBe('redis://localhost:6379');

    // Labels are built by buildAgentLabels.
    expect(config.labels['herobids.agentId']).toBe('agent-x');
    expect(config.labels['herobids.sessionId']).toBe('sess-x');
  });
});
