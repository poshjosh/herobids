import { and, eq, asc } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentSkills, agentConnections, connections, skillRevisions, skills } from './schema/index.js';
import {
  BASE_SKILL,
  SYSTEM_SKILLS,
  findUnknownSkillTools,
  getRuntimeFamiliesForProvider,
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

export type RuntimeAssignmentRow = {
  assignmentId: string;
  grantStatus: string;
  grantedAt: Date;
  connectionId: string;
  connectionStatus: string;
  provider: string;
  label: string;
  providerRef: string | null;
  profile: Record<string, unknown> | null;
  resolvedVenueAccountId: string | null;
  capabilities: string[];
};

export function deriveReadiness(row?: RuntimeAssignmentRow, family = 'trading'): CapabilityReadiness {
  if (!row) {
    return {
      family,
      state: 'unconfigured',
      connectionReadiness: 'unconfigured',
      agentEligibility: 'ineligible',
      effectiveReady: false,
      reasons: ['no connections have been assigned for this capability family'],
    };
  }

  if (row.connectionStatus === 'revoked') {
    return {
      family,
      state: 'revoked',
      connectionReadiness: 'revoked',
      agentEligibility: 'ineligible',
      effectiveReady: false,
      connectionId: row.connectionId,
      reasons: ['connection has been revoked'],
    };
  }
  if (row.grantStatus === 'revoked') {
    return {
      family,
      state: 'revoked',
      connectionReadiness: 'ready',
      agentEligibility: 'ineligible',
      effectiveReady: false,
      connectionId: row.connectionId,
      reasons: ['connection assignment has been revoked'],
    };
  }

  // A trading connection with no resolved venue account is not executable.
  if (family === 'trading' && !row.resolvedVenueAccountId) {
    return {
      family,
      state: 'unconfigured',
      connectionReadiness: 'ready',
      agentEligibility: 'ineligible',
      effectiveReady: false,
      connectionId: row.connectionId,
      reasons: ['connection has no resolved venue account — complete trading setup first'],
    };
  }

  return {
    family,
    state: 'ready',
    connectionReadiness: 'ready',
    agentEligibility: 'eligible',
    effectiveReady: true,
    connectionId: row.connectionId,
    reasons: [],
  };
}

export function chooseLatest(rows: RuntimeAssignmentRow[]): RuntimeAssignmentRow | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  return rows.slice().sort((left, right) => {
    const delta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (delta !== 0) {
      return delta;
    }
    return right.assignmentId.localeCompare(left.assignmentId);
  })[0];
}

function chooseDefaultConnectionId(rows: RuntimeAssignmentRow[]): string | null {
  const readyRows = rows.filter((row) => row.grantStatus === 'active' && row.connectionStatus === 'active');
  return chooseLatest(readyRows)?.connectionId ?? chooseLatest(rows)?.connectionId ?? null;
}

