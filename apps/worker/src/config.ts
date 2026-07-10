import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema } from '@herobids/domain';
import type { AppConfig } from '@herobids/domain';

// Resolve monorepo root relative to this file (works for both src/ and dist/ execution)
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const MONOREPO_CONFIG_DIR = resolve(MODULE_DIR, '../../../config');

type EnvType = 'string' | 'number' | 'boolean';

interface EnvOverride {
  path: string;
  type: EnvType;
}

const ENV_OVERRIDES: Record<string, EnvOverride> = {
  DATABASE_URL: { path: 'database.url', type: 'string' },
  REDIS_URL: { path: 'redis.url', type: 'string' },
  // Reconciliation
  RECONCILIATION_INTERVAL_MS: { path: 'reconciliation.intervalMs', type: 'number' },
  RECONCILIATION_DRIFT_ALERT_ONLY: { path: 'reconciliation.driftAlertOnly', type: 'boolean' },
  RECONCILIATION_POSITION_THRESHOLD: { path: 'reconciliation.positionDriftThreshold', type: 'string' },
  RECONCILIATION_BALANCE_THRESHOLD: { path: 'reconciliation.balanceDriftThreshold', type: 'string' },
  RECONCILIATION_AUTO_CORRECT: { path: 'reconciliation.autoCorrect', type: 'boolean' },
  // Streams
  STREAM_RECONNECT_BASE_MS: { path: 'streams.private.reconnectBaseMs', type: 'number' },
  STREAM_RECONNECT_MAX_MS: { path: 'streams.private.reconnectMaxMs', type: 'number' },
  STREAM_MAX_RECONNECT_ATTEMPTS: { path: 'streams.private.maxReconnectAttempts', type: 'number' },
  // Venues
  JUPITER_API_URL: { path: 'venues.jupiter.baseUrl', type: 'string' },
  HYPERLIQUID_BASE_URL: { path: 'venues.hyperliquid.baseUrl', type: 'string' },
  HYPERLIQUID_WS_URL: { path: 'venues.hyperliquid.wsUrl', type: 'string' },
  HYPERLIQUID_TESTNET: { path: 'venues.hyperliquid.testnet', type: 'boolean' },
  BYBIT_BASE_URL: { path: 'venues.bybit.baseUrl', type: 'string' },
  BYBIT_WS_URL: { path: 'venues.bybit.wsUrl', type: 'string' },
  BYBIT_WS_PUBLIC_URL: { path: 'venues.bybit.wsPublicUrl', type: 'string' },
  BYBIT_TESTNET: { path: 'venues.bybit.testnet', type: 'boolean' },
  ONEINCH_BASE_URL: { path: 'venues.1inch.baseUrl', type: 'string' },
  ONEINCH_RPC_URL: { path: 'venues.1inch.rpcUrl', type: 'string' },
  ONEINCH_CHAIN_ID: { path: 'venues.1inch.chainId', type: 'number' },
  ONEINCH_ROUTER_ADDRESS: { path: 'venues.1inch.routerAddress', type: 'string' },
  // Marking
  MARKING_STALENESS_MS: { path: 'marking.stalenessThresholdMs', type: 'number' },
  MARKING_ORACLE_BASE_URL: { path: 'marking.oracleBaseUrl', type: 'string' },
  // Backtesting
  BACKTEST_MAX_DATA_GAP_MS: { path: 'backtesting.maxDataGapMs', type: 'number' },
  // Live rollout
  LIVE_ROLLOUT_ENABLED: { path: 'liveRollout.enabled', type: 'boolean' },
  LIVE_ROLLOUT_MAX_ORDER_NOTIONAL_USD: { path: 'liveRollout.maxInitialOrderNotionalUsd', type: 'string' },
  // Alerts
  ALERTS_ENABLED: { path: 'alerts.enabled', type: 'boolean' },
  TELEGRAM_BOT_TOKEN: { path: 'alerts.telegram.botToken', type: 'string' },
  TELEGRAM_WEBHOOK_SECRET: { path: 'alerts.telegram.webhookSecret', type: 'string' },
  TELEGRAM_WEBHOOK_URL: { path: 'alerts.telegram.webhookUrl', type: 'string' },
  // Email — outbound provider (SES)
  EMAIL_PROVIDER: { path: 'alerts.email.provider', type: 'string' },
  EMAIL_FROM_EMAIL: { path: 'alerts.email.fromEmail', type: 'string' },
  EMAIL_REPLY_TO_EMAIL: { path: 'alerts.email.replyToEmail', type: 'string' },
  EMAIL_TIMEOUT_MS: { path: 'alerts.email.timeoutMs', type: 'number' },
  AWS_REGION: { path: 'alerts.email.ses.region', type: 'string' },
  SES_CONFIGURATION_SET_NAME: { path: 'alerts.email.ses.configurationSetName', type: 'string' },
  // Market data providers
  BIRDEYE_API_KEY: { path: 'marketData.birdeye.apiKey', type: 'string' },
  COINMARKETCAP_API_KEY: { path: 'marketData.coinMarketCap.apiKey', type: 'string' },
  // LLM runtime
  LLM_PROVIDER: { path: 'llm.provider', type: 'string' },
  LLM_MODEL: { path: 'llm.model', type: 'string' },
  LLM_BASE_URL: { path: 'llm.baseUrl', type: 'string' },
  LLM_MAX_TOKENS: { path: 'llm.maxTokens', type: 'number' },
  LLM_TIMEOUT_MS: { path: 'llm.timeoutMs', type: 'number' },
  LLM_TICK_INTERVAL_MS: { path: 'llm.tickIntervalMs', type: 'number' },
  LLM_HEARTBEAT_INTERVAL_MS: { path: 'llm.heartbeatIntervalMs', type: 'number' },
  LLM_SERVER_COST_USD_PER_HOUR: { path: 'llm.serverCostUsdPerHour', type: 'number' },
  // Billing
  BILLING_PRIMARY_PROVIDER: { path: 'billing.primaryProvider', type: 'string' },
  STRIPE_SECRET_KEY: { path: 'billing.stripe.secretKey', type: 'string' },
  STRIPE_WEBHOOK_SECRET: { path: 'billing.stripe.webhookSecret', type: 'string' },
  CREEM_API_KEY: { path: 'billing.creem.apiKey', type: 'string' },
  CREEM_WEBHOOK_SECRET: { path: 'billing.creem.webhookSecret', type: 'string' },
  // Auth
  AUTH_PUBLIC_BASE_URL: { path: 'auth.publicBaseUrl', type: 'string' },
  AUTH_JWT_SECRET: { path: 'auth.jwtSecret', type: 'string' },
  AUTH_JWT_TTL_SECS: { path: 'auth.jwtTtlSecs', type: 'number' },
  GOOGLE_CLIENT_ID: { path: 'auth.googleClientId', type: 'string' },
  GOOGLE_CLIENT_SECRET: { path: 'auth.googleClientSecret', type: 'string' },
  // Evaluation
  EVALUATION_STORAGE_ROOT: { path: 'evaluation.storageRoot', type: 'string' },
  // Shared-service connectivity — override with private IPs for cluster deployments
  SHARED_REDIS_HOST: { path: 'sharedServices.redisHost', type: 'string' },
  SHARED_REDIS_PORT: { path: 'sharedServices.redisPort', type: 'number' },
  SHARED_POSTGRES_HOST: { path: 'sharedServices.postgresHost', type: 'string' },
  SHARED_POSTGRES_PORT: { path: 'sharedServices.postgresPort', type: 'number' },
  SHARED_POSTGRES_USER: { path: 'sharedServices.postgresUser', type: 'string' },
  SHARED_POSTGRES_PASSWORD: { path: 'sharedServices.postgresPassword', type: 'string' },
  SHARED_POSTGRES_DATABASE: { path: 'sharedServices.postgresDatabase', type: 'string' },
  // Nomad
  NOMAD_TOKEN: { path: 'nomad.token', type: 'string' },
};

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) && tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function coerceEnvValue(raw: string, type: EnvType): unknown {
  switch (type) {
    case 'number': return Number(raw);
    case 'boolean': {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      throw new Error(`Invalid boolean env value: "${raw}" — must be true, false, 1, or 0`);
    }
    default: return raw;
  }
}

