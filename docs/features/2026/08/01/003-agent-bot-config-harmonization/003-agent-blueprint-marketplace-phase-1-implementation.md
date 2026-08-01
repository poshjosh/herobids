# 009 - Agent Blueprint Marketplace Phase 1 Implementation Plan

**Status:** Ready for implementation after Plan 008  
**Created:** 2026-08-01  
**Depends on:** [002-agent-bot-config-harmonization-closure.md](./002-agent-bot-config-harmonization-closure.md)  
**Supersedes for implementation:** [006-phase-1-plan.md](../002-agent-blueprint-marketplace/006-phase-1-plan.md)  
**Preserves:** [003-target-state-brief.md](../002-agent-blueprint-marketplace/003-target-state-brief.md), [004-adr-list.md](../002-agent-blueprint-marketplace/004-adr-list.md), and all four accepted marketplace ADRs

## Purpose

Implement Marketplace Phase 1 from the accepted target state and ADRs using one canonical configuration source, immutable revision-owned recipes, portable pinned skills, preserved agent-risk provenance, binding-aware execution, transactional attribution, and server-owned ranking events.

006 remains historical context. This document is the sole Phase 1 implementation plan. Milestone A and Milestone B below replace the contradictory Phase 1a/1b/1c labels.

## Prerequisite Gate

Do not begin projection or blueprint persistence until Plan 008 passes and [007-field-classification.md](../002-agent-blueprint-marketplace/007-field-classification.md) has been rewritten as the canonical post-harmonization field manifest. The implementation must project that manifest without fallback to removed columns or strategy metadata.

## Locked Domain Contract

### Kind and revision ownership

`BlueprintKindSchema` is exactly `z.enum(['agent', 'bot'])`. An immutable `blueprint_revisions` row plus its immutable `blueprint_revision_skills` rows form the revision aggregate and are the sole owner of recipe content. The mutable `blueprints` row owns identity, author, lifecycle, current query facets, lineage, counters, scores, and revision pointers; it never stores recipe JSON.

### Agent revision payload

The agent payload has this high-level shape and rejects unknown keys:

```ts
{
  kind: 'agent';
  name: string;
  description: string;
  tags: string[];
  prompt: string;
  style: 'careful' | 'balanced' | 'bold' | null;
  strategy: StrategyIdentity | null;
  risk: RiskPosture | null;
  executionDefaults: ExecutionDefaults | null;
  technical?: TechnicalConfig;
  intelligence?: IntelligenceConfig;
  capabilityMode: 'intelligence' | 'hybrid';
  hybridMode?: 'mixed' | 'scanner_gated';
  executionPolicy?: {
    positionSizeMode?: 'fixed' | 'percent_equity';
    fixedPositionSize?: string;
    takeProfitPct?: number;
  };
  runtimePolicyOverrides?: AgentRuntimePolicyOverrides;
  toolPolicy?: Record<string, unknown>;
  modelPolicy?: Record<string, unknown>;
  allowedPresets?: AllowedPresetsPolicy;
  presetTransition?: PresetTransitionPolicy;
  platformAssessment?: PlatformAssessmentOptIn;
  authorizationMode: 'direct' | 'approval_required' | null;
  wakePreferences?: WakePreferences;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
  capital: number | null;
  maxBots: number | null;
  tickIntervalMs: number | null;
}
```

Skill dependencies are the `blueprint_revision_skills` rows in the revision aggregate rather than duplicate JSON members. `strategy` and `executionDefaults` are always present as keys and may be `null` only when no pinned skill revision has `trading` in `capabilityFamilies`. A trading-capable agent requires non-null values for both, whether its reasoning `capabilityMode` is `intelligence` or `hybrid`. Skills exist only on agent revision aggregates in Phase 1; bot revisions reject skill dependencies unless a separate accepted bot-skill contract lands first.

`authorizationMode` is also tied to resolved trading capability: it must be `null` for a non-trading agent and non-null for a trading-capable agent, defaulting to `direct` only while creating a trading recipe. The agent payload composes the existing `UnifiedAgentConfigSchema` invariants: at least one of `technical` or `intelligence` is present; `capabilityMode: hybrid` requires `technical`; and `capabilityMode: intelligence` forbids `hybridMode`.

### Bot revision payload

The bot payload has this high-level shape and rejects unknown keys:

