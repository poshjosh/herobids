# Plan: Scrapfly Proxy for Forex Factory (Cloudflare Bypass)

**Status:** Implemented — pending staging verification (Item 11)
**Date:** 2026-07-15
**Depends on:** `docs/features/2026/07/09/001-macro-economic-context/001-plan.md` (ships `ForexFactoryCalendarAdapter`)

---

## Problem

The economic-calendar feature (`marketData.economicCalendar`) scrapes
`https://www.forexfactory.com/calendar` for upcoming high-impact events
(FOMC, NFP, CPI, etc.). It works on local dev machines but fails on the
staging Hetzner box.

Root cause (confirmed): Cloudflare fronts Forex Factory and blocks/challenges
requests from well-known cloud/datacenter IP ranges (Hetzner is one of them).
An HTTP/1.1 workaround (`fetchHttp1` in `apps/worker/src/agent.ts`) was
already applied because Node's default `fetch()` negotiates HTTP/2, which
also triggers Cloudflare blocks — that fix was necessary but not sufficient;
the IP-reputation block persists regardless of HTTP version.

We now have a `SCRAPFLY_API_KEY` (already added to `.env` / `.env.example`)
and want to route the Forex Factory scrape through
[Scrapfly](https://scrapfly.io)'s Scrape API, which proxies the request
through rotating (residential-capable) IPs and its Anti-Scraping Protection
(ASP) feature to solve Cloudflare's JS challenge.

## Decisions (confirmed with user)

| Question | Decision |
|---|---|
| Scope | Build a **generic, reusable** Scrapfly fetch helper in `packages/market-data`, not a Forex-Factory-only hack. Config lives at `marketData.scrapfly` (sibling of `birdeye`/`coinMarketCap`), not nested under `forexFactory`. |
| Always vs. fallback | **Always** route through Scrapfly when `marketData.scrapfly.enabled` — no "try direct, then fall back to Scrapfly" branching. Request volume is already low (3h shared Redis cache, `requestsPerMinute: 1` limiter). |
| Anti-Scraping Protection | `asp=true` **always** for the Forex Factory target (this is the entire reason we need Scrapfly). |
| Env scope | Enabled **uniformly across all environments**, gated on whether `SCRAPFLY_API_KEY` resolves to a non-empty value at runtime (see "Secret wiring pattern" below — this is a graceful runtime check, not a schema-level `enabled` flag). Local dev will also route through Scrapfly once `SCRAPFLY_API_KEY` is set — this is fine since it will be a no-op cost that confirms the integration works before it ever reaches staging. |
| Failure fallback | **No fallback to direct fetch.** If the Scrapfly request itself fails, let `ForexFactoryCalendarAdapter.getUpcomingEvents()` return `err(...)` as it does today. `CompositeEconomicCalendarProvider` already serves stale Redis cache on failure — no new resilience code needed. |
| Cost controls | **Skip for this MVP.** No `cost_budget` param, no low-credit alerting. Revisit if Scrapfly billing becomes a problem. |
| Secret wiring pattern | Follow the **`TAVILY_API_KEY` pattern** (raw env passthrough, kept out of the Zod config schema entirely), not the `BIRDEYE_API_KEY`/`COINMARKETCAP_API_KEY` pattern (apiKey as a schema field serialized into `MARKET_DATA_CONFIG_JSON`). See below — this was investigated specifically because the two existing precedents in this codebase disagree with each other. |

## Secret wiring pattern — why `TAVILY_API_KEY`, not `BIRDEYE_API_KEY`

This codebase has **two different, conflicting precedents** for wiring a
third-party API key into the agent container:

1. **`BIRDEYE_API_KEY` / `COINMARKETCAP_API_KEY`** — `apiKey` is a field in
   `MarketDataConfigSchema`, resolved via `ENV_OVERRIDES` in
   `apps/api/src/config.ts` / `apps/worker/src/config.ts`, and the *entire*
   `appConfig.marketData` object (including the resolved `apiKey` values) is
   `JSON.stringify`'d into `MARKET_DATA_CONFIG_JSON` and forwarded into every
   agent container (`apps/worker/src/index.ts`, both the Docker and
   `buildAgentEnv()` code paths).
2. **`TAVILY_API_KEY`** — never enters the Zod schema. It's read directly
   from `process.env['TAVILY_API_KEY']` at the call site
   (`apps/worker/src/tools/web-access.ts`) and separately forwarded as a raw,
   individually-named env var into the agent container
   (`docker-agent-manager.ts` and `runtime-lifecycle.ts`'s `buildAgentEnv()`).
   The web-access plan doc (`docs/features/2026/06/10/005-web-access-tools/001-plan.md`)
   states explicitly: *"`TAVILY_API_KEY` is a secret — it must never enter
   the Zod schema."*

**These two precedents contradict each other**, and the contradiction is
confirmed by `docs/features/2026/07/08/004-orchestration/003-cluster-safe-connectivity.md`,
which classifies `BIRDEYE_API_KEY` / `COINMARKETCAP_API_KEY` as
**"Control-Plane-Only (NEVER pass to agent runtimes)"**, while
`MARKET_DATA_CONFIG_JSON` (which *does* currently carry those same keys, per
point 1 above) is separately classified as "Agent-Safe." In other words: the
current code already leaks `BIRDEYE_API_KEY`/`COINMARKETCAP_API_KEY` into every
agent container's env, in direct contradiction of this codebase's own
documented secrets policy. This is a pre-existing bug, out of scope for this
plan — logged separately in repo memory
(`marketdata-secrets-leak-into-agent-env.md`) rather than fixed here.

**Decision for Scrapfly: follow the `TAVILY_API_KEY` pattern.** It's the
newer, correct-per-the-codebase's-own-policy approach, and it's exactly what
the user pointed at when asking to check how `TAVILY_API_KEY` is handled.
Concretely:

- `SCRAPFLY_API_KEY` is **not** a field in `MarketDataConfigSchema`. Only
  non-secret knobs (`asp`, `baseUrl`, `requestTimeoutMs`) live in
  `marketData.scrapfly` and flow via `MARKET_DATA_CONFIG_JSON` as before.
- No `SCRAPFLY_API_KEY` entry is added to `ENV_OVERRIDES` in
  `apps/api/src/config.ts` or `apps/worker/src/config.ts` (mirrors: Tavily
  has no entry there either).
- No `enabled` boolean / no `superRefine` fail-fast-at-startup check —
  "enabled" is simply "is `SCRAPFLY_API_KEY` set at runtime," checked where
  the fetch is constructed, exactly like `search_web`'s
  `if (!apiKey) return { success: false, error: '... requires TAVILY_API_KEY', ... }`
  guard.
- `SCRAPFLY_API_KEY` is forwarded into agent containers as a raw,
  individually-named env var, in **both** places `TAVILY_API_KEY` is
  forwarded today: `apps/worker/src/agents/docker-agent-manager.ts` (Docker
  path) and `apps/worker/src/agents/runtime-lifecycle.ts`'s `buildAgentEnv()`
  (scheduler-agnostic path used for Nomad/cluster deployments).

## Non-Goals

- Routing `browse_url` (the agent's general-purpose web tool) through Scrapfly. Only Forex Factory is in scope; the generic helper just makes it easy to opt other scrapers in later.
- OHLC.dev adapter changes (it's a plain JSON API, not Cloudflare-fronted — no block).
- Cost budgeting / credit alerting (explicitly deferred).
- Extracting `apps/api/src/config.ts` / `apps/worker/src/config.ts` duplication (`ENV_OVERRIDES`, `loadConfig()`) into a shared package — tracked separately in repo memory (`009-dry-config-loading-api-worker.md`). This plan adds one entry to both existing maps, matching current convention.

## Design

### Why a generic helper (not a Forex-Factory-only hack)

`ForexFactoryAdapterConfig` already accepts an injectable `fetchFn?: typeof fetch`
(used today for `fetchHttp1`). A Scrapfly-backed `fetch` implementation fits
the same seam — no interface changes needed on the adapter itself. Building
it as `createScrapflyFetch(config): typeof fetch` in `packages/market-data`
means any future adapter that takes a `fetchFn` can opt in with one line.

### Scrapfly request shape

Scrapfly's Scrape API (`GET https://api.scrapfly.io/scrape`) takes the target
`url` and `key` as query params. Two response modes exist:
- Default: JSON envelope (`{ result: { content, status_code, ... } }`).
- `proxified_response=true`: the API responds with the **target's actual
  body, status code, and headers** — the real target status flows through
  the outer HTTP response instead of a JSON wrapper.

We use `proxified_response=true` so `createScrapflyFetch` can return the
`Response` object straight from the Scrapfly call, with no envelope parsing.
This keeps `fetchText()` (`packages/market-data/src/http.ts`) working
unmodified — it already does `if (!response.ok) throw ...; return response.text()`.

Important nuance to document in code comments: with `proxified_response=true`,
a non-2xx response can mean either (a) the target really returned that status
and ASP couldn't fully bypass it, or (b) Scrapfly itself rejected the request
(bad key, quota, concurrency limit). `fetchText()` can't distinguish these —
both surface as `HttpError` today, which is acceptable given the "no fallback,
let it fail" decision. `X-Scrapfly-Reject-Code` / `X-Scrapfly-Reject-Description`
headers are available on the response for future debugging if needed.

Query params to send for the Forex Factory target:

| Param | Value | Why |
|---|---|---|
| `url` | target URL, URL-encoded | required |
| `key` | `marketData.scrapfly.apiKey` | required |
| `asp` | `true` | bypass Cloudflare's JS challenge |
| `proxified_response` | `true` | return raw target content/status directly |
| `format` | `raw` | explicit (matches current default, but the config field should say what it means) |

**Do not forward the adapter's custom `User-Agent` header through to
Scrapfly.** Scrapfly's docs explicitly recommend using its own smart-default
fingerprinting (User-Agent + OS + browser brand are coordinated for ASP to
work correctly); a custom `User-Agent` header disables that coordination.
`createScrapflyFetch` will drop incoming `headers` entirely and rely on
Scrapfly's own defaults + `format=raw` (instead of an `Accept` header) to
control the response shape.

### Timeout sizing (real gotcha — must handle)

`fetchText()` builds its own `AbortController` from the **caller's**
`requestTimeoutMs` and passes the resulting `signal` into `fetchFn`. That
means the effective timeout for the *entire* Scrapfly round trip (including
ASP retries/browser rendering on Scrapfly's side) is bounded by
`economicCalendar.forexFactory.requestTimeoutMs` — currently `15000` in
`config/default.yaml` (schema default `10000`). Scrapfly's own documented
read timeout is ~155s, and ASP bypasses can legitimately take much longer
than a plain HTML fetch (browser rendering, CAPTCHA solving, proxy retries).

Action: raise `economicCalendar.forexFactory.requestTimeoutMs` in
`config/default.yaml` to something in the 60s–120s range (proposing `60000`)
so a slow-but-successful ASP bypass isn't aborted prematurely. This value is
already a config field (not hardcoded), so this is a config-value change,
not a schema change.

Trade-off to note: because this fetch is `await`ed directly in the agent's
main tick loop (`apps/worker/src/agent.ts`, "Economic calendar fetch"
section) before `buildTickUserContext()`, a slow Scrapfly call delays that
tick by however long it takes. This only happens for the one tick, across
*all* agents, that finds the shared Redis cache stale (cache TTL 3h) — so
it's an infrequent, bounded, already-`try/catch`-guarded cost. No change to
that call site's control flow is needed; it already logs a warning and
proceeds with `macroEvents = null` on failure/timeout.

### Config schema changes (non-secret knobs only)

`packages/domain/src/config/schema.ts` — add a `scrapfly` object to
`MarketDataConfigSchema`, sibling of `birdeye` / `coinMarketCap`, but with
**no `apiKey` or `enabled` field** (see "Secret wiring pattern" above):

```typescript
scrapfly: z.object({
  baseUrl: z.string().url().default('https://api.scrapfly.io/scrape'),
  asp: z.boolean().default(true),
  requestTimeoutMs: z.number().int().min(1_000).default(60_000),
}).default({}),
```

No change to the existing `superRefine` on `MarketDataConfigSchema` — there's
no secret field here to validate at startup.

`config/default.yaml` — add alongside `birdeye`/`coinMarketCap`:

```yaml
scrapfly:
  baseUrl: "https://api.scrapfly.io/scrape"
  asp: true
  requestTimeoutMs: 60000
```

And bump the existing `forexFactory.requestTimeoutMs` value in the same
file's `economicCalendar` block from `15000` to `60000` (see timeout section
above).

### New module: `packages/market-data/src/scrapfly.ts`

```typescript
export interface ScrapflyConfig {
  apiKey: string;             // resolved from process.env['SCRAPFLY_API_KEY'] by the caller — never a schema field
  baseUrl: string;
  asp: boolean;
  requestTimeoutMs: number;
  fetchFn?: typeof fetch;     // test injection, defaults to global fetch — same pattern as ForexFactoryAdapterConfig.fetchFn
}

export function createScrapflyFetch(config: ScrapflyConfig): typeof fetch {
  const rawFetch = config.fetchFn ?? fetch;
  return async (input, init) => {
    const targetUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const proxyUrl = new URL(config.baseUrl);
    proxyUrl.searchParams.set('url', targetUrl);
    proxyUrl.searchParams.set('key', config.apiKey);
    proxyUrl.searchParams.set('asp', String(config.asp));
    proxyUrl.searchParams.set('proxified_response', 'true');
    proxyUrl.searchParams.set('format', 'raw');

    // Deliberately do not forward `init.headers` — see design notes on
    // why a custom User-Agent breaks Scrapfly's ASP fingerprinting.
    return rawFetch(proxyUrl, {
      method: init?.method ?? 'GET',
      signal: init?.signal ?? undefined,
    });
  };
}
```

Export `ScrapflyConfig` and `createScrapflyFetch` from
`packages/market-data/src/index.ts`.

Unit tests (`packages/market-data/src/scrapfly.test.ts`), following the
existing style in `economic-calendar.test.ts`:
- builds the expected Scrapfly URL (`url`, `key`, `asp`, `proxified_response`, `format` params) via the injected `fetchFn` spy.
- does not forward incoming headers.
- propagates the `AbortSignal` from `init` through to the Scrapfly call.
- returns the `Response` unmodified (status/body pass through).

### Wiring into the agent runtime (`apps/worker/src/agent.ts`)

`SCRAPFLY_API_KEY` is read directly from `process.env`, exactly like
`process.env['TAVILY_API_KEY']` is read inside `web-access.ts`'s `search_web`
tool — not from `marketDataConfig`. Where `forexFactoryConfig.fetchFn` is
currently hardcoded to `fetchHttp1`, select the fetch implementation based on
whether the key resolved:

```typescript
const SCRAPFLY_API_KEY = process.env['SCRAPFLY_API_KEY'];

const forexFactoryFetchFn = SCRAPFLY_API_KEY
  ? createScrapflyFetch({
      apiKey: SCRAPFLY_API_KEY,
      baseUrl: ecConfig.scrapfly.baseUrl,
      asp: ecConfig.scrapfly.asp,
      requestTimeoutMs: ecConfig.scrapfly.requestTimeoutMs,
    })
  : fetchHttp1;

if (!SCRAPFLY_API_KEY) {
  logger.warn('SCRAPFLY_API_KEY not set — Forex Factory fetch will use direct HTTP/1.1 and may be blocked by Cloudflare on cloud IPs');
}

const forexFactoryConfig: ForexFactoryAdapterConfig = {
  // ...unchanged fields...
  fetchFn: forexFactoryFetchFn,
  parseHtmlFn: createLlmCalendarParser(),
};
```

`fetchHttp1` stays in the codebase as the graceful-degradation path when
`SCRAPFLY_API_KEY` isn't set (e.g. a fresh local checkout before the
developer has added it to `.env`).

### Secret forwarding into agent containers (both env-building code paths)

Add `SCRAPFLY_API_KEY` immediately next to the existing `TAVILY_API_KEY`
forwarding in **both** places — these are two independent, currently
duplicated code paths (Docker-direct vs. scheduler-agnostic), and both
already forward `TAVILY_API_KEY` the same way:

**File A:** `apps/worker/src/agents/docker-agent-manager.ts` (~line 255):

```typescript
...(process.env['TAVILY_API_KEY'] ? [`TAVILY_API_KEY=${process.env['TAVILY_API_KEY']}`] : []),
...(process.env['SCRAPFLY_API_KEY'] ? [`SCRAPFLY_API_KEY=${process.env['SCRAPFLY_API_KEY']}`] : []),
```

**File B:** `apps/worker/src/agents/runtime-lifecycle.ts`, inside
`buildAgentEnv()` (~line 114):

```typescript
// Tavily API key for web search tool — optional.
if (resolvedEnv['TAVILY_API_KEY']) envOut['TAVILY_API_KEY'] = resolvedEnv['TAVILY_API_KEY']!;
// Scrapfly API key for Forex Factory Cloudflare bypass — optional.
if (resolvedEnv['SCRAPFLY_API_KEY']) envOut['SCRAPFLY_API_KEY'] = resolvedEnv['SCRAPFLY_API_KEY']!;
```

No changes needed to `apps/api/src/config.ts` or `apps/worker/src/config.ts`
(`ENV_OVERRIDES`) — `SCRAPFLY_API_KEY` never enters `AppConfig`, so there's
nothing for those loaders to resolve.

### Deployment: `infra/hetzner/.env.staging` (the actual staging gap)

This is the concrete answer to "what needs updating besides code": staging
secrets are **not** read from the repo's `.env`/`.env.example` — the Hetzner
box gets its env from `infra/hetzner/.env.staging` (gitignored), deployed via
`infra/hetzner/deploy.sh --env staging --env-file infra/hetzner/.env.staging`.
That file already has `TAVILY_API_KEY`, `BIRDEYE_API_KEY`, and
`COINMARKETCAP_API_KEY` entries — it does **not** yet have `SCRAPFLY_API_KEY`.

`docker-compose.yaml` / `docker-compose.staging.yaml` themselves need **no
changes** — both `api` and `worker` services already declare
`env_file: [{ path: .env, required: false }]`, which auto-loads every
variable from whatever `.env` file is present on the host (Compose does not
need each var listed individually in the `environment:` block — none of the
existing provider keys are listed there either). The gap is purely a missing
line in the staging secrets file, not the compose files.

Action item: add `SCRAPFLY_API_KEY=<the same key already in .env>` to
`infra/hetzner/.env.staging`, then redeploy (or otherwise refresh the env on
the running host) so `docker compose up -d` picks it up for the `worker`
service. (`infra/hetzner/.env.prod` isn't present in this checkout — add the
same line there once it exists / before going live in production.)

### `.env.example`

`SCRAPFLY_API_KEY` is already present. Update its comment to state what it's
for and that it's optional-but-required-for-Cloudflare-bypass (matching the
graceful-degradation behavior, not a hard startup requirement):

```dotenv
# https://scrapfly.io/ = anti-bot/Cloudflare bypass proxy for scraping.
# Used by the Forex Factory economic-calendar adapter (Cloudflare blocks
# cloud/datacenter IPs like Hetzner's). Optional locally (falls back to a
# direct HTTP/1.1 fetch), but required for the fetch to succeed on staging/
# production hosts. (free tier: 1,000 credits/month, no card required)
SCRAPFLY_API_KEY=
```

## Implementation Steps

1. **[DONE] Schema:** add the non-secret `scrapfly` sub-schema (`baseUrl`, `asp`, `requestTimeoutMs` — no `apiKey`, no `enabled`) to `MarketDataConfigSchema` in [packages/domain/src/config/schema.ts](../../../../packages/domain/src/config/schema.ts).
2. **[DONE] Default config:** add `marketData.scrapfly` block to [config/default.yaml](../../../../config/default.yaml); bump `economicCalendar.forexFactory.requestTimeoutMs` to `60000`.
3. **[DONE] New module:** create `packages/market-data/src/scrapfly.ts` (`ScrapflyConfig`, `createScrapflyFetch`) + unit tests in `scrapfly.test.ts`; export from `packages/market-data/src/index.ts`.
4. **[DONE] Agent wiring:** update `apps/worker/src/agent.ts` to read `process.env['SCRAPFLY_API_KEY']` directly and select `createScrapflyFetch(...)` vs `fetchHttp1` for the Forex Factory `fetchFn`.
5. **[DONE] Container env forwarding:** add `SCRAPFLY_API_KEY` passthrough to both `apps/worker/src/agents/docker-agent-manager.ts` and `apps/worker/src/agents/runtime-lifecycle.ts`'s `buildAgentEnv()`, next to the existing `TAVILY_API_KEY` lines; add matching tests in `apps/worker/src/agents/runtime-lifecycle.test.ts` (mirror the existing Tavily forwarding test cases).
6. **[DONE] `.env.example`:** refine the `SCRAPFLY_API_KEY` comment (see above).
7. **[DONE - Manual] Deployment secrets:** add `SCRAPFLY_API_KEY` to `infra/hetzner/.env.staging` (and `.env.prod` when it exists) — file is gitignored; requires manual action by whoever holds staging server access. A `docker compose restart worker` is sufficient to pick up the new env var.
8. **[DONE] Documentation:** add `SCRAPFLY_API_KEY` to the "Agent-Safe" table in `docs/features/2026/07/08/004-orchestration/003-cluster-safe-connectivity.md`, next to `TAVILY_API_KEY`.
9. **[DONE] Manual verification script:** update `scripts/ts/test-forexfactory-parser.ts` — added `--scrapfly` flag to exercise the Scrapfly path locally (behind the `SCRAPFLY_API_KEY` env var).
10. **[DONE - Manual] Local verification:** run `npx tsx scripts/ts/test-forexfactory-parser.ts --scrapfly` locally with `SCRAPFLY_API_KEY` set, confirm HTML comes back and the LLM parser extracts events.
11. **[PENDING - Manual] Staging verification (manual, post-deploy):** after deploying to the Hetzner staging box, confirm `marketData.economicCalendar.enabled` agents log `'Economic calendar fetched'` (not `'... fetch failed'` / `'... provider threw'`) in worker/agent logs. This is the actual bug repro — cannot be verified locally.
12. **[DONE] Tests:** `pnpm --filter @herobids/market-data run test` (315 passed), `pnpm --filter @herobids/worker run test` (1986 passed), `pnpm lint` (clean), and `pnpm build` (clean) at the repo root.
13. **[DONE] Changelog:** add an entry to `CHANGELOG.md`.

## Outstanding Issues

### [Item 3: New module — scrapfly.ts]
- **MEDIUM — `requestTimeoutMs` dead field in `createScrapflyFetch`:** The `ScrapflyConfig.requestTimeoutMs` field is accepted but never consumed by `createScrapflyFetch`. The actual timeout is enforced by `fetchText()` via `economicCalendar.forexFactory.requestTimeoutMs`. Consider either using it to create a backstop `AbortController` composed with the caller's signal, or removing it from the interface with a JSDoc note that timeout is the caller's responsibility. (Decision: the plan intentionally delegates timeout to the caller's `AbortSignal`; `scrapfly.requestTimeoutMs` is a config knob available for future use or alternate call sites that don't go through `fetchText`.)
- **LOW — `method` passthrough fragility:** `createScrapflyFetch` passes `init?.method ?? 'GET'` through to Scrapfly's `/scrape` endpoint, which only accepts GET. If a future caller passes POST, the error would be opaque. Consider hardcoding `'GET'` with a comment explaining Scrapfly's GET-only constraint.
- **LOW — Missing explicit test for `undefined` init:** The code handles omitted `init` correctly via optional chaining, but no test explicitly validates behavior when `init` is not passed at all. Add a test case for completeness.

### [Item 4: Agent wiring — agent.ts]
- **MEDIUM — Plan code snippet has a typo:** The plan's wiring snippet writes `ecConfig.scrapfly.baseUrl` but the design section correctly states config lives at `marketData.scrapfly`. The implementation correctly uses `marketDataConfig.scrapfly.*`. Plan snippet should be corrected for future reference.
- **LOW — Pre-existing `JSON.parse(...) as MarketDataConfig` fragility:** `marketDataConfig` is parsed with a bare type assertion, not Zod validation. If the producing side omits the `scrapfly` key, accessing `marketDataConfig.scrapfly.baseUrl` would throw at runtime. Pre-existing pattern affecting all `marketDataConfig` fields — not introduced by this change.
- **LOW — Local const naming convention:** `SCRAPFLY_API_KEY` (SCREAMING_SNAKE_CASE) vs surrounding `camelCase` locals like `forexFactoryFetchFn`. Cosmetic; the current form is instantly grep-able against the env var name.

## Testing Plan

- Unit: `packages/market-data/src/scrapfly.test.ts` (new).
- Unit: `apps/worker/src/agents/runtime-lifecycle.test.ts` — new `SCRAPFLY_API_KEY` forwarding cases (present → forwarded, absent → omitted), mirroring the existing `TAVILY_API_KEY` cases.
- Existing `packages/market-data/src/economic-calendar.test.ts` should continue to pass unmodified (adapter interface unchanged; only the injected `fetchFn` changes at the call site).
- No changes needed to `apps/api/src/config.test.ts` / `apps/worker/src/config.test.ts` / `packages/domain` schema tests for secrets — `SCRAPFLY_API_KEY` never enters `AppConfig`. The new non-secret `scrapfly` schema fields (`baseUrl`, `asp`, `requestTimeoutMs`) can get a plain defaults test if `MarketDataConfigSchema` has one already (check `packages/domain/src/config/schema.test.ts`).
- Manual: `scripts/ts/test-forexfactory-parser.ts` run locally with a real `SCRAPFLY_API_KEY`.
- Manual: staging deploy + log check (this is the actual regression we're fixing — no automated test can reach the real Hetzner-vs-Cloudflare condition).

## Open Risks / Follow-ups (not blocking this plan)

- If Scrapfly's `asp=true` still gets blocked on this specific target (Forex Factory may have particularly aggressive Cloudflare rules), the next lever is `proxy_pool=public_residential_pool` — deferred since it costs more credits and we don't yet know if `asp=true` alone is insufficient.
- Cost controls (`cost_budget`, low-credit alerting) were explicitly deferred — revisit if Scrapfly billing/usage becomes a concern.
- **Discovered, not fixed here:** `BIRDEYE_API_KEY` / `COINMARKETCAP_API_KEY` currently leak into every agent container's env via `MARKET_DATA_CONFIG_JSON` (`JSON.stringify(appConfig.marketData)` in `apps/worker/src/index.ts`, both the Docker and `buildAgentEnv()` paths), contradicting their own "Control-Plane-Only — NEVER pass to agent runtimes" classification in `docs/features/2026/07/08/004-orchestration/003-cluster-safe-connectivity.md`. Logged in repo memory (`marketdata-secrets-leak-into-agent-env.md`) as a separate pre-existing security issue to fix later.
- `apps/api/src/config.ts` / `apps/worker/src/config.ts` duplication is a known pre-existing issue (repo memory `009-dry-config-loading-api-worker.md`), not addressed here.
