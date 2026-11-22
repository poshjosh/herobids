# Implementation Plan

Scope: Herobids repo only. No task edits the Traderton repo or `traderton-skills`. No new dependencies, no new `.env` variable, no new config key, no production or remote-target action. Property tests are deterministic table-driven `it.each` sweeps (the repo has no `fast-check`).

Tooling note: `pnpm lint` checks nothing at the repo root (`tsconfig.json` has `"files": []`) and test files are never type-checked by `pnpm lint` or `pnpm build`. Real type checking is `pnpm build`. Review test types by eye and rely on vitest runtime assertions.

- [x] 1. Write bug condition exploration tests (BEFORE the fix)
  - **Property 1: Bug Condition** - Tagged `crypto-trading` tools missing from the local registry
  - **CRITICAL**: These tests MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the tests or the code when they fail**
  - **NOTE**: The assertions encode the expected behavior and will validate the fix when they pass after implementation
  - **GOAL**: Surface counterexamples that show the root cause is "no local registry entry", not a gate further down
  - **Scoped PBT Approach**: The bug is deterministic, so scope the property to the three concrete failing inputs (`list_strategy_presets`, `assess_strategy_preset`, `change_strategy_preset`, all with `skillRef = traderton/skills/crypto-trading`)
  - Bug condition from design: `isBugCondition(X)` = `X.skillRef IN approvedRefs AND X.toolName IN backendTags[X.skillRef] AND X.toolName NOT IN registryNames`
  - Create the fixture first, because the tests read it: `apps/worker/src/external-backend/__fixtures__/traderton-skill-tools.json`
    - Names only. No schemas, no preset definitions, no logic (AGENTS.md "do not reintroduce mirrored trading files", INV-L2)
    - Shape: `{ "source": { "repo": "traderton", "file": "packages/boundary/src/mcp/skill-tool-map.ts", "commit": "0ea5654", "note": "one commit after tag v0.2.2; update when re-copied" }, "skills": { "traderton/skills/crypto-trading": [22 names], "traderton/skills/crypto-bot-management": [9 names], "traderton/skills/crypto-risk-monitoring": [11 names] }, "notExposed": {} }`
    - Copy the names by reading Traderton's `packages/boundary/src/mcp/skill-tool-map.ts` read-only (do not edit that repo). If it is not readable, derive the 29 distinct names from `KNOWN_AGENT_TOOL_NAMES` plus the three missing names and flag the gap in the task notes
    - `notExposed` maps `skillRef -> { toolName: "reason" }`; it starts empty
  - Write `apps/worker/src/external-backend/backend-skill-tools.test.ts` (final form; the same file is reused in task 5.8). Read the fixture with `readFileSync`, like the existing signing-vector fixture. Put these cases in it now:
    - Case A, fixture vs registry: every `crypto-trading` fixture tool (minus `notExposed`) is in `createToolRegistry().list()` names. Failure message names the skill and tool. Expected on unfixed code: fails with exactly the three names
    - Case B, end-to-end visibility: feed `buildBackendToolVisibility` a discovery result built from the fixture and the real registry names. Assert `requiredTools` is the full 22-name list, `droppedTools` is `[]`, `taggedToolCount` is 22 and `toolCount` is 22. Expected on unfixed code: fails with `droppedTools` of exactly the three tools, reason `not_in_local_registry`, and `toolCount: 19` (mirrors the staging log for `bright-parrot`)
  - Add the runtime-gate case, Case C, where the existing `executeTool` tests live (find them by searching for `unknown tool`; add a new `describe` or test file next to them): with the three names in a skill's `requiredTools` but not in the registry, `executeTool` rejects each with `unknown tool`. This confirms the second gate is only the registry
    - On unfixed code Case C passes for the three names. That is expected and is the root cause confirmation; the post-fix assertion in task 5.8 flips it to "the registry has the tool"
    - Write the test so it reads the registry live and asserts the registry contains the tool, so it fails on unfixed code and passes after the fix
  - Run the new tests on UNFIXED code. **EXPECTED OUTCOME**: Cases A, B and C FAIL
  - Document the counterexamples in the task notes: the three names, `not_in_local_registry`, 19 of 22 visible. If a different set appears, stop and re-hypothesize before coding
  - Mark the task complete when the tests are written, run, and the failures are documented
  - **Task notes (executed, unfixed code)**: fixture `apps/worker/src/external-backend/__fixtures__/traderton-skill-tools.json` copied read-only from Traderton `0ea5654` (22/9/11 names, `notExposed: {}`). Tests in `apps/worker/src/external-backend/backend-skill-tools.test.ts`. Run with `vitest run`: Cases A, B, C FAIL as expected (7 failing assertions: A 1, B 3, C 3).
    - Counterexamples: Case A missing = `list_strategy_presets`, `assess_strategy_preset`, `change_strategy_preset`. Case B `droppedTools` = those three with `reason: not_in_local_registry`; info log `toolCount: 19, taggedToolCount: 22, discoveredToolCount: 29` (matches staging `bright-parrot`). Case C: `createToolRegistry().get(name)` is `undefined` for all three.
    - Case C note: `executeTool` in `apps/worker/src/agent.ts` is a closure inside the agent module and cannot be imported in a unit test (no existing `executeTool` tests exist). The test asserts the registry lookup, which is the `unknown tool` gate that follows the `allowedTools()` check.
  - _Requirements: 1.1, 1.2, 1.3, 2.1_

