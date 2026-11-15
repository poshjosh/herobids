import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { ToolContext } from '@herobids/domain';

vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

import { resolve4, resolve6 } from 'node:dns/promises';
import { webAccessTools } from './web-access.js';
import { saveToWebCache, webCacheFileName } from './web-cache.js';

const browseUrlTool = webAccessTools.find((t) => t.name === 'browse_url')!;

const MIB = 1024 * 1024;
const URL_A = 'https://example.com/long-page';

interface BrowseData {
  url: string;
  title: string;
  truncated: boolean;
  sourceTruncated: boolean;
  totalChars: number;
  returnedChars: number;
  nextOffset: number | null;
  savedTo?: string;
  saveError?: string;
  hint?: string;
  content: string;
}

function ctx(): ToolContext {
  return { agentId: 'agent-browse-test', sessionId: 'session-browse-test' } as ToolContext;
}

function html(text: string): string {
  return `<html><head><title>Long</title></head><body><p>${text}</p></body></html>`;
}

function stubFetchBody(body: string): void {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    sent = false;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          cancel: async () => undefined,
        }),
      },
    };
  }));
}

async function browse(args: Record<string, unknown>, url = URL_A): Promise<{ success: boolean; data?: BrowseData; error?: string; errorCode?: string }> {
  const result = await browseUrlTool.execute({ url, ...args }, ctx());
  return result as { success: boolean; data?: BrowseData; error?: string; errorCode?: string };
}

