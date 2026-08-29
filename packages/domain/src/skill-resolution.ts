// ── Skill ref classification ────────────────────────────────────────────────
//
// Pure helpers that classify skill references (slugs, legacy IDs, external)
// without touching the DB.  Used by the DB layer (resolveSkillRefs) and
// worker tools (add_skills / remove_skills) to decide which lookup strategy
// to use for each ref.

/**
 * Discriminator for skill reference kinds produced by the pure classifier.
 *
 * `'external'` is determined post-DB-resolution (when a slug-like ref has no
 * DB match), so it is NOT part of this type.  Downstream code that needs all
 * three variants should define its own union.
 */
export type SkillRefKind = 'slug' | 'legacy-id';

export type ClassifiedSkillRef =
  | { kind: 'slug'; slug: string }
  | { kind: 'legacy-id'; id: string };

/**
 * Classify a single skill reference string.
 *
 * - Contains `/`  → treated as a slug (`system/trading`, `alice/my-skill`,
 *   or potentially an external `owner/repo`).  The caller resolves against
 *   the DB; if no match is found the ref is external.
 * - No `/`        → legacy skill ID (`trading`, `bot-management`, …).
 */
export function classifySkillRef(ref: string): ClassifiedSkillRef {
  if (ref.includes('/')) {
    return { kind: 'slug', slug: ref };
  }
  return { kind: 'legacy-id', id: ref };
}

/** Result of partitioning an array of skill refs by shape. */
export interface PartitionedSkillRefs {
  /** Refs that contain `/` — resolve by slug (or external if no DB match). */
  slugLike: string[];
  /** Refs without `/` — resolve by legacy skill ID. */
  legacyIds: string[];
}

/**
 * Partition an array of skill reference strings into slug-like and legacy-id
 * buckets.  Order within each bucket matches the input order.
 */
export function partitionSkillRefs(refs: readonly string[]): PartitionedSkillRefs {
  const slugLike: string[] = [];
  const legacyIds: string[] = [];

  for (const ref of refs) {
    const classified = classifySkillRef(ref);
    if (classified.kind === 'slug') {
      slugLike.push(ref);
    } else {
      legacyIds.push(ref);
    }
  }

  return { slugLike, legacyIds };
}
