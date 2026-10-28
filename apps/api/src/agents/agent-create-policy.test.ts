import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { agents, agentConnections, agentSkills, users, checkAgentLimit } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { err, ok } from '@herobids/domain';
import { consumeTokenBucketToken } from '../services/token-bucket.js';
import {
  AgentChildDuplicateError,
  AgentCreatePolicyError,
  consumeAgentCreateToken,
  evaluateAgentCreatePolicy,
  type AgentCreatePolicyInput,
  type AgentPolicyReader,
} from './agent-create-policy.js';

// The plan total and the creation lock are faked. The reads go through an in-memory reader that
// evaluates the same drizzle conditions the policy builds, so each rule sees the rows it would see in SQL.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => ({ kind: 'eq', column, value }),
    gte: (column: unknown, value: unknown) => ({ kind: 'gte', column, value }),
    and: (...conditions: unknown[]) => ({ kind: 'and', conditions }),
  };
});

vi.mock('@herobids/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, checkAgentLimit: vi.fn(), lockUserAgentCreation: vi.fn() };
});

vi.mock('../services/token-bucket.js', () => ({ consumeTokenBucketToken: vi.fn() }));

type Row = Record<string, unknown>;
type Condition = { kind: 'eq'; column: unknown; value: unknown } | { kind: 'gte'; column: unknown; value: unknown } | { kind: 'and'; conditions: Condition[] };

interface Store {
  agents: Row[];
  users: Row[];
  agentSkills: Row[];
  agentConnections: Row[];
}

const TABLES = [agents, users, agentSkills, agentConnections] as const;

function columnKey(column: unknown): string {
  for (const table of TABLES) {
    const entry = Object.entries(table).find(([, value]) => value === column);
    if (entry) return entry[0];
  }
  throw new Error('column is not a known table column');
}

function matches(condition: Condition, row: Row): boolean {
  if (condition.kind === 'and') return condition.conditions.every((inner) => matches(inner, row));
  if (condition.kind === 'gte') return (row[columnKey(condition.column)] as Date).getTime() >= (condition.value as Date).getTime();
  return row[columnKey(condition.column)] === condition.value;
}

interface FakeQuery extends PromiseLike<Row[]> {
  where(condition: Condition): FakeQuery;
  for(mode: string): FakeQuery;
  orderBy(...order: unknown[]): FakeQuery;
  limit(count: number): FakeQuery;
}

function rowsQuery(rows: Row[], condition?: Condition): FakeQuery {
  const selected = () => (condition ? rows.filter((row) => matches(condition, row)) : rows);
  const query: FakeQuery = {
    where: (next) => rowsQuery(rows, next),
    for: () => query,
    orderBy: () => query,
    limit: () => query,
    then: (onFulfilled, onRejected) => Promise.resolve(selected()).then(onFulfilled, onRejected),
  };
  return query;
}

function rowsFor(store: Store, table: unknown): Row[] {
  if (table === agents) return store.agents;
  if (table === users) return store.users;
  if (table === agentSkills) return store.agentSkills;
  if (table === agentConnections) return store.agentConnections;
  throw new Error('table has no fake rows');
}

function readerOf(store: Store): AgentPolicyReader {
  const select = vi.fn();
  select.mockImplementation(() => ({ from: (table: unknown) => rowsQuery(rowsFor(store, table)) }));
  return { select };
}

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const PARENT_ID = 'parent-1';
const PLANS_CONFIG = {} as PlansConfig;

interface ParentOverrides {
  depth?: number;
  childAgentLimit?: number;
  permissionLevel?: string;
}

/** A store with one parent of USER_ID, optional children, one held skill and one active connection. */
function storeWith(parent: ParentOverrides = {}, options: { children?: number; ownerIsAdmin?: boolean } = {}): Store {
  const childRows: Row[] = Array.from({ length: options.children ?? 0 }, (_, index) => ({
    id: `child-${index}`,
    userId: USER_ID,
    parentAgentId: PARENT_ID,
  }));
  return {
    agents: [
      {
        id: PARENT_ID,
        userId: USER_ID,
        parentAgentId: null,
        depth: parent.depth ?? 1,
        childAgentLimit: parent.childAgentLimit ?? 2,
        permissionLevel: parent.permissionLevel ?? 'standard',
      },
      ...childRows,
    ],
    users: [{ id: USER_ID, isAdmin: options.ownerIsAdmin ?? false }],
    agentSkills: [{ agentId: PARENT_ID, skillId: 'skill-a' }],
    agentConnections: [{ agentId: PARENT_ID, connectionId: 'conn-a', status: 'active' }],
  };
}

