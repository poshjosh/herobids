import {
  ExecutionDefaultsSchema,
  RiskPostureSchema,
  type ExecutionDefaults,
  type RiskPosture,
} from '@herobids/domain';

export interface TradingProfileAgentConfig {
  actorId: string;
  capital: string | null;
  riskPosture: RiskPosture | null;
  executionDefaults: ExecutionDefaults | null;
}

export interface TradingProfileConnection {
  connectionId: string;
  venueAccountId: string | null;
  active: boolean;
  ready: boolean;
  grantedAt: Date;
  assignmentId: string;
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
  config: TradingProfileAgentConfig,
  connections: TradingProfileConnection[],
): TradingProfileConfiguration[] {
  const riskPosture = config.riskPosture === null ? null : RiskPostureSchema.parse(config.riskPosture);
  const executionDefaults = config.executionDefaults === null
    ? null
    : ExecutionDefaultsSchema.parse(config.executionDefaults);

  const snapshotsByVenueAccountId = new Map<string, TradingProfileConfiguration>();
  for (const connection of connections
    .filter((connection): connection is TradingProfileConnection & { venueAccountId: string } => (
      connection.active && connection.venueAccountId !== null
    ))) {
    snapshotsByVenueAccountId.set(connection.venueAccountId, {
      actorId: config.actorId,
      venueAccountId: connection.venueAccountId,
      capital: config.capital,
      riskPosture,
      executionDefaults,
    });
  }
  return [...snapshotsByVenueAccountId.values()];
}

/** Selects one ready direct-execution binding using the runtime grant ordering. */
export function selectExecutionBinding(connections: TradingProfileConnection[]): ExecutionBinding | null {
  const readyConnections = connections.filter(
    (connection): connection is TradingProfileConnection & { venueAccountId: string } => (
      connection.active && connection.ready && connection.venueAccountId !== null
    ),
  );
  const selected = readyConnections.slice().sort((left, right) => {
    const grantDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    return grantDelta !== 0 ? grantDelta : right.assignmentId.localeCompare(left.assignmentId);
  })[0];
  return selected
    ? { connectionId: selected.connectionId, venueAccountId: selected.venueAccountId }
    : null;
}

/** Plans replacement snapshots, removals, binding transition, and compensating inverse actions. */
export function planTradingProfileReconciliation(params: {
  prior: { config: TradingProfileAgentConfig; connections: TradingProfileConnection[] };
  proposed: { config: TradingProfileAgentConfig; connections: TradingProfileConnection[] };
}): TradingProfileReconciliationPlan {
  const priorSnapshots = buildTradingProfileSnapshots(params.prior.config, params.prior.connections);
  const proposedSnapshots = buildTradingProfileSnapshots(params.proposed.config, params.proposed.connections);
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