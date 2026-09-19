import {
  ExecutionDefaultsSchema,
  RiskPostureSchema,
  type ExecutionDefaults,
  type RiskPosture,
} from '@herobids/domain';

export interface TypedTradingProfile {
  actorId: string;
  venueAccountId: string;
  capital: string | null;
  riskPosture: RiskPosture | null;
  executionDefaults: ExecutionDefaults | null;
}

export type TradingProfileChanges = {
  capital?: string | null;
  riskPosture?: RiskPosture | null;
  executionDefaults?: ExecutionDefaults | null;
};

export interface TradingProfileConnection {
  connectionId: string;
  venueAccountId: string | null;
  active: boolean;
  ready: boolean;
  isDefault: boolean;
}

export interface TradingProfileConfiguration {
  actorId: string;
  venueAccountId: string;
  capital: string | null;
  riskPosture: RiskPosture | null;
  executionDefaults: ExecutionDefaults | null;
}

export interface ExecutionBinding {
  connectionId: string;
  venueAccountId: string;
}

export type TradingProfileInverseAction =
  | { kind: 'upsert'; snapshot: TradingProfileConfiguration }
  | { kind: 'clear'; venueAccountId: string }
  | { kind: 'select_binding'; binding: ExecutionBinding | null };

type TradingProfileForwardAction =
  | { kind: 'upsert'; snapshot: TradingProfileConfiguration }
  | { kind: 'clear'; venueAccountId: string }
  | { kind: 'select_binding'; binding: ExecutionBinding | null };

export interface TradingProfileReconciliationPlan {
  upserts: TradingProfileConfiguration[];
  clears: string[];
  selectedBinding: { previous: ExecutionBinding | null; next: ExecutionBinding | null };
  inverseActions: TradingProfileInverseAction[];
}

function sameSnapshot(left: TradingProfileConfiguration, right: TradingProfileConfiguration): boolean {
  return left.actorId === right.actorId
    && left.venueAccountId === right.venueAccountId
    && left.capital === right.capital
    && JSON.stringify(left.riskPosture) === JSON.stringify(right.riskPosture)
    && JSON.stringify(left.executionDefaults) === JSON.stringify(right.executionDefaults);
}

function sameBinding(left: ExecutionBinding | null, right: ExecutionBinding | null): boolean {
  return left?.connectionId === right?.connectionId
    && left?.venueAccountId === right?.venueAccountId;
}

/** Builds complete, boundary-ready snapshots for every active resolved trading account. */
export function buildTradingProfileSnapshots(
  profiles: ReadonlyMap<string, TypedTradingProfile>,
  connections: TradingProfileConnection[],
): TradingProfileConfiguration[] {
  const snapshotsByVenueAccountId = new Map<string, TradingProfileConfiguration>();
  for (const connection of connections
    .filter((connection): connection is TradingProfileConnection & { venueAccountId: string } => (
      connection.active && connection.venueAccountId !== null
    ))) {
    const profile = profiles.get(connection.venueAccountId);
    if (profile) snapshotsByVenueAccountId.set(connection.venueAccountId, profile);
  }
  return [...snapshotsByVenueAccountId.values()];
}

export function overlayTradingProfile(
  profile: TypedTradingProfile,
  changes: TradingProfileChanges,
): TypedTradingProfile {
  return {
    ...profile,
    ...(changes.capital !== undefined ? { capital: changes.capital } : {}),
    ...(changes.riskPosture !== undefined
      ? { riskPosture: changes.riskPosture === null ? null : RiskPostureSchema.parse(changes.riskPosture) }
      : {}),
    ...(changes.executionDefaults !== undefined
      ? { executionDefaults: changes.executionDefaults === null ? null : ExecutionDefaultsSchema.parse(changes.executionDefaults) }
      : {}),
  };
}

/**
 * Carries remote profiles forward for proposed local bindings. New bindings copy
 * the selected (or first) remote profile and never synthesize a default profile.
 */
