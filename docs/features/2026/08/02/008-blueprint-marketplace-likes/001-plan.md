## Plan: Blueprint Marketplace Access And Likes

**Status:** Proposed
**Scope:** Add dedicated blueprint marketplace entitlements for public viewing and liking, expose viewer like state in blueprint API responses, and wire like/unlike controls into the marketplace browse and detail UI.

**TL;DR:** The database, scoring, and like/unlike endpoints already exist. This slice adds dedicated plan entitlements for blueprint marketplace access and likes, enforces them in the API and UI, and adds the missing viewer-specific response contract (`isLikedByViewer`) plus interactive controls. Blueprint pricing is explicitly deferred into a separate research-and-design track that should cover both skills and blueprints/agents together.

---

## Current Code Truth (verified)

1. **Blueprint like storage already exists.** `packages/db/src/schema/blueprint-likes.ts` defines `blueprint_likes` with one row per `(blueprintId, userId)`.

2. **Blueprint rows already denormalize like counts.** `packages/db/src/schema/blueprints.ts` includes `likeCount`, and `apps/api/src/services/blueprint-scoring.ts` refreshes that counter from `blueprint_likes`.

3. **The API already supports like and unlike writes.** `apps/api/src/routes/blueprints.ts` exposes:
   - `PUT /blueprints/:id/like`
   - `DELETE /blueprints/:id/like`

4. **Like writes already recompute ranking.** Both blueprint like routes call `refreshLikeCount()` and `recomputeBlueprintScores()`.

5. **The web API client already wraps those write endpoints.** `apps/web/src/lib/api-client.ts` already exports `blueprints.like(id)` and `blueprints.unlike(id)`.

6. **Blueprint read models do not expose viewer like state.** `packages/domain/src/blueprint.ts` defines `BlueprintSummarySchema` and `BlueprintDetailSchema` with `likeCount`, but no `isLikedByViewer` field.

7. **The blueprint browse and detail UI currently render likes as static text.**
   - `apps/web/src/features/blueprints/BlueprintBrowse.tsx`
   - `apps/web/src/features/blueprints/BlueprintDetailPage.tsx`

8. **Skills already implement the complete pattern.** Skills responses include `isLikedByViewer`, and `apps/web/src/features/skills/SkillsPage.tsx` already has the like/unlike mutation and button behavior needed as direct prior art.

9. **The current plan-entitlements model has no blueprint section.** `packages/domain/src/config/schema.ts`, `apps/api/src/plan-guards.ts`, `apps/web/src/lib/api-client.ts`, and `config/default.yaml` currently define skill entitlements and agent entitlements, but no blueprint-specific marketplace entitlements.

10. **Blueprint marketplace read routes are not currently plan-gated.** The published browse/detail flows in `apps/api/src/routes/blueprints.ts` currently enforce publication/lifecycle rules, but not plan-specific “can view marketplace blueprints” or “can like marketplace blueprints” checks.

11. **Blueprint pricing does not exist today.** There is no blueprint price field or pricing entitlement in the schema or routes, and Phase 1 blueprint portability explicitly rejects paid skill dependencies.

---

## Goal

1. Add dedicated plan entitlements for blueprint marketplace viewing and blueprint liking.
2. Enforce blueprint marketplace visibility consistently in API and UI.
3. Allow a signed-in user with blueprint-like entitlement to like and unlike published blueprints from the marketplace browse grid and the blueprint detail page, with correct viewer-state rendering and immediate UI feedback.

## Non-Goals

1. Do not redesign blueprint ranking or scoring formulas.
2. Do not add new blueprint browse filters such as `likedByMe` in this slice.
3. Do not add notifications, activity feeds, or author analytics for likes.
4. Do not implement blueprint pricing in this slice.
5. Do not redesign skill pricing in this slice.
6. Do not introduce paid blueprint portability or paid skill-in-blueprint support in this slice.

---

## Assumptions

