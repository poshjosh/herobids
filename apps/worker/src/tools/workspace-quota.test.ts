import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { assertWithinQuota, getWorkspaceUsage } from './workspace-quota.js';
import { quotaExceeded } from './file-messages.js';

const MIB = 1024 * 1024;

describe('workspace quota', () => {
  let root: string;
  const saved = {
    config: process.env['AGENT_RUNTIME_CONFIG_JSON'],
    quota: process.env['AGENT_WORKSPACE_QUOTA_MB'],
  };

  async function put(rel: string, bytes: number): Promise<void> {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, Buffer.alloc(bytes, 97));
  }

  beforeEach(async () => {
    root = await mkdtemp(join(os.tmpdir(), 'herobids-quota-'));
    delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    delete process.env['AGENT_WORKSPACE_QUOTA_MB'];
  });

  afterEach(async () => {
    if (saved.config === undefined) delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    else process.env['AGENT_RUNTIME_CONFIG_JSON'] = saved.config;
    if (saved.quota === undefined) delete process.env['AGENT_WORKSPACE_QUOTA_MB'];
    else process.env['AGENT_WORKSPACE_QUOTA_MB'] = saved.quota;
    await rm(root, { recursive: true, force: true });
  });

  it('sums regular files, skips platform and dependency dirs, and does not follow symlinks', async () => {
    await put('a.txt', 100);
    await put('notes/b.txt', 200);
    await put('sandbox/big.bin', 5_000);
    await put('.agents/skill.md', 5_000);
    await put('notes/node_modules/dep.js', 5_000);
    await put('proj/.git/obj', 5_000);
    await mkdir(join(root, 'target'), { recursive: true });
    await put('target/outside.bin', 7_000);
    await symlink(join(root, 'target'), join(root, 'link'));
    await symlink(join(root, 'a.txt'), join(root, 'file-link'));

    const usage = await getWorkspaceUsage(root);

    // a.txt + notes/b.txt + target/outside.bin (reached once, by its real path)
    expect(usage.usedBytes).toBe(100 + 200 + 7_000);
    expect(usage.walkCapped).toBe(false);
  });

  it('skips a top-level folder named agent but counts notes/agent', async () => {
    await put('agent/skill.md', 1_000);
    await put('notes/agent/data.txt', 300);
    const usage = await getWorkspaceUsage(root);
    expect(usage.usedBytes).toBe(300);
  });

  it('counts web-cache', async () => {
    await put('web-cache/page.txt', 400);
    expect((await getWorkspaceUsage(root)).usedBytes).toBe(400);
  });

  it('lists top-level folders largest first', async () => {
    await put('small/a', 10);
    await put('large/a', 1_000);
    await put('mid/a', 100);
    const usage = await getWorkspaceUsage(root);
    expect(usage.topDirs.map((d) => d.name)).toEqual(['large', 'mid', 'small']);
  });

  it('treats a missing workspace as empty', async () => {
    const usage = await getWorkspaceUsage(join(root, 'does-not-exist'));
    expect(usage).toMatchObject({ usedBytes: 0, fileCount: 0, walkCapped: false });
  });

  it('does not hit the file cap for node_modules with thousands of files', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { files: { quotaWalkMaxFiles: 50 } } });
    for (let i = 0; i < 120; i++) await put(`proj/node_modules/pkg/f${i}.js`, 1);
    await put('proj/index.js', 10);
    const usage = await getWorkspaceUsage(root);
    expect(usage).toMatchObject({ walkCapped: false, usedBytes: 10 });
  });

  it('fails the write when the walk hits the file cap', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { files: { quotaWalkMaxFiles: 3 } } });
    for (let i = 0; i < 5; i++) await put(`bulk/f${i}.txt`, 1);

    const result = await assertWithinQuota(root, 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('walk_capped');
    const message = quotaExceeded(result.error);
    expect(message.errorCode).toBe('file.quota_exceeded');
    expect(message.error).toContain('delete_file(path: "bulk", recursive: true)');
  });

  it('allows a write that lands exactly on the quota and fails one byte over', async () => {
    process.env['AGENT_WORKSPACE_QUOTA_MB'] = '1';
    await put('data.bin', MIB - 10);
    expect((await assertWithinQuota(root, 10)).ok).toBe(true);
    const over = await assertWithinQuota(root, 11);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.reason).toBe('over_quota');
  });

  it('uses sandboxDefaults when the quota env var is missing', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ sandboxDefaults: { workspaceDiskMb: 1 } });
    await put('data.bin', MIB);
    expect((await assertWithinQuota(root, 1)).ok).toBe(false);
  });

  it('names the three largest top-level folders in the quota message and a delete frees space', async () => {
    process.env['AGENT_WORKSPACE_QUOTA_MB'] = '1';
    await put('big/a.bin', MIB / 2);
    await put('mid/a.bin', MIB / 4);
    await put('low/a.bin', MIB / 8);
    await put('tiny/a.bin', MIB / 16);
    await put('x.bin', MIB / 16 - 8);

    const failure = await assertWithinQuota(root, MIB);
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    const message = quotaExceeded(failure.error).error!;
    expect(message).toContain('big/ 0.5 MiB, mid/ 0.25 MiB, low/ 0.13 MiB');
    expect(message).not.toContain('tiny/');
    expect(message).toContain('delete_file(path: "big", recursive: true)');
    expect(message).not.toContain(root);

    await rm(join(root, 'big'), { recursive: true });
    expect((await assertWithinQuota(root, MIB / 4)).ok).toBe(true);
  });
});
