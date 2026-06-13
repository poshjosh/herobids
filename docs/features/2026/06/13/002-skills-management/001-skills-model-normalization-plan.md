# Plan: Skills Model Normalization

## Goal

Normalize the skills domain model before expanding the product into a real
marketplace.

The immediate purpose of this plan is to stop using one overloaded field and
one mixed list endpoint to represent several different concerns at once:

1. who owns a skill
2. whether a skill is platform-owned or user-authored
3. whether a skill is published to the marketplace
4. whether a user may select a skill for an agent
5. whether a skill may be edited, delisted, archived, or deleted
6. how likes and usage should be tracked and ranked

This plan is intentionally model-first. It establishes the normalized data and
API shape needed for later UX and commercial work.

## Objective

Ship a foundation that makes the following product requirements coherent:

1. users can create, edit, delete, publish, and delist skills
2. users can browse their own skills separately from marketplace skills
3. free-plan users can have newly created skills auto-published by plan policy
4. admins can inspect all skills regardless of publication state
5. skills can be liked
6. skills can expose a price
7. skills can be sorted by popularity using durable, non-gamable usage signals

## Architectural Rule

The normalized model should follow these boundaries:

1. `skills` is the catalog identity and marketplace record
2. `skill_revisions` holds immutable executable skill content
3. `selectability` is a derived authorization result, not a persisted boolean
4. likes and usage are append-only facts, not inferred from mutable agent rows
5. published skills must not be hard-deleted in a way that changes historical
   agent behavior silently

Do not continue extending the current `visibility` field as the source of truth
for ownership, publication, and runtime selection.

## Current-State Findings

The repo already has basic skills CRUD, but the model is not ready for a
marketplace.

1. The current `skills` table mixes system-owned and user-authored records in a
   single row shape with `visibility` values `private | public | built-in`.
2. The current `GET /skills` route returns one mixed list: own skills, public
   skills, and built-in skills.
3. The agent builder treats every non-base returned skill as selectable.
4. The runtime resolves stored skills by ID at startup; if a skill row is
   deleted, the runtime silently stops resolving that skill on the next start.
5. There is no immutable skill usage record, so marketplace popularity cannot
   be computed reliably from current tables.
6. There is no likes table, no publication lifecycle, and no separate pricing
   or acquisition model.
7. Plan config has no skills-specific entitlement block, so free-plan
   auto-publish would currently be forced into route logic.

## Scope Decisions

These decisions should be treated as the implementation bias unless product
requirements change explicitly.

1. Replace `visibility` as the canonical model with explicit publication and
   access concepts.
2. Keep built-in skills separate from marketplace skills in both data semantics
   and UI presentation.
3. Treat `authorId = null` as the existing signal for platform-owned skills.
   No separate `ownerType` column is required unless future multi-owner support
   needs it.
4. Introduce immutable `skill_revisions` rather than mutating executable skill
   content in place.
5. Treat likes as marketplace engagement for user-published skills, not for
   built-in system skills.
6. Record price as real catalog metadata now, even if checkout and purchase
   flows are implemented later.
7. Make selectability derive from ownership, publication state, plan policy,
   and acquisition state. Do not infer it from publication alone.
8. Compute popularity from rolling usage windows, not from raw lifetime likes.

## Out of Scope

This plan does not attempt to solve the following product areas fully:

1. payment checkout for paid skills
2. payouts or creator revenue accounting
3. ratings, reviews, or comments
4. moderation workflows beyond admin visibility
5. recommendations or search relevance tuning
6. team or workspace-owned skills

Those can build on this normalized model later.

## Normalized Domain Vocabulary

### 1. Ownership

Ownership answers who controls the skill record.

1. system-owned: `authorId = null`
2. user-owned: `authorId = users.id`

Ownership controls edit authority. It does not by itself control marketplace
listing or runtime selection.

### 2. Publication Status

Publication status answers whether a skill is listed to the marketplace.

Canonical statuses:

1. `draft`
2. `published`
3. `delisted`
4. `archived`

Definitions:

1. `draft`: owner-only and admin-visible; not publicly listed
2. `published`: marketplace-visible and eligible for likes and ranking
3. `delisted`: not publicly listed, but retained for owners, prior acquirers,
   and historical references
4. `archived`: retired from normal author workflows; preserved for existing
   references and audit history

### 3. Selectability

Selectability answers whether a user may attach a skill to an agent.

Selectability should be derived from policy, not stored. A skill is selectable
for a user when at least one of the following is true:

1. the skill is system-owned
2. the user owns the skill
3. the skill is published, free, and marketplace-selectable
4. the skill is published, paid, and the user has a valid entitlement

Admin visibility does not imply admin selectability.

### 4. Lifecycle

Lifecycle answers how skill content changes over time.

