import { describe, expect, it, vi } from 'vitest';
import { backfillProfileScanConfig, type BackfillAgentRow } from './backfill-profile-scan-config.js';
import type { TypedTradingProfile } from '../agents/trading-profile-reconciliation.js';
import { deriveProfileScanConfig } from '../agents/profile-scan-config.js';
import type { UnifiedAgentConfig } from '@herobids/domain';

vi.mock('../agents/trading-profile-reconciliation-adapter.js', () => ({
  loadActiveTradingProfileConnections: vi.fn(),
}));
import { loadActiveTradingProfileConnections } from '../agents/trading-profile-reconciliation-adapter.js';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

const CONNECTIONS = [
  { connectionId: 'c1', venueAccountId: 'venue-1', active: true, ready: true, isDefault: true },
];

/** A hybrid scanner_gated agent so deriveProfileScanConfig yields a non-null scan config. */
function hybridAgent(id = 'agent-1'): BackfillAgentRow {
  return {
    id,
    userId: 'user-1',
    style: 'balanced',
    unifiedConfig: {
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      technical: { filters: { venue: 'hyperliquid', venueType: 'orderbook' } },
    },
  };
}

/** A saga stub whose readCurrentProfiles returns profiles with the given scan state. */
function makeSaga(remote: { scanMode: 'scanner_gated' | 'mixed' | null; creatorStrategy: TypedTradingProfile['creatorStrategy'] }) {
  const executeStaged = vi.fn(async (input: {
    preparePlannerInput: () => { prior: unknown; proposed: unknown } | Promise<{ prior: unknown; proposed: unknown }>;
    commitLocal: (tx: unknown, mark: () => Promise<void>) => Promise<unknown>;
  }) => {
    await input.preparePlannerInput();
    return input.commitLocal(undefined, async () => undefined);
  });
  const readCurrentProfiles = vi.fn(async (_ownerId: string, actorId: string, connections: typeof CONNECTIONS) => new Map(
    connections.map((c) => [c.venueAccountId, {
      actorId,
      venueAccountId: c.venueAccountId,
      capital: '1000',
      riskPosture: null,
      executionDefaults: { mode: 'paper' as const },
      scanMode: remote.scanMode,
      creatorStrategy: remote.creatorStrategy,
    } satisfies TypedTradingProfile])),
  );
  return { saga: { executeStaged, readCurrentProfiles } as never, executeStaged, readCurrentProfiles };
}

describe('backfillProfileScanConfig', () => {
  it('dry run does not call the boundary (no executeStaged)', async () => {
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue(CONNECTIONS);
    const { saga, executeStaged } = makeSaga({ scanMode: null, creatorStrategy: null });

    const outcomes = await backfillProfileScanConfig({
      db: {} as never, saga, agentsList: [hybridAgent()], apply: false, logger: silentLogger(),
    });

    expect(executeStaged).not.toHaveBeenCalled();
    // Remote scan config is null but the agent is scanner_gated → the proposed
    // upsert differs → reported as "sent" even in dry-run.
    expect(outcomes).toEqual([{ agentId: 'agent-1', result: 'sent' }]);
  });

  it('apply sends the scan config for an agent whose traderton profile lacks it', async () => {
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue(CONNECTIONS);
    const { saga, executeStaged } = makeSaga({ scanMode: null, creatorStrategy: null });

    const outcomes = await backfillProfileScanConfig({
      db: {} as never, saga, agentsList: [hybridAgent()], apply: true, logger: silentLogger(),
    });

    expect(executeStaged).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([{ agentId: 'agent-1', result: 'sent' }]);
  });

  it('reports an unchanged agent as unchanged', async () => {
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue(CONNECTIONS);
    // Remote already carries the EXACT scan config the agent would derive —
    // compute it the same way the backfill does so the snapshot compares equal.
    const agent = hybridAgent();
    const derived = deriveProfileScanConfig({ unifiedConfig: agent.unifiedConfig as UnifiedAgentConfig, style: agent.style });
    const { saga } = makeSaga({ scanMode: derived.scanMode, creatorStrategy: derived.creatorStrategy });

    const outcomes = await backfillProfileScanConfig({
      db: {} as never, saga, agentsList: [agent], apply: true, logger: silentLogger(),
    });

    expect(outcomes).toEqual([{ agentId: 'agent-1', result: 'unchanged' }]);
  });

  it('one failure does not stop the remaining agents', async () => {
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue(CONNECTIONS);
    const { saga, readCurrentProfiles } = makeSaga({ scanMode: null, creatorStrategy: null });
    // Fail the first agent's read, succeed the second.
    (readCurrentProfiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('boundary down'), { code: 'venue.timeout' }));

    const outcomes = await backfillProfileScanConfig({
      db: {} as never, saga, agentsList: [hybridAgent('agent-a'), hybridAgent('agent-b')], apply: true, logger: silentLogger(),
    });

    expect(outcomes).toEqual([
      { agentId: 'agent-a', result: 'failed', errorCode: 'venue.timeout' },
      { agentId: 'agent-b', result: 'sent' },
    ]);
  });

  it('skips agents with no active trading connection', async () => {
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([]);
    const { saga, executeStaged } = makeSaga({ scanMode: null, creatorStrategy: null });

    const outcomes = await backfillProfileScanConfig({
      db: {} as never, saga, agentsList: [hybridAgent()], apply: true, logger: silentLogger(),
    });

    expect(executeStaged).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });
});