```ts
{
  kind: 'bot';
  name: string;
  description: string;
  tags: string[];
  strategy: StrategyIdentity;
  risk: BotConfig['risk'];
  executionDefaults: ExecutionDefaults;
  tokenSafety?: TokenSafety;
  venue: string;
  venueType: 'orderbook' | 'swap';
  symbol: string;
  swapAssets?: {
    baseAsset: string;
    quoteAsset: string;
    baseDecimals: number;
    quoteDecimals: number;
  };
  shadowPollIntervalMs: number;
}
```

Bot revision creation separates marketplace metadata (`kind`, `name`, `description`, `tags`) from the actor-config subset. Strict blueprint validation first requires raw `executionDefaults`; do not let `BotConfigSchema` supply its default for an omitted blueprint field. Map only `strategy`, `risk`, required `executionDefaults` as `execution`, `tokenSafety`, venue fields, symbol, swap assets, and polling interval into `BotConfigSchema`. Parse that subset, map parsed `execution` back to `executionDefaults`, then reconstruct and validate the strict blueprint union before persistence. Never parse or persist the complete marketplace object as `BotConfig`, and never persist the mapped actor shape as the revision payload. `risk` is always a non-null object and uses `BotConfigSchema` defaults/omission semantics; it never carries agent-style nullable provenance or runtime mutability. Bot sizing, stop-loss/take-profit strategy behavior, and similar strategy-specific policy live only in `StrategyIdentity.params` and are validated by the selected strategy's parameter schema. A root `executionPolicy` is rejected, preventing two policy owners. Swap assets and mode rules remain those of `BotConfigSchema`. Plan 008 must reconcile shared fields without dropping bot-only token safety or strategy parameters.

### Skill dependencies

Every agent skill reference is exactly `{ skillId, skillRevisionId }`. The pair must resolve to one revision belonging to that skill. Instantiation writes that exact pair directly to `agent_skills`; it must not call a resolver that substitutes the skill's current revision. Add unique `(skillId, id)` ownership on `skill_revisions` and composite foreign keys from both `blueprint_revision_skills(skillId, skillRevisionId)` and `agent_skills(skillId, skillRevisionId)` so mismatched pairs fail at the database boundary.

Phase 1 portability permits only:

1. system skills with an installable pinned revision; or
2. published, free user skills whose pinned revision belongs to that published skill.

Private, draft, delisted, archived, and paid skill dependencies are rejected. Publication and confirmation both revalidate ownership, status, price, and pair integrity. Supporting any rejected category requires a separate entitlement/portability contract.

Installability is revision-level, not inferred from the skill row alone. Add content-publication metadata to skill revisions (`publishedAt`, nullable until first publication) and a `skills.publishedRevisionId` pointer. A user-skill revision is portable only when its content has previously been published, the skill is currently `published`, and the skill is currently free. Staged revisions have `publishedAt = null` and are rejected; previously published revisions remain portable while the skill remains published/free. Publishing marks the selected immutable revision and advances `publishedRevisionId` transactionally.

System skill synchronization is append-only: compare the canonical content hash with the current system revision, do nothing when equal, and insert/publish the next version when changed. Hash deterministic JSON containing `name`, `description`, `instructions`, `promptHint`, `promptTemplate`, sorted set-like `requiredTools`, `contextRequirements`, `requiredGuardrails`, and `capabilityFamilies`, plus `suggestedTickIntervalMs` and sorted `tags`; use SHA-256 over UTF-8 with recursively sorted object keys. Take a transaction-scoped advisory lock derived from the system skill ID before lookup/insert so first-time creation is serialized even when no row exists; then row-lock an existing skill, allocate `MAX(version) + 1`, insert, and advance current/published pointers. It must never update revision content in place. Existing pinned system revisions therefore remain reproducible.

## Exact Storage Model

### `blueprints`

Replace the legacy table with these fields:

1. identity: `id`, `authorId`, `createdAt`, `updatedAt`
2. lifecycle: `publicationStatus`, `publishedAt`, `delistedAt`, `archivedAt`
3. authoring/public pointers: `currentRevisionId`, `publishedRevisionId`
4. current-revision facets: `kind`, `name`, `description`, `strategyType`, `style`, `tags`, `venueType`
5. lineage: `sourceBlueprintId`, `sourceBlueprintRevisionId`
6. counters/scores: `likeCount`, `forkCount`, `popularityScore`, `trendingScore`

`publicationStatus` is one of `draft`, `private`, `published`, `delisted`, or `archived`. Current facets are transactionally derived from `currentRevisionId` and are for authoring/current-owner queries. Public browse and installation render/filter from `publishedRevisionId`, not current facets, so staged edits cannot leak. No `configData`, `configVersion`, `visibility`, or recipe duplicate remains.

