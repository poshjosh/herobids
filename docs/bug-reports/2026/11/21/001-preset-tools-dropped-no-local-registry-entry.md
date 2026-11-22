# Bug Report: the three strategy-preset tools are never visible to agents (`list_strategy_presets`, `assess_strategy_preset`, `change_strategy_preset`)

- **Status:** FIXED in Herobids code (2026-11-21, uncommitted at the time of writing). Focused suites, `pnpm lint`, `pnpm build` and the full `pnpm test` pass. Two things are still open:
  - `list_strategy_presets` and `change_strategy_preset` do not work end to end until a Traderton build that includes the matching fix is deployed. That fix is written and tested in the Traderton working tree (2026-11-21) but is uncommitted and not deployed. It is described in Traderton's `docs/bug-reports/2026/11/21/002-list-and-change-strategy-preset-unavailable-without-venue-account.md`. (The spec called its two parts "T1" and "T2" in `.kiro/specs/preset-tools-dropped-no-local-registry/tasks.md`; those labels were created for that spec and are not an existing Traderton plan.) Until it is deployed, Traderton answers "preset assessment not available in this context", which the proxies map to `validation.invalid_payload` (`fault: false`). `assess_strategy_preset` needs no Traderton change.
  - Staging verification is pending. Nobody has restarted a canary agent on a new image and read `Backend tool visibility` in its log. The expected result is `toolCount: 22, taggedToolCount: 22, droppedTools: []`.
- **Severity:** Medium. A whole documented capability (an agent reviewing and switching its own strategy preset) cannot be used by any trading agent, and the review wake tells the agent to call tools it does not have. Medium rather than High only because a user can presumably still change the preset themselves in the web app. That workaround was not verified.
- **Date:** 2026-11-21
- **Environment:** observed on staging (agent `bright-parrot`, `e5312010-e9b7-4e5e-80eb-eac9c0e3fc86`, Nomad allocation `7857d519`). The cause is in shared worker code, so production is affected the same way. Not verified on production.
- **Related:**
  - `88e67c98` "feat(preset-assessment): move preset assessment to traderton, data-only and free" (2026-10-12). The commit that deleted the local tools.
  - `CHANGELOG.md` v0.6.11, which says the tools "are now Traderton tools reached over the external-backend path".
  - `docs/bug-reports/2026/11/17/002-gated-tools-without-default-grant-denied-for-every-agent.md`. Same class of failure: a tool the model is told about that cannot work.

## Summary

Traderton exposes `list_strategy_presets`, `assess_strategy_preset` and `change_strategy_preset` and tags them to the `traderton/skills/crypto-trading` skill. Herobids filters Traderton's tools down to the ones that also exist in its own local tool registry. Herobids deleted its local definitions of these tools in `88e67c98` and did not add thin proxies for them, so the filter drops all three on every agent start.

## Symptom

On every start or skill reload, the agent runtime logs this for `crypto-trading` (staging, 2026-11-18 08:42:29 and again 2026-11-20 14:25:03):

```
Backend tool visibility: approved skill tools resolved from MCP tools/list
  toolCount: 19, taggedToolCount: 22, discoveredToolCount: 29
  droppedTools: [
    { name: "list_strategy_presets",  reason: "not_in_local_registry" },
    { name: "assess_strategy_preset", reason: "not_in_local_registry" },
    { name: "change_strategy_preset", reason: "not_in_local_registry" } ]
```

followed by three `Backend tool visibility: tool tagged for this skill was not made visible` warnings and `Approved external skill tools are not all visible after discovery`.

The agent has 19 of the 22 tools. Over the agent's whole log (2,438 lines, 2026-11-18 to 2026-11-21), none of the three preset tools was ever called. That is expected, since they are not visible. It means this path has had no runtime use on staging since the move.

## Root Cause

Tool visibility for an approved external skill is computed as *(tools Traderton tags to the skill)* ∩ *(tools in the local herobids registry)*.

