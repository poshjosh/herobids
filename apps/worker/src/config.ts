import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema } from '@herobids/domain';
import type { AppConfig } from '@herobids/domain';

// Resolve monorepo root relative to this file (works for both src/ and dist/ execution)
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MONOREPO_CONFIG_DIR = resolve(MODULE_DIR, '../../../config');

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
  // Marking
  MARKING_STALENESS_MS: { path: 'marking.stalenessThresholdMs', type: 'number' },
  MARKING_ORACLE_BASE_URL: { path: 'marking.oracleBaseUrl', type: 'string' },
  // Backtesting
  BACKTEST_MAX_DATA_GAP_MS: { path: 'backtesting.maxDataGapMs', type: 'number' },
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
    if (value !== undefined) {
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

  return AppConfigSchema.parse(merged);
}
