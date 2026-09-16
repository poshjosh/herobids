import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema } from '@herobids/domain';
import type { AppConfig } from '@herobids/domain';

// Resolve monorepo root relative to this file (works for both src/ and dist/ execution)
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MONOREPO_CONFIG_DIR = resolve(MODULE_DIR, '../../../config');

type EnvType = 'string' | 'number' | 'boolean' | 'string-array';

interface EnvOverride {
  path: string;
  type: EnvType;
}

const ENV_OVERRIDES: Record<string, EnvOverride> = {
  // App
  PORT: { path: 'app.port', type: 'number' },
  DATABASE_URL: { path: 'database.url', type: 'string' },
  REDIS_URL: { path: 'redis.url', type: 'string' },
  // Auth
  AUTH_PUBLIC_BASE_URL: { path: 'auth.publicBaseUrl', type: 'string' },
  AUTH_FRONTEND_ORIGIN: { path: 'auth.frontendOrigin', type: 'string' },
  AUTH_JWT_SECRET: { path: 'auth.jwtSecret', type: 'string' },
  AUTH_JWT_TTL_SECS: { path: 'auth.jwtTtlSecs', type: 'number' },
  AUTH_EXCHANGE_CODE_TTL_SECS: { path: 'auth.exchangeCodeTtlSecs', type: 'number' },
  GOOGLE_CLIENT_ID: { path: 'auth.googleClientId', type: 'string' },
  GOOGLE_CLIENT_SECRET: { path: 'auth.googleClientSecret', type: 'string' },
  AUTH_LOGIN_LINK_TTL_SECS: { path: 'auth.loginLinkTtlSecs', type: 'number' },
  AUTH_LOGIN_LINK_RESEND_COOLDOWN_SECS: { path: 'auth.loginLinkResendCooldownSecs', type: 'number' },
  AUTH_LOGIN_LINK_MAX_SENDS_PER_WINDOW: { path: 'auth.loginLinkMaxSendsPerWindow', type: 'number' },
  AUTH_LOGIN_LINK_WINDOW_SECS: { path: 'auth.loginLinkWindowSecs', type: 'number' },
  AUTH_LOGIN_LINK_MAX_SENDS_PER_IP_WINDOW: { path: 'auth.loginLinkMaxSendsPerIpWindow', type: 'number' },
  // Billing
  BILLING_PRIMARY_PROVIDER: { path: 'billing.primaryProvider', type: 'string' },
  STRIPE_SECRET_KEY: { path: 'billing.stripe.secretKey', type: 'string' },
  STRIPE_WEBHOOK_SECRET: { path: 'billing.stripe.webhookSecret', type: 'string' },
  CREEM_API_KEY: { path: 'billing.creem.apiKey', type: 'string' },
  CREEM_WEBHOOK_SECRET: { path: 'billing.creem.webhookSecret', type: 'string' },
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
  // Evaluation
  EVALUATION_STORAGE_ROOT: { path: 'evaluation.storageRoot', type: 'string' },
  // Market data providers
  BIRDEYE_API_KEY: { path: 'marketData.birdeye.apiKey', type: 'string' },
  COINGECKO_API_KEY: { path: 'marketData.geckoterminal.apiKey', type: 'string' },
  COINMARKETCAP_API_KEY: { path: 'marketData.coinMarketCap.apiKey', type: 'string' },
  // Venue developer-platform keys
  JUPITER_API_KEY: { path: 'venues.jupiter.apiKey', type: 'string' },
  ONEINCH_API_KEY: { path: 'venues.1inch.apiKey', type: 'string' },
  // Gmail OAuth integration
  GMAIL_CLIENT_ID: { path: 'integrations.gmail.clientId', type: 'string' },
  GMAIL_CLIENT_SECRET: { path: 'integrations.gmail.clientSecret', type: 'string' },
  GMAIL_REDIRECT_URI: { path: 'integrations.gmail.redirectUri', type: 'string' },
  // Traderton REST boundary (L3) — MUST mirror apps/worker/src/config.ts. The API
  // builds its TradertonClient from boundary.baseUrl + boundary.hmacSecret
  // (apps/api/src/index.ts); without these overrides the config never picks up
  // the operator env, the client is never constructed, and every trading route
  // fail-closes to precondition.not_ready (503).
  TRADERTON_BOUNDARY_URL: { path: 'boundary.baseUrl', type: 'string' },
  TRADERTON_BOUNDARY_HMAC_SECRET: { path: 'boundary.hmacSecret', type: 'string' },
  TRADERTON_BOUNDARY_CONSUMER_ID: { path: 'boundary.consumerId', type: 'string' },
  TRADERTON_BOUNDARY_KEY_ID: { path: 'boundary.keyId', type: 'string' },
  TRADERTON_BOUNDARY_TIMEOUT_MS: { path: 'boundary.requestTimeoutMs', type: 'number' },

};

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
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
    case 'string-array':
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    default: return raw;
  }
}

function applyEnvOverrides(merged: Record<string, unknown>): void {
  for (const [envVar, override] of Object.entries(ENV_OVERRIDES)) {
    const value = process.env[envVar];
    // Skip empty strings so docker-compose ${VAR:-} passthrough entries do not stomp YAML defaults.
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