- `apps/worker/src/external-backend/backend-tool-visibility.ts`, `buildBackendToolVisibility`, about lines 188 to 197: a tagged tool with `registryToolNames.has(tool.name) === false` goes into `droppedTools` with reason `not_in_local_registry`.
- `apps/worker/src/agent.ts` line 1070: `registryToolNames = new Set(toolRegistry.list().map(t => t.name))`, built from `createToolRegistry()` (`apps/worker/src/tools/index.ts`).

Every other Traderton tool has a thin local proxy in the registry that forwards to the backend (for example `search_tokens` in `apps/worker/src/tools/market-data.ts` calls `ctx.externalBackend.invoke({ toolName: 'search_tokens', ... })`, and `adjust_risk_limits` uses `ctx.externalBackendWrite`).

Commit `88e67c98` deleted `apps/worker/src/tools/assess-strategy-preset.ts` and `change-strategy-preset.ts` (and their tests), plus their entries in `tools/index.ts`, `tool-schemas.ts` and `tools.ts`, and described the tools as "reached over the external-backend path". That description is wrong for the agent: no local proxy replaced the deleted tools, so there is no path from the agent to them.

`list_strategy_presets` is also absent. A search of `apps/worker/src`, `apps/api/src` and `packages/*/src` found no definition of it in herobids (`git log -S` shows it only in docs commits), so it was never a local tool either.

### Why it was not caught

- The drop is logged, but only at `warn` level, and nothing fails: the skill still loads and the agent runs, with fewer tools. A tool count of 19 against 22 looks like a normal result.
- The tests for the filter use a made-up `ghost_tool` (`backend-tool-visibility.test.ts`, `read-skill.test.ts`). None asserts that every tool named in Traderton's skill map is visible.
- Comments in `apps/worker/src/agent.ts` (around line 3401) still say "Transition tools (assess_strategy_preset, change_strategy_preset) are now implemented and registered". That stopped being true at `88e67c98`.
- The review screen calls `assess_strategy_preset` from the API process (`apps/api/src/routes/agent-platform-assessment-reviews.ts`, about line 236), which does not use the agent's registry. That path can look healthy while the agent's own path is broken.

## Impact

- An agent cannot compare presets or switch presets on its own, even when the creator's policy allows it (`changesAllowed`, `allowedPresets`).
- The assessment-review wake still instructs the agent to "Call `assess_strategy_preset`" and to change its preset with `change_strategy_preset` (`apps/worker/src/assessment-review-message.ts`, lines 33 to 35, and `buildPresetReviewMessage` in `agent.ts`). A wake that routes the agent into this flow asks for tools it cannot call. I did not check whether such a wake has fired on staging.
- `apps/worker/src/tools/platform-docs-data.ts` (lines 1716 and 1725) still lists `assess_strategy_preset` and `change_strategy_preset` as required tools in the docs that agents can read, so agents can be told they have them.
- The `crypto-trading` SKILL.md in `traderton-skills` has a full section on these tools. Agents read that text and cannot act on it.

## Reproduction (read-only)

1. Read the agent's runtime log, as in `.github/skills/access-remote-targets`: `nomad alloc logs -namespace=herobids-agents <alloc> agent`.
2. Search for `Backend tool visibility`. The message above appears at every start and every skill reload.
3. Offline equivalent: `traderton/packages/boundary/src/mcp/skill-tool-map.ts` lists 22 tools for `traderton/skills/crypto-trading`. Compare with the names in the herobids registry (`createToolRegistry()`). Exactly these three are missing.

## Suggested fix (not applied)

Add local proxy tools for the three names, in the same style as the other Traderton tools:
- Reads (`list_strategy_presets`, `assess_strategy_preset`): `ctx.externalBackend.invoke({ toolName, payload })` with `mapReadResultToToolResult`.
- Write (`change_strategy_preset`): `ctx.externalBackendWrite.invokeAndAwait(...)`, as `adjust_risk_limits` does.

Alternatively, stop requiring a local registry entry for backend-approved tools and dispatch them generically. That is a broader design change and needs the owner's decision. The three tools need entries in the herobids tool catalog and names list as well, since `88e67c98` removed those.