describe('browse_url page and web cache', () => {
  let root: string;
  const saved = {
    root: process.env['AGENT_WORKSPACE_ROOT'],
    config: process.env['AGENT_RUNTIME_CONFIG_JSON'],
    quota: process.env['AGENT_WORKSPACE_QUOTA_MB'],
  };

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(resolve6).mockResolvedValue([]);
    root = await mkdtemp(join(os.tmpdir(), 'herobids-browse-'));
    process.env['AGENT_WORKSPACE_ROOT'] = root;
    delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    delete process.env['AGENT_WORKSPACE_QUOTA_MB'];
  });

  afterEach(async () => {
    restore('AGENT_WORKSPACE_ROOT', saved.root);
    restore('AGENT_RUNTIME_CONFIG_JSON', saved.config);
    restore('AGENT_WORKSPACE_QUOTA_MB', saved.quota);
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  async function cacheFiles(): Promise<string[]> {
    try {
      return await readdir(join(root, 'web-cache'));
    } catch {
      return [];
    }
  }

  async function put(rel: string, bytes: number): Promise<void> {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, Buffer.alloc(bytes, 97));
  }

  it('returns the whole text inline when it fits one page and writes nothing', async () => {
    stubFetchBody(html('short page text'));
    const result = await browse({});
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ truncated: false, sourceTruncated: false, nextOffset: null });
    expect(result.data?.content).toContain('short page text');
    expect(result.data?.savedTo).toBeUndefined();
    expect(await cacheFiles()).toEqual([]);
  });

  it('returns the first page, totalChars and savedTo when the text is longer than one page', async () => {
    const text = 'abcdefghij'.repeat(30); // 300 chars
    stubFetchBody(html(text));
    const result = await browse({ limit: 100 });
    const data = result.data!;
    expect(data.truncated).toBe(true);
    expect(data.sourceTruncated).toBe(false);
    expect(data.returnedChars).toBe(100);
    expect(data.totalChars).toBeGreaterThanOrEqual(300);
    expect(data.content).toHaveLength(100);
    expect(data.nextOffset).toBe(100);
    expect(data.savedTo).toMatch(/^web-cache\/example\.com-[0-9a-f]{12}\.txt$/);
    expect(data.saveError).toBeUndefined();
  });

  it('saves the full cleaned text and the continue hint names read_file with savedTo and nextOffset', async () => {
    stubFetchBody(html('abcdefghij'.repeat(30)));
    const data = (await browse({ limit: 100 })).data!;
    const file = await readFile(join(root, data.savedTo!), 'utf8');
    expect([...file]).toHaveLength(data.totalChars);
    expect(file.startsWith(data.content)).toBe(true);
    expect(data.hint).toContain(`read_file(path: "${data.savedTo}", offset: 100)`);
  });

  it('puts the small metadata keys and the hint before the content key', async () => {
    stubFetchBody(html('abcdefghij'.repeat(30)));
    const data = (await browse({ limit: 100 })).data!;
    const keys = Object.keys(data);
    expect(keys[keys.length - 1]).toBe('content');
    expect(keys.indexOf('savedTo')).toBeLessThan(keys.indexOf('content'));
    expect(keys.indexOf('hint')).toBeLessThan(keys.indexOf('content'));
  });

  it('uses the default page size when limit is not given', async () => {
    stubFetchBody(html('x'.repeat(60_000)));
    const data = (await browse({})).data!;
    expect(data.returnedChars).toBe(50_000);
    expect(data.truncated).toBe(true);
    expect(data.savedTo).toBeDefined();
  });

  it('counts the page size in code points, never splitting a surrogate pair', async () => {
    stubFetchBody(html('😀'.repeat(200)));
    const data = (await browse({ limit: 101 })).data!;
    expect([...data.content]).toHaveLength(101);
    expect(data.content).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('truncated is true when the inline text is cut even if the source was not capped', async () => {
    stubFetchBody(html('y'.repeat(500)));
    const data = (await browse({ limit: 50 })).data!;
    expect(data.truncated).toBe(true);
    expect(data.sourceTruncated).toBe(false);
  });

  it('sourceTruncated is true only when the fetch cap was hit', async () => {
    stubFetchBody(html('z'.repeat(5_000)));
    const capabilityEngine = {
      checkAccess: vi.fn(() => undefined),
      recordStart: vi.fn(),
      recordEnd: vi.fn(),
      getGrant: vi.fn(() => ({ limits: { maxResponseBytes: 2_000, timeoutMs: 15_000 } })),
    } as unknown as ToolContext['capabilityEngine'];
    const result = await browseUrlTool.execute({ url: URL_A, limit: 100 }, { ...ctx(), capabilityEngine });
    const data = result.data as BrowseData;
    expect(data.sourceTruncated).toBe(true);
    expect(data.truncated).toBe(true);
  });

  it('the same URL overwrites the same file', async () => {
    stubFetchBody(html('a'.repeat(300)));
    const first = (await browse({ limit: 100 })).data!;
    stubFetchBody(html('b'.repeat(400)));
    const second = (await browse({ limit: 100 })).data!;
    expect(second.savedTo).toBe(first.savedTo);
    expect(await cacheFiles()).toHaveLength(1);
    expect(await readFile(join(root, second.savedTo!), 'utf8')).toContain('b'.repeat(400));
  });

  it('refuses a limit above the configured maximum before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await browse({ limit: 500_001 });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('file.limit_too_large');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the page with saveError and saves nothing when the cache cap would be passed', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { webAccess: { webCache: { sizeMb: 1 } } } });
    await put('web-cache/old-page.txt', MIB);
    stubFetchBody(html('c'.repeat(300)));
    const result = await browse({ limit: 100 });
    expect(result.success).toBe(true);
    expect(result.data?.savedTo).toBeUndefined();
    expect(result.data?.nextOffset).toBeNull();
    expect(result.data?.content).toHaveLength(100);
    expect(result.data?.saveError).toContain('delete_file(path)');
    expect(result.data?.saveError).toContain('web-cache/');
    expect(await cacheFiles()).toEqual(['old-page.txt']);
  });

  it('returns the page with saveError and saves nothing when the quota would be passed', async () => {
    process.env['AGENT_WORKSPACE_QUOTA_MB'] = '1';
    await put('notes/big.txt', MIB);
    stubFetchBody(html('d'.repeat(300)));
    const result = await browse({ limit: 100 });
    expect(result.success).toBe(true);
    expect(result.data?.savedTo).toBeUndefined();
    expect(result.data?.saveError).toContain('delete_file(path)');
    expect(await cacheFiles()).toEqual([]);
  });

  it('never deletes any file, also when the cache is full', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { webAccess: { webCache: { sizeMb: 1 } } } });
    await put('web-cache/one.txt', MIB / 2);
    await put('web-cache/two.txt', MIB / 2);
    await put('notes/keep.txt', 10);
    stubFetchBody(html('e'.repeat(300)));
    await browse({ limit: 100 });
    expect((await cacheFiles()).sort()).toEqual(['one.txt', 'two.txt']);
    expect(await readdir(join(root, 'notes'))).toEqual(['keep.txt']);
  });

  it('saves again after the agent deleted a file and called again', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { webAccess: { webCache: { sizeMb: 1 } } } });
    await put('web-cache/old-page.txt', MIB);
    stubFetchBody(html('f'.repeat(300)));
    expect((await browse({ limit: 100 })).data?.savedTo).toBeUndefined();
    await rm(join(root, 'web-cache/old-page.txt'));
    const again = await browse({ limit: 100 });
    expect(again.data?.savedTo).toBeDefined();
    expect(again.data?.saveError).toBeUndefined();
  });

  it('skips saving without an error when sizeMb is 0', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { webAccess: { webCache: { sizeMb: 0 } } } });
    stubFetchBody(html('g'.repeat(300)));
    const result = await browse({ limit: 100 });
    expect(result.success).toBe(true);
    expect(result.data?.truncated).toBe(true);
    expect(result.data?.savedTo).toBeUndefined();
    expect(result.data?.saveError).toBeUndefined();
    expect(result.data?.nextOffset).toBeNull();
    expect(await cacheFiles()).toEqual([]);
  });

  it('still blocks http and private hosts', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await browse({}, 'http://example.com')).success).toBe(false);
    vi.mocked(resolve4).mockResolvedValue(['10.0.0.1']);
    expect((await browse({}, 'https://internal.example.com')).error).toContain('private or reserved IP');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('describes the page size, the saved copy and the untrusted text rule', () => {
    expect(browseUrlTool.description).toContain('50000');
    expect(browseUrlTool.description).toContain('savedTo');
    expect(browseUrlTool.description).toContain('read_file(path, offset)');
    expect(browseUrlTool.description).toContain('untrusted');
  });
});

