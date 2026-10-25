import type { Redis } from 'ioredis';
import { AGENT_STREAM_MAXLEN, type PeerMessagePayload, type PeerWake, type PeerWakePublisher } from '@herobids/domain';
import { AGENT_USER_MESSAGE_TYPE } from '../tick-gate-state.js';

/**
 * Publishes a peer message to the recipient's `agent:outbound:<id>` stream as an `agent.user.message` envelope.
 * That type already wakes the runtime early, bypasses the context-hash gate and is held (not dropped) while the agent itself is paused,
 * so a peer message needs no wake type of its own. `initiatorType` is `agent` and `payload.peer` names the sender, so
 * the receiving runtime tags the text as written by another agent. The envelope id is the thread row id.
 */
export class RedisPeerWakePublisher implements PeerWakePublisher {
  constructor(private readonly redis: Pick<Redis, 'xadd'>) {}

  async publish(wake: PeerWake): Promise<void> {
    const payload: PeerMessagePayload = {
      message: wake.body,
      peer: { fromAgentId: wake.fromAgentId, fromAgentName: wake.fromAgentName },
    };
    const envelope = {
      schemaVersion: 'v1',
      messageId: wake.messageId,
      correlationId: crypto.randomUUID(),
      initiatorType: 'agent',
      initiatorId: wake.fromAgentId,
      agentId: wake.toAgentId,
      type: AGENT_USER_MESSAGE_TYPE,
      createdAt: new Date().toISOString(),
      payload,
    };
    await this.redis.xadd(
      `agent:outbound:${wake.toAgentId}`,
      'MAXLEN', '~', AGENT_STREAM_MAXLEN,
      '*',
      'envelope', JSON.stringify(envelope),
    );
  }
}