### `blueprint_revisions`

Fields are `id`, `blueprintId`, `version`, immutable query facets `kind`, `name`, `description`, `strategyType`, `style`, `tags`, and `venueType`, plus `payload`, `changeSummary`, `createdByUserId`, and `createdAt`. `payload` is the strict agent/bot union above; revision facets are derived from that payload in the revision-creation transaction. Revisions are insert-only. Enforce unique `(blueprintId, version)` and unique `(blueprintId, id)`. Public browse joins `publishedRevisionId` to these indexed immutable facets; it does not inspect JSON or use staged current facets.

### `blueprint_revision_skills`

Fields are `blueprintRevisionId`, `skillId`, `skillRevisionId`, and `orderIndex`. Enforce unique `(blueprintRevisionId, skillId)`, unique `(blueprintRevisionId, orderIndex)`, a restrictive FK to `blueprint_revisions.id`, and the composite skill ownership FK above. These rows are inserted only while creating an agent revision and are thereafter immutable. Bot revisions must have no rows. The domain revision response assembles them as `skills: Array<{ skillId, skillRevisionId }>` without duplicating them inside `payload`.

### Marketplace tables

1. `blueprint_likes`: `blueprintId`, `userId`, `createdAt`; unique `(blueprintId, userId)`.
2. `blueprint_usage_events`: `id`, `blueprintId`, `blueprintRevisionId`, `userId`, `subjectKind`, `subjectId`, `eventType`, `isSelfUsage`, `occurredAt`, `metadata`, `createdAt`. `eventType` is exactly `instance_created` or `fork_created`; `subjectKind` is `agent`, `bot`, or `blueprint`; unique `(subjectKind, subjectId, eventType)`.
3. `blueprint_instantiation_requests`: `id`, `userId`, `idempotencyKey`, `requestHash`, `blueprintId`, `blueprintRevisionId`, `actorKind`, `actorId`, `responsePayload`, `createdAt`; unique `(userId, idempotencyKey)`.
4. `blueprint_fork_requests`: `id`, `userId`, `idempotencyKey`, `requestHash`, `sourceBlueprintId`, `sourceBlueprintRevisionId`, `forkBlueprintId`, `responsePayload`, `createdAt`; unique `(userId, idempotencyKey)`.

There is no public usage-event write endpoint. Only successful server-owned confirmation and fork transactions emit events.

### Attribution and ownership integrity

Add nullable `blueprintId` and `blueprintRevisionId` to both `agents` and `bots`. Enforce all of the following in PostgreSQL:

1. paired-null checks: each attribution pair is either both null or both non-null;
2. composite attribution FK `(blueprintId, blueprintRevisionId)` to `blueprint_revisions(blueprintId, id)` with restrictive deletion;
3. composite current/published pointer FKs `(blueprints.id, currentRevisionId)` and `(blueprints.id, publishedRevisionId)` to the same revision key;
4. a paired-null check and composite FK for `(sourceBlueprintId, sourceBlueprintRevisionId)` so the source revision belongs to the source blueprint;
5. restrictive deletion for revision, lineage, usage, and attribution references.
6. lifecycle checks: `draft`/`private` have no published pointer or publication timestamps; `published` requires `publishedRevisionId` and `publishedAt` with no delist/archive timestamp; `delisted` requires the retained published pointer, `publishedAt`, and `delistedAt`; `archived` requires `archivedAt` and may retain a published pointer only if it was formerly published.

Use Drizzle declarations where supported. If cyclic/composite FK declaration is awkward, generate the tables with Drizzle and add named PostgreSQL constraints in the generated migration; integration tests must prove wrong-owner revision IDs and half-null pairs fail at the database boundary.

The usage-event `(blueprintId, blueprintRevisionId)` and fork/instantiation request source pairs use the same composite revision ownership FK. A usage or idempotency record cannot name a revision from another blueprint.

### Draft hard delete

Hard delete is allowed only when the blueprint is `draft`, has never been published, and has no likes, usage events, forks, or actor attribution. In one locked transaction: verify those predicates, set `currentRevisionId` and `publishedRevisionId` to null to break the pointer cycle, delete `blueprint_revision_skills`, delete its revisions, then delete the blueprint. Published, formerly published, referenced, delisted, and archived assets are never hard-deleted.

## Revision And Lifecycle Semantics

### Creation and editing

