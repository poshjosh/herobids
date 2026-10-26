import crypto from 'node:crypto';
import type { Database } from './index.js';
import type { DatabaseTransaction } from './trading-profile-reconciliation-outbox-repository.js';
import { agentAuditEvents } from './schema/index.js';

export const AGENT_AUDIT_ACTIONS = [
  'agent.created',
  'agent.child_created',
  'agent.child_limit_set',
  'agent.creator_paused_child',
  'agent.creator_stopped_child',
  'agent.creator_messaged_child',
  'agent.deleted',
  'agent.delete_failed',
  'agent.child_deleted',
] as const;

export type AgentAuditAction = (typeof AGENT_AUDIT_ACTIONS)[number];

export type AgentAuditActorType = 'user' | 'agent' | 'system';

/**
 * The only keys an audit event may carry. Counts and ids, never prompts, configuration, keys or message text.
 * The type is closed, so a literal with any other key fails to compile.
 */
export interface AgentAuditDetail {
  parentAgentId?: string;
  depth?: number;
  childAgentLimit?: number;
  scope?: 'agent' | 'subtree';
  agentCount?: number;
  botCount?: number;
  /** The delete step reached when a delete failed. */
  step?: string;
  /** Why a child limit changed: a user assigned the children skill. */
  source?: 'skill_assigned';
}

export interface AgentAuditEventInput {
  userId: string;
  actorType: AgentAuditActorType;
  actorId: string | null;
  action: AgentAuditAction;
  targetId: string;
  detail?: AgentAuditDetail;
}

const actionSet = new Set<string>(AGENT_AUDIT_ACTIONS);

/**
 * Appends one audit row. Pass the transaction of the change being audited so the row commits or rolls back
 * with it. Throws on an action outside the closed set or on a failed insert: inside a transaction, a
 * thrown error aborts the change, which is the intended outcome when the audit cannot be written.
 */
export async function recordAgentAuditEvent(
  q: Database | DatabaseTransaction,
  event: AgentAuditEventInput,
): Promise<void> {
  if (!actionSet.has(event.action)) {
    throw new Error(`unknown agent audit action: ${event.action}`);
  }
  await q.insert(agentAuditEvents).values({
    id: crypto.randomUUID(),
    userId: event.userId,
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    targetType: 'agent',
    targetId: event.targetId,
    detail: event.detail ? { ...event.detail } : null,
  });
}