- [x] 2. Write preservation baseline tests and record the baseline (BEFORE the fix)
  - **Property 2: Preservation** - Behavior outside the bug condition is unchanged
  - **IMPORTANT**: Follow the observation-first methodology. Observe the UNFIXED code, then write tests that assert what was observed
  - Non-bug-condition inputs: any tool, skill or backend state where `isBugCondition` is false (the other 19 `crypto-trading` tools, the other two Traderton skills, unapproved and system skills, unreachable backend, tools Traderton does not tag)
  - [x] 2.1 Run the existing suites on UNFIXED code and record the baseline
    - Focused `vitest run` for: `backend-tool-visibility`, `risk-limits`, `account`, `account-funding`, `read-skill`, `tool-registry`, `runtime-tool-visibility`, `assessment-review-message`, `agent-assessment-review`, `agent-message-broker`, `agent-platform-assessment-reviews`, `providers` (apps/api) and `tools` (packages/domain)
    - Record pass/fail counts per suite. All must pass before continuing. Any pre-existing failure is documented and not "fixed" here
    - **EXPECTED OUTCOME**: All pass on unfixed code
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [x] 2.2 Write the visibility preservation sweep
    - Sweep the existing `buildBackendToolVisibility` scenarios (approved, unapproved, system skill, unreachable backend, no family) over a registry that includes and excludes the three new names. Add to `backend-skill-tools.test.ts` or a new `describe` in `backend-tool-visibility.test.ts`
    - Observe on unfixed code, then assert: the visible set minus the three names is identical before and after the fix; unapproved and `system/*` skills are returned unchanged with no backend tools added; an unreachable backend still gives `requiredTools: []`, applies the family and never throws; a tool Traderton does not tag (`list_agent_strategy_changes`, `get_assessment_artifact`, `get_strategy_presets`) stays hidden
    - Encode the assertions so they hold for both the unfixed and the fixed registry (parametrise over the registry names, not the real registry)
    - Run on UNFIXED code. **EXPECTED OUTCOME**: PASS
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x] 2.3 Write the wake text preservation test
    - Snapshot-style assertion: `buildAssessmentReviewMessage` output for representative inputs is byte-identical to the output observed on unfixed code. Store the observed strings in the test as literals
    - Do not duplicate the fragment assertions already in `assessment-review-message.test.ts` and `agent-assessment-review.test.ts`; those stay as they are
    - Run on UNFIXED code. **EXPECTED OUTCOME**: PASS
    - _Requirements: 3.7_
  - [x] 2.4 Confirm the offline map comparison from the design
    - Read-only check: all 29 distinct names across the three skill maps are in `KNOWN_AGENT_TOOL_NAMES` except the three. Record the result in the task notes. This is the check behind the fixture contents
    - _Requirements: 1.1, 3.1_