1. Blueprint likes remain limited to `published` blueprints only.
2. Authors still cannot like their own blueprints.
3. The entitlement model will gain a dedicated `blueprints` section with:
   - `canViewMarketplaceBlueprints`
   - `canLikeMarketplaceBlueprints`
4. `canPriceBlueprints` is intentionally not added in this slice; pricing is deferred into a separate research-and-design follow-up.
5. The existing backend route contract stays as-is: like uses `PUT`, unlike uses `DELETE`.

If any of these assumptions change, the plan should be revised before implementation.

---

## Proposed Design

### Change 1 — Add dedicated blueprint marketplace entitlements

**Files:**
- `packages/domain/src/config/schema.ts`
- `config/default.yaml`
- `apps/api/src/plan-guards.ts`
- `apps/web/src/lib/api-client.ts`
- auth/me tests and any other plan-entitlement fixtures that mirror the shape

**What:**
Introduce a dedicated blueprint-entitlements section under plan entitlements:

```ts
blueprints: {
   canViewMarketplaceBlueprints: boolean;
   canLikeMarketplaceBlueprints: boolean;
}
```

**Why:**
- Blueprints are now a distinct marketplace surface and should not inherit access policy indirectly from skill entitlements.
- This keeps blueprint discoverability and engagement independently configurable without prematurely committing to blueprint pricing.

**Notes:**
- Admin bypass should grant both permissions.
- Operator config values in `config/default.yaml` should be added explicitly rather than inferred from skill settings.

### Change 2 — Enforce blueprint marketplace visibility in the API and UI

**Files:**
- `apps/api/src/routes/blueprints.ts`
- any shared blueprint page bootstrap or auth consumer used by the web frontend

**What:**
Use `canViewMarketplaceBlueprints` as the public-marketplace access gate for non-owner, non-admin blueprint interactions.

**Required route/action matrix:**

| Route / action | Marketplace entitlement requirement for non-owner, non-admin access | Notes |
|---|---|---|
| `GET /blueprints` browse | `canViewMarketplaceBlueprints` | This is the primary marketplace listing surface. |
| `GET /blueprints/:id` for published blueprint detail | `canViewMarketplaceBlueprints` | Direct-by-ID reads must not bypass marketplace access policy. |
| `POST /blueprints/:id/fork` from a published marketplace blueprint | `canViewMarketplaceBlueprints` | Fork-by-ID must not remain callable when marketplace viewing is disabled. |
| `PUT /blueprints/:id/like` | `canViewMarketplaceBlueprints` **and** `canLikeMarketplaceBlueprints` | A viewer cannot engage with a marketplace blueprint they are not entitled to view. |
| `DELETE /blueprints/:id/like` | `canViewMarketplaceBlueprints` **and** `canLikeMarketplaceBlueprints` | Same rule as like. |

**Out of scope for this slice unless already exposed as public marketplace actions in the blueprint routes:**
1. owner-only revision-management and lifecycle routes such as publish, draft, private, delist, archive, delete, and create-revision flows
2. preset/default helper routes that are not blueprint marketplace asset access paths

**Why:**
- Hiding the UI alone is insufficient; API access must enforce the same boundary.
- Otherwise users without marketplace entitlement could still reach published blueprints directly by ID.

**Implementation note:**
- Owner/admin reads of their own draft/private/published blueprints remain governed by existing lifecycle/ownership rules, not by marketplace-view entitlement.
- Treat the table above as exhaustive for this slice. If implementation discovers another non-owner public marketplace blueprint action, update the plan first rather than inferring policy ad hoc.

### Change 3 — Add viewer like state to blueprint read models

**Files:**
- `packages/domain/src/blueprint.ts`
- `apps/web/src/lib/blueprint-types.ts`

**What:**
Add `isLikedByViewer: boolean` to the shared blueprint summary/detail response contract.

**Why:**
The frontend cannot render a stable like button state from `likeCount` alone. It must know whether the current viewer has liked the blueprint.

**Notes:**
- `BlueprintDetailSchema` extends `BlueprintSummarySchema`, so adding the field once at the summary layer keeps the contract consistent.
- The frontend local types must mirror the domain change exactly.

