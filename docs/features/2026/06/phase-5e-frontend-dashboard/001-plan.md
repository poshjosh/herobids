# Phase 5e: Frontend / Mission Control

## Objective

Implement Step 4 of Phase 5 as the first real user-facing product surface: an authenticated, agent-first product app that feels like supervising an operator rather than using a trader terminal.

The Step 4 label in the Phase 5 outline still says "Frontend / dashboard", but the product target for this phase should be Mission Control, not a classic trading dashboard.

The frontend should be built around the surfaces already identified in `docs/features/2026/06/phase-5e-frontend-dashboard/000-frontend-q-and-a.md`:

1. Agent Overview
2. Activity Feed
3. Outcome Board
4. Portfolio / Exposure View

It must also stay aligned with the canonical agent contract in `docs/tech/agents/` so later agent implementation does not force a structural UI rewrite.

## Current Baseline

What already exists:

- Multi-user auth, OAuth login, JWT sessions, ownership-guarded API routes, and plan-aware mutation guards are already implemented in `apps/api`.
- The API already exposes usable resource endpoints for auth, portfolios, venue accounts, credentials, trading instances, positions, journal events, live readiness/status, reconciliation events, and backtests.
- Canonical agent docs now freeze the frontend-relevant contract for status, timeline, execution result, guardrail, and recovery semantics.

What does not exist yet:

- There is no frontend app package in the monorepo.
- The API is not yet configured as a browser-facing app backend with explicit frontend origin handling.
- The current OAuth callback returns JSON directly from the API instead of redirecting into a browser app flow.
- The API mostly exposes resource-level endpoints, not user-scoped composite read models for an agent-first homepage.

## Product Boundary

This phase intentionally builds the authenticated product app first.

- Create a product app in `apps/web`.
- Keep public marketing pages, blog, and long-form docs out of `apps/web`.
- Signed-out routes in `apps/web` should stay minimal: product entry, auth handoff, and callback/bootstrap.
- If a meaningful public site is needed later, create it separately, for example in `apps/site`.
- Keep the boundary clean by sharing only small brand tokens or UI primitives later if needed; do not couple public content routes to product-auth bootstrap assumptions.

This keeps Step 4 focused on the product surface users need first, while leaving room for a separate public site later without forcing a rewrite.

## Step 0: Lock The Pre-Implementation Boundary

### Product-app-first architecture

Decision for this plan:

- build the product app first
- keep any future public site separate
- do not treat Step 4 as a combined product app plus marketing/blog/docs effort

Default implementation direction for the product app:

- new `apps/web`
- client-rendered React app
- SPA shell by default

This can be revisited later if there is a stronger reason to adopt a server-rendered or hybrid product-app shell, but it is not a blocker for starting Step 4.

### Browser OAuth callback contract

This is the one material item that should still be confirmed before implementation begins.

Current behavior:

- `GET /auth/google/callback` in `apps/api/src/routes/auth.ts` returns `{ token, expiresAt }` JSON directly.

Why this matters:

- A browser app needs a deliberate callback contract: redirect into the frontend with a safe handoff, or a frontend-owned code exchange flow.
- If we start frontend implementation without locking this, the first auth slice will likely be thrown away.

Recommended direction:

- Keep the API as the OAuth integrator, but change the callback flow so the API redirects to a frontend callback route and hands off a short-lived code or other bounded token-exchange primitive.
- Avoid baking raw JWT JSON responses from the OAuth callback directly into the browser flow.

The rest of this plan assumes that this callback contract is resolved before Step 2 begins.

## Recommended Product-App Shape

Chosen default:

- create a new `apps/web` package as a client-rendered React app
- prefer a simple SPA shell unless there is a separate product-app reason to require SSR

Why this is the chosen recommendation:

- the current backend is already an API-first JWT service
- there is no existing frontend stack to preserve
- the early product need is authenticated app UX and resource orchestration, not a combined product-and-content platform

If a server-rendered framework is later preferred for the product app itself, the rest of the plan still applies, but the file list will change.

## Performance Constraints

This phase should explicitly optimize for low-end devices and higher-latency networks.

- Keep the initial JS payload small.
- Avoid chart-heavy or animation-heavy first loads.
- Avoid startup waterfalls across auth bootstrap and the first signed-in home.
- Make the first useful screen text-first and summary-first.
- Lazy-load heavier detail surfaces.
- Treat weak phones and unreliable networks as a first-class target, not an afterthought.

## First Shippable Slice

The first shippable slice of Step 4 should be narrower than the full phase.

It should include:

1. auth bootstrap and callback handling
2. first-run setup
3. Mission Control home
4. one trading-instance detail page
5. the minimum resource-creation flows needed to reach those screens

It should not require:

- a public marketing/blog/docs surface
- a full design system
- advanced charting
- every possible management screen before the first signed-in experience is usable

## Implementation Order

### 1. Scaffold the frontend app and monorepo integration

Primary files:

