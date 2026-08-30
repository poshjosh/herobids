# Unified Skill Catalog — Implementation Plan

**Status:** Ready for implementation
**Scope:** Merge external skills (skills.sh) into the `GET /skills` API response so the UI displays a single, paginated skill catalog. Add pagination to `GET /skills`. Route all external skill discovery through a self-hosted `@mastra/skills-api` HTTP server. Align the agent `search_skills` tool to use the same HTTP source.
**Parent:** `docs/features/2026/08/29/001-unified-skill-discoverability/001-plan.md`

---

## Problem

The skills UI only shows local skills — system skills, user-authored skills, and marketplace skills stored in PostgreSQL. External skills from the skills.sh ecosystem (600,000+) are invisible to the UI. Users must rely on agents calling `search_skills` to discover external skills, which only agents can do.

This creates two problems:

1. **The UI undersells the platform.** A user browsing skills sees a handful of local skills. The 600k+ external skills ecosystem is hidden behind an agent-only tool.

2. **The UI and agent have different catalogs.** An agent can discover and install external skills via `search_skills` + `add_skills`. A user browsing the skills page cannot. This split will grow more confusing as external skills become the primary catalog.

Additionally, `GET /skills` currently returns all matching rows without pagination. This is already a scaling concern for local skills and becomes untenable when merging external results.

---

## Resolved Questions

### Should the UI distinguish between local and external skills?

No. From the user's perspective there is one catalog. The UI does not label skills as "local" or "external". Internally, the API still tracks `sourceKind` (`system`, `user`, `external`) for routing purposes (e.g. `add_skills` needs to know whether to use the broker or the skills.sh CLI), but this is not surfaced as a user-facing filter dimension.

### Which scopes include external skills?

| UI category | API scope | Includes external? |
|---|---|---|
| All | `selectable` | Yes |
| User (my skills) | `mine` | No |
| Built-in | `selectable` + `sourceKind=system` filter | No |
| Marketplace | `marketplace` | Yes |

### What data source do we use for external skills?

