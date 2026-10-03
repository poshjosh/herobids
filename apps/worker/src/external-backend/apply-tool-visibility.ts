// Applies the generic trust-gated resolver (Step 12 T3.2) to a runtime
// descriptor's resolved skills, rewriting each skill's visible tool surface from
// its backend's signed descriptor. This is the single wiring point that replaces
// the removed hard-coded trading inference in both the DB resolution path and the
// worker fallback: it owns NO backend identity, iterating the registry via the
// resolver.
//
// For a matched skill:
//  - tools_exposed  → `requiredTools` becomes exactly the descriptor's tool names.
//  - instruction_only → `requiredTools` becomes empty (no tools).
// Instructions are PRESERVED in both cases — this applicator only moves the
// visible tool set. (Making the descriptor's instructions authoritative is
// deferred to T4.1, when real descriptors carry distinct instruction content;
// `tools_exposed` does not yet carry an `instructions` field, so that is a
// deliberate follow-up, not a D16 gap: D16 governs tool SCHEMA authority, which
// is already the descriptor's.)
// `capabilityFamilies`, `bindingRequirements`, `requiredContextBlocks`,
// `promptRendererHints` are left untouched — the §6-fence consumers (tick-work,
// readiness, prompt rendering) still read them. Only the VISIBLE TOOL SET moves to
// the descriptor. A skill that matches no backend is returned unchanged.
import type { DescriptorWrapper } from '@herobids/domain/external-backend';
import type { DescriptorTrustPolicy } from '@herobids/domain/external-backend';
import type { SkillDefinition } from '@herobids/domain';
import { matchSkillBackend, resolveMatchedSkillTools, type SkillToolResolution } from './skill-tool-resolver.js';

/** Synchronous descriptor source — the dev stub resolves in-process without I/O. */
export interface SyncDescriptorSource {
  getDescriptor(backendId: string): DescriptorWrapper | undefined;
}

export interface ApplyToolVisibilityInput {
  resolvedSkills: readonly SkillDefinition[];
  registry: readonly DescriptorTrustPolicy[];
  descriptorSource: SyncDescriptorSource;
  now: Date;
}

export interface SkillVisibilityOutcome {
  skillId: string;
  backendId: string;
  outcome: SkillToolResolution['outcome'];
  reason?: string;
}

export interface ApplyToolVisibilityResult {
  resolvedSkills: SkillDefinition[];
  /** One entry per skill that matched a backend (for structured logging / tests). */
  outcomes: SkillVisibilityOutcome[];
}

export function applyDescriptorToolVisibility(input: ApplyToolVisibilityInput): ApplyToolVisibilityResult {
  const { resolvedSkills, registry, descriptorSource, now } = input;
  const outcomes: SkillVisibilityOutcome[] = [];

  const rewritten = resolvedSkills.map((skill) => {
    const definition = matchSkillBackend(skill, registry);
    if (definition === undefined || skill.sourceRef === undefined) return skill;

    const wrapper = descriptorSource.getDescriptor(definition.backendId);
    const resolution = resolveMatchedSkillTools({ sourceRef: skill.sourceRef, definition, wrapper, now });

    if (resolution.outcome === 'tools_exposed') {
      outcomes.push({ skillId: skill.id, backendId: resolution.backendId, outcome: resolution.outcome });
      return {
        ...skill,
        requiredTools: resolution.tools.map((tool) => tool.name),
      };
    }
    // instruction_only: expose the skill's instructions, no tools (DT3).
    outcomes.push({
      skillId: skill.id,
      backendId: resolution.backendId,
      outcome: resolution.outcome,
      reason: resolution.reason,
    });
    return { ...skill, requiredTools: [] };
  });

  return { resolvedSkills: rewritten, outcomes };
}