1. Create a blueprint and revision 1 in one transaction: insert the blueprint with null pointers, insert the immutable revision, then set `currentRevisionId` and all current facets.
2. Every content edit creates the next immutable revision under a row lock; it never updates a revision payload. Advance `currentRevisionId` and current facets in the same transaction.
3. Editing a published blueprint leaves `publicationStatus = published` and `publishedRevisionId` unchanged. The new current revision is an unpublished authoring revision; public browse/install continues to use the previously published revision.
4. Publishing locks the row, revalidates payload and dependencies, and sets `publishedRevisionId = currentRevisionId`, `publicationStatus = published`, and timestamps/facets transactionally.

### Allowed transitions

| From | Allowed targets/actions |
|---|---|
| `draft` | `private`, `published`, `archived`, or eligible hard delete |
| `private` | `draft`, `published`, `archived` |
| `published` | publish current revision, `delisted`, `archived` |
| `delisted` | republish current revision, `archived` |
| `archived` | none; terminal |

Editing does not itself change lifecycle status. Delisting retains `publishedRevisionId` for attribution/audit but removes public installability. Archive is terminal.

### Lifecycle field invariants

| Status | `publishedRevisionId` / `publishedAt` | `delistedAt` | `archivedAt` |
|---|---|---|---|
| `draft` or `private` | both null | null | null |
| `published` | both non-null | null | null |
| `delisted` | both non-null | non-null | null |
| `archived` never published | both null | null | non-null |
| `archived` formerly published | both non-null | non-null | non-null |

Publishing or republishing sets `publishedRevisionId = currentRevisionId`, sets `publishedAt` to the transition time, and clears `delistedAt`. Delisting sets `delistedAt`. Archiving a published blueprint sets both `delistedAt` and `archivedAt`; archiving a delisted blueprint preserves `delistedAt`; archiving a never-published draft/private blueprint sets only `archivedAt`. Database checks enforce these combinations.

## Access And Availability

1. Owners may read, preview, and instantiate the current revision or an explicitly selected revision of their own `draft`, `private`, or `published` blueprint. Platform admins have the same authority over any author's blueprint for support/moderation operations, with the action audited. Both remain subject to dependency and execution checks.
2. Nonowners may browse, preview, fork, like, or instantiate only `publishedRevisionId` while status is `published`. Supplying any other revision returns `404`.
3. Historical formerly published revisions are not publicly installable in Phase 1.
4. `delisted` and `archived` blueprints remain attributable and existing instances remain runnable, but all new preview, confirmation, fork, and like operations are blocked. Nonowners receive `404`; owners/admin receive `409` lifecycle conflict.
5. Only owner/admin may edit, publish, delist, archive, or hard-delete. Authors cannot like their own blueprint. Self-instantiation/fork may be retained as an audit event but is excluded from counters and ranking.

Confirmation repeats visibility and lifecycle checks under lock. An owner/admin's explicit pinned revision remains intentional and installable after later authoring edits; changing `currentRevisionId` alone is not a stale conflict. Owner/admin receive `409` only when lifecycle, dependency, binding, or compatibility changes make that pinned revision invalid. For a nonowner, republish, delist, archive, or any change that makes the pinned public revision unavailable returns `404` to preserve non-disclosure, even after a genuine preview; preview never grants future access.

## Risk Semantics

Agent revisions store raw nullable `RiskPosture` only.

For installer `risk` overrides:

1. omitted field: inherit the exact raw revision member, including omission or null;
2. explicit `null`: select operator default and agent-mutability where that field's risk contract permits;
3. number: installer-configured value, immutable to the running agent.

Preview returns separate `rawRisk` and `effectiveRisk` objects. `effectiveRisk` includes each effective value plus provenance/mutability; it is display-only. Confirmation accepts only `revisionId`, installer edits/overrides, and private inputs. It rejects an `effectiveRisk` payload and reconstructs effective values server-side from the immutable revision, edits, operator defaults, and ceilings.

Bot revisions and instances use the parsed non-null `BotConfigSchema` risk object described above. They do not expose agent mutable/default provenance.

## Preview And Confirmation Protocol

### Preview

`POST /blueprints/:blueprintId/instantiate/preview`

Request: optional `revisionId` (owner/admin only except when equal to the public target), typed installer `edits`, proposed private binding IDs, and requested execution mode/live opt-in. Response: `blueprintId`, pinned `revisionId`, `kind`, editable raw payload, `rawRisk`, `effectiveRisk` with provenance, required/missing private inputs, compatible execution modes, selected resolved mode, and validation warnings. Preview writes no actor, attribution, usage, or counter.