- new `apps/web/package.json`
- new `apps/web/tsconfig.json`
- new `apps/web/src/main.tsx`
- new `apps/web/src/app/App.tsx`
- new `apps/web/src/app/router.tsx`
- new `apps/web/src/app/layout/*`
- root `tsconfig.json`

Changes:

- Add the new frontend workspace package.
- Add root TypeScript project reference(s) for the new app.
- Create the base app shell, router, route layout, error boundary, and loading boundary.
- Add a single place for frontend runtime config such as API base URL and auth callback path.
- Keep the product-app route tree clean and avoid mixing in future public-site concerns.

Dependency:

- Depends on resolving Step 0.

### 2. Make the API browser-facing and resolve the auth browser contract

Primary files:

- `apps/api/src/routes/auth.ts`
- `apps/api/src/index.ts`
- `apps/api/src/config.ts`
- `packages/domain/src/config/schema.ts`
- `config/default.yaml`
- `apps/api/package.json`

Changes:

- Add explicit frontend-origin config and browser-facing API origin policy.
- Register CORS handling for the frontend origin(s).
- Replace the current JSON-only OAuth callback behavior with the agreed browser callback handoff.
- Keep auth verification and ownership logic in the API; do not move trust decisions into the frontend.

Dependency:

- Depends on the callback decision above.
- Must land before frontend auth bootstrap is implemented.

### 3. Add composite read models for the mission-control homepage

Primary files:

- new `apps/api/src/routes/dashboard.ts` or `apps/api/src/routes/frontend.ts`
- `apps/api/src/index.ts`
- `apps/api/src/schemas.ts`
- existing route or repository helpers under `packages/db/src/**` only if the current repository surface is too low-level

Changes:

- Add a user-scoped overview endpoint that combines the data needed for the first signed-in screen.
- Add a normalized activity-feed endpoint that composes journal, live-status, and reconciliation surfaces into one user-facing timeline shape.
- Add an outcome/exposure summary endpoint when the current positions endpoints are too raw or too fragmented for the frontend.
- Add a plan-summary endpoint or extend `GET /auth/me` so the frontend can display current plan and relevant limits without hardcoding plan semantics.
- Optimize these read models for the first signed-in screen so the frontend does not need a slow startup waterfall.

Design rule:

- Prefer thin composite read models for the homepage and detail drawer instead of making the frontend orchestrate large fan-out request graphs.
- Keep ownership checks at the route boundary.

Dependency:

- Depends on Step 2.

### 4. Build shared frontend auth, session, and API infrastructure

Primary files:

- new `apps/web/src/lib/api-client.ts`
- new `apps/web/src/lib/session.ts`
- new `apps/web/src/features/auth/*`
- new `apps/web/src/app/providers/*`
- new `apps/web/src/app/routes/auth-callback.tsx`

Changes:

- Add token/session storage and authenticated API request helpers.
- Implement login bootstrap, auth callback handling, logout, and `GET /auth/me` hydration.
- Add a guarded app shell that distinguishes unauthenticated, loading, and authenticated states.
- Keep plan/user identity in one typed frontend session model.
- Keep first-load bootstrap lean enough that auth plus app init does not become a long startup waterfall.

Dependency:

- Depends on Step 2.

### 5. Implement the initial product-management flows needed to make Mission Control usable

Primary files:

- new `apps/web/src/features/portfolios/*`
- new `apps/web/src/features/credentials/*`
- new `apps/web/src/features/venue-accounts/*`
- new `apps/web/src/features/trading-instances/*`
- optional small API additions in `apps/api/src/routes/accounts.ts`, `apps/api/src/routes/credentials.ts`, and `apps/api/src/routes/instances.ts` only if UX blockers appear

Changes:

- Build the minimum create/list flows for portfolios, credentials, venue accounts, and trading instances.
- Support instance start, stop, and config-update flows from the UI.
- Surface plan-limit failures and ownership failures cleanly.

Why this is part of Step 4:

- Mission Control without the ability to create or manage the user’s first resources will not be a usable product surface.

Dependency:

- Depends on Steps 3 and 4.

### 6. Build the agent-first signed-in Mission Control surfaces

Primary files:

- new `apps/web/src/features/mission-control/*`
- new `apps/web/src/features/activity/*`
- new `apps/web/src/features/outcomes/*`
- new `apps/web/src/features/exposure/*`
- new `apps/web/src/features/health/*`

Changes:

- Implement the first signed-in homepage as Mission Control, not a trader terminal.
- Build:
  - Agent Overview cards
  - Activity Feed
  - Outcome Board
  - Portfolio / Exposure view
  - Health / Safety strip
- Use plain-language labels and avoid leading with exchange-native jargon.
- Make the detail drawer and activity items map to canonical concepts from `docs/tech/agents/message-catalog.md`: status, decision acceptance/rejection, plan lifecycle, execution result, guardrail outcome, and reconciliation notice.
- Keep the first load intentionally light enough for weaker phones and high-latency networks.

Dependency:

- Depends on Steps 3 and 4.

