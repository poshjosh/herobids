import { eq } from 'drizzle-orm';
import type { Database } from './index.js';
import { blueprints } from './schema/blueprints.js';
import { blueprintRevisions } from './schema/blueprint-revisions.js';
import { blueprintRevisionSkills } from './schema/blueprint-revision-skills.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CreateBlueprintWithRevisionParams {
  id: string;
  authorId: string;
  revisionId: string;
  payload: Record<string, unknown>;
  kind: string;
  name: string;
  description: string;
  tags: string[];
  strategyType: string | null;
  style: string | null;
  venueType: string | null;
  skills?: Array<{ skillId: string; skillRevisionId: string; orderIndex?: number }>;
  changeSummary?: string | null;
  createdByUserId: string;
}

// ── Repository ────────────────────────────────────────────────────────────────

/**
 * BlueprintRepository — persistent operations for blueprints and their revisions.
 * NOTE: updatedAt must be set explicitly on every UPDATE — it does NOT auto-update.
 * Full implementation in Milestone A3/A4.
 */
export class BlueprintRepository {
  constructor(private readonly db: Database) {}

  /**
   * Create a blueprint with its first revision in a single transaction.
   * Sets currentRevisionId and copies facet columns from the revision payload.
   */
  async createBlueprintWithRevision(
    params: CreateBlueprintWithRevisionParams,
  ): Promise<{ blueprintId: string; revisionId: string }> {
    return await this.db.transaction(async (tx) => {
      // 1. Insert blueprint with null pointers
      await tx.insert(blueprints).values({
        id: params.id,
        authorId: params.authorId,
        publicationStatus: 'draft',
        kind: params.kind,
        name: params.name,
        description: params.description,
        strategyType: params.strategyType,
        style: params.style,
        tags: params.tags,
        venueType: params.venueType,
        currentRevisionId: null, // placeholder, updated below
        publishedRevisionId: null, // placeholder
      });

      // 2. Insert revision (version 1)
      await tx.insert(blueprintRevisions).values({
        id: params.revisionId,
        blueprintId: params.id,
        version: 1,
        kind: params.kind,
        name: params.name,
        description: params.description,
        strategyType: params.strategyType,
        style: params.style,
        tags: params.tags,
        venueType: params.venueType,
        payload: params.payload,
        changeSummary: params.changeSummary ?? null,
        createdByUserId: params.createdByUserId,
      });

      // 3. Insert blueprint_revision_skills if agent kind
      if (params.skills && params.skills.length > 0) {
        await tx.insert(blueprintRevisionSkills).values(
          params.skills.map((s, i) => ({
            blueprintRevisionId: params.revisionId,
            skillId: s.skillId,
            skillRevisionId: s.skillRevisionId,
            orderIndex: s.orderIndex ?? i,
          })),
        );
      }

      // 4. Update blueprint with currentRevisionId
      await tx
        .update(blueprints)
        .set({ currentRevisionId: params.revisionId })
        .where(eq(blueprints.id, params.id));

      return { blueprintId: params.id, revisionId: params.revisionId };
    });
  }
}
