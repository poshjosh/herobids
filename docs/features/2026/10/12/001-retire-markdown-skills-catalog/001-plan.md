# Plan — Retire the `docs/agents/skills/` markdown catalog in favour of the external GitHub registry

Status: pending
Owner: (unassigned)
Created: 2026-09-06

## 1. Goal

Stop seeding "extra" (non-crucial, non-system) skills from `docs/agents/skills/*.md`. Instead, agents discover and load those skills exclusively through the **external skill path** (the same `npx skills` / `ExternalSkillProvider` mechanism used for skills.sh), sourced from the public GitHub repo **`openaidom/skills`** — with our own published skills **preferred** in search results.

Retire and delete the markdown files, remove the seeding step, and clean up the docs/tests that reference them.

**Explicit non-goal:** touching the in-built **system skills** (`packages/domain/src/skills.ts` → `SYSTEM_SKILLS`: base, trading, web-access, file-management, etc.). Those are crucial, code-seeded, and stay exactly as they are.

## 2. Background — how it works today (verified)

There are two independent seeding paths; only one touches the markdown files.

| Path | Source | Seeded by | DB fingerprint |
|------|--------|-----------|----------------|
| **System skills** (crucial) | `SYSTEM_SKILLS` in `packages/domain/src/skills.ts` | `apps/api/src/sync-system-skills.ts` + `scripts/ts/upsert-system-skills.ts` (code-sourced, no markdown) | `authorId = null`, `publicationStatus = 'published'`, slug `system/*` |
| **Markdown catalog skills** (to retire) | `docs/agents/skills/*.md` | `scripts/shell/ops/quick-setup.sh` + `quick-setup-remote.sh` (parse frontmatter, `POST /skills`) | `authorId = <setup user>`, `publicationStatus = 'draft'` |
| **External skills** (the target) | skills.sh / GitHub repos | Fetched live via `ExternalSkillProviderHttp`; installed via `npx skills` CLI | Not persisted in `skills` table; live in agent workspace `.agents/skills/` |

Key findings:

- **No TypeScript/runtime code reads `docs/agents/skills/*.md`.** Only the two shell setup scripts do (`SKILLS_DIR="$REPO_ROOT/docs/agents/skills"`).
- `ensure_all_skills()` in `quick-setup.sh` already **degrades gracefully** if the directory is missing (logs a warning, returns 0).
- Markdown skills are POSTed as **`draft`**, and local `search_skills` only returns `publicationStatus = 'published'` rows — so their runtime exposure via `search_skills` is already minimal/nil unless separately published.
- `search_skills` (`apps/worker/src/tools/skills.ts`) returns two buckets: `local` (DB catalog via `ctx.skillOps.search`) and `external` (via `ctx.externalSkillProvider.search`). There is **no cross-bucket ranking** and **no first-party preference** today.
- External search is served by `ExternalSkillProviderHttp` (`packages/domain/src/external-skill-provider-http.ts`) against `searchApiBaseUrl` (default `https://skills.sh`), mapping results to `ExternalSkillSummary` which already carries `owner` and `repo`.
- `add_skills`/`remove_skills` route `owner/repo` (or `owner/repo@skill`) refs to the external CLI; auto-attach `system/file-management`, and `system/programming` when a `SKILL.md` declares `Bash(` in `allowed-tools`.
- `SourceKind` (`system|user|external`) is a **domain type only** — there is no `source_kind` column. System vs markdown rows are distinguished by `authorId` and publication status.

### The four published skills (already live in `openaidom/skills`)
`lost-or-stolen-item-finder`, `flight-deal-monitoring`, `raw-text-to-bitwarden-csv-converter`, `ai4trade-trading-signals`.

### Files being retired (markdown originals)
- `ai4trade-trading-signals.md`
- `flight-deal-monitoring.md`
- `raw-text-to-bitwarden-csv-converter.md`
- `personal-property-locator-tools.md`
- `external-skills-manager.md` — this is the resolution plumbing; not published, and its capability is already covered by the built-in skill tools. Retire from the markdown catalog.
- `personal-property-locator-generic.md` — now **in scope** for retirement (previously kept back). It is superseded by the published `openaidom/skills` version `lost-or-stolen-item-finder`. Delete it with the others.

