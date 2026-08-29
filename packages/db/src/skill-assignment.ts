import crypto from 'node:crypto';
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentSkills, skillEntitlements, skillRevisions, skillUsageEvents, skills } from './schema/index.js';

export type SkillAssignmentResolution = {
  skillId: string;
  skillRevisionId: string;
};

export function isSkillSelectableForUser(input: {
  skill: typeof skills.$inferSelect;
  userId: string;
  entitledSkillIds: Set<string>;
  preservedSkillIds?: Set<string>;
  canViewMarketplaceSkills: boolean;
}): boolean {
  if (input.skill.authorId === null) return true;
  if (input.skill.authorId === input.userId) return true;
  if (input.preservedSkillIds?.has(input.skill.id)) return true;
  if (input.entitledSkillIds.has(input.skill.id)) return true;
  return input.canViewMarketplaceSkills && input.skill.publicationStatus === 'published' && input.skill.priceCents === 0;
}

/**
 * Resolve skill references (slugs or legacy IDs) to skill IDs in a single query.
 *
 * The returned map keys each input ref to its resolved skill ID.
 * - For slug matches the key is the slug string.
 * - For ID matches the key is the ID string.
 * - If a ref matches both slug and ID (different rows), the slug match wins.
 * - Refs that match nothing are omitted from the map.
 */
export async function resolveSkillIdsBySlugOrId(
  db: Database,
  refs: string[],
): Promise<Map<string, string>> {
  if (refs.length === 0) return new Map();

  const unique = [...new Set(refs)];

  const rows = await db
    .select({ id: skills.id, slug: skills.slug })
    .from(skills)
    .where(or(inArray(skills.slug, unique), inArray(skills.id, unique)));

  const result = new Map<string, string>();

  // First pass: ID matches (lower priority).
  for (const row of rows) {
    if (unique.includes(row.id)) {
      result.set(row.id, row.id);
    }
  }

  // Second pass: slug matches (higher priority — overwrites if a ref matched
  // both as an ID on one row and a slug on another).
  for (const row of rows) {
    if (row.slug !== null && unique.includes(row.slug)) {
      result.set(row.slug, row.id);
    }
  }

  return result;
}

export async function resolveSkillAssignmentsForUser(
  db: Database,
  userId: string,
  skillIds: string[],
  preservedSkillIds: Set<string> = new Set(),
  canViewMarketplaceSkills = true,
): Promise<{ assignments?: SkillAssignmentResolution[]; error?: { code: string; message: string; details?: unknown } }> {
  if (skillIds.length === 0) {
    return { assignments: [] };
  }

  const uniqueSkillIds = [...new Set(skillIds)];
  const [skillRows, entitlementRows] = await Promise.all([
    db.select().from(skills).where(inArray(skills.id, uniqueSkillIds)),
    db.select({ skillId: skillEntitlements.skillId })
      .from(skillEntitlements)
      .where(and(eq(skillEntitlements.userId, userId), sql`${skillEntitlements.revokedAt} IS NULL`)),
  ]);

  const skillById = new Map(skillRows.map((row) => [row.id, row] as const));
  const missingSkillIds = uniqueSkillIds.filter((skillId) => !skillById.has(skillId));
  if (missingSkillIds.length > 0) {
    return {
      error: {
        code: 'validation_error',
        message: 'Some selected skills do not exist',
        details: [{ code: 'custom', path: ['skillIds'], message: `Unknown skillIds: ${missingSkillIds.join(', ')}` }],
      },
    };
  }

  const entitledSkillIds = new Set(entitlementRows.map((row) => row.skillId));
  const nonSelectable = uniqueSkillIds.filter((skillId) => {
    const skill = skillById.get(skillId)!;
    return !isSkillSelectableForUser({ skill, userId, entitledSkillIds, preservedSkillIds, canViewMarketplaceSkills });
  });

  if (nonSelectable.length > 0) {
    return {
      error: {
        code: 'validation_error',
        message: 'Some selected skills are not selectable for this user',
        details: [{ code: 'custom', path: ['skillIds'], message: `Non-selectable skillIds: ${nonSelectable.join(', ')}` }],
      },
    };
  }

  const revisionRows = await db.select({
    skillId: skillRevisions.skillId,
    revisionId: skillRevisions.id,
    version: skillRevisions.version,
  }).from(skillRevisions).where(inArray(skillRevisions.skillId, uniqueSkillIds));

  const latestRevisionBySkillId = new Map<string, { revisionId: string; version: number }>();
  for (const row of revisionRows) {
    const current = latestRevisionBySkillId.get(row.skillId);
    if (!current || row.version > current.version) {
      latestRevisionBySkillId.set(row.skillId, { revisionId: row.revisionId, version: row.version });
    }
  }

  const assignments: SkillAssignmentResolution[] = [];
  const missingRevisionSkills: string[] = [];
  for (const skillId of uniqueSkillIds) {
    const skill = skillById.get(skillId)!;
    const resolvedRevisionId = skill.currentRevisionId ?? latestRevisionBySkillId.get(skillId)?.revisionId ?? null;
    if (!resolvedRevisionId) {
      missingRevisionSkills.push(skillId);
      continue;
    }
    assignments.push({ skillId, skillRevisionId: resolvedRevisionId });
  }

  if (missingRevisionSkills.length > 0) {
    return {
      error: {
        code: 'invalid_state',
        message: 'Some selected skills do not have revisions',
        details: [{ code: 'custom', path: ['skillIds'], message: `Skills missing revisions: ${missingRevisionSkills.join(', ')}` }],
      },
    };
  }

  return { assignments };
}

export async function syncAgentSkillAssignments(
  db: Database,
  agentId: string,
  userId: string,
  assignments: SkillAssignmentResolution[],
  assignmentSource: 'user_select' | 'guided_setup' | 'blueprint_instantiate' | 'agent_self' = 'user_select',
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const existingRows = await tx.select({
      skillId: agentSkills.skillId,
      skillRevisionId: agentSkills.skillRevisionId,
    }).from(agentSkills).where(eq(agentSkills.agentId, agentId));

    const existingBySkillId = new Map(existingRows.map((row) => [row.skillId, row.skillRevisionId] as const));
    const nextSkillIds = assignments.map((assignment) => assignment.skillId);

    if (nextSkillIds.length === 0) {
      await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
    } else {
      await tx.delete(agentSkills).where(and(
        eq(agentSkills.agentId, agentId),
        notInArray(agentSkills.skillId, nextSkillIds),
      ));
    }

    for (const [orderIndex, assignment] of assignments.entries()) {
      const previousRevisionId = existingBySkillId.get(assignment.skillId);
      await tx.insert(agentSkills).values({
        agentId,
        skillId: assignment.skillId,
        skillRevisionId: assignment.skillRevisionId,
        orderIndex,
        assignedAt: now,
        assignedByUserId: userId,
        assignmentSource,
      }).onConflictDoUpdate({
        target: [agentSkills.agentId, agentSkills.skillId],
        set: {
          skillRevisionId: assignment.skillRevisionId,
          orderIndex,
          assignedAt: now,
          assignedByUserId: userId,
          assignmentSource,
        },
      });

      if (previousRevisionId !== assignment.skillRevisionId) {
        await tx.insert(skillUsageEvents).values({
          id: crypto.randomUUID(),
          skillId: assignment.skillId,
          skillRevisionId: assignment.skillRevisionId,
          userId,
          agentId,
          sessionId: null,
          eventType: 'agent_assigned',
          occurredAt: now,
          metadata: { source: 'agent_update' },
          createdAt: now,
        });
      }
    }
  });
}
