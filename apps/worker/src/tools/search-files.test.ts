import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { ToolContext, ToolResult } from '@herobids/domain';
import { filesystemTools } from './filesystem.js';
import { getActiveRegexWorkerCount } from './line-matcher.js';
import { getFileToolLimits } from './file-limits.js';
import { SearchRun } from './search-scan.js';
import { createLiteralMatcher } from './line-matcher.js';
import { describeCutResult } from '../stale-result-hints.js';

const searchTool = filesystemTools.find((t) => t.name === 'search_files')!;

function makeCtx(): ToolContext {
  return {
    agentId: 'search-agent',
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

interface Match {
  file: string;
  line: number;
  offset: number;
  text: string;
  before?: string[];
  after?: string[];
}

function data(result: ToolResult): Record<string, unknown> & { matches: Match[] } {
  expect(result.success, result.error).toBe(true);
  return result.data as Record<string, unknown> & { matches: Match[] };
}

/** Run the schema the way agent.ts does before execute, so defaults and coercion apply. */
async function search(args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = searchTool.parametersSchema!.safeParse(args);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return searchTool.execute(parsed.data, makeCtx());
}

describe('search_files', () => {
  let root: string;
  let previousRoot: string | undefined;
  let previousConfig: string | undefined;

  beforeEach(async () => {
    previousRoot = process.env['AGENT_WORKSPACE_ROOT'];
    previousConfig = process.env['AGENT_RUNTIME_CONFIG_JSON'];
    root = await mkdtemp(join(os.tmpdir(), 'herobids-search-'));
    process.env['AGENT_WORKSPACE_ROOT'] = root;
    delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env['AGENT_WORKSPACE_ROOT'];
    else process.env['AGENT_WORKSPACE_ROOT'] = previousRoot;
    if (previousConfig === undefined) delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    else process.env['AGENT_RUNTIME_CONFIG_JSON'] = previousConfig;
    await rm(root, { recursive: true, force: true });
  });

  const put = async (name: string, content: string | Buffer) => {
    const full = join(root, name);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  };
  const setSearchLimits = (search: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { files: { ...extra, search } } });
  };

  describe('literal search', () => {
    it('finds a literal match with file, line, offset and text', async () => {
      await put('notes.txt', 'alpha\nbeta needle gamma\ndelta');
      const out = data(await search({ query: 'needle' }));
      expect(out.matches).toEqual([{ file: 'notes.txt', line: 2, offset: 11, text: 'beta needle gamma' }]);
      expect(out).toMatchObject({ returnedMatches: 1, filesScanned: 1, incomplete: false, regex: false });
    });

    it('reports the offset in characters, so read_file can use it for multi-byte text', async () => {
      await put('u.txt', '日本語\n😀 target');
      const out = data(await search({ query: 'target' }));
      // 日本語\n = 4 code points, then "😀 " = 2.
      expect(out.matches[0]).toMatchObject({ line: 2, offset: 6 });
    });

    it('is case sensitive by default and case insensitive on request', async () => {
      await put('c.txt', 'Hello HELLO hello');
      expect(data(await search({ query: 'HELLO' })).matches).toHaveLength(1);
      await put('d.txt', 'only Needle here');
      expect(data(await search({ path: 'd.txt', query: 'needle' })).matches).toHaveLength(0);
      expect(data(await search({ path: 'd.txt', query: 'needle', caseInsensitive: true })).matches).toHaveLength(1);
    });

    it('treats regex characters literally unless regex is true', async () => {
      await put('r.txt', 'price (a+b) ok\nprice aab ok');
      const out = data(await search({ query: '(a+b)' }));
      expect(out.matches.map((m) => m.line)).toEqual([1]);
    });

    it('cuts a long line to a window around the match', async () => {
      await put('long.txt', `${'a'.repeat(1000)}NEEDLE${'b'.repeat(1000)}`);
      const out = data(await search({ query: 'NEEDLE' }));
      const text = out.matches[0]!.text;
      expect(text).toContain('NEEDLE');
      expect(text.startsWith('…')).toBe(true);
      expect(text.endsWith('…')).toBe(true);
      expect(text.length).toBeLessThanOrEqual(302);
      expect(out.matches[0]!.offset).toBe(1000);
    });

    it('returns context lines before and after a match', async () => {
      await put('ctx.txt', 'l1\nl2\nl3 hit\nl4\nl5\nl6');
      const out = data(await search({ query: 'hit', contextLines: 2 }));
      expect(out.matches[0]).toMatchObject({ before: ['l1', 'l2'], after: ['l4', 'l5'] });
    });

    it('keeps the after context when the next lines are in the next batch', async () => {
      const lines = Array.from({ length: 700 }, (_, i) => (i === 499 ? 'hit' : `line ${i + 1}`));
      await put('batch.txt', lines.join('\n'));
      const out = data(await search({ query: 'hit', contextLines: 3 }));
      expect(out.matches[0]!.after).toEqual(['line 501', 'line 502', 'line 503']);
    });

    it('stops at maxMatches and sets incomplete max_matches only when more matches exist', async () => {
      await put('m.txt', 'x\nx\nx\nx');
      const partial = data(await search({ query: 'x', maxMatches: 3 }));
      expect(partial).toMatchObject({ returnedMatches: 3, incomplete: true, incompleteReason: 'max_matches', stoppedAt: { file: 'm.txt', line: 4 } });
      expect(partial['hint']).toContain('Search stopped');
      const exact = data(await search({ query: 'x', maxMatches: 4 }));
      expect(exact).toMatchObject({ returnedMatches: 4, incomplete: false });
    });

    it('stops reading further files after the match limit', async () => {
      await put('a.txt', 'x\nx');
      await put('b.txt', 'x\nx');
      const out = data(await search({ query: 'x', maxMatches: 2 }));
      expect(out['filesScanned']).toBe(2);
      expect(out).toMatchObject({ incomplete: true, incompleteReason: 'max_matches', stoppedAt: { file: 'b.txt', line: 1 } });
      expect(out.matches.map((m) => m.file)).toEqual(['a.txt', 'a.txt']);
    });

    it('caps result text at the default budget and at the read default when maxMatches is raised', async () => {
      setSearchLimits({ defaultResultChars: 600 }, { readDefaultChars: 1500 });
      await put('many.txt', Array.from({ length: 100 }, (_, i) => `hit ${'p'.repeat(100)} ${i}`).join('\n'));
      const small = data(await search({ query: 'hit' }));
      expect(small).toMatchObject({ incomplete: true, incompleteReason: 'result_chars' });
      expect(JSON.stringify(small.matches).length).toBeLessThanOrEqual(600 + 2);
      const raised = data(await search({ query: 'hit', maxMatches: 60 }));
      expect(raised).toMatchObject({ incomplete: true, incompleteReason: 'result_chars' });
      expect(raised.matches.length).toBeGreaterThan(small.matches.length);
      expect(JSON.stringify(raised.matches).length).toBeLessThanOrEqual(1500 + 2);
    });

    it('searches a single file path', async () => {
      await put('one.txt', 'needle');
      await put('two.txt', 'needle');
      const out = data(await search({ path: 'one.txt', query: 'needle' }));
      expect(out.matches.map((m) => m.file)).toEqual(['one.txt']);
    });

    it('searches a directory recursively in sorted order', async () => {
      await put('b/x.txt', 'needle');
      await put('a/y.txt', 'needle');
      await put('a/b/z.txt', 'needle');
      await put('top.txt', 'needle');
      const out = data(await search({ query: 'needle' }));
      expect(out.matches.map((m) => m.file)).toEqual(['a/b/z.txt', 'a/y.txt', 'b/x.txt', 'top.txt']);
    });

    it('searches below a given folder with workspace-relative file paths', async () => {
      await put('notes/a.txt', 'needle');
      await put('other/b.txt', 'needle');
      const out = data(await search({ path: './notes/', query: 'needle' }));
      expect(out.matches.map((m) => m.file)).toEqual(['notes/a.txt']);
    });

    it('skips binary files and counts them', async () => {
      await put('bin.dat', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
      await put('text.txt', 'needle');
      const out = data(await search({ query: 'needle' }));
      expect(out.matches.map((m) => m.file)).toEqual(['text.txt']);
      expect(out['skippedBinary']).toBe(1);
    });

    it('skips the platform dirs at the top level and the dependency dirs at any depth by default', async () => {
      await put('sandbox/s.txt', 'needle');
      await put('.agents/a.txt', 'needle');
      await put('node_modules/n.txt', 'needle');
      await put('proj/node_modules/m.txt', 'needle');
      await put('proj/ok.txt', 'needle');
      const out = data(await search({ query: 'needle' }));
      expect(out.matches.map((m) => m.file)).toEqual(['proj/ok.txt']);
    });

    it('searches a folder named agent that is not at the top level', async () => {
      await put('agent/top.txt', 'needle');
      await put('notes/agent/inner.txt', 'needle');
      const out = data(await search({ query: 'needle' }));
      expect(out.matches.map((m) => m.file)).toEqual(['notes/agent/inner.txt']);
    });

    it('searches inside a skipped dir when the path names it', async () => {
      await put('node_modules/n.txt', 'needle');
      await put('sandbox/out.txt', 'needle');
      expect(data(await search({ path: 'node_modules', query: 'needle' })).matches.map((m) => m.file)).toEqual(['node_modules/n.txt']);
      expect(data(await search({ path: 'sandbox', query: 'needle' })).matches.map((m) => m.file)).toEqual(['sandbox/out.txt']);
    });

    it('does not follow symlinks', async () => {
      const outside = await mkdtemp(join(os.tmpdir(), 'herobids-search-outside-'));
      try {
        await writeFile(join(outside, 'secret.txt'), 'needle');
        await put('real.txt', 'needle');
        await symlink(outside, join(root, 'linked-dir'));
        await symlink(join(outside, 'secret.txt'), join(root, 'linked-file.txt'));
        const out = data(await search({ query: 'needle' }));
        expect(out.matches.map((m) => m.file)).toEqual(['real.txt']);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('rejects a multi-line query', async () => {
      const parsed = searchTool.parametersSchema!.safeParse({ query: 'a\nb' });
      expect(parsed.success).toBe(false);
    });

    it('rejects a query over the configured length with file.limit_too_large', async () => {
      const result = await search({ query: 'q'.repeat(201) });
      expect(result).toMatchObject({ success: false, errorCode: 'file.limit_too_large', errorOwner: 'agent', fault: false });
      expect(result.error).toContain('201');
      expect(result.error).toContain('200');
    });

    it('rejects maxMatches and contextLines above their maximums', async () => {
      const tooMany = await search({ query: 'x', maxMatches: 201 });
      expect(tooMany).toMatchObject({ success: false, errorCode: 'file.limit_too_large' });
      expect(tooMany.error).toContain('search_files(path, query)');
      const tooMuch = await search({ query: 'x', contextLines: 4 });
      expect(tooMuch).toMatchObject({ success: false, errorCode: 'file.limit_too_large' });
    });

    it('skips files over the file size limit and counts them', async () => {
      process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { files: { maxFileBytes: 1024 } } });
      await put('big.txt', `needle ${'x'.repeat(2000)}`);
      await put('small.txt', 'needle');
      const out = data(await search({ query: 'needle' }));
      expect(out.matches.map((m) => m.file)).toEqual(['small.txt']);
      expect(out['skippedLarge']).toBe(1);
    });

    it('refuses a single file over the size limit with file.too_large', async () => {
      process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { files: { maxFileBytes: 1024 } } });
      await put('big.txt', 'x'.repeat(2000));
      const result = await search({ path: 'big.txt', query: 'x' });
      expect(result).toMatchObject({ success: false, errorCode: 'file.too_large' });
    });

    it('finds text in a one-line file of several MiB', async () => {
      await put('min.json', `{"a":"${'z'.repeat(5 * 1024 * 1024)}","k":"needle"}`);
      const out = data(await search({ path: 'min.json', query: 'needle' }));
      expect(out.matches).toHaveLength(1);
      expect(out.matches[0]!.line).toBe(1);
      expect(out.matches[0]!.offset).toBe(5 * 1024 * 1024 + 13);
    });

    it('returns file.not_found for a missing path and file.path_invalid for an escaping path', async () => {
      expect(await search({ path: 'missing', query: 'x' })).toMatchObject({ success: false, errorCode: 'file.not_found' });
      expect(await search({ path: '../outside', query: 'x' })).toMatchObject({ success: false, errorCode: 'file.path_invalid' });
    });

    it('handles an empty file and an empty workspace', async () => {
      await put('empty.txt', '');
      const out = data(await search({ query: 'x' }));
      expect(out).toMatchObject({ returnedMatches: 0, incomplete: false, filesScanned: 1 });
    });
  });

  describe('scan limits', () => {
    it('returns incomplete max_files with stoppedAt when the file limit is reached', async () => {
      setSearchLimits({ maxFiles: 2 });
      await put('a.txt', 'needle');
      await put('b.txt', 'needle');
      await put('c.txt', 'needle');
      const out = data(await search({ query: 'needle' }));
      expect(out).toMatchObject({ incomplete: true, incompleteReason: 'max_files', filesScanned: 2, stoppedAt: { file: 'c.txt' } });
      expect(out.matches).toHaveLength(2);
      expect(out['hint']).toContain('2 files');
    });

    it('is not incomplete when the number of files equals the file limit', async () => {
      setSearchLimits({ maxFiles: 2 });
      await put('a.txt', 'needle');
      await put('b.txt', 'needle');
      expect(data(await search({ query: 'needle' }))['incomplete']).toBe(false);
    });

    it('returns incomplete max_bytes when the scan size limit would be passed', async () => {
      setSearchLimits({ maxScanMb: 1 });
      await put('a.txt', `needle ${'x'.repeat(700 * 1024)}`);
      await put('b.txt', `needle ${'x'.repeat(700 * 1024)}`);
      const out = data(await search({ query: 'needle' }));
      expect(out).toMatchObject({ incomplete: true, incompleteReason: 'max_bytes', filesScanned: 1, stoppedAt: { file: 'b.txt' } });
    });

    it('returns incomplete max_depth for folders below the depth limit and keeps scanning the rest', async () => {
      setSearchLimits({ maxDepth: 1 });
      await put('top.txt', 'needle');
      await put('d1/in.txt', 'needle');
      await put('d1/d2/deep.txt', 'needle');
      const out = data(await search({ query: 'needle' }));
      expect(out.matches.map((m) => m.file)).toEqual(['d1/in.txt', 'top.txt']);
      expect(out).toMatchObject({ incomplete: true, incompleteReason: 'max_depth' });
    });

    it('returns incomplete deadline with stoppedAt when the clock passes the deadline', async () => {
      await put('a.txt', 'needle');
      await put('b.txt', 'needle');
      let calls = 0;
      // First call sets the deadline (0 + deadlineMs); the later calls are far past it.
      const now = () => (calls++ === 0 ? 0 : 10_000_000);
      const outcome = await new SearchRun({
        startRelative: '',
        startAbsolute: root,
        startIsFile: false,
        startSizeBytes: 0,
        matcher: createLiteralMatcher('needle', false),
        isRegex: false,
        maxMatches: 20,
        contextLines: 0,
        resultCharsCap: 8000,
        limits: getFileToolLimits(),
        now,
      }).run();
      expect(outcome).toMatchObject({ incomplete: true, incompleteReason: 'deadline', filesScanned: 0 });
      expect(outcome.stoppedAt?.file).toBe('a.txt');
    });
  });

  describe('regex search', () => {
    it('finds a regex match and reports the first match position', async () => {
      await put('r.txt', 'id=12\nid=x\nid=345');
      const out = data(await search({ query: 'id=\\d+', regex: true }));
      expect(out.matches.map((m) => [m.line, m.offset])).toEqual([[1, 0], [3, 11]]);
      expect(out['regex']).toBe(true);
    });

    it('matches case-insensitively when asked', async () => {
      await put('r.txt', 'Error: bad');
      expect(data(await search({ query: '^error', regex: true })).matches).toHaveLength(0);
      expect(data(await search({ query: '^error', regex: true, caseInsensitive: true })).matches).toHaveLength(1);
    });

    it('rejects an invalid pattern with search.invalid_pattern', async () => {
      const result = await search({ query: '(unclosed', regex: true });
      expect(result).toMatchObject({ success: false, errorCode: 'search.invalid_pattern', errorOwner: 'agent', fault: false });
      expect(result.error).toContain('regex: false');
    });

    it('rejects a pattern over the configured length', async () => {
      const result = await search({ query: 'a'.repeat(101), regex: true });
      expect(result).toMatchObject({ success: false, errorCode: 'search.invalid_pattern' });
      expect(result.error).toContain('101');
    });

    it('times out a catastrophic pattern, terminates the worker and returns partial matches', async () => {
      setSearchLimits({ deadlineMs: 400 });
      await put('a-fast.txt', 'safe line\n');
      await put('b-slow.txt', `${'a'.repeat(40)}b\n`);
      const started = Date.now();
      const out = data(await search({ query: '(a+)+$', regex: true }));
      expect(Date.now() - started).toBeLessThan(5000);
      expect(out).toMatchObject({ incomplete: true, incompleteReason: 'regex_timeout' });
      expect(out['stoppedAt']).toMatchObject({ file: 'b-slow.txt' });
      expect(out['hint']).toContain('pattern took too long');
      expect(getActiveRegexWorkerCount()).toBe(0);
    });

    it('skips regex lines over the line limit and counts them', async () => {
      setSearchLimits({ regexLineMaxChars: 50 });
      await put('r.txt', `needle short\n${'x'.repeat(100)} needle\nneedle again`);
      const out = data(await search({ query: 'needle', regex: true }));
      expect(out.matches.map((m) => m.line)).toEqual([1, 3]);
      expect(out['skippedLongLines']).toBe(1);
    });

    it('does not skip long lines for literal search', async () => {
      setSearchLimits({ regexLineMaxChars: 50 });
      await put('r.txt', `${'x'.repeat(100)} needle`);
      const out = data(await search({ query: 'needle' }));
      expect(out.matches).toHaveLength(1);
      expect(out['skippedLongLines']).toBe(0);
    });

    it('does not leave a worker running after a normal regex search', async () => {
      await put('r.txt', 'needle');
      data(await search({ query: 'n.*e', regex: true }));
      expect(getActiveRegexWorkerCount()).toBe(0);
    });
  });

  describe('hints', () => {
    it('returns a read_file_lines hint for the first match and none when nothing matched', async () => {
      await put('h.txt', `${'filler\n'.repeat(20)}needle\n`);
      const hit = data(await search({ query: 'needle' }));
      expect(hit['hint']).toBe('Read around a match with read_file_lines(path: "h.txt", startLine: 16, limit: 20).');
      const none = data(await search({ query: 'absent' }));
      expect(none['hint']).toBeUndefined();
    });

    it('puts the hint key before the matches key so a stale cut keeps it', async () => {
      await put('h.txt', 'needle');
      const result = await search({ query: 'needle' });
      const serialized = JSON.stringify(result.data);
      expect(serialized.indexOf('"hint"')).toBeGreaterThan(-1);
      expect(serialized.indexOf('"hint"')).toBeLessThan(serialized.indexOf('"matches"'));
    });

    it('adds a stale-result hint for search_files', () => {
      const hint = describeCutResult({ toolName: 'search_files', args: { query: 'x' }, originalContent: '{}' });
      expect(hint).toBe('Run search_files(path, query) again with a narrower query or path.');
    });
  });
});
