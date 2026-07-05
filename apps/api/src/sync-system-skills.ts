import { and, eq } from 'drizzle-orm';
import { SYSTEM_SKILLS } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { skillRevisions, skills as skillsTable } from '@herobids/db';

/**
 * Upsert all platform-owned system skills so the database copy stays aligned
 * with the in-memory domain definitions.
 */
export async function syncSystemSkills(db: Database): Promise<void> {
  const now = new Date();

  for (const skill of SYSTEM_SKILLS) {
    const [existingRevision] = await db
      .select({ id: skillRevisions.id })
      .from(skillRevisions)
      .where(and(eq(skillRevisions.skillId, skill.id), eq(skillRevisions.version, 1)))
      .limit(1);
    const revisionId = existingRevision?.id ?? `${skill.id}:system:1`;

    await db.insert(skillsTable).values({
      id: skill.id,
      authorId: null,
      publicationStatus: 'published',
      publishedAt: now,
      currentRevisionId: revisionId,
      priceCents: 0,
      autoPublishedByPlan: false,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      promptHint: skill.promptHint ?? null,
      promptTemplate: skill.promptTemplate ?? null,
      requiredTools: skill.requiredTools,
      contextRequirements: skill.contextRequirements,
      requiredGuardrails: skill.requiredGuardrails,
      capabilityFamilies: skill.capabilityFamilies,
      suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
      tags: [],
    }).onConflictDoUpdate({
      target: skillsTable.id,
      set: {
        publicationStatus: 'published',
        publishedAt: now,
        currentRevisionId: revisionId,
        priceCents: 0,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        promptHint: skill.promptHint ?? null,
        promptTemplate: skill.promptTemplate ?? null,
        requiredTools: skill.requiredTools,
        contextRequirements: skill.contextRequirements,
        requiredGuardrails: skill.requiredGuardrails,
        capabilityFamilies: skill.capabilityFamilies,
        suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
        updatedAt: now,
      },
    });

    await db.insert(skillRevisions).values({
      id: revisionId,
      skillId: skill.id,
      version: 1,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      promptHint: skill.promptHint ?? null,
      promptTemplate: skill.promptTemplate ?? null,
      requiredTools: skill.requiredTools,
      contextRequirements: skill.contextRequirements,
      requiredGuardrails: skill.requiredGuardrails,
      capabilityFamilies: skill.capabilityFamilies,
      suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
      tags: [],
      changeSummary: 'system seed',
      createdByUserId: null,
      createdAt: now,
    }).onConflictDoUpdate({
      target: skillRevisions.id,
      set: {
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        promptHint: skill.promptHint ?? null,
        promptTemplate: skill.promptTemplate ?? null,
        requiredTools: skill.requiredTools,
        contextRequirements: skill.contextRequirements,
        requiredGuardrails: skill.requiredGuardrails,
        capabilityFamilies: skill.capabilityFamilies,
        suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
        tags: [],
        changeSummary: 'system seed',
      },
    });
  }
}