function childInput(overrides: Partial<AgentCreatePolicyInput> = {}): AgentCreatePolicyInput {
  return {
    caller: { userId: USER_ID, planId: 'free', isAdmin: false, parentAgentId: PARENT_ID },
    plansConfig: PLANS_CONFIG,
    maxAgentDepth: 6,
    childName: 'Child',
    duplicateChildWindowSeconds: 300,
    skillIds: [],
    connectionIds: [],
    permissionLevel: undefined,
    ...overrides,
  };
}

function userInput(overrides: Partial<AgentCreatePolicyInput> = {}): AgentCreatePolicyInput {
  return childInput({ caller: { userId: USER_ID, planId: 'free', isAdmin: false, parentAgentId: null }, ...overrides });
}

async function duplicateOf(promise: Promise<unknown>): Promise<AgentChildDuplicateError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentChildDuplicateError) return error;
    throw error;
  }
  throw new Error('expected the policy to report a duplicate child');
}

async function ruleOf(promise: Promise<unknown>): Promise<AgentCreatePolicyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentCreatePolicyError) return error;
    throw error;
  }
  throw new Error('expected the policy to refuse the creation');
}

const PLAN_REFUSED = err({ code: 'plan.limit_exceeded', message: 'Agent limit reached (3)', limit: 3, current: 3, params: { resource: 'agent', limit: 3, current: 3 } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkAgentLimit).mockResolvedValue(ok(undefined));
});

describe('agent create policy: user creation', () => {
  it('a user creation within the plan total gets a user-owned lineage at depth zero with standard permission', async () => {
    const lineage = await evaluateAgentCreatePolicy(readerOf(storeWith()), userInput(), false);

    expect(lineage).toEqual({ creatorType: 'user', creatorId: USER_ID, parentAgentId: null, depth: 0, permissionLevel: 'standard' });
  });

  it('a user creation at the plan total is refused by the plan_total rule with the plan error code', async () => {
    vi.mocked(checkAgentLimit).mockResolvedValue(PLAN_REFUSED);

    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith()), userInput(), false));

    expect(refusal).toMatchObject({ status: 403, rule: 'plan_total' });
    expect(refusal.body).toMatchObject({ error: 'plan.limit_exceeded', params: { resource: 'agent', limit: 3, current: 3 } });
  });

  it('a user creation with no plan configuration skips the plan total', async () => {
    await evaluateAgentCreatePolicy(readerOf(storeWith()), userInput({ plansConfig: undefined }), false);

    expect(checkAgentLimit).not.toHaveBeenCalled();
  });

  it('an admin user creation passes the admin flag to the plan total', async () => {
    await evaluateAgentCreatePolicy(readerOf(storeWith()), userInput({ caller: { userId: USER_ID, planId: 'free', isAdmin: true, parentAgentId: null } }), false);

    expect(checkAgentLimit).toHaveBeenCalledWith(expect.anything(), PLANS_CONFIG, USER_ID, 'free', true);
  });
});