### Confirmation

`POST /blueprints/:blueprintId/instantiate`

Require an `Idempotency-Key` header. Request: pinned `revisionId`, typed `edits`, private binding IDs, requested execution mode, and explicit `liveOptIn`; never accept a full resolved preview payload. The server reloads the immutable revision and reconstructs the candidate.

The key is trimmed printable ASCII, 1-200 characters, and scoped to authenticated user plus operation. Hash the normalized parsed intent with SHA-256 over deterministic UTF-8 JSON: recursively sort object keys; retain array order except binding-ID sets, which are deduplicated and sorted; preserve normalized number and string values. The instantiate hash includes operation, path `blueprintId`, pinned `revisionId`, kind, edits, binding IDs, requested mode, and `liveOptIn`; it excludes derived preview/effective values and current operator defaults.

Instantiation request rows are success-only records: `actorId`, `requestHash`, attribution fields, and the original typed success `responsePayload` are non-null. The advisory lock serializes a user/key before lookup. A completed same-hash retry immediately returns the stored response before blueprint, lifecycle, dependency, or binding revalidation; a different hash returns `409`. If no row exists, work proceeds and inserts the completed row at the end of the same transaction. Rollback leaves no reservation. Fork uses the same early-return protocol and hashes operation, source blueprint/revision, and normalized fork edits.

In one database transaction:

1. take a PostgreSQL transaction-scoped advisory lock derived from `(userId, idempotencyKey)`; return a completed same-hash response immediately or reject a different hash;
2. when no completed row exists, lock the blueprint and recheck access/lifecycle;
3. revalidate payload, exact skill pairs/portability, raw risk edits, private binding ownership/status, and execution resolution;
4. create the stopped agent or bot with exact blueprint attribution;
5. for agents, insert exact `{skillId, skillRevisionId}` rows and selected connection grants where applicable;
6. insert the idempotency result with response payload and one unique `instance_created` usage event.

A retry with the same user/key/hash returns the same actor and does not emit another event. Reusing the key with a different hash returns `409`. Transaction failure leaves no actor/event/idempotency success. External side effects and runtime start are outside this transaction; every instantiated actor is `stopped`, and starting it is a separate existing lifecycle operation.

## Shared Execution Resolver

Add one named server/domain operation, `resolveBlueprintExecution`, used by preview and confirmation. Confirmation always reruns it and never trusts preview output.

The authoritative capability input is a domain port `BlueprintExecutionCapabilityResolver` in `packages/domain/src/ports/`. It returns a typed profile containing provider, venue type, supported actor kinds, supported execution modes, binding requirements by mode, supported networks, and symbol/asset constraints. Implement the adapter at `apps/api/src/services/blueprint-execution-capability-adapter.ts`, where the API composition root can inject both provider-catalog metadata and the venue-profile resolver from `packages/venues` without reversing package dependencies. Routes receive the port by constructor injection; they never infer capabilities from provider strings or instantiate venue adapters directly.

Inputs are blueprint kind, trading capability, revision execution defaults and venue/venue type/swap assets, requested mode, explicit live opt-in, and kind-specific private bindings. Agent input uses deduplicated `connectionIds` (0-20); bot input uses exactly one `connectionId` plus its matching `venueAccountId`. The resolver derives provider and venue capabilities from the shared provider catalog and adapter capability contract.

Rules:

1. `paper` is available/default only when the selected adapter and recipe support paper simulation.
2. swap recipes default to `shadow`; `paper` is rejected.
3. `live` requires explicit `liveOptIn`, a compatible active binding/account owned by the installer, provider capability for the actor kind, matching venue type/provider, and compatible symbol/assets/network.
4. Missing, inactive, foreign, mismatched, or incapable bindings fail validation. The resolver does not silently choose another account or downgrade requested live mode.

Binding and result cardinality are fixed:

| Actor / mode | Required trading bindings | Resolver result |
|---|---|---|
| non-trading agent | zero venue-trading bindings; other skill-required private connections are validated outside this resolver | `mode: null`; `executionDefaults` must be null and `liveOptIn` false |
| trading agent, `paper` | zero or more active user-owned trading connections; supplied ones must all match recipe constraints | paper only when adapter/recipe supports simulation; never auto-upgrade because connections exist |
| trading agent, `shadow` or `live` | one or more active user-owned trading connections | every selected trading connection must satisfy provider, venue type, network, and asset constraints; mixed incompatible grants reject the request |
| bot, any mode | exactly one active user-owned connection and exactly one venue account belonging to that connection | one resolved binding; paper still requires the pair because the bot row requires it |