- [x] 3. Fix for strategy preset tools dropped as `not_in_local_registry`

  - [x] 3.1 Register the three tool names and catalog entries
    - Edit `packages/domain/src/tools.ts`
    - `KNOWN_AGENT_TOOL_NAMES`, keeping alphabetical order: add `assess_strategy_preset` (after `append_file`), `change_strategy_preset` (after `browse_url`), `list_strategy_presets` (after `list_skills`)
    - `TOOL_CATALOG`: add three entries. Categories must equal the tools' own categories (`assertToolCatalogMatchesRegistry` compares them)
      - `list_strategy_presets`: `read-config`. "List the strategy presets you can choose from (key, name, description, strategy type, signal bias, behavior version)."
      - `assess_strategy_preset`: `read-market-data`. "Get computed, data-only evidence and per-preset scorecards and flags for one or more symbols, to decide whether to switch preset. Free."
      - `change_strategy_preset`: `write-database`. "Switch your active strategy preset using a fresh assessment artifact and a reason shown on the review screen."
    - Do not touch `DEFAULT_CAPABILITY_GRANTS`, `MARKET_DATA_TOOLS`, `DATABASE_DEPENDENT_TOOLS`, `permanentlyExcludedTools`, `agent-message-broker.ts`, `packages/domain/src/tool-schemas.ts`, built-in skill `requiredTools` or `tool-signature.ts` (design section 1: no change)
    - _Bug_Condition: isBugCondition(input) where skillRef is an approved skill, toolName is tagged by the backend and toolName NOT IN registryNames_
    - _Preservation: no existing name, category or order-sensitive test changes_
    - _Requirements: 2.6_

  - [x] 3.2 Add the three proxy tools in `apps/worker/src/tools/strategy-presets.ts`
    - New file exporting `strategyPresetTools`, modelled on `apps/worker/src/tools/risk-limits.ts`. Import `resolveSelectedVenueAccountId` and `selectedAccountUnavailable` from `./risk-limits.js` (as `account.ts` already does) and `mapReadResultToToolResult` / `mapWriteResultToToolResult` from where the existing proxies import them. Do not modify the shared mappers, read or write adapters, or transport
    - Constants: `CHANGE_STRATEGY_PRESET_DEADLINE_MS = 30_000` (same value as `adjust_risk_limits` and the watch writes; no new operator config) and a shared `BOUNDARY_NOT_READY` result: `{ success: false, error: 'trading boundary not configured', errorCode: 'precondition.not_ready', fault: false }`
    - `list_strategy_presets` (category `read-config`, read port)
      - Params (Zod): `styleTier?: 'economy' | 'standard' | 'premium'`
      - No `ctx.externalBackend` returns `BOUNDARY_NOT_READY`. Never resolves a venue account and never sends `venueAccountId`
      - Calls `ctx.externalBackend.invoke({ toolName: 'list_strategy_presets', payload: styleTier ? { styleTier } : {} })` and returns `mapReadResultToToolResult(...)`
    - `assess_strategy_preset` (category `read-market-data`, read port)
      - Params: `symbols: string[]` (min 1, max 50), `venueFamily: string`, `instrumentKind?: 'orderbook' | 'perp' | 'swap' | 'dex'`
      - No `ctx.externalBackend` returns `BOUNDARY_NOT_READY`. Then `resolveSelectedVenueAccountId(ctx)`; any status other than `ready` returns `selectedAccountUnavailable(resolution)` without calling Traderton
      - Payload: `{ symbols, venueFamily, ...(instrumentKind ? { instrumentKind } : {}), venueAccountId: resolution.venueAccountId }`. Do not invent a default for `instrumentKind`
    - `change_strategy_preset` (category `write-database`, write port)
      - Params: `assessmentArtifactId: string` (min 1), `targetPreset: string` (min 1), `mode: 'entries_only'` (required, no default), `reason: string` (min 1, required)
      - No `ctx.externalBackendWrite` returns `BOUNDARY_NOT_READY`. Same account gating as assess
      - Calls `ctx.externalBackendWrite.invokeAndAwait({ toolName: 'change_strategy_preset', payload: { assessmentArtifactId, targetPreset, mode, reason, venueAccountId }, deadlineMs: CHANGE_STRATEGY_PRESET_DEADLINE_MS })` and returns `mapWriteResultToToolResult(result)`
      - The tool must never pass, mint or cache an idempotency key. `createSubjectBoundWriteBoundary` mints `randomUUID()` per `invokeAndAwait`
    - Every LLM schema property carries a non-empty `description`. No `venueAccountId` in any LLM schema. Use the tool and parameter descriptions from the design (section 3, "LLM-facing descriptions") verbatim in intent, including: "Only entries_only is supported." for `mode`, and the reason being shown to the creator on the review screen
    - No `promptGuidance`
    - No trading logic: the proxy only validates wire shape, adds the venue account and maps the result. Creator policy, artifact freshness and cooldowns stay in Traderton. No `@traderton/*` import
    - Use the repo's type-safety rules: no `any`, no `@ts-ignore`, no `as unknown as X`. Narrow params with `z.infer<typeof Schema>` as `risk-limits.ts` does
    - _Bug_Condition: isBugCondition(input) for the three tool names_
    - _Expected_Behavior: expectedBehavior(result) - exactly one Traderton call with the validated params plus the platform-resolved venue account where account-scoped; Traderton's data or mapped failure returned unchanged; `precondition.not_ready`, `connection.missing` and `connection.provisioning` without calling Traderton_
    - _Preservation: shared mappers, ports, transport and the API review route are untouched_
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.10, 3.5, 3.6, 3.8_

  - [x] 3.3 Register the proxies in the tool registry barrel
    - Edit `apps/worker/src/tools/index.ts`: import `strategyPresetTools` and spread it into `allTools`
    - Confirm `createToolRegistry()` does not throw (worker startup assertion: known names equal registry names, categories equal catalog categories)
    - _Requirements: 2.1, 2.6_

  - [x] 3.4 Add the three rows to the capability manifest document
    - Edit the "Exhaustive Tool Ownership" table in `docs/features/pending/000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md`: add `assess_strategy_preset`, `change_strategy_preset`, `list_strategy_presets`, owner `external:trading`, following the format of the neighbouring `external:trading` rows (e.g. `get_risk_limits`, `adjust_risk_limits`)
    - `apps/api/src/routes/providers.test.ts` asserts the table equals `KNOWN_AGENT_TOOL_NAMES`, so this row set must match task 3.1 exactly
    - _Requirements: 2.6_

  - [x] 3.5 Change the dropped-tool report to one `error` per skill
    - Edit `apps/worker/src/external-backend/backend-tool-visibility.ts`
    - Add `error(fields, message)` to the `BackendToolVisibilityLogger` interface. The only production caller passes the pino logger, which already has it
    - Replace the per-tool `warn` loop with one `error` per skill when `droppedTools.length > 0`, with fields `{ skillId, sourceRef, droppedToolNames, droppedTools, visibleToolCount, taggedToolCount }` and message `Backend tool visibility: backend tags tools for this skill that this runtime cannot call`
    - Keep the `info` summary line unchanged (the staging check reads it). Keep `recordBackendToolReport`'s `warn` in `agent.ts` unchanged (it also covers transient `backend_unreachable`)
    - The function must still never throw and still hide the dropped tools
    - Do not add a runtime allow-list for intentional drops (YAGNI; the test-level `notExposed` is enough)
    - _Bug_Condition: isBugCondition(input) - a tagged tool dropped as not_in_local_registry_
    - _Expected_Behavior: exactly one `error` log naming skillId, sourceRef and every dropped tool; no throw; dropped tools stay hidden_
    - _Preservation: info summary, unreachable-backend degradation and unapproved/system skill handling unchanged_
    - _Requirements: 2.7, 3.2, 3.3_

  - [x] 3.6 Update the existing visibility tests for the logger change
    - Edit `apps/worker/src/external-backend/backend-tool-visibility.test.ts`
    - Add `error: vi.fn()` to every logger literal in the file (`const logger`, `{ info, warn }`, `{ info, warn: vi.fn() }` and any other shape), so a drop in any test cannot hit a missing method. Tests are not type-checked, so search the file for every logger construction by eye
    - Rewrite "records each tagged tool that was not made visible, with the reason, and logs it": assert exactly one `error` call with `droppedToolNames: ['ghost_tool']`, `skillId`, `sourceRef`, `visibleToolCount` and `taggedToolCount`, and that `warn` was not called for the drop
    - Leave `read-skill.test.ts` and the `summarizeBackendToolVisibility` tests unchanged (they use `ghost_tool` only as data); confirm by running them
    - _Requirements: 2.7_

  - [x] 3.7 Fix stale comments and docs
    - `apps/worker/src/agent.ts` ~3401-3404: replace the `NOTE: Transition tools ... are now implemented and registered` block with the accurate path: the review tools (`list_strategy_presets`, `assess_strategy_preset`, `change_strategy_preset`) are local proxies in `tools/strategy-presets.ts` that forward to Traderton, which owns assessment, policy, cooldowns and the change; they are visible only when Traderton tags them to the agent's approved skill
    - `apps/worker/src/agent.ts` ~3414: reword "can use assessment tools to request a full platform assessment, evaluate, and apply preset changes" to "call `assess_strategy_preset` (data-only, free), read the flags, and call `change_strategy_preset` if the data clearly shows a better fit"
    - `apps/worker/src/agent.ts` ~3420: change "review rankings" to "read flags" in the `assess_strategy_preset → ... → change_strategy_preset` line
    - `apps/worker/src/agent.ts` ~1900-1902 (`appendJournal` no-op comment): drop the "consumed by change_strategy_preset" reference. Comment only, no behavior change
    - `apps/worker/src/hybrid-agent-evaluator.ts` ~50: change "review rankings" to "read flags". Comment only
    - `apps/worker/src/assessment-review-message.ts` JSDoc ~10-13: change "(now a Traderton data-only tool)" to "(a local proxy that forwards to Traderton's data-only tool)". **Do not change the message text** (`assessment-review-message.test.ts` and `agent-assessment-review.test.ts` assert exact fragments)
    - `apps/worker/src/external-backend/agent-ports.ts` ~95 log text: "read tools + risk-limit writes route over REST" becomes "read tools + side-effecting writes route over REST" (optional hygiene; no test asserts the string, so grep first to confirm)
    - Line numbers are approximate; locate each by searching for the quoted text
    - Do not change: `buildPresetReviewMessage` in `agent.ts`, the legacy `Trading skill (id: trading)` doc wording, the skill text in `traderton-skills`, `docs/product/PROBLEMS-WITH-TRADING-EXTRACTION.md`
    - _Requirements: 2.8, 3.7, 3.9_

  - [x] 3.8 Update the docs index source and regenerate the platform docs
    - Edit `scripts/ts/build-docs-index.ts` (the `skills/trading` entry, ~lines 550 and 559): add `list_strategy_presets` to "Required tools" and to the "Decide" line, next to `assess_strategy_preset, change_strategy_preset`
    - Regenerate `apps/worker/src/tools/platform-docs-data.ts` with `pnpm --filter @herobids/scripts run build-docs-index` (`pnpm build` also runs it first). The file is generated ("DO NOT EDIT MANUALLY"); never hand-edit it
    - Review `git diff` for `platform-docs-data.ts`: it must show only the two lines (~1716 and ~1725). If unrelated content drift appears, stop, revert the generated file, and report it instead of including it
    - _Requirements: 1.3, 2.8_

  - [x] 3.9 Add the CHANGELOG entry
    - Edit `CHANGELOG.md` under `[Unreleased]` → `### Fixed` with the two bullets from the design (section 7, "CHANGELOG entry"): the three proxies and the Traderton dependency note, and the `error` log plus fixture test
    - Match the existing CHANGELOG style (sentence case, backticks for identifiers). Do not claim end-to-end behavior for `list_strategy_presets` and `change_strategy_preset` without the Traderton release
    - _Requirements: 2.1, 2.7_

  - [x] 3.10 Write the proxy unit tests
    - Create `apps/worker/src/tools/strategy-presets.test.ts`, in the style of `risk-limits.test.ts` and `account-funding.test.ts`
    - `list_strategy_presets`
      - sends `{}` and `{ styleTier }`
      - never calls the account resolver and never sends `venueAccountId`
      - `precondition.not_ready` without the read port
      - success data passed through
      - Traderton's "preset assessment not available in this context" failure maps to `validation.invalid_payload`, `fault: false`
    - `assess_strategy_preset`
      - payload is `{ symbols, venueFamily, [instrumentKind], venueAccountId }`; `instrumentKind` omitted when unset
      - a model-supplied `venueAccountId` is stripped by `parametersSchema` and the resolver's value is used
      - `connection.missing` and `connection.provisioning` without calling Traderton; a throwing resolver becomes `missing`
      - no read port gives `precondition.not_ready`
      - `transport_error` gives `boundary.transport_error` (`fault: true`); `in_progress` gives `boundary.in_progress`
      - per-symbol failures inside a successful payload (for example `assessment.cooldown_blocked` with `nextEligibleAt`) pass through untouched
    - `change_strategy_preset`
      - calls the write port (not the read port) with the exact payload and `deadlineMs: 30_000`; the tool supplies no `idempotencyKey`
      - wired through the real `createSubjectBoundWriteBoundary` over a fake boundary, two calls produce two different keys and the subject carries no venue account
      - same account gating as assess
      - failure mapping: `validation.invalid_payload`, `precondition.not_ready`, `authorization.denied` are `fault: false`; `upstream.transient` is retryable and `fault: true`
      - `in_progress` becomes `precondition.not_ready`; no write port gives `precondition.not_ready`
    - Schemas
      - `mode` accepts only `entries_only`
      - `reason` and `assessmentArtifactId` reject empty strings
      - `symbols` rejects an empty array
      - every property of each tool's JSON schema has a non-empty `description`
      - `required` lists match the design table (list: none; assess: `symbols`, `venueFamily`; change: `assessmentArtifactId`, `targetPreset`, `mode`, `reason`)
    - Registration: extend `tool-registry.test.ts` so the three names are in `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG` with categories equal to the tools' categories, and `createToolRegistry()` does not throw
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.10_

  - [x] 3.11 Write the property sweeps for the proxies and visibility
    - **Property 1: Expected Behavior** and **Property 2: Preservation** sweeps, table-driven with `it.each`. Put them in `strategy-presets.test.ts` and `backend-skill-tools.test.ts`
    - Port and account matrix: for all combinations of `{ boundary present, absent } × { account ready, missing, provisioning, resolver throws } × { tool }`, the outcome is exactly one of: forwarded once with the correct payload, `precondition.not_ready`, `connection.missing`, `connection.provisioning`. The boundary is called at most once, and never when a precondition fails. `list_strategy_presets` ignores the account dimension
    - Mapper identity: for all Traderton result kinds (`success`, `failure` with each failure code and both retryable values, `in_progress`, `transport_error`) × (read mapper, write mapper), the proxy result equals the shared mapper's output for the same input (no proxy-local mapping)
    - Drop sets: for each subset of fixture tool names removed from the registry names (use the `crypto-trading` list, 22 names, so cap the sweep to single removals, pairs of the three preset tools and the empty set to keep it fast), `droppedTools` equals the removed set, `visible ∪ dropped` equals `tagged`, and `error` is logged once if and only if the set is non-empty
    - Payload keys: for random `validation.data` objects (a fixed list of crafted objects, including ones carrying `venueAccountId`, `idempotencyKey`, `__proto__`-style and unknown keys), the payload sent never contains a key outside the design's payload table
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.7, 2.10, 3.1_

  - [x] 3.12 Write the integration tests
    - `createToolRegistry()` + `buildBackendToolVisibility` + the `runtime-tool-visibility` controller: with the fixture-derived discovery, `allowedTools()` contains the three names and a tick-time `applyToolVisibility` does not drop them (guards "visible but denied")
    - Write-path integration against the existing `fake-idempotent-boundary.ts` (REST face): a repeated unknown-outcome reconcile inside one `change_strategy_preset` call re-issues the same key; a second tool call uses a new key. Locate the fake with a file search; if it lives in a different package, import it the way existing tests do and do not duplicate it
    - Confirm `agent-platform-assessment-reviews.test.ts` is unchanged and green (the API path keeps calling Traderton directly)
    - _Requirements: 2.1, 2.3, 2.6, 3.5_

  - [x] 3.13 Finalise the regression guard tests in `backend-skill-tools.test.ts`
    - Complete the file started in task 1 so it contains the four cases from the design (section 6):
      1. Every fixture tool, minus `notExposed`, is in `createToolRegistry().list()` names. Failure message names the skill and tool
      2. Every `notExposed` entry is a tagged tool, is absent from the registry, and has a non-empty reason (a stale allow-list entry fails)
      3. `buildBackendToolVisibility` over the fixture and the real registry names gives the full `requiredTools`, `droppedTools: []`, `taggedToolCount` equal to the fixture length (22 for `crypto-trading`), and no `error` log
      4. Negative control: the same run with `change_strategy_preset` removed from the registry names reports exactly that tool dropped and one `error` log. This proves the guard can fail
    - Keep the fixture names-only. Do not add schemas, definitions or logic to it
    - _Requirements: 2.1, 2.7, 2.9_

  - [x] 3.14 Verify the bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Tagged tools are visible and forward to Traderton
    - **IMPORTANT**: Re-run the SAME tests from task 1 (fixture vs registry, end-to-end visibility, runtime gate). Do NOT write new tests
    - **EXPECTED OUTCOME**: Cases A, B and C PASS (22 of 22 visible, `droppedTools: []`, the three tools in the registry)
    - _Requirements: 2.1, 2.2, 2.3, 2.6_

  - [x] 3.15 Verify the preservation tests still pass
    - **Property 2: Preservation** - Behavior outside the bug condition is unchanged
    - **IMPORTANT**: Re-run the SAME tests and suites from task 2 (2.1, 2.2, 2.3). Do NOT write new ones, except the logger and `warn`-to-`error` edits already made in task 3.6
    - **EXPECTED OUTCOME**: All pass, with results equal to the baseline recorded in 2.1
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 4. Run the verification commands
  - [x] 4.1 Focused vitest runs
    - Run `vitest run` (single execution, no watch) on each suite below, in the package that owns it, and confirm every one is green
      - `apps/worker`: `strategy-presets.test.ts`, `backend-skill-tools.test.ts`, `backend-tool-visibility.test.ts`, `tool-registry.test.ts`, `risk-limits.test.ts`, `account.test.ts`, `account-funding.test.ts`, `read-skill.test.ts`, `runtime-tool-visibility` tests, `assessment-review-message.test.ts`, `agent-assessment-review.test.ts`, `agent-message-broker.test.ts`, `platform-docs.test.ts`
      - `apps/api`: `providers.test.ts`, `agent-platform-assessment-reviews.test.ts`
      - `packages/domain`: the `tools` test
    - If a suite name does not resolve, locate it with a file search and run it by path
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 2.7, 2.9, 3.1, 3.6, 3.7_
  - [x] 4.2 `pnpm lint`
    - Must pass (AGENTS.md). Record that it checks nothing at the repo root, so a pass is necessary but not sufficient
    - _Requirements: 2.6_
  - [x] 4.3 `pnpm build`
    - This is the real type check (`tsc --build`, which also runs the docs index generation first). It must pass. It excludes `*.test.ts`, so re-read the new and edited test files for type correctness by eye
    - After the build, confirm `git status` shows `platform-docs-data.ts` changed only as expected (see task 3.8) and no stray generated files
    - _Requirements: 2.6, 2.8_
  - [x] 4.4 `pnpm test`
    - Run the full Vitest suite. All must pass. Compare any failure against the baseline from task 2.1 before treating it as a regression
    - Do not run `pnpm test:integration` or e2e scripts that need external services unless the services are already documented as available locally; never target staging or production
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_
  - [x] 4.5 Confirm scope and cleanliness
    - `git diff --stat` shows no change under any Traderton repo path or `traderton-skills`, no `package.json` or lockfile change, no `.env*` or `config/*.yaml` change, and no `@traderton/*` import
    - Remove any temporary files created during verification
    - _Requirements: 3.8_

