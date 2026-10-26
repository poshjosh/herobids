import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { and, desc, eq, gte } from 'drizzle-orm';
import {
  agentConnections,
  agentSkills,
  agents,
  checkAgentLimit,
  lockUserAgentCreation,
  users,
  type Database,
  type DatabaseTransaction,
} from '@herobids/db';
import { isUserOnlySkill, type PermissionLevel, type PlanCheckResult, type PlansConfig } from '@herobids/domain';
import { errorPayload } from '../error-payload.js';
import { consumeTokenBucketToken } from '../services/token-bucket.js';

export type AgentCreateRule = 'rate' | 'limiter' | 'ownership' | 'allowance' | 'depth' | 'plan_total' | 'grant' | 'permission';

type ApiErrorBody = ReturnType<typeof errorPayload>;
type PlanCheckError = Extract<PlanCheckResult, { ok: false }>['error'];

/**
 * Thrown inside the creation transaction (rolls it back) and mapped to a reply by the route. `rule`
 * names the policy that refused the attempt, for metrics.
 */
export class AgentCreatePolicyError extends Error {
  constructor(readonly status: number, readonly rule: AgentCreateRule, readonly body: ApiErrorBody) {
    super(body.message);
  }
}

/**
 * Thrown when a direct child of the same parent already has this name and was created inside the duplicate
 * window. Thrown in the creation transaction (rolls it back) and mapped by the route to that existing child.
 */
export class AgentChildDuplicateError extends Error {
  constructor(readonly childId: string) {
    super('A child with this name was created recently.');
  }
}

function agentPolicyError(
  status: number,
  rule: AgentCreateRule,
  code: string,
  message: string,
  params?: Record<string, unknown>,
): AgentCreatePolicyError {
  return new AgentCreatePolicyError(status, rule, errorPayload(code, message, params, { rule }));
}

/** The parent agent's own token bucket, shared across the user's whole tree. Every attempt that reaches it takes a token. */
export async function consumeAgentCreateToken(
  redis: Pick<Redis, 'eval'> | undefined,
  log: Pick<FastifyBaseLogger, 'warn'>,
  userId: string,
  ratePerMinute: number,
): Promise<AgentCreatePolicyError | null> {
  const unavailable = (): AgentCreatePolicyError => agentPolicyError(
    503,
    'limiter',
    'agent.create.limiter_unavailable',
    'Agent creation is temporarily unavailable. Retry shortly.',
  );
  if (!redis) return unavailable();

  const result = await consumeTokenBucketToken(redis, {
    key: `ratelimit:agent-create:${userId}`,
    capacity: ratePerMinute,
    refillPerMinute: ratePerMinute,
  });
  if (!result.ok) {
    log.warn({ err: result.error }, 'agent create rate limiter unavailable');
    return unavailable();
  }
  if (!result.data) {
    return agentPolicyError(429, 'rate', 'agent.create.rate_limited', 'Agent creation rate limit reached. Retry later.');
  }
  return null;
}

/** The reads the policy makes. The database and a transaction both satisfy it, so tests can pass a fake. */
export type AgentPolicyReader = Pick<Database, 'select'>;

export interface AgentCreateCaller {
  userId: string;
  planId: string;
  /** The requesting user's admin flag. Ignored for agent callers, whose owner's flag is read instead. */
  isAdmin: boolean;
  /** Set when the request came from an agent key: the parent agent that creates the child. */
  parentAgentId: string | null;
}

/** The only body fields an agent key may send to create a child. The server sets everything else. */
export const AGENT_CHILD_CREATE_FIELDS = ['name', 'prompt', 'skillIds', 'connectionIds', 'start'] as const;

const agentChildCreateFieldSet = new Set<string>(AGENT_CHILD_CREATE_FIELDS);

/** Body keys an agent key may not send, unknown keys included. They are refused, not stripped. */
export function disallowedAgentCreateFields(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  return Object.keys(body).filter((key) => !agentChildCreateFieldSet.has(key));
}

export interface AgentCreatePolicyInput {
  caller: AgentCreateCaller;
  plansConfig: PlansConfig | undefined;
  maxAgentDepth: number;
  /** Name of the child being created. Matched exactly against the parent's direct children. */
  childName: string;
  /** Seconds a same-name child of the same parent is returned instead of a new create. 0 disables the check. */
  duplicateChildWindowSeconds: number;
  skillIds: string[];
  connectionIds: string[];
  /** Omitted: a user creation gets standard; an agent creation gets the lower of the parent's level and standard. */
  permissionLevel: PermissionLevel | undefined;
}

