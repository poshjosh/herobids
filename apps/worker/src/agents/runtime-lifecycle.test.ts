import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildAgentEnv,
  buildAgentLabels,
  buildRuntimeLaunchConfig,
} from './runtime-lifecycle.js';
import type { AgentEnvConfig, RuntimeResourceProfile } from '@herobids/domain';

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
