// Phase 4 T8 — backend-approved tool visibility over MCP discovery (ADR 017 §3-4,
// D25/D27), replacing the removed signed-descriptor pipeline (D26).
//
// For each resolved skill that carries a `sourceRef` matching the forwarded
// backend's `approvedSourceSkillRefs`, we discover the backend's tools over MCP
// `tools/list` (NOT a committed file), compute the visible set as the tools
// tagged with that ref intersected with the local tool registry, and set the
// skill's `capabilityFamilies` from the backend's single `requiresConnectionFamily`
// (D28). Tool CALLS still go REST (D27) — this module only discovers.
//
// Degradation (EC-11): a backend unreachable at agent start hides the approved
// skills' tools (requiredTools = []) but keeps the skill loadable as text, and
// NEVER throws into agent start. A skill whose ref is not approved, and every
// system/* skill, is returned unchanged.

import {
  ResolvedExternalBackendSchema,
  type ResolvedExternalBackend,
  type SkillDefinition,
} from '@herobids/domain';
import { discoverExternalBackendTools, type DiscoveredBackendTool } from '@herobids/domain/external-backend';

export interface BackendToolVisibilityLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface BuildBackendToolVisibilityInput {
  /** Raw EXTERNAL_BACKEND_CONFIG_JSON (carries the definition + HMAC secret). */
  rawConfigJson: string | undefined;
  resolvedSkills: readonly SkillDefinition[];
  /** Names the local tool registry can actually invoke (intersection target). */
  registryToolNames: ReadonlySet<string>;
  logger: BackendToolVisibilityLogger;
  /**
   * Discovery override for tests (bypasses the real MCP transport). Returns the
   * backend's advertised tools or `null` to simulate an unreachable backend.
   */
  discoverTools?: (resolved: ResolvedExternalBackend) => Promise<DiscoveredBackendTool[] | null>;
}

export interface BackendSkillOutcome {
  skillId: string;
  sourceRef: string;
  outcome: 'tools_exposed' | 'no_tools' | 'backend_unreachable' | 'not_approved';
  toolNames: string[];
}

export interface BackendToolVisibilityResult {
  resolvedSkills: SkillDefinition[];
  outcomes: BackendSkillOutcome[];
}

function parseResolved(
  rawConfigJson: string,
  logger: BackendToolVisibilityLogger,
): ResolvedExternalBackend | undefined {
  let json: unknown;
  try {
    json = JSON.parse(rawConfigJson);
  } catch {
    logger.warn({ reason: 'invalid_json' }, 'Backend tool visibility: could not parse EXTERNAL_BACKEND_CONFIG_JSON');
    return undefined;
  }
  const parsed = ResolvedExternalBackendSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join('.') }));
    logger.warn({ reason: 'invalid_schema', issues }, 'Backend tool visibility: EXTERNAL_BACKEND_CONFIG_JSON failed validation');
    return undefined;
  }
  return parsed.data;
}

/** Default discovery: the backend's MCP `tools/list` (null = unreachable, reason logged). */
async function discoverViaMcp(
  resolved: ResolvedExternalBackend,
  logger: BackendToolVisibilityLogger,
): Promise<DiscoveredBackendTool[] | null> {
  const outcome = await discoverExternalBackendTools(resolved.definition, resolved.hmacSecret);
  if (outcome.kind === 'ok') return outcome.tools;
  logger.warn(
    {
      backendId: resolved.definition.backendId,
      baseUrl: resolved.definition.endpoint.baseUrl,
      mcpPath: resolved.definition.endpoint.mcpPath,
      reason: outcome.message,
    },
    'Backend tool visibility: MCP tools/list discovery failed',
  );
  return null;
}

/**
 * Rewrite `resolvedSkills` so backend-approved external skills expose exactly the
 * backend's tools (tagged with the ref) ∩ the local registry, with the backend's
 * connection family. Discovery runs once per call. Never throws.
 */
