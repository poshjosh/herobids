import { describe, expect, it } from 'vitest';
import {
  buildTradingProfileSnapshots,
  overlayTradingProfile,
  planTradingProfileReconciliation,
  proposeTradingProfiles,
  selectExecutionBinding,
  type TradingProfileConnection,
  type TypedTradingProfile,
} from './trading-profile-reconciliation.js';
import { loadActiveTradingProfileConnections } from './trading-profile-reconciliation-adapter.js';

const profile: TypedTradingProfile = {
  actorId: 'agent-1',
  venueAccountId: 'venue-account-1',
  capital: null,
  riskPosture: null,
  executionDefaults: null,
};

function profiles(...items: TypedTradingProfile[]): Map<string, TypedTradingProfile> {
  return new Map(items.map((item) => [item.venueAccountId, item]));
}

function connection(overrides: Partial<TradingProfileConnection>): TradingProfileConnection {
  return {
    connectionId: 'connection-1',
    venueAccountId: 'venue-account-1',
    active: true,
    ready: true,
    isDefault: false,
    ...overrides,
  };
}

describe('trading profile reconciliation', () => {
  it('builds full snapshots without changing nullable configuration semantics', () => {
    expect(buildTradingProfileSnapshots(profiles(profile), [connection({})])).toEqual([{
      actorId: 'agent-1',
      venueAccountId: 'venue-account-1',
      capital: null,
      riskPosture: null,
      executionDefaults: null,
    }]);
  });

  it('selects the ready default binding even when it follows another ready connection', () => {
    const bindings = [
      connection({ connectionId: 'first-ready', venueAccountId: 'account-first' }),
      connection({
        connectionId: 'default-ready',
        venueAccountId: 'account-default',
        isDefault: true,
      }),
    ];

    expect(selectExecutionBinding(bindings)).toEqual({ connectionId: 'default-ready', venueAccountId: 'account-default' });
  });

  it('selects the first ready binding when the default is not ready', () => {
    const bindings = [
      connection({ connectionId: 'first-ready', venueAccountId: 'account-first' }),
      connection({
        connectionId: 'default-not-ready',
        venueAccountId: 'account-default',
        ready: false,
        isDefault: true,
      }),
      connection({ connectionId: 'later-ready', venueAccountId: 'account-later' }),
    ];

    expect(selectExecutionBinding(bindings)).toEqual({ connectionId: 'first-ready', venueAccountId: 'account-first' });
  });

  it('matches runtime default and first-ready fallback from adapter-loaded bindings', async () => {
    const rows = [
      {
        assignmentId: 'assignment-first',
        grantedAt: new Date('2026-01-01T00:00:00.000Z'),
        connectionId: 'first-ready',
        venueAccountId: 'account-first',
        connectionStatus: 'active',
      },
      {
        assignmentId: 'assignment-default',
        grantedAt: new Date('2026-01-02T00:00:00.000Z'),
        connectionId: 'default-not-ready',
        venueAccountId: null,
        connectionStatus: 'active',
      },
      {
        assignmentId: 'assignment-later',
        grantedAt: new Date('2026-01-01T00:00:00.000Z'),
        connectionId: 'later-ready',
        venueAccountId: 'account-later',
        connectionStatus: 'active',
      },
    ];
    const query = {
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
    };
    const db = { select: () => query };

    const connections = await loadActiveTradingProfileConnections(db as never, 'agent-1');

    expect(connections.find((connection) => connection.isDefault)?.connectionId).toBe('default-not-ready');
    expect(selectExecutionBinding(connections)).toEqual({ connectionId: 'first-ready', venueAccountId: 'account-first' });
  });

  it('plans binding removal, exact clears, and inverse restoration', () => {
    const prior = [connection({})];
    const plan = planTradingProfileReconciliation({
      prior: { profiles: profiles(profile), connections: prior },
      proposed: { profiles: profiles(profile), connections: [] },
    });

    expect(plan.upserts).toEqual([]);
    expect(plan.clears).toEqual(['venue-account-1']);
    expect(plan.selectedBinding).toEqual({
      previous: { connectionId: 'connection-1', venueAccountId: 'venue-account-1' },
      next: null,
    });
    expect(plan.inverseActions).toEqual([
      { kind: 'select_binding', binding: { connectionId: 'connection-1', venueAccountId: 'venue-account-1' } },
      {
        kind: 'upsert',
        snapshot: {
          actorId: 'agent-1', venueAccountId: 'venue-account-1', capital: null, riskPosture: null, executionDefaults: null,
        },
      },
    ]);
  });

  it('reverses the complete mixed forward sequence for compensation', () => {
    const prior = [
      connection({ connectionId: 'connection-a', venueAccountId: 'venue-account-a' }),
      connection({ connectionId: 'connection-c', venueAccountId: 'venue-account-c', ready: false }),
    ];
    const proposed = [
      connection({ connectionId: 'connection-a', venueAccountId: 'venue-account-a' }),
      connection({
        connectionId: 'connection-b',
        venueAccountId: 'venue-account-b',
        isDefault: true,
      }),
    ];

    const plan = planTradingProfileReconciliation({
      prior: { profiles: profiles(
        { ...profile, venueAccountId: 'venue-account-a' },
        { ...profile, venueAccountId: 'venue-account-c' },
      ), connections: prior },
      proposed: { profiles: profiles(
        { ...profile, venueAccountId: 'venue-account-a', capital: '100' },
        { ...profile, venueAccountId: 'venue-account-b', capital: '100' },
      ), connections: proposed },
    });

    expect(plan.upserts.map((snapshot) => snapshot.venueAccountId)).toEqual(['venue-account-a', 'venue-account-b']);
    expect(plan.clears).toEqual(['venue-account-c']);
    expect(plan.selectedBinding).toEqual({
      previous: { connectionId: 'connection-a', venueAccountId: 'venue-account-a' },
      next: { connectionId: 'connection-b', venueAccountId: 'venue-account-b' },
    });
    expect(plan.inverseActions).toEqual([
      { kind: 'select_binding', binding: { connectionId: 'connection-a', venueAccountId: 'venue-account-a' } },
      {
        kind: 'upsert',
        snapshot: {
          actorId: 'agent-1', venueAccountId: 'venue-account-c', capital: null, riskPosture: null, executionDefaults: null,
        },
      },
      { kind: 'clear', venueAccountId: 'venue-account-b' },
      {
        kind: 'upsert',
        snapshot: {
          actorId: 'agent-1', venueAccountId: 'venue-account-a', capital: null, riskPosture: null, executionDefaults: null,
        },
      },
    ]);
  });

  it('plans deletion as clears with inverse snapshots', () => {
    const plan = planTradingProfileReconciliation({
      prior: { profiles: profiles(profile, { ...profile, venueAccountId: 'venue-account-2' }), connections: [connection({}), connection({ connectionId: 'connection-2', venueAccountId: 'venue-account-2' })] },
      proposed: { profiles: profiles(profile, { ...profile, venueAccountId: 'venue-account-2' }), connections: [] },
    });

    expect(plan.clears).toEqual(['venue-account-1', 'venue-account-2']);
    expect(plan.inverseActions.filter((action) => action.kind === 'upsert')).toHaveLength(2);
  });

  it('preserves unrelated remote profiles while overlaying supplied changes per account', () => {
    const first = { ...profile, capital: '100' };
    const second = { ...profile, venueAccountId: 'venue-account-2', capital: '200' };
    const plan = planTradingProfileReconciliation({
      prior: { profiles: profiles(first, second), connections: [connection({}), connection({ connectionId: 'connection-2', venueAccountId: 'venue-account-2' })] },
      proposed: { profiles: profiles(overlayTradingProfile(first, { executionDefaults: { mode: 'paper' } }), second), connections: [connection({}), connection({ connectionId: 'connection-2', venueAccountId: 'venue-account-2' })] },
    });

    expect(plan.upserts).toEqual([{ ...first, executionDefaults: { mode: 'paper' } }]);
    expect(plan.clears).toEqual([]);
  });

  it('copies the selected remote profile for a new account and synthesizes a null profile for a first grant', () => {
    const priorConnections = [connection({ isDefault: true })];
    const proposedConnections = [...priorConnections, connection({ connectionId: 'connection-2', venueAccountId: 'venue-account-2' })];

    expect(proposeTradingProfiles({
      actorId: 'agent-1',
      priorProfiles: profiles({ ...profile, capital: '250', executionDefaults: { mode: 'paper' } }),
      priorConnections,
      proposedConnections,
      changes: {},
    }).get('venue-account-2')).toEqual({ ...profile, venueAccountId: 'venue-account-2', capital: '250', executionDefaults: { mode: 'paper' } });

    expect(proposeTradingProfiles({
      actorId: 'agent-1',
      priorProfiles: new Map(), priorConnections: [], proposedConnections: [connection({})], changes: {},
    }).get('venue-account-1')).toEqual({
      actorId: 'agent-1',
      venueAccountId: 'venue-account-1',
      capital: null,
      riskPosture: null,
      executionDefaults: null,
    });
  });
});