import { getTableColumns } from 'drizzle-orm';
import { agentRuntimeSessions } from '@herobids/db';

const runtimeSessionColumns = getTableColumns(agentRuntimeSessions);

/**
 * Runtime session columns safe to return to API clients. Omits `apiKeyHash`: the hash is a
 * credential verifier and must not leave the server.
 */
export const agentRuntimeSessionPublicColumns = Object.fromEntries(
  Object.entries(runtimeSessionColumns).filter(([name]) => name !== 'apiKeyHash'),
) as Omit<typeof runtimeSessionColumns, 'apiKeyHash'>;
