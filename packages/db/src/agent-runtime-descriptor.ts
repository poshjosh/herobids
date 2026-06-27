import { and, eq, asc } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentSkills, capabilityGrants, connections, skillRevisions, skills, tradingBindings } from './schema/index.js';
import {
  BASE_SKILL,
  SYSTEM_SKILLS,
  findUnknownSkillTools,
} from '@herobids/domain';
import type {
  CapabilityReadiness,
  RuntimeBudgetPolicy,
  RuntimeDescriptor,
  RuntimeFamilyBindingDescriptor,
  SkillDefinition,
} from '@herobids/domain';

const SYSTEM_SKILLS_BY_ID: Record<string, SkillDefinition> = Object.fromEntries(
  [BASE_SKILL, ...SYSTEM_SKILLS].map((skill) => [skill.id, skill]),
);

function assertKnownRequiredTools(skillId: string, requiredTools: string[]): string[] {
  const unknownTools = findUnknownSkillTools(requiredTools);
  if (unknownTools.length > 0) {
    throw new Error(`Skill ${skillId} references unknown requiredTools: ${unknownTools.join(', ')}`);
  }
  return requiredTools;
}

type RuntimeGrantRow = {
  family: string;
  grantStatus: string;
  grantedAt: Date;
  bindingId: string;
  bindingStatus: string;
  connectionId: string;
  connectionStatus: string;
  provider: string;
  label: string;
  bindingRef: string | null;
  bindingProfile: Record<string, unknown> | null;
  sourceVenueAccountId: string | null;
};

function deriveReadiness(row?: RuntimeGrantRow): CapabilityReadiness {
  if (!row) {
    return {
      family: 'trading',
      state: 'unconfigured',
      bindingReadiness: 'unconfigured',
      agentEligibility: 'ineligible',
      effectiveReady: false,
      reasons: ['no grants have been created for this capability family'],
    };
  }

  if (row.connectionStatus === 'revoked') {
    return {
      family: row.family,
      state: 'revoked',
      bindingReadiness: 'revoked',
      agentEligibility: 'ineligible',
      effectiveReady: false,
      bindingId: row.bindingId,
      reasons: ['underlying connection has been revoked'],
    };
  }
  if (row.bindingStatus === 'revoked') {
    return {
      family: row.family,
      state: 'revoked',
      bindingReadiness: 'revoked',
      agentEligibility: 'ineligible',
      effectiveReady: false,
      bindingId: row.bindingId,
      reasons: ['binding has been revoked'],
    };
  }
  if (row.grantStatus === 'revoked') {
    return {
      family: row.family,
      state: 'revoked',
      bindingReadiness: row.bindingStatus === 'active' ? 'ready' : 'revoked',
      agentEligibility: 'ineligible',
      effectiveReady: false,
      bindingId: row.bindingId,
      reasons: ['grant has been revoked'],
    };
  }

  return {
    family: row.family,
    state: 'ready',
    bindingReadiness: 'ready',
    agentEligibility: 'eligible',
    effectiveReady: true,
    bindingId: row.bindingId,
    reasons: [],
  };
}

function chooseLatest(rows: RuntimeGrantRow[]): RuntimeGrantRow | undefined {
  return rows.slice().sort((left, right) => right.grantedAt.getTime() - left.grantedAt.getTime())[0];
}

function chooseDefaultBindingId(rows: RuntimeGrantRow[]): string | null {
  const readyRows = rows.filter((row) => row.grantStatus === 'active' && row.bindingStatus === 'active' && row.connectionStatus === 'active');
  return chooseLatest(readyRows)?.bindingId ?? chooseLatest(rows)?.bindingId ?? null;
}