export function proposeTradingProfiles(input: {
  priorProfiles: ReadonlyMap<string, TypedTradingProfile>;
  priorConnections: TradingProfileConnection[];
  proposedConnections: TradingProfileConnection[];
  changes: TradingProfileChanges;
}): Map<string, TypedTradingProfile> {
  const templateAccountId = selectExecutionBinding(input.priorConnections)?.venueAccountId;
  const template = (templateAccountId ? input.priorProfiles.get(templateAccountId) : undefined)
    ?? input.priorProfiles.values().next().value as TypedTradingProfile | undefined;
  const proposed = new Map<string, TypedTradingProfile>();
  for (const connection of input.proposedConnections) {
    if (!connection.active || connection.venueAccountId === null || proposed.has(connection.venueAccountId)) continue;
    const existing = input.priorProfiles.get(connection.venueAccountId);
    if (!existing && !template) {
      throw new Error('cannot grant a trading connection without an existing remote trading profile template');
    }
    const base = existing ?? { ...template!, venueAccountId: connection.venueAccountId };
    proposed.set(connection.venueAccountId, overlayTradingProfile(base, input.changes));
  }
  return proposed;
}

/** Selects one ready direct-execution binding using the runtime descriptor rule. */
export function selectExecutionBinding(connections: TradingProfileConnection[]): ExecutionBinding | null {
  const readyConnections = connections.filter(
    (connection): connection is TradingProfileConnection & { venueAccountId: string } => (
      connection.active && connection.ready && connection.venueAccountId !== null
    ),
  );
  const selected = readyConnections.find((connection) => connection.isDefault) ?? readyConnections[0];
  return selected
    ? { connectionId: selected.connectionId, venueAccountId: selected.venueAccountId }
    : null;
}

/** Plans replacement snapshots, removals, binding transition, and compensating inverse actions. */
export function planTradingProfileReconciliation(params: {
  prior: { profiles: ReadonlyMap<string, TypedTradingProfile>; connections: TradingProfileConnection[] };
  proposed: { profiles: ReadonlyMap<string, TypedTradingProfile>; connections: TradingProfileConnection[] };
}): TradingProfileReconciliationPlan {
  const priorSnapshots = buildTradingProfileSnapshots(params.prior.profiles, params.prior.connections);
  const proposedSnapshots = buildTradingProfileSnapshots(params.proposed.profiles, params.proposed.connections);
  const priorByVenueAccountId = new Map(priorSnapshots.map((snapshot) => [snapshot.venueAccountId, snapshot]));
  const proposedByVenueAccountId = new Map(proposedSnapshots.map((snapshot) => [snapshot.venueAccountId, snapshot]));
  const upserts = proposedSnapshots.filter((snapshot) => {
    const previous = priorByVenueAccountId.get(snapshot.venueAccountId);
    return !previous || !sameSnapshot(previous, snapshot);
  });
  const clears = priorSnapshots
    .filter((snapshot) => !proposedByVenueAccountId.has(snapshot.venueAccountId))
    .map((snapshot) => snapshot.venueAccountId);
  const selectedBinding = {
    previous: selectExecutionBinding(params.prior.connections),
    next: selectExecutionBinding(params.proposed.connections),
  };
  const forwardActions: TradingProfileForwardAction[] = [
    ...upserts.map((snapshot) => ({ kind: 'upsert' as const, snapshot })),
    ...clears.map((venueAccountId) => ({ kind: 'clear' as const, venueAccountId })),
    ...(sameBinding(selectedBinding.previous, selectedBinding.next)
      ? []
      : [{ kind: 'select_binding' as const, binding: selectedBinding.next }]),
  ];
  const inverseActions = forwardActions.reverse().map((action): TradingProfileInverseAction => {
    if (action.kind === 'select_binding') {
      return { kind: 'select_binding', binding: selectedBinding.previous };
    }
    if (action.kind === 'clear') {
      return { kind: 'upsert', snapshot: priorByVenueAccountId.get(action.venueAccountId)! };
    }

    const previous = priorByVenueAccountId.get(action.snapshot.venueAccountId);
    return previous
      ? { kind: 'upsert', snapshot: previous }
      : { kind: 'clear', venueAccountId: action.snapshot.venueAccountId };
  });

  return { upserts, clears, selectedBinding, inverseActions };
}