### Change 4 — Load viewer like state in blueprint browse responses

**Files:**
- `apps/api/src/routes/blueprints.ts`

**What:**
In `GET /blueprints`, batch-load likes for the current viewer across the page of returned blueprint IDs and set `isLikedByViewer` per item.

**Recommended implementation shape:**
1. After the page rows are selected, collect the page blueprint IDs.
2. Query `blueprint_likes` for `userId = request.userId` and `blueprintId IN (...)`.
3. Build a `Set<string>` of liked blueprint IDs.
4. Include `isLikedByViewer: likedIds.has(bp.id)` in each `BlueprintSummarySchema.parse(...)` call.

**Why this shape:**
- It keeps the endpoint efficient with one extra query per page, not one query per row.
- It matches the existing skills viewer-context pattern and keeps behavior consistent across marketplace surfaces.

### Change 5 — Load viewer like state in blueprint detail responses

**Files:**
- `apps/api/src/routes/blueprints.ts`

**What:**
When building the response for `GET /blueprints/:id`, load whether the requesting user has liked that blueprint and include `isLikedByViewer` in the detail payload.

**Recommended implementation shape:**
1. Add a small helper that checks `blueprint_likes` for `(blueprintId, request.userId)`.
2. Thread that boolean into the detail response builder.

**Why:**
The detail page needs the same source-of-truth contract as browse. Without it, the UI cannot render the correct initial heart state.

### Change 6 — Make the browse cards interactive

**Files:**
- `apps/web/src/features/blueprints/BlueprintBrowse.tsx`

**What:**
Replace the static likes display in blueprint cards with a like/unlike control that:
- toggles between filled and outline state based on `isLikedByViewer`
- calls `blueprints.like()` or `blueprints.unlike()`
- disables while the mutation is in flight
- updates the visible count immediately

**Recommended implementation shape:**
1. Follow the pattern already used in `apps/web/src/features/skills/SkillsPage.tsx`.
2. Use a `useMutation` per rendered card or extract a small reusable hook for blueprint likes.
3. On success, patch React Query cache for the current browse result instead of waiting for a full refetch.
4. Hide the control or render it disabled when `canLikeMarketplaceBlueprints` is false.

**Why:**
- Browse is the primary discovery surface; the like action must exist there.
- Optimistic or immediate cache patching prevents visible lag after a click.

### Change 7 — Make the detail page interactive

**Files:**
- `apps/web/src/features/blueprints/BlueprintDetailPage.tsx`

**What:**
Add the same like/unlike control to the detail page header or details card.

**Recommended behavior:**
- Reuse the same mutation logic as the browse card.
- Update both the detail query cache and any already-cached browse pages so counts stay in sync when navigating back.

**Why:**
Users expect to act from the detailed view, not just from the marketplace list.

### Change 8 — Enforce blueprint-like entitlement on write routes

**Files:**
- `apps/api/src/routes/blueprints.ts`

**What:**
Require `canLikeMarketplaceBlueprints` for `PUT /blueprints/:id/like` and `DELETE /blueprints/:id/like` when acting as a non-owner/non-admin marketplace user.

**Why:**
- UI gating is not sufficient.
- The server must reject like writes when the plan forbids blueprint-marketplace engagement.

**Implementation note:**
- The self-like prohibition remains separate and continues to apply even when the viewer has like entitlement.
- Like and unlike should fail closed when either required entitlement from the Change 2 route/action matrix is absent.

### Change 9 — Add focused tests

**Files:**
- `apps/api/src/routes/blueprints.integration.test.ts`
- frontend test file adjacent to blueprint UI if one exists, otherwise add a small targeted test for the extracted mutation helper/hook

**Minimum cases:**

1. **Marketplace browse is plan-gated**
   - users without `canViewMarketplaceBlueprints` cannot browse published marketplace blueprints