describe('agent create policy: each rule in isolation', () => {
  it('ownership refuses a parent that belongs to another user', async () => {
    const store = storeWith();
    store.agents.push({ id: 'parent-2', userId: OTHER_USER_ID, parentAgentId: null, depth: 1, childAgentLimit: 2, permissionLevel: 'standard' });

    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(store), childInput({ caller: { userId: USER_ID, planId: 'free', isAdmin: false, parentAgentId: 'parent-2' } }), false));

    expect(refusal).toMatchObject({ status: 403, rule: 'ownership' });
    expect(refusal.body).toMatchObject({ error: 'agent.create.parent_not_owned' });
  });

  it('allowance refuses when the parent already has as many children as its allowance', async () => {
    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith({ childAgentLimit: 1 }, { children: 1 })), childInput(), false));

    expect(refusal).toMatchObject({ status: 403, rule: 'allowance' });
    expect(refusal.body).toMatchObject({ error: 'agent.create.allowance_exhausted', params: { limit: 1, current: 1 } });
  });

  it('allowance admits a child while the parent is below its allowance', async () => {
    const lineage = await evaluateAgentCreatePolicy(readerOf(storeWith({ childAgentLimit: 2 }, { children: 1 })), childInput(), false);

    expect(lineage).toMatchObject({ creatorType: 'agent', parentAgentId: PARENT_ID });
  });

  it('depth refuses a child whose depth would exceed the maximum', async () => {
    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith({ depth: 1 })), childInput({ maxAgentDepth: 1 }), false));

    expect(refusal).toMatchObject({ status: 403, rule: 'depth' });
    expect(refusal.body).toMatchObject({ error: 'agent.create.depth_exceeded', params: { limit: 1, requested: 2 } });
  });

  it('plan_total refuses an agent child when the owner is at the plan total', async () => {
    vi.mocked(checkAgentLimit).mockResolvedValue(PLAN_REFUSED);

    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith()), childInput(), false));

    expect(refusal).toMatchObject({ status: 403, rule: 'plan_total' });
    expect(refusal.body).toMatchObject({ error: 'agent.create.plan_limit_exceeded' });
  });

  it('plan_total follows the owner admin flag, not the agent caller flag', async () => {
    await evaluateAgentCreatePolicy(readerOf(storeWith({}, { ownerIsAdmin: true })), childInput(), false);

    expect(checkAgentLimit).toHaveBeenCalledWith(expect.anything(), PLANS_CONFIG, USER_ID, 'free', true);
  });

  it('grant refuses a skill the parent does not hold and names it', async () => {
    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith()), childInput({ skillIds: ['skill-a', 'skill-b'] }), false));

    expect(refusal).toMatchObject({ status: 403, rule: 'grant' });
    expect(refusal.body).toMatchObject({ error: 'agent.create.grant_not_held', params: { kind: 'skill', missing: ['skill-b'] } });
  });

  it('grant refuses the user-only children skill even when the parent holds it', async () => {
    const store = storeWith();
    store.agentSkills.push({ agentId: PARENT_ID, skillId: 'child-agent-management' });
    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(store), childInput({ skillIds: ['child-agent-management'] }), false));

    expect(refusal).toMatchObject({ status: 403, rule: 'grant' });
    expect(refusal.body).toMatchObject({ error: 'agent.create.grant_user_only', message: 'This skill can only be added by the user.' });
  });

  it('a user creation may carry the user-only children skill', async () => {
    const lineage = await evaluateAgentCreatePolicy(readerOf(storeWith()), userInput({ skillIds: ['child-agent-management'] }), false);

    expect(lineage).toMatchObject({ creatorType: 'user', depth: 0 });
  });

  it('grant refuses a connection the parent is not actively assigned and names it', async () => {
    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith()), childInput({ connectionIds: ['conn-b'] }), false));

    expect(refusal).toMatchObject({ status: 403, rule: 'grant' });
    expect(refusal.body).toMatchObject({ error: 'agent.create.grant_not_held', params: { kind: 'connection', missing: ['conn-b'] } });
  });

  it('permission refuses an explicit level above the parent level', async () => {
    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith({ permissionLevel: 'standard' })), childInput({ permissionLevel: 'full' }), false));

    expect(refusal).toMatchObject({ status: 403, rule: 'permission' });
    expect(refusal.body).toMatchObject({ error: 'agent.create.permission_exceeds_parent', params: { parent: 'standard', requested: 'full' } });
  });

  it('permission gives a restricted parent a restricted child when no level is requested', async () => {
    const lineage = await evaluateAgentCreatePolicy(readerOf(storeWith({ permissionLevel: 'restricted' })), childInput(), false);

    expect(lineage.permissionLevel).toBe('restricted');
  });

  it('permission gives a standard parent a standard child when no level is requested', async () => {
    const lineage = await evaluateAgentCreatePolicy(readerOf(storeWith({ permissionLevel: 'full' })), childInput(), false);

    expect(lineage.permissionLevel).toBe('standard');
  });

  it('a child that passes every rule gets an agent-owned lineage one level below the parent', async () => {
    const lineage = await evaluateAgentCreatePolicy(readerOf(storeWith({ depth: 2 })), childInput({ skillIds: ['skill-a'], connectionIds: ['conn-a'] }), false);

    expect(lineage).toEqual({
      creatorType: 'agent',
      creatorId: PARENT_ID,
      parentAgentId: PARENT_ID,
      depth: 3,
      permissionLevel: 'standard',
    });
  });
});

