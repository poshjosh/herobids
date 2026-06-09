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
billing:
  primaryProvider: stripe
  stripe:
    secretKey: sk_live_test_key
    webhookSecret: whsec_test_secret
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
    expect(config.marketData).toBeUndefined();
  });

  it('loads marketData when explicitly configured', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  dexscreener:
    baseUrl: https://api.dexscreener.com
    search:
      requestsPerMinute: 35
      cacheTtlMs: 15000
    discovery:
      requestsPerMinute: 25
  binance:
    baseUrl: https://api.binance.com
    requestsPerMinute: 200
  geckoterminal:
    baseUrl: https://api.geckoterminal.com
    candles:
      requestsPerMinute: 12
    discovery:
      requestsPerMinute: 8
  hyperliquid:
    baseUrl: https://api.hyperliquid.xyz
    intelligencePath: /info
    intelligence:
      requestsPerMinute: 100
  bybit:
    baseUrl: https://api.bybit.com
    longShortRatioPath: /v5/market/account-ratio
    intelligence:
      requestsPerMinute: 90
  birdeye:
    enabled: false
    baseUrl: https://public-api.birdeye.so
    requestsPerMinute: 60
    apiKey: ''
  coinMarketCap:
    enabled: true
    baseUrl: https://pro-api.coinmarketcap.com
    requestsPerMinute: 25
    apiKey: cmc-key
  timeoutMs: 5000
`);

    const config = loadConfig(tmpDir);

    expect(config.marketData?.dexscreener.baseUrl).toBe('https://api.dexscreener.com');
    expect(config.marketData?.dexscreener.search.requestsPerMinute).toBe(35);
    expect(config.marketData?.dexscreener.discovery.requestsPerMinute).toBe(25);
    expect(config.marketData?.geckoterminal.discovery.requestsPerMinute).toBe(8);
    expect(config.marketData?.hyperliquid.intelligence.requestsPerMinute).toBe(100);
    expect(config.marketData?.bybit.longShortRatioPath).toBe('/v5/market/account-ratio');
    expect(config.marketData?.coinMarketCap.enabled).toBe(true);
    expect(config.marketData?.binance.requestsPerMinute).toBe(200);
    expect(config.marketData?.timeoutMs).toBe(5000);
  });

  it('deep-merges marketData overlays without clobbering sibling budgets', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
marketData:
  dexscreener:
    baseUrl: https://api.dexscreener.com
    search:
      requestsPerMinute: 30
    discovery:
      requestsPerMinute: 20
  geckoterminal:
    baseUrl: https://api.geckoterminal.com
    candles:
      requestsPerMinute: 15
    discovery:
      requestsPerMinute: 10
`);
    writeFileSync(resolve(tmpDir, 'development.yaml'), `
marketData:
  dexscreener:
    discovery:
      requestsPerMinute: 12
`);
    process.env['NODE_ENV'] = 'development';

    const config = loadConfig(tmpDir);

    expect(config.marketData?.dexscreener.search.requestsPerMinute).toBe(30);
    expect(config.marketData?.dexscreener.discovery.requestsPerMinute).toBe(12);
    expect(config.marketData?.geckoterminal.candles.requestsPerMinute).toBe(15);
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

  describe('liveRollout config', () => {
    it('applies Zod defaults when liveRollout is omitted', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);

      const config = loadConfig(tmpDir);

      expect(config.liveRollout.enabled).toBe(false);
      expect(config.liveRollout.allowedVenues).toEqual(['hyperliquid']);
      expect(config.liveRollout.requireDbCredentials).toBe(true);
      expect(config.liveRollout.maxInitialOrderNotionalUsd).toBe('50');
      expect(config.liveRollout.maxConsecutiveVenueErrors).toBe(3);
      expect(config.liveRollout.slippageAlertBps).toBe(50);
    });

    it('loads explicit liveRollout from YAML', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  enabled: true
  allowedVenues:
    - hyperliquid
  maxInitialOrderNotionalUsd: "100"
`);

      const config = loadConfig(tmpDir);

      expect(config.liveRollout.enabled).toBe(true);
      expect(config.liveRollout.allowedVenues).toEqual(['hyperliquid']);
      expect(config.liveRollout.maxInitialOrderNotionalUsd).toBe('100');
    });

    it('applies LIVE_ROLLOUT_ENABLED env override', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
      process.env['LIVE_ROLLOUT_ENABLED'] = 'true';

      const config = loadConfig(tmpDir);

      expect(config.liveRollout.enabled).toBe(true);
    });

    it('applies LIVE_ROLLOUT_MAX_ORDER_NOTIONAL_USD env override', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
      process.env['LIVE_ROLLOUT_MAX_ORDER_NOTIONAL_USD'] = '25';

      const config = loadConfig(tmpDir);

      expect(config.liveRollout.maxInitialOrderNotionalUsd).toBe('25');
    });

    it('rejects non-numeric maxInitialOrderNotionalUsd', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  maxInitialOrderNotionalUsd: "fifty"
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('rejects zero maxInitialOrderNotionalUsd', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  maxInitialOrderNotionalUsd: "0"
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('rejects Infinity maxInitialOrderNotionalUsd', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  maxInitialOrderNotionalUsd: "Infinity"
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('rejects whitespace-padded maxInitialOrderNotionalUsd', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  maxInitialOrderNotionalUsd: " 50 "
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('rejects unsupported venues in allowedVenues', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
liveRollout:
  allowedVenues:
    - kraken
`);

      expect(() => loadConfig(tmpDir)).toThrow();
    });
  });

  describe('LLM runtime env overrides', () => {
    it('applies LLM_TICK_INTERVAL_MS env override', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
      process.env['LLM_TICK_INTERVAL_MS'] = '120000';

      const config = loadConfig(tmpDir);

      expect(config.llm.tickIntervalMs).toBe(120000);
    });

    it('applies LLM_HEARTBEAT_INTERVAL_MS env override', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
      process.env['LLM_HEARTBEAT_INTERVAL_MS'] = '10000';

      const config = loadConfig(tmpDir);

      expect(config.llm.heartbeatIntervalMs).toBe(10000);
    });

    it('rejects LLM_TICK_INTERVAL_MS below schema minimum (5000)', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);
      process.env['LLM_TICK_INTERVAL_MS'] = '1000';

      expect(() => loadConfig(tmpDir)).toThrow();
    });

    it('loads optional llm trading hours config from YAML', () => {
      writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
llm:
  tradingHours:
    allowedHoursUtc: [9, 10, 11, 12]
    weekendPause: true
`);

      const config = loadConfig(tmpDir);

      expect(config.llm.tradingHours).toEqual({
        allowedHoursUtc: [9, 10, 11, 12],
        weekendPause: true,
      });
    });
  });
});