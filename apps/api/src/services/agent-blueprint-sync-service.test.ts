import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ensurePublishedBlueprintForAgent,
} from './agent-blueprint-sync-service.js';
import { projectAgentToBlueprintPayload } from './blueprint-projection.js';
import * as skillValidator from './blueprint-skill-validator.js';
import type { Database } from '@herobids/db';

// ── Global mocks ─────────────────────────────────────────────────────────────

vi.spyOn(skillValidator, 'validateSkillPortability').mockResolvedValue({
  valid: true,
  errors: [],
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a chainable query builder mock (thenable) that resolves to `value`.
 * Mimics Drizzle's fluent .select().from().where().limit()... chain.
 */
function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin', 'groupBy']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    _reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve);
  return chain as unknown as ReturnType<Database['select']>;
}

/** Minimal valid agent row matching the DB schema + fields consumed by projectAgentToBlueprintPayload. */
function makeAgentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Test Agent',
    style: null,
    prompt: 'Do momentum trading',
    status: 'stopped',
    pauseState: null,
    toolPolicy: null,
    modelPolicy: null,
    telegramChatId: null,
    notificationPolicy: null,
    maxBots: null,
    tickIntervalMs: null,
    capital: null,
    riskOverrides: null,
    risk: null,
    strategy: null,
    executionDefaults: null,
    unifiedConfig: {
      capabilityMode: 'intelligence',
      intelligence: { provider: 'openai', wakeIntervalMs: 60_000 },
    },
    wakePreferences: null,
    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
    blueprintId: null,
    blueprintRevisionId: null,
    runtimePolicyOverrides: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** Minimal blueprint row. */
function makeBlueprintRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bp-1',
    authorId: 'user-1',
    publicationStatus: 'published',
    publishedAt: new Date('2026-01-01'),
    delistedAt: null,
    archivedAt: null,
    currentRevisionId: 'rev-1',
    publishedRevisionId: 'rev-1',
    kind: 'agent',
    name: 'Test Agent',
    description: '',
    strategyType: null,
    style: null,
    tags: [],
    venueType: null,
    sourceBlueprintId: null,
    sourceBlueprintRevisionId: null,
    likeCount: 0,
    forkCount: 0,
    popularityScore: 0,
    trendingScore: 0,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** Minimal blueprint revision row. */
function makeRevisionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'rev-1',
    blueprintId: 'bp-1',
    version: 1,
    kind: 'agent',
    name: 'Test Agent',
    description: '',
    strategyType: null,
    style: null,
    tags: [],
    venueType: null,
    payload: {} as Record<string, unknown>,
    changeSummary: 'Auto-generated from agent config on start',
    createdByUserId: 'user-1',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** Track what values are inserted/updated during a test. */
interface InsertTracker {
  /** All rows passed to .values() on any insert call */
  inserted: Record<string, unknown>[];
  /** All objects passed to .set() on any update call (outer + tx) */
  updated: Record<string, unknown>[];
}

function makeInsertTracker(): InsertTracker {
  return { inserted: [], updated: [] };
}

/**
 * Build a mock Database whose select calls return the given row arrays in order.
 * A shared selectCallCount is used by both the outer db and the inner tx objects
 * created during transaction(), so ALL select calls (outer + inner) consume from
 * the same results array.
 */
function buildMockDb(
  selectResults: unknown[][],
  tracker: InsertTracker,
): Database {
  let selectCallCount = 0;

  function nextSelect() {
    const idx = selectCallCount++;
    return selectResults[idx] ?? [];
  }

  function makeUpdate() {
    return {
      set: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        tracker.updated.push(v);
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    };
  }

  function makeInsert() {
    return {
      values: vi.fn().mockImplementation((v: Record<string, unknown> | Record<string, unknown>[]) => {
        // .values() accepts either a single row or an array of rows (bulk insert)
        if (Array.isArray(v)) {
          tracker.inserted.push(...v);
        } else {
          tracker.inserted.push(v);
        }
        return Promise.resolve();
      }),
    };
  }

  function makeSelect() {
    return makeChain(nextSelect());
  }

  // Track whether the outer update mock has been configured with a set() spy.
  // We need the outer update to also push to tracker.
  const outerUpdate = makeUpdate();

  const db = {
    select: vi.fn().mockImplementation(() => makeSelect()),
    insert: vi.fn().mockImplementation(() => makeInsert()),
    update: vi.fn().mockReturnValue(outerUpdate),
    transaction: vi.fn().mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          select: vi.fn().mockImplementation(() => makeSelect()),
          insert: vi.fn().mockImplementation(() => makeInsert()),
          update: vi.fn().mockReturnValue(makeUpdate()),
        };
        return fn(tx);
      },
    ),
  };

  return db as unknown as Database;
}