function inferSkillFromRevisionRow(row: {
  skillId: string;
  name: string;
  description: string;
  instructions: string;
  requiredTools: string[];
  contextRequirements: string[];
  requiredGuardrails: string[];
  capabilityFamilies: string[];
  suggestedTickIntervalMs: number | null;
}): SkillDefinition {
  const systemSkill = SYSTEM_SKILLS_BY_ID[row.skillId];
  if (systemSkill) {
    return systemSkill;
  }

  const requiredTools = assertKnownRequiredTools(row.skillId, row.requiredTools);

  const inferredTradingCapability = requiredTools.includes('create_bot')
    || requiredTools.includes('submit_decision')
    || requiredTools.includes('manage_bot')
    || requiredTools.includes('bot_query')
    || requiredTools.includes('list_positions')
    || requiredTools.includes('get_analytics')
    || row.contextRequirements.some((requirement) => ['bot_statuses', 'positions', 'fills', 'analytics'].includes(requirement));

  const capabilityFamilies = row.capabilityFamilies.length > 0
    ? row.capabilityFamilies
    : inferredTradingCapability ? ['trading'] : [];
  const hasTrading = capabilityFamilies.includes('trading');
  const requiredContextBlocks = ['corePlatformContext', ...(hasTrading ? ['tradingContext'] : [])];

  return {
    id: row.skillId,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    requiredTools,
    capabilityFamilies,
    bindingRequirements: (hasTrading
      ? { trading: { minBindings: 1, requireReady: true } }
      : {}) as Record<string, { minBindings: number; requireReady: boolean }>,
    contextRequirements: row.contextRequirements,
    requiredContextBlocks,
    promptRendererHints: hasTrading ? ['readiness-summary', 'trading'] : ['core-system'],
    requiredGuardrails: row.requiredGuardrails,
    suggestedTickIntervalMs: row.suggestedTickIntervalMs ?? 900_000,
    visibility: 'private',
  };
}

export interface RuntimeCapabilityDescriptor {
  resolvedSkills: SkillDefinition[];
  grantedBindingsByFamily: Record<string, RuntimeFamilyBindingDescriptor[]>;
  readinessByFamily: Record<string, CapabilityReadiness>;
  defaultBindingByFamily: Record<string, string | null>;
}

