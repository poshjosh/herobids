import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { AgentRepository, type Database } from '@herobids/db';
import type { ExternalBackendClientResult, ExternalBackendSubject } from '@herobids/domain/external-backend';
import type { ProfilesCommittedEvent, TradingProfileReconciliationHooks } from './trading-profile-reconciliation-saga.js';

/**
 * Minimal lifecycle client: the API's trading-backend client exposes `invoke`
 * for a single tool call. The hook only needs this surface.
 */
export interface AgentActorLifecycleClient {
  invoke(input: {
    toolName: string;
    payload: unknown;
    subject: ExternalBackendSubject;
    requestId: string;
    idempotencyKey: string;
    correlationId: string;
    deadlineMs: number;
  }): Promise<ExternalBackendClientResult>;
}

/**
 * Build the post-commit agent-actor lifecycle hook (L1 / D6). After a profile
 * write commits, this is the single place that starts or stops the traderton
 * actor for an agent:
 *  - all profiles cleared (last connection revoked, or agent deleted) → stop.
 *  - a profile upserted on an agent with a live session + a resolved execution
 *    venue account → start on that account.
 *
 * Never throws: a lifecycle failure is logged, not propagated (the saga already
 * swallows hook errors, but failing fast here would still be wrong — the write
 * is committed). Each call uses a fresh idempotency key so the boundary does not
 * replay a prior start/stop result (the lifecycle tools are naturally idempotent).
 */
export function createAgentActorLifecycleHook(deps: {
  client: AgentActorLifecycleClient;
  db: Database;
  timeoutMs: number;
  logger: Logger;
}): TradingProfileReconciliationHooks {
  const agentRepo = new AgentRepository(deps.db);

  const invoke = async (toolName: string, payload: unknown, event: ProfilesCommittedEvent): Promise<void> => {
    const subject: ExternalBackendSubject = { ownerId: event.ownerId, actor: { type: 'agent', id: event.actorId } };
    const result = await deps.client.invoke({
      toolName,
      payload,
      subject,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      deadlineMs: deps.timeoutMs,
    });
    if (result.kind !== 'success') {
      deps.logger.warn(
        { toolName, actorId: event.actorId, kind: result.kind, errorCode: errorCodeOf(result) },
        'agent-actor lifecycle call did not succeed',
      );
    }
  };

  return {
    async onProfilesCommitted(event: ProfilesCommittedEvent): Promise<void> {
      try {
        if (event.remainingProfiles === 0 && event.cleared > 0) {
          await invoke('stop_agent_actor', {}, event);
          return;
        }
        if (event.upserted > 0 && event.executionVenueAccountId) {
          const session = await agentRepo.getCurrentSession(event.actorId);
          if (!session) return; // not live → nothing to start
          await invoke('start_agent_actor', { venueAccountId: event.executionVenueAccountId }, event);
        }
      } catch (error) {
        deps.logger.warn({ error, actorId: event.actorId }, 'agent-actor lifecycle hook failed');
      }
    },
  };
}

function errorCodeOf(result: ExternalBackendClientResult): string | undefined {
  if (result.kind === 'failure') {
    const details = result.details as Record<string, unknown> | undefined;
    return (typeof details?.['errorCode'] === 'string' ? details['errorCode'] : undefined) ?? result.code;
  }
  return undefined;
}
