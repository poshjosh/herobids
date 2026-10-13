import type { AgentWakePayload } from '../trading/trading-protocol.js';

/**
 * Domain port for publishing an agent wake from a process that is NOT the
 * worker (e.g. the API). The worker's `InstanceEventPublisher` is the canonical
 * implementation; the API needs the same Redis XADD to `agent:outbound:{agentId}`
 * but cannot import worker code. This port lets the API own a thin Redis
 * implementation while the domain (and `packages/db`) depend only on the
 * abstraction.
 */
export interface AgentWakePublisher {
  emitAgentWake(agentId: string, payload: AgentWakePayload): Promise<void>;
}