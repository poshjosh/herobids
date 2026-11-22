# Strategy Preset Tools Dropped (No Local Registry Entry) Bugfix Design

## Overview

Traderton tags three tools to `traderton/skills/crypto-trading`: `list_strategy_presets`,
`assess_strategy_preset` and `change_strategy_preset`. Herobids shows an agent only the tools
that are both tagged by Traderton and present in its own local tool registry
(`buildBackendToolVisibility`). Commit `88e67c98` deleted the local tools and added no
replacement, and `list_strategy_presets` never existed locally. All three are dropped on every
agent start (`not_in_local_registry`), so an agent sees 19 of 22 tools and cannot review or
switch its own preset.

The fix has four parts, all in Herobids, plus one out-of-repo Traderton task:

1. Add three thin proxy tools in a new file `apps/worker/src/tools/strategy-presets.ts` that
   forward to Traderton (two reads, one side-effecting write). They carry no trading logic.
2. Register them consistently (tool name list, catalog, registry barrel, capability manifest doc).
   The visibility intersection is not touched.
3. Make a future gap loud: one `error` log per skill when a tagged tool is dropped, and a
   regression test that fails when any tool in a checked-in copy of Traderton's skill map is
   missing from the registry.
4. Fix the stale comments and docs that tell agents and maintainers these tools already work.

Traderton also needs a small change before `list_strategy_presets` and `change_strategy_preset`
work end to end (section "Out-of-repo Traderton task"). That task is separate, ships first, and
is not edited from this repo.

This design re-verified the requirements against the code. Corrections to `bugfix.md` are listed
in "Corrections to the requirements phase" so nothing downstream relies on a wrong claim.

## Glossary

- **Bug_Condition (C)**: An approved backend skill has a tool the backend tags to it that has no
  entry in the local registry, so the tool is dropped from the agent's visible set.
- **Property (P)**: Every tool the backend tags to an approved skill and that Herobids is expected
  to expose is in the local registry, visible, and forwards to Traderton correctly when called.
- **Preservation**: Behaviour of the other 19 `crypto-trading` tools, the other two Traderton
  skills, unapproved and system skills, fail-closed degradation, the web review screen, and the
  `assessment_review` wake content, none of which may change.
- **Local proxy**: A Herobids `AgentTool` whose `execute` only names a Traderton tool, forwards a
  validated payload plus platform-owned values (the venue account), and maps the result.
- **Selected venue account**: The agent's newest active connection grant that has a resolved
  venue account, returned by `ctx.selectedVenueAccountResolver`. Attached by the platform after
  the LLM call; the LLM never supplies it.
- **Read port**: `ctx.externalBackend.invoke` (single signed call, no polling, deadline from
  `endpoint.requestTimeoutMs`, 10 s by default).
- **Write port**: `ctx.externalBackendWrite.invokeAndAwait` (signed call, polls to a deadline,
  idempotency key minted per call by `createSubjectBoundWriteBoundary`).
- **buildBackendToolVisibility**: `apps/worker/src/external-backend/backend-tool-visibility.ts`.
  Computes visible tools as (tagged by backend) ∩ (local registry).
- **Skill map**: Traderton's `SKILL_TOOL_MAP` in `packages/boundary/src/mcp/skill-tool-map.ts`,
  the source of the tool tags returned by MCP `tools/list`.

## Bug Details

### Bug Condition

The bug manifests when Traderton tags a tool to an approved skill and Herobids has no local tool
of that name. `buildBackendToolVisibility` then puts the tool in `droppedTools` and the agent
never sees it. The same gap also means the tool cannot be called even if the model tries,
because `executeTool` rejects names outside `allowedTools()`.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type { skillRef: string, toolName: string,
                     approvedRefs: Set<string>,
                     backendTags: Map<string, Set<string>>,   // skillRef -> tool names (MCP tools/list)
                     registryNames: Set<string> }             // createToolRegistry().list() names
  OUTPUT: boolean

  RETURN X.skillRef IN X.approvedRefs
         AND X.toolName IN X.backendTags[X.skillRef]
         AND X.toolName NOT IN X.registryNames
