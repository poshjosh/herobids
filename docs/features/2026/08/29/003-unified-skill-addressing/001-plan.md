# Unified Skill Addressing — Implementation Plan

**Status:** Ready for implementation
**Scope:** `author/name` slug addressing for skills, dependency auto-resolution in `add_skills`, external skill install/remove via `add_skills`/`remove_skills`, agent-facing response migration to slug format
**Parent:** `docs/features/2026/08/29/001-unified-skill-discoverability/001-plan.md`

---

## Problem

Three related gaps in the skill system:

1. **No human-readable addressing.** Platform skills are identified by opaque IDs (`trading`, `bot-management`) that happen to be readable for system skills but become UUIDs for user-authored skills. External skills use `owner/repo` (e.g. `twostraws/swiftui-agent-skill`). There is no unified addressing scheme.

2. **Dependency dead ends.** When an agent adds a skill whose tools depend on another skill, `add_skills` reports `missingDependencies` but the agent must make a separate call to resolve them. LLMs are unreliable at multi-step dependency chains.

3. **External skill confusion.** `search_skills` returns both platform and external results, but `add_skills` only accepts platform skill IDs. An agent that tries `add_skills(['twostraws/swiftui-agent-skill'])` gets `"Some selected skills do not exist"` — a confusing dead end after the platform just told it the skill exists.

---

## Solution

Three changes, built in sequence:

1. **`author/name` slug addressing** — every platform skill gets a derived `slug` (`system/trading`, `alice/my-skill`). The slug is a unique, human-readable identifier computed from the author's username and the skill name. Agent-facing tools (`add_skills`, `remove_skills`, `search_skills`, `list_skills`) accept slugs in addition to IDs, and prefer slugs in all response data.

2. **Dependency auto-resolution** — `add_skills` gains an optional `includeDependencies` parameter. When true, the system resolves and adds dependency skills automatically. When false (default), it reports them as before.

3. **External skill support in `add_skills`/`remove_skills`** — when a slug doesn't match any platform skill, the tools route to the skills.sh CLI (`npx skills add`/`npx skills remove`) as a fixed subprocess. Platform prerequisites (`programming`, `file-management`) are auto-resolved when `includeDependencies` is true.

---

## Design Constraints

### Slug is derived, not stored as primary key

The `skills.id` primary key is unchanged. The slug is either a computed column or a separately maintained indexed column. All existing FK references, broker payloads, runtime descriptors, and frontend selection flows continue to use `id` internally.

**Decision:** Add a `slug` column to the `skills` table with a unique index. Compute it at write time (skill creation, system skill seeding). The resolution layer maps slugs → IDs before hitting existing plumbing.

### Slug format

```
<author_handle>/<skill_name_slug>
```

- **System skills** (`authorId IS NULL`): author handle is `system`. Name slug is the kebab-cased skill name.
  - `system/trading`, `system/bot-management`, `system/programming`, `system/file-management`, `system/web-access`, `system/risk-monitoring`, `system/task-management`, `system/email`, `system/platform-docs`
- **User-authored skills**: author handle is `users.username` (unique, lowercase, canonical). Name slug is a kebab-cased version of the skill name, scoped to the author.
  - `alice/my-custom-strategy`, `bob/sol-momentum`
- **External skills**: use the `owner/repo` format from skills.sh directly. These don't have slugs in the DB — the resolution layer recognizes them by the absence of a DB match.

### Slug uniqueness

`(slug)` is globally unique. Since `username` is unique per user and name slugs are unique per author, the composite is naturally unique. Enforced by a unique index on the `slug` column.

**Decision:** Uniqueness constraint is on `slug` alone (not a composite of `authorId` + name-slug), because the slug column already encodes both.

### Legacy ID acceptance

All agent-facing tools continue to accept legacy IDs (`trading`, `bot-management`, etc.) as input. The resolution layer tries slug lookup first, then falls back to ID lookup. This makes the migration backward-compatible.

**Decision:** The resolution order is: (1) exact slug match, (2) exact `id` match. If a string contains `/`, only slug lookup is attempted. If it doesn't contain `/`, both are tried.

### Agent-facing responses prefer slugs