describe('agent create policy: rule order', () => {
  it('ownership is evaluated before allowance, so a parent that is not the caller\'s is refused as not owned', async () => {
    const store = storeWith();
    store.agents.push(
      { id: 'parent-2', userId: OTHER_USER_ID, parentAgentId: null, depth: 1, childAgentLimit: 0, permissionLevel: 'standard' },
      { id: 'child-of-2', userId: OTHER_USER_ID, parentAgentId: 'parent-2' },
    );

    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(store), childInput({ caller: { userId: USER_ID, planId: 'free', isAdmin: false, parentAgentId: 'parent-2' } }), false));

    expect(refusal.rule).toBe('ownership');
  });

  it('allowance is evaluated before depth', async () => {
    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith({ childAgentLimit: 0, depth: 1 })), childInput({ maxAgentDepth: 1 }), false));

    expect(refusal.rule).toBe('allowance');
  });

  it('depth is evaluated before plan_total', async () => {
    vi.mocked(checkAgentLimit).mockResolvedValue(PLAN_REFUSED);

    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith({ depth: 1 })), childInput({ maxAgentDepth: 1 }), false));

    expect(refusal.rule).toBe('depth');
    expect(checkAgentLimit).not.toHaveBeenCalled();
  });

  it('plan_total is evaluated before grant', async () => {
    vi.mocked(checkAgentLimit).mockResolvedValue(PLAN_REFUSED);

    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith()), childInput({ skillIds: ['skill-b'] }), false));

    expect(refusal.rule).toBe('plan_total');
  });

  it('grant is evaluated before permission', async () => {
    const refusal = await ruleOf(evaluateAgentCreatePolicy(readerOf(storeWith({ permissionLevel: 'standard' })), childInput({ skillIds: ['skill-b'], permissionLevel: 'full' }), false));

    expect(refusal.rule).toBe('grant');
  });
});

describe('consumeAgentCreateToken', () => {
  const USER_RATE = 6;

  function logger() {
    const warn = vi.fn();
    const log: Pick<FastifyBaseLogger, 'warn'> = { warn };
    return { log, warn };
  }

  it('refuses with 503 limiter_unavailable when no limiter is configured', async () => {
    const { log } = logger();

    const refusal = await consumeAgentCreateToken(undefined, log, USER_ID, USER_RATE);

    expect(refusal).toMatchObject({ status: 503, rule: 'limiter' });
    expect(refusal?.body).toMatchObject({ error: 'agent.create.limiter_unavailable' });
    expect(consumeTokenBucketToken).not.toHaveBeenCalled();
  });

  it('takes the token from the user bucket keyed by user, sized by the rate per minute', async () => {
    vi.mocked(consumeTokenBucketToken).mockResolvedValue(ok(true));
    const redis: Pick<Redis, 'eval'> = { eval: vi.fn() };

    await consumeAgentCreateToken(redis, logger().log, USER_ID, USER_RATE);

    expect(consumeTokenBucketToken).toHaveBeenCalledWith(redis, {
      key: `ratelimit:agent-create:${USER_ID}`,
      capacity: USER_RATE,
      refillPerMinute: USER_RATE,
    });
  });

  it('lets the attempt through when a token is available', async () => {
    vi.mocked(consumeTokenBucketToken).mockResolvedValue(ok(true));

    expect(await consumeAgentCreateToken({ eval: vi.fn() }, logger().log, USER_ID, USER_RATE)).toBeNull();
  });

  it('refuses with 429 rate when the bucket is empty', async () => {
    vi.mocked(consumeTokenBucketToken).mockResolvedValue(ok(false));

    const refusal = await consumeAgentCreateToken({ eval: vi.fn() }, logger().log, USER_ID, USER_RATE);

    expect(refusal).toMatchObject({ status: 429, rule: 'rate' });
    expect(refusal?.body).toMatchObject({ error: 'agent.create.rate_limited' });
  });

  it('fails closed with 503 and logs a warning when the limiter errors', async () => {
    vi.mocked(consumeTokenBucketToken).mockResolvedValue(err('connection refused'));
    const { log, warn } = logger();

    const refusal = await consumeAgentCreateToken({ eval: vi.fn() }, log, USER_ID, USER_RATE);

    expect(refusal).toMatchObject({ status: 503, rule: 'limiter' });
    expect(refusal?.body).toMatchObject({ error: 'agent.create.limiter_unavailable' });
    expect(warn).toHaveBeenCalledWith({ err: 'connection refused' }, 'agent create rate limiter unavailable');
  });
});

