-- WP7 (D8) — Remove the `task-management` system skill.
--
-- Task and reminder tools moved into the auto-injected `base` skill, so the
-- standalone `task-management` system skill is gone from SYSTEM_SKILLS and will
-- no longer be re-seeded by syncSystemSkills. This drops its persisted rows.
--
-- FK ordering (verified against packages/db/src/schema/):
--   agent_skills.skill_id        → skills.id  ON DELETE restrict  (delete first)
--   skill_usage_events.skill_id  → skills.id  ON DELETE restrict  (delete first)
--   skill_revisions.skill_id     → skills.id  ON DELETE cascade
--   skill_likes.skill_id         → skills.id  ON DELETE cascade
--   skill_entitlements.skill_id  → skills.id  ON DELETE cascade
-- Delete the two restrict-side children explicitly; the cascade children follow
-- automatically when the skills row is removed. skill_usage_events and
-- skill_revisions are also linked (restrict), so revisions are removed last of
-- the children, before the skills row. IF the row is absent (greenfield DB where
-- it was never seeded) every statement is a harmless no-op.
DELETE FROM "agent_skills" WHERE "skill_id" = 'task-management';
--> statement-breakpoint
DELETE FROM "skill_usage_events" WHERE "skill_id" = 'task-management';
--> statement-breakpoint
DELETE FROM "skill_revisions" WHERE "skill_id" = 'task-management';
--> statement-breakpoint
DELETE FROM "skills" WHERE "id" = 'task-management';