END FUNCTION
```

Today the condition holds for exactly three inputs, all with `skillRef = traderton/skills/crypto-trading`:
`list_strategy_presets`, `assess_strategy_preset`, `change_strategy_preset`. Checked against the
code: every tool in all three Traderton skill maps (22 + 9 + 11 entries, 29 distinct names, which
matches the `discoveredToolCount: 29` in the staging log) other
than these three is in `KNOWN_AGENT_TOOL_NAMES`, and the worker startup assertion guarantees
known names equal registry names.

### Examples

- Agent `bright-parrot` starts with `crypto-trading`. Expected: 22 tagged tools visible. Actual:
  `toolCount: 19, taggedToolCount: 22, droppedTools: [list_strategy_presets, assess_strategy_preset, change_strategy_preset]`.
- An `assessment_review` wake arrives. `buildAssessmentReviewMessage` says "Call
  `assess_strategy_preset`". Expected: the tool exists. Actual: the runtime answers
  `tool rejected: assess_strategy_preset is not available in the current skill set`.
- The agent reads the `crypto-trading` SKILL.md section on presets and tries
  `list_strategy_presets`. Expected: the catalog. Actual: rejected as not in the active skill set.
- Edge: Traderton adds `get_market_structure` to the skill map before Herobids ships a proxy
  (see `docs/features/pending/000-multi-timeframe-market-structure/001-plan.md`). Expected:
  the gap is loud in logs and caught by a test. Actual today: a quiet `warn`.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- The 19 other `crypto-trading` tools stay visible and route as before (3.1).
- Unapproved external skills and `system/*` skills are returned unchanged (3.2).
- An unreachable backend still hides approved tools, keeps the skill loadable as text, and never
  throws into agent start (3.3).
- Tools Traderton does not tag to a skill (`list_agent_strategy_changes`,
  `get_assessment_artifact`, `get_strategy_presets`) stay hidden from agents (3.4).
- The web review screen keeps calling Traderton directly from the API process (3.5).
- `adjust_risk_limits`, `get_risk_limits`, `submit_decision` and market-data proxies behave as
  before, including fail-closed degradation (3.6).
- The `assessment_review` wake message text and its routing to the scout/judge loop (3.7).
- No trading logic, preset definitions, risk limits, venue calls or `@traderton/*` imports in
  Herobids (3.8). The `crypto-trading` skill text is served unchanged (3.9).

**Scope:** every input where C(X) is false. The visibility intersection, the shared result
mappers (`mapReadResultToToolResult`, `mapWriteResultToToolResult`), the read and write adapters
and the Traderton transport are not modified.

## Hypothesized Root Cause

Confirmed by reading the code, not just hypothesized:

1. **Deleted without a replacement.** `88e67c98` removed `assess-strategy-preset.ts`,
   `change-strategy-preset.ts`, their registry entries, catalog entries, broker routes and
   capability grants, and described the tools as "reached over the external-backend path". The
   agent's only path to Traderton is a local proxy, and none was added.
2. **`list_strategy_presets` was never local.** No definition exists in Herobids history for the
   agent runtime; it arrived with Traderton's 004 plan.
3. **The drop is silent by design.** `buildBackendToolVisibility` logs one `info` summary and one
   `warn` per dropped tool, and `recordBackendToolReport` adds a `warn`. Nothing fails, and a
   count of 19 reads as normal.
4. **No test ties the two repos together.** `backend-tool-visibility.test.ts` uses a made-up
   `ghost_tool`; no test asserts that Traderton's real skill map is satisfied.
5. **Stale text hid the gap.** Comments in `agent.ts` still claim the tools are "implemented and
   registered", and the generated platform docs list them as required tools.

Rejected hypotheses: a capability or grant denial (the old grants were removed by `88e67c98` and
new proxies do not call `checkAccess`), a category gate (none exists for external-skill tools),
and a write-port allow-list (the write boundary and Traderton's REST app have no per-tool
allow-list; `watch_token` and others already use it).

## Correctness Properties

Property 1: Bug Condition - Tagged tools are visible and forward to Traderton

_For any_ input where the bug condition holds today (the three preset tools tagged to an
approved `crypto-trading` skill), the fixed system SHALL include the tool in the local registry,
report it in `requiredTools` with an empty `droppedTools` list (22 of 22 visible), and when the
tool is called with valid parameters SHALL forward exactly one Traderton call whose payload is
the validated LLM parameters plus the platform-resolved venue account where the tool is
account-scoped, returning Traderton's data or its mapped failure unchanged.

**Validates: Requirements 2.1, 2.2, 2.3, 2.6, 2.10**

Property 2: Bug Condition - Fail closed without a boundary or account

_For any_ call to one of the three tools where the required Traderton port is absent, the tool
SHALL return `precondition.not_ready` (`fault: false`) without any local fallback; and _for any_
call to `assess_strategy_preset` or `change_strategy_preset` where the selected venue account is
`missing` or `provisioning`, the tool SHALL return `connection.missing` or
`connection.provisioning` respectively without calling Traderton.

**Validates: Requirements 2.4, 2.5**

Property 3: Bug Condition - A dropped tagged tool is reported loudly

_For any_ approved skill where at least one tagged tool is not in the local registry, the fixed
`buildBackendToolVisibility` SHALL log exactly one `error` entry naming the `skillId`,
`sourceRef` and every dropped tool, SHALL still never throw, and SHALL still hide the dropped
tools; and _for any_ tool in the checked-in Traderton skill-map fixture that is not allow-listed,
the repository tests SHALL fail if the tool is missing from the registry.

**Validates: Requirements 2.7, 2.8, 2.9**

Property 4: Preservation - Everything outside the bug condition is unchanged

_For any_ input where the bug condition does NOT hold (any other tool, skill or backend state),
the fixed code SHALL produce the same visibility result, tool results and wake text as the
original code, preserving the 19 other `crypto-trading` tools, the other approved skills,
unapproved and system skills, unreachable-backend degradation, web review-screen calls and
`assessment_review` wake content.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**

## Fix Implementation

### Changes Required

#### 1. Registration surface (requirement 2.6)

Every place that enumerates tool names was checked. The proxies are visible only through
external-skill discovery, so nothing else needs to list them.

| Surface | Decision | Reason |
|---|---|---|
| `KNOWN_AGENT_TOOL_NAMES` (`packages/domain/src/tools.ts`) | Add `assess_strategy_preset` (after `append_file`), `change_strategy_preset` (after `browse_url`), `list_strategy_presets` (after `list_skills`) | Required by `assertToolCatalogMatchesRegistry`; `tool-registry.test.ts` compares sorted names. Keeps alphabetical order; no ordering test is affected |
| `TOOL_CATALOG` (same file) | Add three entries, categories below | Required by the same assertion, which also compares categories |
| Registry barrel `apps/worker/src/tools/index.ts` | Import `strategyPresetTools` and spread it into `allTools` | Registers the tools |
| `docs/features/pending/000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md`, "Exhaustive Tool Ownership" | Add three rows, owner `external:trading` | `apps/api/src/routes/providers.test.ts` asserts the table equals `KNOWN_AGENT_TOOL_NAMES`. Not in the requirements; found by reading tests |
| `MARKET_DATA_TOOLS`, `DATABASE_DEPENDENT_TOOLS` (`runtime-tool-visibility.ts`) | No change | These encode local runtime dependencies. The siblings `get_risk_limits`, `adjust_risk_limits`, `get_funding_info` use the same resolver and boundary and are in neither set. A trading agent without a boundary already crashes at startup, so the sets cannot matter here |
| `permanentlyExcludedTools` (`agent.ts`) | No change | Only `execute_shell` and the two sets above feed it |
| `DEFAULT_CAPABILITY_GRANTS`, `capabilityEngine.checkAccess` | No change | The proxies never call `checkAccess`. The old brokered grants were deleted by `88e67c98`. Adding a grant would be dead config. The existing drift-guard test (from the `make_http_request` fix) covers any future literal `checkAccess('<name>')` without a grant |
| `agent-message-broker.ts` tool-message mapping | No change | The legacy `agent.tool.*_strategy_preset.request` routes stay deleted; `agent-message-broker.test.ts` asserts the rejection |
| `packages/domain/src/tool-schemas.ts` (`get_schema`) | No change | Holds nested config schemas only (`create_bot.config.*`, `publish_artifact.*`, `submit_decision.targetSize`). `adjust_risk_limits` and the other proxies have no entry |
| Built-in skills (`BASE_SKILL`, `SYSTEM_SKILLS`) `requiredTools` | No change | Visibility comes from the approved external skill |
| `tool-signature.ts` `FILE_TOOL_PARAMS` | No change | File tools only |
| Scout read-only set (`toolRegistry.getReadOnlyToolNames()`, `agent.ts:3979`) | Automatic from category | Categories starting `read-` are scout-visible, so `list_strategy_presets` and `assess_strategy_preset` are available to the scout and `change_strategy_preset` is judge-only. `assess_strategy_preset` was `read-database` before `88e67c98`, so this matches the old behaviour |
| Judge tool definitions, `registryToolNames` (`agent.ts:1070`), `/api/v1/agent-tools`, `findUnknownSkillTools`, prompt `formatVisibleTools` | Automatic | Derived from the registry, catalog or visible set |

**Categories (local catalog and tool must agree).** Align with Traderton so a reader comparing
the repos sees the same classification:

| Tool | Category | Catalog description |
|---|---|---|
| `list_strategy_presets` | `read-config` | List the strategy presets you can choose from (key, name, description, strategy type, signal bias, behavior version). |
| `assess_strategy_preset` | `read-market-data` | Get computed, data-only evidence and per-preset scorecards and flags for one or more symbols, to decide whether to switch preset. Free. |
| `change_strategy_preset` | `write-database` | Switch your active strategy preset using a fresh assessment artifact and a reason shown on the review screen. |

**Visible-but-denied analysis.** A call to a visible tool passes these gates in order:
`allowedTools()` (skill `requiredTools` minus permanent, degraded and circuit exclusions) →
`toolRegistry.get` → Zod parameter validation → `execute`. `execute` returns typed results for a
missing boundary or account. There is no capability, grant, category, permission-level or
execution-mode gate on this path. The circuit breaker counts only `fault: true` results, and the
shared mappers classify `validation.invalid_payload`, `not_found.resource`,
`precondition.not_ready` and `authorization.denied` as `fault: false`.

#### 2. Venue-account handling (item 2)

How the siblings work (`apps/worker/src/tools/risk-limits.ts`, `account.ts`):

- `resolveSelectedVenueAccountId(ctx)` calls `ctx.selectedVenueAccountResolver()`, which joins
  `agent_connections` and `connections`, keeps active grants whose connection is active and has
  `resolvedVenueAccountId`, and picks the newest grant (tie-break on assignment id). A resolver
  that is missing or throws becomes `{ status: 'missing' }`. The result is
  `ready | missing | provisioning`.
- `selectedAccountUnavailable(resolution)` returns, both with `success: false, fault: false`:
  - `connection.provisioning`: "your trading connection is being set up and its account is not
    ready yet, retry shortly".
  - `connection.missing` (`errorOwner: 'user'`): "no trading connection is set up yet, call
    list_providers ... then request_connection".
- The platform adds `venueAccountId` to the payload after the LLM call. It is not in any LLM
  schema, and because `executeTool` passes `parametersSchema.safeParse(...).data` to `execute`,
  a model-supplied `venueAccountId` is stripped.
- The API review route uses `selectExecutionBinding(loadActiveTradingProfileConnections(...))`.
  Its source comment says it uses "the same order and the same default as runtime selection".
  Edge: when the newest active connection has no resolved account, the runtime resolver skips it
  while the API default falls back to the first ready connection in row order. This is existing
  behaviour shared with every account-scoped tool; the proxies use the runtime resolver, like
  `get_risk_limits`.

**Payload each proxy sends** (the proxy adds only the venue account; it adds no defaults, no
limits and no preset knowledge):

| Tool | Port | LLM parameters (Zod, `parametersSchema`) | Payload sent to Traderton | Account resolved? |
|---|---|---|---|---|
| `list_strategy_presets` | read | `styleTier?: 'economy' \| 'standard' \| 'premium'` | `{}` or `{ styleTier }` | No. The catalog is venue-independent; requiring a connection would block a pre-connection read |
| `assess_strategy_preset` | read | `symbols: string[]` (min 1, max 50), `venueFamily: string`, `instrumentKind?: 'orderbook' \| 'perp' \| 'swap' \| 'dex'` | `{ symbols, venueFamily, [instrumentKind], venueAccountId }` | Yes (Traderton declares `venueAccountId` optional and needs it to build the assessment context) |
| `change_strategy_preset` | write | `assessmentArtifactId: string`, `targetPreset: string`, `mode: 'entries_only'`, `reason: string` | `{ assessmentArtifactId, targetPreset, mode, reason, venueAccountId }` | Yes (Traderton keys the profile by owner + actor + venue account) |

Notes:
- `instrumentKind` is omitted from the payload when the model did not pass it, so Traderton's own
  default applies. No default is invented in Herobids.
- `change_strategy_preset` always sends `venueAccountId`. Today Traderton strips the undeclared
  key (it is a non-strict `z.object`), so the extra field is harmless before the Traderton change
  ships and required after it.
- `list_strategy_presets` sends no account on purpose. See the Traderton task for why the
  recommended Traderton change keeps it that way.

#### 3. Proxy tools and the write path for `change_strategy_preset` (items 2 and 3)

New file `apps/worker/src/tools/strategy-presets.ts`, exporting `strategyPresetTools`, modelled
on `risk-limits.ts` (imports `resolveSelectedVenueAccountId` and `selectedAccountUnavailable`
from `./risk-limits.js`, as `account.ts` already does). Tool names, parameter names and schemas
follow Traderton's wire contract. The copied bounds (`min(1)`, `max(50)`, the enums) are wire
validation, not trading logic; they exist so the model gets a self-correcting parameter error
instead of a generic `validation.invalid_payload` from Traderton.

```ts
const CHANGE_STRATEGY_PRESET_DEADLINE_MS = 30_000; // same value as adjust_risk_limits / watch writes

const BOUNDARY_NOT_READY: ToolResult = {
  success: false, error: 'trading boundary not configured',
  errorCode: 'precondition.not_ready', fault: false,
};

// list_strategy_presets (read)
async execute(params, ctx) {
  if (!ctx.externalBackend) return BOUNDARY_NOT_READY;
  const { styleTier } = params as z.infer<typeof ListStrategyPresetsParamsSchema>;
  return mapReadResultToToolResult(await ctx.externalBackend.invoke({
    toolName: 'list_strategy_presets',
    payload: styleTier ? { styleTier } : {},
  }));
}

// assess_strategy_preset (read)
async execute(params, ctx) {
  if (!ctx.externalBackend) return BOUNDARY_NOT_READY;
  const resolution = await resolveSelectedVenueAccountId(ctx);
  if (resolution.status !== 'ready') return selectedAccountUnavailable(resolution);
  const { symbols, venueFamily, instrumentKind } = params as z.infer<typeof AssessParamsSchema>;
  return mapReadResultToToolResult(await ctx.externalBackend.invoke({
    toolName: 'assess_strategy_preset',
    payload: { symbols, venueFamily, ...(instrumentKind ? { instrumentKind } : {}),
               venueAccountId: resolution.venueAccountId },
  }));
}

// change_strategy_preset (write)
async execute(params, ctx) {
  if (!ctx.externalBackendWrite) return BOUNDARY_NOT_READY;
  const resolution = await resolveSelectedVenueAccountId(ctx);
  if (resolution.status !== 'ready') return selectedAccountUnavailable(resolution);
  const { assessmentArtifactId, targetPreset, mode, reason } = params as z.infer<typeof ChangeParamsSchema>;
  const result = await ctx.externalBackendWrite.invokeAndAwait({
    toolName: 'change_strategy_preset',
    payload: { assessmentArtifactId, targetPreset, mode, reason, venueAccountId: resolution.venueAccountId },
    deadlineMs: CHANGE_STRATEGY_PRESET_DEADLINE_MS,
  });
  return mapWriteResultToToolResult(result);
}
```

**Write-path facts, verified against code** (the `adjust_risk_limits` pattern, copied):

- Idempotency: the tool supplies only `toolName`, `payload` and `deadlineMs`. The agent-container
  port is `createSubjectBoundWriteBoundary`, which mints `randomUUID()` per `invokeAndAwait` and
  binds the subject `{ ownerId, actor: { type: 'agent', id } }`. One tool execution is one
  logical write with one key. `ExternalBackendClient.invokeAndAwait` re-issues the same key only
  while the outcome is unknown, inside the same call. The tool must never pass or cache a key.
- Deadline: 30 s, the same constant value used by `adjust_risk_limits` and the watch writes. No
  new operator config and no new `.env` variable.
- Result mapping: `mapWriteResultToToolResult`. `success` returns the payload unchanged.
  `failure` keeps `code` and `retryable`; `fault` is false for `validation.invalid_payload`,
  `not_found.resource`, `precondition.not_ready`, `authorization.denied`, true otherwise.
  `in_progress` at the deadline becomes `precondition.not_ready` (retryable, `fault: false`).
  `transport_error` becomes `boundary.transport_error` (`errorOwner: 'platform'`, `fault: true`).
- Traderton routes the write through its idempotency store because `write-database` is not a
  read category (`dispatcher.ts`, `isSideEffecting`), and the REST app has no tool allow-list.
- Traderton's tool-level refusals (`assessment.artifact_expired`, `assessment.preset_not_allowed`,
  `assessment.preset_changes_disabled`, `assessment.cooldown_blocked` inside assess results)
  reach Herobids as `validation.invalid_payload` with the readable message; the specific code
  travels in `details.errorCode`, which the shared mapper does not forward. The messages tell the
  agent what to do (for example "Request a fresh assessment before changing your preset").
  Forwarding `details.errorCode` would change a shared mapper used by the existing proxies, so
  it is a deliberate non-goal here.

**Traderton's schema for `change_strategy_preset`** (`ChangeStrategyPresetParamsSchema`, read at
Traderton HEAD `0ea5654`): `assessmentArtifactId` (min 1), `targetPreset` (min 1), `mode`
(`enum['entries_only']`, required), `reason` (min 1, required). The Herobids schema matches it
field for field. `mode` stays required rather than defaulted, so Herobids does not decide the
contract if Traderton adds modes.

**LLM-facing descriptions** (every parameter has one; a test asserts this):

- `list_strategy_presets`: "List the strategy presets you can choose from: key, name,
  description, strategy type, signal bias and behavior version. Read only. Use it to learn preset
  keys before assess_strategy_preset or change_strategy_preset."
  - `styleTier`: "Style tier to list. Omit to list all tiers."
- `assess_strategy_preset`: "Get computed data to decide whether to switch your strategy preset,
  for one or more symbols: market evidence, a scorecard and flags for each preset, an
  artifactId and expiresAt. Data only: no recommendation and no narrative, and it is free. Pass
  the artifactId to change_strategy_preset. The crypto-trading skill explains how to read the
  flags."
  - `symbols`: "Trading symbols to assess, for example [\"BTC\", \"ETH\"]. When you were woken
    for a review, use the candidate symbols. Symbols beyond the platform cap are ignored and the
    response reports the cap (maxInstrumentsPerRequest)."
  - `venueFamily`: "Venue family to assess against, for example \"hyperliquid\". Required. When
    you were woken for a review, use the venue family shown for the candidate."
  - `instrumentKind`: "Instrument kind shared by all symbols: orderbook, perp, swap or dex.
    Defaults to orderbook when omitted."
- `change_strategy_preset`: "Switch your active strategy preset. Needs the artifactId from a
  recent assess_strategy_preset call (it must not have expired), the target preset key, mode
  entries_only and a reason. The creator's policy and cooldowns are enforced by the trading
  backend, and a refusal comes back as an error with the reason."
  - `assessmentArtifactId`: "The artifactId returned by assess_strategy_preset. It must not have expired."
  - `targetPreset`: "Key of the preset to switch to, as listed by list_strategy_presets or shown in the assessment."
  - `mode`: "Only entries_only is supported."
  - `reason`: "Why you are changing preset, in your own words. It is shown to the creator on the review screen. Required."

No `promptGuidance` is added (the skill text already carries the guidance, and it would cost
prompt tokens on every tick).

#### 4. Out-of-repo Traderton task (item 4; not edited here)

Re-read at Traderton `main` (`0ea5654`, one commit after tag v0.2.2). The requirements' claim is **confirmed**, with
one refinement for `list_strategy_presets`.

Mechanism, in order of execution (`packages/boundary/src/dispatcher.ts`, `bin.ts`,
`subject-resolver.ts`):

1. `dispatch` validates the payload with `tool.parametersSchema.safeParse(invocation.payload)` and
   passes `payloadParse.data` onward. The schemas are plain `z.object`, so undeclared keys are
   stripped, not rejected.
2. `contextFactory` computes `skipVenueResolution = isReadOnlyCategory(category) || tool.ownerScopedNoVenue`.
   `list_strategy_presets` (`read-config`), `assess_strategy_preset` (`read-market-data`) and
   `change_strategy_preset` (`write-database`, `ownerScopedNoVenue: true`) all skip venue
   resolution.
3. `resolveSubjectInjection` on the skip path reads `venueAccountId` from the (already stripped)
   payload. If present it checks the account belongs to the owner (`authorization.denied`
   otherwise) and returns it; if absent the injection has `venueAccountId: ''`.
4. `presetAssessment` is built only when `actor.type === 'agent' && injection.venueAccountId` is
   truthy. All three tools return `preset assessment not available in this context` when it is
   absent. The profile, preset policy and active strategy are loaded with the same account.

Result per tool:

| Tool | Declares `venueAccountId` | Works end to end from Herobids today |
|---|---|---|
| `assess_strategy_preset` | Yes (optional) | **Yes**, once Herobids forwards the account. The API review route already does this |
| `list_strategy_presets` | No | **No**: key stripped, context absent |
| `change_strategy_preset` | No | **No**: key stripped, context absent |

**Task T1 (`list_strategy_presets`).** Recommended: read from the always-present
`ctx.presetCatalog` (the same source `get_strategy_presets` uses; same `listPresets(tier)` shape)
instead of `ctx.presetAssessment`, in `packages/worker/src/tools/preset-assessment.ts`. No schema
change, no account needed, and the tool then works before a connection exists. Add a test that
the tool succeeds with `presetCatalog` set and `presetAssessment` unset. Alternative if the
Traderton owner prefers to keep the current seam: declare `venueAccountId` optional on its schema
as `assess_strategy_preset` does. That needs a one-line Herobids follow-up (resolve and send the
account in the list proxy), so it is not the recommended option.

**Task T2 (`change_strategy_preset`).** In `packages/domain/src/preset-assessment.ts`, add
`venueAccountId: z.string().min(1).optional()` with the description "Consumer-injected venue
account binding. Never an LLM input." to `ChangeStrategyPresetParamsSchema`, mirroring
`AssessStrategyPresetParamsSchema`. (Traderton's `adjust_risk_limits` instead declares it
required and builds an LLM-facing schema with `.omit({ venueAccountId: true })`; either pattern is
fine. Keep it optional if other callers could exist.) Keep the `get_schema` entry for
`change_strategy_preset` in `packages/domain/src/tool-schemas.ts` in step. The tool stays
`ownerScopedNoVenue`, so the skip path validates ownership and returns the account, which builds
`presetAssessment` with the profile. Add a dispatcher or context-factory test: a payload carrying
`venueAccountId` yields a non-empty `presetAssessment.venueAccountId` for this tool, and one
without it still returns the "not available" error.

Both tasks are additive and backward compatible: an older Herobids build that never sends the key
behaves as before. Deploy Traderton first so Herobids never exposes a tool that cannot work.

**Behaviour in each rollout state** (both are safe for Herobids; the proxies are correct in both):

| State | `list_strategy_presets` | `assess_strategy_preset` | `change_strategy_preset` |
|---|---|---|---|
| Herobids fixed, Traderton T1/T2 not deployed | Traderton error "preset assessment not available in this context" mapped to `validation.invalid_payload`, `fault: false` (no breaker trip, no fallback) | Works | Same error as list |
| Both deployed | Works | Works | Works |

#### 5. Visibility reporting (item 5, requirement 2.7)

Current behaviour (verified): `buildBackendToolVisibility` logs one `info` summary
(`toolCount`, `taggedToolCount`, `discoveredToolCount`, `droppedTools`, `keptTools`), then one
`warn` per dropped tool ("tool tagged for this skill was not made visible"); `agent.ts`
`recordBackendToolReport` adds one `warn` ("Approved external skill tools are not all visible
after discovery") for any non-`tools_exposed` outcome. These were all present on staging and went
unnoticed.

Change in `backend-tool-visibility.ts`:

- Add `error(fields, message)` to `BackendToolVisibilityLogger`. The only production caller
  passes the pino `logger`, which already has it.
- Replace the per-tool `warn` loop with one `error` per skill when `droppedTools.length > 0`:

```ts
logger.error(
  {
    skillId: skill.id,
    sourceRef: ref,
    droppedToolNames: droppedTools.map((t) => t.name),
    droppedTools,                       // [{ name, reason: 'not_in_local_registry' }]
    visibleToolCount: visible.length,
    taggedToolCount: tagged.length,
  },
  'Backend tool visibility: backend tags tools for this skill that this runtime cannot call',
);
```

- Keep the `info` summary as is. It is the line the staging check reads.
- Keep `recordBackendToolReport`'s `warn` unchanged. It also covers `backend_unreachable`, which
  is transient and stays at `warn`.

Why `error` and one line per skill: a dropped tagged tool is a deployment skew (Traderton is
ahead of this build). It never heals without a code change, and it is the exact condition that
shipped broken. `backend_unreachable` is transient and keeps `warn`. A single summary line with a
flat `droppedToolNames` array is easy to grep and replaces N near-identical lines. The function
still never throws and still hides the dropped tools (3.3).

Existing tests that assert the current `warn` behaviour, all in
`backend-tool-visibility.test.ts`:

- "records each tagged tool that was not made visible, with the reason, and logs it" asserts
  `warn` was called with `{ tool: 'ghost_tool', reason }`. Change it to assert one `error` call
  with `droppedToolNames: ['ghost_tool']`, `skillId`, `sourceRef` and counts, and that `warn` was
  not called for the drop.
- Every logger literal in that file (`const logger`, `{ info, warn }`, `{ info, warn: vi.fn() }`)
  gets `error: vi.fn()` so a drop in any test cannot hit a missing method. Tests are not
  type-checked by `pnpm build` or `pnpm lint`, so this is a runtime concern only.
- `read-skill.test.ts` and the `summarizeBackendToolVisibility` tests use `ghost_tool` only as
  data and are unaffected.

A runtime allow-list for intentional drops is not added (YAGNI): after this fix there are no
intentional drops, and consumer-only tools are not in any skill map (3.4). If Herobids ever hides
a tagged tool on purpose, it adds the allow-list then.

#### 6. Regression test and fixture (item 6, requirement 2.9)

Herobids cannot import `@traderton/*` (INV-L1) and `@poshjosh/contracts@0.3.0` carries no skill
or tool map (checked its `dist`: `assessment`, `trading` and index only). So the test uses a
checked-in expectation, not Traderton code.

- New fixture `apps/worker/src/external-backend/__fixtures__/traderton-skill-tools.json`. JSON, so it
  is plain data, is not compiled into `dist`, and is read with `readFileSync` like the existing
  signing-vector fixture.

```json
{
  "source": { "repo": "traderton", "file": "packages/boundary/src/mcp/skill-tool-map.ts",
              "commit": "0ea5654", "note": "one commit after tag v0.2.2; update when re-copied" },
  "skills": {
    "traderton/skills/crypto-trading": ["get_market_overview", "...22 names..."],
    "traderton/skills/crypto-bot-management": ["...9 names..."],
    "traderton/skills/crypto-risk-monitoring": ["...11 names..."]
  },
  "notExposed": {}
}
```

  `notExposed` maps `skillRef -> { toolName: "reason" }` and starts empty. It is the explicit
  allow-list for any tagged tool Herobids intentionally does not expose.

- New test `apps/worker/src/external-backend/backend-skill-tools.test.ts`:
  1. Every fixture tool, minus `notExposed`, is in `createToolRegistry().list()` names. Failure
     message names the skill and tool.
  2. Every `notExposed` entry is a tagged tool, is absent from the registry, and has a non-empty
     reason (a stale allow-list entry fails).
  3. Feeding `buildBackendToolVisibility` a discovery result built from the fixture and the real
     registry names gives `requiredTools` of the full list, `droppedTools: []`,
     `taggedToolCount` equal to the fixture length (22 for `crypto-trading`), and no `error` log.
  4. Negative control: the same run with `change_strategy_preset` removed from the registry names
     reports exactly that tool dropped and one `error` log. This proves the guard can fail.

- Keeping it in sync. A fixture-only check cannot see a Traderton change nobody copied, so there
  are three layers, stated honestly:
  1. The fixture header (`source`) records the Traderton release and commit it was copied from,
     and the plan for any new Traderton skill-map tool says to update the fixture in the same
     Herobids change that adds the proxy (for example `get_market_structure` in
     `000-multi-timeframe-market-structure/001-plan.md`).
  2. The runtime `error` log from section 5 is the live detector in every environment: a tool
     Traderton tags that Herobids lacks shows up at startup.
  3. Long-term and out of scope: ask Traderton to publish the skill map in `@poshjosh/contracts`
     (ADR 018 disposition 3, exact-version pin). Then the test imports the real map and the
     fixture is deleted. An optional manual script that diffs the fixture against a running
     boundary's `tools/list` using the existing `discoverExternalBackendTools` is a possible
     follow-up; it is not part of this fix.

- Policy check (AGENTS.md: "Do not reintroduce mirrored trading files"; INV-L2). This fixture is
  a consumer-side expectation of tool names only. It carries no schemas, preset definitions or
  logic, it is not byte-compared with any Traderton file, it is not shipped, and no parity
  tooling is reintroduced. It must stay names-only.

#### 7. Stale comments and docs (item 7)

Exact edits:

| File | Location | Change |
|---|---|---|
| `apps/worker/src/agent.ts` | ~3401-3404, the `NOTE: Transition tools ... are now implemented and registered` block | Replace with: the review tools (`list_strategy_presets`, `assess_strategy_preset`, `change_strategy_preset`) are local proxies in `tools/strategy-presets.ts` that forward to Traderton, which owns assessment, policy, cooldowns and the change; they are visible only when Traderton tags them to the agent's approved skill |
| `apps/worker/src/agent.ts` | ~3414 ("can use assessment tools to request a full platform assessment, evaluate, and apply preset changes") | Reword to "call `assess_strategy_preset` (data-only, free), read the flags, and call `change_strategy_preset` if the data clearly shows a better fit". No platform assessment exists |
| `apps/worker/src/agent.ts` | ~3420 (`assess_strategy_preset → review rankings → change_strategy_preset`) | "review rankings" becomes "read flags". There are no rankings in the data-only flow |
| `apps/worker/src/agent.ts` | ~1900-1902 (`appendJournal` no-op comment: "consumed by change_strategy_preset") | Drop the reference; the tool no longer reads `agentConfigOps`. Comment only, behaviour unchanged |
| `apps/worker/src/hybrid-agent-evaluator.ts` | ~50 (`review rankings`) | Same wording fix. Comment only |
| `apps/worker/src/assessment-review-message.ts` | JSDoc lines ~10-13 | "(now a Traderton data-only tool)" becomes "(a local proxy that forwards to Traderton's data-only tool)". **The message text is not changed** (3.7; `assessment-review-message.test.ts` and `agent-assessment-review.test.ts` assert exact fragments) |
| `scripts/ts/build-docs-index.ts` | lines 550 and 559 (the `skills/trading` entry) | Add `list_strategy_presets` to "Required tools" and to the "Decide" line, next to `assess_strategy_preset, change_strategy_preset` |
| `apps/worker/src/tools/platform-docs-data.ts` | lines ~1716 and ~1725 | **Generated** ("DO NOT EDIT MANUALLY"). Regenerate with `pnpm --filter @herobids/scripts run build-docs-index` (`pnpm build` runs it first). Check `git diff` for this file shows only those two lines; if unrelated content drift appears, stop and report instead of committing it |
| `apps/worker/src/external-backend/agent-ports.ts` | line ~95 log text "read tools + risk-limit writes route over REST" | Optional hygiene: "read tools + side-effecting writes route over REST". The write port is generic; the old text suggested only risk-limit writes were wired. No test asserts the string |
| `docs/bug-reports/2026/11/21/001-preset-tools-dropped-no-local-registry-entry.md` | Status and "Files Changed" | Update when the fix lands |
| `CHANGELOG.md` | `[Unreleased]` | Add the entry below |

Not changed on purpose: `buildPresetReviewMessage` in `agent.ts` (documented DEFERRED and unused;
its text mentions rankings and `allowedPresets` that the data-only assessment no longer returns,
which is a separate cleanup), the `Trading skill (id: trading)` legacy wording and the missing
`get_funding_info` in that generated doc entry (pre-existing and unrelated), the skill text in
`traderton-skills` (3.9), and `docs/product/PROBLEMS-WITH-TRADING-EXTRACTION.md` (a dated
Q&A transcript).

**CHANGELOG entry** (`[Unreleased]`):

```
### Fixed
- Agents with the `crypto-trading` skill can now use `list_strategy_presets`, `assess_strategy_preset` and `change_strategy_preset`. Herobids dropped all three on every start because it had no local tool for them (`not_in_local_registry`), so agents saw 19 of 22 tools while the review wake and the skill text told them to call tools they did not have. The three are now thin proxies to Traderton (reads for list and assess, a side-effecting write with a 30 s deadline and a fresh idempotency key per call for change). Assess and change send the agent's selected venue account and return `connection.missing` or `connection.provisioning` without calling Traderton when none is ready. `list_strategy_presets` and `change_strategy_preset` also need the matching Traderton release; until it is deployed they return Traderton's "preset assessment not available in this context" error.
- A tool that Traderton tags to an approved skill but Herobids cannot call is now logged once per skill at `error` (`droppedToolNames`) instead of one `warn` per tool, and a test fails when a tool in the checked-in Traderton skill-map fixture has no local tool.
```

#### 8. Rollout (per `docs/tech/agents/agent-runtime-rollout-guide.md`)

The guide's principles apply by analogy: ship dependencies first, ship dark, prove one target,
keep a fast rollback. These tools are "dark by ordering": visibility is (Traderton tags) ∩ (local
registry) and Traderton already tags them, so Herobids becomes visible the moment an agent runs
the new code. Order:

1. **Traderton first.** Deploy T1 and T2 to staging. Confirm `tools/list` still tags the three
   tools and, with a read-only probe if available, that `list_strategy_presets` no longer returns
   "not available". This changes nothing for Herobids agents.
2. **Herobids second.** Merge, let CI publish the agent image, deploy worker and API, then
   release the agent image for the environment with `infra/hetzner/scripts/release-agent-image.sh
   --env staging` (probe first with `--dry-run`). The tool registry lives in the agent image and
   `createToolRegistry()` runs at agent module load, so the agent image must be released.
3. **Agent restart third.** Relaunch one canary agent per guide section 7 (DB state and Nomad job
   together; skip live-mode agents without owner approval). **Correction to the requested order:**
   "agent restart or skill reload" is not interchangeable. A skill reload only re-runs discovery
   against the registry already in the running image, so on an agent still running the old image
   it still drops the three tools. Restart (new image) is required. After that, reload only
   matters when Traderton changes its tags again.
4. **Verify the canary, then the rest** in small groups.

Rollback: re-pin the previous agent image (`release-agent-image.sh --env <env> --sha <previous>`)
and relaunch; the three tools disappear again. Traderton T1 and T2 are additive and can stay.
Nothing in this work touches production or remote targets; steps 1 to 4 are operator actions on
staging first.

### Corrections to the requirements phase

1. `list_strategy_presets` is not account-scoped in Herobids, and Traderton's own fix for it
   should not require an account at all (use `presetCatalog`). `bugfix.md` grouped it with
   `change_strategy_preset` as needing the account forwarded.
2. The bug report says the log shows "risk-limit writes route over REST" as if only those writes
   are wired. The write boundary is generic (the watch tools already use it) and neither the
   Herobids transport nor Traderton's REST app has a per-tool allow-list. The risk that
   `change_strategy_preset` is rejected by transport is therefore low; the real gate is Traderton
   context building (section 4).
3. `bugfix.md` 1.4 and the bug report say the drop is logged only at `warn`. True, but there
   were already three `warn` lines per start, so raising the level alone would not have been the
   whole gap; the missing piece is a test and a single `error` summary.
4. **`pnpm lint` does not check this code.** Root `tsconfig.json` has `"files": []` with project
   references, so `pnpm lint` (`tsc --noEmit`) exits in about 1.4 s having checked nothing. Real
   type checking is `pnpm build` (`tsc --build`, which also excludes `*.test.ts`). Test files are
   never type-checked by either command. The implementation must run `pnpm lint` as required and
   also `pnpm build`, and review test types by eye.
5. `providers.test.ts` requires three new rows in the capability manifest document; the
   requirements did not list it.

## Testing Strategy

### Validation Approach

Two phases: first write tests that fail on unfixed code and show the root cause, then confirm the
fix and that nothing else moved. No new dependencies: there is no `fast-check` in the repo, so
"property" tests are deterministic table-driven `it.each` sweeps over generated combinations.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples on UNFIXED code and confirm the root cause (no local entry),
not a gate further down.

**Test Plan**: Write the visibility test and the fixture test first and run them on the current
tree; run a read-only offline comparison of the three Traderton skill maps against
`KNOWN_AGENT_TOOL_NAMES`.

**Test Cases**:
1. **Fixture vs registry**: every `crypto-trading` fixture tool is in `createToolRegistry()`
   names (fails on unfixed code with exactly the three names).
2. **End-to-end visibility**: `buildBackendToolVisibility` over the fixture and real registry
   names reports `droppedTools` of exactly the three tools and `toolCount: 19` (fails on unfixed
   code; mirrors the staging log).
3. **Runtime gate**: with the three names in a skill's `requiredTools` but not in the registry,
   `executeTool` rejects with `unknown tool` (confirms the second gate is only the registry).
4. **Offline map comparison (done during this design)**: all 29 distinct names across the three
   Traderton skill maps are in `KNOWN_AGENT_TOOL_NAMES` except the three. Already confirmed.

**Expected Counterexamples**: the three names, `reason: not_in_local_registry`, 19 of 22 visible.
If a different set appears, re-hypothesize before coding.

### Fix Checking

**Goal**: For every input where C(X) holds, the fixed system makes the tool visible and forwards
correctly.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  registry := createToolRegistry_fixed()
  ASSERT X.toolName IN registry.names
  vis := buildBackendToolVisibility(X.backendTags, registry.names)
  ASSERT X.toolName IN vis.requiredTools AND vis.droppedTools = []
  result := registry.get(X.toolName).execute(validParams, ctxWithPorts)
  ASSERT portCallCount = 1
         AND payload = validParams + (venueAccountId IF accountScoped(X.toolName))
         AND result = mapped(portResult)
END FOR
```

### Preservation Checking

**Goal**: For inputs where C(X) is false, fixed and original behave the same.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT visibility_original(X) = visibility_fixed(X)
END FOR
```

**Testing Approach**: Sweep the existing `buildBackendToolVisibility` scenarios (approved,
unapproved, system skill, unreachable, no family) with a registry that includes and excludes the
new names, and assert results are identical except for the three names. The existing suites are
the baseline and must pass unmodified apart from the logger and `warn`-to-`error` edits listed in
section 5.

**Test Plan**: Run the existing suites on UNFIXED code first (`backend-tool-visibility`,
`risk-limits`, `account`, `account-funding`, `read-skill`, `tool-registry`,
`runtime-tool-visibility`, `assessment-review-message`, `agent-assessment-review`,
`agent-message-broker`, `agent-platform-assessment-reviews`, `providers`, `tools` in domain), then
re-run after.

**Test Cases**:
1. **Other 19 tools**: visible set minus the three is identical before and after.
2. **Wake text**: `buildAssessmentReviewMessage` output is byte-identical.
3. **Unreachable backend**: still `requiredTools: []`, family applied, no throw.
4. **Review route**: `agent-platform-assessment-reviews.test.ts` unchanged and green.

### Unit Tests

New `apps/worker/src/tools/strategy-presets.test.ts` (style of `risk-limits.test.ts` and
`account-funding.test.ts`):

- `list_strategy_presets`: sends `{}` and `{ styleTier }`; never calls the account resolver and
  never sends `venueAccountId`; `precondition.not_ready` without the read port; success data
  passed through; Traderton's "not available in this context" failure maps to
  `validation.invalid_payload`, `fault: false`.
- `assess_strategy_preset`: payload is `{ symbols, venueFamily, [instrumentKind], venueAccountId }`;
  `instrumentKind` omitted when unset; a model-supplied `venueAccountId` is stripped by
  `parametersSchema` and the resolver's value is used; `connection.missing` and
  `connection.provisioning` without calling Traderton; a throwing resolver becomes `missing`;
  no read port gives `precondition.not_ready`; `transport_error` gives `boundary.transport_error`
  (`fault: true`); `in_progress` gives `boundary.in_progress`; per-symbol failures inside a
  successful payload (for example `assessment.cooldown_blocked` with `nextEligibleAt`) are passed
  through untouched.
- `change_strategy_preset`: calls the write port (not the read port) with the exact payload and
  `deadlineMs: 30_000`; no `idempotencyKey` field supplied by the tool; wired through the real
  `createSubjectBoundWriteBoundary` over a fake boundary, two calls produce two different keys
  and the subject carries no venue account; same account gating as assess; failure mapping table
  (`validation.invalid_payload`, `precondition.not_ready`, `authorization.denied` are
  `fault: false`; `upstream.transient` is retryable and `fault: true`); `in_progress` becomes
  `precondition.not_ready`; no write port gives `precondition.not_ready`.
- Schemas: `mode` accepts only `entries_only`; `reason` and `assessmentArtifactId` reject empty
  strings; `symbols` rejects an empty array; every property of each tool's JSON schema has a
  non-empty `description`; `required` lists match the table in section 2.
- Registration: `createToolRegistry()` does not throw; the three names are in
  `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG` with categories equal to the tools' categories
  (extend `tool-registry.test.ts`); `agent-tools.test.ts` and `providers.test.ts` stay green.
- Visibility: updated `backend-tool-visibility.test.ts` (one `error`, fields, no per-tool `warn`)
  and the new `backend-skill-tools.test.ts` from section 6.

### Property-Based Tests

Table-driven sweeps, no new library:

- For all combinations of `{ boundary present, absent } × { account ready, missing, provisioning,
  resolver throws } × { tool }`, the outcome is exactly one of: forwarded once with the correct
  payload, `precondition.not_ready`, `connection.missing`, `connection.provisioning`; the
  boundary is called at most once and never when a precondition fails.
- For all Traderton result kinds (`success`, `failure` with each failure code and both retryable
  values, `in_progress`, `transport_error`) × (read mapper, write mapper), the proxy result
  equals the shared mapper's output for the same input (no proxy-local mapping).
- For all drop sets over the fixture (each subset of tool names removed from the registry),
  `droppedTools` equals the removed set, `visible ∪ dropped` equals `tagged`, and `error` is
  logged once if and only if the set is non-empty.
- For random `validation.data` objects, the payload sent never contains a key outside the table in
  section 2 (guards against the model smuggling `venueAccountId` or other fields).

### Integration Tests

- `createToolRegistry()` plus `buildBackendToolVisibility` plus `runtime-tool-visibility`
  controller: with the fixture-derived discovery, `allowedTools()` contains the three names and a
  tick-time `applyToolVisibility` does not drop them.
- A proxy run against the existing `fake-idempotent-boundary.ts` (REST face) for the write path:
  a repeated unknown-outcome reconcile inside one call re-issues the same key, a second tool
  call uses a new one.
- Existing `agent-platform-assessment-reviews.test.ts` unchanged (the API path keeps calling
  Traderton directly).
- Manual staging check (operator, read-only, after the rollout order above; not run by the
  implementer): restart one agent, read its runtime log with the `access-remote-targets` skill
  (`nomad alloc logs -namespace=herobids-agents <alloc> agent`), search `Backend tool visibility`.
  Expect `toolCount: 22, taggedToolCount: 22, droppedTools: []` for `traderton/skills/crypto-trading`,
  no `Backend tool visibility` line at `error` level, and no
  `Approved external skill tools are not all visible after discovery` warning for that skill.
  Then call `list_strategy_presets` once through the agent (read-only) and confirm it returns
  presets (this needs T1 deployed). Do not run `change_strategy_preset` on a live-mode agent.
- Verification commands for the implementer: focused `vitest run` on the files above,
  `pnpm lint` (must pass), `pnpm build` (the real type check), then `pnpm test`.

## Risks

- **Rollout skew.** Herobids shipped before Traderton T1/T2 exposes two tools that return a
  deterministic error, and the review wake sends the agent to them. Mitigation: deploy order,
  and the proxies fail without a breaker trip or fallback. An agent retrying each tick is wasteful
  but harmless.
- **Read timeout for `assess_strategy_preset`.** The read port has one deadline for all reads
  (`requestTimeoutMs`, 10 s by default, `TRADERTON_BOUNDARY_TIMEOUT_MS`). Traderton assesses up
  to its cap of symbols sequentially with candle fetches and may exceed it on a cold cache. The
  call then returns `boundary.transport_error` (retryable), and Traderton caches a completed
  assessment, so a retry is cheap. The API review route has the same limit. A per-tool read
  deadline is out of scope; raise the operator timeout if staging shows timeouts.
- **Scout can call `assess_strategy_preset`.** Category `read-market-data` makes it scout-visible
  (as it was before `88e67c98`). Traderton persists the artifact and starts a cooldown per
  identity, so a scout call that the judge does not follow up can use up a recompute window.
  Matches pre-deletion behaviour and Traderton's design; flagged, not changed.
- **Lossy error codes.** Traderton's tool-level codes arrive in `details.errorCode` and are not
  forwarded; the agent sees `validation.invalid_payload` plus the message. Accepted to keep the
  shared mappers unchanged (2.10, 3.6).
- **Duplicate change on an unknown outcome.** If a change write ends `in_progress` at the 30 s
  deadline the tool reports `precondition.not_ready` (retryable); a model retry is a new logical
  write with a new key. The change targets the same preset, so a duplicate is idempotent in
  effect and not an external venue action (INV-S1), but it may add a second audit row. Same
  property as `adjust_risk_limits`.
- **Fixture drift.** The fixture is a human-maintained copy of tool names. It is a
  consumer-side expectation, not a mirror of Traderton logic, but it can go stale; the runtime
  `error` log is the backstop and `@poshjosh/contracts` publication is the real fix. Do not add
  schemas or definitions to it.
- **Name collisions between concurrent plans.** `000-multi-timeframe-market-structure` will also
  edit `KNOWN_AGENT_TOOL_NAMES`, `TOOL_CATALOG`, the manifest table and the fixture. Textual
  merge conflicts only; the same registration surface list applies.
- **Pending capability-gating plan.** `001-capability-gating-enforcement/001-plan.md` still lists
  `assess_strategy_preset` and `change_strategy_preset` as broker-mediated. If that plan lands it
  must treat these proxies as ordinary boundary proxies; a new `checkAccess` without a grant would
  recreate the `make_http_request` failure. Update that plan's table when this fix lands.
- **Account selection divergence.** The agent and the review route can choose different accounts
  only in the edge case described in section 2; it is pre-existing and shared with every
  account-scoped tool.
- **Tooling gap.** `pnpm lint` checks nothing at the repo root and tests are never type-checked.
  A wrong type in the new test file would pass lint and build. Mitigation: run `pnpm build` and
  rely on vitest runtime assertions.

## Out of scope

Editing the Traderton repo, publishing the skill map in `@poshjosh/contracts`, a per-tool read
deadline, forwarding `details.errorCode`, removing dead `buildPresetReviewMessage`, fixing the
legacy `skills/trading` doc entry, any production or remote-target action, and any new `.env`
variable or config key (none is needed, so no `.example` twin changes).