- [x] 5. Record the outcome in docs (only after tasks 3 and 4 pass)
  - [x] 5.1 Update the bug report
    - Edit `docs/bug-reports/2026/11/21/001-preset-tools-dropped-no-local-registry-entry.md`: set Status to fixed (note that `list_strategy_presets` and `change_strategy_preset` end-to-end behavior is gated on the Traderton T1/T2 release) and fill in "Files Changed" with the final list from `git diff --stat`
    - Do this only after the code and tests are green. Do not mark it fixed earlier
    - _Requirements: 2.1, 2.7_
  - [x] 5.2 Update the pending capability-gating plan table
    - Edit `docs/features/pending/001-capability-gating-enforcement/001-plan.md`: the table still lists `assess_strategy_preset` and `change_strategy_preset` as broker-mediated. Update those rows (and add `list_strategy_presets`) to say they are ordinary external-backend proxies in `tools/strategy-presets.ts` and never call `checkAccess`. Add a one-line warning that a new literal `checkAccess('<name>')` without a grant recreates the `make_http_request` failure
    - _Requirements: 2.6_
  - [x] 5.3 Note the multi-timeframe plan dependency
    - Edit `docs/features/pending/000-multi-timeframe-market-structure/001-plan.md`: add a short note that adding `get_market_structure` (or any new Traderton skill-map tool) must also update `__fixtures__/traderton-skill-tools.json` and the registration surface list in this fix's design (names list, catalog, barrel, manifest rows)
    - _Requirements: 1.6, 2.9_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

