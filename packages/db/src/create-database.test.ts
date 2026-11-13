import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the options passed to the postgres client factory without opening a
// real connection. drizzle only needs a callable client, so the stub is enough.
const postgresCalls: Array<{ connectionString: string; options: unknown }> = [];

vi.mock('postgres', () => ({
  default: (connectionString: string, options?: unknown) => {
    postgresCalls.push({ connectionString, options });
    // Minimal stand-in: drizzle(postgres-js) treats the client as a tagged-template
    // function plus a few methods; nothing here calls them.
    const client = (() => undefined) as unknown as Record<string, unknown>;
    client['options'] = { parsers: {}, serializers: {} };
    return client;
  },
}));

// drizzle is imported by the module under test; a light stub avoids needing the
// real client shape. It just echoes the client so $client is reachable if needed.
vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: (client: unknown) => ({ $client: client }),
}));

const { createDatabase } = await import('./index.js');

describe('createDatabase pool options', () => {
  beforeEach(() => {
    postgresCalls.length = 0;
  });

  it('passes no pool options when called with just a connection string (default preserved)', () => {
    createDatabase('postgres://user:pass@localhost:5432/db');
    expect(postgresCalls).toHaveLength(1);
    expect(postgresCalls[0]?.connectionString).toBe('postgres://user:pass@localhost:5432/db');
    // No max / idle_timeout keys, so the postgres library keeps its own defaults.
    expect(postgresCalls[0]?.options).toEqual({});
  });

  it('passes through max and idle_timeout when provided', () => {
    createDatabase('postgres://user:pass@localhost:5432/db', { max: 2, idleTimeoutSeconds: 30 });
    expect(postgresCalls[0]?.options).toEqual({ max: 2, idle_timeout: 30 });
  });

  it('passes only the options that are set, leaving the rest at the library default', () => {
    createDatabase('postgres://user:pass@localhost:5432/db', { max: 5 });
    expect(postgresCalls[0]?.options).toEqual({ max: 5 });

    postgresCalls.length = 0;
    createDatabase('postgres://user:pass@localhost:5432/db', { idleTimeoutSeconds: 10 });
    expect(postgresCalls[0]?.options).toEqual({ idle_timeout: 10 });
  });
});
