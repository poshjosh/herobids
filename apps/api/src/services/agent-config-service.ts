// Re-export shim: the grant service moved to @herobids/db. Importers should switch to @herobids/db.
export {
  grantConnection,
  grantConnectionToRunningAgent,
  listAgentConnections,
  revokeConnection,
} from '@herobids/db';
export type { AgentConfigError, RunningAgentGrantWakeContext } from '@herobids/db';
