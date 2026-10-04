// Phase 4 T4 — external skills.sh skills are stored as ASSIGNMENT METADATA ONLY
// (ADR 017 §1, D23): a `skills` row carrying `source_ref`, `name`, `description`
// and `last_installed_at`, with NO skill body. The full skill folder is
// installed into the agent workspace at every agent start (T5); the body is
// never persisted. `authorId` stays null (platform-visible, like system skills);
// `sourceKind: 'external'` is DERIVED from `source_ref` being set.

import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Database } from './index.js';
import { skillRevisions, skills } from './schema/index.js';
import { resolveSkillIdsBySlugOrId } from './skill-assignment.js';
import type { SourceKind } from '@herobids/domain';

/**
 * Normalise a skills.sh ref to its canonical three-segment slug form
 * `owner/repo/skill`. Accepts either `owner/repo/skill` or the CLI's
 * `owner/repo@skill` form. Returns the input unchanged if it is not ref-shaped.
 */
export function normalizeSourceRefToSlug(ref: string): string {
  // owner/repo@skill → owner/repo/skill
  const at = ref.indexOf('@');
  if (at >= 0 && ref.slice(0, at).includes('/')) {
    return `${ref.slice(0, at)}/${ref.slice(at + 1)}`;
  }
  return ref;
}

/**
 * The deterministic `skills.id` for an external skill, derived from its
 * canonical `owner/repo/skill` ref so repeated adds collapse to one row and
 * callers can predict the id without a DB round-trip. Pass the slug form.
 */
export function externalSkillIdForRef(sourceRefOrSlug: string): string {
  const slug = normalizeSourceRefToSlug(sourceRefOrSlug);
  return `ext_${crypto.createHash('sha256').update(slug).digest('hex').slice(0, 24)}`;
}

/** Derive the skill's source kind without an identity branch (ADR 017, T4). */
export function deriveSourceKind(row: { sourceRef: string | null; authorId: string | null }): SourceKind {
  if (row.sourceRef !== null) return 'external';
  if (row.authorId === null) return 'system';
  return 'user';
}

export interface ExternalSkillUpsert {
  /** Canonical skills.sh ref, `owner/repo/skill` (D11). */
  sourceRef: string;
  /** Display name — from the installed SKILL.md frontmatter (T5) or catalog. */
  name: string;
  /** Display description — from the frontmatter/catalog; may be empty. */
  description: string;
  /** Set when this upsert follows a successful install (T5). */
  lastInstalledAt?: Date | null;
}

export interface ExternalSkillRow {
  skillId: string;
  skillRevisionId: string;
}

/**
 * A ref is an installable skills.sh ref only in the canonical `owner/repo/skill`
 * three-segment form, or the CLI `owner/repo@skill` form. A two-segment
 * `author/name` is a marketplace skill slug (NOT installable) and must still
 * resolve against the catalog — so it is NOT treated as an external ref here.
 * `system/*` is a platform slug, also excluded.
 */
function isExternalRef(ref: string): boolean {
  if (ref.startsWith('system/')) return false;
  if (ref.includes('@')) {
    // owner/repo@skill
    const [left] = ref.split('@');
    return (left ?? '').split('/').length === 2;
  }
  return ref.split('/').length === 3;
}

/**
 * Phase 4 T6: translate the agent-create `skillIds` list into resolvable skill
 * ids, creating placeholder metadata rows for any skills.sh-shaped ref that is
 * not yet in the catalog. The assignment is recorded now (name = the last ref
 * segment, empty description); the first agent start installs the folder and
 * refreshes name/description from the frontmatter (T5). Agent creation is never
 * blocked by an unknown ref. Non-ref ids (system/user skill ids) pass through
 * unchanged. Returns the input order with each ref replaced by its skill id.
 */