1. The catalog record persists across revisions.
2. Executable content is immutable once written to a revision.
3. Publishing promotes a specific revision.
4. Delisting stops new marketplace discovery but does not destroy historical
   references.
5. Deletion means hard delete only for unreferenced, never-published drafts.
   Published or referenced skills should be archived or delisted instead.

## Target Model

### 1. Catalog Identity: `skills`

Keep `skills` as the stable catalog record, but reduce it to identity,
ownership, publication, and commercial metadata.

Suggested columns:

1. `id` text PK
2. `authorId` text nullable references `users.id`
3. `publicationStatus` text not null
4. `publishedAt` timestamptz nullable
5. `delistedAt` timestamptz nullable
6. `archivedAt` timestamptz nullable
7. `currentRevisionId` text nullable
8. `priceCents` integer not null default `0`
9. `autoPublishedByPlan` boolean not null default `false`
10. `likeCount` integer not null default `0`
11. `forkCount` integer not null default `0`
12. `popularityScore` double precision not null default `0`
13. `trendingScore` double precision not null default `0`
14. `createdAt` timestamptz not null default now
15. `updatedAt` timestamptz not null default now

Notes:

1. `priceCents = 0` means free.
2. Built-in skills should remain system-owned and published, but they should be
   treated as a separate library section rather than marketplace content.
3. A compatibility field named `visibility` may be returned temporarily by the
   API during migration, but it should be derived from the new fields rather
   than stored as the primary model.

### 2. Immutable Content: `skill_revisions`

Introduce `skill_revisions` as the source of executable skill content.

Suggested columns:

1. `id` text PK
2. `skillId` text not null references `skills.id`
3. `version` integer not null
4. `name` text not null
5. `description` text not null
6. `instructions` text not null
7. `requiredTools` text[] not null
8. `contextRequirements` text[] not null
9. `requiredGuardrails` text[] not null
10. `capabilityFamilies` text[] not null
11. `suggestedTickIntervalMs` integer nullable
12. `tags` text[] not null
13. `changeSummary` text nullable
14. `createdByUserId` text nullable references `users.id`
15. `createdAt` timestamptz not null default now

Indexes:

1. unique on `skillId, version`
2. index on `skillId, createdAt`

Notes:

1. Every skill starts with revision `1`.
2. Editing a skill creates a new revision; it does not mutate the previously
   published executable content.
3. Built-in skills should also be materialized into revisions so one runtime
   model applies across system-owned and user-owned skills.

### 3. Selection Linkage: `agent_skills`

The current `agents.skillIds` array is too weak for revision pinning,
selectability checks, and usage accounting.

Introduce an explicit link table:

1. `agentId` text not null references `agents.id`
2. `skillId` text not null references `skills.id`
3. `skillRevisionId` text not null references `skill_revisions.id`
4. `assignedAt` timestamptz not null default now
5. `assignedByUserId` text nullable references `users.id`
6. `assignmentSource` text not null

Indexes:

1. unique on `agentId, skillId`
2. index on `skillRevisionId`

Notes:

1. This table pins the exact revision an agent is using.
2. `agents.skillIds` can be retained temporarily during migration, then removed
   after all API, UI, and runtime paths are updated.
3. Runtime sessions should derive active skills from this table, not from a raw
   string array.

### 4. Likes: `skill_likes`

Suggested columns:

1. `skillId` text not null references `skills.id`
2. `userId` text not null references `users.id`
3. `createdAt` timestamptz not null default now

Indexes:

1. unique on `skillId, userId`
2. index on `userId, createdAt`

Rules:

1. one active like per user per skill
2. no self-likes by the author
3. likes allowed only on published user-authored skills
4. built-in skills are excluded from likes

### 5. Usage Facts: `skill_usage_events`

Suggested columns:

1. `id` text PK
2. `skillId` text not null references `skills.id`
3. `skillRevisionId` text not null references `skill_revisions.id`
4. `userId` text not null references `users.id`
5. `agentId` text nullable references `agents.id`
6. `sessionId` text nullable references `agent_runtime_sessions.id`
7. `eventType` text not null
8. `occurredAt` timestamptz not null
9. `metadata` jsonb nullable
10. `createdAt` timestamptz not null default now

Canonical `eventType` values for v1:

1. `agent_assigned`
2. `session_started`
3. `fork_created`

Notes:

1. `agent_assigned` measures adoption.
2. `session_started` measures actual runtime use.
3. `fork_created` measures derivation and reuse.
4. Popularity should use these immutable facts rather than trying to infer use
   from current `agents` rows.

### 6. Optional Later: `skill_entitlements`

If non-zero price should control actual reuse rights, add a future-facing table
now or in the immediate follow-up phase:

1. `skillId`
2. `userId`
3. `grantedBy` enum-like text
4. `grantedAt`
5. `revokedAt` nullable