---

## Manual checklist: staging verification (operator step; the implementer MUST NOT run this)

This is not an executable task. It touches staging and remote targets. Do it only after Traderton T1/T2 are deployed to staging (see the next section) and the Herobids change is merged, built and released.

- [ ] Deploy order: Traderton T1/T2 first, then Herobids worker and API, then release the agent image with `infra/hetzner/scripts/release-agent-image.sh --env staging` (probe first with `--dry-run`). The tool registry lives in the agent image, so the image must be released
- [ ] Restart one canary agent on the new image (DB state and Nomad job together, per `docs/tech/agents/agent-runtime-rollout-guide.md` section 7). A skill reload alone is not enough on an agent still running the old image. Skip live-mode agents without owner approval
- [ ] Read the canary's runtime log (`access-remote-targets` skill: `nomad alloc logs -namespace=herobids-agents <alloc> agent`) and search `Backend tool visibility`. For `traderton/skills/crypto-trading` expect `toolCount: 22, taggedToolCount: 22, droppedTools: []`
- [ ] Confirm there is no `Backend tool visibility` line at `error` level and no `Approved external skill tools are not all visible after discovery` warning for that skill
- [ ] Call `list_strategy_presets` once through the agent (read-only) and confirm it returns presets. This needs T1 deployed
- [ ] Do not call `change_strategy_preset` on a live-mode agent. If exercising it on a paper-mode canary, confirm the result is Traderton's change or a typed refusal with a readable reason
- [ ] Roll the remaining agents in small groups. Rollback: re-pin the previous agent image (`release-agent-image.sh --env <env> --sha <previous>`) and relaunch; Traderton T1/T2 are additive and can stay
- [ ] If staging shows `boundary.transport_error` on `assess_strategy_preset` (cold cache, 10 s read deadline), the operator may raise `TRADERTON_BOUNDARY_TIMEOUT_MS`. That is an operator decision, not part of this spec

