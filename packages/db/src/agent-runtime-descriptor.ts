import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from './index.js';
import { capabilityGrants, connections, skills, tradingBindings } from './schema/index.js';
import {
  BASE_SKILL,
  BOT_MANAGEMENT_SKILL,
  DEFAULT_RUNTIME_BUDGETS,
  RISK_MONITORING_SKILL,
} from '@herobids/domain';
import type {
  CapabilityReadiness,
  RuntimeDescriptor,
  RuntimeFamilyBindingDescriptor,
  SkillDefinition,
} from '@herobids/domain';

const SYSTEM_SKILLS_BY_ID: Record<string, SkillDefinition> = {
  [BASE_SKILL.id]: BASE_SKILL,
  [BOT_MANAGEMENT_SKILL.id]: BOT_MANAGEMENT_SKILL,
  [RISK_MONITORING_SKILL.id]: RISK_MONITORING_SKILL,
};

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
  const ready = rows.find((row) => row.grantStatus === 'active' && row.bindingStatus === 'active' && row.connectionStatus === 'active');
  return ready?.bindingId ?? chooseLatest(rows)?.bindingId ?? null;
}

function inferSkillFromRow(row: typeof skills.$inferSelect): SkillDefinition {
  const skill = SYSTEM_SKILLS_BY_ID[row.id];
  if (skill) {
    return skill;
  }

  const requiresTrading = row.requiredTools.includes('create_bot')
    || row.requiredTools.includes('decision_submit')
    || row.contextRequirements.some((requirement) => ['bot_statuses', 'positions', 'fills', 'analytics'].includes(requirement));

  const capabilityFamilies = requiresTrading ? ['trading'] : [];
  const requiredContextBlocks = ['corePlatformContext', ...(requiresTrading ? ['tradingContext'] : [])];

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    requiredTools: row.requiredTools,
    capabilityFamilies,
    bindingRequirements: (requiresTrading
      ? { trading: { minBindings: 1, requireReady: true } }
      : {}) as Record<string, { minBindings: number; requireReady: boolean }>,
    contextRequirements: row.contextRequirements,
    requiredContextBlocks,
    promptRendererHints: requiresTrading ? ['readiness-summary', 'trading'] : ['core-system'],
    requiredGuardrails: row.requiredGuardrails,
    suggestedTickIntervalMs: row.suggestedTickIntervalMs ?? 900_000,
    visibility: row.visibility === 'public' ? 'public' : 'private',
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
  skillIds: string[],
): Promise<RuntimeCapabilityDescriptor> {
  const storedSkills = skillIds.length > 0
    ? await db.select().from(skills).where(inArray(skills.id, skillIds))
    : [];

  const seenSkillIds = new Set<string>();
  const resolvedSkills: SkillDefinition[] = [BASE_SKILL];
  for (const skillId of skillIds) {
    const systemSkill = SYSTEM_SKILLS_BY_ID[skillId];
    if (systemSkill && !seenSkillIds.has(systemSkill.id)) {
      resolvedSkills.push(systemSkill);
      seenSkillIds.add(systemSkill.id);
      continue;
    }

    const storedSkill = storedSkills.find((row) => row.id === skillId);
    if (storedSkill && !seenSkillIds.has(storedSkill.id)) {
      resolvedSkills.push(inferSkillFromRow(storedSkill));
      seenSkillIds.add(storedSkill.id);
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
  goal: string;
  executionMode?: string | null;
  toolPolicy?: Record<string, unknown> | null;
  dailyTokenBudget?: number | null;
  dailyLossLimit?: string | null;
  maxBots?: number | null;
  maxSlippageBps?: number | null;
  capabilityDescriptor: RuntimeCapabilityDescriptor;
}): RuntimeDescriptor {
  return {
    schemaVersion: 'v1',
    agentId: input.agentId,
    goal: input.goal,
    executionMode: input.executionMode ?? 'paper',
    resolvedSkills: input.capabilityDescriptor.resolvedSkills,
    grantedBindingsByFamily: input.capabilityDescriptor.grantedBindingsByFamily,
    defaultBindingByFamily: input.capabilityDescriptor.defaultBindingByFamily,
    readinessByFamily: input.capabilityDescriptor.readinessByFamily,
    toolPolicy: input.toolPolicy ?? {},
    guardrails: {
      dailyTokenBudget: input.dailyTokenBudget ?? null,
      dailyLossLimit: input.dailyLossLimit ?? null,
      maxBots: input.maxBots ?? null,
      maxSlippageBps: input.maxSlippageBps ?? null,
    },
    budgets: DEFAULT_RUNTIME_BUDGETS,
  };
}