describe('shared fetch cap', () => {
  const savedConfig = process.env['AGENT_RUNTIME_CONFIG_JSON'];
  const savedRoot = process.env['AGENT_WORKSPACE_ROOT'];
  let root: string;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(resolve6).mockResolvedValue([]);
    root = await mkdtemp(join(os.tmpdir(), 'herobids-fetchcap-'));
    process.env['AGENT_WORKSPACE_ROOT'] = root;
  });

  afterEach(async () => {
    if (savedConfig === undefined) delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    else process.env['AGENT_RUNTIME_CONFIG_JSON'] = savedConfig;
    if (savedRoot === undefined) delete process.env['AGENT_WORKSPACE_ROOT'];
    else process.env['AGENT_WORKSPACE_ROOT'] = savedRoot;
    vi.unstubAllGlobals();
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  function engineWithoutByteGrant(): ToolContext['capabilityEngine'] {
    return {
      checkAccess: vi.fn(() => undefined),
      recordStart: vi.fn(),
      recordEnd: vi.fn(),
      getGrant: vi.fn(() => ({ limits: { timeoutMs: 15_000 } })),
    } as unknown as ToolContext['capabilityEngine'];
  }

  it('browse_url uses the config cap when no grant sets one', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { webAccess: { browseUrl: { maxResponseBytes: 2_000 } } } });
    vi.resetModules();
    const fresh = await import('./web-access.js');
    const tool = fresh.webAccessTools.find((t) => t.name === 'browse_url')!;
    stubFetchBody(html('h'.repeat(5_000)));
    const result = await tool.execute({ url: URL_A, limit: 100 }, { ...ctx(), capabilityEngine: engineWithoutByteGrant() });
    expect((result.data as BrowseData).sourceTruncated).toBe(true);
  });

  it('browse_url falls back to the 1 MiB schema default, so a 600 KiB page is not cut', async () => {
    delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    stubFetchBody(html('i'.repeat(600 * 1024)));
    const result = await browseUrlTool.execute({ url: URL_A, limit: 100 }, { ...ctx(), capabilityEngine: engineWithoutByteGrant() });
    const data = result.data as BrowseData;
    expect(data.sourceTruncated).toBe(false);
    expect(data.totalChars).toBeGreaterThanOrEqual(600 * 1024);
  });

  it('read_document fetches a PDF between 512 KiB and 1 MiB under the shared cap', async () => {
    const readDocumentTool = webAccessTools.find((t) => t.name === 'read_document')!;
    const size = 700 * 1024;
    const bytes = new Uint8Array(size);
    let sent = false;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/pdf' : name === 'content-length' ? String(size) : null) },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          cancel: async () => undefined,
        }),
      },
    }));
    const result = await readDocumentTool.execute({ url: 'https://example.com/a.pdf' }, { ...ctx(), capabilityEngine: engineWithoutByteGrant() });
    expect(result.success).toBe(true);
    expect((result.data as { sizeBytes: number; truncated: boolean })).toMatchObject({ sizeBytes: size, truncated: false });
  });
});

describe('saveToWebCache', () => {
  let root: string;
  const saved = {
    root: process.env['AGENT_WORKSPACE_ROOT'],
    config: process.env['AGENT_RUNTIME_CONFIG_JSON'],
    quota: process.env['AGENT_WORKSPACE_QUOTA_MB'],
  };

  beforeEach(async () => {
    root = await mkdtemp(join(os.tmpdir(), 'herobids-webcache-'));
    process.env['AGENT_WORKSPACE_ROOT'] = root;
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({ tools: { webAccess: { webCache: { sizeMb: 1 } } } });
    delete process.env['AGENT_WORKSPACE_QUOTA_MB'];
  });

  afterEach(async () => {
    for (const [name, value] of [
      ['AGENT_WORKSPACE_ROOT', saved.root],
      ['AGENT_RUNTIME_CONFIG_JSON', saved.config],
      ['AGENT_WORKSPACE_QUOTA_MB', saved.quota],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('counts a re-save of the same URL at its net growth', async () => {
    const first = await saveToWebCache('a', URL_A, 'a'.repeat(900 * 1024));
    expect(first.status).toBe('saved');
    // 900 KiB already there + 950 KiB new would pass 1 MiB if counted in full; net growth is 50 KiB.
    const second = await saveToWebCache('a', URL_A, 'b'.repeat(950 * 1024));
    expect(second.status).toBe('saved');
    // A different URL with the cache nearly full is refused.
    const other = await saveToWebCache('a', 'https://example.com/other', 'c'.repeat(200 * 1024));
    expect(other.status).toBe('not_saved');
  });

  it('builds a file name from the host and a hash of the final URL only', () => {
    const name = webCacheFileName('https://Sub.Example.com/a?b=1');
    expect(name).toMatch(/^sub\.example\.com-[0-9a-f]{12}\.txt$/);
    expect(webCacheFileName('https://Sub.Example.com/a?b=2')).not.toBe(name);
    expect(webCacheFileName('https://[::1]/x')).toMatch(/^[a-z0-9.-]*[0-9a-f]{12}\.txt$/);
  });
});
