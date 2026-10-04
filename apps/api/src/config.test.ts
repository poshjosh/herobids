import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildExternalBackendClientConfig } from '@herobids/domain/external-backend';
import { loadConfig, resolveConfiguredExternalBackend } from './config.js';

const REPO_CONFIG_DIR = resolve(new URL('.', import.meta.url).pathname, '../../../config');

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

  it('applies venue developer key env overrides without enabling wallet generation', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
venues:
  jupiter:
    baseUrl: https://api.jup.ag/swap/v1
`);
    process.env['JUPITER_API_KEY'] = 'jupiter-operator-key';

    const config = loadConfig(tmpDir);

    expect(config.venues.jupiter?.apiKey).toBe('jupiter-operator-key');
    expect(config.venues.jupiter?.walletGeneration.enabled).toBe(false);
  });

  it('rejects enabled Jupiter wallet generation without an operator key', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + `
venues:
  jupiter:
    baseUrl: https://api.jup.ag/swap/v1
    walletGeneration:
      enabled: true
`);

    expect(() => loadConfig(tmpDir)).toThrow('venues.jupiter.apiKey is required');
  });
});

// External backend registry (Phase 3 T1.3): loader mapping, D19, resolution, parity.
const BACKEND_ENV_VARS = [
  'TRADERTON_BOUNDARY_URL',
  'TRADERTON_BOUNDARY_HMAC_SECRET',
  'TRADERTON_BOUNDARY_CONSUMER_ID',
  'TRADERTON_BOUNDARY_KEY_ID',
  'TRADERTON_BOUNDARY_TIMEOUT_MS',
  'TEST_EXTERNAL_BACKEND_SECRET',
] as const;

function backendYaml(endpointExtra = '', tradingBackendId = 'traderton'): string {
  return `
externalBackends:
  traderton:
    endpoint:
      baseUrl: http://localhost:8080
${endpointExtra}    caller:
      consumerId: herobids
      keyId: current
      hmacSecretRef: TEST_EXTERNAL_BACKEND_SECRET
    descriptorPinning:
      mode: maxAge
      seconds: 3600
tradingBackendId: ${tradingBackendId}
`;
}

describe('loadConfig external backend registry', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'herobids-backend-config-test-'));
    for (const name of BACKEND_ENV_VARS) delete process.env[name];
    process.env['NODE_ENV'] = 'test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps the TRADERTON_BOUNDARY_* overrides onto externalBackends.traderton', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + backendYaml());
    process.env['TRADERTON_BOUNDARY_URL'] = 'http://host.docker.internal:8080';
    process.env['TRADERTON_BOUNDARY_CONSUMER_ID'] = 'consumer-from-env';
    process.env['TRADERTON_BOUNDARY_KEY_ID'] = 'key-from-env';
    process.env['TRADERTON_BOUNDARY_TIMEOUT_MS'] = '15000';

    const config = loadConfig(tmpDir);

    const [entry] = config.externalBackends;
    expect(config.externalBackends).toHaveLength(1);
    expect(entry?.backendId).toBe('traderton');
    expect(entry?.endpoint.baseUrl).toBe('http://host.docker.internal:8080');
    expect(entry?.endpoint.requestTimeoutMs).toBe(15000);
    expect(entry?.caller).toEqual({
      consumerId: 'consumer-from-env',
      keyId: 'key-from-env',
      hmacSecretRef: 'TEST_EXTERNAL_BACKEND_SECRET',
    });
  });

  it('does not treat the HMAC secret env var as a config override', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + backendYaml());
    process.env['TRADERTON_BOUNDARY_HMAC_SECRET'] = 'must-not-land-in-config';

    const config = loadConfig(tmpDir);

    expect(JSON.stringify(config)).not.toContain('must-not-land-in-config');
  });

  it('rejects protocol mcp when NODE_ENV is staging', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + backendYaml('      protocol: mcp\n      mcpPath: /mcp\n'));
    process.env['NODE_ENV'] = 'staging';

    expect(() => loadConfig(tmpDir)).toThrow(/externalBackends\.traderton\.endpoint\.protocol is mcp.*"staging"/);
  });

  it('rejects protocol mcp when NODE_ENV is production', () => {
    writeFileSync(
      resolve(tmpDir, 'default.yaml'),
      BASE_YAML + backendYaml('      toolProtocolOverrides:\n        get_price: mcp\n      mcpPath: /mcp\n'),
    );
    process.env['NODE_ENV'] = 'production';

    expect(() => loadConfig(tmpDir)).toThrow(/toolProtocolOverrides\.get_price is mcp.*"production"/);
  });

  it('allows protocol mcp with an mcpPath in development', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + backendYaml('      protocol: mcp\n      mcpPath: /mcp\n'));
    process.env['NODE_ENV'] = 'development';

    const config = loadConfig(tmpDir);

    expect(config.externalBackends[0]?.endpoint).toMatchObject({ protocol: 'mcp', mcpPath: '/mcp' });
  });

  it('rejects a tradingBackendId that names no registered backend', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + backendYaml('', 'unknown-backend'));

    expect(() => loadConfig(tmpDir)).toThrow(/tradingBackendId 'unknown-backend' does not name a registered externalBackends entry/);
  });

  it('loads without a registry or a tradingBackendId', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);

    const config = loadConfig(tmpDir);

    expect(config.externalBackends).toEqual([]);
    expect(config.tradingBackendId).toBeUndefined();
  });

  it('resolveConfiguredExternalBackend reads the secret from the env var named by hmacSecretRef', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + backendYaml());
    const config = loadConfig(tmpDir);

    const unresolved = resolveConfiguredExternalBackend(config, config.tradingBackendId);
    expect(unresolved.ok ? undefined : unresolved.error.code).toBe('external_backend.secret_missing');

    process.env['TEST_EXTERNAL_BACKEND_SECRET'] = 'secret-from-named-env-var';
    const resolved = resolveConfiguredExternalBackend(config, config.tradingBackendId);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.data.hmacSecret).toBe('secret-from-named-env-var');
    expect(resolved.data.definition.backendId).toBe('traderton');
  });

  it('the default traderton entry yields the client config the boundary block produced', () => {
    // Only the registry sections of the real default.yaml: the rest needs operator env.
    const realDefaults = parseYaml(readFileSync(resolve(REPO_CONFIG_DIR, 'default.yaml'), 'utf8')) as Record<string, unknown>;
    const registrySections = {
      externalBackends: realDefaults['externalBackends'],
      tradingBackendId: realDefaults['tradingBackendId'],
    };
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + stringifyYaml(registrySections));
    process.env['TRADERTON_BOUNDARY_HMAC_SECRET'] = 'parity-secret';
    const config = loadConfig(tmpDir);

    const resolved = resolveConfiguredExternalBackend(config, config.tradingBackendId);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(buildExternalBackendClientConfig(resolved.data.definition, resolved.data.hmacSecret)).toEqual({
      baseUrl: 'http://localhost:8080',
      consumerId: 'herobids',
      keyId: 'current',
      hmacSecret: 'parity-secret',
      requestTimeoutMs: 10000,
      protocol: 'rest',
      backendId: 'traderton',
      toolProtocolOverrides: undefined,
      mcpPath: undefined,
    });
  });
});
