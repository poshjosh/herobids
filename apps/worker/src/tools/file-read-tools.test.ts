import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { ToolContext, ToolResult } from '@herobids/domain';
import { filesystemTools } from './filesystem.js';

const readTool = filesystemTools.find((t) => t.name === 'read_file')!;
const linesTool = filesystemTools.find((t) => t.name === 'read_file_lines')!;
const listTool = filesystemTools.find((t) => t.name === 'list_files')!;

const MAX_FILE_BYTES = 16_777_216;

function makeCtx(): ToolContext {
  return {
    agentId: 'read-agent',
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

describe('read-side file tools', () => {
  let root: string;
  let previousRoot: string | undefined;
  const ctx = makeCtx();

  beforeEach(async () => {
    previousRoot = process.env['AGENT_WORKSPACE_ROOT'];
    root = await mkdtemp(join(os.tmpdir(), 'herobids-read-tools-'));
    process.env['AGENT_WORKSPACE_ROOT'] = root;
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env['AGENT_WORKSPACE_ROOT'];
    else process.env['AGENT_WORKSPACE_ROOT'] = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  const put = (name: string, content: string | Buffer) => writeFile(join(root, name), content);

  describe('read_file', () => {
    it('returns the whole file with nextOffset null when it fits in one page', async () => {
      await put('a.txt', 'hello\nworld');
      const out = data(await readTool.execute({ path: 'a.txt' }, ctx));
      expect(out).toMatchObject({ offset: 0, returnedChars: 11, totalChars: 11, totalLines: 2, nextOffset: null, truncated: false, content: 'hello\nworld' });
      expect(out['hint']).toBeUndefined();
    });

    it('returns the first page, nextOffset and a continue hint for a file longer than the default page', async () => {
      await put('big.txt', 'x'.repeat(50_001));
      const out = data(await readTool.execute({ path: 'big.txt' }, ctx));
      expect(out['returnedChars']).toBe(50_000);
      expect(out['nextOffset']).toBe(50_000);
      expect(out['truncated']).toBe(true);
      expect(out['hint']).toContain('read_file(path: "big.txt", offset: 50000)');
    });

    it('returns consecutive pages with no gap or overlap', async () => {
      const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
      await put('p.txt', text);
      let offset = 0;
      let joined = '';
      for (let guard = 0; guard < 100; guard++) {
        const out = data(await readTool.execute({ path: 'p.txt', offset, limit: 37 }, ctx));
        joined += out['content'] as string;
        if (out['nextOffset'] === null) break;
        offset = out['nextOffset'] as number;
      }
      expect(joined).toBe(text);
    });

    it('never splits a surrogate pair at a page boundary', async () => {
      await put('e.txt', 'a😀b😀c');
      const first = data(await readTool.execute({ path: 'e.txt', limit: 2 }, ctx));
      expect(first['content']).toBe('a😀');
      const second = data(await readTool.execute({ path: 'e.txt', offset: first['nextOffset'] as number, limit: 10 }, ctx));
      expect(second['content']).toBe('b😀c');
    });

    it('pages multi-byte text by characters, not bytes', async () => {
      await put('cjk.txt', '你好世界مرحباéé');
      const out = data(await readTool.execute({ path: 'cjk.txt', limit: 4 }, ctx));
      expect(out['content']).toBe('你好世界');
      expect(out['totalChars']).toBe(11);
    });

    it('counts totalLines with and without a trailing newline', async () => {
      await put('n1.txt', 'a\nb\n');
      await put('n2.txt', 'a\nb');
      expect(data(await readTool.execute({ path: 'n1.txt' }, ctx))['totalLines']).toBe(2);
      expect(data(await readTool.execute({ path: 'n2.txt' }, ctx))['totalLines']).toBe(2);
    });

    it('returns an empty page for an empty file and for an offset past the end', async () => {
      await put('empty.txt', '');
      expect(data(await readTool.execute({ path: 'empty.txt' }, ctx))).toMatchObject({ totalChars: 0, totalLines: 0, content: '', nextOffset: null });
      await put('s.txt', 'abc');
      expect(data(await readTool.execute({ path: 's.txt', offset: 99 }, ctx))).toMatchObject({ content: '', totalChars: 3, nextOffset: null });
    });

    it('opens a file of exactly the maximum size and refuses one byte more', async () => {
      await put('max.txt', Buffer.alloc(MAX_FILE_BYTES, 0x61));
      const out = data(await readTool.execute({ path: 'max.txt', limit: 10 }, ctx));
      expect(out['totalChars']).toBe(MAX_FILE_BYTES);

      await put('over.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
      const refused = await readTool.execute({ path: 'over.txt' }, ctx);
      expect(refused).toMatchObject({ success: false, errorCode: 'file.too_large', fault: false });
      expect(refused.error).toContain('read_file_lines(path, startLine, limit)');
    });

    it('rejects a limit above the maximum and accepts the maximum', async () => {
      await put('s.txt', 'abc');
      const refused = await readTool.execute({ path: 's.txt', limit: 500_001 }, ctx);
      expect(refused).toMatchObject({ success: false, errorCode: 'file.limit_too_large' });
      expect(refused.error).toContain('500000');
      expect(data(await readTool.execute({ path: 's.txt', limit: 500_000 }, ctx))['content']).toBe('abc');
    });

    it('returns file.not_found with a list_files hint, and a restart hint under web-cache', async () => {
      const missing = await readTool.execute({ path: 'notes/none.txt' }, ctx);
      expect(missing).toMatchObject({ success: false, errorCode: 'file.not_found' });
      expect(missing.error).toContain('list_files(path: "notes")');
      expect(missing.error).not.toContain('restarts');

      const cached = await readTool.execute({ path: 'web-cache/x.txt' }, ctx);
      expect(cached.error).toContain('restarts');
    });

    it('returns file.is_directory for a directory', async () => {
      await mkdir(join(root, 'dir'));
      const result = await readTool.execute({ path: 'dir' }, ctx);
      expect(result).toMatchObject({ success: false, errorCode: 'file.is_directory' });
      expect(result.error).toContain('list_files(path: "dir")');
    });

    it('refuses paths that escape the workspace, absolute paths and symlink escapes', async () => {
      await symlink('/tmp', join(root, 'link'));
      for (const path of ['../x', '/etc/passwd', 'link/x']) {
        expect(await readTool.execute({ path }, ctx)).toMatchObject({ success: false, errorCode: 'file.path_invalid' });
      }
    });

    it('reads a file under sandbox/', async () => {
      await mkdir(join(root, 'sandbox'), { recursive: true });
      await writeFile(join(root, 'sandbox', 'o.txt'), 'out');
      expect(data(await readTool.execute({ path: 'sandbox/o.txt' }, ctx))['content']).toBe('out');
    });

    it('puts metadata and the hint before content so a cut result keeps them', async () => {
      await put('big.txt', 'x'.repeat(60_000));
      const result = await readTool.execute({ path: 'big.txt' }, ctx);
      const serialized = JSON.stringify(result.data);
      expect(serialized.indexOf('"nextOffset"')).toBeLessThan(serialized.indexOf('"content"'));
      expect(serialized.indexOf('"hint"')).toBeLessThan(serialized.indexOf('"content"'));
    });

    it('pages a 16 MiB file within a generous time bound', async () => {
      await put('max.txt', Buffer.alloc(MAX_FILE_BYTES, 0x61));
      const started = Date.now();
      data(await readTool.execute({ path: 'max.txt', offset: 5_000_000, limit: 1000 }, ctx));
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });

  describe('read_file_lines', () => {
    it('returns whole lines exactly as in the file, with no line numbers', async () => {
      await put('l.txt', 'one\ntwo\nthree\n');
      const out = data(await linesTool.execute({ path: 'l.txt', startLine: 2, limit: 1 }, ctx));
      expect(out).toMatchObject({ startLine: 2, endLine: 2, totalLines: 3, nextLine: 3, truncated: true, content: 'two\n' });
      expect(out['hint']).toContain('read_file_lines(path: "l.txt", startLine: 3)');
    });

    it('keeps CRLF line endings', async () => {
      await put('c.txt', 'a\r\nb\r\n');
      expect(data(await linesTool.execute({ path: 'c.txt' }, ctx))['content']).toBe('a\r\nb\r\n');
    });

    it('continues with nextLine without a gap and ends with nextLine null', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `row ${i}\n`);
      await put('r.txt', lines.join(''));
      let start = 1;
      let joined = '';
      for (let guard = 0; guard < 20; guard++) {
        const out = data(await linesTool.execute({ path: 'r.txt', startLine: start, limit: 3 }, ctx));
        joined += out['content'] as string;
        if (out['nextLine'] === null) {
          expect(out['truncated']).toBe(false);
          break;
        }
        start = out['nextLine'] as number;
      }
      expect(joined).toBe(lines.join(''));
    });

    it('stops before the line that would pass maxChars', async () => {
      await put('m.txt', 'aaaa\nbbbb\ncccc\n');
      const out = data(await linesTool.execute({ path: 'm.txt', maxChars: 10 }, ctx));
      expect(out).toMatchObject({ content: 'aaaa\nbbbb\n', endLine: 2, nextLine: 3, truncated: true });
    });

    it('uses the default cap when maxChars is not given', async () => {
      await put('d.txt', `${'y'.repeat(99)}\n`.repeat(600));
      const out = data(await linesTool.execute({ path: 'd.txt' }, ctx));
      expect((out['content'] as string).length).toBeLessThanOrEqual(50_000);
      expect(out['nextLine']).not.toBeNull();
    });

    it('accepts maxChars equal to the maximum and rejects one above it', async () => {
      await put('s.txt', 'abc\n');
      expect(data(await linesTool.execute({ path: 's.txt', maxChars: 500_000 }, ctx))['content']).toBe('abc\n');
      expect(await linesTool.execute({ path: 's.txt', maxChars: 500_001 }, ctx)).toMatchObject({ success: false, errorCode: 'file.limit_too_large' });
    });

    it('cuts a single over-long first line and reports it as truncated with lineStartOffset', async () => {
      await put('long.txt', `short\n${'z'.repeat(100)}`);
      const out = data(await linesTool.execute({ path: 'long.txt', startLine: 2, maxChars: 40 }, ctx));
      expect(out).toMatchObject({ lineCut: true, lineStartOffset: 6, endLine: 2, nextLine: null, truncated: true });
      expect((out['content'] as string).length).toBe(40);
      expect(out['hint']).toContain('read_file(path: "long.txt", offset: 46)');
    });

    it('handles a file that is one very long line', async () => {
      await put('one.txt', 'q'.repeat(200_000));
      const out = data(await linesTool.execute({ path: 'one.txt' }, ctx));
      expect(out).toMatchObject({ lineCut: true, lineStartOffset: 0, totalLines: 1, truncated: true });
    });

    it('returns an empty result past the last line and for an empty file', async () => {
      await put('s.txt', 'a\nb\n');
      expect(data(await linesTool.execute({ path: 's.txt', startLine: 9 }, ctx))).toMatchObject({ content: '', endLine: null, nextLine: null, truncated: false, totalLines: 2 });
      await put('e.txt', '');
      expect(data(await linesTool.execute({ path: 'e.txt' }, ctx))).toMatchObject({ content: '', totalLines: 0, endLine: null });
    });

    it('refuses a file over the maximum size and a directory', async () => {
      await put('over.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
      expect(await linesTool.execute({ path: 'over.txt' }, ctx)).toMatchObject({ success: false, errorCode: 'file.too_large' });
      await mkdir(join(root, 'dir'));
      expect(await linesTool.execute({ path: 'dir' }, ctx)).toMatchObject({ success: false, errorCode: 'file.is_directory' });
    });
  });

  describe('list_files', () => {
    it('returns totalEntries and no hint for a short folder', async () => {
      await put('a.txt', 'a');
      const out = data(await listTool.execute({ path: '' }, ctx));
      expect(out).toMatchObject({ totalEntries: 2, nextOffset: null, truncated: false });
      expect(out['hint']).toBeUndefined();
    });

    it('caps at the default number of entries and pages with offset and limit', async () => {
      await mkdir(join(root, 'many'));
      for (let i = 0; i < 520; i++) await writeFile(join(root, 'many', `f${String(i).padStart(4, '0')}.txt`), '');
      const first = data(await listTool.execute({ path: 'many' }, ctx));
      expect((first['entries'] as string[]).length).toBe(500);
      expect(first).toMatchObject({ totalEntries: 520, nextOffset: 500, truncated: true });
      expect(first['hint']).toContain('list_files(path: "many", offset: 500)');

      const second = data(await listTool.execute({ path: 'many', offset: 500, limit: 100 }, ctx));
      expect((second['entries'] as string[]).length).toBe(20);
      expect(second).toMatchObject({ nextOffset: null, truncated: false });
    });

    it('rejects a limit over the maximum', async () => {
      const result = await listTool.execute({ path: '', limit: 2001 }, ctx);
      expect(result).toMatchObject({ success: false, errorCode: 'file.limit_too_large' });
      expect(result.error).toContain('list_files');
    });

    it('returns file.not_found for a missing folder and file.not_a_directory for a file', async () => {
      expect(await listTool.execute({ path: 'nope' }, ctx)).toMatchObject({ success: false, errorCode: 'file.not_found' });
      await put('f.txt', 'x');
      expect(await listTool.execute({ path: 'f.txt' }, ctx)).toMatchObject({ success: false, errorCode: 'file.not_a_directory' });
    });
  });
});