Net effect: **all six** markdown files under `docs/agents/skills/` are retired and deleted; the directory is emptied and removed.

## 3. What breaks if we do nothing else (verified)

Nothing at runtime; system and external skills are unaffected. The only losses are:
- Fresh setups no longer seed the retired skills into the local catalog (already `draft`, so little/no `search_skills` exposure).
- Docs (`skill-authoring.md`, `CHANGELOG.md`) go stale.

## 4. Decisions (resolved)

1. **First-party preference — soft.** Our results rank first in `search_skills`; the agent still chooses. No auto-add/hard override.
2. **"Ours" identified by a fixed owner handle from config** — `openaidom`, matching `ExternalSkillSummary.owner === firstPartyOwner`. No hardcoded literal (AGENTS.md rule).
3. **Add `openaidom/skills` as an explicit first-party source** so preference works immediately, independent of skills.sh indexing lag. This expands Phase 3 (see design there).
4. **No cleanup migration — starting afresh.** Existing `draft` rows from prior setups are not migrated or deleted; fresh DBs simply never seed the retired skills, and any dev DB can be re-provisioned clean. No backward-compatibility burden.
5. **Pre-check confirmed:** grep blueprints, agent seed data, and product prompts for references to the retired skills before deletion (Phase 0).

## 5. Implementation phases

### Phase 0 — Pre-checks
Decisions in §4 are resolved. Before deleting anything, grep the repo for references to the retired skill slugs/IDs/names in: blueprints (`apps/api/src/services/blueprint-*`), agent seed data, and product prompts (`.ignore/product/prompts/`). Record any dangling references to fix or accept.

### Phase 1 — Stop seeding markdown skills + remove dead script code (low risk)

Both `scripts/shell/ops/quick-setup.sh` and `quick-setup-remote.sh` contain a self-contained markdown-seeding block that becomes fully dead once seeding stops. Remove it entirely (not just the call site), in both scripts:

**`quick-setup.sh`:**
- Remove the call site `ensure_all_skills` (line ~774).
- Remove the `SKILLS_DIR` var (line ~101).
- Remove the now-unused functions: `parse_frontmatter_field`, `parse_frontmatter_block_scalar`, `parse_frontmatter_list`, `parse_skill_body`, `build_skill_payload_from_file`, `ensure_skill`, `ensure_all_skills` (lines ~350–529).
- Remove the final-summary loop that prints provisioned skills (`for skill_summary in "${PROVISIONED_SKILL_IDS[@]:-}"`, lines ~953–958) and the `PROVISIONED_SKILL_IDS` / `SKILLS_LIST_CACHED` state.

**`quick-setup-remote.sh`:**
- Remove the `--skip-skill` flag entirely: the arg-parse case (lines ~176–179), the `SKIP_SKILL` var (line ~151), and the `if [[ "$SKIP_SKILL" -eq 1 ]] … else ensure_all_skills fi` block (lines ~828–833).
- Remove the same `SKILLS_DIR` var, frontmatter/seeding functions, provisioned-skill summary loop, and associated state as above.
- Update `--help`/usage text if it documents `--skip-skill`.

**Verify:** shellcheck/lint both scripts; dry-run `quick-setup.sh` and confirm it completes with no skill-provisioning step and no references to removed vars/functions.

### Phase 2 — Delete retired markdown files + clean docs (low risk)

**Delete:**
- All six files under `docs/agents/skills/`, then remove the now-empty directory.

**`docs/tech/agents/skill-authoring.md` (the main doc rewrite):**
- Remove the entire "Markdown skills" flow: the `docs/agents/skills/*.md` row in the two-tier table (line ~14), the "Markdown skills" section (`~17` onward), "Adding a new skill" steps, and the "Markdown skills: see existing files in `docs/agents/skills/`" pointer (line ~89).
- Replace with a two-tier model of **System skills (code)** vs **External skills (`openaidom/skills` repo)**: extra/user-facing skills are now authored as standard `SKILL.md` in the external repo, in capability language, with optional `allowed-tools`, and discovered/loaded via the external path. Keep and preserve the system-skill (code) guidance and the "agent prompts go in `docs/agents/prompts/`" note.

