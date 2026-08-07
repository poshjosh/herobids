import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, agentSkills, blueprints, blueprintRevisions, blueprintRevisionSkills } from '@herobids/db';
import { ok, err, type Result } from '@herobids/domain';
import { projectAgentToBlueprintPayload } from './blueprint-projection.js';
import { validateSkillPortability } from './blueprint-skill-validator.js';
import { recomputeBlueprintPerformanceScore } from './blueprint-performance-scorer.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentBlueprintSyncError =
  | { code: 'agent.not_found'; message: string }
  | { code: 'agent.not_owned'; message: string }
  | { code: 'blueprint.skill_portability'; message: string }
  | { code: 'blueprint.internal_error'; message: string };

interface SkillRef {
  skillId: string;
  skillRevisionId: string;
}

/**
 * Allowed lifecycle transitions for blueprints.
 * Editing does not itself change lifecycle status.
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['private', 'published', 'archived'],
  private: ['draft', 'published', 'archived'],
  published: ['published', 'delisted', 'archived'],
  delisted: ['published', 'archived'],
  archived: [],
};

function isAllowedTransition(from: string, to: string): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively sort JSON object keys for deterministic serialization.
 * Arrays are returned as-is (element order is meaningful).
 */
function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Build a deterministic SHA-256 fingerprint from a blueprint payload
 * and its ordered skill references.
 */
function buildFingerprint(
  payload: Record<string, unknown>,
  skillRefs: SkillRef[],
): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(payload, sortKeysReplacer));
  for (const ref of skillRefs) {
    hash.update(`|${ref.skillId}:${ref.skillRevisionId}`);
  }
  return hash.digest('hex');
}

/**
 * Extract facets from a projected agent blueprint payload for
 * storing on blueprint / revision rows.
 */