export async function buildBackendToolVisibility(
  input: BuildBackendToolVisibilityInput,
): Promise<BackendToolVisibilityResult> {
  const { rawConfigJson, resolvedSkills, registryToolNames, logger } = input;
  const skills = [...resolvedSkills];
  const outcomes: BackendSkillOutcome[] = [];

  const resolved = rawConfigJson ? parseResolved(rawConfigJson, logger) : undefined;

  // No backend forwarded, or no external skills: nothing to resolve.
  const hasExternal = skills.some((s) => typeof s.sourceRef === 'string');
  if (!resolved || !hasExternal) {
    return { resolvedSkills: skills, outcomes };
  }

  const approved = new Set(resolved.definition.approvedSourceSkillRefs);
  const connectionFamily = resolved.definition.requiresConnectionFamily;

  // Discover the backend's tools once — only if at least one assigned external
  // skill is approved by this backend. `null` = unreachable (hide tools).
  const needsDiscovery = skills.some((s) => s.sourceRef && approved.has(s.sourceRef));
  let discovered: DiscoveredBackendTool[] | null = null;
  if (needsDiscovery) {
    try {
      discovered = input.discoverTools
        ? await input.discoverTools(resolved)
        : await discoverViaMcp(resolved, logger);
    } catch (err) {
      logger.warn({ err }, 'Backend tool visibility: tools/list discovery threw — treating backend as unreachable');
      discovered = null;
    }
  }

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i]!;
    const ref = skill.sourceRef;
    if (!ref) continue; // system/* skill — unchanged

    if (!approved.has(ref)) {
      outcomes.push({ skillId: skill.id, sourceRef: ref, outcome: 'not_approved', toolNames: [] });
      continue; // unapproved external skill — loadable text, no tools (unchanged)
    }

    const families = connectionFamily ? [connectionFamily] : [];

    if (discovered === null) {
      // Backend unreachable: hide tools, keep the skill loadable, no crash.
      skills[i] = { ...skill, requiredTools: [], capabilityFamilies: families, ...familyPresentation(families) };
      outcomes.push({ skillId: skill.id, sourceRef: ref, outcome: 'backend_unreachable', toolNames: [] });
      logger.warn({ skillId: skill.id, sourceRef: ref }, 'Backend tool visibility: backend unreachable — approved skill tools hidden this session');
      continue;
    }

    const visible = discovered
      .filter((t) => t.skillRefs.includes(ref) && registryToolNames.has(t.name))
      .map((t) => t.name);

    skills[i] = { ...skill, requiredTools: visible, capabilityFamilies: families, ...familyPresentation(families) };
    outcomes.push({
      skillId: skill.id,
      sourceRef: ref,
      outcome: visible.length > 0 ? 'tools_exposed' : 'no_tools',
      toolNames: visible,
    });
    logger.info({ skillId: skill.id, sourceRef: ref, toolCount: visible.length }, 'Backend tool visibility: approved skill tools resolved from MCP tools/list');
  }

  return { resolvedSkills: skills, outcomes };
}

/**
 * Mirror the family-keyed presentation that `inferSkillFromRevisionRow` applies,
 * so an approved skill that gains a `trading` family also gets its binding
 * requirement, trading context block and prompt hints — exactly as a built-in
 * trading skill did before Phase 4. For a backend with no connection family the
 * skill keeps the plain core presentation.
 */
function familyPresentation(families: string[]): Pick<
  SkillDefinition,
  'bindingRequirements' | 'requiredContextBlocks' | 'promptRendererHints'
> {
  const hasFamily = families.length > 0;
  if (!hasFamily) {
    return {
      bindingRequirements: {},
      requiredContextBlocks: ['corePlatformContext'],
      promptRendererHints: ['core-system'],
    };
  }
  const bindingRequirements: Record<string, { minBindings: number; requireReady: boolean }> = {};
  for (const family of families) {
    bindingRequirements[family] = { minBindings: 1, requireReady: true };
  }
  return {
    bindingRequirements,
    // 'trading' is the only family with a dedicated context block today; the
    // generic path keeps the core block and adds tradingContext when present.
    requiredContextBlocks: ['corePlatformContext', ...(families.includes('trading') ? ['tradingContext'] : [])],
    promptRendererHints: families.includes('trading') ? ['readiness-summary', 'trading'] : ['core-system'],
  };
}