---

## Dependencies outside this repo (not executed by this spec)

T1 and T2 are for the Traderton owner. They are plain sections, not checkbox tasks, so no agent working this spec picks them up. No task above edits the Traderton repo or `traderton-skills`. Verified by reading Traderton `main` at `0ea5654` (one commit after tag v0.2.2); no live call was made. Both are additive and backward compatible: an older Herobids build that never sends the key behaves as before. Deploy Traderton first so Herobids never exposes a tool that cannot work.

Mechanism (`packages/boundary/src/dispatcher.ts`, `bin.ts`, `subject-resolver.ts`): `dispatch` parses the payload with the tool's plain `z.object` schema, so undeclared keys such as `venueAccountId` are stripped. All three tools skip venue resolution, and `resolveSubjectInjection` then reads `venueAccountId` from the stripped payload. `presetAssessment` is built only when `actor.type === 'agent'` and that account is non-empty, otherwise the tools return "preset assessment not available in this context".

| Tool | Declares `venueAccountId` | Works end to end from Herobids today |
|---|---|---|
| `assess_strategy_preset` | Yes (optional) | Yes, once Herobids forwards the account |
| `list_strategy_presets` | No | No (key stripped, context absent) |
| `change_strategy_preset` | No | No (key stripped, context absent) |

