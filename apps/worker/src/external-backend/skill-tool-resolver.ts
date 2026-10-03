// Generic, trust-gated skill-tool resolver (Step 12 T3.2).
//
// This is the composition that replaces every hard-coded trading branch in the
// tool-visibility path. It names NO backend: it iterates the registry and matches
// a skill's declared `sourceRef` against each entry's `approvedSourceSkillRefs`.
// On a match it runs the pure Step 10 §3 trust pipeline (`resolveDescriptorTools`,
// domain, untouched) over the backend's signed descriptor. The trust logic stays
// in domain; this module only wires registry → descriptor → pipeline and maps the
// outcome onto the skill surface.
//
// Outcomes (DT3):
//  - `tools_exposed`  → the matched skill exposes the descriptor's tools.
//  - `instruction_only` → any trust failure (or an absent/undefined descriptor)
//                       degrades the skill to instructions-only, no tools.
//  - `no_match`       → the skill has no `sourceRef` or none approved anywhere;
//                       it is an ordinary platform skill (resolve as today).
// Never throws.
import {
  getToolCatalogEntry,
  type ExternalBackendDescriptorSource,
  type SkillDefinition,
} from '@herobids/domain';
import {
  resolveDescriptorTools,
  type DescriptorTool,
  type DescriptorTrustFailureReason,
  type DescriptorTrustPolicy,
  type DescriptorWrapper,
} from '@herobids/domain/external-backend';

/**
 * A `category` the descriptor declares that disagrees with the registered
 * `TOOL_CATALOG` entry is a consistency failure (Decision 3 / DT4): the
 * descriptor is the sole schema authority, so a divergent category is a trust
 * defect, not a silent catalog mutation. Namespaced like the Step 10 reasons but
 * worker-local — it is a cross-check this composition owns, not a §3 pipeline step.
 */
export type SkillToolResolution =
  | { outcome: 'tools_exposed'; backendId: string; tools: DescriptorTool[] }
  | { outcome: 'instruction_only'; backendId: string; reason: DescriptorTrustFailureReason | 'descriptor.category_mismatch' }
  | { outcome: 'no_match' };

export interface SkillToolMatch {
  skill: Pick<SkillDefinition, 'id' | 'sourceRef'>;
  registry: readonly DescriptorTrustPolicy[];
  now: Date;
}

/** The registry entry whose approved refs contain `sourceRef`, or undefined. */
function matchBackend(
  registry: readonly DescriptorTrustPolicy[],
  sourceRef: string,
): DescriptorTrustPolicy | undefined {
  return registry.find((definition) => definition.approvedSourceSkillRefs.includes(sourceRef));
}

/**
 * Cross-check each exposed descriptor tool's `category` against its `TOOL_CATALOG`
 * entry (Decision 3). An unknown tool name has no catalog entry to disagree with,
 * so it is left to the registry/visibility layer; only a present-but-divergent
 * category is a defect.
 */
function firstCategoryMismatch(tools: readonly DescriptorTool[]): DescriptorTool | undefined {
  return tools.find((tool) => {
    const catalogEntry = getToolCatalogEntry(tool.name);
    return catalogEntry !== undefined && catalogEntry.category !== tool.category;
  });
}

/**
 * The matched backend for a skill, or `undefined` when the skill does not map to
 * any registered backend (→ `no_match`, resolve as an ordinary platform skill).
 */
export function matchSkillBackend(
  skill: Pick<SkillDefinition, 'sourceRef'>,
  registry: readonly DescriptorTrustPolicy[],
): DescriptorTrustPolicy | undefined {
  if (skill.sourceRef === undefined) return undefined;
  return matchBackend(registry, skill.sourceRef);
}

/**
 * Synchronous core: given the already-fetched descriptor wrapper (or `undefined`)
 * for a matched backend, run the trust pipeline + category cross-check. Separated
 * so a synchronous descriptor source (the dev stub) can drive resolution without
 * forcing an async boundary at the composition root.
 */
export function resolveMatchedSkillTools(input: {
  sourceRef: string;
  definition: DescriptorTrustPolicy;
  wrapper: DescriptorWrapper | undefined;
  now: Date;
}): Exclude<SkillToolResolution, { outcome: 'no_match' }> {
  const { sourceRef, definition, wrapper, now } = input;
  if (wrapper === undefined) {
    // No descriptor available for a matched backend → degrade (DT3). Reuse the
    // disabled reason: an unresolvable source is operationally a disabled backend.
    return { outcome: 'instruction_only', backendId: definition.backendId, reason: 'definition.disabled' };
  }

  const result = resolveDescriptorTools({ definition, wrapper, installedSkillRef: sourceRef, now });
  if (result.outcome === 'instruction_only') {
    return { outcome: 'instruction_only', backendId: definition.backendId, reason: result.reason };
  }

  const mismatch = firstCategoryMismatch(result.tools);
  if (mismatch !== undefined) {
    return { outcome: 'instruction_only', backendId: definition.backendId, reason: 'descriptor.category_mismatch' };
  }

  return { outcome: 'tools_exposed', backendId: definition.backendId, tools: result.tools };
}

/**
 * Full composition over the descriptor-source port. Fetches the descriptor for a
 * matched backend (the port may be sync or async) then delegates to the sync core.
 */
export async function resolveSkillTools(input: {
  skill: Pick<SkillDefinition, 'id' | 'sourceRef'>;
  registry: readonly DescriptorTrustPolicy[];
  descriptorSource: ExternalBackendDescriptorSource;
  now: Date;
}): Promise<SkillToolResolution> {
  const { skill, registry, descriptorSource, now } = input;
  const definition = matchSkillBackend(skill, registry);
  if (definition === undefined || skill.sourceRef === undefined) return { outcome: 'no_match' };

  const wrapper = await descriptorSource.getDescriptor(definition.backendId);
  return resolveMatchedSkillTools({ sourceRef: skill.sourceRef, definition, wrapper, now });
}