export async function resolveRuntimeCapabilityDescriptor(
  db: Database,
  agentId: string,
): Promise<RuntimeCapabilityDescriptor> {
  const assignedSkillRows = await db
    .select({
      skillId: skills.id,
      name: skillRevisions.name,
      description: skillRevisions.description,
      instructions: skillRevisions.instructions,
      requiredTools: skillRevisions.requiredTools,
      contextRequirements: skillRevisions.contextRequirements,
      requiredGuardrails: skillRevisions.requiredGuardrails,
      capabilityFamilies: skillRevisions.capabilityFamilies,
      suggestedTickIntervalMs: skillRevisions.suggestedTickIntervalMs,
    })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .innerJoin(skillRevisions, eq(agentSkills.skillRevisionId, skillRevisions.id))
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(agentSkills.orderIndex), asc(agentSkills.skillId));

  const normalizedAssignedRows = assignedSkillRows.filter((row): row is typeof assignedSkillRows[number] & {
    skillId: string;
    requiredTools: string[];
  } => typeof row.skillId === 'string' && Array.isArray(row.requiredTools));

  const resolvedSkills: SkillDefinition[] = [BASE_SKILL];

  if (normalizedAssignedRows.length > 0) {
    const seenSkillIds = new Set<string>();
    for (const row of normalizedAssignedRows) {
      if (seenSkillIds.has(row.skillId)) {
        continue;
      }
      resolvedSkills.push(inferSkillFromRevisionRow(row));
      seenSkillIds.add(row.skillId);
    }
  }

  const tradingRows = await db
    .select({
      family: capabilityGrants.capabilityFamily,
      grantStatus: capabilityGrants.status,
      grantedAt: capabilityGrants.grantedAt,
      bindingId: tradingBindings.id,
      bindingStatus: tradingBindings.status,
      connectionId: connections.id,
      connectionStatus: connections.status,
      provider: tradingBindings.provider,
      label: tradingBindings.label,
      bindingRef: tradingBindings.bindingRef,
      bindingProfile: tradingBindings.bindingProfile,
      sourceVenueAccountId: tradingBindings.sourceVenueAccountId,
    })
    .from(capabilityGrants)
    .innerJoin(tradingBindings, eq(capabilityGrants.bindingId, tradingBindings.id))
    .innerJoin(connections, eq(tradingBindings.connectionId, connections.id))
    .where(and(eq(capabilityGrants.agentId, agentId), eq(capabilityGrants.capabilityFamily, 'trading')));

  const grantedBindingsByFamily: Record<string, RuntimeFamilyBindingDescriptor[]> = {};
  const readinessByFamily: Record<string, CapabilityReadiness> = {};
  const defaultBindingByFamily: Record<string, string | null> = {};

  const familiesFromSkills = new Set(resolvedSkills.flatMap((skill) => skill.capabilityFamilies));
  if (tradingRows.length > 0 || familiesFromSkills.has('trading')) {
    const defaultBindingId = chooseDefaultBindingId(tradingRows);
    grantedBindingsByFamily['trading'] = tradingRows.map((row) => ({
      family: 'trading',
      bindingId: row.bindingId,
      connectionId: row.connectionId,
      provider: row.provider,
      label: row.label,
      bindingRef: row.bindingRef,
      bindingProfile: row.bindingProfile,
      sourceVenueAccountId: row.sourceVenueAccountId,
      readiness: deriveReadiness(row),
      isDefault: row.bindingId === defaultBindingId,
    }));
    readinessByFamily['trading'] = deriveReadiness(
      tradingRows.find((row) => row.bindingId === defaultBindingId) ?? chooseLatest(tradingRows),
    );
    defaultBindingByFamily['trading'] = defaultBindingId;
  }

  for (const family of familiesFromSkills) {
    if (!readinessByFamily[family]) {
      readinessByFamily[family] = {
        family,
        state: 'unconfigured',
        bindingReadiness: 'unconfigured',
        agentEligibility: 'ineligible',
        effectiveReady: false,
        reasons: ['no grants have been created for this capability family'],
      };
    }
    if (!grantedBindingsByFamily[family]) {
      grantedBindingsByFamily[family] = [];
    }
    if (!(family in defaultBindingByFamily)) {
      defaultBindingByFamily[family] = null;
    }
  }

  return {
    resolvedSkills,
    grantedBindingsByFamily,
    readinessByFamily,
    defaultBindingByFamily,
  };
}

export function buildRuntimeDescriptor(input: {
  agentId: string;
  name?: string | null;
  goal: string;
  executionMode?: string | null;
  toolPolicy?: Record<string, unknown> | null;
  dailyLossLimit?: string | null;
  maxBots?: number | null;
  maxSlippageBps?: number | null;
  budgets: RuntimeBudgetPolicy;
  capabilityDescriptor: RuntimeCapabilityDescriptor;
}): RuntimeDescriptor {
  return {
    schemaVersion: 'v1',
    agentId: input.agentId,
    name: input.name ?? input.agentId,
    goal: input.goal,
    executionMode: input.executionMode ?? 'paper',
    resolvedSkills: input.capabilityDescriptor.resolvedSkills,
    grantedBindingsByFamily: input.capabilityDescriptor.grantedBindingsByFamily,
    defaultBindingByFamily: input.capabilityDescriptor.defaultBindingByFamily,
    readinessByFamily: input.capabilityDescriptor.readinessByFamily,
    toolPolicy: input.toolPolicy ?? {},
    guardrails: {
      dailyLossLimit: input.dailyLossLimit ?? null,
      maxBots: input.maxBots ?? null,
      maxSlippageBps: input.maxSlippageBps ?? null,
    },
    budgets: { ...input.budgets },
  };
}