import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { blueprintRoutes } from './blueprints.js';
import type { Database } from '@herobids/db';

const TEST_USER_ID = 'user-1';
const BLUEPRINT_ID = 'bp-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>, userId = TEST_USER_ID) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
  });
}

// Builds a chainable DB mock that resolves to a fixed value when awaited.
function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

const stubBlueprint = {
  id: BLUEPRINT_ID,
  userId: TEST_USER_ID,
  name: 'My Blueprint',
  description: null,
  configData: { strategy: { type: 'momentum', decisionMode: 'mechanical' }, execution: { mode: 'paper' } },
  configVersion: 1,
  visibility: 'private',
  strategyPreset: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildDb(
  selectRows: unknown[] = [stubBlueprint],
  subsequentRows: unknown[] = [],
): Database {
  let selectCallCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      return makeChain(selectCallCount === 1 ? selectRows : subsequentRows);
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  } as unknown as Database;
}

// ─── GET /blueprints/presets ───────────────────────────────────────────────

describe('GET /blueprints/presets', () => {
  it('returns list of all 7 presets', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/blueprints/presets' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.presets).toHaveLength(7);
    const keys = body.presets.map((p: { key: string }) => p.key);
    expect(keys).toContain('momentum');
    expect(keys).toContain('dca');
    expect(keys).toContain('scalper');
  });
});

// ─── GET /presets/for-agent ───────────────────────────────────────────────

describe('GET /presets/for-agent', () => {
  it('returns an agent-consumable split for a technical strategy', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/presets/for-agent?strategy=momentum&style=standard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('technical');
    expect(body).toHaveProperty('risk');
    expect(body).toHaveProperty('execution');
    // Execution uses the unified agent field name
    expect(body.execution).not.toHaveProperty('positionSize');
  });

  it('rejects dca for agent preset application with preset_not_supported_for_agent', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/presets/for-agent?strategy=dca&style=standard' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('preset_not_supported_for_agent');
  });
});

// ─── GET /blueprints/defaults ─────────────────────────────────────────────

describe('GET /blueprints/defaults', () => {
  it('returns default config fields', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/blueprints/defaults' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaults).toHaveProperty('strategy');
    expect(body.defaults).toHaveProperty('execution');
  });
});

// ─── POST /blueprints/from-preset ────────────────────────────────────────

describe('POST /blueprints/from-preset', () => {
  it('creates a blueprint from a known preset and returns 201', async () => {
    // select after insert returns the new blueprint row
    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : []);
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints/from-preset',
      payload: { preset: 'momentum' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe(BLUEPRINT_ID);
  });

  it('returns 404 for nonexistent preset', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints/from-preset',
      payload: { preset: 'nonexistent' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('preset_not_found');
  });

  it('merges overrides on top of preset configData', async () => {
    let capturedValues: Record<string, unknown> | null = null;
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([stubBlueprint])),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues = vals;
          return Promise.resolve(undefined);
        }),
      }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    await app.inject({
      method: 'POST',
      url: '/blueprints/from-preset',
      payload: { preset: 'momentum', overrides: { myOverride: true } },
    });

    const configData = capturedValues?.['configData'] as Record<string, unknown> | undefined;
    expect(configData?.['myOverride']).toBe(true);
    // Base preset strategy should still be present
    expect((configData?.['strategy'] as Record<string, unknown> | undefined)?.['type']).toBe('momentum');
  });

  it('nested override merges into the section rather than replacing it', async () => {
    let capturedValues2: Record<string, unknown> | null = null;
    const db2 = {
      select: vi.fn().mockImplementation(() => makeChain([stubBlueprint])),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues2 = vals;
          return Promise.resolve(undefined);
        }),
      }),
    } as unknown as Database;
    const app2 = Fastify();
    decorateWithAuth(app2);
    await blueprintRoutes(app2, db2);

    // Override only one field inside the strategy section.
    await app2.inject({
      method: 'POST',
      url: '/blueprints/from-preset',
      payload: { preset: 'momentum', overrides: { strategy: { params: { candleLimit: 60 } } } },
    });

    const configData2 = capturedValues2?.['configData'] as Record<string, unknown> | undefined;
    const strategy = configData2?.['strategy'] as Record<string, unknown> | undefined;
    const params = strategy?.['params'] as Record<string, unknown> | undefined;
    // The override updates params.candleLimit
    expect(params?.['candleLimit']).toBe(60);
    // But must NOT drop sibling fields from the strategy level
    expect(strategy?.['type']).toBe('momentum');
    expect(strategy?.['decisionMode']).toBeDefined();
    // And must NOT drop sibling fields within params
    expect(params?.['candleInterval']).toBeDefined();
    expect(params?.['stopLossPct']).toBeDefined();
    expect(params?.['takeProfitPct']).toBeDefined();
    expect(params?.['signalBias']).toBeDefined();
    // Nested indicators object must be preserved entirely
    const indicators = params?.['indicators'] as Record<string, unknown> | undefined;
    expect(indicators).toBeDefined();
    const rsi = indicators?.['rsi'] as Record<string, unknown> | undefined;
    expect(rsi?.['enabled']).toBe(true);
    expect(rsi?.['period']).toBe(14);
  });
});