function inferSkillFromRevisionRow(row: {
  skillId: string;
  name: string;
  description: string;
  instructions: string;
  promptHint: string | null;
  promptTemplate: string | null;
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
    promptHint: row.promptHint ?? undefined,
    promptTemplate: row.promptTemplate ?? undefined,
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
  grantedConnectionsByFamily: Record<string, RuntimeFamilyBindingDescriptor[]>;
  readinessByFamily: Record<string, CapabilityReadiness>;
  defaultConnectionByFamily: Record<string, string | null>;
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
      promptHint: skillRevisions.promptHint,
      promptTemplate: skillRevisions.promptTemplate,
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

  const connectionRows = await db
    .select({
      assignmentId: agentConnections.id,
      grantStatus: agentConnections.status,
      grantedAt: agentConnections.grantedAt,
      connectionId: connections.id,
      connectionStatus: connections.status,
      provider: connections.provider,
      label: connections.label,
      providerRef: connections.providerRef,
      profile: connections.profile,
      resolvedVenueAccountId: connections.resolvedVenueAccountId,
    })
    .from(agentConnections)
    .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
    .where(and(eq(agentConnections.agentId, agentId), eq(agentConnections.status, 'active')));

  const connectionRowsWithFamilies: Array<typeof connectionRows[number] & { capabilities: string[] }> = connectionRows.map((row) => ({
    ...row,
    capabilities: getRuntimeFamiliesForProvider(row.provider),
  }));

  const grantedConnectionsByFamily: Record<string, RuntimeFamilyBindingDescriptor[]> = {};
  const readinessByFamily: Record<string, CapabilityReadiness> = {};
  const defaultConnectionByFamily: Record<string, string | null> = {};

  // Collect families from both skill definitions and provider capabilities.
  const familiesFromSkills = new Set(resolvedSkills.flatMap((skill) => skill.capabilityFamilies));
  const familiesFromProviders = new Set<string>();
  for (const row of connectionRowsWithFamilies) {
    for (const cap of row.capabilities) {
      familiesFromProviders.add(cap);
    }
  }
  const allFamilies = new Set([...familiesFromSkills, ...familiesFromProviders]);

  for (const family of allFamilies) {
    const familyRows = connectionRowsWithFamilies.filter((row) => row.capabilities.includes(family));
    if (familyRows.length > 0) {
      const defaultConnectionId = chooseDefaultConnectionId(familyRows);
      grantedConnectionsByFamily[family] = familyRows.map((row) => ({
        family,
        connectionId: row.connectionId,
        provider: row.provider,
        label: row.label,
        providerRef: row.providerRef,
        profile: row.profile,
        readiness: deriveReadiness(row, family),
        isDefault: row.connectionId === defaultConnectionId,
      }));
      const defaultRow = familyRows.find((row) => row.connectionId === defaultConnectionId) ?? chooseLatest(familyRows);
      readinessByFamily[family] = deriveReadiness(defaultRow, family);
      defaultConnectionByFamily[family] = defaultConnectionId;
    } else {
      readinessByFamily[family] = {
        family,
        state: 'unconfigured',
        connectionReadiness: 'unconfigured',
        agentEligibility: 'ineligible',
        effectiveReady: false,
        reasons: ['no connections have been assigned for this capability family'],
      };
      grantedConnectionsByFamily[family] = [];
      defaultConnectionByFamily[family] = null;
    }
  }

  return {
    resolvedSkills,
    grantedConnectionsByFamily,
    readinessByFamily,
    defaultConnectionByFamily,
  };
}

export function buildRuntimeDescriptor(input: {
  agentId: string;
  name?: string | null;
  goal: string;
  executionMode?: string | null;
  authorizationMode?: string | null;
  toolPolicy?: Record<string, unknown> | null;
  dailyTokenBudget?: string | null;
  dailyLossLimit?: string | null;
  maxDrawdownPct?: number | null;
  maxBots?: number | null;
  maxOpenPositions?: number | null;
  maxPositionSizePct?: number | null;
  stopLossPct?: number | null;
  capital?: string | null;
  budgets: RuntimeBudgetPolicy;
  capabilityDescriptor: RuntimeCapabilityDescriptor;
}): RuntimeDescriptor {
  return {
    schemaVersion: 'v1',
    agentId: input.agentId,
    name: input.name ?? input.agentId,
    goal: input.goal,
    executionMode: input.executionMode ?? 'paper',
    authorizationMode: input.authorizationMode ?? 'direct',
    resolvedSkills: input.capabilityDescriptor.resolvedSkills,
    grantedConnectionsByFamily: input.capabilityDescriptor.grantedConnectionsByFamily,
    defaultConnectionByFamily: input.capabilityDescriptor.defaultConnectionByFamily,
    readinessByFamily: input.capabilityDescriptor.readinessByFamily,
    toolPolicy: input.toolPolicy ?? {},
    guardrails: {
      dailyTokenBudget: input.dailyTokenBudget ?? 'unlimited tokens',
      dailyLossLimit: input.dailyLossLimit ?? null,
      maxDrawdownPct: input.maxDrawdownPct ?? null,
      maxBots: input.maxBots ?? null,
      maxOpenPositions: input.maxOpenPositions ?? null,
      maxPositionSizePct: input.maxPositionSizePct ?? null,
      stopLossPct: input.stopLossPct ?? null,
      capital: input.capital ?? null,
    },
    budgets: { ...input.budgets },
  };
}