**`docs/features/2026/08/29/001-unified-skill-discoverability/001-plan.md`:**
- Update the reference to `docs/agents/skills/external-skills-manager.md` (line ~66) — that file is being deleted. Point to the external-skills workflow doc/section instead, or note it as historical.

**`CHANGELOG.md`:**
- Add an entry under the current release: retired the `docs/agents/skills/` markdown catalog and its setup-script seeding; extra skills now live in the external `openaidom/skills` registry with first-party preference in `search_skills`.
- The two historical entries referencing `docs/agents/skills/` (lines ~92, ~97–98) are past changelog records — leave them as historical fact; do not rewrite history.

### Phase 3 — First-party source + soft preference in `search_skills` (the feature core)

Two parts: (a) make our repo discoverable immediately, and (b) rank it first.

**Config (`packages/domain/src/config/schema.ts`, `externalSkills` block):**
- `firstPartyOwner: string` (default `"openaidom"`) — the owner handle treated as first-party.
- `firstPartySources: string[]` (default `["openaidom/skills"]`) — repos queried directly as a first-party source, so results appear before skills.sh indexes them.
- Values come from config, not hardcoded literals (AGENTS.md rule). Wire through `EXTERNAL_SKILLS_CONFIG_JSON` like the existing external-skills config.

**First-party source (immediate availability — §4 decision 3):**
- Extend the external-skill provider (or add a thin first-party provider alongside `ExternalSkillProviderHttp`) to read the declared `firstPartySources` repos directly — e.g. fetch each repo's `skills/*/SKILL.md` frontmatter (name/description) via the GitHub API/raw content, mapping to `ExternalSkillSummary` with `owner`/`repo` set. Cache briefly (mirror the existing search cache TTL) and degrade gracefully on network failure, matching the current "never throw" contract.
- This makes `openaidom/skills` searchable regardless of skills.sh indexing state. `add_skills openaidom/skills` already works today via the CLI path.

**Soft preference (ranking):**
- In `searchSkillsTool` (`apps/worker/src/tools/skills.ts`), merge first-party-source results with skills.sh results, then **stable-sort** so entries with `owner === firstPartyOwner` come first; within each tier preserve existing order (install count). De-dupe by `ref` in case a repo appears in both the first-party source and skills.sh.
- Tag first-party entries in the tool response (e.g. `firstParty: true`) so the model has an explicit reason to prefer them. The agent still chooses (soft).
- `ExternalSkillSummary.owner` already exists — detecting first-party needs no port/schema change.

**Verification:** unit test that first-party owner results sort before third-party; integration/manual check that `openaidom/skills` appears in `search_skills` output ranked first.

### Phase 4 — Verify round-trip
- `npx skills add openaidom/skills` in an agent workspace; confirm install + `SKILL.md` read.
- Confirm `search_skills` surfaces the repo (once indexed or via first-party source) with our results ranked first.
- Confirm `add_skills` auto-attaches `system/file-management` and (for `allowed-tools: Bash`) `system/programming`.

## 6. Testing

- `pnpm lint` and `pnpm test` must pass (existing skill tests don't read the markdown, so they should be unaffected; update any doc-snapshot tests if present).
- Add a unit test for the first-party sort in `search_skills` (Phase 3): "ranks first-party owner results before third-party results".
- Add a test for the first-party source mapping (frontmatter → `ExternalSkillSummary`) and its graceful degradation on fetch failure.
- Shell: dry-run `quick-setup.sh` to confirm removal of the seeding step doesn't error.

## 7. Rollout / safety

- No destructive DB migration — starting afresh (§4 decision 4). Fresh setups simply stop seeding the retired skills.
- Runtime unaffected for system/external skills.
- Reversible: markdown files remain in git history; the seeding loop can be restored if ever needed.
- First-party source fetching must degrade gracefully (never throw), consistent with the existing external-provider contract, so `search_skills` still works if GitHub is unreachable.

## 8. Out of scope

- Any change to `SYSTEM_SKILLS` / built-in skills.
- Any DB migration for already-provisioned databases (we start afresh).