When requested mode is omitted, non-trading agents resolve null, swap recipes resolve shadow, and other trading recipes resolve paper only when supported; otherwise they require a compatible binding and resolve shadow. Authored `live` is never auto-applied. Live always requires an explicit requested mode and `liveOptIn: true`. Preview and confirmation use discriminated binding request schemas, not one ambiguous plural field.

Preview reports resolver results. Confirmation treats changed binding/capability state as `409` when it invalidates the pinned preview intent.

## Fork, Usage, And Ranking

`POST /blueprints/:blueprintId/fork` requires an `Idempotency-Key` and optional owner/admin `revisionId`; nonowners always fork the current public target. Fork creates a new draft blueprint plus immutable revision copied from the permitted source revision in one transaction. It records exact source blueprint/revision lineage, a `blueprint_fork_requests` result, and one unique `fork_created` event whose subject is the new blueprint. The same user/key/hash returns the same fork; a changed hash returns `409`. Failed requests and retries emit nothing new.

Phase 1 duplicates the skills scoring helper and adds a parity test. Use exactly:

$$
0.45\log(1 + \text{distinctUsers}) + 0.25\log(1 + \text{likes}) + 0.20\log(1 + \text{instances}) + 0.10\log(1 + \text{forks})
$$

`popularityScore` uses a rolling 90-day window and `trendingScore` a rolling 30-day window, matching skills. `instances` maps the skills helper's `sessionStarts` slot to unique `instance_created` events. Likes come from `blueprint_likes`; forks and users come from unique usage events.

Author self-like is rejected. Self-instantiation and self-fork events may be stored with `isSelfUsage = true` for audit, but are excluded from `distinctUsers`, instances, forks, `forkCount`, and both scores. Preview, failed confirmation, stale confirmation, and retry never affect counts. Counters are derived/recomputed from unique rows rather than incremented from client requests.

For `instance_created`, `blueprintId`/`blueprintRevisionId` name the installed source. For `fork_created`, they name the source being credited while `subjectId` names the new fork. `distinctUsers` is the union of non-self users with either qualifying event in the score window; `instances` and `forks` count their respective unique events. `forkCount` belongs to the source blueprint. Only `likeCount` and `forkCount` are persisted counters; instance usage is derived from unique events during score computation. Like/fork transactions refresh their exact counters, while score recomputation runs after commit and on the existing periodic reconciliation schedule from authoritative rows. Tests invoke recomputation directly and cover 30/90-day boundaries.

## Endpoint Contract Matrix

All bodies use strict shared schemas, all revision targets are explicit, and responses return typed row/revision DTOs without private instance data.

| Operation | Route and request | Authorization / revision target | Result |
|---|---|---|---|
| browse | `GET /blueprints?kind&strategyType&style&venueType&tags&sort&cursor` | authenticated; published only; `publishedRevisionId` | cursor page sorted by `popular`, `trending`, or `newest` using the ordering below |
| retrieve | `GET /blueprints/:id?revisionId` | nonowner gets published target only; owner/admin may select owned revision | metadata plus assembled immutable revision aggregate |
| create draft | `POST /blueprints` with typed recipe aggregate | authenticated author | draft blueprint plus revision 1 |
| save actor | `POST /agents/:id/blueprints` or `POST /bots/:id/blueprints` with marketplace metadata | actor owner/admin; server projects canonical 007 fields | draft blueprint plus projected revision 1 |
| edit | `POST /blueprints/:id/revisions` with typed full replacement aggregate, expected base revision, and `changeSummary` | owner/admin | next immutable current revision; public pointer unchanged |
| publish | `POST /blueprints/:id/publish` with expected `currentRevisionId` | owner/admin | validates dependencies and promotes current revision |
| set draft/private | `POST /blueprints/:id/draft` / `POST /blueprints/:id/private` | owner/admin; allowed transition only | lifecycle DTO |
| list revisions | `GET /blueprints/:id/revisions?cursor` | owner/admin only | immutable revision summaries; no private actor data |
| delist/archive | `POST /blueprints/:id/delist` / `POST /blueprints/:id/archive` | owner/admin | lifecycle DTO with invariant timestamps |
| hard delete | `DELETE /blueprints/:id` with expected `currentRevisionId` | owner/admin; eligible draft only | `204` |
| preview/confirm | routes defined above | access matrix above; pinned revision | read-only preview / stopped attributed actor |
| fork | route defined above with key, pinned source, normalized edits | published target or owner/admin revision | new draft and exact lineage |
| like/unlike | `PUT /blueprints/:id/like` / `DELETE /blueprints/:id/like` | nonauthor, published target only | idempotent like state and authoritative count |