2. **Marketplace detail is plan-gated**
   - users without `canViewMarketplaceBlueprints` cannot read published blueprint detail as marketplace viewers

3. **Marketplace fork is plan-gated**
   - users without `canViewMarketplaceBlueprints` cannot fork a published marketplace blueprint by ID

4. **Browse response includes viewer like state**
   - a liked published blueprint returns `isLikedByViewer: true`
   - an unliked one returns `false`

5. **Detail response includes viewer like state**
   - the field matches the persisted like row

6. **Like action is entitlement-gated and updates count/state when allowed**
   - users without `canViewMarketplaceBlueprints` are rejected
   - users without `canLikeMarketplaceBlueprints` are rejected
   - after `PUT /blueprints/:id/like`, response returns `liked: true`
   - `likeCount` increments authoritatively

7. **Unlike action is entitlement-gated and updates count/state when allowed**
   - users without `canViewMarketplaceBlueprints` are rejected
   - users without `canLikeMarketplaceBlueprints` are rejected
   - after `DELETE /blueprints/:id/like`, response returns `liked: false`
   - `likeCount` decrements authoritatively

8. **Author self-like remains rejected**
   - existing backend guard stays covered

9. **Frontend interaction reflects toggled state**
   - clicking the control flips the visual state and count without requiring full-page reload

### Change 10 — Record the pricing follow-up explicitly

**What:**
Capture pricing as a separate follow-up track covering both:
1. skill pricing UX and entitlement/product behavior
2. blueprint/agent pricing and entitlement/product behavior

**Why:**
- Skills already have partial backend pricing support but incomplete UI.
- Blueprints have no pricing model yet, and Phase 1 portability currently rejects paid skill dependencies.
- Trying to bolt blueprint pricing into this access/likes slice would mix straightforward marketplace gating with unresolved monetization design.

**Topics the pricing follow-up must answer:**
1. What exactly is being sold for blueprints/agents: reusable config, install right, hosted runtime, or some combination?
2. Whether paid blueprints may include paid skills, and if so how entitlements are granted and verified.
3. How forking, instantiation, and revision history behave for paid assets.
4. Whether skills and blueprints share one purchase model or need distinct billing flows.

---

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Browse/detail responses drift from each other | Add `isLikedByViewer` at the shared domain schema layer and use common response-building helpers where practical |
| UI count becomes stale across pages after liking | Patch both detail and browse React Query caches on success, then optionally invalidate in the background |
| Per-card mutations duplicate logic | Extract a small blueprint-like hook if duplication starts to obscure behavior |
| New blueprint entitlements drift from auth/config clients | Update schema, plan resolution, auth payload typing, and frontend consumers in the same slice |
| Route contract confusion (`PUT` vs `POST`) | Preserve the current backend contract and document it in tests and client wrappers |
| Pricing pressure creeps into the likes plan | Keep pricing explicitly out of scope here and capture a separate monetization research follow-up |

---

## Implementation Order

1. **[DONE]** Add `blueprints` plan entitlements in schema, config defaults, plan resolution, and auth client typing.
2. **[DONE]** Enforce the Change 2 route/action matrix for public marketplace blueprint reads/actions.
3. **[DONE]** Extend blueprint response schemas and frontend types with `isLikedByViewer`.
4. **[DONE]** Update `GET /blueprints` to load viewer like state in batch.
5. **[DONE]** Update `GET /blueprints/:id` to include viewer like state.
6. **[DONE]** Enforce `canViewMarketplaceBlueprints` on `POST /blueprints/:id/fork` for published marketplace sources.
7. **[DONE]** Enforce both `canViewMarketplaceBlueprints` and `canLikeMarketplaceBlueprints` on like/unlike write routes.
8. **[DONE]** Add or extract the frontend blueprint-like mutation logic.
9. **[DONE]** Wire like/unlike controls into marketplace cards.
10. **[DONE]** Wire like/unlike controls into the detail page.
11. **[PENDING]** Add focused API and frontend tests.
12. **[PENDING]** Run `pnpm lint` and the narrow blueprint test slice.

