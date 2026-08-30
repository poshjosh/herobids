# Unified Skill Catalog — Changelog

## 2026-08-30 — Post-implementation fixes

### Bug fix: ExternalSkillProviderHttp not wired into skills route

**Problem:** `ExternalSkillProviderHttp` was fully implemented but never instantiated or passed to `skillsRoutes()` in `apps/api/src/index.ts`. The 4th parameter (`externalSkillProvider`) was omitted from the call. Since it's typed as optional, TypeScript didn't flag it, and the route handler's graceful degradation silently returned local-only results — 13 skills instead of 34k+.

**Fix:** Construct the provider from `appConfig.externalSkills` and pass it as the 4th argument to `skillsRoutes()`.

**Files:** `apps/api/src/index.ts`

### Bug fix: Logger type mismatch in ExternalSkillProviderHttp

**Problem:** The constructor accepted `Logger` from pino, but Fastify provides `FastifyBaseLogger`. The Docker build failed with `TS2345: Argument of type 'FastifyBaseLogger' is not assignable to parameter of type 'Logger'`.

**Fix:** Changed the type to `FastifyBaseLogger` from `fastify` in both the implementation and test file.

**Files:** `apps/api/src/external-skill-provider-http.ts`, `apps/api/src/external-skill-provider-http.test.ts`

### Bug fix: skills-api Docker container crash loop

**Problem:** The `skills-api` service in `docker-compose.yaml` used `npx @mastra/skills-api@0.1.0`, but the package is not published to npm. The container crash-looped with `E404 Not Found`.

**Fix:** Changed the service to clone from `https://github.com/mastra-ai/skills-api.git`, build from source, and persist the repo in a named volume (`skills-api-data`). Increased `start_period` to 120s for the initial build.

**Files:** `docker-compose.yaml`

### Feature: Hybrid external skill provider (skills.sh search + mastra browse)

**Problem:** The self-hosted `@mastra/skills-api` only indexes ~34k skills from ~2,800 scraped repos. Skills from Google, OpenAI, Anthropic, and most of the ecosystem were missing. The official skills.sh registry has 600,000+ skills.

**Solution:** Hybrid `ExternalSkillProvider` that routes to two sources:

| Method | Source | Catalog size |
|--------|--------|-------------|
| `search(query)` | Public `skills.sh/api/search` (no auth) | 600,000+ |
| `browse()` | Self-hosted `@mastra/skills-api` | 34,000+ |
| `getStats()` | Self-hosted `@mastra/skills-api` | 34,000+ |

Search results from skills.sh are cached for 60 seconds and sliced locally for pagination (the API returns up to 200 results with no server-side pagination). Browse and stats continue to use the self-hosted instance which supports full pagination.

**Config addition:**
```yaml
externalSkills:
  searchApiBaseUrl: https://skills.sh  # new — Vercel public search API
```

**Files:**
- `packages/domain/src/config/schema.ts` — added `searchApiBaseUrl` to `externalSkills` Zod schema
- `config/default.yaml` — added `searchApiBaseUrl` default
- `apps/api/src/external-skill-provider-http.ts` — rewrote as hybrid provider
- `apps/api/src/external-skill-provider-http.test.ts` — rewrote tests for hybrid behavior
- `apps/api/src/index.ts` — pass `searchApiBaseUrl` in provider config
- `packages/domain/src/config/external-skills-config.test.ts` — added `searchApiBaseUrl` assertions

**Trade-offs:**
- Search pagination is simulated (client-side slice of up to 200 results). Beyond ~10 pages of search results, we can't go deeper. Acceptable for a search UI.
- `totalCount` for search results reflects the capped result count (max 200), not the true total. The skills.sh API doesn't expose a total match count.
- Two external dependencies: skills.sh (Vercel production infra) for search, self-hosted mastra for browse/stats.