All tool responses that surface skill identifiers (`list_skills`, `search_skills`, `add_skills`, `remove_skills`) return the `slug` form (`system/trading`) instead of the raw `id` (`trading`). This teaches agents the canonical addressing convention.

**Decision:** Response fields change from `id` to `skill` (the slug), or include both `id` and `skill` during a transition period. The `missingDependencies` field uses `skill` (the slug) and `requiredBy` (the slug), not `skillId`.

### `includeDependencies` defaults to true

Auto-resolution is the default. Agents that want to control exactly which skills are added can set it to false. This matches the common case — most agents want dependencies resolved automatically.

**Decision:** `add_skills` schema gains `includeDependencies: z.boolean().optional().default(true)`. When true, the tool computes the transitive dependency closure before sending to the broker.

### External skill routing is slug-based

When `add_skills` receives a slug that contains `/` and doesn't match any platform skill, it treats it as an external skill reference and routes to `npx skills add <slug>`.

**Decision:** External adds run as a fixed subprocess (same pattern as `search_skills`), not through `execute_code`. The agent doesn't need the `programming` skill to add external skills — the platform handles it.

### External skills auto-resolve `file-management`

External skills are instruction bundles. The agent needs `read_file`/`list_files` to read them after installation. When `includeDependencies` is true and the target is external, the system auto-adds `file-management` if not already assigned.

**Decision:** `programming` is NOT auto-resolved — external skill installation via `add_skills` doesn't go through `execute_code`. `file-management` IS auto-resolved because the agent structurally cannot use the installed instructions without it.

### `remove_skills` for external skills

When the slug doesn't match a platform skill, route to `npx skills remove <skill-name>`. The skill name is the portion after the `/` in the slug.

**Decision:** External removal is best-effort. If the CLI fails, the tool returns an informational error. Platform skill removal is unchanged.

---

## Resolved Questions

### Should we change the `skills.id` primary key?

No. The slug is an additional addressing layer. All internal references continue to use `id`. No FK changes, no data migration of existing IDs.

### Should external skills become DB rows?

No. External skills remain filesystem-based instruction bundles. They are not persisted in the `skills` table. The slug format (`owner/repo`) is recognized by the absence of a DB match.

### What happens when an agent calls `add_skills` with a mix of platform and external slugs?

The tool partitions the input: platform slugs go through the broker, external slugs go through the subprocess. Both results are returned in the response. If any platform skill fails validation, the platform portion fails but the external portion can still proceed (and vice versa).

### How does the slug column get populated for existing skills?

A data migration computes slugs for all existing rows. System skills get `system/<kebab-name>`. User skills get `<username>/<kebab-name>`. The seeder (`syncSystemSkills`) is updated to set the slug on upsert.

---

## Step 1 — Schema: add `slug` column to `skills` table — DONE

**Files:**
- New migration file
- `packages/db/src/schema/skills.ts`

**Changes:**

1. Add `slug: text('slug')` column to the `skills` table definition. Initially nullable (migration backfills, then a follow-up makes it NOT NULL).
2. Add a unique index: `index('idx_skills_slug').on(t.slug).unique()`.
3. Migration SQL:
   - `ALTER TABLE skills ADD COLUMN slug TEXT;`
   - Backfill system skills: `UPDATE skills SET slug = 'system/' || LOWER(REPLACE(name, ' ', '-')) WHERE author_id IS NULL;`
   - Backfill user skills: `UPDATE skills SET slug = u.username || '/' || LOWER(REPLACE(skills.name, ' ', '-')) FROM users u WHERE skills.author_id = u.id;`
   - `CREATE UNIQUE INDEX idx_skills_slug ON skills (slug) WHERE slug IS NOT NULL;`
   - Follow-up: `ALTER TABLE skills ALTER COLUMN slug SET NOT NULL;` (after confirming all rows populated).

**Depends on:** Nothing.

---

## Step 2 — Domain: add `slugify` helper and update `SkillDefinition` — DONE

**File:** `packages/domain/src/skills.ts`

**Changes:**

