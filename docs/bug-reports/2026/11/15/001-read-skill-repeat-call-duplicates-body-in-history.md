# Bug Report: Repeat `read_skill` / `load_skill` calls return the full skill body again and duplicate it in the conversation history

- **Status:** FIXED (in code, not deployed)
- **Severity:** Low
- **Date:** 2026-11-15
- **Summary:** `read_skill` re-reads `SKILL.md` and returns the whole body as `data.instructions` on every call, even when the skill is already loaded this session. `load_skill` inherits this. Both tools are in `DURABLE_TOOL_NAMES`, so their results are never truncated, and every repeat call permanently adds another full copy of the body to the conversation history.

## Symptom

An agent that calls `read_skill` (or `load_skill`) more than once for the same skill in one session gets the full body back each time. The history then holds one full copy per call. No error is raised and nothing is logged, so it shows up only as growing context and token cost.

## Root Cause

Verified by reading the code:

- `apps/worker/src/tools/read-skill.ts`, `executeReadSkill`: after the assigned and availability checks it always calls `readInstalledSkillBody`, then `session?.markLoaded(ref, body)`, then returns `instructions: body`. It never consults `session.isLoaded(ref)`.
- `session.isLoaded` is defined at `apps/worker/src/agent.ts:2260` (`loadedBodies.has(sourceRef)`). It is used only by tests.
- `session.markLoaded` writes `runtimeState.externalSkills.loadedBodies` (`agent.ts:2258`). `runtime-composition.ts:2557` renders that map into the system prompt, once per prompt build. The system prompt is therefore not duplicated.
- `apps/worker/src/tools/load-skill.ts` calls `readSkillTool.execute({ ref: rawRef }, ctx)` and spreads the result data, so it returns the full body on a repeat call too. It skips `add_skills` when the skill is already assigned, but not the read.
- `read_skill` and `load_skill` are in `DURABLE_TOOL_NAMES` (`apps/worker/src/structured-tool-loop.ts:12-15`), added by the fix in `docs/bug-reports/2026/11/14/002-durable-tool-results-deleted-by-stale-truncation.md`. Pinned results are exempt from stale truncation, so each copy stays in the history for the whole loop.

## Impact

- Each repeat call adds one full body to the history (about 15 KB, roughly 4k tokens, for a skill the size of `job-search`). The copies are never truncated, so the cost is paid on every later model call in that loop.
- The system prompt is not affected. It holds one copy, because `loadedBodies` is a Map keyed by ref.
- No incorrect behavior, only wasted context. It can push a long run toward `maxHistoryTokens`.

## History Check

Read-only `git log` on `apps/worker/src/tools/read-skill.ts`, `load-skill.ts` and `structured-tool-loop.ts`:

```
dadb77dc Improve UX
b3c23760 fix(worker): make stale tool-result truncation idempotent
7c569548 fix(worker): exempt durable tool results from stale truncation
2e005613 Improve skill loading
f03e5c6c fix(worker): keep backend tools after skill install and config updates
cd241243 Fix skill and connection handling
fde57c00 Phase 4 T5-T7: install external skills at start, read_skill, progressive disclosure
2fde6d16 steps 10,10a,10b: wire skillOps, onSkillsChanged hot-reload callback, per-turn tool getter in judge loop
```

- `fde57c00` introduced `read_skill`. It has returned the full body on every call since then.
- **Gap, not a regression.** `read_skill` never had a loaded-skill short-circuit. Before `7c569548` the duplicates were eventually truncated like any other stale result, which hid the cost. Pinning `read_skill`/`load_skill` results in `7c569548` (bug 002) made the duplicates permanent. That fix is correct and is not changed here.

Prior reports (`grep read_skill docs/bug-reports/`): `2026/11/14/002` (stale truncation deleted the body) and `2026/11/14/003` (ref normalization; mentions the agent recovering via `read_skill`). Neither covers repeat calls. `2026/10/05/005` only mentions the agent calling `read_skill`. This is new.

## Fix

- `executeReadSkill` now checks `session?.isLoaded(ref)` after the assigned and availability checks and before reading from disk. When the skill is loaded and `refresh` is not true, it returns success with `{ ref, loaded: true, available: true, alreadyLoaded: true, message, ...toolReportFields }` and no `instructions`. The tool report fields are kept so the agent still sees which tools it can call.
- `ReadSkillParamsSchema` gained an optional boolean `refresh`. With `refresh: true` the short-circuit is skipped and the existing path runs (read from disk, install if missing, `markLoaded` with the new body, return `instructions`).
- `load_skill` accepts an optional `refresh` and passes it to `read_skill`. It is otherwise unchanged.
- Both tool descriptions mention the already-loaded behavior and `refresh`. The JSON schema comes from `convertZodToJsonSchema`, so `refresh` appears in it (as `["boolean","null"]`, the OpenAI-target form for optionals, and not in `required`).
- Not changed: stale-result truncation and `DURABLE_TOOL_NAMES`. The system prompt text and `packages/domain` tool descriptions ("stays available for the rest of the session") are still accurate, so they were left alone.

## Files Changed

- `apps/worker/src/tools/read-skill.ts`
- `apps/worker/src/tools/load-skill.ts`
- `apps/worker/src/tools/read-skill.test.ts`
- `apps/worker/src/tools/load-skill.test.ts`
- `CHANGELOG.md`
- this report

No existing test asserted the old duplicate-body behavior, so none were adjusted.

## Verification

Done:

- `pnpm exec vitest run src/tools src/external-skill-startup.test.ts src/structured-tool-loop.test.ts src/render-skill-prompt-block.test.ts` in `apps/worker`: 48 files, 1040 tests pass. An earlier run with all test files that mention `read_skill`/`load_skill` also passed apart from one assertion of mine on the JSON schema type (nullable form), which I corrected in the new test.
- `pnpm lint` (`tsc --noEmit`): passes.
- `pnpm --filter @herobids/worker build`: passes.
- New tests cover: repeat call returns no `instructions` and `alreadyLoaded: true`; no disk read or installer call on a repeat; tool report fields kept; `refresh: true` re-reads and updates the stored body; `refresh: true` still installs a missing SKILL.md; a different ref still loads; not-assigned and unavailable paths unchanged; `refresh` in the JSON schema; `load_skill` repeat and `refresh` pass-through.

Not verified:

- No live agent run. Whether models use `refresh` sensibly, or read the `alreadyLoaded` message correctly, is untested.
- The message says the instructions are in the system prompt. In the same tick as the first load, the system prompt is not rebuilt until the next build; the first result is still in the history then. If `loadedBodies` is lost (restart), `isLoaded` is false and the skill loads normally.
- No DB or integration suites were run.
