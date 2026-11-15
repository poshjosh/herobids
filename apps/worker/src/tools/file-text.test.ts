import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  countCodePoints,
  readCharPage,
  readLinePage,
  sliceCodePoints,
  streamLines,
} from './file-text.js';

describe('code point helpers', () => {
  it('counts an emoji as one character', () => {
    expect(countCodePoints('a😀b')).toBe(3);
  });

  it('slices by code points without splitting a surrogate pair', () => {
    expect(sliceCodePoints('a😀b😀c', 1, 3)).toBe('😀b');
    expect(sliceCodePoints('😀😀', 0, 1)).toBe('😀');
  });
});

describe('file text readers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(os.tmpdir(), 'herobids-file-text-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function make(content: string | Buffer): Promise<string> {
    const path = join(dir, 'f.txt');
    await writeFile(path, content);
    return path;
  }

  describe('readCharPage', () => {
    it('returns the whole file with nextOffset null when it fits in one page', async () => {
      const page = await readCharPage(await make('hello'), 0, 100);
      expect(page).toMatchObject({ content: 'hello', returnedChars: 5, totalChars: 5, nextOffset: null });
    });

    it('returns the same text across consecutive pages with no gap or overlap', async () => {
      const text = Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join('');
      const path = await make(text);
      let offset: number | null = 0;
      let rebuilt = '';
      while (offset !== null) {
        const page: Awaited<ReturnType<typeof readCharPage>> = await readCharPage(path, offset, 777);
        rebuilt += page.content;
        offset = page.nextOffset;
      }
      expect(rebuilt).toBe(text);
    });

    it('never splits a surrogate pair at a page boundary', async () => {
      const path = await make('😀😀😀😀');
      const first = await readCharPage(path, 0, 3);
      expect(first.content).toBe('😀😀😀');
      expect(first.nextOffset).toBe(3);
      const second = await readCharPage(path, 3, 3);
      expect(second.content).toBe('😀');
    });

    it('pages multi-byte UTF-8 text by characters, not bytes', async () => {
      const text = '你好世界 مرحبا café';
      const page = await readCharPage(await make(text), 2, 4);
      expect(page.content).toBe(sliceCodePoints(text, 2, 6));
      expect(page.totalChars).toBe(countCodePoints(text));
    });

    it('decodes characters that straddle a 64 KiB chunk boundary', async () => {
      const text = '€'.repeat(70_000);
      const page = await readCharPage(await make(text), 65_000, 10);
      expect(page.content).toBe('€'.repeat(10));
      expect(page.totalChars).toBe(70_000);
    });

    it('counts totalLines with and without a trailing newline', async () => {
      expect((await readCharPage(await make('a\nb\n'), 0, 10)).totalLines).toBe(2);
      expect((await readCharPage(await make('a\nb'), 0, 10)).totalLines).toBe(2);
      expect((await readCharPage(await make('a'), 0, 10)).totalLines).toBe(1);
    });

    it('returns an empty page for an empty file', async () => {
      const page = await readCharPage(await make(''), 0, 10);
      expect(page).toEqual({ content: '', returnedChars: 0, totalChars: 0, totalLines: 0, nextOffset: null });
    });

    it('returns an empty page for an offset past the end', async () => {
      const page = await readCharPage(await make('abc'), 50, 10);
      expect(page).toMatchObject({ content: '', returnedChars: 0, totalChars: 3, nextOffset: null });
    });

    it('turns invalid UTF-8 bytes into U+FFFD', async () => {
      const page = await readCharPage(await make(Buffer.from([0x61, 0xff, 0x62])), 0, 10);
      expect(page.content).toBe('a\uFFFDb');
    });
  });

  describe('streamLines', () => {
    it('keeps line endings and does not invent a line after a trailing newline', async () => {
      const lines: string[] = [];
      for await (const line of streamLines(await make('a\r\nb\n'))) lines.push(line.text);
      expect(lines).toEqual(['a\r\n', 'b\n']);
    });

    it('reports code point offsets for each line', async () => {
      const offsets: number[] = [];
      for await (const line of streamLines(await make('😀\nab\nc'))) offsets.push(line.startOffset);
      expect(offsets).toEqual([0, 2, 5]);
    });
  });

  describe('readLinePage', () => {
    const text = 'one\ntwo\r\nthree\nfour';

    it('returns whole lines exactly as in the file, keeping CRLF', async () => {
      const page = await readLinePage(await make(text), { startLine: 1, limit: 2, maxChars: 1000 });
      expect(page.content).toBe('one\ntwo\r\n');
      expect(page).toMatchObject({ startLine: 1, endLine: 2, totalLines: 4, nextLine: 3, lineCut: false });
    });

    it('continues with nextLine with no gap', async () => {
      const path = await make(text);
      const first = await readLinePage(path, { startLine: 1, limit: 2, maxChars: 1000 });
      const second = await readLinePage(path, { startLine: first.nextLine!, limit: 2, maxChars: 1000 });
      expect(first.content + second.content).toBe(text);
      expect(second.nextLine).toBeNull();
    });

    it('stops before the line that would pass maxChars', async () => {
      const page = await readLinePage(await make('aaaa\nbbbb\ncccc\n'), { startLine: 1, maxChars: 10 });
      expect(page.content).toBe('aaaa\nbbbb\n');
      expect(page.nextLine).toBe(3);
    });

    it('cuts a single over-long first line and sets lineCut and lineStartOffset', async () => {
      const page = await readLinePage(await make('ab\n' + 'x'.repeat(50) + '\nlast'), { startLine: 2, maxChars: 10 });
      expect(page.content).toBe('x'.repeat(10));
      expect(page).toMatchObject({ lineCut: true, lineStartOffset: 3, endLine: 2, nextLine: 3 });
    });

    it('has no next line after a cut last line', async () => {
      const page = await readLinePage(await make('x'.repeat(50)), { startLine: 1, maxChars: 10 });
      expect(page).toMatchObject({ lineCut: true, nextLine: null, endLine: 1 });
    });

    it('returns endLine null past the end', async () => {
      const page = await readLinePage(await make('a\nb\n'), { startLine: 9, maxChars: 100 });
      expect(page).toMatchObject({ content: '', endLine: null, nextLine: null, totalLines: 2 });
    });

    it('handles an empty file', async () => {
      const page = await readLinePage(await make(''), { startLine: 1, maxChars: 100 });
      expect(page).toMatchObject({ content: '', endLine: null, nextLine: null, totalLines: 0 });
    });
  });

  it('streams a 10 MiB file in bounded time', async () => {
    const path = await make('x'.repeat(10 * 1024 * 1024 - 1) + '\n');
    const started = Date.now();
    const page = await readCharPage(path, 5_000_000, 100);
    const elapsedMs = Date.now() - started;
    expect(page.totalChars).toBe(10 * 1024 * 1024);
    expect(page.returnedChars).toBe(100);
    // Generous bound: the scan is normally tens of milliseconds.
    expect(elapsedMs).toBeLessThan(5_000);
    console.info(`file-text benchmark: 10 MiB readCharPage scan took ${elapsedMs} ms`);
  });
});
