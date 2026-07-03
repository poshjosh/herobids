import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { filesystemTools } from './filesystem.js';
import type { ToolContext } from '@herobids/domain';

const writeTool = filesystemTools.find((t) => t.name === 'write_file')!;
const readTool = filesystemTools.find((t) => t.name === 'read_file')!;
const listTool = filesystemTools.find((t) => t.name === 'list_files')!;
const deleteTool = filesystemTools.find((t) => t.name === 'delete_file')!;
const statTool = filesystemTools.find((t) => t.name === 'stat_file')!;

function makeCtx(agentId = 'fs-agent'): ToolContext {
  return {
    agentId,
    sessionId: 'session-1',
    phase: 'judge',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
  };
}

describe('filesystem tools', () => {
  let tempDir: string;
  let ctx: ToolContext;
  let originalWorkspaceRoot: string | undefined;

  beforeEach(async () => {
    originalWorkspaceRoot = process.env['AGENT_WORKSPACE_ROOT'];
    tempDir = await mkdtemp(join(os.tmpdir(), 'herobids-fs-test-'));
    // Create sandbox subdirectory as required by workspace contract
    await mkdir(join(tempDir, 'sandbox'), { recursive: true });
    process.env['AGENT_WORKSPACE_ROOT'] = tempDir;
    ctx = makeCtx();
  });

  afterEach(async () => {
    if (originalWorkspaceRoot !== undefined) {
      process.env['AGENT_WORKSPACE_ROOT'] = originalWorkspaceRoot;
    } else {
      delete process.env['AGENT_WORKSPACE_ROOT'];
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('write then read round-trip', async () => {
    const writeResult = await writeTool.execute({ path: 'hello.txt', content: 'world' }, ctx);
    expect(writeResult.success).toBe(true);
    expect((writeResult.data as Record<string, unknown>)['bytesWritten']).toBe(5);

    const readResult = await readTool.execute({ path: 'hello.txt' }, ctx);
    expect(readResult.success).toBe(true);
    expect((readResult.data as Record<string, unknown>)['content']).toBe('world');
  });

  it('list_files returns root entries', async () => {
    await writeTool.execute({ path: 'alpha.txt', content: 'a' }, ctx);
    await writeTool.execute({ path: 'beta.txt', content: 'b' }, ctx);

    const result = await listTool.execute({ path: '' }, ctx);
    expect(result.success).toBe(true);
    const entries = (result.data as Record<string, unknown>)['entries'] as string[];
    expect(entries).toContain('alpha.txt');
    expect(entries).toContain('beta.txt');
    expect(entries).toContain('sandbox/');
  });

  it('list_files returns nested directory entries', async () => {
    await writeTool.execute({ path: 'subdir/file.txt', content: 'nested' }, ctx);

    const result = await listTool.execute({ path: 'subdir' }, ctx);
    expect(result.success).toBe(true);
    const entries = (result.data as Record<string, unknown>)['entries'] as string[];
    expect(entries).toContain('file.txt');
  });

  it('delete_file removes a file', async () => {
    await writeTool.execute({ path: 'temp.txt', content: 'bye' }, ctx);

    const deleteResult = await deleteTool.execute({ path: 'temp.txt' }, ctx);
    expect(deleteResult.success).toBe(true);

    const readResult = await readTool.execute({ path: 'temp.txt' }, ctx);
    expect(readResult.success).toBe(false);
    expect(readResult.error).toMatch(/not found/);
  });

  it('rejects writes to the reserved sandbox directory', async () => {
    const result = await writeTool.execute({ path: 'sandbox/evil.js', content: 'bad' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reserved/);
  });

  it('rejects deletes in the reserved sandbox directory', async () => {
    // Create a file directly in sandbox to attempt delete
    await writeFile(join(tempDir, 'sandbox', 'script.js'), 'code', 'utf8');

    const result = await deleteTool.execute({ path: 'sandbox/script.js' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reserved/);
  });

  it('reading a file from sandbox succeeds', async () => {
    // Simulate code execution output written to sandbox
    await writeFile(join(tempDir, 'sandbox', 'output.txt'), 'result data', 'utf8');

    const result = await readTool.execute({ path: 'sandbox/output.txt' }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['content']).toBe('result data');
  });

  it('rejects path traversal with ..', async () => {
    const result = await readTool.execute({ path: '../etc/passwd' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/traversal|escapes/);
  });

  it('rejects absolute paths', async () => {
    const result = await writeTool.execute({ path: '/tmp/evil.txt', content: 'bad' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/relative/);
  });

  it('rejects symlink escaping workspace root', async () => {
    // Create a symlink in the workspace that points outside
    const linkPath = join(tempDir, 'escape-link');
    await symlink('/tmp', linkPath);

    const result = await readTool.execute({ path: 'escape-link/passwd' }, ctx);
    // Should fail: symlink target resolves outside workspace root
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // stat_file
  // -------------------------------------------------------------------------

  it('stat_file returns metadata for an existing file', async () => {
    await writeTool.execute({ path: 'stats.txt', content: 'hello world' }, ctx);

    const result = await statTool.execute({ path: 'stats.txt' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.exists).toBe(true);
    expect(data.isFile).toBe(true);
    expect(data.isDir).toBe(false);
    expect(data.size).toBe(11);
    expect(data.path).toBe('stats.txt');
    expect(data.modifiedAt).toEqual(expect.any(String));
    expect(data.createdAt).toEqual(expect.any(String));
  });

  it('stat_file identifies directories', async () => {
    // A directory is created by writeFile (mkdir recursion) then we stat the dir
    await writeTool.execute({ path: 'mydir/nested.txt', content: 'nested' }, ctx);

    const result = await statTool.execute({ path: 'mydir' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.exists).toBe(true);
    expect(data.isDir).toBe(true);
    expect(data.isFile).toBe(false);
  });

  it('stat_file returns exists=false with null fields for missing paths', async () => {
    const result = await statTool.execute({ path: 'nonexistent.txt' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.exists).toBe(false);
    expect(data.isDir).toBeNull();
    expect(data.isFile).toBeNull();
    expect(data.size).toBeNull();
    expect(data.modifiedAt).toBeNull();
    expect(data.createdAt).toBeNull();
  });
});