1. Add a `slugify(name: string): string` helper that converts a skill name to a kebab-case slug component: `'Bot Management' → 'bot-management'`, `'Web Access' → 'web-access'`.
2. Add a `buildSkillSlug(authorHandle: string, name: string): string` helper: `buildSkillSlug('system', 'Trading') → 'system/trading'`.
3. Add `slug` to system skill definitions. For system skills, the slug is deterministic: `system/<kebab-id>`. Since system skill IDs are already kebab-case (`trading`, `bot-management`), the slug is `system/${id}`.
4. Export `SYSTEM_SKILL_SLUGS` — a map from slug → skill ID for fast lookup.

**Depends on:** Nothing.

---

## Step 3 — Seeder: populate `slug` on system skill upsert — DONE

**File:** `apps/api/src/sync-system-skills.ts`

**Changes:**

1. Set `slug: 'system/' + skill.id` when inserting or updating system skills.
2. For user-authored skills, the slug is set at creation time (Step 6).

**Depends on:** Steps 1, 2.

---

## Step 4 — Domain: add slug resolution helper — DONE

**File:** `packages/domain/src/skills.ts` or a new `packages/domain/src/skill-resolution.ts`

**Changes:**

Add a `classifySkillRef(ref: string)` function:

```typescript
type SkillRefKind = 'slug' | 'legacy-id' | 'external';

function classifySkillRef(ref: string): { kind: SkillRefKind; slug?: string; id?: string; externalRef?: string } {
  if (ref.includes('/')) {
    // Could be a platform slug (system/trading, alice/my-skill) or external (owner/repo)
    // The caller resolves against the DB; if no match, it's external
    return { kind: 'slug', slug: ref };
  }
  // No slash → legacy ID (trading, bot-management, etc.)
  return { kind: 'legacy-id', id: ref };
}
```

Also add `resolveSkillRefs(refs: string[], db)` that:
1. Partitions refs into slug-like (contains `/`) and legacy-id (no `/`).
2. Queries the DB for slug matches and ID matches.
3. Returns `{ resolved: Map<inputRef, skillId>, unresolved: string[] }`.
4. Unresolved slug-like refs are classified as external.

**Depends on:** Step 2.

---

## Step 5 — DB: add slug-based skill lookup — DONE

**File:** `packages/db/src/skill-assignment.ts`

**Changes:**

1. Add `resolveSkillIdsBySlugOrId(db, refs: string[]): Promise<Map<string, string>>` that queries:
   ```sql
   SELECT id, slug FROM skills WHERE slug = ANY($1) OR id = ANY($1)
   ```