### T1. Traderton: make `list_strategy_presets` work without an account (owner: Traderton)
  - **Recommended change**: read from the always-present `ctx.presetCatalog` (the same source `get_strategy_presets` uses, same `listPresets(tier)` shape) instead of `ctx.presetAssessment`
  - File: `packages/worker/src/tools/preset-assessment.ts`. No schema change and no account needed, so the tool also works before a connection exists
  - Test: `list_strategy_presets` succeeds with `presetCatalog` set and `presetAssessment` unset
  - **Alternative** (not recommended): declare `venueAccountId` optional on its schema as `assess_strategy_preset` does. This needs a one-line Herobids follow-up (resolve and send the account in the list proxy), so choose it only if Traderton wants to keep the current seam
  - Herobids side: no change under the recommended option. The proxy sends no account on purpose
  - _Requirements: 2.2 (end to end), bugfix.md "Dependency on Traderton"_

### T2. Traderton: accept the venue account on `change_strategy_preset` (owner: Traderton)
  - File: `packages/domain/src/preset-assessment.ts`. Add `venueAccountId: z.string().min(1).optional()` with the description "Consumer-injected venue account binding. Never an LLM input." to `ChangeStrategyPresetParamsSchema`, mirroring `AssessStrategyPresetParamsSchema`. (Traderton's `adjust_risk_limits` instead declares it required and builds an LLM-facing schema with `.omit({ venueAccountId: true })`; either pattern is fine. Keep it optional if other callers could exist)
  - File: `packages/domain/src/tool-schemas.ts`. Keep the `get_schema` entry for `change_strategy_preset` in step
  - The tool stays `ownerScopedNoVenue`, so the skip path validates ownership and returns the account, which builds `presetAssessment` with the profile
  - Test (dispatcher or context-factory): a payload carrying `venueAccountId` yields a non-empty `presetAssessment.venueAccountId` for this tool, and one without it still returns the "not available" error
  - Herobids side: no change. The proxy already always sends `venueAccountId`; today Traderton strips it harmlessly
  - _Requirements: 2.3 (end to end), bugfix.md "Dependency on Traderton"_

Rollout states (both are safe for Herobids; the proxies are correct in both):

| State | `list_strategy_presets` | `assess_strategy_preset` | `change_strategy_preset` |
|---|---|---|---|
| Herobids fixed, T1/T2 not deployed | Traderton error "preset assessment not available in this context", mapped to `validation.invalid_payload`, `fault: false` (no breaker trip, no fallback) | Works | Same error as list |
| Both deployed | Works | Works | Works |
