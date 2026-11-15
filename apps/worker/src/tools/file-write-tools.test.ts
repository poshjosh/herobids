import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { ToolContext, ToolResult } from '@herobids/domain';
import { filesystemTools } from './filesystem.js';
import { findSignatureProblems } from './tool-signature.js';

const tool = (name: string) => filesystemTools.find((t) => t.name === name)!;
const writeTool = tool('write_file');
const appendTool = tool('append_file');
const editTool = tool('edit_file');
const deleteTool = tool('delete_file');

const MIB = 1024 * 1024;

function makeCtx(): ToolContext {
  return {
    agentId: 'write-agent',
    sessionId: 's1',
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

function data(result: ToolResult): Record<string, unknown> {
  expect(result.success, result.error).toBe(true);
  return result.data as Record<string, unknown>;
}

function failure(result: ToolResult, errorCode: string): string {
  expect(result.success).toBe(false);
  expect(result.errorCode).toBe(errorCode);
  expect(result.fault).toBe(false);
  expect(result.error!.length).toBeLessThanOrEqual(350);
  expect(findSignatureProblems(result.error!)).toEqual([]);
  return result.error!;
}

describe('write-side file tools', () => {
  let root: string;
  const saved = {
    root: process.env['AGENT_WORKSPACE_ROOT'],
    config: process.env['AGENT_RUNTIME_CONFIG_JSON'],
    quota: process.env['AGENT_WORKSPACE_QUOTA_MB'],
  };
  const ctx = makeCtx();

  function setFiles(files: Record<string, unknown>): void {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { files } });
  }

  const put = async (rel: string, content: string | Buffer) => {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), content);
  };
  const text = (rel: string) => readFile(join(root, rel), 'utf8');

  beforeEach(async () => {
    root = await mkdtemp(join(os.tmpdir(), 'herobids-write-tools-'));
    process.env['AGENT_WORKSPACE_ROOT'] = root;
    delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    delete process.env['AGENT_WORKSPACE_QUOTA_MB'];
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['AGENT_WORKSPACE_ROOT', saved.root],
      ['AGENT_RUNTIME_CONFIG_JSON', saved.config],
      ['AGENT_WORKSPACE_QUOTA_MB', saved.quota],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  describe('write_file', () => {
    it('keeps today behaviour for content under the cap', async () => {
      expect(data(await writeTool.execute({ path: 'a/b.txt', content: 'héllo' }, ctx))).toEqual({ path: 'a/b.txt', bytesWritten: 6 });
      expect(await text('a/b.txt')).toBe('héllo');
    });

    it('refuses content over writeMaxChars and names append_file', async () => {
      setFiles({ writeMaxChars: 10 });
      const error = failure(await writeTool.execute({ path: 'a.txt', content: 'x'.repeat(11) }, ctx), 'file.content_too_long');
      expect(error).toContain('11 characters');
      expect(error).toContain('append_file(path, content)');
      await expect(stat(join(root, 'a.txt'))).rejects.toThrow();
    });

    it('counts characters, not UTF-16 units, against the cap', async () => {
      setFiles({ writeMaxChars: 10 });
      data(await writeTool.execute({ path: 'emoji.txt', content: '😀'.repeat(10) }, ctx));
    });

    it('counts only net growth against the quota when overwriting', async () => {
      process.env['AGENT_WORKSPACE_QUOTA_MB'] = '1';
      await put('pad.bin', Buffer.alloc(MIB - 15_000, 97));
      await put('f.txt', 'a'.repeat(10_000));
      // Growth is 4,000 bytes (not 14,000), which fits in the 5,000 bytes left.
      data(await writeTool.execute({ path: 'f.txt', content: 'y'.repeat(14_000) }, ctx));
      const error = failure(await writeTool.execute({ path: 'other.txt', content: 'z'.repeat(5_000) }, ctx), 'file.quota_exceeded');
      expect(error).toContain('delete_file(path)');
    });

    it('refuses a directory, a reserved path and an escaping path with their codes', async () => {
      await mkdir(join(root, 'dir'), { recursive: true });
      failure(await writeTool.execute({ path: 'dir', content: 'x' }, ctx), 'file.is_directory');
      failure(await writeTool.execute({ path: 'sandbox/x.js', content: 'x' }, ctx), 'file.reserved_path');
      failure(await writeTool.execute({ path: '../x', content: 'x' }, ctx), 'file.path_invalid');
    });
  });

  describe('append_file', () => {
    it('creates a missing file with no leading newline and creates parent directories', async () => {
      const out = data(await appendTool.execute({ path: 'logs/day/1.txt', content: 'first' }, ctx));
      expect(out).toEqual({ path: 'logs/day/1.txt', bytesAppended: 5, newlineAdded: false, sizeBytes: 5 });
      expect(await text('logs/day/1.txt')).toBe('first');
    });

    it('adds one newline when the file does not end in one', async () => {
      await put('n.txt', 'one');
      const out = data(await appendTool.execute({ path: 'n.txt', content: 'two' }, ctx));
      expect(out).toMatchObject({ bytesAppended: 4, newlineAdded: true, sizeBytes: 7 });
      expect(await text('n.txt')).toBe('one\ntwo');
    });

    it('adds no newline when ensureNewline is false', async () => {
      await put('n.txt', 'one');
      const out = data(await appendTool.execute({ path: 'n.txt', content: 'two', ensureNewline: false }, ctx));
      expect(out['newlineAdded']).toBe(false);
      expect(await text('n.txt')).toBe('onetwo');
    });

    it('adds no newline when the file already ends in one', async () => {
      await put('n.txt', 'one\n');
      data(await appendTool.execute({ path: 'n.txt', content: 'two' }, ctx));
      expect(await text('n.txt')).toBe('one\ntwo');
    });

    it('adds no newline to an empty file', async () => {
      await put('e.txt', '');
      const out = data(await appendTool.execute({ path: 'e.txt', content: 'x' }, ctx));
      expect(out['newlineAdded']).toBe(false);
      expect(await text('e.txt')).toBe('x');
    });

    it('does not add a lone newline for empty content', async () => {
      await put('n.txt', 'one');
      expect(data(await appendTool.execute({ path: 'n.txt', content: '' }, ctx))).toMatchObject({ bytesAppended: 0, newlineAdded: false });
      expect(await text('n.txt')).toBe('one');
    });

    it('refuses sandbox/', async () => {
      failure(await appendTool.execute({ path: 'sandbox/a.txt', content: 'x' }, ctx), 'file.reserved_path');
    });

    it('refuses content over writeMaxChars and points to repeated appends', async () => {
      setFiles({ writeMaxChars: 5 });
      const error = failure(await appendTool.execute({ path: 'a.txt', content: 'abcdef' }, ctx), 'file.content_too_long');
      expect(error).toContain('append_file(path, content)');
    });

    it('refuses a result over the file size limit and leaves the file unchanged', async () => {
      setFiles({ maxFileBytes: 2048 });
      await put('f.txt', 'a'.repeat(2000));
      const error = failure(await appendTool.execute({ path: 'f.txt', content: 'b'.repeat(100) }, ctx), 'file.write_too_large');
      expect(error).toContain('append_file(path, content)');
      expect(await text('f.txt')).toBe('a'.repeat(2000));
    });

    it('refuses a write that passes the quota', async () => {
      process.env['AGENT_WORKSPACE_QUOTA_MB'] = '1';
      await put('big/data.bin', Buffer.alloc(MIB - 10, 1));
      const error = failure(await appendTool.execute({ path: 'n.txt', content: 'x'.repeat(100) }, ctx), 'file.quota_exceeded');
      expect(error).toContain('delete_file(path: "big", recursive: true)');
    });

    it('refuses a directory', async () => {
      await mkdir(join(root, 'd'), { recursive: true });
      failure(await appendTool.execute({ path: 'd', content: 'x' }, ctx), 'file.is_directory');
    });
  });

  describe('edit_file', () => {
    it('replaces a single match and returns the summary only', async () => {
      await put('c.txt', 'alpha beta gamma');
      const out = data(await editTool.execute({ path: 'c.txt', oldText: 'beta', newText: 'BETA!' }, ctx));
      expect(out).toEqual({ path: 'c.txt', replacements: 1, sizeBytes: 17, bytesDelta: 1 });
      expect(await text('c.txt')).toBe('alpha BETA! gamma');
    });

    it('does not treat $ sequences in newText as replacement patterns', async () => {
      await put('c.txt', 'price: X');
      data(await editTool.execute({ path: 'c.txt', oldText: 'X', newText: "$& $1 $'" }, ctx));
      expect(await text('c.txt')).toBe("price: $& $1 $'");
    });

    it('fails with edit.text_not_found and leaves the file untouched', async () => {
      await put('c.txt', 'alpha');
      const error = failure(await editTool.execute({ path: 'c.txt', oldText: 'zzz', newText: 'y' }, ctx), 'edit.text_not_found');
      expect(error).toContain('read_file_lines(path, startLine, limit)');
      expect(await text('c.txt')).toBe('alpha');
    });

    it('reports a CRLF mismatch', async () => {
      await put('c.txt', 'one\r\ntwo\r\n');
      const error = failure(await editTool.execute({ path: 'c.txt', oldText: 'one\ntwo', newText: 'x' }, ctx), 'edit.text_not_found');
      expect(error).toContain('\\r\\n');
    });

    it('fails with edit.ambiguous_match and the match count when there are several', async () => {
      await put('c.txt', 'a a a');
      const error = failure(await editTool.execute({ path: 'c.txt', oldText: 'a', newText: 'b' }, ctx), 'edit.ambiguous_match');
      expect(error).toContain('3 places');
      expect(await text('c.txt')).toBe('a a a');
    });

    it('replaces every match with replaceAll', async () => {
      await put('c.txt', 'a a a');
      expect(data(await editTool.execute({ path: 'c.txt', oldText: 'a', newText: 'bb', replaceAll: true }, ctx)))
        .toMatchObject({ replacements: 3, bytesDelta: 3 });
      expect(await text('c.txt')).toBe('bb bb bb');
    });

    it('fails with edit.no_change when oldText equals newText', async () => {
      await put('c.txt', 'a');
      failure(await editTool.execute({ path: 'c.txt', oldText: 'a', newText: 'a' }, ctx), 'edit.no_change');
    });

    it('fails with file.not_found for a missing file and does not create it', async () => {
      failure(await editTool.execute({ path: 'nope.txt', oldText: 'a', newText: 'b' }, ctx), 'file.not_found');
      await expect(stat(join(root, 'nope.txt'))).rejects.toThrow();
    });

    it('writes atomically and leaves no temp file, on success and on failure', async () => {
      await put('c.txt', 'alpha');
      data(await editTool.execute({ path: 'c.txt', oldText: 'alpha', newText: 'beta' }, ctx));
      await editTool.execute({ path: 'c.txt', oldText: 'missing', newText: 'x' }, ctx);
      expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('keeps the file mode', async () => {
      await put('run.sh', '#!/bin/sh\necho a\n');
      await chmod(join(root, 'run.sh'), 0o750);
      data(await editTool.execute({ path: 'run.sh', oldText: 'echo a', newText: 'echo b' }, ctx));
      expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o750);
    });

    it('edits the target of an in-workspace symlink and keeps the link', async () => {
      await put('real.txt', 'one');
      await symlink(join(root, 'real.txt'), join(root, 'link.txt'));
      data(await editTool.execute({ path: 'link.txt', oldText: 'one', newText: 'two' }, ctx));
      expect(await text('real.txt')).toBe('two');
      expect((await lstat(join(root, 'link.txt'))).isSymbolicLink()).toBe(true);
    });

    it('refuses sandbox/', async () => {
      await put('sandbox/a.js', 'x');
      failure(await editTool.execute({ path: 'sandbox/a.js', oldText: 'x', newText: 'y' }, ctx), 'file.reserved_path');
    });

    it('refuses oldText or newText over writeMaxChars', async () => {
      setFiles({ writeMaxChars: 5 });
      await put('c.txt', 'abc');
      failure(await editTool.execute({ path: 'c.txt', oldText: 'abc', newText: 'x'.repeat(6) }, ctx), 'file.content_too_long');
    });

    it('refuses a file over the size limit', async () => {
      setFiles({ maxFileBytes: 2048 });
      await put('big.txt', 'a'.repeat(3000));
      const error = failure(await editTool.execute({ path: 'big.txt', oldText: 'a', newText: 'b', replaceAll: true }, ctx), 'file.too_large');
      expect(error).toContain('too large to edit');
    });

    it('refuses a result over the size limit and leaves the file unchanged', async () => {
      setFiles({ maxFileBytes: 2048 });
      await put('c.txt', `${'a'.repeat(2000)}X`);
      failure(await editTool.execute({ path: 'c.txt', oldText: 'X', newText: 'y'.repeat(100) }, ctx), 'file.write_too_large');
      expect((await text('c.txt')).endsWith('X')).toBe(true);
    });

    it('respects the quota for growth but not for a shrinking edit', async () => {
      process.env['AGENT_WORKSPACE_QUOTA_MB'] = '1';
      await put('big/data.bin', Buffer.alloc(MIB - 50, 1));
      await put('c.txt', 'short');
      failure(await editTool.execute({ path: 'c.txt', oldText: 'short', newText: 'x'.repeat(200) }, ctx), 'file.quota_exceeded');
      data(await editTool.execute({ path: 'c.txt', oldText: 'short', newText: 's' }, ctx));
    });

    it('refuses a file that is not valid UTF-8 instead of corrupting it', async () => {
      const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
      await put('bin.dat', bytes);
      failure(await editTool.execute({ path: 'bin.dat', oldText: 'a', newText: 'c' }, ctx), 'file.not_text');
      expect((await readFile(join(root, 'bin.dat'))).equals(bytes)).toBe(true);
    });

    it('edits a file of exactly 10 MiB', async () => {
      await put('ten.txt', `${'a'.repeat(10 * MIB - 4)}ZZZZ`);
      const out = data(await editTool.execute({ path: 'ten.txt', oldText: 'ZZZZ', newText: 'YYYY' }, ctx));
      expect(out).toMatchObject({ replacements: 1, sizeBytes: 10 * MIB, bytesDelta: 0 });
      expect((await text('ten.txt')).endsWith('aYYYY')).toBe(true);
    }, 30_000);
  });

  describe('delete_file', () => {
    it('deletes a file as before and reports filesDeleted and bytesFreed', async () => {
      await put('t.txt', 'bye');
      expect(data(await deleteTool.execute({ path: 't.txt' }, ctx))).toEqual({ path: 't.txt', deleted: true, filesDeleted: 1, bytesFreed: 3 });
    });

    it('refuses a folder without recursive and the message names recursive: true', async () => {
      await put('d/a.txt', 'a');
      const error = failure(await deleteTool.execute({ path: 'd' }, ctx), 'file.is_directory');
      expect(error).toContain('delete_file(path: "d", recursive: true)');
      expect(await text('d/a.txt')).toBe('a');
    });

    it('deletes a folder and its contents with recursive: true', async () => {
      await put('d/a.txt', 'aa');
      await put('d/sub/deep/b.txt', 'bbb');
      expect(data(await deleteTool.execute({ path: 'd', recursive: true }, ctx))).toEqual({ path: 'd', deleted: true, filesDeleted: 2, bytesFreed: 5 });
      await expect(stat(join(root, 'd'))).rejects.toThrow();
    });

    it('deletes a file when recursive is true on a file', async () => {
      await put('t.txt', 'bye');
      data(await deleteTool.execute({ path: 't.txt', recursive: true }, ctx));
      await expect(stat(join(root, 't.txt'))).rejects.toThrow();
    });

    it('refuses a folder with more files than maxDeleteFiles and deletes nothing', async () => {
      setFiles({ maxDeleteFiles: 3 });
      for (let i = 0; i < 4; i++) await put(`d/sub/f${i}.txt`, 'x');
      const error = failure(await deleteTool.execute({ path: 'd', recursive: true }, ctx), 'file.delete_too_many');
      expect(error).toContain('more than 3');
      expect(await readdir(join(root, 'd', 'sub'))).toHaveLength(4);
    });

    it('allows exactly maxDeleteFiles files', async () => {
      setFiles({ maxDeleteFiles: 3 });
      for (let i = 0; i < 3; i++) await put(`d/f${i}.txt`, 'x');
      expect(data(await deleteTool.execute({ path: 'd', recursive: true }, ctx))['filesDeleted']).toBe(3);
    });

    it('does not follow a symlink inside the folder and leaves its target untouched', async () => {
      const outside = await mkdtemp(join(os.tmpdir(), 'herobids-outside-'));
      try {
        await writeFile(join(outside, 'keep.txt'), 'keep');
        await put('d/a.txt', 'a');
        await symlink(outside, join(root, 'd', 'link'));
        expect(data(await deleteTool.execute({ path: 'd', recursive: true }, ctx))['filesDeleted']).toBe(2);
        expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('unlinks a symlink path without touching its target', async () => {
      await put('real/a.txt', 'a');
      await symlink(join(root, 'real'), join(root, 'link'));
      data(await deleteTool.execute({ path: 'link', recursive: true }, ctx));
      expect(await text('real/a.txt')).toBe('a');
      await expect(stat(join(root, 'link'))).rejects.toThrow();
    });

    it('refuses the workspace root, sandbox and the top-level platform dirs', async () => {
      for (const dir of ['.agents', '.claude', 'agent']) await put(`${dir}/skill.md`, 's');
      for (const path of ['.', './', 'notes/..', '.agents', '.claude', 'agent']) {
        const error = failure(await deleteTool.execute({ path, recursive: true }, ctx), 'file.reserved_path');
        expect(error).toContain('managed by the platform');
      }
      failure(await deleteTool.execute({ path: 'sandbox', recursive: true }, ctx), 'file.reserved_path');
      expect(await text('.agents/skill.md')).toBe('s');
    });

    it('deletes a folder named agent that is not at the top level', async () => {
      await put('notes/agent/a.txt', 'a');
      data(await deleteTool.execute({ path: 'notes/agent', recursive: true }, ctx));
    });

    it('refuses a path that escapes the workspace', async () => {
      failure(await deleteTool.execute({ path: '../x', recursive: true }, ctx), 'file.path_invalid');
      failure(await deleteTool.execute({ path: '/etc', recursive: true }, ctx), 'file.path_invalid');
    });

    it('returns file.not_found for a missing path', async () => {
      failure(await deleteTool.execute({ path: 'nope', recursive: true }, ctx), 'file.not_found');
    });

    it('frees quota so a refused write succeeds afterwards', async () => {
      process.env['AGENT_WORKSPACE_QUOTA_MB'] = '1';
      await put('old/data.bin', Buffer.alloc(MIB - 10, 1));
      const refused = failure(await writeTool.execute({ path: 'n.txt', content: 'x'.repeat(100) }, ctx), 'file.quota_exceeded');
      expect(refused).toContain('delete_file(path: "old", recursive: true)');
      data(await deleteTool.execute({ path: 'old', recursive: true }, ctx));
      data(await writeTool.execute({ path: 'n.txt', content: 'x'.repeat(100) }, ctx));
    });
  });
});
