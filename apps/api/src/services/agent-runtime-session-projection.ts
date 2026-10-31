import { getTableColumns } from 'drizzle-orm';
import { agentRuntimeSessions } from '@herobids/db';

const runtimeSessionColumns = getTableColumns(agentRuntimeSessions);

/**
 * Runtime session columns safe to return to API clients. Omits `apiKeyHash`: the hash is a
 * credential verifier and must not leave the server. Also omits the startup facts
 * (registration/placement times and allocation identity); scheduler identity stays internal until
 * a typed startup-progress projection is added.
 */
const NON_PUBLIC_RUNTIME_SESSION_COLUMNS = [
  'apiKeyHash',
  'runtimeRegisteredAt',
  'firstPlacedAt',
  'placementAllocationId',
] as const;

export const agentRuntimeSessionPublicColumns = Object.fromEntries(
  Object.entries(runtimeSessionColumns).filter(
    ([name]) => !(NON_PUBLIC_RUNTIME_SESSION_COLUMNS as readonly string[]).includes(name),
  ),
) as Omit<typeof runtimeSessionColumns, (typeof NON_PUBLIC_RUNTIME_SESSION_COLUMNS)[number]>;
