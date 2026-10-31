import { getTableColumns } from 'drizzle-orm';
import { agentRuntimeSessions } from '@herobids/db';
import {
  computeStartupProgress,
  isStartupDeadlineReason,
  type CapacityAwareStartTimings,
  type StartupDeadlineReason,
  type StartupProgress,
  type StartupProgressSession,
} from '@herobids/domain';

const runtimeSessionColumns = getTableColumns(agentRuntimeSessions);

/**
 * Runtime session columns safe to return to API clients. Omits `apiKeyHash`: the hash is a
 * credential verifier and must not leave the server. Also omits the startup facts
 * (registration/placement times and allocation identity); those are read only to derive the
 * typed `startupProgress` view, see `agentRuntimeSessionReadColumns`. `startupFailureReason` is
 * exposed only as a validated enum through `toPublicRuntimeSession`, never as a raw column.
 */
const NON_PUBLIC_RUNTIME_SESSION_COLUMNS = [
  'apiKeyHash',
  'runtimeRegisteredAt',
  'firstPlacedAt',
  'placementAllocationId',
  'startupFailureReason',
] as const;

export const agentRuntimeSessionPublicColumns = Object.fromEntries(
  Object.entries(runtimeSessionColumns).filter(
    ([name]) => !(NON_PUBLIC_RUNTIME_SESSION_COLUMNS as readonly string[]).includes(name),
  ),
) as Omit<typeof runtimeSessionColumns, (typeof NON_PUBLIC_RUNTIME_SESSION_COLUMNS)[number]>;

/** Columns a route selects before calling `toPublicRuntimeSession`. Never return these rows unmapped. */
export const agentRuntimeSessionReadColumns = {
  ...agentRuntimeSessionPublicColumns,
  runtimeRegisteredAt: runtimeSessionColumns.runtimeRegisteredAt,
  firstPlacedAt: runtimeSessionColumns.firstPlacedAt,
  startupFailureReason: runtimeSessionColumns.startupFailureReason,
};

export type StartupProgressGate = { enabled: boolean } & CapacityAwareStartTimings;

/** Client shape of a runtime session: the public columns plus the two derived, typed fields. */
export type PublicRuntimeSession<T> = Omit<T, (typeof NON_PUBLIC_RUNTIME_SESSION_COLUMNS)[number]> & {
  startupProgress: StartupProgress | null;
  /** Bounded enum explaining why a starting session was stopped by the worker; null otherwise. */
  startupFailureReason: StartupDeadlineReason | null;
};

/**
 * Maps a session read row to its client shape: drops the startup facts and the raw failure column,
 * and adds the derived `startupProgress` view and the validated `startupFailureReason` enum.
 */
export function toPublicRuntimeSession<T extends StartupProgressSession>(
  row: T,
  gate: StartupProgressGate | null,
): PublicRuntimeSession<T> {
  const {
    runtimeRegisteredAt: _registeredAt,
    firstPlacedAt: _placedAt,
    placementAllocationId: _allocationId,
    apiKeyHash: _apiKeyHash,
    startupFailureReason: rawFailureReason,
    ...publicRow
  } = row as T & {
    placementAllocationId?: unknown;
    apiKeyHash?: unknown;
    startupFailureReason?: unknown;
  };
  return {
    ...publicRow,
    startupProgress: gate ? computeStartupProgress(row, gate) : null,
    startupFailureReason: isStartupDeadlineReason(rawFailureReason) ? rawFailureReason : null,
  } as PublicRuntimeSession<T>;
}