---

## Acceptance Criteria

1. Plans expose a dedicated `blueprints` entitlement block including `canViewMarketplaceBlueprints` and `canLikeMarketplaceBlueprints`.
2. Users without `canViewMarketplaceBlueprints` cannot browse, read, or fork published marketplace blueprints as public viewers.
3. Published blueprint browse results include `isLikedByViewer` for the requesting user when view entitlement allows access.
4. Blueprint detail responses include `isLikedByViewer` for the requesting user when view entitlement allows access.
5. A non-author user with blueprint-like entitlement can like and unlike a published blueprint from the marketplace browse page.
6. A non-author user with blueprint-like entitlement can like and unlike a published blueprint from the blueprint detail page.
7. The UI reflects the correct heart state and like count immediately after a successful toggle.
8. Users without `canLikeMarketplaceBlueprints` do not see an enabled blueprint like control and are rejected server-side if they attempt the write anyway.
9. Users without `canViewMarketplaceBlueprints` are also rejected server-side if they attempt marketplace like/unlike or fork actions directly by blueprint ID.
10. Existing ranking behavior continues to refresh from authoritative like counts.
11. Blueprint pricing remains out of scope for this slice, with a separate follow-up required for skills and blueprints/agents.

---

## Follow-Up

1. Create a separate pricing research-and-design plan that covers both skill pricing and blueprint/agent pricing together before introducing `canPriceBlueprints` or extending paid portability rules.

---

## Outstanding Issues

### [Item 1 — Blueprint Plan Entitlements]

- **Medium 1:** Test fixture `makePlansConfig()` in `apps/api/src/plan-guards.test.ts` is missing `blueprints` entitlements. Should add `blueprints: { canViewMarketplaceBlueprints: true, canLikeMarketplaceBlueprints: true }` to both `free` and `pro` plans.
- **Medium 2:** Test assertions in `resolvePlanEntitlements` block don't cover `blueprints`. Should add assertions for `blueprints.canViewMarketplaceBlueprints` and `blueprints.canLikeMarketplaceBlueprints` for admin bypass (expect true/true) and fail-closed fallback (expect false/false).
- **Low 1:** `api-client.ts` duplicates `PlanBlueprintsEntitlements` type rather than importing from `@herobids/domain`. Consistent with existing pattern but creates drift risk.
- **Low 2:** Plan document changes were mixed with code changes in same diff — consider separate commits in future.

### [Item 2 — Route/Action Matrix Enforcement]

- **Medium 1:** `PUT /like` has a redundant `bp.authorId !== request.userId` condition in the entitlement guard — the preceding self-like check already returns 403. Harmless but slightly misleading.
- **Low 1:** `testPlansConfig` in integration tests uses `canLikeMarketplaceSkills: true` for `no-marketplace` and `view-only` plans — plan names slightly misleading since skills marketplace features remain enabled.
- **Low 2:** Unit test `executionCapabilityResolver` mock is never exercised — exists solely to satisfy the function signature.
- **Low 3:** Unit test `decorateWithAuth` always sets `isAdmin: false` — no unit tests covering admin bypass path.
- **Low 4:** Two patterns for creating users in integration tests (direct `db.insert` vs `seedUser` helper with hardcoded `planId: 'free'`). Consider adding optional `planId` param to `seedUser`.

### [Items 3+4+5 — isLikedByViewer Schema, Browse & Detail Data Loading]

- **Low 1:** Plan document items 3/4/5 still show `[PENDING]` — need to mark as `[DONE]`.
- **Low 2:** Detail route: like query runs before marketplace entitlement check (wasted for rejected users). Reorder to match browse handler pattern (query after entitlement gate).
- **Low 3:** Detail route selects all columns from `blueprintLikes` when only existence check is needed. Use `.select({ blueprintId })` to match browse handler pattern.
- **Low 4:** `buildBlueprintDetail` parameter ordering forces `undefined` at one call site for `lineageOverride`. Works correctly but is stylistically suboptimal.
