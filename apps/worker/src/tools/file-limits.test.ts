import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFileToolLimits, getWebCacheConfig, getWorkspaceQuotaBytes } from './file-limits.js';

const MIB = 1024 * 1024;

describe('file limits reader', () => {
  let savedConfig: string | undefined;
  let savedQuota: string | undefined;

  beforeEach(() => {
    savedConfig = process.env['AGENT_RUNTIME_CONFIG_JSON'];
    savedQuota = process.env['AGENT_WORKSPACE_QUOTA_MB'];
    delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    delete process.env['AGENT_WORKSPACE_QUOTA_MB'];
  });

  afterEach(() => {
    if (savedConfig === undefined) delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    else process.env['AGENT_RUNTIME_CONFIG_JSON'] = savedConfig;
    if (savedQuota === undefined) delete process.env['AGENT_WORKSPACE_QUOTA_MB'];
    else process.env['AGENT_WORKSPACE_QUOTA_MB'] = savedQuota;
  });

  it('falls back to schema defaults when the runtime config has no tools.files', () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { codeExecute: {} } });
    expect(getFileToolLimits().maxFileBytes).toBe(16_777_216);
    expect(getFileToolLimits().readDefaultChars).toBe(50_000);
  });

  it('falls back to schema defaults when the runtime config is missing or unreadable', () => {
    expect(getFileToolLimits().writeMaxChars).toBe(16_000);
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = '{not json';
    expect(getFileToolLimits().writeMaxChars).toBe(16_000);
  });

  it('reads configured values and picks up a changed env', () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { files: { writeMaxChars: 1_000 } } });
    expect(getFileToolLimits().writeMaxChars).toBe(1_000);
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { files: { writeMaxChars: 2_000 } } });
    expect(getFileToolLimits().writeMaxChars).toBe(2_000);
  });

  it('reads the web cache settings with defaults', () => {
    expect(getWebCacheConfig()).toEqual({ sizeMb: 200, dir: 'web-cache' });
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { webAccess: { webCache: { sizeMb: 5 } } } });
    expect(getWebCacheConfig()).toEqual({ sizeMb: 5, dir: 'web-cache' });
  });

  it('uses the per-tier quota env var first', () => {
    process.env['AGENT_WORKSPACE_QUOTA_MB'] = '500';
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ sandboxDefaults: { workspaceDiskMb: 80 } });
    expect(getWorkspaceQuotaBytes()).toBe(500 * MIB);
  });

  it('falls back to sandboxDefaults when the quota env var is missing', () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ sandboxDefaults: { workspaceDiskMb: 80 } });
    expect(getWorkspaceQuotaBytes()).toBe(80 * MIB);
  });

  it('falls back to the schema default when neither source exists, and ignores a bad env value', () => {
    expect(getWorkspaceQuotaBytes()).toBe(100 * MIB);
    process.env['AGENT_WORKSPACE_QUOTA_MB'] = 'abc';
    expect(getWorkspaceQuotaBytes()).toBe(100 * MIB);
  });
});
