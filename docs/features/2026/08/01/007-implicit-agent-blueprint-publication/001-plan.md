## Plan: Implicit Agent Blueprint Publication On Start

**Status:** Proposed
**Scope:** Automatically create/publish or refresh an agent-linked blueprint when an agent starts, and close the missing frontend blueprint API-client methods needed to call the existing blueprint lifecycle endpoints.

**TL;DR:** Keep blueprint UX hidden. On `POST /agents/:id/start`, ensure the agent has a linked published blueprint that reflects its current authored config and skill set. Reuse the existing projection and publish flows, skip revision churn when nothing changed, and add the missing `blueprints.*` client helpers so existing and future internal callers stop using ad hoc `fetch` calls.

---

## Current Code Truth (verified)

1. **The start route only starts the agent today.** `apps/api/src/routes/agents.ts` forwards `POST /agents/:id/start` directly to `startAgent(db, id, userId)` and returns `202` when that succeeds.

2. **`startAgent()` is the narrow orchestration seam.** `apps/api/src/services/agent-lifecycle-service.ts` atomically validates ownership/status/model selection, flips `stopped -> starting`, and inserts a runtime session. It currently has no blueprint side effects.

3. **A draft-from-agent path already exists.** `POST /agents/:id/blueprints` in `apps/api/src/routes/agents.ts` loads the owned agent, projects it through `projectAgentToBlueprintPayload()`, copies ordered `agentSkills`, and creates a brand new draft blueprint plus revision 1.

4. **Blueprint publishing already exists.** `POST /blueprints/:id/publish` in `apps/api/src/routes/blueprints.ts` validates ownership and lifecycle, requires `expectedCurrentRevisionId`, and moves `currentRevisionId` into `publishedRevisionId`.

5. **Agents already have blueprint linkage columns.** `packages/db/src/schema/agents.ts` includes `blueprintId` and `blueprintRevisionId`, but the draft-from-agent route does not currently populate them.

6. **The existing projection is reusable.** `apps/api/src/services/blueprint-projection.ts` already defines the authored agent-to-blueprint projection and strips runtime-only state.

7. **The frontend blueprint API client is incomplete.** `apps/web/src/lib/api-client.ts` exposes `browse`, `get`, `create`, `createRevision`, `createFromAgent`, `createFromBot`, `previewInstantiation`, and `instantiate`, but is missing `publish`, `delist`, `like`, `unlike`, and `fork`.

8. **At least one UI already bypasses the API client.** `apps/web/src/features/blueprints/BlueprintDetailPage.tsx` uses raw `fetch()` for publish/delist/archive/delete instead of `api-client.ts`, which is a symptom of the missing methods.

9. **The requested client contract has two mismatches with the backend today.**
   - The backend like route is `PUT /blueprints/:id/like` and `DELETE /blueprints/:id/like`, not `POST`.
   - The backend fork route requires an `Idempotency-Key` header and optional request body, so `blueprints.fork(id)` is underspecified unless the client generates the key internally.

---

## Goals

1. Starting an agent implicitly ensures there is a published blueprint representing its current authored config.
2. Repeated starts do not create duplicate blueprints or unnecessary revisions when the authored config and skill set are unchanged.
3. Blueprint sync remains implicit; no new user-facing blueprint flow is required for this feature.
4. The frontend API client covers the existing blueprint lifecycle endpoints so internal callers can stop using raw `fetch()`.
5. Tests pin the no-op, first-publish, and changed-config revision flows.

## Non-Goals

1. Do not add new blueprint UI entry points or expose blueprint authoring as a primary workflow.
2. Do not redesign blueprint ranking, browse, or marketplace presentation.
3. Do not add new blueprint schema columns if payload comparison can solve the change-detection problem.
4. Do not change agent runtime launch semantics beyond the new implicit blueprint sync side effect.

---

## Proposed Design

### Change 1 — Add an internal `ensurePublishedBlueprintForAgent()` service

**Files:**
- `apps/api/src/services/agent-blueprint-sync-service.ts` (new)
- `apps/api/src/services/blueprint-projection.ts` (reuse, not redesign)

**What:**
Create a small internal service that:

1. Loads the full owned agent row and ordered skill references.
2. Projects the current authored blueprint payload via `projectAgentToBlueprintPayload(agent)`.
3. Builds a deterministic fingerprint from:
   - projected payload
   - ordered skill refs (`skillId`, `skillRevisionId`)
4. If the agent has no linked blueprint:
   - create a draft blueprint from the projected payload
   - publish it immediately
   - persist `agents.blueprintId` and `agents.blueprintRevisionId`
5. If the agent already has a linked blueprint:
   - load its current revision and current skill refs
   - compute the existing revision fingerprint from stored revision payload + skill refs
   - if fingerprints match:
     - no new revision
     - if the linked blueprint is not currently `published`, republish the current revision
   - if fingerprints differ:
     - create a new revision on the linked blueprint
     - publish the new current revision
     - update `agents.blueprintRevisionId`

**Why this shape:**
- It reuses current blueprint routes/service logic instead of duplicating publish semantics inside the start route.
- It avoids schema churn by deriving hashes on the fly from canonical data.
- It gives a clean idempotent rule: “same authored agent config + same skills = no new revision.”

### Change 2 — Invoke blueprint sync from the agent start flow

**Files:**
- `apps/api/src/services/agent-lifecycle-service.ts`
- possibly `apps/api/src/routes/agents.ts` only if dependency wiring needs adjustment

**What:**
Call `ensurePublishedBlueprintForAgent()` during `startAgent()` after the agent has been successfully claimed but before returning success.

