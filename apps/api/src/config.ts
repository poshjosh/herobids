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
  // Billing
  BILLING_PRIMARY_PROVIDER: { path: 'billing.primaryProvider', type: 'string' },
  STRIPE_SECRET_KEY: { path: 'billing.stripe.secretKey', type: 'string' },
  STRIPE_WEBHOOK_SECRET: { path: 'billing.stripe.webhookSecret', type: 'string' },
  CREEM_API_KEY: { path: 'billing.creem.apiKey', type: 'string' },
  CREEM_WEBHOOK_SECRET: { path: 'billing.creem.webhookSecret', type: 'string' },
  TELEGRAM_BOT_TOKEN: { path: 'alerts.telegram.botToken', type: 'string' },
  TELEGRAM_WEBHOOK_SECRET: { path: 'alerts.telegram.webhookSecret', type: 'string' },
  TELEGRAM_WEBHOOK_URL: { path: 'alerts.telegram.webhookUrl', type: 'string' },
  // Market data providers
  BIRDEYE_API_KEY: { path: 'marketData.birdeye.apiKey', type: 'string' },

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

  if (env === 'production' && config.liveRollout.enabled && config.billing.primaryProvider === 'mock') {
    throw new Error(
      "billing.primaryProvider is 'mock' in a production environment with liveRollout enabled — " +
      "set BILLING_PRIMARY_PROVIDER=creem (or stripe) or add billing.primaryProvider to config/production.yaml",
    );
  }

  return config;
}
