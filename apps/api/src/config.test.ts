import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.js';

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
agentRuntime:
  defaultBudgets:
    maxHistoryMessages: 20
    maxHistoryTokens: 40000
    maxRecentToolMessages: 6
    maxToolResultChars: 4000
    maxVisibleToolSchemas: 64
    maxContextBlockChars: 4000
marketData:
  birdeye:
    enabled: false
    baseUrl: https://public-api.birdeye.so
    requestsPerMinute: 60
    apiKey: yaml-birdeye-key
`;

describe('loadConfig', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'herobids-api-config-test-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies BIRDEYE_API_KEY env override', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['BIRDEYE_API_KEY'] = 'env-birdeye-key';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.birdeye.apiKey).toBe('env-birdeye-key');
  });

  it('preserves YAML defaults when BIRDEYE_API_KEY is empty', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['BIRDEYE_API_KEY'] = '';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.birdeye.apiKey).toBe('yaml-birdeye-key');
  });

  it('applies COINMARKETCAP_API_KEY env override without clobbering YAML defaults', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
    process.env['COINMARKETCAP_API_KEY'] = 'cmc-env-key';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.coinMarketCap?.apiKey).toBe('cmc-env-key');
    expect(config.marketData?.coinMarketCap?.enabled).toBe(false);
  });

  it('preserves YAML CoinMarketCap apiKey when the env override is empty', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
  coinMarketCap:
    enabled: false
    baseUrl: https://pro-api.coinmarketcap.com
    requestsPerMinute: 30
    apiKey: yaml-cmc-key
`);
    process.env['COINMARKETCAP_API_KEY'] = '';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.coinMarketCap?.apiKey).toBe('yaml-cmc-key');
    expect(config.marketData?.coinMarketCap?.enabled).toBe(false);
  });

  it('COINMARKETCAP_API_KEY overrides YAML apiKey when coinMarketCap is enabled', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
  coinMarketCap:
    enabled: true
    baseUrl: https://pro-api.coinmarketcap.com
    requestsPerMinute: 30
    apiKey: yaml-cmc-key
`);
    process.env['COINMARKETCAP_API_KEY'] = 'env-cmc-key';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.coinMarketCap?.apiKey).toBe('env-cmc-key');
    expect(config.marketData?.coinMarketCap?.enabled).toBe(true);
  });
});