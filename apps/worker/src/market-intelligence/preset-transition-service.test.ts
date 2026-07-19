import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PresetTransitionService } from './preset-transition-service.js';
import type { PresetTransitionServiceDeps } from './preset-transition-service.js';
import { ok, err } from '@herobids/domain';
import type {
  PresetTransitionApplicationResult,
  ActivePresetBinding,
} from '@herobids/domain';

// ── Mock getPreset to avoid filesystem reads ───────────────────────────────

const { mockGetPreset } = vi.hoisted(() => ({
  mockGetPreset: vi.fn().mockReturnValue(undefined),
}));

vi.mock('@herobids/domain/config/presets-loader', () => ({
  getPreset: mockGetPreset,
}));

// ── Mock Helpers ───────────────────────────────────────────────────────────

/**
 * Creates a DB mock where each `select()` call pops the next resolved value
 * from the provided queue. This lets us control what each successive query
 * in the service returns without needing per-call argument matching.
 */
function makeQueueDb(selectQueue: unknown[]) {
  let idx = 0;

  function createChain(value: unknown): any {
    const fn: any = function () {
      return createChain(value);
    };
    fn.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);

    return new Proxy(fn, {
      get(_target, prop) {
        if (prop === 'then' || prop === 'catch') {
          return Reflect.get(_target, prop, _target);
        }
        return createChain(value);
      },
    });
  }

  return {
    select: vi.fn(() => {
      const value = idx < selectQueue.length
        ? selectQueue[idx]!
        : (selectQueue.length > 0 ? selectQueue[selectQueue.length - 1] : []);
      idx++;
      return createChain(value);
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  };
}

// ── Artifact factory ───────────────────────────────────────────────────────

function makeActiveArtifact(overrides?: Record<string, unknown>) {
  return {
    id: 'artifact-1',
    venueFamily: 'hyperliquid',
    instrumentKind: 'orderbook',
    styleTier: 'standard',
    symbol: 'BTC',
    network: null,
    address: null,
    assessedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000), // 1 hour from now
    maxActorUseAge: new Date(Date.now() + 3600_000).toISOString(),
    maxWakeAge: new Date(Date.now() + 1800_000).toISOString(),
    assessmentVersion: 1,
    artifactVersion: 1,
    rankingPolicyVersion: 1,
    status: 'active' as const,
    allowedPresets: ['momentum', 'mean_reversion', 'breakout'],
    presetRankings: [
      { presetKey: 'momentum', rank: 1, score: 85, scoreBand: 'high', pros: ['Strong trend following'], cons: [], fitNotes: null },
      { presetKey: 'mean_reversion', rank: 2, score: 72, scoreBand: 'medium', pros: [], cons: ['Choppy conditions'], fitNotes: null },
    ],
    recommendedPreset: 'momentum',
    confidence: 0.8,
    urgency: 'medium' as const,
    currentMarketSummary: 'Bullish momentum',
    regimeSummary: 'Trending up',
    scanHealthSummary: 'Healthy',
    reasoningSummary: 'Top pick: momentum',
    evidenceRefs: [],
    ...overrides,
  };
}

function makeExpiredArtifact() {
  return makeActiveArtifact({
    id: 'artifact-expired',
    status: 'expired',
    expiresAt: new Date(Date.now() - 3600_000), // 1 hour ago
  });
}

function makeSupersededArtifact() {
  return makeActiveArtifact({
    id: 'artifact-superseded',
    status: 'superseded',
  });
}

// ── Binding factory ────────────────────────────────────────────────────────