This table is the clean way to make paid selectability real rather than purely
decorative.

## Plan Configuration Changes

Primary files:

1. `packages/domain/src/config/schema.ts`
2. `packages/domain/src/config/index.ts`
3. `config/default.yaml`

Extend each plan with a dedicated skills entitlement block.

Suggested shape:

1. `autoPublishCreatedSkills: boolean`
2. `canKeepSkillsPrivate: boolean`
3. `canChargeForSkills: boolean`
4. `maxPublishedSkills?: number`

Default product behavior implied by the user request:

1. free plan: `autoPublishCreatedSkills = true`
2. free plan: `canKeepSkillsPrivate = false`
3. paid plans: `canKeepSkillsPrivate = true`
4. `canChargeForSkills` should be configurable and not hardcoded to paid or
   free status in route logic

## Publication and Lifecycle Rules

### 1. Create

1. Create a `skills` row plus revision `1`.
2. Resolve the user's plan.
3. If plan policy requires auto-publish, set `publicationStatus = published`,
   `publishedAt = now`, and `autoPublishedByPlan = true`.
4. Otherwise create the skill as `draft`.

### 2. Edit

1. Editing always creates a new revision.
2. Editing a draft advances `currentRevisionId` immediately.
3. Editing a published skill creates an unpublished successor revision that can
   later be published explicitly.
4. Existing agents remain pinned to the revision they selected until updated.

### 3. Publish

1. Only the owner may publish a user-authored skill.
2. Publishing promotes a specific revision to be the current published revision.
3. Only published user-authored skills appear in marketplace lists.
4. Built-in skills remain outside marketplace ranking and likes.

### 4. Delist

1. Delisting removes a skill from marketplace discovery.
2. Delisting does not revoke existing ownership, historical references, or
   previously granted entitlements.
3. Delisted skills remain visible to the owner, admins, and existing acquirers.

### 5. Delete and Archive

1. Never-published drafts with no references may be hard-deleted.
2. Published skills should be archived or delisted, not hard-deleted.
3. Referenced skills should be retained so runtime history and usage metrics do
   not lose referential integrity.

## API Plan

### Route Principles

1. stop using one mixed `/skills` feed for every UX
2. make query scope explicit
3. return derived selectability and like state directly from the API
4. keep admin visibility separate from admin mutation authority

### Proposed Endpoints

#### `GET /skills`

Supported scopes:

1. `mine`
2. `marketplace`
3. `selectable`
4. `admin` for admins only

Suggested filters:

1. `publicationStatus`
2. `sort`
3. `priceMin`
4. `priceMax`
5. `likedByMe`
6. `tag`
7. `q` later if search is added

Suggested response fields:

1. `id`
2. `authorId`
3. `sourceKind` derived: `system | user`
4. `publicationStatus`
5. `priceCents`
6. `likeCount`
7. `isLikedByViewer`
8. `isSelectable`
9. `selectabilityReason`
10. `currentRevisionVersion`
11. `popularityScore`
12. `trendingScore`

#### `POST /skills`

1. creates a skill plus revision `1`
2. applies plan-based auto-publish policy
3. validates price policy against the user's plan

#### `PATCH /skills/:id`

1. updates marketplace metadata and creates a new revision when executable
   content changes
2. separates content changes from publication changes

#### `POST /skills/:id/publish`

1. publishes the current draft revision or a specified revision
2. rejects publication if the plan disallows the requested price policy

#### `POST /skills/:id/delist`

1. moves the skill to `delisted`

#### `DELETE /skills/:id`

1. hard-deletes only safe draft records
2. otherwise archives or returns a conflict requiring delist/archive

#### `POST /skills/:id/like`

1. idempotent like
2. rejects self-like and non-published targets

#### `DELETE /skills/:id/like`

1. idempotent unlike

#### `GET /skills/:id/metrics`

Returns the metrics and score breakdown used for marketplace sorting.

## UI Plan

The current Skills page should be restructured around intent, not around the
legacy `built-in` visibility tag.

### 1. Built-in Library

Purpose:

1. show platform-owned skills
2. keep them separate from marketplace content

### 2. My Skills

Purpose:

1. show drafts, published skills, delisted skills, and archived skills for the
   current user
2. expose publish, delist, edit, and archive actions
3. show plan-driven auto-publish behavior clearly

### 3. Marketplace

Purpose:

1. browse published user-authored skills
2. sort by popularity, trending, newest, and price
3. like skills
4. show price and selectability state directly

### 4. Agent Skill Picker

Purpose:

1. consume only `scope=selectable`
2. stop treating all non-base skills as selectable by default
3. show pinned revision or upgrade state where relevant

## Usage Metrics and Popularity

### Metric Definitions

For marketplace ranking, use rolling windows and unique-user signals.