function extractBlueprintFacets(projected: ReturnType<typeof projectAgentToBlueprintPayload>) {
  return {
    name: projected.name,
    description: projected.description,
    tags: projected.tags,
    strategyType: projected.strategy?.type ?? null,
    style: projected.style,
    venueType: null as string | null,
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Ensure the given agent has a published blueprint that matches its current
 * configuration and skill assignments.
 *
 * Callers MUST guarantee single-writer access to the agent (e.g. the agent
 * start flow gates on `stopped → starting`). This avoids TOCTOU races
 * between the initial fingerprint read and the publish transaction.
 *
 * - If the agent has **no** linked blueprint, creates a draft blueprint from the
 *   current agent projection and publishes it immediately.
 * - If the agent **has** a linked blueprint and the fingerprint matches the
 *   current state, re-publishes the existing revision if needed (unchanged).
 * - If the agent **has** a linked blueprint and the fingerprint differs, creates
 *   a new revision on the existing blueprint, publishes it, and updates the
 *   agent's blueprint linkage.
 */
export async function ensurePublishedBlueprintForAgent(
  db: Database,
  agentId: string,
  userId: string,
): Promise<
  Result<
    { blueprintId: string; blueprintRevisionId: string; action: 'created' | 'unchanged' | 'revised' },
    AgentBlueprintSyncError
  >
> {
  try {
    // 1. Load the agent row
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .limit(1);

    if (!agent) {
      // Distinguish not-found vs not-owned for clearer error messages
      const [anyAgent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      if (!anyAgent) {
        return err({ code: 'agent.not_found', message: `Agent ${agentId} not found` });
      }
      return err({
        code: 'agent.not_owned',
        message: `Agent ${agentId} does not belong to user ${userId}`,
      });
    }

    // 2. Load ordered skill references
    const skillRows = await db
      .select({
        skillId: agentSkills.skillId,
        skillRevisionId: agentSkills.skillRevisionId,
      })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))
      .orderBy(agentSkills.orderIndex);

    const skillRefs: SkillRef[] = skillRows.map((s) => ({
      skillId: s.skillId,
      skillRevisionId: s.skillRevisionId,
    }));

    // 3. Project current authored blueprint payload
    const projectedPayload = projectAgentToBlueprintPayload(agent);

    // 4. Build fingerprint of current state
    const currentFingerprint = buildFingerprint(
      projectedPayload,
      skillRefs,
    );

    // 5. No linked blueprint → create + publish
    if (!agent.blueprintId) {
      return createAndPublishBlueprint(
        db,
        agentId,
        userId,
        projectedPayload,
        skillRefs,
      );
    }

    // 6. Linked blueprint exists → compare fingerprints
    return syncExistingBlueprint(
      db,
      agentId,
      userId,
      agent.blueprintId,
      projectedPayload,
      skillRefs,
      currentFingerprint,
    );
  } catch (e) {
    return err({
      code: 'blueprint.internal_error',
      message: e instanceof Error ? e.message : 'Unknown error during blueprint sync',
    });
  }
}

// ── Internal: create blueprint from scratch + publish ────────────────────────

async function createAndPublishBlueprint(
  db: Database,
  agentId: string,
  userId: string,
  projectedPayload: ReturnType<typeof projectAgentToBlueprintPayload>,
  skillRefs: SkillRef[],
): Promise<
  Result<
    { blueprintId: string; blueprintRevisionId: string; action: 'created' },
    AgentBlueprintSyncError
  >
> {
  // Validate skill portability for agent blueprints with skill dependencies
  if (skillRefs.length > 0) {
    const portability = await validateSkillPortability(skillRefs, db);
    if (!portability.valid) {
      return err({
        code: 'blueprint.skill_portability',
        message: portability.errors.join('; '),
      });
    }
  }

  const blueprintId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const now = new Date();
  const facets = extractBlueprintFacets(projectedPayload);

  try {
    await db.transaction(async (tx) => {
      // Insert blueprint WITHOUT currentRevisionId — the composite FK
      // fk_blueprints_current_revision requires the revision row to exist first.
      await tx.insert(blueprints).values({
        id: blueprintId,
        authorId: userId,
        publicationStatus: 'draft',
        kind: 'agent',
        name: facets.name,
        description: facets.description,
        strategyType: facets.strategyType,
        style: facets.style,
        tags: facets.tags,
        venueType: facets.venueType,
        createdAt: now,
        updatedAt: now,
      });

      // Insert revision 1 — satisfies blueprint_revisions.blueprint_id → blueprints.id FK
      await tx.insert(blueprintRevisions).values({
        id: revisionId,
        blueprintId,
        version: 1,
        kind: 'agent',
        name: facets.name,
        description: facets.description,
        strategyType: facets.strategyType,
        style: facets.style,
        tags: facets.tags,
        venueType: facets.venueType,
        payload: projectedPayload,
        changeSummary: 'Auto-generated from agent config on start',
        createdByUserId: userId,
        createdAt: now,
      });

      // Insert skill dependencies
      if (skillRefs.length > 0) {
        await tx.insert(blueprintRevisionSkills).values(
          skillRefs.map((s, i) => ({
            blueprintRevisionId: revisionId,
            skillId: s.skillId,
            skillRevisionId: s.skillRevisionId,
            orderIndex: i,
          })),
        );
      }

      // Now that the revision exists, set currentRevisionId and publish.
      // This satisfies fk_blueprints_current_revision and fk_blueprints_published_revision.
      await tx
        .update(blueprints)
        .set({
          currentRevisionId: revisionId,
          publicationStatus: 'published',
          publishedAt: now,
          publishedRevisionId: revisionId,
          delistedAt: null,
          name: facets.name,
          description: facets.description,
          tags: facets.tags,
          strategyType: facets.strategyType,
          style: facets.style,
          venueType: facets.venueType,
          updatedAt: now,
        })
        .where(eq(blueprints.id, blueprintId));

      // Persist blueprint linkage on the agent row
      await tx
        .update(agents)
        .set({
          blueprintId,
          blueprintRevisionId: revisionId,
          updatedAt: now,
        })
        .where(eq(agents.id, agentId));
    });
  } catch (cause) {
    return err({
      code: 'blueprint.internal_error',
      message: cause instanceof Error ? cause.message : 'Failed to create blueprint',
    });
  }

  // Fire-and-forget: recompute blueprint performance score on new blueprint creation.
  try {
    recomputeBlueprintPerformanceScore(db, blueprintId).catch((err) => {
      console.error('Failed to recompute blueprint performance score on blueprint create', { err, blueprintId });
    });
  } catch {
    // noop
  }

  return ok({ blueprintId, blueprintRevisionId: revisionId, action: 'created' });
}

// ── Internal: sync agent state with existing linked blueprint ────────────────

async function syncExistingBlueprint(
  db: Database,
  agentId: string,
  userId: string,
  linkedBlueprintId: string,
  projectedPayload: ReturnType<typeof projectAgentToBlueprintPayload>,
  skillRefs: SkillRef[],
  currentFingerprint: string,
): Promise<
  Result<
    { blueprintId: string; blueprintRevisionId: string; action: 'unchanged' | 'revised' },
    AgentBlueprintSyncError
  >
> {
  // Load linked blueprint
  const [bp] = await db
    .select()
    .from(blueprints)
    .where(eq(blueprints.id, linkedBlueprintId))
    .limit(1);

  if (!bp) {
    return err({
      code: 'blueprint.internal_error',
      message: `Linked blueprint ${linkedBlueprintId} not found`,
    });
  }

  // Defensive: blueprint must be agent-kind
  if (bp.kind !== 'agent') {
    return err({
      code: 'blueprint.internal_error',
      message: `Linked blueprint ${linkedBlueprintId} is not an agent blueprint`,
    });
  }

  const currentRevId = bp.currentRevisionId;
  if (!currentRevId) {
    return err({
      code: 'blueprint.internal_error',
      message: `Blueprint ${linkedBlueprintId} has no current revision`,
    });
  }

  // Load current revision
  const [revision] = await db
    .select()
    .from(blueprintRevisions)
    .where(eq(blueprintRevisions.id, currentRevId))
    .limit(1);

  if (!revision) {
    return err({
      code: 'blueprint.internal_error',
      message: `Revision ${currentRevId} not found`,
    });
  }

  // Load existing skill refs for the current revision
  const existingSkillRows = await db
    .select({
      skillId: blueprintRevisionSkills.skillId,
      skillRevisionId: blueprintRevisionSkills.skillRevisionId,
    })
    .from(blueprintRevisionSkills)
    .where(eq(blueprintRevisionSkills.blueprintRevisionId, currentRevId))
    .orderBy(blueprintRevisionSkills.orderIndex);

  const existingSkillRefs: SkillRef[] = existingSkillRows.map((s) => ({
    skillId: s.skillId,
    skillRevisionId: s.skillRevisionId,
  }));

  // Compute fingerprint of the existing revision
  const existingFingerprint = buildFingerprint(
    revision.payload,
    existingSkillRefs,
  );

  // Fingerprints match — nothing changed
  if (currentFingerprint === existingFingerprint) {
    // Re-publish if the blueprint is not currently published
    if (bp.publicationStatus !== 'published') {
      const republishResult = await republishBlueprint(
        db,
        agentId,
        bp.id,
        bp.publicationStatus,
        currentRevId,
        revision,
      );
      if (!republishResult.ok) {
        return republishResult;
      }
    } else {
      // Already published — ensure agent linkage is up to date
      await db
        .update(agents)
        .set({
          blueprintId: bp.id,
          blueprintRevisionId: currentRevId,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId));
    }
    // Fire-and-forget: recompute blueprint performance score on unchanged blueprint re-publish.
    try {
      recomputeBlueprintPerformanceScore(db, bp.id).catch((err) => {
        console.error('Failed to recompute blueprint performance score on blueprint sync (unchanged)', { err, blueprintId: bp.id });
      });
    } catch {
      // noop
    }

    return ok({
      blueprintId: bp.id,
      blueprintRevisionId: currentRevId,
      action: 'unchanged',
    });
  }

  // Fingerprints differ — create new revision, publish, and update agent linkage
  return createNewRevisionAndPublish(
    db,
    agentId,
    userId,
    bp,
    revision,
    projectedPayload,
    skillRefs,
  );
}

// ── Internal: re-publish an existing revision ────────────────────────────────

async function republishBlueprint(
  db: Database,
  agentId: string,
  blueprintId: string,
  publicationStatus: string,
  expectedCurrentRevisionId: string,
  revision: typeof blueprintRevisions.$inferSelect,
): Promise<Result<void, AgentBlueprintSyncError>> {
  // Check allowed lifecycle transition
  if (!isAllowedTransition(publicationStatus, 'published')) {
    return err({
      code: 'blueprint.internal_error',
      message: `Cannot publish from status "${publicationStatus}"`,
    });
  }

  const publishTime = new Date();

  try {
    await db.transaction(async (tx) => {
      // Validate that the expected revision is still current (guard against races)
      const [current] = await tx
        .select({ currentRevisionId: blueprints.currentRevisionId })
        .from(blueprints)
        .where(eq(blueprints.id, blueprintId))
        .limit(1);

      if (!current || current.currentRevisionId !== expectedCurrentRevisionId) {
        throw new Error(
          `Blueprint ${blueprintId} current revision changed unexpectedly: ` +
            `expected ${expectedCurrentRevisionId}, got ${current?.currentRevisionId ?? 'null'}`,
        );
      }

      await tx
        .update(blueprints)
        .set({
          publicationStatus: 'published',
          publishedAt: publishTime,
          publishedRevisionId: expectedCurrentRevisionId,
          delistedAt: null,
          name: revision.name,
          description: revision.description,
          tags: revision.tags,
          strategyType: revision.strategyType,
          style: revision.style,
          venueType: revision.venueType,
          updatedAt: publishTime,
        })
        .where(eq(blueprints.id, blueprintId));

      // Persist blueprint linkage on the agent row
      await tx
        .update(agents)
        .set({
          blueprintId,
          blueprintRevisionId: expectedCurrentRevisionId,
          updatedAt: publishTime,
        })
        .where(eq(agents.id, agentId));
    });

    return ok(undefined);
  } catch (e) {
    return err({
      code: 'blueprint.internal_error',
      message: e instanceof Error ? e.message : 'Unknown error during republish',
    });
  }
}

// ── Internal: create a new revision, publish it, and update agent linkage ────

async function createNewRevisionAndPublish(
  db: Database,
  agentId: string,
  userId: string,
  bp: typeof blueprints.$inferSelect,
  currentRevision: typeof blueprintRevisions.$inferSelect,
  projectedPayload: ReturnType<typeof projectAgentToBlueprintPayload>,
  skillRefs: SkillRef[],
): Promise<
  Result<
    { blueprintId: string; blueprintRevisionId: string; action: 'revised' },
    AgentBlueprintSyncError
  >
> {
  // Validate skill portability for agent blueprints with skill dependencies
  if (skillRefs.length > 0) {
    const portability = await validateSkillPortability(skillRefs, db);
    if (!portability.valid) {
      return err({
        code: 'blueprint.skill_portability',
        message: portability.errors.join('; '),
      });
    }
  }

  const newRevisionId = crypto.randomUUID();
  const newVersion = currentRevision.version + 1;
  const now = new Date();
  const facets = extractBlueprintFacets(projectedPayload);
  const expectedCurrentRevisionId = bp.currentRevisionId;

  try {
    await db.transaction(async (tx) => {
      // Guard: re-read current revision pointer and assert it hasn't changed
      const [locked] = await tx
        .select({ currentRevisionId: blueprints.currentRevisionId })
        .from(blueprints)
        .where(eq(blueprints.id, bp.id))
        .limit(1);

      if (!locked || locked.currentRevisionId !== expectedCurrentRevisionId) {
        throw new Error(
          `Blueprint ${bp.id} current revision changed unexpectedly: ` +
            `expected ${expectedCurrentRevisionId}, got ${locked?.currentRevisionId ?? 'null'}`,
        );
      }

      // Insert new revision — satisfies blueprint_revisions.blueprint_id → blueprints.id FK
      await tx.insert(blueprintRevisions).values({
        id: newRevisionId,
        blueprintId: bp.id,
        version: newVersion,
        kind: 'agent',
        name: facets.name,
        description: facets.description,
        strategyType: facets.strategyType,
        style: facets.style,
        tags: facets.tags,
        venueType: facets.venueType,
        payload: projectedPayload,
        changeSummary: 'Auto-generated from agent config on start',
        createdByUserId: userId,
        createdAt: now,
      });

      // Copy skill refs to the new revision
      if (skillRefs.length > 0) {
        await tx.insert(blueprintRevisionSkills).values(
          skillRefs.map((s, i) => ({
            blueprintRevisionId: newRevisionId,
            skillId: s.skillId,
            skillRevisionId: s.skillRevisionId,
            orderIndex: i,
          })),
        );
      }

      // Now that the revision exists, advance current revision pointer + publish.
      // This satisfies fk_blueprints_current_revision and fk_blueprints_published_revision.
      await tx
        .update(blueprints)
        .set({
          currentRevisionId: newRevisionId,
          publicationStatus: 'published',
          publishedAt: now,
          publishedRevisionId: newRevisionId,
          delistedAt: null,
          name: facets.name,
          description: facets.description,
          tags: facets.tags,
          strategyType: facets.strategyType,
          style: facets.style,
          venueType: facets.venueType,
          updatedAt: now,
        })
        .where(eq(blueprints.id, bp.id));

      // Update agent blueprint revision pointer
      await tx
        .update(agents)
        .set({
          blueprintRevisionId: newRevisionId,
          updatedAt: now,
        })
        .where(eq(agents.id, agentId));
    });
  } catch (cause) {
    return err({
      code: 'blueprint.internal_error',
      message: cause instanceof Error ? cause.message : 'Failed to create revision',
    });
  }

  // Fire-and-forget: recompute blueprint performance score on blueprint revision.
  try {
    recomputeBlueprintPerformanceScore(db, bp.id).catch((err) => {
      console.error('Failed to recompute blueprint performance score on blueprint revision', { err, blueprintId: bp.id });
    });
  } catch {
    // noop
  }

  return ok({
    blueprintId: bp.id,
    blueprintRevisionId: newRevisionId,
    action: 'revised',
  });
}