A self-hosted [`@mastra/skills-api`](https://github.com/mastra-ai/skills-api) HTTP server. This serves a browsable registry of 34,000+ skills from 2,800+ repositories with structured JSON, pagination, and total counts. It runs as a lightweight container alongside our existing infra.

**Decision:** Self-hosted HTTP server (Option B). The data source is abstracted behind an `ExternalSkillProvider` port so the implementation can be swapped later (e.g. to the official Vercel-hosted skills.sh API if OIDC auth becomes available).

### What about the existing `npx skills` CLI usage?

The CLI is used today for two distinct purposes:

| Purpose | Current approach | New approach |
|---|---|---|
| **Discovery/search** (`npx skills find`) | Subprocess in `search_skills` agent tool and potentially API | HTTP call to self-hosted `@mastra/skills-api` |
| **Install/remove/list-installed** (`npx skills add/remove/list`) | Subprocess in `add_skills`, `remove_skills`, `list_skills` agent tools | **Unchanged** — these are local filesystem operations (clone repo, copy files, manage workspace). The HTTP API does not handle installation. |

All discovery/search paths are consolidated through the self-hosted API. The CLI remains only for workspace-local operations (install, remove, list-installed).

### Should offset-based pagination work across two sources?

Yes, with documented limitations. Offset-based pagination across two independent data sources has inherent consistency gaps: if the local set changes between page requests, offsets may shift. This is acceptable for an initial implementation. The code must clearly document this limitation.

### Should the total count include external skills?

Yes. The response includes a `totalCount` that sums local and external totals. This is the headline number visible to the user. When the external source is unavailable, `totalCount` reflects only local skills and the response includes a degradation note.

---

## Solution

Four changes:

1. **Self-hosted `@mastra/skills-api`** — deploy as a new container in docker-compose, configured with auto-refresh for fresh data.

2. **Paginated `GET /skills`** — add `page` and `pageSize` query parameters. Return `{ skills, totalCount, page, pageSize }`.

3. **External skill merging** — for `selectable` and `marketplace` scopes, fetch external skills from the self-hosted API and merge them into the paginated response. Local skills appear first; external skills fill remaining page slots.

4. **Unified discovery path** — replace the `npx skills find` subprocess in the agent `search_skills` tool with an HTTP call to the same self-hosted API. All search/browse flows use one source.

---

## Design Constraints

### Local-first ordering

Local skills (system + user-authored + marketplace) always appear before external skills in the merged result set. Rationale: local skills have richer metadata (entitlements, likes, selectability), are more likely to be relevant to the platform's specific domain, and the user may have authored or previously used them.

External skills fill page slots after local results are exhausted. On page 1 with 20 local matches and pageSize=20, external skills do not appear. On page 2, all 20 slots are external.

### Merged pagination model

```
Given:
  localTotal  = count of local skills matching filters
  externalTotal = count of external skills matching filters (from provider)
  totalCount  = localTotal + externalTotal
  offset      = (page - 1) * pageSize

If offset < localTotal:
  localSlice  = local skills [offset .. min(offset + pageSize, localTotal)]
  remaining   = pageSize - localSlice.length
  externalSlice = remaining > 0 ? external skills [0 .. remaining] : []
Else:
  localSlice  = []
  externalOffset = offset - localTotal
  externalSlice = external skills [externalOffset .. externalOffset + pageSize]

skills = [...localSlice, ...externalSlice]
```

**Limitation (documented in code):** If the local skill set changes between page requests, the offset boundary between local and external results shifts. A skill may be duplicated or skipped across pages. This is a known trade-off of offset-based pagination over two independent sources.

### Deduplication

An external skill that has already been imported locally (matched by slug pattern: `owner/repo@skill` or `owner/repo`) is excluded from the external slice. The local copy takes precedence.

### External skill SkillView shape

External skills are mapped to a subset of `SkillView` fields. Fields that don't apply to external skills use sensible defaults:

| Field | External skill value |
|---|---|
| `id` | Synthetic: `ext:<owner>/<repo>/<skillId>` |
| `slug` | `<owner>/<repo>@<skillId>` |
| `name` | From `@mastra/skills-api` response |
| `description` | From `@mastra/skills-api` response |
| `authorId` | `null` |
| `sourceKind` | `'external'` |
| `publicationStatus` | `'published'` |
| `isSelectable` | `true` |
| `selectabilityReason` | `'external'` |
| `priceCents` | `0` |
| `likeCount` | External installs count (mapped from `installs` field) |
| `popularityScore` | Derived from installs via `Math.log1p(installs)` |
| `tags` | From external source (if available) |
| All other fields | Default/empty values |

### Graceful degradation

External skill fetching is best-effort. When the self-hosted API is unavailable:

1. The response succeeds with local-only results.
2. `totalCount` reflects only local skills.
3. A `degradation` field is included: `{ external: "unavailable", reason: "..." }`.
4. The UI can optionally display a subtle indicator but must not break.

### No new sort dimensions for external skills

Sorting applies within each source independently. Local skills are sorted by the user's chosen sort (popular, trending, newest, price). External skills are sorted by installs (the `@mastra/skills-api` default). The merged result preserves the local-first invariant regardless of sort.

### CLI retained for workspace operations only

The `npx skills add/remove/list` commands remain in the agent tools (`add_skills`, `remove_skills`, `list_skills`) for managing installed skill files in the agent workspace. These are local filesystem operations that the HTTP API does not replace. Only the `npx skills find` discovery path is removed.

### Configuration

New operator config section:

```yaml
# config/default.yaml
externalSkills:
  enabled: true                       # master switch — disables all external skill features
  apiBaseUrl: http://skills-api:3456  # self-hosted @mastra/skills-api URL (Compose service name for local dev)
  searchTimeoutMs: 5000               # timeout for search requests
  browseTimeoutMs: 5000               # timeout for browse requests (no query)
  statsTimeoutMs: 3000                # timeout for stats/total-count requests
```

Validated at startup via Zod in `AppConfigSchema`. Env overrides: `EXTERNAL_SKILLS_ENABLED`, `EXTERNAL_SKILLS_API_BASE_URL`, `EXTERNAL_SKILLS_SEARCH_TIMEOUT_MS`, `EXTERNAL_SKILLS_BROWSE_TIMEOUT_MS`.

For production/staging, `apiBaseUrl` is overridden to point to the private IP or service-discovery name of the skills-api container.

---

## Step 1 — Infrastructure: add `@mastra/skills-api` to docker-compose [DONE]

**Files:**
- `docker-compose.yaml` (local dev)
- `docker-compose.prod.yaml`
- `docker-compose.staging.yaml`

> `docker-compose.dev.yaml` is not modified — `skills-api` inherits from the base compose unchanged, same as postgres and redis.

**Changes:**

Add a `skills-api` service:

```yaml
skills-api:
  image: node:22-alpine
  working_dir: /app
  command: ['npx', '@mastra/skills-api']
  ports:
    - '3456:3456'
  environment:
    PORT: '3456'
    HOST: '0.0.0.0'
    AUTO_REFRESH: 'true'
    REFRESH_INTERVAL: '60'        # re-scrape every 60 minutes
  healthcheck:
    test: ['CMD-SHELL', 'node -e "fetch(\"http://localhost:3456/api/skills/stats\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"']
    interval: 30s
    timeout: 10s
    retries: 5
    start_period: 60s             # initial scrape takes time
  restart: unless-stopped
  logging:
    driver: json-file
    options:
      max-size: "10m"
      max-file: "3"
```

For production, add S3 persistence so scraped data survives restarts:

```yaml
environment:
  S3_BUCKET: herobids-skills-data
  S3_REGION: eu-central-1
```

The `api` and `worker` services gain a soft dependency (no `condition: service_healthy` — external skills are best-effort):

```yaml
api:
  depends_on:
    skills-api:
      condition: service_started   # best-effort, not blocking
```

**Implementation note:** Evaluate whether `npx @mastra/skills-api` is sufficient or if a dedicated Dockerfile is needed for production. The `npx` approach is simplest for dev; production may benefit from a pre-built image with pinned version for deterministic deploys.

**Depends on:** Nothing.

---

## Step 2 — Domain: define `ExternalSkillProvider` port and types [DONE]

**File:** `packages/domain/src/ports/external-skill-provider.ts` (new)

**Changes:**

Define the port interface:

```typescript
export interface ExternalSkillSummary {
  /** Canonical ref: owner/repo/skillId */
  ref: string;
  /** Skill ID from external registry */
  skillId: string;
  name: string;
  description: string;
  owner: string;
  repo: string;
  /** Install count from the external registry */
  installs: number;
  tags?: string[];
}

export interface ExternalSkillPage {
  results: ExternalSkillSummary[];
  /** Total matching skills in the external catalog. */
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface ExternalSkillStats {
  totalSkills: number;
  totalSources: number;
  totalOwners: number;
}

export interface ExternalSkillProvider {
  /**
   * Search external skills by keyword. Paginated.
   */
  search(query: string, opts: { page: number; pageSize: number }): Promise<ExternalSkillPage>;

  /**
   * Browse external skills (no query — returns popular/default listing). Paginated.
   */
  browse(opts: { page: number; pageSize: number }): Promise<ExternalSkillPage>;

  /**
   * Get registry statistics (total skills, sources, owners).
   * Used for the headline count. Result should be cached by the implementation.
   */
  getStats(): Promise<ExternalSkillStats | null>;
}
```

The `@mastra/skills-api` endpoints map directly:
- `search()` → `GET /api/skills?query=...&page=N&pageSize=M`
- `browse()` → `GET /api/skills?sortBy=installs&sortOrder=desc&page=N&pageSize=M`
- `getStats()` → `GET /api/skills/stats`

Re-export from `packages/domain/src/ports/index.ts`.

**Depends on:** Nothing.

---

## Step 3 — Domain: add `sourceKind: 'external'` to the type system [DONE]

**File:** `packages/domain/src/skills.ts`

**Changes:**

1. Extend the `SourceKind` type to include `'external'`: `type SourceKind = 'system' | 'user' | 'external'`.
2. Export this type for use in the API route.

**Depends on:** Nothing.

---

## Step 4 — Domain: add external skills config to `AppConfigSchema` [DONE]

**File:** `packages/domain/src/config.ts`

**Changes:**

Add `externalSkills` section to `AppConfigSchema`:

```typescript
externalSkills: z.object({
  enabled: z.boolean().default(true),
  apiBaseUrl: z.string().url().default('http://skills-api:3456'),
  searchTimeoutMs: z.number().int().min(500).max(30000).default(5000),
  browseTimeoutMs: z.number().int().min(500).max(30000).default(5000),
  statsTimeoutMs: z.number().int().min(500).max(10000).default(3000),
}).default({}),
```

**Depends on:** Nothing.

---

## Step 5 — Domain: add pagination types [DONE]

**File:** `packages/domain/src/pagination.ts` (new)

**Changes:**

Define shared pagination types:

```typescript
export interface PaginatedResponse<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
}
```

Re-export from `packages/domain/src/index.ts`.

**Depends on:** Nothing.

---

## Step 6 — Infrastructure: implement HTTP-based `ExternalSkillProvider` [DONE]

**File:** `apps/api/src/external-skill-provider-http.ts` (new)

**Changes:**

Implement `ExternalSkillProvider` using `fetch` calls to the self-hosted `@mastra/skills-api`:

1. **`search(query, opts)`**: `GET /api/skills?query=<query>&page=<page>&pageSize=<pageSize>`. Parse the JSON response into `ExternalSkillPage`. The `@mastra/skills-api` returns structured skill objects with `id`, `name`, `description`, `owner`, `repo`, `installs`, etc.

2. **`browse(opts)`**: `GET /api/skills?sortBy=installs&sortOrder=desc&page=<page>&pageSize=<pageSize>`. Same response parsing.

3. **`getStats()`**: `GET /api/skills/stats`. Cache the result in-memory with a TTL of 5 minutes. The stats endpoint returns `{ totalSkills, totalSources, totalOwners }`.

4. **Error handling**: All calls use `AbortSignal.timeout()` with configured timeouts. On failure (network error, timeout, non-2xx), return a well-typed error that the caller can degrade gracefully from. Do not throw — return `Result<T, E>` per project convention for port implementations that cross network boundaries. Alternatively, since this is infra and the caller handles errors with try/catch, throwing with a typed error class is acceptable if that matches the existing HTTP-client patterns in the codebase.

5. **Constructor**: Accepts `{ baseUrl: string; searchTimeoutMs: number; browseTimeoutMs: number; statsTimeoutMs: number }` from the resolved `externalSkills` config.

**Depends on:** Steps 2, 4.

---

## Step 7 — API: add pagination to `GET /skills` [PENDING]

**File:** `apps/api/src/routes/skills.ts`

**Changes:**

1. Add `page` and `pageSize` to `ListSkillsQuerySchema`:
   ```typescript
   page: z.coerce.number().int().min(1).default(1),
   pageSize: z.coerce.number().int().min(1).max(100).default(20),
   ```

2. Apply `LIMIT` and `OFFSET` to the local DB query.

3. Add a separate count query for `localTotal` (same WHERE clauses, `SELECT COUNT(*)`).

4. Change the response shape from `{ skills: SkillView[] }` to:
   ```json
   {
     "skills": [],
     "totalCount": 0,
     "page": 1,
     "pageSize": 20
   }
   ```

5. For scopes that don't include external skills (`mine`, `admin`, and `selectable` with `sourceKind=system` filter), `totalCount = localTotal` and no external fetch occurs.

**Breaking change:** The response shape changes from `{ skills }` to `{ skills, totalCount, page, pageSize }`. The `skills` array key is preserved. Frontend must be updated to read the new envelope.

**Depends on:** Nothing (can proceed independently of external skill work).

---

## Step 8 — API: merge external skills into paginated response [PENDING]

**File:** `apps/api/src/routes/skills.ts`

**Changes:**

1. Inject `ExternalSkillProvider` into `skillsRoutes` (constructor injection, or `null` when `externalSkills.enabled` is false).

2. For `selectable` and `marketplace` scopes when provider is available:
   a. Compute the merged pagination (see Design Constraints model).
   b. Run the local DB query (with pagination for the local slice) and external provider fetch in parallel.
   c. Map external results to `SkillView` using the external-to-SkillView mapping (see Design Constraints).
   d. Deduplicate: exclude external skills whose `ref` matches any local skill's slug.
   e. Compute `totalCount = localTotal + externalTotal`.

3. For `mine` and `admin` scopes: skip external fetch entirely.

4. When external fetch fails or provider is `null`: degrade gracefully (local-only, add `degradation` field).

**Depends on:** Steps 2, 6, 7.

---

## Step 9 — API: add `sourceKind` filter to query schema [PENDING]

**File:** `apps/api/src/routes/skills.ts`

**Changes:**

Add optional `sourceKind` filter to `ListSkillsQuerySchema`:

```typescript
sourceKind: z.enum(['system', 'user', 'external']).optional(),
```

When set:
- `system`: only local skills where `authorId IS NULL`. No external fetch.
- `user`: only local skills where `authorId IS NOT NULL`. No external fetch.
- `external`: only external skills. Skip local query. `totalCount` from external provider only.

This enables the UI to implement the "Built-in" tab without a separate endpoint.

**Depends on:** Step 7.

---

## Step 10 — Worker: replace `npx skills find` with HTTP call in `search_skills` [PENDING]

**File:** `apps/worker/src/tools/skills.ts`

**Changes:**

Replace the `runExternalSkillSearch` subprocess function with an HTTP call to the self-hosted `@mastra/skills-api`:

1. Remove `runExternalSkillSearch()` and its subprocess helpers (`spawn`, `EXTERNAL_SEARCH_TIMEOUT_MS`, `EXTERNAL_OUTPUT_MAX_BYTES`, `tokenizeQuery`).

2. Add an `ExternalSkillProvider` to the tool context (or resolve from config). The worker already has access to `AppConfig` — construct the HTTP provider using `config.externalSkills`.

3. In `searchSkillsTool.execute()`:
   - Replace the subprocess call with `provider.search(query, { page: 1, pageSize: 10 })`.
   - Map `ExternalSkillPage.results` to the existing response format (`external.results` section).
   - The response shape for agents can remain split (local + external sections) since agents benefit from seeing both sources.

4. Keep the existing `runExternalSkillList`, `runExternalSkillInstall`, `runExternalSkillRemove` subprocess helpers unchanged — these are workspace-local operations that the HTTP API does not replace.

**Depends on:** Steps 2, 6.

---

## Step 11 — Frontend: update skills page for paginated + merged catalog [PENDING]

**Files:**
- `apps/web/src/lib/api-client.ts`
- `apps/web/src/features/skills/SkillsPage.tsx` (or equivalent)

**Changes:**

1. Update the API client to read the new `{ skills, totalCount, page, pageSize }` envelope.
2. Add pagination controls (page selector or infinite scroll).
3. Display `totalCount` as the catalog size (e.g. "34,000+ skills").
4. Map the existing UI tabs to the new query params:
   - **All** → `scope=selectable` (includes external)
   - **User** → `scope=mine`
   - **Built-in** → `scope=selectable&sourceKind=system`
   - **Marketplace** → `scope=marketplace` (includes external)
5. Do not visually distinguish external skills from local skills. The card layout is identical.
6. Handle the `degradation` field gracefully (optional subtle toast or banner when external is unavailable).

**Depends on:** Steps 8, 9.

---

## Step 12 — Config: add defaults to `config/default.yaml` [PENDING]

**File:** `config/default.yaml`

**Changes:**

```yaml
externalSkills:
  enabled: true
  apiBaseUrl: http://skills-api:3456    # Compose service name for local dev; override for prod/staging
  searchTimeoutMs: 5000
  browseTimeoutMs: 5000
  statsTimeoutMs: 3000
```

Env overrides documented inline. For production/staging YAML overrides or `EXTERNAL_SKILLS_API_BASE_URL` env var, point to the private IP or service-discovery name.

**Depends on:** Step 4.

---

## Step 13 — Tests [PENDING]

### Domain tests

**Files:** `packages/domain/src/ports/external-skill-provider.test.ts`, `packages/domain/src/config.test.ts`

1. `ExternalSkillProvider` interface type-checks (compile-time only).
2. `AppConfigSchema` accepts and defaults the `externalSkills` section.
3. `SourceKind` includes `'external'`.

### Provider tests

**File:** `apps/api/src/external-skill-provider-http.test.ts`

1. `search()` calls the correct URL with query, page, pageSize params.
2. `search()` respects configured timeout.
3. `search()` parses structured JSON response into `ExternalSkillPage`.
4. `search()` handles network errors gracefully (returns typed error, does not throw unhandled).
5. `browse()` calls the correct URL with sort params.
6. `getStats()` returns cached stats and respects TTL.
7. `getStats()` handles API unavailability gracefully.

### API tests

**File:** `apps/api/src/routes/skills.test.ts`

1. `GET /skills` returns `{ skills, totalCount, page, pageSize }` envelope.
2. Pagination: `page=1&pageSize=5` returns at most 5 skills with correct `totalCount`.
3. `scope=selectable` includes external skills when provider is available.
4. `scope=mine` excludes external skills.
5. `sourceKind=system` returns only system skills, no external fetch.
6. `sourceKind=external` returns only external skills, no local query.
7. External provider failure degrades gracefully — local results still returned, `degradation` field present.
8. External skills are deduplicated against local skills by slug/ref match.
9. Merged pagination: when local results span the page boundary, external skills fill remaining slots correctly.
10. `totalCount` sums local and external totals.

### Worker tests

**File:** `apps/worker/src/tools/skills.test.ts`

1. `search_skills` calls the HTTP provider instead of spawning a subprocess.
2. `search_skills` returns structured external results.
3. `search_skills` degrades gracefully when provider is unavailable.
4. `add_skills` / `remove_skills` / `list_skills` still use `npx skills` CLI for workspace operations (unchanged behavior).

### Integration tests

1. `docker compose up` starts `skills-api` alongside existing services.
2. `skills-api` healthcheck passes after initial scrape.
3. `GET /skills?scope=selectable` returns merged local + external results.
4. Agent `search_skills` tool returns external results from the HTTP provider.

---

## Implementation Order

```
Step 1  — Infrastructure: add skills-api to docker-compose
Step 2  — Domain: ExternalSkillProvider port and types
Step 3  — Domain: sourceKind 'external'
Step 4  — Domain: externalSkills config schema
Step 5  — Domain: pagination types
Step 6  — Infrastructure: HTTP-based ExternalSkillProvider implementation
Step 7  — API: add pagination to GET /skills
Step 8  — API: merge external skills into response
Step 9  — API: sourceKind filter
Step 10 — Worker: replace npx skills find with HTTP call
Step 11 — Frontend: paginated + merged skills page
Step 12 — Config: default.yaml
Step 13 — Tests
```

Parallelizable groups:

- **Group A (domain):** Steps 2, 3, 4, 5 — no dependencies between them
- **Group B (infrastructure):** Steps 1, 6 — Step 6 depends on Steps 2 and 4 from Group A. Step 1 is independent.
- **Group C (API pagination):** Step 7 — can proceed independently of external skill work
- **Group D (API merge):** Steps 8, 9 — after Groups A, B, and C
- **Group E (worker):** Step 10 — after Steps 2 and 6, can run in parallel with Group D
- **Group F (frontend):** Step 11 — after Group D
- **Group G (config + tests):** Steps 12, 13 — after relevant implementation steps

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **`@mastra/skills-api` initial scrape is slow** | Set `start_period: 60s` on healthcheck. API and worker degrade gracefully during startup. First page loads show local-only results until external data is available. |
| **`@mastra/skills-api` goes down or becomes unresponsive** | Timeout + graceful degradation. Local results always return. `degradation` field tells the frontend. Healthcheck + `restart: unless-stopped` auto-recovers. |
| **Data staleness between refresh intervals** | Default 60-minute refresh. Acceptable for a skill catalog that changes slowly. Operator can lower `REFRESH_INTERVAL` if needed. |
| **Memory usage of skills-api container** | 34k+ skills in memory is lightweight (~50-100MB). Monitor via standard container metrics. |
| **Response shape change breaks frontend** | Coordinate with frontend update (Step 11). The `skills` array key is preserved — only the envelope changes. |
| **Offset pagination inconsistency across pages** | Document in code. Acceptable for initial launch. Cursor-based pagination is a future improvement. |
| **Deduplication misses edge cases** | Match on normalized `owner/repo@skill` ref against local skill slugs. False negatives (duplicates shown) are cosmetically annoying but not harmful. |
| **`npx @mastra/skills-api` version drift** | Pin the version in docker-compose. Use a dedicated Dockerfile for production with locked dependency. |
| **Network between API/worker and skills-api** | Same docker network (compose default). Latency is sub-millisecond. For multi-host deployments, skills-api runs on the same host or uses service discovery. |
| **Breaking changes in `@mastra/skills-api` response schema** | The `ExternalSkillProvider` port isolates the API route from schema changes. Only the HTTP implementation file needs updating. Validate external responses defensively (Zod parse, not type assertion). |

---

## Future Work (out of scope)

- **Official Vercel skills.sh API:** If Vercel OIDC auth becomes available outside Vercel projects, switch from self-hosted to the official API (600k+ skills vs 34k scraped).
- **Cursor-based pagination:** Replace offset-based pagination for more consistent cross-source paging.
- **External skill detail view:** `GET /skills/:id` for external skills — proxy to `@mastra/skills-api`'s `/api/skills/:owner/:repo/:skillId/content` endpoint to fetch SKILL.md from GitHub.
- **External skill caching:** Cache frequently-accessed external skill pages in Redis to reduce calls to skills-api.
- **Unified sort across sources:** When both local and external skills have comparable popularity metrics, sort the merged set globally instead of local-first.
- **Dedicated Docker image for skills-api:** Build a production image with pinned `@mastra/skills-api` version + S3 persistence instead of `npx` at runtime.