describe('agent create policy: duplicate child window', () => {
  const WINDOW_SECONDS = 300;

  /** Adds a direct child of PARENT_ID with the given name, created `ageSeconds` ago. */
  function withChild(store: Store, name: string, ageSeconds: number, parentId = PARENT_ID, id = 'dup-child'): Store {
    store.agents.push({
      id,
      userId: USER_ID,
      parentAgentId: parentId,
      name,
      depth: 2,
      childAgentLimit: 0,
      createdAt: new Date(Date.now() - ageSeconds * 1000),
    });
    return store;
  }

  it('a same-name child created inside the window is reported as the duplicate, with its id', async () => {
    const store = withChild(storeWith(), 'Scout', 10);

    const duplicate = await duplicateOf(evaluateAgentCreatePolicy(readerOf(store), childInput({ childName: 'Scout', duplicateChildWindowSeconds: WINDOW_SECONDS }), true));

    expect(duplicate).toBeInstanceOf(AgentChildDuplicateError);
    expect(duplicate.childId).toBe('dup-child');
  });

  it('the preflight read (no lock) reports the same duplicate', async () => {
    const store = withChild(storeWith(), 'Scout', 10);

    const duplicate = await duplicateOf(evaluateAgentCreatePolicy(readerOf(store), childInput({ childName: 'Scout', duplicateChildWindowSeconds: WINDOW_SECONDS }), false));

    expect(duplicate.childId).toBe('dup-child');
  });

  it('a same-name child created before the window opened does not block a new create', async () => {
    const store = withChild(storeWith(), 'Scout', WINDOW_SECONDS + 60);

    const lineage = await evaluateAgentCreatePolicy(readerOf(store), childInput({ childName: 'Scout', duplicateChildWindowSeconds: WINDOW_SECONDS }), true);

    expect(lineage).toMatchObject({ creatorType: 'agent', parentAgentId: PARENT_ID });
  });

  it('a different name creates a new child even inside the window', async () => {
    const store = withChild(storeWith(), 'Scout', 10);

    const lineage = await evaluateAgentCreatePolicy(readerOf(store), childInput({ childName: 'Trader', duplicateChildWindowSeconds: WINDOW_SECONDS }), true);

    expect(lineage).toMatchObject({ creatorType: 'agent', parentAgentId: PARENT_ID });
  });

  it('a window of zero disables the check', async () => {
    const store = withChild(storeWith(), 'Scout', 0);

    const lineage = await evaluateAgentCreatePolicy(readerOf(store), childInput({ childName: 'Scout', duplicateChildWindowSeconds: 0 }), true);

    expect(lineage).toMatchObject({ creatorType: 'agent', parentAgentId: PARENT_ID });
  });

  it('a same-name child of another parent does not match', async () => {
    const store = withChild(storeWith(), 'Scout', 10, 'other-parent');

    const lineage = await evaluateAgentCreatePolicy(readerOf(store), childInput({ childName: 'Scout', duplicateChildWindowSeconds: WINDOW_SECONDS }), true);

    expect(lineage).toMatchObject({ creatorType: 'agent', parentAgentId: PARENT_ID });
  });

  it('the duplicate is reported before the allowance rule, so a retry at the allowance limit still gets the child', async () => {
    const store = withChild(storeWith({ childAgentLimit: 1 }, { children: 0 }), 'Scout', 10);

    const duplicate = await duplicateOf(evaluateAgentCreatePolicy(readerOf(store), childInput({ childName: 'Scout', duplicateChildWindowSeconds: WINDOW_SECONDS }), true));

    expect(duplicate.childId).toBe('dup-child');
  });

  it('a user creation is never matched against children', async () => {
    const store = withChild(storeWith(), 'Scout', 10);

    const lineage = await evaluateAgentCreatePolicy(readerOf(store), userInput({ childName: 'Scout', duplicateChildWindowSeconds: WINDOW_SECONDS }), true);

    expect(lineage).toMatchObject({ creatorType: 'user', parentAgentId: null });
  });
});