function applyEnvOverrides(merged: Record<string, unknown>): void {
  for (const [envVar, override] of Object.entries(ENV_OVERRIDES)) {
    const value = process.env[envVar];
    // Skip undefined and empty strings — empty string from docker-compose ${VAR:-} must not
    // stomp defaults set in default.yaml.
    if (value !== undefined && value !== '') {
      setNestedValue(merged, override.path, coerceEnvValue(value, override.type));
    }
  }
}

export function loadConfig(configDir?: string): AppConfig {
  const dir = configDir ?? MONOREPO_CONFIG_DIR;
  const defaultPath = resolve(dir, 'default.yaml');

  if (!existsSync(defaultPath)) {
    throw new Error(`Config file not found: ${defaultPath}`);
  }

  const base = parseYaml(readFileSync(defaultPath, 'utf8')) as Record<string, unknown>;

  const env = process.env['NODE_ENV'] ?? 'development';
  const envPath = resolve(dir, `${env}.yaml`);
  const envOverlay = existsSync(envPath)
    ? (parseYaml(readFileSync(envPath, 'utf8')) as Record<string, unknown>)
    : {};

  const merged = deepMerge(base, envOverlay);
  applyEnvOverrides(merged);

  const config = AppConfigSchema.parse(merged);

  if (env === 'production' && config.billing.primaryProvider === 'mock') {
    throw new Error(
      "billing.primaryProvider is 'mock' in a production environment — " +
      "set BILLING_PRIMARY_PROVIDER=creem (or stripe) in .env.prod or override billing.primaryProvider in config/production.yaml",
    );
  }

  // Warn if staging is accidentally connected to a real billing provider.
  // Staging should always use mock billing unless explicitly testing payments.
  if (env === 'staging' && config.billing.primaryProvider !== 'mock') {
    console.warn(
      `⚠️  staging is using billing.primaryProvider='${config.billing.primaryProvider}' (not mock). ` +
      'Real charges may apply. Override with BILLING_PRIMARY_PROVIDER=mock in .env.staging if unintended.',
    );
  }

  return config;
}
