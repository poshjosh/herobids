import crypto from 'node:crypto';
import { agents, agentSkills, recordAgentAuditEvent, type DatabaseTransaction } from '@herobids/db';
import { applyChatAddresses, type ChatAddressesInput } from '../agents/chat-addresses.js';
import type { AgentBlueprintRevisionPayload, RiskPosture } from '@herobids/domain';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentFromPayloadContext {
  /** User creating the agent. */
  userId: string;
  /** Pre-generated agent ID (caller may need it for upstream idempotency). */
  agentId?: string;
  /** Blueprint attribution — omitted for non-blueprint callers (e.g. Go Live). */
  blueprintId?: string;
  blueprintRevisionId?: string;
  /** Chat address pre-fill for the new agent's own scope. Telegram entries are ignored: Telegram is user-level only. */
  chatAddresses?: ChatAddressesInput;
  /** Default name when payload.name is absent. */
  fallbackName?: string;
  /** Child-agent limit for the new row, set when the user assigns the children skill. Omitted means 0. */
  childAgentLimit?: number;
}

export interface SkillRef {
  skillId: string;
  skillRevisionId: string;
}

export interface AgentFromPayloadResult {
  agentId: string;
  unifiedConfig: Record<string, unknown> | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Build the unifiedConfig JSONB from an AgentBlueprintRevisionPayload.
 *
 * This mirrors the inline logic previously in blueprints.ts step 12 (agent branch).
 * The `riskOverride` parameter allows callers to supply a separately-resolved risk
 * value (e.g. after applying operator ceilings in the blueprint instantiate path).
 */
export function buildUnifiedConfigFromPayload(
  payload: AgentBlueprintRevisionPayload,
  riskOverride?: RiskPosture | null,
): Record<string, unknown> | null {
  const uc: Record<string, unknown> = {};

  if (payload.technical) uc.technical = payload.technical;
  if (payload.intelligence) uc.intelligence = payload.intelligence;
  uc.capabilityMode = payload.capabilityMode;
  if (payload.hybridMode) uc.hybridMode = payload.hybridMode;
  if (payload.executionPolicy) {
    uc.execution = {
      positionSizeMode: payload.executionPolicy.positionSizeMode,
      fixedPositionSize: payload.executionPolicy.fixedPositionSize,
    };
  }
  if (payload.executionDefaults) {
    uc.execution = {
      ...(isPlainObject(uc.execution) ? uc.execution : {}),
      mode: payload.executionDefaults.mode,
    };
  }
  // Risk goes into unifiedConfig.risk (separate from direct risk column)
  const risk = riskOverride ?? payload.risk;
  if (risk) {
    uc.risk = risk;
  }
  if (payload.allowedPresets) uc.allowedPresets = payload.allowedPresets;
  if (payload.presetTransition) uc.presetTransition = payload.presetTransition;
  if (payload.platformAssessment) uc.platformAssessment = payload.platformAssessment;
  uc.authorizationMode = payload.authorizationMode ?? 'direct';

  return Object.keys(uc).length > 0 ? uc : null;
}

// ── Core Service ─────────────────────────────────────────────────────────────

/**
 * Create an agent row + agent_skills from an AgentBlueprintRevisionPayload.
 *
 * This is the shared core extracted from the blueprint instantiate route.
 * It has NO blueprint-specific side effects: no attribution event, no
 * idempotency insert, no usage event. Callers are responsible for those.
 *
 * @param tx        Drizzle transaction (or DB instance)
 * @param payload   Validated agent blueprint revision payload
 * @param skillRefs Resolved skill assignments (caller decides source: revision pins or re-resolved)
 * @param context   Caller-supplied identity and optional overrides
 * @param riskOverride  Optional risk JSONB override (e.g. after operator ceiling resolution)
 */
export async function createAgentFromPayload(
  tx: DatabaseTransaction,
  payload: AgentBlueprintRevisionPayload,
  skillRefs: SkillRef[],
  context: AgentFromPayloadContext,
  riskOverride?: RiskPosture | null,
): Promise<AgentFromPayloadResult> {
  const agentId = context.agentId ?? crypto.randomUUID();

  const unifiedConfig = buildUnifiedConfigFromPayload(payload, riskOverride);

  await tx.insert(agents).values({
    id: agentId,
    userId: context.userId,
    name: payload.name ?? context.fallbackName ?? '',
    prompt: payload.prompt ?? '',
    style: payload.style,
    status: 'stopped',
    childAgentLimit: context.childAgentLimit ?? 0,
    strategy: payload.strategy ?? null,
    maxBots: payload.maxBots ?? null,
    tickIntervalMs: payload.tickIntervalMs ?? null,
    toolPolicy: payload.toolPolicy ?? null,
    modelPolicy: payload.modelPolicy ?? null,
    openPositionEscalationToJudgePolicy: payload.openPositionEscalationToJudgePolicy ?? 'uncovered_or_triggered',
    blueprintId: context.blueprintId ?? null,
    blueprintRevisionId: context.blueprintRevisionId ?? null,
    runtimePolicyOverrides: payload.runtimePolicyOverrides ?? null,
    wakePreferences: payload.wakePreferences ?? null,
    unifiedConfig: unifiedConfig,
  } as typeof agents.$inferInsert);

  if (context.chatAddresses && context.chatAddresses.length > 0) {
    await applyChatAddresses(tx, { userId: context.userId, agentId }, context.chatAddresses);
  }

  await recordAgentAuditEvent(tx, {
    userId: context.userId,
    actorType: 'user',
    actorId: context.userId,
    action: 'agent.created',
    targetId: agentId,
    detail: { depth: 0 },
  });
  if (context.childAgentLimit !== undefined) {
    await recordAgentAuditEvent(tx, {
      userId: context.userId,
      actorType: 'user',
      actorId: context.userId,
      action: 'agent.child_limit_set',
      targetId: agentId,
      detail: { childAgentLimit: context.childAgentLimit, source: 'skill_assigned' },
    });
  }

  // Insert agent_skills rows
  if (skillRefs.length > 0) {
    await tx.insert(agentSkills).values(
      skillRefs.map((s, i) => ({
        agentId,
        skillId: s.skillId,
        skillRevisionId: s.skillRevisionId,
        orderIndex: i,
        assignedByUserId: context.userId,
        assignmentSource: context.blueprintId ? 'blueprint_instantiate' : 'go_live',
      })),
    );
  }

  return { agentId, unifiedConfig };
}
