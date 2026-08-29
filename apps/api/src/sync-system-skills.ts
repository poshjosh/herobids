import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { SYSTEM_SKILLS } from '@herobids/domain';
import type { SkillDefinition } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { skillRevisions, skills as skillsTable } from '@herobids/db';

/**
 * Compute a deterministic SHA-256 hash of a skill's canonical content fields.
 * This is used for immutable append-only comparison — if the hash hasn't changed,
 * no new revision is created.
 */
function computeSkillContentHash(skill: SkillDefinition): string {
  const content = {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    promptHint: skill.promptHint ?? null,
    promptTemplate: skill.promptTemplate ?? null,
    requiredTools: [...(skill.requiredTools ?? [])].sort(),
    contextRequirements: [...(skill.contextRequirements ?? [])].sort(),
    requiredGuardrails: [...(skill.requiredGuardrails ?? [])].sort(),
    capabilityFamilies: [...(skill.capabilityFamilies ?? [])].sort(),
    suggestedTickIntervalMs: skill.suggestedTickIntervalMs ?? null,
    tags: [], // system skills never have user tags
  };
  const json = JSON.stringify(content, Object.keys(content).sort());
  return createHash('sha256').update(json, 'utf-8').digest('hex');
}

/**
 * Compute content hash from a revision row's content fields (for comparison).
 */
function computeRevisionContentHash(rev: {
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
  tags: string[];
}): string {
  const content = {
    name: rev.name,
    description: rev.description,
    instructions: rev.instructions,
    promptHint: rev.promptHint ?? null,
    promptTemplate: rev.promptTemplate ?? null,
    requiredTools: [...rev.requiredTools].sort(),
    contextRequirements: [...rev.contextRequirements].sort(),
    requiredGuardrails: [...rev.requiredGuardrails].sort(),
    capabilityFamilies: [...rev.capabilityFamilies].sort(),
    suggestedTickIntervalMs: rev.suggestedTickIntervalMs ?? null,
    tags: [...rev.tags].sort(),
  };
  const json = JSON.stringify(content, Object.keys(content).sort());
  return createHash('sha256').update(json, 'utf-8').digest('hex');
}

/**
 * Upsert all platform-owned system skills with an append-only revision protocol.
 *
 * Protocol:
 * 1. Take pg_advisory_xact_lock before lookup/insert.
 * 2. Row-lock existing skill with FOR UPDATE.
 * 3. Compare SHA-256 content hash of incoming skill vs current revision.
 * 4. If hash matches, skip the skill (no change).
 * 5. If changed: allocate MAX(version) + 1, INSERT new immutable revision,
 *    advance currentRevisionId and publishedRevisionId pointers.
 * 6. NEVER update a revision row in place.
 */
export async function syncSystemSkills(db: Database): Promise<void> {
  const now = new Date();

  for (const skill of SYSTEM_SKILLS) {
    await db.transaction(async (tx) => {
      const skillId = skill.id;

      // 1. Advisory lock to serialise concurrent syncs for this skill
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('sync_system_skill:' || ${skillId}))`,
      );

      // 2. Lock existing skill row
      const existingSkills = await tx
        .select({ id: skillsTable.id, currentRevisionId: skillsTable.currentRevisionId })
        .from(skillsTable)
        .where(eq(skillsTable.id, skillId))
        .for('update')
        .limit(1);

      const existingSkill = existingSkills[0] ?? null;

      // 3. Compute content hash of incoming skill definition
      const incomingHash = computeSkillContentHash(skill);

      // 4. If skill already exists, compare hash against current revision
      if (existingSkill?.currentRevisionId) {
        const latestRev = await tx
          .select({
            id: skillRevisions.id,
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
            tags: skillRevisions.tags,
          })
          .from(skillRevisions)
          .where(eq(skillRevisions.id, existingSkill.currentRevisionId))
          .limit(1);

        if (latestRev.length > 0) {
          const existingHash = computeRevisionContentHash(latestRev[0]!);
          if (existingHash === incomingHash) {
            // Content hasn't changed — nothing to do
            return;
          }
        }
      }

      // 5. Allocate next version
      const maxVersionResult = await tx
        .select({ max: sql<number>`COALESCE(MAX(version), 0)` })
        .from(skillRevisions)
        .where(eq(skillRevisions.skillId, skillId));
      const nextVersion = (maxVersionResult[0]?.max ?? 0) + 1;
      const revisionId = `${skillId}:system:${nextVersion}`;

      // 6. Upsert skills table entry FIRST (without FK columns to avoid circular dependency with skill_revisions)
      //    skill_revisions.skill_id → skills.id AND skills.published_revision_id → skill_revisions.id
      //    form a circular FK. We insert skills with null revision pointers, then insert the revision,
      //    then update skills to set the revision pointers.
      const slug = skill.slug ?? `system/${skillId}`;

      if (existingSkill) {
        await tx
          .update(skillsTable)
          .set({
            slug,
            publicationStatus: 'published',
            publishedAt: now,
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
            delistedAt: null,
            archivedAt: null,
            updatedAt: now,
          })
          .where(eq(skillsTable.id, skillId));
      } else {
        await tx.insert(skillsTable).values({
          id: skillId,
          authorId: null,
          slug,
          publicationStatus: 'published',
          publishedAt: now,
          // FK pointers set to null initially — patched in step 8 after revision is inserted
          currentRevisionId: null,
          publishedRevisionId: null,
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
          delistedAt: null,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      // 7. Insert immutable revision — now that the parent skills row exists
      await tx.insert(skillRevisions).values({
        id: revisionId,
        skillId,
        version: nextVersion,
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
        changeSummary: `system seed (hash: ${incomingHash.slice(0, 8)})`,
        createdByUserId: null,
        publishedAt: now,
        createdAt: now,
      });

      // 8. Patch skills revision pointers now that the revision row exists
      await tx
        .update(skillsTable)
        .set({
          currentRevisionId: revisionId,
          publishedRevisionId: revisionId,
        })
        .where(eq(skillsTable.id, skillId));
    });
  }
}