/**
 * Edge-case unit tests for handleGoLive and its interaction with resolveAgentByName.
 *
 * Complements execution-mode-immutability.test.ts which covers the core happy/sad paths.
 * This file focuses on:
 * - Default parameter handling (userPlanId, isAdmin)
 * - Full dependency passthrough (llmCatalogDeps, operatorModelDefaults)
 * - Agent name edge cases (spaces, special chars, empty)
 * - Ambiguous agent ID truncation in messages
 * - Less common cloneAgentAsLive error codes
 * - DB-level failures during agent resolution
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@herobids/db';

// ── Service mocks ────────────────────────────────────────────────────────

vi.mock('../services/agent-config-service.js', () => ({
  grantConnection: vi.fn(),
  revokeConnection: vi.fn(),
  listAgentConnections: vi.fn(),
}));

vi.mock('../services/setup-link-token-service.js', () => ({
  makeSetupLinkUrl: vi.fn(),
  createAndStoreSetupLinkToken: vi.fn(),
}));

vi.mock('../services/agent-lifecycle-service.js', () => ({
  startAgent: vi.fn(),
  pauseAgent: vi.fn(),
  resumeAgent: vi.fn(),
  stopAgent: vi.fn(),
}));

vi.mock('../services/agent-go-live-service.js', () => ({
  cloneAgentAsLive: vi.fn(),
}));

import { handleGoLive } from './telegram-command-handlers.js';
import { cloneAgentAsLive } from '../services/agent-go-live-service.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

function makeRejectingChain(error: Error) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    _resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.reject(error).then(undefined, reject);
  return chain;
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    userId: 'user-1',
    name: 'Momentum',
    status: 'active',
    prompt: 'Trade BTC',
    style: 'balanced',
    executionDefaults: { mode: 'paper' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDb(agents: unknown[]): Database {
  return {
    select: vi.fn().mockReturnValue(makeChain(agents)),
  } as unknown as Database;
}

const mockClone = vi.mocked(cloneAgentAsLive);

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// Default parameter handling
// ─────────────────────────────────────────────────────────────────────────

describe('handleGoLive — default parameter values', () => {
  it('passes userPlanId "free" and isAdmin false when not specified', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({ ok: true, agentId: 'new-id' });

    await handleGoLive({ db, userId: 'user-1', args: ['Momentum'] });

    expect(mockClone).toHaveBeenCalledWith(
      expect.objectContaining({
        userPlanId: 'free',
        isAdmin: false,
      }),
    );
  });

  it('passes undefined for plansConfig, llmCatalogDeps, agentRiskDefaults, operatorModelDefaults when not provided', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({ ok: true, agentId: 'new-id' });

    await handleGoLive({ db, userId: 'user-1', args: ['Momentum'] });

    expect(mockClone).toHaveBeenCalledWith(
      expect.objectContaining({
        plansConfig: undefined,
        llmCatalogDeps: undefined,
        agentRiskDefaults: undefined,
        operatorModelDefaults: undefined,
      }),
    );
  });

  it('overrides userPlanId and isAdmin when explicitly provided', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({ ok: true, agentId: 'new-id' });

    await handleGoLive({
      db,
      userId: 'user-1',
      args: ['Momentum'],
      userPlanId: 'enterprise',
      isAdmin: true,
    });

    expect(mockClone).toHaveBeenCalledWith(
      expect.objectContaining({
        userPlanId: 'enterprise',
        isAdmin: true,
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Full dependency passthrough
// ─────────────────────────────────────────────────────────────────────────

describe('handleGoLive — full dependency passthrough', () => {
  it('forwards llmCatalogDeps and operatorModelDefaults to cloneAgentAsLive', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({ ok: true, agentId: 'new-id' });

    const fakeLlmDeps = { catalog: 'mock-catalog' } as unknown;
    const fakeModelDefaults = { model: 'gpt-4', temperature: 0.7 } as unknown;

    await handleGoLive({
      db,
      userId: 'user-1',
      args: ['Momentum'],
      llmCatalogDeps: fakeLlmDeps as any,
      operatorModelDefaults: fakeModelDefaults as any,
    });

    expect(mockClone).toHaveBeenCalledWith(
      expect.objectContaining({
        llmCatalogDeps: fakeLlmDeps,
        operatorModelDefaults: fakeModelDefaults,
      }),
    );
  });

  it('forwards all opts simultaneously to cloneAgentAsLive', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({ ok: true, agentId: 'new-id' });

    const fakePlans = { plans: { free: {} } } as unknown;
    const fakeLlmDeps = { catalog: 'mock' } as unknown;
    const fakeRisk = { maxOpenPositions: 25 } as unknown;
    const fakeModels = { model: 'claude-3' } as unknown;

    await handleGoLive({
      db,
      userId: 'user-1',
      args: ['Momentum'],
      plansConfig: fakePlans as any,
      userPlanId: 'pro',
      isAdmin: true,
      llmCatalogDeps: fakeLlmDeps as any,
      agentRiskDefaults: fakeRisk as any,
      operatorModelDefaults: fakeModels as any,
    });

    expect(mockClone).toHaveBeenCalledWith({
      sourceAgentId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      userId: 'user-1',
      db,
      plansConfig: fakePlans,
      userPlanId: 'pro',
      isAdmin: true,
      llmCatalogDeps: fakeLlmDeps,
      agentRiskDefaults: fakeRisk,
      operatorModelDefaults: fakeModels,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Agent name edge cases
// ─────────────────────────────────────────────────────────────────────────

describe('handleGoLive — agent name edge cases', () => {
  it('resolves agent with spaces in name (pre-stripped quotes)', async () => {
    const db = makeDb([makeAgent({ name: 'DCA Bot' })]);
    mockClone.mockResolvedValue({ ok: true, agentId: 'new-id' });

    const result = await handleGoLive({ db, userId: 'user-1', args: ['DCA Bot'] });

    expect(result).toContain("Created live agent 'DCA Bot (Live)'");
    expect(result).toContain('/start DCA Bot (Live)');
  });

  it('uses only the first arg as the agent name', async () => {
    // When extra args exist after the name, only args[0] is used
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({ ok: true, agentId: 'new-id' });

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Momentum', 'extra', 'args'] });

    expect(result).toContain("Created live agent 'Momentum (Live)'");
    expect(mockClone).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAgentId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Ambiguous agent resolution — message format
// ─────────────────────────────────────────────────────────────────────────

describe('handleGoLive — ambiguous agent message format', () => {
  it('truncates agent IDs to 8 characters with ellipsis', async () => {
    const db = makeDb([
      makeAgent({ id: 'abcdefgh-1234-5678-9abc-def012345678', name: 'Alpha' }),
      makeAgent({ id: '12345678-aaaa-bbbb-cccc-dddddddddddd', name: 'Alpha' }),
    ]);

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Alpha'] });

    expect(result).toContain('abcdefgh...');
    expect(result).toContain('12345678...');
    expect(result).toContain('Multiple agents named "Alpha"');
    expect(result).toContain('Use a unique name or check the web app.');
  });

  it('includes all matching agent entries in the ambiguous message', async () => {
    const db = makeDb([
      makeAgent({ id: 'id-aaaa-0001', name: 'Trader' }),
      makeAgent({ id: 'id-bbbb-0002', name: 'Trader' }),
      // resolveAgentByName limits to 3, so third entry would be the max
    ]);

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Trader'] });

    expect(result).toContain('Trader (id-aaaa-...), Trader (id-bbbb-...)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Less common cloneAgentAsLive error codes
// ─────────────────────────────────────────────────────────────────────────

describe('handleGoLive — cloneAgentAsLive error variants', () => {
  it('shows generic fallback for unrecognized error codes', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({
      ok: false,
      status: 500,
      error: 'internal.unknown',
      message: 'Database constraint violation',
    });

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Momentum'] });

    expect(result).toBe('Go Live failed: Database constraint violation');
  });

  it('shows connection error when message contains "active connection" anywhere', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'validation_error',
      message: 'No active connection found for the agent',
    });

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Momentum'] });

    expect(result).toBe('Momentum has no active connections. Grant a connection first.');
  });

  it('shows already-live message only for exact "Agent is already in live mode" message', async () => {
    const db = makeDb([makeAgent()]);
    // A similar but different message should NOT trigger the already-live branch
    mockClone.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'validation_error',
      message: 'Agent is already in live mode in another workspace',
    });

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Momentum'] });

    // This does NOT match the exact string check, so falls through to generic
    expect(result).toBe('Go Live failed: Agent is already in live mode in another workspace');
  });

  it('falls through to generic message for validation_error with unmatched message', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'validation_error',
      message: 'Agent configuration is invalid',
    });

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Momentum'] });

    expect(result).toBe('Go Live failed: Agent configuration is invalid');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DB-level failures
// ─────────────────────────────────────────────────────────────────────────

describe('handleGoLive — database errors during agent resolution', () => {
  it('catches DB errors in resolveAgentByName and returns fallback message', async () => {
    const db = {
      select: vi.fn().mockReturnValue(makeRejectingChain(new Error('ECONNREFUSED'))),
    } as unknown as Database;

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Momentum'] });

    expect(result).toBe('Failed to create live agent. Please try again later.');
    expect(mockClone).not.toHaveBeenCalled();
  });

  it('catches non-Error throwable in cloneAgentAsLive and returns fallback', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockRejectedValue('string error');

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Momentum'] });

    expect(result).toBe('Failed to create live agent. Please try again later.');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Success message format
// ─────────────────────────────────────────────────────────────────────────

describe('handleGoLive — success message format', () => {
  it('appends " (Live)" to the original agent name in the success message', async () => {
    const db = makeDb([makeAgent({ name: 'BTC Scalper' })]);
    mockClone.mockResolvedValue({ ok: true, agentId: 'new-live-id' });

    const result = await handleGoLive({ db, userId: 'user-1', args: ['BTC Scalper'] });

    expect(result).toBe("Created live agent 'BTC Scalper (Live)' — ready to start with /start BTC Scalper (Live)");
  });

  it('does not include the new agentId in the success message', async () => {
    const db = makeDb([makeAgent()]);
    mockClone.mockResolvedValue({ ok: true, agentId: 'new-live-abc123' });

    const result = await handleGoLive({ db, userId: 'user-1', args: ['Momentum'] });

    expect(result).not.toContain('new-live-abc123');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Usage/args boundary
// ─────────────────────────────────────────────────────────────────────────

describe('handleGoLive — args boundary', () => {
  it('returns usage for empty args array', async () => {
    const db = {} as Database;
    const result = await handleGoLive({ db, userId: 'user-1', args: [] });
    expect(result).toBe('Usage: /golive <agent name>');
    expect(mockClone).not.toHaveBeenCalled();
  });

  it('does not call DB or cloneAgentAsLive when args is empty', async () => {
    const db = { select: vi.fn() } as unknown as Database;
    await handleGoLive({ db, userId: 'user-1', args: [] });
    expect(db.select).not.toHaveBeenCalled();
    expect(mockClone).not.toHaveBeenCalled();
  });
});
