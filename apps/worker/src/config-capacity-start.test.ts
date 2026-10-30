import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadConfig, MONOREPO_CONFIG_DIR } from './config.js';
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
`;

function workerYaml(capacityAwareStartBlock: string): string {
  return `${BASE_YAML}
worker:
  agents:
    startTimeoutMs: 60000
    capacityAwareStart:
${capacityAwareStartBlock}
`;
}

describe('worker.agents.capacityAwareStart config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'herobids-capacity-start-config-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ships disabled with the 600000 ms capacity wait and 120000 ms placed-start budgets in default.yaml', () => {
    // Only the worker section of the real default.yaml: the rest needs operator env (API keys).
    const realDefaults = parseYaml(readFileSync(resolve(MONOREPO_CONFIG_DIR, 'default.yaml'), 'utf8')) as Record<string, unknown>;
    const worker = realDefaults['worker'];
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML + stringifyYaml({ worker }));
    const config = loadConfig(tmpDir);

    expect(config.worker.agents.capacityAwareStart).toEqual({
      enabled: false,
      capacityWaitTimeoutMs: 600_000,
      placedStartTimeoutMs: 120_000,
    });
    expect(config.worker.agents.startTimeoutMs).toBe(60_000);
  });

  it('defaults to disabled with the same budgets when the block is absent from the YAML', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), BASE_YAML);

    const config = loadConfig(tmpDir);

    expect(config.worker.agents.capacityAwareStart).toEqual({
      enabled: false,
      capacityWaitTimeoutMs: 600_000,
      placedStartTimeoutMs: 120_000,
    });
  });

  it('parses an explicit enabled gate and custom budgets', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), workerYaml(`      enabled: true
      capacityWaitTimeoutMs: 300000
      placedStartTimeoutMs: 90000`));

    const config = loadConfig(tmpDir);

    expect(config.worker.agents.capacityAwareStart).toEqual({
      enabled: true,
      capacityWaitTimeoutMs: 300_000,
      placedStartTimeoutMs: 90_000,
    });
  });

  it('rejects a non-boolean enabled value', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), workerYaml(`      enabled: "yes"`));

    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it('rejects budgets below the 1000 ms floor or above the 1 hour ceiling', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), workerYaml(`      capacityWaitTimeoutMs: 999`));
    expect(() => loadConfig(tmpDir)).toThrow();

    writeFileSync(resolve(tmpDir, 'default.yaml'), workerYaml(`      placedStartTimeoutMs: 3600001`));
    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it('rejects non-integer budgets', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), workerYaml(`      capacityWaitTimeoutMs: 600000.5`));

    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it('rejects unknown keys so a misspelled gate cannot be silently ignored', () => {
    writeFileSync(resolve(tmpDir, 'default.yaml'), workerYaml(`      enable: true`));

    expect(() => loadConfig(tmpDir)).toThrow();
  });
});
