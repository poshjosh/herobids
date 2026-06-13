# Plan: Admin Dashboard v1

## Goal

Add the first internal admin dashboard for Herobids.

This feature is standalone. It is not a child of the usage-billing feature.
Billing and usage are only one section of the dashboard, alongside platform
health, users, runtimes, and resources.

The purpose of v1 is operational clarity, not completeness. It should give an
admin one place to answer a small set of practical questions quickly:

1. is the platform up and healthy
2. who are the users and which plans or roles do they have
3. what runtimes or containers are currently active
4. are there obvious billing-provider issues to investigate
5. what machine and runtime resources are currently in use

## Objective

Ship a strict v1 that follows the earlier table boundary:

1. implement the rows marked `Yes`
2. implement only the `Low-effort Partial` rows
3. explicitly defer the `Medium`, `High`, and `No` rows to later phases

That means this plan is intentionally narrower than a full operator console. It
does not try to solve cross-user commercial analytics, deep runtime
orchestration, or broad support workflows in the first release.

## Product Principles

1. keep v1 read-heavy and operationally safe
2. prefer existing backend routes and tables over new domain concepts
3. add small aggregations where they are obviously low effort
4. do not let the billing subsection dominate the dashboard
5. keep support mutations very narrow in v1
6. do not promise cross-user financial or runtime analytics that require medium
   complexity joins or new audit machinery

## V1 Information Architecture

### 1. Overview

Purpose:

- give the admin a fast health and status snapshot

V1 content:

1. Postgres status
2. Redis status
3. API version
4. total users
5. total agents
6. total bots
7. running runtime session count
8. running container count
9. failed billing webhook count
10. new users in the recent window
11. new agents in the recent window

### 2. Users and Accounts

Purpose:

- give the admin a simple support view of users and roles

V1 content:

1. email
2. display name
3. created date
4. plan
5. admin status
6. agent count
7. bot count
8. admin actions: promote to admin, revoke admin
9. optional low-risk plan override if support flow needs it immediately

### 3. Billing and Usage

Purpose:

- give the admin a minimal billing-operations surface without pulling the whole
  dashboard into usage-billing scope

V1 content:

1. failed webhook count on overview
2. failed webhook list for investigation
3. provider event type, processing status, error text, and processed time

V1 exclusions for this section:

1. cross-user current-period spend by user
2. top spenders
3. by-meter commercial breakdowns
4. hard-limited or soft-limited account dashboards
5. cross-user usage-event tables

### 4. Agents and Runtime

Purpose:

- show what is currently active in the runtime layer using the lowest-risk
  existing signals

V1 content:

1. running container list
2. associated running session records already exposed by admin APIs
3. session CPU percent
4. session memory bytes
5. lightweight running counts surfaced in Overview

V1 exclusions for this section:

1. full global agent inventory with owner and model metadata
2. cross-user session history explorer
3. unhealthy-session analytics
4. stop or restart runtime controls

### 5. Resources

Purpose:

- expose immediate host and runtime resource usage

V1 content:

1. total memory
2. free memory
3. used memory
4. total disk
5. free disk
6. used disk
7. session CPU percent
8. session memory bytes

V1 exclusions for this section:

1. host CPU telemetry
2. container memory-limit introspection
3. resource-cost overlays by agent

## Confirmed V1 Scope

The following list is the intended implementation boundary for v1.

### Yes rows included

1. Postgres status
2. Redis status
3. API version
4. total users
5. total agents
6. total bots
7. user list with email, display name, created date, plan, and admin status
8. per-user agent count
9. per-user bot count
10. promote admin
11. revoke admin
12. running container list
13. host memory totals
14. host disk totals
15. session CPU percent
16. session memory bytes

### Low-effort partial rows included

1. running runtime session count
2. running container count headline
3. failed webhook list and count
4. new users in recent window
5. new agents in recent window
6. optional plan override route and UI entry point if needed immediately

### Explicitly deferred from v1

1. active runtime session count per user
2. billing-account status per user
3. usage-billing account status dashboards
4. current-period spend by user
5. usage breakdown by meter
6. top-spending users, agents, and skills
7. cross-user usage-event drill-down
8. global agent inventory with owner, status, skills, and last activity
9. active session history across all users
10. unhealthy or orphaned-session dashboards
11. billing-account suspend or reactivate actions
12. spend-cap override actions
13. manual credit grants or manual ledger adjustments
14. runtime stop or restart controls
15. admin-action audit system

## Current-State Baseline

The strict v1 aligns with the backend surface that already exists or is very
close to existing:

1. `apps/api/src/routes/admin.ts` already exposes platform stats, user listing,
   running containers, and admin promotion or revocation
2. `users.isAdmin` and the existing admin pre-handler already establish the
   basic auth boundary for internal routes
3. billing webhook rows already exist in the database, which makes a failed
   webhook list a low-effort extension
4. runtime-session CPU and memory are already persisted and already surfaced
   through admin container responses
5. host memory and disk stats are already returned by the existing admin stats
   route

## Scope

### In scope

