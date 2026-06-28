import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { FsEvaluationArtifactStore } from './agent-evaluation-storage-fs.js';

function tmpDir(): string {
  return join(tmpdir(), `eval-store-test-${crypto.randomUUID()}`);
}

describe('FsEvaluationArtifactStore', () => {
  let store: FsEvaluationArtifactStore;
  let root: string;

  beforeEach(async () => {
    root = tmpDir();
    await mkdir(root, { recursive: true });
    store = new FsEvaluationArtifactStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('write → list → read roundtrip', async () => {
    const runId = 'run-1';
    const ref = await store.write(runId, 'test.json', JSON.stringify({ ok: true }));
    expect(ref.name).toBe('test.json');
    expect(ref.mimeType).toBe('application/json');
    expect(ref.sizeBytes).toBeGreaterThan(0);

    const list = await store.list(runId);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('test.json');

    const data = await store.read(runId, 'test.json');
    expect(data).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(data!))).toEqual({ ok: true });
  });

  it('read returns null for missing file', async () => {
    const data = await store.read('run-1', 'nonexistent.json');
    expect(data).toBeNull();
  });

  it('list returns empty array for unknown runId', async () => {
    const list = await store.list('unknown-run');
    expect(list).toEqual([]);
  });

  it('write accepts string and Uint8Array', async () => {
    const runId = 'run-2';
    const strRef = await store.write(runId, 'str.txt', 'hello');
    const bufRef = await store.write(runId, 'buf.bin', new Uint8Array([1, 2, 3]));

    expect(strRef.mimeType).toBe('text/plain');
    expect(bufRef.mimeType).toBe('application/octet-stream');

    const strData = await store.read(runId, 'str.txt');
    expect(new TextDecoder().decode(strData!)).toBe('hello');

    const bufData = await store.read(runId, 'buf.bin');
    expect(bufData).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('list returns correct mime types', async () => {
    const runId = 'run-3';
    await store.write(runId, 'report.md', '# Report');
    await store.write(runId, 'data.csv', 'a,b,c');
    await store.write(runId, 'config.yaml', 'key: value');
    await store.write(runId, 'unknown.xyz', 'data');

    const list = await store.list(runId);
    expect(list).toHaveLength(4);
    const byName = Object.fromEntries(list.map((r) => [r.name, r.mimeType]));
    expect(byName['report.md']).toBe('text/markdown');
    expect(byName['data.csv']).toBe('text/csv');
    expect(byName['config.yaml']).toBe('application/yaml');
    expect(byName['unknown.xyz']).toBe('application/octet-stream');
  });

  it('multiple runs are isolated', async () => {
    await store.write('run-a', 'a.json', '{}');
    await store.write('run-b', 'b.json', '{}');

    const listA = await store.list('run-a');
    const listB = await store.list('run-b');

    expect(listA).toHaveLength(1);
    expect(listA[0]!.name).toBe('a.json');
    expect(listB).toHaveLength(1);
    expect(listB[0]!.name).toBe('b.json');
  });
});