function makeBindingRow(overrides?: Partial<{
  id: string;
  agentId: string;
  scope: string;
  activePresetKey: string;
  styleTier: 'economy' | 'standard' | 'premium';
  behaviorVersion: string;
  appliedPresetVersion: string;
  sourceArtifactId: string | null;
  sourceTransitionId: string | null;
  status: 'active' | 'superseded' | 'revoked';
  appliedAt: Date;
  createdAt: Date;
}>) {
  return {
    id: 'binding-1',
    agentId: 'agent-1',
    scope: 'default',
    activePresetKey: 'mean_reversion',
    styleTier: 'standard' as const,
    behaviorVersion: 'abc123def456',
    appliedPresetVersion: 'v2',
    sourceArtifactId: null,
    sourceTransitionId: null,
    status: 'active' as const,
    appliedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Agent row factory ──────────────────────────────────────────────────────

function makeAgentRow(overrides?: Record<string, unknown>) {
  return {
    unifiedConfig: {
      platformAssessment: { enabled: true },
      ...overrides,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PresetTransitionService', () => {
  beforeEach(() => {
    mockGetPreset.mockReset();
    mockGetPreset.mockReturnValue(undefined); // default: preset not found → behaviorVersion 'unknown'
  });

  function createService(
    selectQueue: unknown[],
    depsOverrides?: Partial<PresetTransitionServiceDeps>,
  ) {
    const db = makeQueueDb(selectQueue);
    return new PresetTransitionService({
      db: db as any,
      ...depsOverrides,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // recommendTransition (read-only)
  // ═══════════════════════════════════════════════════════════════════════

  describe('recommendTransition', () => {
    // ── Artifact missing / expired ──────────────────────────────────────

    it('returns artifact_not_found when artifact does not exist', async () => {
      const service = createService([
        [], // artifact query → empty
      ]);

      const result = await service.recommendTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'nonexistent',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.artifact_not_found');
      }
    });

    it('returns artifact_expired when artifact has expired', async () => {
      const expired = makeExpiredArtifact();
      const service = createService([
        [expired], // artifact query → expired
      ]);

      const result = await service.recommendTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-expired',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.artifact_expired');
      }
    });

    it('returns artifact_expired when artifact is superseded', async () => {
      const superseded = makeSupersededArtifact();
      const service = createService([
        [superseded],
      ]);

      const result = await service.recommendTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-superseded',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.artifact_expired');
      }
    });

    // ── Already on recommended preset ───────────────────────────────────

    it('recommends null when agent is already on the top-ranked preset', async () => {
      const artifact = makeActiveArtifact({ presetRankings: [{ presetKey: 'momentum', rank: 1, score: 85, scoreBand: 'high', pros: [], cons: [], fitNotes: null }] });
      const binding = makeBindingRow({ activePresetKey: 'momentum' }); // same as top-ranked
      const agent = makeAgentRow();

      const service = createService([
        [artifact],   // artifact query
        [binding],    // binding query
        [agent],      // agent query
      ]);

      const result = await service.recommendTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.recommendedPreset).toBeNull();
        expect(result.data.reasoningSummary).toContain('already on the recommended preset');
        expect(result.data.preparedTransition).toBeNull();
      }
    });

    // ── Top-ranked preset blocked by allowed-presets policy ─────────────

    it('recommends null when top-ranked preset is blocked by allowed-presets policy', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow({ activePresetKey: 'mean_reversion' });
      const agent = makeAgentRow({
        allowedPresets: { allowed: ['mean_reversion', 'breakout'] }, // momentum NOT allowed
      });

      const service = createService([
        [artifact],
        [binding],
        [agent],
      ]);

      const result = await service.recommendTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.recommendedPreset).toBeNull();
        expect(result.data.reasoningSummary).toContain('not in the agent\'s allowed presets policy');
        expect(result.data.preparedTransition).toBeNull();
      }
    });

    // ── Successful recommendation ───────────────────────────────────────

    it('recommends the top-ranked preset with a prepared transition', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow({ activePresetKey: 'mean_reversion' });
      const agent = makeAgentRow();

      const service = createService([
        [artifact],
        [binding],
        [agent],
      ]);

      const result = await service.recommendTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.recommendedPreset).toBe('momentum');
        expect(result.data.confidence).toBe(0.85);
        expect(result.data.transitionMode).toBe('entries_only');
        expect(result.data.preparedTransition).not.toBeNull();
        if (result.data.preparedTransition) {
          expect(result.data.preparedTransition.agentId).toBe('agent-1');
          expect(result.data.preparedTransition.targetPreset).toBe('momentum');
          expect(result.data.preparedTransition.oldPresetKey).toBe('mean_reversion');
          expect(result.data.preparedTransition.newPresetKey).toBe('momentum');
          expect(result.data.preparedTransition.transitionMode).toBe('entries_only');
          expect(result.data.preparedTransition.transitionScope).toBe('default');
          expect(result.data.preparedTransition.idempotencyKey).toBeTypeOf('string');
          expect(result.data.preparedTransition.positionActions).toEqual([]);
        }
      }
    });

    it('handles agent with no current binding (fresh agent)', async () => {
      const artifact = makeActiveArtifact();
      const agent = makeAgentRow();

      const service = createService([
        [artifact],
        [],     // binding query → empty (no active binding)
        [agent],
      ]);

      const result = await service.recommendTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.recommendedPreset).toBe('momentum');
        if (result.data.preparedTransition) {
          expect(result.data.preparedTransition.oldPresetKey).toBe('none');
          expect(result.data.preparedTransition.oldBehaviorVersion).toBe('unknown');
          expect(result.data.preparedTransition.oldBinding).toBeNull();
        }
      }
    });

    it('returns agent_not_found when agent does not exist', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow();

      const service = createService([
        [artifact],
        [binding],
        [], // agent query → empty
      ]);

      const result = await service.recommendTransition({
        agentId: 'nonexistent',
        assessmentArtifactId: 'artifact-1',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.agent_not_found');
      }
    });

    it('returns empty recommendation when artifact has no preset rankings', async () => {
      const artifact = makeActiveArtifact({ presetRankings: [] });
      const binding = makeBindingRow();
      const agent = makeAgentRow();

      const service = createService([
        [artifact],
        [binding],
        [agent],
      ]);

      const result = await service.recommendTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.recommendedPreset).toBeNull();
        expect(result.data.reasoningSummary).toContain('No presets ranked');
        expect(result.data.preparedTransition).toBeNull();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // applyTransition (durable mutation)
  // ═══════════════════════════════════════════════════════════════════════

  describe('applyTransition', () => {
    // ── Exact artifact required ─────────────────────────────────────────

    it('returns artifact_not_found when artifact does not exist', async () => {
      const service = createService([
        [], // artifact query → empty
      ]);

      const result = await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'nonexistent',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-1',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.artifact_not_found');
      }
    });

    // ── Stale artifact rejected ─────────────────────────────────────────

    it('rejects stale (expired) artifact', async () => {
      const expired = makeExpiredArtifact();
      const service = createService([
        [expired],
      ]);

      const result = await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-expired',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-2',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.artifact_expired');
      }
    });

    it('rejects stale (superseded) artifact', async () => {
      const superseded = makeSupersededArtifact();
      const service = createService([
        [superseded],
      ]);

      const result = await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-superseded',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-3',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.artifact_expired');
      }
    });

    // ── Preset not allowed by agent policy ──────────────────────────────

    it('rejects preset not allowed by agent policy', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow();
      const agent = makeAgentRow({
        platformAssessment: { enabled: true },
        allowedPresets: { allowed: ['mean_reversion', 'breakout'] }, // momentum not allowed
      });

      const service = createService([
        [artifact],
        [binding],
        [agent],
      ]);

      const result = await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-4',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.preset_not_allowed');
      }
    });

    // ── Preset not in artifact allowed set ──────────────────────────────

    it('rejects preset not in artifact allowed set', async () => {
      const artifact = makeActiveArtifact({
        allowedPresets: ['mean_reversion', 'breakout'], // momentum not in artifact allowed set
      });
      const binding = makeBindingRow();
      const agent = makeAgentRow();

      const service = createService([
        [artifact],
        [binding],
        [agent],
      ]);

      const result = await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-5',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.preset_not_in_artifact');
      }
    });

    // ── Transition persists prepared → applying → applied ───────────────

    it('persists transition through prepared → applying → applied states', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow({ activePresetKey: 'mean_reversion' });
      const agent = makeAgentRow();

      // Track state transitions via the DB mock capture
      const insertValues = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn(() => Promise.resolve()),
      });
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const setFn = vi.fn().mockReturnValue({ where: updateWhere });

      const db = {
        select: makeQueueDb([
          [artifact],  // artifact query
          [binding],   // binding query
          [agent],     // agent query
          [],          // (no more selects expected in the happy path after this)
        ]).select,
        insert: vi.fn(() => ({ values: insertValues })),
        update: vi.fn(() => ({ set: setFn })),
      };

      // Successful actor notification
      const notifyActor = vi.fn().mockResolvedValue(ok(undefined));

      const service = new PresetTransitionService({
        db: db as any,
        notifyActor,
      });

      const result = await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-6',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.state).toBe('applied');
        expect(result.data.transitionId).toBeTypeOf('string');
        expect(result.data.positionActionResults).toBeNull();
      }

      // Verify two inserts: transition record + binding upsert
      expect(insertValues).toHaveBeenCalledTimes(2);

      // First insert: transition record (state: prepared)
      const transitionRow = insertValues.mock.calls[0]?.[0];
      expect(transitionRow).toMatchObject({
        agentId: 'agent-1',
        oldPresetKey: 'mean_reversion',
        newPresetKey: 'momentum',
        state: 'prepared',
        mode: 'live',
        transitionMode: 'entries_only',
      });

      // Second insert: binding upsert
      const bindingRow = insertValues.mock.calls[1]?.[0];
      expect(bindingRow).toMatchObject({
        agentId: 'agent-1',
        activePresetKey: 'momentum',
        styleTier: 'standard',
        status: 'active',
      });

      // Verify update was called twice: once for applying, once for applied
      expect(setFn).toHaveBeenCalledTimes(2);
      expect(setFn.mock.calls[0]?.[0]).toEqual({ state: 'applying' });
      expect(setFn.mock.calls[1]?.[0]).toMatchObject({
        state: 'applied',
        outcome: 'accepted',
      });

      // Verify actor was notified
      expect(notifyActor).toHaveBeenCalledOnce();
      const notifyCall = notifyActor.mock.calls[0];
      expect(notifyCall[0]).toBe('agent-1');
      expect(notifyCall[1]).toBe('momentum');
      expect(notifyCall[2]).toBe('standard');
      expect(notifyCall[3]).toBeTypeOf('string'); // behaviorVersion
    });

    // ── Actor notification failure leaves state failed ──────────────────

    it('leaves state failed when actor notification fails', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow();
      const agent = makeAgentRow();

      const insertValues = vi.fn().mockResolvedValue(undefined);
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const setFn = vi.fn().mockReturnValue({ where: updateWhere });

      const db = {
        select: makeQueueDb([
          [artifact],
          [binding],
          [agent],
        ]).select,
        insert: vi.fn(() => ({ values: insertValues })),
        update: vi.fn(() => ({ set: setFn })),
      };

      // Actor notification fails
      const notifyActor = vi.fn().mockResolvedValue(
        err({ code: 'actor.unavailable', message: 'Actor is not running' }),
      );

      const service = new PresetTransitionService({
        db: db as any,
        notifyActor,
      });

      const result = await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-7',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.state).toBe('failed');
        expect(result.data.transitionId).toBeTypeOf('string');
      }

      // Verify final state is 'failed'
      const finalSetCall = setFn.mock.calls[1]?.[0];
      expect(finalSetCall).toMatchObject({
        state: 'failed',
        outcome: 'rejected',
      });

      // Verify actor was notified (and failed)
      expect(notifyActor).toHaveBeenCalledOnce();
    });

    // ── Binding upsert happens only after successful actor notification ─

    it('does NOT upsert binding when actor notification fails', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow();
      const agent = makeAgentRow();

      const insertValues = vi.fn().mockResolvedValue(undefined);
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const setFn = vi.fn().mockReturnValue({ where: updateWhere });

      // Track all insert calls by the table/values
      const allInsertValues: unknown[] = [];
      const insertFn = vi.fn((table?: unknown) => ({
        values: vi.fn((values: unknown) => {
          allInsertValues.push({ table, values });
          return Promise.resolve();
        }),
      }));

      const db = {
        select: makeQueueDb([
          [artifact],
          [binding],
          [agent],
        ]).select,
        insert: insertFn,
        update: vi.fn(() => ({ set: setFn })),
      };

      const notifyActor = vi.fn().mockResolvedValue(
        err({ code: 'actor.unavailable', message: 'Actor is not running' }),
      );

      const service = new PresetTransitionService({
        db: db as any,
        notifyActor,
      });

      await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-8',
      });

      // The only insert should be the transition record (state: prepared),
      // NOT the binding upsert. Since the actor notification fails,
      // the binding upsert code inside the try block should not execute.
      expect(allInsertValues.length).toBe(1);
      // The single insert is for agentPresetTransitions, not agentPresetBindings
    });

    // ── Binding upsert happens on successful actor notification ─────────

    it('upserts binding after successful actor notification', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow();
      const agent = makeAgentRow();

      const allInsertCalls: Array<{ table: unknown; values: unknown }> = [];
      const insertFn = vi.fn((table?: unknown) => ({
        values: vi.fn((values: unknown) => {
          allInsertCalls.push({ table, values });
          return {
            onConflictDoUpdate: vi.fn(() => Promise.resolve()),
          };
        }),
        onConflictDoUpdate: undefined,
      }));

      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const setFn = vi.fn().mockReturnValue({ where: updateWhere });

      const db = {
        select: makeQueueDb([
          [artifact],
          [binding],
          [agent],
        ]).select,
        insert: insertFn,
        update: vi.fn(() => ({ set: setFn })),
      };

      const notifyActor = vi.fn().mockResolvedValue(ok(undefined));

      const service = new PresetTransitionService({
        db: db as any,
        notifyActor,
      });

      await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-9',
      });

      // Two inserts: transition record + binding upsert
      expect(allInsertCalls.length).toBe(2);

      // Second insert is the binding upsert
      const bindingInsert = allInsertCalls[1];
      expect(bindingInsert).toBeDefined();
      if (bindingInsert) {
        const bindingValues = bindingInsert.values as Record<string, unknown>;
        expect(bindingValues.agentId).toBe('agent-1');
        expect(bindingValues.activePresetKey).toBe('momentum');
        expect(bindingValues.styleTier).toBe('standard');
        expect(bindingValues.status).toBe('active');
        expect(bindingValues.sourceArtifactId).toBe('artifact-1');
      }
    });

    // ── Platform assessment not enabled ─────────────────────────────────

    it('rejects transition when platformAssessment is not enabled', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow();
      const agent = makeAgentRow({ platformAssessment: { enabled: false } });

      const service = createService([
        [artifact],
        [binding],
        [agent],
      ]);

      const result = await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-10',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.not_enabled');
      }
    });

    // ── Agent not found ─────────────────────────────────────────────────

    it('returns agent_not_found when agent does not exist', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow();

      const service = createService([
        [artifact],
        [binding],
        [], // agent query → empty
      ]);

      const result = await service.applyTransition({
        agentId: 'nonexistent',
        assessmentArtifactId: 'artifact-1',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-11',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('transition.agent_not_found');
      }
    });

    // ── Actor notification absent (no-op) ───────────────────────────────

    it('succeeds when notifyActor is not provided (actor not running)', async () => {
      const artifact = makeActiveArtifact();
      const binding = makeBindingRow();
      const agent = makeAgentRow();

      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const setFn = vi.fn().mockReturnValue({ where: updateWhere });

      const allInsertCalls: Array<{ values: unknown }> = [];
      const insertFn = vi.fn((_table?: unknown) => ({
        values: vi.fn((values: unknown) => {
          allInsertCalls.push({ values });
          return {
            onConflictDoUpdate: vi.fn(() => Promise.resolve()),
          };
        }),
      }));

      const db = {
        select: makeQueueDb([
          [artifact],
          [binding],
          [agent],
        ]).select,
        insert: insertFn,
        update: vi.fn(() => ({ set: setFn })),
      };

      // No notifyActor provided → assume acknowledged
      const service = new PresetTransitionService({
        db: db as any,
      });

      const result = await service.applyTransition({
        agentId: 'agent-1',
        assessmentArtifactId: 'artifact-1',
        targetPreset: 'momentum',
        mode: 'entries_only',
        idempotencyKey: 'idem-12',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.state).toBe('applied');
      }

      // Binding should still be upserted because the catch block is not hit
      // (no notifyActor → actorAcknowledged stays true)
      expect(allInsertCalls.length).toBe(2);
    });
  });
});
