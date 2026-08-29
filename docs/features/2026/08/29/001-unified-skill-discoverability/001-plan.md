# Unified Skill Discoverability — Implementation Plan

**Status:** Ready for implementation
**Scope:** `search_skills` tool (local platform catalog + skills.sh discovery flow), `list_skills` response hint, BASE_SKILL instruction update, derived skill dependency surfacing in tool responses and skill views
**Parent:** `docs/features/2026/08/28/002-dynamic-skill-management/001-plan.md`

---

## Problem

Agents have no implicit awareness that external skills exist. The current BASE_SKILL instructions tell agents about `list_skills`, `add_skills`, and `remove_skills`, all of which operate on the internal platform catalog. External skills are only practically accessible if:

1. The agent already has the "External Skills Manager" skill assigned, or
2. The user explicitly tells the agent to use that flow.

Without either, agents that need a capability outside the platform catalog fall back to ad hoc web browsing, manual repository inspection, or simply give up.

There is a second usability gap: skill dependencies are implicit. A skill may rely on tools that are primarily provided by another platform skill, but that relationship is not surfaced anywhere. The result is avoidable dead ends where an agent successfully adds instructions yet still lacks the platform tools those instructions assume.

---

## Resolved Questions

### Should base-skill agents discover external skills without the programming skill?

Yes. Discovery should be available from BASE_SKILL. The agent should be able to learn that an external skill exists before it decides whether it needs to add `programming` or any other platform skill.

### Do we keep our own external registry or mirrored catalog?

No. Herobids does not maintain a separate external catalog for this feature. External discovery uses the standard skills.sh discovery flow directly.

### Does discovery also install external skills?

No. Discovery and installation remain separate:

1. `search_skills` tells the agent what exists.
2. The agent decides what to do next.
3. If it wants to install an external skill, it may need to add `programming` and then use `execute_code` with the documented skills.sh workflow.

---

## Solution

Four changes:

1. **`search_skills` tool** — a new BASE_SKILL tool that searches both the local platform catalog and the standard skills.sh discovery flow (`npx skills find ...`). It returns unified results with clear source labels.

2. **`list_skills` response hint** — when `list_skills` returns results, include a hint pointing the agent toward `search_skills` when the capability it needs is not in the platform catalog.

3. **BASE_SKILL instruction update** — add guidance that `search_skills` can discover both platform skills and external skills, while keeping installation as a separate step.

4. **Derived dependency surfacing** — infer skill dependencies from `requiredTools` at read time and surface them in `list_skills`, `search_skills`, `add_skills`, and API skill views. Do not persist `dependsOn` in the database.

---

## Design Constraints

### No Herobids-managed external catalog

This feature does not introduce a new external registry service, cache, or mirrored table inside Herobids.

**Decision:** The external arm uses skills.sh's existing discovery procedure directly. Herobids only brokers the query and returns the result.

### Use the standard skills.sh discovery flow

The desired external behavior is the same workflow described in `docs/agents/skills/external-skills-manager.md`:

```bash
npx skills find <keywords>
```

**Decision:** `search_skills` wraps this procedure as a first-class tool so base-skill agents can discover external skills without first needing the External Skills Manager skill.

### Discovery is not installation

External discovery should not imply that the agent can immediately install or use an external skill.

**Decision:** `search_skills` only surfaces results. Installation remains a separate action. If the agent needs CLI-based installation, it can add `programming` and then use `execute_code` with the documented skills.sh flow.

### Fixed-purpose subprocess, not general code execution

The worker needs to invoke skills.sh without exposing arbitrary command execution to BASE_SKILL.

**Decision:** `search_skills` runs a fixed command only:

1. Use `spawn` or `execFile`, not shell-interpolated `exec`.
2. Invoke `npx` with explicit argv, for example `['skills', 'find', ...tokens]`.
3. Sanitize and tokenize the query before it becomes argv.
4. Keep cwd, env, stdin, timeout, and output limits server-controlled.

This preserves the skill/runtime boundary while still allowing first-class discovery.

### Interactive mode suppression

The skills.sh CLI may prefer interactive output when attached to a TTY.

**Decision:** Force non-interactive execution with both:

1. `CI=1`
2. `stdio: ['ignore', 'pipe', 'pipe']`

This avoids hanging the worker on a selector UI.

### External output is text, not a stable JSON contract