// ── Test data builders ───────────────────────────────────────────────────────

/** The projected payload for the default agent (used in fingerprint matching). */
function agentProjectedPayload(agent: ReturnType<typeof makeAgentRow>) {
  return projectAgentToBlueprintPayload({
    name: agent.name,
    style: agent.style,
    prompt: agent.prompt,
    runtimePolicyOverrides: agent.runtimePolicyOverrides,
    toolPolicy: agent.toolPolicy,
    modelPolicy: agent.modelPolicy,
    strategy: agent.strategy,
    risk: agent.risk,
    executionDefaults: agent.executionDefaults,
    unifiedConfig: agent.unifiedConfig,
    wakePreferences: agent.wakePreferences,
    openPositionEscalationToJudgePolicy: agent.openPositionEscalationToJudgePolicy,
    capital: agent.capital,
    maxBots: agent.maxBots,
    tickIntervalMs: agent.tickIntervalMs,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ensurePublishedBlueprintForAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 1: First start with no linked blueprint → 'created' ───────────────

  it('creates and publishes a new blueprint when agent has no linked blueprint', async () => {
    const tracker = makeInsertTracker();
    const agent = makeAgentRow({ blueprintId: null, blueprintRevisionId: null });

    // Select call order:
    // 1. Agent lookup (by id + userId) → [agent]
    // 2. Agent skills → []
    // Transaction: no inner selects, only inserts + updates
    const selectResults: unknown[][] = [
      [agent],  // agent lookup
      [],       // agent skills
    ];

    const db = buildMockDb(selectResults, tracker);

    const result = await ensurePublishedBlueprintForAgent(db, agent.id, agent.userId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.action).toBe('created');
    expect(result.data.blueprintId).toBeTruthy();
    expect(result.data.blueprintRevisionId).toBeTruthy();

    // Inserted: blueprint (draft), revision (v1), skill refs (if any)
    const bpInsert = tracker.inserted.find((r) => r.kind === 'agent' && r.publicationStatus === 'draft');
    expect(bpInsert).toBeDefined();
    expect(bpInsert!.kind).toBe('agent');

    // CRITICAL: currentRevisionId must NOT be in the INSERT — the composite FK
    // fk_blueprints_current_revision requires the revision row to exist first.
    // Setting it on the insert would cause a FK violation in a real database.
    expect(bpInsert).not.toHaveProperty('currentRevisionId');

    const revInsert = tracker.inserted.find((r) => r.version === 1 && r.kind === 'agent');
    expect(revInsert).toBeDefined();

    // Updated: agent linkage + blueprint publish
    const agentUpdate = tracker.updated.find(
      (u) => 'blueprintId' in u && 'blueprintRevisionId' in u,
    );
    expect(agentUpdate).toBeDefined();
    expect((agentUpdate as Record<string, unknown>).blueprintId).toBe(result.data.blueprintId);
    expect((agentUpdate as Record<string, unknown>).blueprintRevisionId).toBe(result.data.blueprintRevisionId);

    const bpPublishUpdate = tracker.updated.find(
      (u) => 'publicationStatus' in u,
    );
    expect(bpPublishUpdate).toBeDefined();
    expect((bpPublishUpdate as Record<string, unknown>).publicationStatus).toBe('published');

    // CRITICAL: currentRevisionId must be set in the UPDATE (not the INSERT)
    // to satisfy the composite FK after the revision row has been created.
    expect(bpPublishUpdate).toHaveProperty('currentRevisionId');
    expect((bpPublishUpdate as Record<string, unknown>).currentRevisionId).toBe(result.data.blueprintRevisionId);
  });

  // ── Test 1b: With skills attached ──────────────────────────────────────────

  it('copies skill refs to blueprintRevisionSkills when agent has skills', async () => {
    const tracker = makeInsertTracker();
    const agent = makeAgentRow({ blueprintId: null, blueprintRevisionId: null });

    const skillRows = [
      { skillId: 'skill-a', skillRevisionId: 'skill-a:v1' },
      { skillId: 'skill-b', skillRevisionId: 'skill-b:v2' },
    ];

    const selectResults: unknown[][] = [
      [agent],     // agent lookup
      skillRows,   // agent skills
    ];

    const db = buildMockDb(selectResults, tracker);

    const result = await ensurePublishedBlueprintForAgent(db, agent.id, agent.userId);
    expect(result.ok).toBe(true);

    // Skill refs copied to blueprintRevisionSkills (inserted rows with orderIndex)
    const skillInserts = tracker.inserted.filter(
      (r) => 'orderIndex' in r && 'skillId' in r,
    );
    expect(skillInserts).toHaveLength(2);
    expect(skillInserts[0]!.skillId).toBe('skill-a');
    expect((skillInserts[0] as Record<string, unknown>).skillRevisionId).toBe('skill-a:v1');
    expect(skillInserts[0]!.orderIndex).toBe(0);
    expect(skillInserts[1]!.skillId).toBe('skill-b');
    expect(skillInserts[1]!.orderIndex).toBe(1);
  });

  // ── Test 1c: Skill portability check fails → 'blueprint.skill_portability' ──

  it('returns blueprint.skill_portability when validateSkillPortability fails', async () => {
    const tracker = makeInsertTracker();
    const agent = makeAgentRow({ blueprintId: null, blueprintRevisionId: null });

    const skillRows = [
      { skillId: 'skill-x', skillRevisionId: 'skill-x:v1' },
    ];

    const selectResults: unknown[][] = [
      [agent],     // agent lookup
      skillRows,   // agent skills (has skills → triggers portability check)
    ];

    const db = buildMockDb(selectResults, tracker);

    // Override the global spy for this test only
    vi.mocked(skillValidator.validateSkillPortability).mockResolvedValueOnce({
      valid: false,
      errors: ['Skill X is not portable'],
    });

    const result = await ensurePublishedBlueprintForAgent(db, agent.id, agent.userId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe('blueprint.skill_portability');
    expect(result.error.message).toContain('Skill X is not portable');

    // No inserts occurred (early return)
    expect(tracker.inserted).toHaveLength(0);
  });

  // ── Test 2: Unchanged authored config → 'unchanged' ────────────────────────

  it('returns unchanged when fingerprint matches and blueprint is already published', async () => {
    const tracker = makeInsertTracker();
    const agent = makeAgentRow({
      blueprintId: 'bp-1',
      blueprintRevisionId: 'rev-1',
    });

    // Compute the payload and fingerprint for matching
    const payload = agentProjectedPayload(agent);

    const blueprint = makeBlueprintRow({
      id: 'bp-1',
      publicationStatus: 'published',
      currentRevisionId: 'rev-1',
      publishedRevisionId: 'rev-1',
    });

    const revision = makeRevisionRow({
      id: 'rev-1',
      blueprintId: 'bp-1',
      version: 1,
      payload: payload as unknown as Record<string, unknown>,
    });

    // Select order:
    // 1. Agent lookup → [agent]
    // 2. Agent skills → []
    // 3. Blueprint lookup → [blueprint]
    // 4. Revision lookup → [revision]
    // 5. Blueprint revision skills → []
    const selectResults: unknown[][] = [
      [agent],     // 1. agent lookup
      [],          // 2. agent skills
      [blueprint], // 3. blueprint lookup
      [revision],  // 4. revision lookup
      [],          // 5. blueprint revision skills
    ];

    const db = buildMockDb(selectResults, tracker);

    const result = await ensurePublishedBlueprintForAgent(db, agent.id, agent.userId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.action).toBe('unchanged');
    expect(result.data.blueprintId).toBe('bp-1');
    expect(result.data.blueprintRevisionId).toBe('rev-1');

    // No new revision was created (no inserts with version field)
    const revInserts = tracker.inserted.filter((r) => 'version' in r);
    expect(revInserts).toHaveLength(0);

    // No blueprint publish update was sent (already published)
    const bpPublishUpdates = tracker.updated.filter((u) => 'publicationStatus' in u);
    expect(bpPublishUpdates).toHaveLength(0);

    // Agent linkage was refreshed
    const agentUpdate = tracker.updated.find(
      (u) => 'blueprintId' in u,
    );
    expect(agentUpdate).toBeDefined();
    expect((agentUpdate as Record<string, unknown>).blueprintId).toBe('bp-1');
    expect((agentUpdate as Record<string, unknown>).blueprintRevisionId).toBe('rev-1');
  });

  // ── Test 2b: Blueprint exists but is not published → re-publish ────────────

  it('re-publishes blueprint when fingerprint matches but blueprint is not published', async () => {
    const tracker = makeInsertTracker();
    const agent = makeAgentRow({
      blueprintId: 'bp-1',
      blueprintRevisionId: 'rev-1',
    });

    const payload = agentProjectedPayload(agent);

    const blueprint = makeBlueprintRow({
      id: 'bp-1',
      publicationStatus: 'delisted', // not published
      currentRevisionId: 'rev-1',
      publishedRevisionId: 'rev-1',
    });

    const revision = makeRevisionRow({
      id: 'rev-1',
      blueprintId: 'bp-1',
      version: 1,
      payload: payload as unknown as Record<string, unknown>,
    });

    // Select order: agent, skills, blueprint, revision, revision skills
    // Then republishBlueprint transaction: tx select re-reads currentRevisionId → [blueprint]
    const selectResults: unknown[][] = [
      [agent],
      [],
      [blueprint],
      [revision],
      [],
      [blueprint], // transaction guard re-read
    ];

    const db = buildMockDb(selectResults, tracker);

    const result = await ensurePublishedBlueprintForAgent(db, agent.id, agent.userId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.action).toBe('unchanged');

    // Blueprint was re-published (via tx update)
    const bpUpdate = tracker.updated.find(
      (u) => 'publicationStatus' in u,
    );
    expect(bpUpdate).toBeDefined();
    expect((bpUpdate as Record<string, unknown>).publicationStatus).toBe('published');
  });

  // ── Test 3: Authored config changed → 'revised' ────────────────────────────

  it('creates a new revision when agent config differs from existing revision', async () => {
    const tracker = makeInsertTracker();
    const agent = makeAgentRow({
      blueprintId: 'bp-1',
      blueprintRevisionId: 'rev-1',
      prompt: 'Updated prompt — now uses DCA strategy',
    });

    // The old revision has the OLD projected payload (matching the original agent)
    const oldAgent = makeAgentRow({
      blueprintId: 'bp-1',
      blueprintRevisionId: 'rev-1',
      prompt: 'Do momentum trading', // original prompt
    });
    const oldPayload = agentProjectedPayload(oldAgent);

    const blueprint = makeBlueprintRow({
      id: 'bp-1',
      publicationStatus: 'published',
      currentRevisionId: 'rev-1',
      publishedRevisionId: 'rev-1',
    });

    const oldRevision = makeRevisionRow({
      id: 'rev-1',
      blueprintId: 'bp-1',
      version: 1,
      payload: oldPayload as unknown as Record<string, unknown>,
    });

    // Select order:
    // 1. Agent lookup, 2. Skills, 3. Blueprint, 4. Revision, 5. Revision skills
    // 6. (tx guard re-read) → [blueprint]
    const selectResults: unknown[][] = [
      [agent],
      [],
      [blueprint],
      [oldRevision],
      [],
      [blueprint],
    ];

    const db = buildMockDb(selectResults, tracker);

    const result = await ensurePublishedBlueprintForAgent(db, agent.id, agent.userId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.action).toBe('revised');
    expect(result.data.blueprintId).toBe('bp-1');
    expect(result.data.blueprintRevisionId).not.toBe('rev-1');

    // A new revision was created with version 2
    const newRev = tracker.inserted.find((r) => r.version === 2 && r.kind === 'agent');
    expect(newRev).toBeDefined();
    expect((newRev as Record<string, unknown>).blueprintId).toBe('bp-1');

    // Blueprint's currentRevisionId and publishedRevisionId are updated
    const bpUpdate = tracker.updated.find(
      (u) => 'currentRevisionId' in u,
    );
    expect(bpUpdate).toBeDefined();
    expect((bpUpdate as Record<string, unknown>).currentRevisionId).toBe(result.data.blueprintRevisionId);
    expect((bpUpdate as Record<string, unknown>).publishedRevisionId).toBe(result.data.blueprintRevisionId);
    expect((bpUpdate as Record<string, unknown>).publicationStatus).toBe('published');

    // Agent's blueprintRevisionId is updated
    const agentUpdate = tracker.updated.find(
      (u) => 'blueprintRevisionId' in u,
    );
    expect(agentUpdate).toBeDefined();
    expect((agentUpdate as Record<string, unknown>).blueprintRevisionId).toBe(result.data.blueprintRevisionId);
  });

  // ── Test 4: Agent not found ────────────────────────────────────────────────

  it('returns agent.not_found for an invalid agent ID', async () => {
    const tracker = makeInsertTracker();

    // Select order:
    // 1. Agent lookup by id+userId → []
    // 2. Any-agent lookup by id only → []
    const selectResults: unknown[][] = [
      [], // not found with userId
      [], // not found at all
    ];

    const db = buildMockDb(selectResults, tracker);

    const result = await ensurePublishedBlueprintForAgent(db, 'nonexistent', 'user-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe('agent.not_found');
  });

  // ── Test 5: Agent not owned by user ────────────────────────────────────────

  it('returns agent.not_owned when agent belongs to a different user', async () => {
    const tracker = makeInsertTracker();

    // Select order:
    // 1. Agent lookup by id+userId → [] (wrong userId)
    // 2. Any-agent lookup by id only → [{ id: 'agent-1' }] (exists)
    const selectResults: unknown[][] = [
      [],
      [{ id: 'agent-1' }],
    ];

    const db = buildMockDb(selectResults, tracker);

    const result = await ensurePublishedBlueprintForAgent(db, 'agent-1', 'wrong-user');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe('agent.not_owned');
  });

  // ── Test: Blueprint not found (linked blueprint was deleted) ───────────────

  it('returns internal_error when linked blueprint no longer exists', async () => {
    const tracker = makeInsertTracker();
    const agent = makeAgentRow({
      blueprintId: 'bp-gone',
      blueprintRevisionId: 'rev-gone',
    });

    // Select order:
    // 1. Agent lookup → [agent]
    // 2. Agent skills → []
    // 3. Blueprint lookup → [] (deleted)
    const selectResults: unknown[][] = [
      [agent],
      [],
      [],
    ];

    const db = buildMockDb(selectResults, tracker);

    const result = await ensurePublishedBlueprintForAgent(db, agent.id, agent.userId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe('blueprint.internal_error');
    expect(result.error.message).toContain('not found');
  });

  // ── Regression: Blueprint kind mismatch (not an agent blueprint) ───────────

  it('returns internal_error when linked blueprint is not agent-kind', async () => {
    const tracker = makeInsertTracker();
    const agent = makeAgentRow({
      blueprintId: 'bp-bot',
      blueprintRevisionId: 'rev-1',
    });

    const blueprint = makeBlueprintRow({
      id: 'bp-bot',
      kind: 'bot', // wrong kind
      currentRevisionId: 'rev-1',
    });

    const selectResults: unknown[][] = [
      [agent],
      [],
      [blueprint],
    ];

    const db = buildMockDb(selectResults, tracker);

    const result = await ensurePublishedBlueprintForAgent(db, agent.id, agent.userId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe('blueprint.internal_error');
    expect(result.error.message).toContain('not an agent blueprint');
  });
});
