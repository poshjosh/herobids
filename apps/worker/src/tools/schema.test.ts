import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { schemaTools } from './schema.js';

const getSchema = schemaTools.find((t) => t.name === 'get_schema')!;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('get_schema', () => {
  // -------------------------------------------------------------------------
  // List all schemas
  // -------------------------------------------------------------------------

  it('returns all schema names when name="all"', async () => {
    const ctx = makeCtx();

    const result = await getSchema.execute({ name: 'all' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const schemas = data.schemas as Array<Record<string, unknown>>;
    expect(schemas.length).toBeGreaterThan(0);
    // Verify known schemas are present
    const names = schemas.map((s) => s.name);
    expect(names).toContain('update_own_config.technical');
    expect(names).toContain('update_own_config.intelligence');
    expect(names).toContain('update_own_config.execution');
    expect(names).toContain('update_own_config.risk');
    expect(names).toContain('create_bot.config.strategy');
    // Each entry has description and version
    for (const s of schemas) {
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('description');
      expect(s).toHaveProperty('version');
    }
  });

  // -------------------------------------------------------------------------
  // Known schema lookup
  // -------------------------------------------------------------------------

  it('returns a specific schema with example and version', async () => {
    const ctx = makeCtx();

    const result = await getSchema.execute({ name: 'update_own_config.technical' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.name).toBe('update_own_config.technical');
    expect(data.schema).toBeDefined();
    expect(data.schema).toHaveProperty('type', 'object');
    expect(data.example).toBeDefined();
    expect(data.version).toBe('1.0.0');
    expect(data.description).toBeDefined();
  });

  it('returns the execution schema with correct shape', async () => {
    const ctx = makeCtx();

    const result = await getSchema.execute({ name: 'update_own_config.execution' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const schema = data.schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('mode');
    expect(props).toHaveProperty('positionSizeMode');
    expect(props).toHaveProperty('fixedPositionSize');
  });

  // -------------------------------------------------------------------------
  // Unknown schema
  // -------------------------------------------------------------------------

  it('returns error for unknown schema name', async () => {
    const ctx = makeCtx();

    const result = await getSchema.execute({ name: 'nonexistent.schema' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('schema.not_found');
    expect(result.error).toContain('Unknown schema');
    expect(result.error).toContain('nonexistent.schema');
    // Should include available schemas
    const data = result.data as Record<string, unknown> | undefined;
    expect(data).toBeDefined();
    expect(data!.availableSchemas).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Fixed position size sub-schema
  // -------------------------------------------------------------------------

  it('returns the fixedPositionSize sub-schema with oneOf', async () => {
    const ctx = makeCtx();

    const result = await getSchema.execute({ name: 'update_own_config.execution.fixedPositionSize' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const schema = data.schema as Record<string, unknown>;
    expect(schema).toHaveProperty('oneOf');
  });
});