Before choosing, check that Traderton's write boundary accepts `change_strategy_preset` over REST. Herobids logs "read tools + risk-limit writes route over REST" at startup, which suggests risk-limit writes were the only write wired. I did not verify the Traderton side end to end. `change_strategy_preset` is defined there (`packages/worker/src/tools/preset-assessment.ts`, category `write-database`) and listed in its MCP skill map.

Also suggested:
- A test that every tool in Traderton's `SKILL_TOOL_MAP` for an approved skill is visible, or an explicit allow-list of known gaps.
- Raise the dropped-tool log to `error`, or surface it in the agent start summary, for tools in an approved skill's map.
- Fix the stale comments in `agent.ts`.

## Not verified

- Production behaviour.
- Whether the web-app preset-change workaround exists.
- Whether Traderton's REST write path supports `change_strategy_preset`.
- Whether a preset-review wake has been delivered to an agent on staging.
- Whether the staging agent image matches the current repository code (see `docs/bug-reports/2026/11/17/001-staging-agents-run-stale-pinned-agent-image.md`). The code reading above is from this repository's current HEAD. The log evidence is from the running staging agent. Both agree.

## Fix

Three thin proxy tools in `apps/worker/src/tools/strategy-presets.ts` forward to Traderton: two reads (`list_strategy_presets`, `assess_strategy_preset`) and one write (`change_strategy_preset`, 30 s deadline, idempotency key minted per call by the write boundary). Assess and change add the agent's selected venue account and return `connection.missing` or `connection.provisioning` without calling Traderton when none is ready. Without a boundary all three return `precondition.not_ready`. The visibility rule (tagged by Traderton AND present locally) is unchanged.

Detection: a dropped tagged tool is now one `error` log per skill (`droppedToolNames`). `backend-skill-tools.test.ts` fails when a tool in the checked-in, names-only fixture `apps/worker/src/external-backend/__fixtures__/traderton-skill-tools.json` has no local tool.

Rollout: the Traderton fix first (see Traderton bug report 2026/11/21/002), then Herobids, then release the agent image and restart a canary. A skill reload alone is not enough on an agent still running the old image.

## Verification (2026-11-21)

- Focused vitest: 17 files, 357 tests passed.
- `pnpm lint`: pass (note: it checks nothing at the repo root, `tsconfig.json` has `"files": []`).
- `pnpm build`: pass (the real type check; it excludes `*.test.ts`).
- `pnpm test`: 463 files passed, 48 skipped; 8978 tests passed, 767 skipped; 0 failed.
- Not run: `pnpm test:integration`, any staging or production check, any call against a live Traderton.

## Files Changed

Modified (`git diff --stat`):

- `CHANGELOG.md`
- `apps/worker/src/agent.ts` (comments only)
- `apps/worker/src/assessment-review-message.ts` (JSDoc only)
- `apps/worker/src/assessment-review-message.test.ts` (wake text preservation test)
- `apps/worker/src/external-backend/agent-ports.ts` (log text)
- `apps/worker/src/external-backend/backend-tool-visibility.ts` (one `error` per skill)
- `apps/worker/src/external-backend/backend-tool-visibility.test.ts`
- `apps/worker/src/hybrid-agent-evaluator.ts` (comment only)
- `apps/worker/src/tools/index.ts` (register `strategyPresetTools`)
- `apps/worker/src/tools/platform-docs-data.ts` (generated, two lines)
- `apps/worker/src/tools/tool-registry.test.ts`
- `docs/features/pending/000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md` (three rows)
- `packages/domain/src/tools.ts` (names and catalog)
- `scripts/ts/build-docs-index.ts`

New:

- `apps/worker/src/tools/strategy-presets.ts`
- `apps/worker/src/tools/strategy-presets.test.ts`
- `apps/worker/src/tools/strategy-presets.integration.test.ts`
- `apps/worker/src/external-backend/backend-skill-tools.test.ts`
- `apps/worker/src/external-backend/__fixtures__/traderton-skill-tools.json`

Docs updated after the fix: `docs/features/pending/001-capability-gating-enforcement/001-plan.md`, `docs/features/pending/000-multi-timeframe-market-structure/001-plan.md`.