### 7. Add instance detail and timeline surfaces that are compatible with the future agent runtime

Primary files:

- new `apps/web/src/features/instances/detail/*`
- new `apps/web/src/features/timeline/*`
- possible API additions in the new composite route module from Step 3

Changes:

- Build an instance detail view that combines current status, live readiness, open positions, recent fills, and recent events.
- Normalize timeline/event cards around canonical concepts rather than current backend implementation details.
- Keep the UI terminology compatible with future `agent`, `bot`, `user`, and `system` provenance fields.
- Do not invent a fake agent model in storage yet; stay compatible with the existing user-owned resources and the agent docs.

Dependency:

- Depends on Step 6.
- Should be implemented with the unresolved Phase 5d relationship modeling question in mind.

### 8. Harden the frontend for product use and developer iteration

Primary files:

- `apps/web/src/app/*`
- `apps/web/src/lib/*`
- `apps/web/package.json`
- root `package.json` only if new workspace scripts are needed

Changes:

- Add consistent empty, loading, error, and retry states.
- Add typed API adapters and response normalization to avoid leaking transport quirks into UI components.
- Add local developer scripts and documentation for running API + web together.
- Add minimal telemetry or logging hooks for auth failures and request failures if desired.
- Document the product-app boundary in the app README or local docs so later public-site work does not erode it accidentally.

Dependency:

- Depends on the earlier frontend slices being in place.

## Public Site Separation Note

Public site, blog, and public docs are intentionally out of scope for this plan.

When they are added later, the default recommendation is:

- keep `apps/web` as the authenticated product app
- add a separate public-site app later
- share branding or design tokens only where useful
- keep product auth, session state, and product routing separate from public-content routing

This is the documented boundary that keeps later public-site work from forcing a redesign of the Step 4 product app.

## Primary Backend Surfaces This Plan Builds On

Existing route files already useful to the frontend:

- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/accounts.ts`
- `apps/api/src/routes/credentials.ts`
- `apps/api/src/routes/instances.ts`
- `apps/api/src/routes/views.ts`
- `apps/api/src/routes/live-status.ts`
- `apps/api/src/routes/reconciliation.ts`
- `apps/api/src/routes/backtests.ts`

Existing canonical design references the frontend must align to:

- `docs/features/2026/06/phase-5e-frontend-dashboard/000-frontend-q-and-a.md`
- `docs/tech/agents/runtime-boundary-and-message-contract.md`
- `docs/tech/agents/message-catalog.md`
- `docs/tech/agents/recovery-and-replay.md`
- `docs/tech/agents/tool-access-and-sandboxing.md`

## Risks And Open Questions

1. **Browser auth callback design is not settled yet.** This is the main pre-implementation decision.
2. **Current API is resource-oriented, not Mission-Control-oriented.** Without composite read models, the frontend will become over-coupled to many low-level endpoints.
3. **Agent, bot, and user relationship modeling is still partially open in Phase 5d.** Frontend naming and navigation should not hardcode a storage model that later becomes wrong.
4. **The current API config does not yet expose browser-origin policy.** That needs to be explicit before a separate web app can run cleanly.
5. **If a public site is added later, boundary drift is the main risk.** Keep product-app auth/bootstrap and public-content concerns separate.

## Test Strategy

### Unit tests

Frontend unit tests should cover:

- auth callback parsing and session persistence
- API client token injection and failure handling
- DTO-to-view-model normalization for Mission Control and timeline surfaces
- component behavior for loading, empty, blocked, degraded, and error states

Backend unit tests should cover:

- Mission Control composite endpoint shaping
- plan-summary calculations if a new summary endpoint is added
- auth callback handoff helpers if the OAuth browser flow changes

### Integration tests

Backend integration tests should cover:

- OAuth browser callback handoff behavior
- CORS/origin policy for the frontend origin
- ownership scoping for all new composite frontend endpoints
- plan-limit and live-readiness responses as surfaced to Mission Control
- startup behavior across auth bootstrap plus initial homepage fetches

Frontend integration tests should cover:

- login → callback → authenticated app bootstrap
- create/list/start/stop flows for the minimum managed resources
- Mission Control hydration using realistic API responses

### Visual verification

Because the repo currently has no frontend test harness, visual verification should be part of the first implementation pass.

Verify at minimum:

- signed-out landing/login state
- callback and session bootstrap state
- first-use empty Mission Control state
- populated Mission Control state with multiple instances
- instance health and degraded/error states
- mobile and desktop layout behavior
- weak-network and low-end-device behavior

## Exit Criteria

Step 4 is complete when:

1. a new authenticated frontend app exists in the monorepo,
2. a user can sign in and land in a usable Mission Control home,
3. the product app exposes overview, activity, outcome, exposure, and health surfaces,
4. the user can manage the minimum resources needed to use the product without direct API calls, and
5. the UI contract stays aligned with the canonical agent documents rather than inventing a divergent frontend-only model, and
6. the product-app boundary is clean enough that a public site can be added later without restructuring the signed-in app.