**Recommended transaction shape:**
- Keep the existing `stopped -> starting` claim atomic.
- Run blueprint sync in the same service flow immediately after claim success.
- If blueprint sync fails, fail the start request loudly and revert the claim within the same request path rather than silently starting the agent with stale marketplace state.

**Reasoning:**
- The feature requirement is “on start, publish/update blueprint by default,” not “best effort.”
- Loud failure matches repo guidance better than hidden drift between agent config and published blueprint.

### Change 3 — Reuse existing publish semantics instead of inventing a parallel shortcut

**Files:**
- `apps/api/src/services/agent-blueprint-sync-service.ts`
- `apps/api/src/routes/blueprints.ts` (extract helper only if it reduces duplication cleanly)

**What:**
Do not hand-roll publish updates in the new service. Either:

1. extract a shared internal helper for “publish current revision,” or
2. mirror the route’s existing validation and update sequence in one private service.

The key invariant is that the sync path must still:
- validate the expected current revision
- move `currentRevisionId` to `publishedRevisionId`
- stamp `publishedAt`
- copy revision facets to the blueprint row

### Change 4 — Fill the blueprint frontend API-client gaps

**Files:**
- `apps/web/src/lib/api-client.ts`

**What:**
Add the missing methods for the already-existing backend endpoints:

1. `blueprints.publish(id, { expectedCurrentRevisionId })`
   - `POST /blueprints/:id/publish`
2. `blueprints.delist(id)`
   - `POST /blueprints/:id/delist`
3. `blueprints.like(id)` / `blueprints.unlike(id)`
   - match the actual backend contract unless backend is changed first
4. `blueprints.fork(...)`
   - include idempotency handling in the client wrapper

**Recommended client signatures:**

```ts
publish: (id: string, body: { expectedCurrentRevisionId: string }) => Promise<BlueprintDetail>
delist: (id: string) => Promise<{ id: string; publicationStatus: string; delistedAt: string | null; updatedAt: string }>
like: (id: string) => Promise<{ liked: boolean; likeCount: number }>
unlike: (id: string) => Promise<{ liked: boolean; likeCount: number }>
fork: (id: string, body?: { revisionId?: string; edits?: Record<string, unknown> }, idempotencyKey?: string) => Promise<...>
```

### Change 5 — Replace ad hoc blueprint fetch calls where practical

**Files:**
- `apps/web/src/features/blueprints/BlueprintDetailPage.tsx`

**What:**
Once the client helpers exist, switch `BlueprintDetailPage` off raw `fetch()` for publish/delist and other lifecycle actions it already exposes.

**Why include this in plan:**
- It verifies the new helpers are actually usable.
- It shrinks duplicated auth/header/error handling.
- It prevents `api-client.ts` from remaining dead surface.

### Change 6 — Add focused tests around the implicit sync behavior

**Files:**
- `apps/api/src/services/agent-lifecycle-service.test.ts` or a new `agent-blueprint-sync-service.test.ts`
- `apps/api/src/__tests__/functional/agents.functional.test.ts`
- `apps/web/src/lib/api-client.test.ts` if a client test harness exists; otherwise cover via compile-time usage in UI

**Minimum cases:**

1. **First start with no linked blueprint**
   - creates draft + publishes it
   - stores `agents.blueprintId` and `agents.blueprintRevisionId`
2. **Second start with unchanged authored config**
   - does not create a new revision
   - keeps the linked published revision
3. **Second start after authored config change**
   - creates a new revision
   - republishes current revision
   - updates `agents.blueprintRevisionId`
4. **Linked blueprint exists but is delisted/private/draft**
   - start republish behavior is explicit and tested
5. **Client helper coverage**
   - `api-client.ts` compiles and callers can use publish/delist/like/unlike/fork without raw `fetch()`

---

## Open Questions

1. **Like method contract:** should the frontend client follow the existing backend route (`PUT /blueprints/:id/like`) or should the backend be normalized to `POST` first? The plan assumes “follow the backend as-is unless there is a separate API-normalization task.”

2. **Fork method signature:** should `blueprints.fork()` auto-generate the idempotency key when none is provided, or should callers always supply one explicitly? Auto-generation is simpler for UI callers.

3. **Reuse of `agents.blueprintId` / `blueprintRevisionId`:** these columns already exist and are the simplest linkage mechanism, but they currently read like provenance fields (“agent came from blueprint”). If that semantic distinction matters, introduce separate “implicit published blueprint” linkage fields instead. If simplicity wins, reuse the existing columns.

4. **Failure policy on start:** this plan recommends failing the start if blueprint sync fails. If product wants “agent start succeeds even when marketplace sync fails,” that needs explicit acceptance because it weakens the invariant.

---

## Implementation Order

1. Add the internal agent-blueprint sync service and fingerprint comparison.
2. Wire blueprint sync into `startAgent()` with loud-failure behavior.
3. Reuse/extract publish logic so start-path publishing matches the route contract.
4. Add the missing `blueprints.*` methods to `apps/web/src/lib/api-client.ts`.
5. Migrate `BlueprintDetailPage` lifecycle calls to the API client.
6. Add targeted tests for first publish, unchanged restart, changed restart, and client usage.
7. Run `pnpm lint` and the narrow API/frontend tests that cover the touched areas.

---

## Acceptance Criteria

1. Starting an owned stopped agent with no blueprint linkage leaves the agent in `starting` status and produces a linked published blueprint.
2. Restarting the same agent without authored config changes does not create a new blueprint revision.
3. Restarting after prompt/risk/strategy/skill changes creates exactly one new revision and republishes it.
4. `apps/web/src/lib/api-client.ts` exposes publish, delist, like, unlike, and fork helpers aligned with the actual backend contract.
5. Existing blueprint UI surfaces can use the shared client methods without raw lifecycle `fetch()` calls.