The skills.sh output is human-readable text and may evolve.

**Decision:** Return the external results as bounded text in the `external` section of the response instead of building a fragile parser.

### Graceful degradation

External search may fail because of network issues, CLI availability, or timeouts.

**Decision:**

1. Always return local results when available.
2. Treat the external arm as best-effort.
3. Include an informational note when the external arm is unavailable.
4. Do not fail the whole tool call solely because the external arm failed.

`search_skills` remains in the existing tool catalog as a `read-database` tool even though it has a best-effort external discovery arm.

### Dependency data is derived, not persisted

`dependsOn` is deterministic from `requiredTools` plus a tool ownership map.

**Decision:** Compute it at read time for:

1. worker `skillOps`
2. `list_skills` and `search_skills` responses
3. `add_skills` unmet dependency surfacing
4. API skill views

This avoids schema changes, write-path drift, and stale stored dependency data.

### Shared-tool ownership must be explicit

Some tools are listed in more than one skill, especially trading-related read tools.

**Decision:** dependency inference uses an explicit ownership-precedence helper rather than repurposing `SYSTEM_SKILLS` array order as a side effect. Shared tools such as `get_analytics`, `list_positions`, `get_price`, and `adjust_risk_limits` should resolve to `trading` as the canonical provider.

### No auto-resolution of dependencies

The system should report missing dependencies, not silently add them.

**Decision:** `add_skills` reports unmet dependencies for the newly-added skills. The agent decides whether to add them.

---

## Step 1 — Domain: add `search_skills` to `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG` [PENDING]

**File:** `packages/domain/src/tools.ts`

**Changes:**

1. Add `'search_skills'` to `KNOWN_AGENT_TOOL_NAMES`.
2. Add a `TOOL_CATALOG` entry describing the tool as skill discovery across the local catalog and skills.sh.

**Depends on:** Nothing.

---

## Step 2 — Domain: add `search_skills` to `BASE_SKILL` and update instructions [PENDING]

**File:** `packages/domain/src/skills.ts`

**Changes:**

1. Add `'search_skills'` to `BASE_SKILL.requiredTools`.
2. Replace the current skill-management lines with guidance like:

```text
- Use `list_skills` to see what skills you have and what platform skills are available to add.
- Use `search_skills` to find skills by keyword. It searches both the platform catalog and the standard skills.sh discovery flow.
- Use `add_skills` to adopt platform skills. The response may tell you about dependency skills you should also add.
- Use `remove_skills` to drop skills you no longer need.
- External skills are instruction bundles. Discovering them does not install them. If you need to install one, you may first need the `programming` skill so you can use `execute_code` with the documented skills.sh workflow.
```

**Depends on:** Step 1.

---

## Step 3 — Domain: extend `skillOps` with `search` and derived dependency metadata [PENDING]

**File:** `packages/domain/src/tools.ts`

**Changes:**

Extend the `skillOps` interface so worker-side skill responses can include derived dependency information and a local search method:

```typescript
skillOps?: {
  listAssigned(): Promise<Array<{ id: string; name: string; description: string; dependsOn: string[] }>>;
  listAvailable(): Promise<Array<{ id: string; name: string; description: string; dependsOn: string[] }>>;
  search(query: string, limit?: number): Promise<Array<{
    id: string;
    name: string;
    description: string;
    isAssigned: boolean;
    dependsOn: string[];
  }>>;
};
```

**Depends on:** Nothing.

---

## Step 4 — Domain: add read-time dependency inference helpers [PENDING]

**File:** `packages/domain/src/skills.ts`

**Changes:**

Add a helper layer that derives dependency skill IDs from `requiredTools` without changing database shape:

1. `buildToolOwnershipMap()` for canonical tool owner lookup.
2. `inferDependsOn(requiredTools, selfSkillId)` for derived dependency IDs.
3. An explicit precedence or override mechanism for shared tools so `trading` stays the canonical owner for shared trading tools.

Example shape:

```typescript
const TOOL_OWNER_OVERRIDES: Readonly<Record<string, string>> = {
  get_analytics: 'trading',
  list_positions: 'trading',
  get_price: 'trading',
  adjust_risk_limits: 'trading',
};
```

The helper should:

1. Exclude BASE_SKILL tools.
2. Exclude the skill itself.
3. Return a deduplicated, sorted list.