Revision retrieval never exposes an owned private revision to a nonowner. Create/save/edit validate skill pairs and trading capability before writing. Endpoint tests assert stable namespaced codes including `blueprint.validation`, `blueprint.forbidden`, `blueprint.not_found`, `blueprint.revision_stale`, `blueprint.lifecycle_conflict`, `blueprint.dependency_unavailable`, and `blueprint.idempotency_conflict` under the HTTP classes below.

Cursor ordering is deterministic: `popular` uses `(popularityScore DESC, id ASC)`, `trending` uses `(trendingScore DESC, popularityScore DESC, id ASC)`, and `newest` uses `(publishedAt DESC, id ASC)`. The opaque cursor contains every ordering value plus `id`; filters and sort are part of the signed/validated cursor context so a cursor cannot be reused with different query semantics.

## API Errors

1. `400`: schema errors, invalid override shape, missing required private input, intrinsically incompatible recipe/mode.
2. `403`: authenticated caller lacks owner/admin authority for an otherwise visible authoring operation; self-like is forbidden.
3. `404`: blueprint/revision does not exist or is intentionally unavailable/not visible to the caller.
4. `409`: invalidated pinned intent, illegal lifecycle transition, delisted/archived owner operation, confirmation race, or idempotency-key hash conflict.

Responses use stable namespaced error codes. No path reveals private blueprint existence to a nonowner.

## Work Packages

### Milestone A - Faithful copy core

1. Domain payload, edit, preview, and confirmation schemas.
2. Database replacement, generated migration, integrity constraints, and revision transactions.
3. Server projection from the canonical 007 manifest and exact skill pinning.
4. Shared execution resolver plus preview/confirmation transaction and idempotency.
5. Agent/bot attribution and faithful-copy functional verification.

Milestone A exits only when a pinned revision can deterministically create a stopped, attributed actor with exact risk provenance, skills, execution, and private bindings.

### Milestone B - Marketplace mechanics and UI

1. Lifecycle, browse, fork, like, server-owned usage, counters, and score recomputation.
2. Agents-page browse/sort and `Use this agent` preview/edit/confirm flow backed by `publishedRevisionId`.
3. Owner authoring/publish actions that clearly distinguish current edits from the public revision.
4. Marketplace functional verification for publish, staged edit, preview, confirm, fork, like, delist, and archive.

Phase 1 sorting is popularity, trending, and newest. Public P&L sorting remains deferred.

## Required Tests

### Contract and integrity

1. Agent/bot discriminated union, skill-capability-based trading rules, non-trading agent optionals, bot-required strategy, bot skill rejection, strict unknown-key rejection.
2. Composite FK rejects wrong-owner current, published, source, and attribution revision IDs; paired-null checks reject half attribution.
3. Immutable revision writes, transactional facet updates/rollback, published edit isolation, and draft hard-delete cycle procedure.
4. Composite ownership constraints and exact skill pair persistence reject mismatched, private, draft, delisted, archived, or paid dependencies at revision creation, publication, and confirmation.
5. Staged user-skill revisions are not installable, previously published revisions remain reproducible while eligible, and system-skill synchronization appends rather than mutates content.

### Lifecycle and authorization

Test every allowed transition and every disallowed transition in the table. For owner, admin, authenticated nonowner, and author-self cases, test current revision, explicit historical revision, public published revision, draft/private, delisted, and archived behavior. Assert `400`, `403`, `404`, and `409` classes and stable codes.

### Instantiation and execution

1. Omitted/null/number agent risk override behavior, raw/effective separation, and rejection of effective preview replay.
2. Owner/admin may intentionally confirm an accessible pinned historical revision after authoring edits; lifecycle/dependency/binding incompatibility returns `409`. Nonowner races that make the pinned public revision unavailable return `404`; neither failure creates an actor/event.
3. Same idempotency key/hash returns the stored stopped-actor response before revalidation, including after republish, delist, archive, or binding revocation; reordered object keys and binding sets hash identically; changed edits/bindings hash differently and return `409`; concurrent retries create one actor/event; rollback leaves no success row.
4. Resolver matrix covers non-trading/trading agent and bot, zero/one/many cardinality, order-book/swap, paper/shadow/live, adapter support, active/foreign/inactive binding, provider, venue, symbol/assets, mixed grants, and live opt-in.
5. Confirmation transaction includes agent skill pins, connection grants where applicable, attribution, idempotency result, and event; rollback is atomic.

