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
});