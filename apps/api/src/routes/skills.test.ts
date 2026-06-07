import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { skillsRoutes } from './skills.js';
import type { Database } from '@herobids/db';

const TEST_USER_ID = 'user-1';
const SKILL_ID = 'skill-1';

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
  });
}

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

const stubSkill = {
  id: SKILL_ID,
  authorId: TEST_USER_ID,
  name: 'My Skill',
  description: 'A test skill',
  instructions: 'Do something useful',
  requiredTools: [],
  contextRequirements: [],
  requiredGuardrails: [],
  visibility: 'private',
  tags: [],
  forkOf: null,
  suggestedTickIntervalMs: 900000,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const stubBuiltinSkill = {
  ...stubSkill,
  id: 'builtin-1',
  authorId: null,
  visibility: 'built-in',
  name: 'Built-in Skill',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /skills ──────────────────────────────────────────────────────────

describe('GET /skills', () => {
  it('returns own skills + public + built-in skills', async () => {
    const rows = [stubSkill, stubBuiltinSkill];
    const db = {
      select: vi.fn().mockImplementation(() => makeChain(rows)),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/skills' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skills).toHaveLength(2);
  });

  it('returns empty list when no skills exist', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: '/skills' });
    expect(res.statusCode).toBe(200);
    expect(res.json().skills).toEqual([]);
  });
});

// ─── POST /skills ─────────────────────────────────────────────────────────

describe('POST /skills', () => {
  it('creates a skill and returns 201', async () => {
    let selectCount = 0;
    const db = {
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [stubSkill] : []);
      }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: {
        name: 'My Skill',
        description: 'Does things',
        instructions: 'Always be helpful',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('My Skill');
  });

  it('returns 400 when required fields are missing', async () => {
    const db = {} as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: { name: 'Missing desc and instructions' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('uses private visibility by default', async () => {
    let insertedValues: Record<string, unknown> = {};
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
          insertedValues = v;
          return Promise.resolve();
        }),
      }),
      select: vi.fn().mockImplementation(() => makeChain([stubSkill])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    await app.inject({
      method: 'POST',
      url: '/skills',
      payload: { name: 'S', description: 'D', instructions: 'I' },
    });
    expect(insertedValues['visibility']).toBe('private');
  });
});

// ─── GET /skills/:id ──────────────────────────────────────────────────────

describe('GET /skills/:id', () => {
  it('returns 200 for owned skill', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([stubSkill])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/skills/${SKILL_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(SKILL_ID);
  });

  it('returns 404 when skill not found or not accessible', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({ method: 'GET', url: `/skills/${SKILL_ID}` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── PUT /skills/:id ──────────────────────────────────────────────────────

describe('PUT /skills/:id', () => {
  it('updates own skill and returns updated row', async () => {
    let selectCount = 0;
    const updatedSkill = { ...stubSkill, name: 'Updated Name' };
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [stubSkill] : [updatedSkill]);
      }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${SKILL_ID}`,
      payload: { name: 'Updated Name' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Updated Name');
  });

  it('returns 404 when skill not owned by user', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${SKILL_ID}`,
      payload: { name: 'Hack' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── DELETE /skills/:id ───────────────────────────────────────────────────

describe('DELETE /skills/:id', () => {
  it('deletes own skill and returns 204', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ id: SKILL_ID, authorId: TEST_USER_ID }])),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: `/skills/${SKILL_ID}` });
    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when skill not owned by user', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({ method: 'DELETE', url: `/skills/${SKILL_ID}` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /skills/:id/fork ────────────────────────────────────────────────

describe('POST /skills/:id/fork', () => {
  it('creates a private copy and returns 201', async () => {
    const forkedSkill = { ...stubSkill, id: 'fork-1', name: 'My Skill (fork)', visibility: 'private', forkOf: SKILL_ID };
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [stubSkill] : [forkedSkill]);
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: `/skills/${SKILL_ID}/fork` });
    expect(res.statusCode).toBe(201);
    expect(res.json().visibility).toBe('private');
    expect(res.json().forkOf).toBe(SKILL_ID);
  });

  it('fork sets visibility to private even if source is public', async () => {
    const publicSkill = { ...stubSkill, visibility: 'public' };
    let insertedValues: Record<string, unknown> = {};
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [publicSkill] : [{ ...publicSkill, visibility: 'private' }]);
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
          insertedValues = v;
          return Promise.resolve();
        }),
      }),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    await app.inject({ method: 'POST', url: `/skills/${SKILL_ID}/fork` });
    expect(insertedValues['visibility']).toBe('private');
    expect(insertedValues['authorId']).toBe(TEST_USER_ID);
  });

  it('returns 404 when source skill is not accessible', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    } as unknown as Database;
    const app = Fastify();
    decorateWithAuth(app);
    await skillsRoutes(app, db);

    const res = await app.inject({ method: 'POST', url: `/skills/${SKILL_ID}/fork` });
    expect(res.statusCode).toBe(404);
  });
});