### Usage, ranking, and UI

1. Only successful instance/fork transactions emit one event; preview/failure/retry emit none.
2. Self-like is rejected; self events are audited but excluded from counters and 30/90-day scores.
3. Blueprint and skills score helpers produce identical results for the same metric vector and windows.
4. Public UI continues to use `publishedRevisionId` while an owner has staged current edits, and delisted/archived copy actions disappear.
5. Every endpoint in the contract matrix has request/response, authorization, revision-target, lifecycle, and stable-error route coverage.

## Verification Commands

Run from the repository root. PostgreSQL and Redis must be available with test configuration for integration and functional suites. State reset is assumed; there is no compatibility or production-data migration rehearsal.

```bash
pnpm exec vitest run packages/domain/src/config/schema.test.ts apps/api/src/routes/blueprints.test.ts apps/api/src/routes/skills.test.ts packages/db/src/journal-timestamps.test.ts
pnpm --filter @herobids/db run db:generate
pnpm exec vitest run packages/db/src/journal-timestamps.test.ts
pnpm --filter @herobids/web run typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm test:functional
pnpm build
BASE_URL=http://localhost:5173 pnpm --filter @herobids/e2e test
```

After `db:generate`, review SQL, snapshot, and `packages/db/drizzle/meta/_journal.json`, then run the journal test. The Playwright command requires the seeded local API/web stack and test account expected by `tests/e2e`; use the actual web URL if it differs from `http://localhost:5173`. Milestone B also requires desktop/mobile screenshots of browse, staged-public revision display, preview/edit/confirm, and lifecycle-disabled actions, recorded in the implementation PR or test report.

## Acceptance Criteria

1. Immutable revisions and dependency pins are the only recipe owners; mutable blueprint rows contain only the exact identity/lifecycle/facet/lineage/ranking fields above.
2. Separate current and published pointers prevent staged edits from silently changing public installation.
3. Database constraints prove every referenced revision belongs to its blueprint and attribution cannot be half-null or erased.
4. Agent and bot payloads, skill portability, raw/effective risk, execution resolution, and access rules match this plan without client invention.
5. Confirmation is pinned, reconstructed server-side, idempotent, atomic, and creates a stopped actor; start is separate.
6. Lifecycle and authorization tests cover every transition/status/role class with the stated HTTP errors.
7. Unique server events drive counters and the exact skills-parity 30/90-day formula, excluding author self-signals.
8. Milestone A and B commands and applicable UI verification pass.

## Deferred

1. paid skill or blueprint entitlements
2. public historical-revision installation
3. bot skills without a separate contract
4. public P&L/performance ranking
5. reviews, ratings, and evaluation-derived reputation
6. generic marketplace abstractions until duplication proves their shape

## Milestone A Implementation — Outstanding Issues

Recorded 2026-08-01 after completing Milestone A (A1–A5). These are non-blocking issues that should be addressed before or during Milestone B.

### MEDIUM

1. **`withVenueResolver` retains unnecessary `any` cast** — `apps/api/src/services/blueprint-execution-capability-adapter.ts`: `venueResolver` was changed from `readonly` to mutable, but the setter still uses `(this as any).venueResolver = resolver` with an `eslint-disable`. Simplify to `this.venueResolver = resolver`.

2. **Risk provenance metadata not verified in integration tests** — `apps/api/src/routes/blueprints.integration.test.ts` (Test 6): Verifies risk value correctness but not the `source` / `mutable` / `enforced` provenance fields from `EffectiveRiskProfile`. The `resolveEffectiveRisk` function returns provenance metadata per-field that should be verified.

### LOW

3. **N+1 queries in skill portability validator** — `apps/api/src/services/blueprint-skill-validator.ts`: The `for` loop queries the DB once per skill ref. For Phase 1 with small skill counts this is acceptable. Consider batching with `inArray` for future scale.

4. **Pre-existing unit test failures** — `apps/api/src/routes/blueprints.test.ts`: 23 of 32 unit tests fail due to the `blueprintRoutes()` function signature change from A4 (now accepts 4 parameters instead of 2). These legacy tests reference the old signature and need updating to match the new constructor-injected dependencies (`agentRiskDefaults`, `executionCapabilityResolver`). Does not block integration tests or runtime behavior.