export async function ensureExternalSkillIds(
  db: Database,
  skillIds: readonly string[],
): Promise<string[]> {
  // Resolve everything already known (by slug or id) in one query first, so an
  // already-catalogued ref (installed earlier, or seeded) is reused as-is and we
  // only create a placeholder for a genuinely-unknown skills.sh ref.
  const known = await resolveSkillIdsBySlugOrId(db, [...skillIds]);
  const out: string[] = [];
  for (const idOrRef of skillIds) {
    const resolved = known.get(idOrRef);
    if (resolved) {
      out.push(resolved);
      continue;
    }
    if (!isExternalRef(idOrRef)) {
      // Unknown non-ref id/slug — leave it unresolved so the caller reports it.
      out.push(idOrRef);
      continue;
    }
    const slug = normalizeSourceRefToSlug(idOrRef);
    const lastSegment = slug.split('/').pop() ?? slug;
    const row = await upsertExternalSkill(db, { sourceRef: slug, name: lastSegment, description: '' });
    out.push(row.skillId);
  }
  return out;
}

/**
 * Upsert an external skills.sh skill as a metadata-only catalog row keyed by its
 * `source_ref`, and ensure it has exactly one (metadata-only) revision so the
 * existing assignment machinery (which pins a `skillRevisionId`) can link it.
 * Idempotent: re-running refreshes `name`/`description`/`last_installed_at` and
 * reuses the existing skill + revision. Stores NO skill body (instructions = '').
 */
export async function upsertExternalSkill(
  db: Database,
  input: ExternalSkillUpsert,
): Promise<ExternalSkillRow> {
  const slug = normalizeSourceRefToSlug(input.sourceRef);
  const sourceRef = slug; // store the canonical three-segment form as the ref too
  const now = new Date();

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: skills.id, currentRevisionId: skills.currentRevisionId })
      .from(skills)
      .where(eq(skills.sourceRef, sourceRef))
      .limit(1);

    if (existing[0]) {
      const skillId = existing[0].id;
      await tx
        .update(skills)
        .set({
          name: input.name,
          description: input.description,
          ...(input.lastInstalledAt !== undefined ? { lastInstalledAt: input.lastInstalledAt } : {}),
          updatedAt: now,
        })
        .where(eq(skills.id, skillId));

      // Keep the single metadata revision's name/description in step.
      let revisionId = existing[0].currentRevisionId;
      if (revisionId) {
        await tx
          .update(skillRevisions)
          .set({ name: input.name, description: input.description, sourceRef })
          .where(eq(skillRevisions.id, revisionId));
      } else {
        revisionId = `${skillId}:external:1`;
        await tx.insert(skillRevisions).values({
          id: revisionId,
          skillId,
          version: 1,
          name: input.name,
          description: input.description,
          instructions: '',
          sourceRef,
          publishedAt: now,
          createdAt: now,
        }).onConflictDoNothing();
        await tx.update(skills).set({ currentRevisionId: revisionId, publishedRevisionId: revisionId }).where(eq(skills.id, skillId));
      }
      return { skillId, skillRevisionId: revisionId };
    }

    // New external skill. id is deterministic from the ref so re-adds collapse.
    const skillId = externalSkillIdForRef(sourceRef);
    const revisionId = `${skillId}:external:1`;

    await tx.insert(skills).values({
      id: skillId,
      authorId: null,
      slug,
      publicationStatus: 'published',
      publishedAt: now,
      currentRevisionId: revisionId,
      publishedRevisionId: revisionId,
      sourceRef,
      ...(input.lastInstalledAt !== undefined ? { lastInstalledAt: input.lastInstalledAt } : {}),
      name: input.name,
      description: input.description,
      instructions: '',
      suggestedTickIntervalMs: 900_000,
      tags: sql`'{}'::text[]`,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();

    await tx.insert(skillRevisions).values({
      id: revisionId,
      skillId,
      version: 1,
      name: input.name,
      description: input.description,
      instructions: '',
      sourceRef,
      publishedAt: now,
      createdAt: now,
    }).onConflictDoNothing();

    return { skillId, skillRevisionId: revisionId };
  });
}
