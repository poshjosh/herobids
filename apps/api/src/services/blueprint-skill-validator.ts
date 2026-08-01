import { and, eq } from 'drizzle-orm';
import type { BlueprintSkillRef } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { skills, skillRevisions } from '@herobids/db';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillPortabilityResult {
  valid: boolean;
  errors: string[];
}

// ── Validator ────────────────────────────────────────────────────────────────

/**
 * Validate that every skill reference in a blueprint can be pinned at the
 * given revision for Phase 1 portability.
 *
 * Phase 1 portability permits only:
 *   a) system skills with an installable pinned revision, or
 *   b) published, free user skills whose pinned revision belongs to that
 *      published skill.
 *
 * Private, draft, delisted, archived, and paid skill dependencies are rejected.
 * The revision must belong to the skill (composite FK checked at query time)
 * and must have been previously published (publishedAt non-null).
 */
export async function validateSkillPortability(
  skillRefs: BlueprintSkillRef[],
  db: Database,
): Promise<SkillPortabilityResult> {
  const errors: string[] = [];

  if (skillRefs.length === 0) {
    return { valid: true, errors: [] };
  }

  // Deduplicate by (skillId, skillRevisionId)
  const seen = new Set<string>();
  const unique = skillRefs.filter((ref) => {
    const key = `${ref.skillId}:${ref.skillRevisionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const ref of unique) {
    // Resolve the skill and its revision in one query, verifying the revision
    // belongs to the skill via the composite join.
    const [row] = await db
      .select({
        skillId: skills.id,
        authorId: skills.authorId,
        publicationStatus: skills.publicationStatus,
        priceCents: skills.priceCents,
        revisionId: skillRevisions.id,
        revisionPublishedAt: skillRevisions.publishedAt,
      })
      .from(skills)
      .innerJoin(skillRevisions, and(
        eq(skillRevisions.skillId, skills.id),
        eq(skillRevisions.id, ref.skillRevisionId),
      ))
      .where(eq(skills.id, ref.skillId))
      .limit(1);

    if (!row) {
      errors.push(
        `Skill "${ref.skillId}" revision "${ref.skillRevisionId}" not found or revision does not belong to skill`,
      );
      continue;
    }

    // Revision must have been published (installable)
    if (row.revisionPublishedAt === null) {
      errors.push(
        `Skill "${ref.skillId}" revision "${ref.skillRevisionId}" has never been published`,
      );
    }

    // Skill must be published
    if (row.publicationStatus !== 'published') {
      errors.push(
        `Skill "${ref.skillId}" is not published (status: ${row.publicationStatus})`,
      );
    }

    // Must be free
    if (row.priceCents !== 0) {
      errors.push(
        `Skill "${ref.skillId}" is not free (price: ${row.priceCents} cents) — paid skills are not portable in Phase 1`,
      );
    }

    // System skills (authorId null) are always portable when published + free
    if (row.authorId !== null) {
      // User-authored skills: must be published AND free (already checked above)
      // Additional check: the pinned revision must be the published revision
      // (i.e., we don't allow pinning an old revision of a user skill unless
      // it was previously published — which is already checked via publishedAt)
      // No additional checks needed beyond what's above.
    }
  }

  return { valid: errors.length === 0, errors };
}