1. `distinctUsers90d`: unique users with at least one `session_started` event
   for the skill in the last 90 days
2. `likes90d`: likes created in the last 90 days
3. `sessionStarts90d`: total `session_started` events in the last 90 days
4. `forks90d`: `fork_created` events in the last 90 days

Also retain `likeCount` as the current all-time display counter for the UI.

### Popularity Formula

Use a rolling, log-scaled score with more weight on distinct adoption than on
raw engagement totals.

$$
\text{popular} =
0.45 \cdot \ln(1 + \text{distinctUsers90d}) +
0.25 \cdot \ln(1 + \text{likes90d}) +
0.20 \cdot \ln(1 + \text{sessionStarts90d}) +
0.10 \cdot \ln(1 + \text{forks90d})
$$

Use a separate recent-window variant for trending.

$$
\text{trending} =
0.45 \cdot \ln(1 + \text{distinctUsers30d}) +
0.25 \cdot \ln(1 + \text{likes30d}) +
0.20 \cdot \ln(1 + \text{sessionStarts30d}) +
0.10 \cdot \ln(1 + \text{forks30d})
$$

Why this shape:

1. logarithms reduce runaway advantage from very old or very large counts
2. distinct-user adoption matters more than repeated sessions from one user
3. likes contribute, but do not dominate real usage
4. forks contribute modestly as a signal of creator-to-creator reuse

### Rollup Strategy

Do not compute popularity live from raw tables on every request.

Recommended approach:

1. append raw events to `skill_usage_events`
2. maintain periodic daily rollups or scheduled recomputation
3. persist `popularityScore` and `trendingScore` onto `skills`
4. sort marketplace lists from persisted scores

## Migration Plan

### Phase 1: Catalog Normalization

1. add new columns to `skills`
2. add `skill_revisions`, `skill_likes`, and `skill_usage_events`
3. backfill revision `1` from each existing skill row
4. backfill publication state:
   - `built-in` -> system-owned, `published`
   - `public` -> user-owned, `published`
   - `private` -> user-owned, `draft`
5. keep a derived `visibility` field in API responses temporarily for client
   compatibility

### Phase 2: Agent Pinning and Runtime Migration

1. add `agent_skills`
2. migrate `agents.skillIds` into pinned skill-revision assignments
3. update runtime descriptor resolution to read pinned revisions
4. snapshot active skill revision IDs into runtime session start flows or usage
   events

### Phase 3: Marketplace APIs and UI Scopes

1. introduce scoped `GET /skills`
2. add publish, delist, like, and metrics endpoints
3. update Skills page into built-in library, my skills, and marketplace
4. update agent picker to use selectable scope only

### Phase 4: Metrics and Ranking

1. write `agent_assigned`, `session_started`, and `fork_created` events
2. add scheduled score recomputation
3. expose popularity and trending sorts in the marketplace

## Testing and Validation

### Backend

1. migration tests covering legacy `visibility` backfill
2. route tests for create, publish, delist, archive, delete, and like semantics
3. plan-policy tests for free auto-publish and private-skill restrictions
4. runtime tests proving pinned revisions survive later skill edits
5. metrics tests proving score calculations are stable and window-based

### Frontend

1. Skills page tests for built-in library, my skills, and marketplace sections
2. agent picker tests proving only selectable skills appear
3. admin view tests proving drafts and delisted skills are visible to admins

## Acceptance Criteria

1. The product no longer uses stored `visibility` as the canonical source of
   truth for marketplace behavior.
2. Publication state, ownership, and selectability are distinct concepts in the
   schema and API.
3. Editing a published skill creates a new immutable revision rather than
   mutating executable content in place.
4. Existing agent skill selections are pinned to explicit revisions.
5. Free-plan auto-publish behavior is expressed through plan configuration, not
   hardcoded route checks.
6. Published user-authored skills can be liked idempotently.
7. Marketplace popularity and trending sorts use persisted rolling-window usage
   metrics, not lifetime raw counts.
8. Built-in skills remain visible and selectable where appropriate, but are not
   conflated with marketplace content.

## Open Questions

These should be resolved before implementing paid skills end to end:

1. Should non-zero price block selection until entitlement exists, or is price
   initially display-only metadata?

yes block selection. users cannot open the skill to view it fully unless they are entitled to. 

2. Should marketplace viewers see full `instructions`, or only a preview before
   acquisition?

full instructions

3. Should built-in skills ever be likeable, or should they remain outside
   marketplace engagement entirely?

you decide which is easier to implement

4. Should delisted paid skills remain selectable for prior acquirers only, or
   also for any user who previously attached them to an agent?

yes

5. Should the migration retain a temporary compatibility response field named
   `visibility`, or should clients be updated in one cutover?

no

IMPORTANT

- no need for backward compatibility at all
- the marketplace is just a public square for now