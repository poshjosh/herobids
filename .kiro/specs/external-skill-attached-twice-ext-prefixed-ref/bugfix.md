# Bugfix Requirements Document

## Introduction

An agent created with an external skills.sh skill (for example `openaidom/skills@job-search`) ends up with that skill attached twice. The create-agent flow submits the UI-layer id `ext:openaidom/skills/job-search`, and the system stores that string, prefix included, as the skill's `source_ref`. The skills installer cannot install that spelling, so the skill is unavailable at agent start. The agent then calls `add_skills` with the real ref, which canonicalizes to `openaidom/skills/job-search`. Because the strings differ, a second skill row (a different deterministic id) and a second assignment are created. The unique index on `source_ref` cannot catch this because it compares exact strings.

The prefix is not stripped when external refs are canonicalized, so the same skill can be stored under several spellings. The impact is duplicate skill rows and assignments per agent, plus a first tick that runs without the skill's instructions.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an agent is created or updated with `skillIds` containing an `ext:`-prefixed external skill id (e.g. `ext:openaidom/skills/job-search`) THEN the system stores a skill row whose `source_ref` and slug include the `ext:` prefix instead of the canonical `owner/repo/skill` form.

1.2 WHEN the same external skill is later supplied as `openaidom/skills/job-search` or `openaidom/skills@job-search` THEN the system derives a different skill id and creates a second skill row, because the `ext:`-prefixed spelling is not recognized as the same ref.

1.3 WHEN an agent whose external skill is stored with an `ext:`-prefixed `source_ref` starts THEN the system passes that ref to the skills installer, the install fails ("External skill install failed — skill unavailable this session"), and the first tick runs without the skill's instructions.

1.4 WHEN the agent recovers by calling `add_skills` with the real ref THEN the system attaches a second skill row and a second assignment for the same skill, so the agent detail lists the skill twice.

1.5 WHEN the agent's `add_skills` call updates the agent's assignments THEN the system rewrites the assignment source of the already-attached, user-selected skill to `agent_self`, losing its original provenance.

1.6 WHEN `ext:`-prefixed skill rows already exist from earlier agent creation THEN the system keeps them alongside the canonical rows, with no merge or cleanup.

### Expected Behavior (Correct)

2.1 WHEN an agent is created or updated with `skillIds` containing an `ext:`-prefixed external skill id THEN the system SHALL canonicalize it to `owner/repo/skill` before resolving or persisting, so no stored `source_ref` or slug contains the `ext:` prefix.

2.2 WHEN the same external skill is supplied as `ext:o/r/s`, `o/r/s` or `o/r@s` THEN the system SHALL resolve all three spellings to one skill row (one skill id) and one assignment.

2.3 WHEN an agent whose external skill was selected at creation starts THEN the system SHALL install it using a valid skills.sh ref, so the skill is available on the first tick without the agent calling `add_skills`.

2.4 WHEN the agent calls `add_skills` for an external skill that is already attached under any spelling THEN the system SHALL NOT create a second skill row or a second assignment.

2.5 WHEN `add_skills` updates the agent's assignments THEN the system SHALL preserve the assignment source of assignments that already existed and apply `agent_self` only to newly added skills.

2.6 WHEN `ext:`-prefixed skill rows already exist THEN the system SHALL provide a data migration that rewrites them to the canonical ref, merges them with any existing canonical row for the same skill, and repoints agent assignments so no agent is left with duplicate assignments for one skill.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an external skill is supplied in canonical `owner/repo/skill` form or CLI `owner/repo@skill` form THEN the system SHALL CONTINUE TO resolve it to the same skill id as today, so existing canonical rows and assignments are unaffected.

3.2 WHEN a platform skill is supplied by slug, legacy id, or `system/*` slug THEN the system SHALL CONTINUE TO resolve it as a platform skill and not treat it as an external ref.

3.3 WHEN a two-segment `author/name` marketplace slug is supplied THEN the system SHALL CONTINUE TO resolve it against the catalog and not treat it as an installable external ref.

3.4 WHEN an unknown, never-catalogued external ref is supplied at agent creation THEN the system SHALL CONTINUE TO create a placeholder metadata row and never block agent creation.

3.5 WHEN an unknown non-ref id or slug is supplied THEN the system SHALL CONTINUE TO reject the request with a 400 `validation_error` listing the unknown skills.

3.6 WHEN the skills list is requested THEN the system SHALL CONTINUE TO return external skills with `ext:`-prefixed view ids and `owner/repo@skill` slugs (the prefix remains a UI-layer id only).

3.7 WHEN a backend-approved external ref is catalogued at API startup THEN the system SHALL CONTINUE TO store it under its canonical ref with its operator-declared capability families.

3.8 WHEN `add_skills`, `read_skill` or `load_skill` is given a canonical or `owner/repo@skill` ref THEN the system SHALL CONTINUE TO install, read and load it as before.

3.9 WHEN an external skill is attached once through any path THEN the system SHALL CONTINUE TO store exactly one assignment with the existing revision pinning.