// ─── GET /blueprints ───────────────────────────────────────────────────────

describe('GET /blueprints', () => {
  it('returns 200 with user blueprints', async () => {
    const db = buildDb([stubBlueprint]);
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/blueprints' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.blueprints)).toBe(true);
  });
});

// ─── POST /blueprints ─────────────────────────────────────────────────────

describe('POST /blueprints', () => {
  it('creates a blueprint and returns 201', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([stubBlueprint])),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints',
      payload: {
        name: 'My Blueprint',
        configData: { strategy: { type: 'momentum' } },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe(BLUEPRINT_ID);
  });

  it('returns 400 when name is missing', async () => {
    const db = buildDb();
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/blueprints',
      payload: { configData: { strategy: { type: 'momentum' } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });
});

// ─── GET /blueprints/:id ──────────────────────────────────────────────────

describe('GET /blueprints/:id', () => {
  it('returns 200 for owned blueprint', async () => {
    const db = buildDb([stubBlueprint]);
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/blueprints/${BLUEPRINT_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(BLUEPRINT_ID);
  });

  it('returns 200 for public blueprint owned by another user', async () => {
    const publicBlueprint = { ...stubBlueprint, userId: 'other-user', visibility: 'public' };
    const db = buildDb([publicBlueprint]);
    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/blueprints/${BLUEPRINT_ID}` });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for private blueprint owned by another user', async () => {
    const db = buildDb([]); // DB returns nothing (query excludes private other-user rows)
    const app = Fastify();
    decorateWithAuth(app, TEST_USER_ID);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/blueprints/${BLUEPRINT_ID}` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── PUT /blueprints/:id ──────────────────────────────────────────────────

describe('PUT /blueprints/:id', () => {
  it('updates blueprint and increments configVersion when configData changes', async () => {
    let capturedSet: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [stubBlueprint]);
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((fields: Record<string, unknown>) => {
          capturedSet = fields;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      payload: { configData: { strategy: { type: 'dca' } } },
    });

    expect(res.statusCode).toBe(200);
    // configVersion should be stubBlueprint.configVersion + 1 = 2
    expect(capturedSet?.['configVersion']).toBe(2);
    expect((capturedSet?.['configData'] as Record<string, unknown> | undefined)?.['strategy']).toBeDefined();
  });

  it('increments configVersion on every PUT, even when only name changes', async () => {
    let capturedSet: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [stubBlueprint]);
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((fields: Record<string, unknown>) => {
          capturedSet = fields;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      payload: { name: 'Renamed' },
    });

    expect(res.statusCode).toBe(200);
    // configVersion must increment on every PUT regardless of which fields changed.
    expect(capturedSet?.['configVersion']).toBe(stubBlueprint.configVersion + 1);
    expect(capturedSet?.['name']).toBe('Renamed');
  });

  it('PUT configData deep-merges nested params without dropping siblings', async () => {
    // stubBlueprint.configData has strategy with type + decisionMode.
    // Override only strategy.type; existing strategy.decisionMode and
    // untouched sections (execution) must survive.
    let capturedSet: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [stubBlueprint]);
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((fields: Record<string, unknown>) => {
          capturedSet = fields;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      // Only updating one field inside 'strategy'.
      payload: { configData: { strategy: { type: 'scalper' } } },
    });

    expect(res.statusCode).toBe(200);
    const merged = capturedSet?.['configData'] as Record<string, unknown> | undefined;
    // The sent section should be applied.
    expect((merged?.['strategy'] as Record<string, unknown> | undefined)?.['type']).toBe('scalper');
    // The untouched 'execution' section from stubBlueprint.configData must be preserved.
    expect(merged?.['execution']).toBeDefined();
    // Sibling keys within the strategy section must be preserved.
    expect((merged?.['strategy'] as Record<string, unknown> | undefined)?.['decisionMode']).toBe('mechanical');
    // Execution section mode must be preserved.
    expect((merged?.['execution'] as Record<string, unknown> | undefined)?.['mode']).toBe('paper');
  });

  it('serializes concurrent blueprint edits inside a transaction lock', async () => {
    let executedLock = false;
    let capturedSet: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockImplementation(async () => {
        executedLock = true;
        return { rows: [] };
      }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [stubBlueprint]);
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((fields: Record<string, unknown>) => {
          capturedSet = fields;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      payload: { name: 'Locked update' },
    });

    expect(res.statusCode).toBe(200);
    expect(executedLock).toBe(true);
    expect(capturedSet?.['configVersion']).toBe(stubBlueprint.configVersion + 1);
  });

  it('returns 404 for blueprint not owned by the user', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => makeChain([])),
      update: vi.fn(),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({
      method: 'PUT',
      url: `/blueprints/${BLUEPRINT_ID}`,
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── DELETE /blueprints/:id ───────────────────────────────────────────────

describe('DELETE /blueprints/:id', () => {
  it('returns 204 when no running bot references the blueprint', async () => {
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        // call 1: ownership check → found; call 2: running bot check → none
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : []);
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BLUEPRINT_ID}` });
    expect(res.statusCode).toBe(204);
  });

  it('returns 409 when a running bot references the blueprint', async () => {
    let selectCallCount = 0;
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        // call 1: ownership check → found; call 2: running bot → found
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [{ id: 'bot-1' }]);
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BLUEPRINT_ID}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('blueprint_in_use');
  });

  it('returns 404 for blueprint not owned by the user', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => makeChain([])),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: `/blueprints/${BLUEPRINT_ID}` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /blueprints/:id/clone ───────────────────────────────────────────

describe('POST /blueprints/:id/clone', () => {
  it('returns 201 with cloned blueprint owned by the caller', async () => {
    const clonedBlueprint = { ...stubBlueprint, id: 'bp-cloned', name: 'My Blueprint (copy)' };
    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        // call 1: source lookup; call 2: fetch clone after insert
        return makeChain(selectCallCount === 1 ? [stubBlueprint] : [clonedBlueprint]);
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/clone` });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('My Blueprint (copy)');
  });

  it('returns 404 when source blueprint does not exist', async () => {
    const db = buildDb([]);
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/clone` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /blueprints/:id/publish and /unpublish ──────────────────────────

describe('POST /blueprints/:id/publish and /unpublish', () => {
  it('publish returns 200 with visibility=public', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => makeChain([stubBlueprint])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/publish` });
    expect(res.statusCode).toBe(200);
    expect(res.json().visibility).toBe('public');
  });

  it('unpublish returns 200 with visibility=private', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => makeChain([{ ...stubBlueprint, visibility: 'public' }])),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/unpublish` });
    expect(res.statusCode).toBe(200);
    expect(res.json().visibility).toBe('private');
  });

  it('publish returns 404 for blueprint not owned by the user', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn().mockImplementation(() => makeChain([])),
    };
    const db = {
      transaction: vi.fn().mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await blueprintRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: `/blueprints/${BLUEPRINT_ID}/publish` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /bots with blueprintId ─────────────────────────────────────────

describe('POST /bots with blueprintId', () => {
  const mockRedis = {
    xadd: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('ioredis').Redis;

  it('creates bot from blueprint and stores configSnapshot', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    let capturedBotValues: Record<string, unknown> | null = null;
    let selectCallCount = 0;
    const db = {
      // Blueprint lookup outside transaction
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Blueprint lookup: return stubBlueprint
          return makeChain([{ id: BLUEPRINT_ID, configData: stubBlueprint.configData }]);
        }
        // Final select to fetch inserted bot
        return makeChain([{
          id: 'new-bot',
          userId: TEST_USER_ID,
          blueprintId: BLUEPRINT_ID,
          configSnapshot: stubBlueprint.configData,
          config: stubBlueprint.configData,
          status: 'stopped',
        }]);
      }),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ id: 'tb-1', userId: TEST_USER_ID, provider: 'hyperliquid', label: 'Test', status: 'active', resolvedVenueAccountId: 'va-1' }]),
            }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
              capturedBotValues = vals;
              return Promise.resolve(undefined);
            }),
          }),
        };
        return callback(tx);
      }),
    } as unknown as Database;

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        blueprintId: BLUEPRINT_ID,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(capturedBotValues?.['blueprintId']).toBe(BLUEPRINT_ID);
    expect(capturedBotValues?.['configSnapshot']).toBeDefined();
    // Deprecation header should NOT be set when using blueprintId
    expect(res.headers['deprecation']).toBeUndefined();
  });

  it('returns 404 when referenced blueprint does not exist', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const db = {
      // Blueprint lookup returns nothing
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        blueprintId: 'bp-nonexistent',
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/blueprint/i);
  });

  it('sets Deprecation header when using legacy inline config', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ id: 'new-bot', userId: TEST_USER_ID, status: 'stopped' }])),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: 'tb-1', userId: TEST_USER_ID, provider: 'hyperliquid', label: 'Test', status: 'active', resolvedVenueAccountId: 'va-1' }]) }),
          }),
          insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
        };
        return callback(tx);
      }),
    } as unknown as Database;

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: { strategy: { type: 'momentum', decisionMode: 'mechanical' }, symbol: 'BTC-PERP' },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers['deprecation']).toBe('true');
  });

  it('returns 400 when configOverrides is supplied without blueprintId', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const db = {} as unknown as Database;

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        config: { strategy: { type: 'momentum' } },
        configOverrides: { strategy: { lookbackPeriod: 21 } },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 404 (not 500) when blueprint is deleted between lookup and insert (FK race)', async () => {
    const { botRoutes } = await import('./bots.js');
    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const { PlansConfigSchema } = await import('@herobids/domain');
    const plansConfig = PlansConfigSchema.parse({});

    const db = {
      // Blueprint lookup returns the blueprint (it exists at pre-transaction check time).
      select: vi.fn().mockImplementation(() =>
        makeChain([{ id: BLUEPRINT_ID, configData: stubBlueprint.configData }]),
      ),
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: 'tb-1', userId: TEST_USER_ID, provider: 'hyperliquid', label: 'Test', status: 'active', resolvedVenueAccountId: 'va-1' }]) }),
          }),
          insert: vi.fn().mockReturnValue({
            // Simulate the FK violation thrown when blueprint is deleted concurrently.
            values: vi.fn().mockRejectedValue(Object.assign(new Error('FK violation'), { code: '23503' })),
          }),
        };
        return callback(tx);
      }),
    } as unknown as Database;

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = TEST_USER_ID;
      request.userPlanId = 'free';
    });
    await botRoutes(app, mockQueue as unknown as import('bullmq').Queue, db, mockRedis, plansConfig);

    const res = await app.inject({
      method: 'POST',
      url: '/bots',
      payload: {
        connectionId: 'tb-1',
        venue: 'hyperliquid',
        symbol: 'BTC-PERP',
        blueprintId: BLUEPRINT_ID,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/blueprint/i);
  });
});
