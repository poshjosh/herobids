# Phase 5c: Broad Auth (Multi-User, OAuth, Plans)

## Objective

Replace the current trusted-caller model with authenticated multi-user access, OAuth sign-in, ownership-guarded resources, and plan-aware limits. Keep scope tight: identity, sessions, route protection, ownership, and coarse plan enforcement. Billing, advanced RBAC, and frontend UX remain later steps.

## Implementation Order

### 1. Extract shared config loading and add auth/plan config

Primary files:
- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/index.ts`
- `config/default.yaml`
- `apps/worker/src/config.ts`
- `apps/api/src/index.ts`
- new shared loader location or `apps/api/src/config.ts`

Changes:
- Stop expanding direct `process.env` reads inside the API. Either extract `loadConfig()` from `apps/worker/src/config.ts` into a shared module or add an equivalent API config loader using the same `AppConfigSchema`.
- Add an `auth` config section for: public base URL, cookie/JWT TTLs, secure-cookie flags, OAuth provider settings, and allowed callback origins.
- Add a `plans` config section for operator-defined plan IDs and coarse limits such as max portfolios, max trading instances, max concurrent backtests, and whether live mode is allowed.

Dependency:
- First. Broad auth will otherwise add more unstructured env reads to a code path that already bypasses the config guidelines.

### 2. Add identity, session, and plan schema; backfill current ownership data

Primary files:
- `packages/db/src/schema/users.ts`
- `packages/db/src/schema/oauth-identities.ts`
- `packages/db/src/schema/sessions.ts`
- `packages/db/src/schema/user-plans.ts`
- `packages/db/src/schema/credentials.ts`
- `packages/db/src/schema/venue-accounts.ts`
- `packages/db/src/schema/portfolios.ts`
- `packages/db/src/schema/trading-instances.ts`
- `packages/db/src/schema/backtest-runs.ts`
- `packages/db/src/schema/replay-corpora.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/index.ts`
- `packages/db/drizzle/` (new migration)

Changes:
- Add canonical `users`, `oauth_identities`, `sessions`, and `user_plans` tables.
- Convert the existing free-form `user_id` owner columns into real foreign keys to `users.id`.
- Add `userId` ownership to backtesting resources that are currently unowned (`backtest_runs`, `replay_corpora`) so Step 3 does not ship a cross-user data leak.
- Write a migration that first creates users for existing distinct `user_id` values, then backfills FKs, and only then enforces the new constraints.

Dependency:
- Required before route protection and owner-scoped queries.

### 3. Add the API auth plugin and session flows

Primary files:
- new `apps/api/src/auth.ts` or `apps/api/src/plugins/auth.ts`
- new `apps/api/src/routes/auth.ts`
- `apps/api/src/types.ts`
- `apps/api/src/index.ts`

Changes:
- Register cookie/session/JWT support in Fastify and decorate requests with the authenticated user and active plan.
- Add OAuth start/callback/logout/me routes.
- Store durable session state in the new `sessions` table so logout and session revocation work across API restarts.
- If rollout safety requires it, keep a short-lived operator bypass behind config. Otherwise remove the implicit trusted-caller model in the same step.

Dependency:
- Depends on steps 1 and 2.

### 4. Remove caller-supplied `userId` from public writes and enforce ownership everywhere

Primary files:
- `apps/api/src/schemas.ts`
- `apps/api/src/routes/accounts.ts`
- `apps/api/src/routes/instances.ts`
- `apps/api/src/routes/credentials.ts`
- `apps/api/src/routes/views.ts`
- `apps/api/src/routes/reconciliation.ts`
- `apps/api/src/routes/live-status.ts`
- `apps/api/src/routes/backtests.ts`
- `apps/api/src/credential-dependents.ts`

Changes:
- Remove `userId` from create schemas. The authenticated request context becomes the only source of owner identity.
- Scope all reads and writes by owner. For resource lookups by ID, return `404` or `403` without leaking whether another user owns the record.
- Keep ownership checks near the route boundary first; add a small shared helper only if route duplication becomes excessive.
- Leave internal helpers such as `findCredentialDependents()` internal-only and call them after auth/ownership checks succeed.

Dependency:
- Depends on the auth plugin and user-backed schema.

### 5. Add coarse plan enforcement at mutation boundaries

Primary files:
- new `apps/api/src/plan-guards.ts`
- `apps/api/src/routes/accounts.ts`
- `apps/api/src/routes/instances.ts`
- `apps/api/src/routes/backtests.ts`

Changes:
- Enforce plan limits on portfolio creation, venue account creation, credential creation, trading instance creation, live-mode start, corpus import, and backtest run creation.
- Read plan limits from operator config rather than hard-coding them.
- Keep the first version coarse. This step should gate feature access and quotas, not implement billing or metering.

Dependency:
- Depends on request auth context resolving the active plan from `user_plans`.

### 6. Scope backtesting and replay resources to users end-to-end

Primary files:
- `packages/db/src/backtesting-repository.ts`
- `apps/api/src/routes/backtests.ts`

Changes:
- Persist `userId` when importing corpora and creating backtest runs.
- Add owner-aware repository methods for get/list/report/journal lookups.
- Filter existing list endpoints so users only see their own corpora and backtest runs.

Dependency:
- Depends on the Step 2 schema migration for `backtest_runs` and `replay_corpora`.

### 7. Update route tests and add auth-specific coverage

Primary files:
- `apps/api/src/routes/accounts.test.ts`
- `apps/api/src/routes/credentials.test.ts`
- `apps/api/src/routes/live-status.test.ts`
- new `apps/api/src/routes/instances.test.ts`
- new `apps/api/src/routes/backtests.test.ts`
- new `apps/api/src/routes/auth.test.ts`

Changes:
- Update existing route tests so they inject an authenticated user instead of passing `userId` in request bodies.
- Add coverage for unauthenticated `401`, cross-user `404/403`, ownership filtering on reads, and plan-limit failures on writes.
- Add focused tests for OAuth callback/session issuance and session invalidation.

Dependency:
- Final step after route wiring changes.

## Risks And Open Questions

1. **Backfill strategy**: existing `userId` strings are arbitrary today. Decide whether they become seeded local users or temporary placeholders linked to OAuth identities later.
2. **Session transport**: cookie sessions are the better fit for a future dashboard; bearer JWTs are easier for CLI clients. Choose one primary mode before implementing both.
3. **Breaking API change**: removing request-body `userId` changes every write route contract. Decide whether to version routes or keep a short compatibility window.
4. **Backtesting ownership gap**: `backtest_runs` and `replay_corpora` currently have no owner field. If that is not fixed in this step, the first multi-user rollout will leak data.
5. **Plan scope creep**: keep plan enforcement to coarse quotas and feature flags. Billing and payment state are Step 5, not Step 3.

## Test Strategy

- Unit tests for config parsing, session issuance/verification, and plan-limit evaluation.
- Fastify route-integration tests for login callback, protected routes, owner scoping, and plan-guard failures.
- Repository and migration tests for user/session/plan tables, owner backfill, and owner-scoped backtesting queries.
- End-to-end smoke path: sign in, create a portfolio, create a venue account, create an instance, create a backtest run, and verify only owned resources are visible.