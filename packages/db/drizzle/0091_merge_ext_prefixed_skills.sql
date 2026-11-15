-- Merge `ext:`-prefixed external skills into their canonical `owner/repo/skill` rows.
-- Bug: the UI-layer id `ext:owner/repo/skill` was stored verbatim as skills.source_ref/slug, so one
-- external skill existed under several spellings (and ids), and agents ended up with duplicate assignments.
--
-- One DO block, so the whole merge is atomic. For every legacy row (source_ref LIKE 'ext:%'):
--   1. find the canonical row by source_ref, or create it (id/revision id as externalSkillIdForRef derives them);
--   2. merge agent_skills (canonical row survives, provenance from the legacy row, lowest order_index);
--   3. repoint every other reference at the canonical skill and its current revision;
--   4. delete the legacy row (its revisions cascade).
-- Idempotent: with no `ext:%` rows the loop does nothing. Forward only (no down migration).
-- No schema change. Ordering matters: legacy rows are deleted last so no unique index
-- (uq_skills_source_ref, idx_skills_slug) ever sees two rows with the same value.
DO $$
DECLARE
  legacy RECORD;
  canon_ref text;
  canon_id text;
  canon_rev text;
  legacy_rev text;
BEGIN
  FOR legacy IN
    SELECT id, current_revision_id, source_ref FROM skills WHERE source_ref LIKE 'ext:%' ORDER BY id
  LOOP
    canon_ref := regexp_replace(legacy.source_ref, '^(ext:)+', '');
    legacy_rev := COALESCE(
      legacy.current_revision_id,
      (SELECT r.id FROM skill_revisions r WHERE r.skill_id = legacy.id ORDER BY r.version DESC LIMIT 1)
    );

    -- 1. Find or create the canonical row. Found by source_ref, not by derived id.
    SELECT s.id, s.current_revision_id INTO canon_id, canon_rev FROM skills s WHERE s.source_ref = canon_ref;
    IF NOT FOUND THEN
      canon_id := 'ext_' || substr(encode(sha256(convert_to(canon_ref, 'UTF8')), 'hex'), 1, 24);
      INSERT INTO skills (
        id, author_id, slug, publication_status, published_at, delisted_at, archived_at,
        price_cents, auto_published_by_plan, like_count, fork_count, popularity_score, trending_score,
        source_ref, last_installed_at, name, description, instructions, prompt_hint, prompt_template,
        required_tools, context_requirements, required_guardrails, capability_families,
        suggested_tick_interval_ms, tags, fork_of, created_at, updated_at
      )
      SELECT
        canon_id, l.author_id, canon_ref, l.publication_status, l.published_at, l.delisted_at, l.archived_at,
        l.price_cents, l.auto_published_by_plan, l.like_count, l.fork_count, l.popularity_score, l.trending_score,
        canon_ref, l.last_installed_at, l.name, l.description, l.instructions, l.prompt_hint, l.prompt_template,
        l.required_tools, l.context_requirements, l.required_guardrails, l.capability_families,
        l.suggested_tick_interval_ms, l.tags, l.fork_of, l.created_at, l.updated_at
      FROM skills l WHERE l.id = legacy.id;
    END IF;

    -- The canonical row needs a current revision to pin assignments to. A row created above has none yet.
    IF canon_rev IS NULL THEN
      canon_rev := (SELECT r.id FROM skill_revisions r WHERE r.skill_id = canon_id ORDER BY r.version DESC LIMIT 1);
    END IF;
    IF canon_rev IS NULL THEN
      canon_rev := canon_id || ':external:1';
      INSERT INTO skill_revisions (
        id, skill_id, version, name, description, instructions, prompt_hint, prompt_template,
        required_tools, context_requirements, required_guardrails, capability_families,
        suggested_tick_interval_ms, tags, source_ref, change_summary, created_by_user_id, published_at, created_at
      )
      SELECT
        canon_rev, canon_id, 1, r.name, r.description, r.instructions, r.prompt_hint, r.prompt_template,
        r.required_tools, r.context_requirements, r.required_guardrails, r.capability_families,
        r.suggested_tick_interval_ms, r.tags, canon_ref, r.change_summary, r.created_by_user_id, r.published_at, r.created_at
      FROM skill_revisions r WHERE r.id = legacy_rev;
    END IF;
    UPDATE skills
       SET current_revision_id = COALESCE(current_revision_id, canon_rev),
           published_revision_id = COALESCE(published_revision_id, canon_rev)
     WHERE id = canon_id AND (current_revision_id IS NULL OR published_revision_id IS NULL);

    -- 2. agent_skills. Agents holding both rows: the canonical row survives with the legacy row's
    --    provenance (the legacy row is the creation-time assignment) and the lowest order_index.
    UPDATE agent_skills c
       SET assignment_source = l.assignment_source,
           assigned_at = l.assigned_at,
           assigned_by_user_id = l.assigned_by_user_id,
           order_index = LEAST(c.order_index, l.order_index)
      FROM agent_skills l
     WHERE l.skill_id = legacy.id AND c.skill_id = canon_id AND c.agent_id = l.agent_id;
    DELETE FROM agent_skills l
     USING agent_skills c
     WHERE l.skill_id = legacy.id AND c.skill_id = canon_id AND c.agent_id = l.agent_id;
    -- Agents holding only the legacy row: repoint skill and revision pin together.
    UPDATE agent_skills
       SET skill_id = canon_id, skill_revision_id = canon_rev
     WHERE skill_id = legacy.id;

    -- 3. Other references.
    UPDATE skill_usage_events
       SET skill_id = canon_id, skill_revision_id = canon_rev
     WHERE skill_id = legacy.id;

    -- Blueprint links: drop the legacy link where the revision already links the canonical skill,
    -- then repoint the rest. Both columns change in one statement for the composite fk_bprs_skill_revision.
    DELETE FROM blueprint_revision_skills l
     USING blueprint_revision_skills c
     WHERE l.skill_id = legacy.id AND c.skill_id = canon_id
       AND c.blueprint_revision_id = l.blueprint_revision_id;
    UPDATE blueprint_revision_skills
       SET skill_id = canon_id, skill_revision_id = canon_rev
     WHERE skill_id = legacy.id;

    -- Entitlements and likes are unique per (skill, user): move only what the canonical row lacks;
    -- the leftover duplicates cascade away with the legacy row.
    UPDATE skill_entitlements e
       SET skill_id = canon_id
     WHERE e.skill_id = legacy.id
       AND NOT EXISTS (SELECT 1 FROM skill_entitlements x WHERE x.skill_id = canon_id AND x.user_id = e.user_id);
    IF EXISTS (SELECT 1 FROM skill_likes WHERE skill_id = legacy.id) THEN
      UPDATE skill_likes k
         SET skill_id = canon_id
       WHERE k.skill_id = legacy.id
         AND NOT EXISTS (SELECT 1 FROM skill_likes x WHERE x.skill_id = canon_id AND x.user_id = k.user_id);
      DELETE FROM skill_likes WHERE skill_id = legacy.id;
      UPDATE skills SET like_count = (SELECT count(*) FROM skill_likes WHERE skill_id = canon_id) WHERE id = canon_id;
    END IF;

    UPDATE billing_usage_events SET skill_id = canon_id WHERE skill_id = legacy.id;

    IF EXISTS (SELECT 1 FROM skills WHERE fork_of = legacy.id) THEN
      UPDATE skills SET fork_of = canon_id WHERE fork_of = legacy.id;
      UPDATE skills SET fork_count = (SELECT count(*) FROM skills f WHERE f.fork_of = canon_id) WHERE id = canon_id;
    END IF;

    -- 4. Remove the legacy row; its revisions cascade.
    DELETE FROM skills WHERE id = legacy.id;
  END LOOP;

  IF EXISTS (SELECT 1 FROM skills WHERE source_ref LIKE 'ext:%' OR slug LIKE 'ext:%') THEN
    RAISE EXCEPTION 'ext: skill rows remain after migration 0091';
  END IF;
END
$$;