/** Lineage and permission written on insert. Derived here from the caller and the parent row, never from request input. */
export interface AgentLineage {
  creatorType: 'user' | 'agent';
  creatorId: string;
  parentAgentId: string | null;
  depth: number;
  permissionLevel: PermissionLevel;
}

const PERMISSION_RANK = new Map<string, number>([
  ['restricted', 0],
  ['standard', 1],
  ['full', 2],
]);

/**
 * Authoritative check. Runs inside the transaction that inserts the agent, after the per-user lock.
 * Throws AgentCreatePolicyError on refusal so the transaction rolls back.
 */
export async function enforceAgentCreatePolicy(
  tx: DatabaseTransaction,
  input: AgentCreatePolicyInput,
): Promise<AgentLineage> {
  await lockUserAgentCreation(tx, input.caller.userId);
  return evaluateAgentCreatePolicy(tx, input, true);
}

/**
 * Read-only pre-check for agent callers, run before any profile-boundary write so a refused child
 * never reaches the boundary. Takes no locks. enforceAgentCreatePolicy remains the authoritative check.
 */
export async function preflightAgentCreatePolicy(db: Database, input: AgentCreatePolicyInput): Promise<void> {
  await evaluateAgentCreatePolicy(db, input, false);
}

export async function evaluateAgentCreatePolicy(
  q: AgentPolicyReader,
  input: AgentCreatePolicyInput,
  lockParent: boolean,
): Promise<AgentLineage> {
  const { caller } = input;

  if (!caller.parentAgentId) {
    const planError = await checkPlanTotal(q, input, caller.userId, caller.isAdmin);
    if (planError) {
      throw new AgentCreatePolicyError(403, 'plan_total', errorPayload(planError.code, planError.message, planError.params));
    }
    return { creatorType: 'user', creatorId: caller.userId, parentAgentId: null, depth: 0, permissionLevel: input.permissionLevel ?? 'standard' };
  }

  // Only the user may give a child the children skill. A parent that holds it cannot pass it on.
  if (input.skillIds.some(isUserOnlySkill)) {
    throw agentPolicyError(403, 'grant', 'agent.create.grant_user_only', 'This skill can only be added by the user.', { kind: 'skill' });
  }

  const parent = await lockParentAgent(q, caller.userId, caller.parentAgentId, lockParent);

  // Before the allowance check, so a retry at the allowance limit gets the child it already made.
  const duplicateChildId = await findRecentDuplicateChild(q, parent.id, input.childName, input.duplicateChildWindowSeconds);
  if (duplicateChildId) throw new AgentChildDuplicateError(duplicateChildId);

  const children = await q.select({ id: agents.id }).from(agents).where(eq(agents.parentAgentId, parent.id));
  if (children.length >= parent.childAgentLimit) {
    throw agentPolicyError(403, 'allowance', 'agent.create.allowance_exhausted', 'This agent has used its child agent allowance.', {
      limit: parent.childAgentLimit,
      current: children.length,
    });
  }

  const childDepth = parent.depth + 1;
  if (childDepth > input.maxAgentDepth) {
    throw agentPolicyError(403, 'depth', 'agent.create.depth_exceeded', 'The maximum agent depth has been reached.', {
      limit: input.maxAgentDepth,
      requested: childDepth,
    });
  }

  // Agent keys carry no admin rights (request.isAdmin is false), so the plan-total bypass follows the owner's flag.
  const [owner] = await q.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, caller.userId)).limit(1);
  const planError = await checkPlanTotal(q, input, caller.userId, owner?.isAdmin ?? false);
  if (planError) {
    throw agentPolicyError(403, 'plan_total', 'agent.create.plan_limit_exceeded', planError.message, planError.params);
  }

  await assertGrantsHeldByParent(q, parent, input);

  const permissionLevel = resolveChildPermission(parent.permissionLevel, input.permissionLevel);
  return { creatorType: 'agent', creatorId: parent.id, parentAgentId: parent.id, depth: childDepth, permissionLevel };
}

const MS_PER_SECOND = 1000;

