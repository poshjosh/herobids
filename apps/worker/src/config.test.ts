import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Minimal required fields for AppConfigSchema
const BASE_YAML = `
app:
  port: 3000
database:
  url: postgres://localhost/test
redis:
  url: redis://localhost:6379
execution:
  defaultSlippageBps: 50
risk:
  globalMaxDrawdownPct: 20
`;

describe('loadConfig', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'herobids-config-test-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and parses default.yaml', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
venues:
  hyperliquid:
    baseUrl: https://api.hyperliquid.xyz
`);

    const config = loadConfig(tmpDir);

    expect(config.database.url).toBe('postgres://localhost/test');
    expect(config.venues['hyperliquid']?.baseUrl).toBe('https://api.hyperliquid.xyz');
  });

  it('throws when default.yaml is missing', () => {
    expect(() => loadConfig(tmpDir)).toThrow('Config file not found');
  });

  it('overlays NODE_ENV-specific config', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    writeFileSync(resolve(tmpDir, 'production.yaml'), `
database:
  url: postgres://prod-host/herobids
`);
    process.env['NODE_ENV'] = 'production';

    const config = loadConfig(tmpDir);

    expect(config.database.url).toBe('postgres://prod-host/herobids');
  });

  it('applies DATABASE_URL env override', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['DATABASE_URL'] = 'postgres://override-host/overridden';

    const config = loadConfig(tmpDir);

    expect(config.database.url).toBe('postgres://override-host/overridden');
  });

  it('env overlay deep-merges without clobbering sibling keys', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
reconciliation:
  intervalMs: 30000
  driftAlertOnly: true
`);
    writeFileSync(resolve(tmpDir, 'development.yaml'), `
reconciliation:
  intervalMs: 5000
`);
    process.env['NODE_ENV'] = 'development';

    const config = loadConfig(tmpDir);

    expect(config.reconciliation.intervalMs).toBe(5000);
    expect(config.reconciliation.driftAlertOnly).toBe(true);
  });

  it('applies Zod defaults for missing sections', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);

    const config = loadConfig(tmpDir);

    expect(config.reconciliation.intervalMs).toBe(30000);
    expect(config.reconciliation.driftAlertOnly).toBe(true);
    expect(config.streams.private.reconnectBaseMs).toBe(1000);
    expect(config.streams.public.reconnectBaseMs).toBe(1000);
    expect(config.marking.stalenessThresholdMs).toBe(300000);
  });

  it('ignores missing NODE_ENV overlay file gracefully', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['NODE_ENV'] = 'staging';

    const config = loadConfig(tmpDir);

    expect(config.database.url).toBe('postgres://localhost/test');
  });

  it('validates marking config with instrumentToCoinId', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marking:
  stalenessThresholdMs: 60000
  oracleBaseUrl: https://api.coingecko.com/api/v3
  instrumentToCoinId:
    BTC/USD:USD: bitcoin
    ETH/USD:USD: ethereum
`);

    const config = loadConfig(tmpDir);

    expect(config.marking.stalenessThresholdMs).toBe(60000);
    expect(config.marking.instrumentToCoinId).toEqual({
      'BTC/USD:USD': 'bitcoin',
      'ETH/USD:USD': 'ethereum',
    });
  });

  it('rejects invalid stalenessThresholdMs below minimum', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marking:
  stalenessThresholdMs: 1000
`);

    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it('rejects invalid boolean env values instead of silently coercing to false', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['RECONCILIATION_DRIFT_ALERT_ONLY'] = 'treu';

    expect(() => loadConfig(tmpDir)).toThrow('Invalid boolean env value');
  });

  it('accepts valid boolean env values true, false, 1, 0', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['RECONCILIATION_DRIFT_ALERT_ONLY'] = 'false';
    process.env['RECONCILIATION_AUTO_CORRECT'] = '1';

    const config = loadConfig(tmpDir);

    expect(config.reconciliation.driftAlertOnly).toBe(false);
    expect(config.reconciliation.autoCorrect).toBe(true);
  });
});