1. a dedicated admin dashboard UI in `apps/web`
2. reuse of existing admin APIs where possible
3. narrow admin API extensions for low-effort aggregates
4. failed billing webhook listing
5. recent-window counts for new users and new agents
6. optional low-risk plan override support

### Out of scope

1. cross-user commercial usage analytics
2. cross-user billing-account operations beyond optional plan override
3. rich agent observability across all users
4. runtime orchestration controls
5. broad support tooling and audit workflows
6. any new domain model that exists only to support the dashboard

## Backend Plan

### Route strategy

Use the existing `/admin/*` namespace and keep v1 compact.

Recommended approach:

1. extend `GET /admin/stats` for the new low-effort headline counts
2. extend `GET /admin/users` only if the extra fields remain low-risk and cheap
3. keep `GET /admin/containers` as the main runtime detail primitive
4. add one small billing-webhook inspection route
5. add plan override only if support pressure justifies it immediately

### Recommended v1 routes

1. `GET /admin/stats`
   - keep existing health, memory, disk, and core counts
   - add running runtime session count
   - add running container count
   - add failed billing webhook count
   - add recent new-user count
   - add recent new-agent count

2. `GET /admin/users`
   - keep existing identity, plan, admin flag, bot count, and agent count
   - do not add medium-complexity billing or runtime joins in v1

3. `GET /admin/containers`
   - keep existing container and running-session data
   - optionally add a simple container count if useful to the UI

4. `GET /admin/billing/webhooks`
   - return webhook rows with status, event type, processed time, and error
   - default filter should emphasize `failed` rows

5. `POST /admin/users/:id/promote`
   - keep existing behavior

6. `DELETE /admin/users/:id/admin`
   - keep existing behavior

7. optional `PATCH /admin/users/:id/plan`
   - only if support needs it now
   - keep the route narrow and explicitly audited in logs

## Frontend Plan

### Page structure

Create a standalone admin dashboard entry in `apps/web` with five sections:

1. Overview
2. Users and Accounts
3. Billing and Usage
4. Agents and Runtime
5. Resources

### UI shape

Prefer cards plus simple tables.

1. Overview: compact stat cards
2. Users and Accounts: one table with lightweight admin actions
3. Billing and Usage: failed-webhook table only in v1
4. Agents and Runtime: container plus session table from existing admin data
5. Resources: memory and disk cards, plus CPU or memory columns already present
   on runtime rows

### UX constraints

1. do not add charting in v1
2. do not add complex filters in v1
3. do not hide the narrow scope; label missing deeper tooling as future work
4. keep the page useful even when Docker data is unavailable

## Detailed Delivery Plan

### Phase 1. Backend baseline cleanup

Outcome:

- the existing admin endpoints cleanly support the v1 dashboard payloads

Steps:

1. extend `GET /admin/stats` with running-session, running-container, failed
   webhook, new-user, and new-agent counts
2. add `GET /admin/billing/webhooks`
3. decide whether plan override is in scope now; if not, leave it out of v1
4. add focused route tests for the new read models and admin auth

### Phase 2. Admin dashboard UI

Outcome:

- admins can use a dedicated internal UI instead of raw endpoints

Steps:

1. add admin page scaffolding in `apps/web`
2. render Overview from `GET /admin/stats`
3. render Users and Accounts from `GET /admin/users`
4. render Billing and Usage from `GET /admin/billing/webhooks`
5. render Agents and Runtime plus Resources from `GET /admin/containers` and
   `GET /admin/stats`
6. wire promote and revoke admin actions
7. wire plan override only if Phase 1 included it

### Phase 3. Hardening

Outcome:

- the dashboard is safe and stable enough for routine internal use

Steps:

1. add loading, empty, and subsystem-unavailable states
2. add pagination where a table can grow materially
3. ensure all admin routes are explicitly guarded by admin auth
4. validate with `pnpm lint`

## Non-Goals

Do not include these in this plan's first version:

1. cross-user usage-billing summary dashboards
2. spend-cap controls
3. billing-account suspension or reactivation
4. manual credit grants
5. manual ledger adjustments
6. top-spender rankings
7. global agent detail explorer
8. runtime lifecycle controls
9. host CPU collection
10. durable admin-action audit product

## Exit Criteria

1. an admin can open one dedicated page and see platform health, user basics,
   runtime basics, billing webhook failures, and system resources
2. the v1 implementation stays inside the `Yes` plus `Low-effort Partial`
   boundary
3. no medium-effort cross-user billing analytics are required for completion
4. all new routes remain inside the existing admin auth model
5. focused tests cover new route auth and the low-effort aggregate fields

## Risks

1. the dashboard could drift back into a billing-first or observability-first
   project unless the v1 boundary is enforced explicitly
2. even low-effort aggregates can become noisy if the recent-window definition
   is not standardized clearly
3. a plan override route, if included, increases support power without a durable
   audit trail, so it should remain optional and narrow

## Open Decisions

1. should plan override be in v1, or remain out until a stronger audit story
   exists
2. what recent window should Overview use for new users and new agents
3. should failed billing webhooks show all rows by default, or only failed rows
   with a toggle to reveal processed events