**Depends on:** Nothing.

---

## Step 5 — API: derive `dependsOn` in skill views [PENDING]

**File:** `apps/api/src/routes/skills.ts`

**Changes:**

1. Add `dependsOn: string[]` to the `SkillView` type.
2. In `buildSkillViews()`, derive `dependsOn` from the effective `requiredTools` for each row instead of reading from the database.
3. Keep create, patch, publish, and fork write paths unchanged with respect to storage. They do not need to persist dependency data.

This keeps API responses current without introducing write-time or migration complexity.

**Depends on:** Step 4.

---

## Step 6 — Frontend: display derived dependencies on skill cards [PENDING]

**Files:**
- `apps/web/src/lib/api-client.ts`
- `apps/web/src/features/skills/SkillsPage.tsx`

**Changes:**

1. Add `dependsOn: string[]` to the frontend `Skill` type.
2. Render read-only dependency pills on skill cards when present.
3. Keep create/edit forms unchanged because `dependsOn` is not user-authored input.

**Depends on:** Step 5.

---

## Step 7 — Worker: wire `skillOps.search` and derive dependency data in runtime skill queries [PENDING]

**File:** `apps/worker/src/agent.ts`

**Changes:**

Update the `skillOps` closure to:

1. Include `dependsOn` in `listAssigned()`.
2. Include `dependsOn` in `listAvailable()`.
3. Add `search(query, limit)` for local platform-skill search.

Implementation notes:

1. Derive `dependsOn` from each row's effective `requiredTools` using the domain helper.
2. Exclude the `base` skill from visible results.
3. Keep the local search limited to published free skills.
4. Fix tag matching correctly. Do not use `ILIKE ANY(tags)` in the reversed direction. Use an array-aware predicate such as `EXISTS (SELECT 1 FROM unnest(tags) tag WHERE tag ILIKE pattern)`.

**Depends on:** Steps 3, 4.

---

## Step 8 — Worker: implement `search_skills` with local search + skills.sh discovery [PENDING]

**File:** `apps/worker/src/tools/skills.ts`

**Changes:**

Add a new `search_skills` tool that:

1. Accepts a text query.
2. Runs local platform search through `ctx.skillOps.search()`.
3. Runs the standard skills.sh discovery flow through a fixed-purpose subprocess.
4. Returns both results in one response.

### External execution shape

Use a dedicated helper similar to:

```typescript
spawn('npx', ['skills', 'find', ...tokens], {
  cwd: getWorkspacePaths(ctx.agentId).root,
  env: { ...process.env, CI: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Unless a second caller emerges, this helper should live alongside the worker skill tools rather than being extracted into a broader shared subprocess abstraction.

### Requirements

1. Do not route discovery through `execute_code`.
2. Do not use shell interpolation.
3. Apply a timeout.
4. Bound stdout/stderr size.
5. Return raw external text output, lightly wrapped with source metadata.
6. If the CLI is unavailable or the network fails, return local results plus an informational note.

### Response shape

```json
{
  "local": {
    "results": [
      {
        "id": "trading",
        "name": "Trading",
        "description": "Submit trade decisions and inspect trading state.",
        "isAssigned": false,
        "dependsOn": []
      }
    ]
  },
  "external": {
    "results": "...raw skills.sh output..."
  }
}
```

**Depends on:** Steps 1, 3, 7.

---

## Step 9 — Worker: add discovery hint to `list_skills` [PENDING]

**File:** `apps/worker/src/tools/skills.ts`

**Changes:**

Update the `list_skills` success response to include:

```text
For capabilities not listed here, use search_skills to search both platform skills and external skills discoverable through skills.sh.
```

**Depends on:** Nothing.

---

## Step 10 — Worker: enrich `add_skills` response with unmet dependencies [PENDING]

**File:** `apps/worker/src/tools/skills.ts`

**Changes:**

After `onSkillsChanged()` succeeds, compute unmet dependencies for newly-added skills by inspecting derived `dependsOn` values from `ctx.skillOps.listAssigned()`.

Example:

```json
{
  "added": ["bot-management"],
  "activeSkills": ["bot-management"],
  "missingDependencies": [
    { "skillId": "trading", "requiredBy": "bot-management" }
  ]
}
```

The tool should report this data, not auto-add the dependency.

**Depends on:** Step 7.

---

## Step 11 — Worker: capability policy and runtime degradation wiring [PENDING]

**Files:**
- `apps/worker/src/agents/capability-policy.ts`
- `apps/worker/src/runtime-tool-visibility.ts`

**Changes:**

1. Add a direct capability grant for `search_skills` with limits similar to other bounded network/read tools.
2. Include `search_skills` in the DB-dependent tool degradation set, because the local arm depends on the skills table.

Even though the external arm is best-effort, the tool should disappear when DB-backed skill discovery is degraded, consistent with other skill-management tools.

**Depends on:** Step 8.

---

## Step 12 — Tests [PENDING]

### Domain

**Files:**
- `packages/domain/src/tools.test.ts`
- `packages/domain/src/skills.test.ts`

Add coverage for:

1. `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG` including `search_skills`.
2. `BASE_SKILL.requiredTools` including `search_skills`.
3. `buildToolOwnershipMap()` excluding BASE_SKILL tools.
4. `inferDependsOn()` deriving canonical dependencies for shared trading tools.
5. Shared-tool ownership overrides or precedence working as intended.

### Worker tool tests

**File:** `apps/worker/src/tools/skills.test.ts`

Add coverage for:

1. `search_skills` returns local results when `skillOps.search` is wired.
2. `search_skills` returns local results plus an external note when the skills.sh subprocess fails.
3. `search_skills` returns both local and external results when both succeed.
4. query sanitization/tokenization for subprocess argv.
5. timeout and output-cap behavior.
6. `list_skills` includes the discovery hint.
7. `list_skills` includes derived `dependsOn`.
8. `add_skills` includes `missingDependencies` when needed.

### Worker runtime tests

**Files:**
- `apps/worker/src/agents/capability-policy.test.ts`
- worker tests covering runtime tool visibility

Add coverage for:

1. `search_skills` default capability grant.
2. rate-limit enforcement.
3. DB degradation hiding `search_skills` from the visible tool set.

### API and frontend tests

Add or extend coverage for:

1. `SkillView` including derived `dependsOn`.
2. skills page rendering dependency pills when present.

### Integration verification

Validate the main flows:

1. agent calls `search_skills({ query: 'trading' })` and receives local results plus best-effort skills.sh output.
2. agent adds `bot-management` and sees `missingDependencies` pointing to `trading`.
3. agent without `programming` can still discover an external skill.
4. agent that wants to install an external skill can add `programming` and then follow the existing skills.sh install flow.

---

## Implementation Order

```text
Step 1  — Domain: add search_skills to known tools and catalog
Step 2  — Domain: update BASE_SKILL instructions
Step 3  — Domain: extend skillOps interface
Step 4  — Domain: add dependency inference helpers
Step 5  — API: derive dependsOn in skill views
Step 6  — Frontend: render dependency pills
Step 7  — Worker: wire skillOps search + derived dependencies
Step 8  — Worker: implement search_skills
Step 9  — Worker: add list_skills hint
Step 10 — Worker: surface missing dependencies in add_skills
Step 11 — Worker: capability + degradation wiring
Step 12 — Tests
```

Parallelizable groups:

- **Group A (domain):** Steps 1, 2, 3, 4
- **Group B (API/frontend):** Steps 5, 6 after Group A
- **Group C (worker):** Steps 7, 8, 9, 10, 11 after Group A
- **Group D (tests):** Step 12 after the relevant implementation slices land

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **skills.sh output format changes** | Return bounded raw text rather than depending on a fragile parser. |
| **CLI missing in the runtime image** | Treat the external arm as best-effort and return local results plus an informational note. |
| **Interactive CLI hangs** | Force non-interactive execution with `CI=1` and ignored stdin. |
| **Shell injection or malformed command construction** | Use `spawn`/`execFile` with explicit argv and sanitized tokens, not shell interpolation. |
| **External search latency** | Apply a timeout and run local + external search in parallel. |
| **Oversized external output** | Cap captured output before returning it to the model context. |
| **Tool ownership ambiguity** | Use explicit shared-tool ownership precedence for dependency inference. |
| **Dependency drift across write paths** | Do not persist `dependsOn`; derive it at read time everywhere it is surfaced. |
| **Feature scope drift into external installation** | Keep `search_skills` limited to discovery. Installation stays on the existing `programming` + `execute_code` path. |