2. Update `resolveSkillAssignmentsForUser` to accept resolved IDs (the caller resolves slugs before calling it — keeps the existing function's contract clean).

**Depends on:** Step 1.

---

## Step 6 — API: set `slug` on skill creation and update — PENDING

**Files:**
- `apps/api/src/routes/skills.ts`
- `apps/api/src/routes/agents.ts`

**Changes:**

1. On skill create (POST `/skills`): compute slug from `users.username` + `slugify(name)`. Validate uniqueness. Store in the `slug` column.
2. On skill update (PATCH `/skills/:id`): if `name` changes, recompute and update the slug. Validate new uniqueness.
3. Include `slug` in `SkillView` response (alongside `id`).
4. On agent create/update: accept slugs in the `skillIds` array. Resolve to IDs before passing to `resolveSkillAssignmentsForUser`.

**Depends on:** Steps 1, 2, 5.

---

## Step 7 — Worker: slug resolution in `skillOps` and skill tools — PENDING

**Files:**
- `apps/worker/src/agent.ts`
- `apps/worker/src/tools/skills.ts`

**Changes:**

### 7a. `skillOps` methods return slugs

Update `listAssigned()`, `listAvailable()`, and `search()` to include `slug` in their return objects. Derive the slug from the joined skills table.

### 7b. `list_skills` returns slugs and includes installed external skills

The response uses `skill` (slug) as the primary identifier. Retain `id` for backward compatibility during transition.

Additionally, `list_skills` runs `npx skills list` as a subprocess to discover installed external skills. The response gains an `external` section (same pattern as `search_skills`):

```json
{
  "assigned": [{ "id": "trading", "skill": "system/trading", "name": "Trading", ... }],
  "available": [{ "id": "programming", "skill": "system/programming", "name": "Programming", ... }],
  "installedExternal": { "results": "...raw npx skills list output..." },
  "hint": "..."
}
```

If the CLI is unavailable or fails, `installedExternal` degrades to `{ "note": "..." }`. Platform results are always returned regardless of external arm status.

### 7c. `add_skills` accepts slugs and supports external skills

1. Add `includeDependencies: z.boolean().optional().default(true)` to `SkillMutationParamsSchema` (or a new `AddSkillsParamsSchema` — `remove_skills` doesn't need it).
2. Before sending to the broker, resolve input refs:
   - Slugs that match platform skills → collect IDs → send to broker (existing path).
   - Slugs with no platform match (external) → route to `npx skills add <ref>` subprocess.
3. When `includeDependencies` is true:
   - After resolving platform skills, compute transitive dependencies via `inferDependsOn`.
   - Add missing dependency IDs to the broker payload.
   - For external skills, auto-add `file-management` if not already assigned.
4. Response uses slugs: `{ added: ['system/bot-management'], autoResolved: [{ skill: 'system/trading', requiredBy: 'system/bot-management' }] }`.

### 7d. `remove_skills` accepts slugs and supports external skills

1. Resolve input refs the same way as `add_skills`.
2. Platform skills → existing broker remove path.
3. External refs → `npx skills remove <name>` subprocess (where name is the portion after `/`).

### 7e. `search_skills` returns slugs

Local results include `slug` as the primary identifier.

**Depends on:** Steps 4, 5, 6.

---

## Step 8 — Worker: external skill install/remove subprocess — PENDING

**File:** `apps/worker/src/tools/skills.ts`

**Changes:**

Add `runExternalSkillInstall(ref: string, cwd: string)`, `runExternalSkillRemove(name: string, cwd: string)`, and `runExternalSkillList(cwd: string)` helpers. Same subprocess pattern as `runExternalSkillSearch`:

```typescript
spawn('npx', ['skills', 'add', ref], {
  cwd,
  env: { ...process.env, CI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 30_000, // installation may take longer than search
});
```

And for remove:
```typescript
spawn('npx', ['skills', 'remove', name], { ... });
```

And for list:
```typescript
spawn('npx', ['skills', 'list'], { ... });
```

All three return `{ ok: true; output: string } | { ok: false; error: string }`.

**Depends on:** Nothing (can be built in parallel with Step 7).

---

## Step 9 — Domain: update `skillOps` interface for slug support — DONE

**File:** `packages/domain/src/tools.ts`

**Changes:**

Update the `skillOps` return types to include `slug`:

```typescript
skillOps?: {
  listAssigned(): Promise<Array<{ id: string; slug: string; name: string; description: string; dependsOn: string[] }>>;
  listAvailable(): Promise<Array<{ id: string; slug: string; name: string; description: string; dependsOn: string[] }>>;
  search(query: string, limit?: number): Promise<Array<{
    id: string;
    slug: string;
    name: string;
    description: string;
    isAssigned: boolean;
    dependsOn: string[];
  }>>;
};
```

The `dependsOn` arrays also switch to slugs (derived from the ownership map + slug lookup).

**Depends on:** Step 2.

---

## Step 10 — Worker: update `ManageAgentSkillsPayload` and broker handler — PENDING

**Files:**
- `packages/domain/src/agent-protocol.ts`
- `apps/worker/src/agents/agent-message-broker.ts`

**Changes:**

The broker continues to receive `skillIds` (resolved IDs, not slugs). The tool layer resolves slugs → IDs before publishing to the broker. No schema change needed for the broker payload.

However, the broker handler's error messages should include slugs for better agent-facing diagnostics. The tool layer can enrich error responses by mapping IDs back to slugs.

**Depends on:** Steps 5, 7.

---

## Step 11 — BASE_SKILL instruction update — PENDING

**File:** `packages/domain/src/skills.ts`

**Changes:**

Update BASE_SKILL instructions to:

```text
- Use `list_skills` to see what skills you have and what platform skills are available to add. Skills are identified by their slug (e.g. system/trading, system/programming).
- Use `search_skills` to find skills by keyword. It searches both the platform catalog and external skills via skills.sh.
- Use `add_skills` to add skills by slug. Dependencies are added automatically unless you set includeDependencies to false. For external skills (e.g. twostraws/swiftui-agent-skill), the platform installs them and adds the file-management skill so you can read the installed instructions.
- Use `remove_skills` to drop skills by slug.
```

**Depends on:** Step 7.

---

## Step 12 — Frontend: display slugs in skill views — PENDING

**Files:**
- `apps/web/src/lib/api-client.ts`
- `apps/web/src/features/skills/SkillsPage.tsx`
- `apps/web/src/features/agents/SkillPicker.tsx`

**Changes:**

1. Add `slug: string` to the frontend `Skill` interface.
2. Display the slug on skill cards (below the name, or as a secondary identifier).
3. The `SkillPicker` can continue to use `id` internally for selection — slugs are a display concern.

**Depends on:** Step 6.

---

## Step 13 — Tests — PENDING

### Domain
- `slugify` and `buildSkillSlug` helpers.
- `classifySkillRef` classification logic.
- `SYSTEM_SKILL_SLUGS` map correctness.
- `inferDependsOn` results expressed as slugs.

### DB
- `resolveSkillIdsBySlugOrId` — slug match, ID match, mixed, no match.
- Migration: existing system skills get correct slugs.
- Unique slug constraint enforcement.

### Worker tools
- `add_skills` accepts slugs and resolves to IDs.
- `add_skills` with `includeDependencies: true` (default) auto-adds dependencies.
- `add_skills` with `includeDependencies: false` reports dependencies without adding them.
- `add_skills` with external slug routes to subprocess.
- `add_skills` with mixed platform + external slugs handles both.
- `remove_skills` accepts slugs.
- `remove_skills` with external slug routes to subprocess.
- `list_skills` returns slugs for platform skills.
- `list_skills` includes `installedExternal` section from `npx skills list`.
- `list_skills` degrades gracefully when external list subprocess fails.
- `search_skills` returns slugs.
- Response format uses `skill` (slug) not `skillId`.

### API
- Skill create sets slug from username + name.
- Skill update with name change updates slug.
- Slug uniqueness enforced on create and update.
- Agent create/update accepts slugs in `skillIds`.

### Frontend
- Skill views display slugs.

---

## Implementation Order

```text
Step 1  — Schema: add slug column and migration
Step 2  — Domain: slugify helper and system skill slugs
Step 3  — Seeder: populate slug on system skill upsert
Step 9  — Domain: update skillOps interface for slug support
Step 4  — Domain: slug resolution helper
Step 5  — DB: slug-based skill lookup
Step 6  — API: set slug on creation/update, include in views
Step 7  — Worker: slug resolution in tools + external routing
Step 8  — Worker: external install/remove subprocess
Step 10 — Worker: broker error enrichment
Step 11 — BASE_SKILL instruction update
Step 12 — Frontend: display slugs
Step 13 — Tests
```

Parallelizable groups:

- **Group A (foundation):** Steps 1, 2, 9
- **Group B (data layer):** Steps 3, 4, 5 after Group A
- **Group C (API):** Step 6 after Group B
- **Group D (worker):** Steps 7, 8, 10, 11 after Group B
- **Group E (frontend):** Step 12 after Group C
- **Group F (tests):** Step 13 after implementation slices land

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **Slug collision on user skill creation** | Uniqueness enforced by DB constraint. API rejects with a clear error. |
| **User renames break slug stability** | Name changes recompute the slug. Agents that cached the old slug get a "not found" error — acceptable since slugs are meant to be looked up, not hardcoded. |
| **External skill install latency** | 30s timeout on subprocess. `add_skills` runs platform and external paths in parallel when possible. |
| **External skill install fails** | Graceful degradation: platform skills succeed even if external fails. Error includes CLI output for diagnostics. |
| **Mixed platform + external in one `add_skills` call** | Partition and handle independently. Response clearly separates platform results from external results. |
| **`includeDependencies` creates unexpected tool visibility** | Auto-resolved skills are reported in `autoResolved` so the agent knows what was added and why. |
| **Slug computation differences between migration and runtime** | Use the same `slugify` function in both the migration SQL and the application code. For the migration, inline the logic in SQL (`LOWER(REPLACE(name, ' ', '-'))`). |
| **`base` skill has no slug** | `BASE_SKILL` is not stored in the DB and is auto-injected. It doesn't need a slug — it's never the target of `add_skills`/`remove_skills`. |

---

## Outstanding Issues

### Step 1 — Schema: add `slug` column to `skills` table

1. **[Medium] Partial unique index WHERE clause is redundant after NOT NULL** — The schema defines `uniqueIndex('idx_skills_slug').on(t.slug).where(sql\`...\`)` but since the column is NOT NULL post-migration, the WHERE clause is dead weight. Consider removing `.where()` from the schema (keep it in migration SQL for the transition window). Update the corresponding test assertion if changed.

2. **[Low] Migration `when` timestamp is a round number** — The journal `when` value `1786200000000` looks synthetic vs other entries' high-precision timestamps. Cosmetic only.

3. **[Low] Backfill only handles single-space separators** — `LOWER(REPLACE(name, ' ', '-'))` doesn't handle double spaces, tabs, etc. Acceptable for backfill since current skill names are clean. The application-level `slugify()` (Step 2) should handle edge cases properly.

### Step 2 — Domain: add `slugify` helper and update `SkillDefinition`

1. **[Medium] `buildSkillSlug` does not normalize the author handle** — `buildSkillSlug('Alice', 'Trading')` produces `Alice/trading`. The author handle is passed through verbatim. Consider adding `.toLowerCase()` for defensive normalization, or adding a JSDoc note that the caller is responsible for passing a lowercase handle.

2. **[Medium] Underscore handling in `slugify`** — `slugify('hello_world')` produces `helloworld` (underscores stripped). Most conventions treat underscores as word separators (`hello-world`). Consider adding `_` to the preserved character set so underscores become hyphens.

3. **[Low] `SYSTEM_SKILL_SLUGS` doesn't include `BASE_SKILL`** — Correct by design (BASE_SKILL is auto-injected). Consider adding a JSDoc note on `SYSTEM_SKILL_SLUGS` explaining the exclusion.

4. **[Low] Missing edge case test for `buildSkillSlug` with empty name** — `buildSkillSlug('system', '')` produces `system/`. Document this behavior with a test.

### Step 3 — Seeder: populate `slug` on system skill upsert

1. **[Medium] Inline slug construction instead of using domain helper** — The seeder computes `` `system/${skillId}` `` inline rather than using `skill.slug!` from the pre-computed domain definition or `buildSkillSlug()`. Works correctly but bypasses the centralized slug construction pipeline.

2. **[Medium] No test for hash-match path leaving a pre-existing null slug untouched** — The "skips update" test verifies no mutations, but doesn't cover the scenario where an existing row has `slug = NULL` and content matches. Not a real bug since Step 1 migration backfills all slugs, but worth documenting.

3. **[Low] `config/default.yaml` plan tier renaming is unrelated** — The diff includes an unrelated config change. Should be committed separately per atomic commit guidelines.

### Step 9 — Domain: update `skillOps` interface for slug support

1. **[Low] Comments reference stale "enterprise" tier name** — `packages/domain/src/config/schema.ts` and `apps/worker/src/agents/agent-runtime-launcher.ts` comments still reference "enterprise" as an example tier after config renamed it to "pro". Cosmetic only.

### Step 4 — Domain: add slug resolution helper

1. **[Medium] `SkillRefKind` includes `'external'` but `ClassifiedSkillRef` never produces it** — The type declares `'slug' | 'legacy-id' | 'external'` but the pure classifier only returns slug or legacy-id. External is determined post-DB-resolution. Consider removing `'external'` from `SkillRefKind` and introducing a broader union type when the DB layer is added.

2. **[Low] `partitionSkillRefs` duplicates `classifySkillRef` logic** — Both re-implement `ref.includes('/')` check. Consider implementing `partitionSkillRefs` in terms of `classifySkillRef` to keep source of truth singular.

### Step 5 — DB: add slug-based skill lookup

1. **[Medium] `unique.includes()` is O(n) per row** — Use a Set for O(1) lookup instead of linear array scan. Keep the array for the `inArray()` SQL call.

2. **[Low] Missing test: ref matching both slug and ID on the same row** — The precedence test covers different rows but not the same-row case (a no-op but worth documenting).
