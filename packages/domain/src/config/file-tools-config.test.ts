import { describe, expect, it } from 'vitest';
import {
  FileToolsConfigSchema,
  WebCacheConfigSchema,
  WebAccessToolsConfigSchema,
} from './schema.js';

describe('FileToolsConfigSchema', () => {
  it('applies the documented defaults when nothing is configured', () => {
    const config = FileToolsConfigSchema.parse(undefined);
    expect(config.maxFileBytes).toBe(10_485_760);
    expect(config.readDefaultChars).toBe(50_000);
    expect(config.readMaxChars).toBe(500_000);
    expect(config.writeMaxChars).toBe(16_000);
    expect(config.quotaWalkMaxFiles).toBe(2_000);
    expect(config.maxDeleteFiles).toBe(5_000);
    expect(config.platformDirs).toEqual(['sandbox', '.agents', '.claude', 'agent']);
    expect(config.dependencyDirs).toEqual(['node_modules', '.git']);
    expect(config.list).toEqual({ defaultEntries: 500, maxEntries: 2_000 });
    expect(config.search.defaultMatches).toBe(20);
    expect(config.search.maxMatches).toBe(200);
    expect(config.search.deadlineMs).toBe(3_000);
  });

  it('keeps unrelated defaults when only one key is overridden', () => {
    const config = FileToolsConfigSchema.parse({ writeMaxChars: 8_000 });
    expect(config.writeMaxChars).toBe(8_000);
    expect(config.readDefaultChars).toBe(50_000);
  });

  it('rejects a maximum file size above 100 MiB', () => {
    expect(FileToolsConfigSchema.safeParse({ maxFileBytes: 104_857_601 }).success).toBe(false);
  });

  it('rejects a default read page larger than the maximum', () => {
    expect(FileToolsConfigSchema.safeParse({ readDefaultChars: 600_000 }).success).toBe(false);
  });

  it('rejects a default list size larger than its maximum', () => {
    expect(FileToolsConfigSchema.safeParse({ list: { defaultEntries: 3_000 } }).success).toBe(false);
  });

  it('rejects a default match count larger than its maximum', () => {
    expect(FileToolsConfigSchema.safeParse({ search: { defaultMatches: 300 } }).success).toBe(false);
  });
});

describe('WebCacheConfigSchema', () => {
  it('defaults to a 50 MiB cache in web-cache', () => {
    expect(WebCacheConfigSchema.parse(undefined)).toEqual({ sizeMb: 50, dir: 'web-cache' });
  });

  it('accepts 0 to turn saving off', () => {
    expect(WebCacheConfigSchema.parse({ sizeMb: 0 }).sizeMb).toBe(0);
  });

  it('rejects a folder name that could leave the workspace', () => {
    expect(WebCacheConfigSchema.safeParse({ dir: '../x' }).success).toBe(false);
    expect(WebCacheConfigSchema.safeParse({ dir: 'a/b' }).success).toBe(false);
  });
});

describe('WebAccessToolsConfigSchema', () => {
  it('raises the browse_url fetch cap default to 1 MiB and adds the web cache', () => {
    const config = WebAccessToolsConfigSchema.parse({});
    expect(config.browseUrl.maxResponseBytes).toBe(1024 * 1024);
    expect(config.webCache.sizeMb).toBe(50);
  });
});