/**
 * The newest direct child of the parent with this exact name, created at or after the window start. One query,
 * served by idx_agents_parent_name_created. Null when no child matches or the window is disabled.
 */
async function findRecentDuplicateChild(
  q: AgentPolicyReader,
  parentId: string,
  name: string,
  windowSeconds: number,
): Promise<string | null> {
  if (windowSeconds === 0) return null;
  const windowStart = new Date(Date.now() - windowSeconds * MS_PER_SECOND);
  const [duplicate] = await q
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.parentAgentId, parentId), eq(agents.name, name), gte(agents.createdAt, windowStart)))
    .orderBy(desc(agents.createdAt))
    .limit(1);
  return duplicate?.id ?? null;
}

async function lockParentAgent(q: AgentPolicyReader, userId: string, parentAgentId: string, lock: boolean) {
  const query = q
    .select({
      id: agents.id,
      depth: agents.depth,
      childAgentLimit: agents.childAgentLimit,
      permissionLevel: agents.permissionLevel,
    })
    .from(agents)
    .where(and(eq(agents.id, parentAgentId), eq(agents.userId, userId)));
  const [parent] = lock ? await query.for('update') : await query;
  if (!parent) {
    throw agentPolicyError(403, 'ownership', 'agent.create.parent_not_owned', 'The creating agent does not belong to you.');
  }
  return parent;
}

/** The plan total counts the user's agents, children included. Null when the plan allows the create. */
async function checkPlanTotal(
  q: AgentPolicyReader,
  input: AgentCreatePolicyInput,
  userId: string,
  isAdmin: boolean,
): Promise<PlanCheckError | null> {
  if (!input.plansConfig) return null;
  const planCheck = await checkAgentLimit(q, input.plansConfig, userId, input.caller.planId, isAdmin);
  return planCheck.ok ? null : planCheck.error;
}

/**
 * Every requested skill and connection must be held by the parent now.
 * Known gap (accepted, plan §5): these grant rows are read in the insert's transaction but not locked.
 * A skill or connection revoked from the parent while this creation runs can still pass. The parent row
 * lock serialises creations from the same parent only, so no further lock is taken here.
 */
async function assertGrantsHeldByParent(
  q: AgentPolicyReader,
  parent: { id: string },
  input: AgentCreatePolicyInput,
): Promise<void> {
  if (input.skillIds.length > 0) {
    const held = await q.select({ skillId: agentSkills.skillId }).from(agentSkills).where(eq(agentSkills.agentId, parent.id));
    const heldIds = new Set(held.map((row) => row.skillId));
    const missing = input.skillIds.filter((skillId) => !heldIds.has(skillId));
    if (missing.length > 0) {
      throw agentPolicyError(403, 'grant', 'agent.create.grant_not_held', 'The creating agent does not hold every requested skill.', {
        kind: 'skill',
        missing,
      });
    }
  }

  if (input.connectionIds.length > 0) {
    const assigned = await q
      .select({ connectionId: agentConnections.connectionId })
      .from(agentConnections)
      .where(and(eq(agentConnections.agentId, parent.id), eq(agentConnections.status, 'active')));
    const assignedIds = new Set(assigned.map((row) => row.connectionId));
    const missing = input.connectionIds.filter((connectionId) => !assignedIds.has(connectionId));
    if (missing.length > 0) {
      throw agentPolicyError(403, 'grant', 'agent.create.grant_not_held', 'The creating agent does not hold every requested connection.', {
        kind: 'connection',
        missing,
      });
    }
  }
}

/**
 * The child's permission level. Omitted: the lower of the parent's level and standard, so a restricted
 * parent can create restricted children. An explicit level may not exceed the parent's. An unknown level
 * on either side fails closed.
 */
function resolveChildPermission(parentLevel: string, requested: PermissionLevel | undefined): PermissionLevel {
  const parentRank = PERMISSION_RANK.get(parentLevel) ?? -1;
  const child: PermissionLevel = requested ?? (parentLevel === 'restricted' ? 'restricted' : 'standard');
  const childRank = PERMISSION_RANK.get(child) ?? Number.POSITIVE_INFINITY;
  if (childRank > parentRank) {
    throw agentPolicyError(403, 'permission', 'agent.create.permission_exceeds_parent', 'The child permission level cannot exceed the parent\'s.', {
      parent: parentLevel,
      requested: child,
    });
  }
  return child;
}
