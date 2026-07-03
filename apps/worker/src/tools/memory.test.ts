import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memoryTools } from './memory.js';

// Minimal ToolContext stub
function makeCtx(store: Record<string, Record<string, string>> = {}): Parameters<typeof memoryTools[0]['execute']>[1] {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async (key: string, field: string, value: string) => {
        store[key] ??= {};
        store[key]![field] = value;
        return 1;
      }),
      hget: vi.fn(async (key: string, field: string) => store[key]?.[field] ?? null),
      hgetall: vi.fn(async (key: string) => store[key] ?? null),
      hdel: vi.fn(async (key: string, ...fields: string[]) => {
        let count = 0;
        for (const f of fields) {
          if (store[key]?.[f] !== undefined) {
            delete store[key]![f];
            count++;
          }
        }
        return count;
      }),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
  };
}

const setMemory = memoryTools.find((t) => t.name === 'set_memory')!;
const getMemory = memoryTools.find((t) => t.name === 'get_memory')!;
const listMemoryKeys = memoryTools.find((t) => t.name === 'list_memory_keys')!;
const deleteMemory = memoryTools.find((t) => t.name === 'delete_memory')!;

describe('memory tools', () => {
  let store: Record<string, Record<string, string>>;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    store = {};
    ctx = makeCtx(store);
  });

  it('set_memory stores a JSON-serialised value', async () => {
    const result = await setMemory.execute({ key: 'foo', value: { x: 1 } }, ctx);
    expect(result.success).toBe(true);
    expect(store['agent:memory:agent-1']?.['foo']).toBe(JSON.stringify({ x: 1 }));
  });

  it('get_memory returns found:true with decoded value for an existing key', async () => {
    store['agent:memory:agent-1'] = { bar: JSON.stringify([1, 2, 3]) };
    const result = await getMemory.execute({ key: 'bar' }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ ok: true, found: true, value: [1, 2, 3] });
  });

  it('get_memory returns found:false for a missing key', async () => {
    const result = await getMemory.execute({ key: 'missing' }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ ok: true, found: false });
  });

  it('list_memory_keys returns stable sorted key ordering', async () => {
    store['agent:memory:agent-1'] = { z: '1', a: '2', m: '3' };
    const result = await listMemoryKeys.execute({}, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { keys: string[] }).keys).toEqual(['a', 'm', 'z']);
  });

  it('list_memory_keys returns empty array when no keys', async () => {
    const result = await listMemoryKeys.execute({}, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { keys: string[] }).keys).toEqual([]);
  });

  it('delete_memory removes the specified keys and reports removed count', async () => {
    store['agent:memory:agent-1'] = { a: '1', b: '2', c: '3' };
    const result = await deleteMemory.execute({ keys: ['a', 'c'] }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { removed: number }).removed).toBe(2);
    expect(store['agent:memory:agent-1']).toEqual({ b: '2' });
  });

  it('delete_memory reports zero for missing keys', async () => {
    const result = await deleteMemory.execute({ keys: ['nonexistent'] }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { removed: number }).removed).toBe(0);
  });
});
