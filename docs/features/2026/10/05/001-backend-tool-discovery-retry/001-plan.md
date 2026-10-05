# 001 — Retry with backoff for backend tool discovery (MCP `tools/list`)

**Status:** planned. **Date:** 2026-10-05.

## Confirmation of the premise

Confirmed by reading the code (not assumed):

- Agent containers do **not** run a general-purpose MCP client that calls `tools/list`
  for arbitrary skills. The only `tools/list` discovery call in `herobids` is scoped to
  **backend-approved external skills** (Phase 4 T8, ADR 017 §3-4) — e.g. an agent that
  has been assigned a skill whose `sourceRef` is approved by the forwarded Traderton
  backend (this is how `traderton/skills/crypto-trading` gets its tools: Traderton's
  `tools/list` surface, not a committed descriptor file).
- Call chain: `apps/worker/src/agent.ts` → `resolveBackendApprovedSkills()`
  (`agent.ts:4036`) → `buildBackendToolVisibility()`
  (`apps/worker/src/external-backend/backend-tool-visibility.ts:98`) →
  `discoverViaMcp()` (same file, line 76) → `discoverExternalBackendTools()`
  (`packages/domain/src/external-backend/discover-tools.ts:16`) →
  `McpTransport.listTools()` (`packages/domain/src/external-backend/transports/mcp-transport.ts:159`).
- `resolveBackendApprovedSkills()` is called from exactly two places:
  1. **Agent start**, once, before the first tick (`agent.ts:4123-4126`, right before
     `toolVisibility.snapshotToolBaselines()` and the first `runTick()` at `agent.ts:4146`).
  2. **`onSkillsChanged`** (`agent.ts:2005`), the hook invoked by the `add_skills` /
     `remove_skills` tools (`apps/worker/src/tools/skills.ts`) after a DB-confirmed skill
     mutation.
- Failure handling today: `discoverViaMcp()` and `McpTransport.listTools()` never throw —
  an unreachable backend (timeout, HTTP error, protocol error) resolves to
  `{ kind: 'unreachable', message }`, which `buildBackendToolVisibility()` turns into
  `requiredTools: []` for every approved skill and an `outcome: 'backend_unreachable'`
  entry, logged once via `logger.warn(...)` (`backend-tool-visibility.ts:88` and `:159`).
  `resolveBackendApprovedSkills()` additionally wraps the whole call in try/catch
  (`agent.ts:4038-4047`) so a thrown error degrades the same way instead of crashing
  agent start.
- **There is no retry.** If discovery fails during the one-shot call at agent start, the
  agent's `runtimeDescriptor.resolvedSkills[].requiredTools` for every backend-approved
  skill stays `[]` for the rest of the session — the agent has no trading tools — unless
  the LLM happens to call `add_skills` (which re-triggers `onSkillsChanged` →
  `resolveBackendApprovedSkills()` again, incidentally retrying discovery as a side
  effect of a skill-list mutation, not a decision to retry).
- The tick loop (`runActiveTick()`, `agent.ts:2495`, invoked every tick via
  `runTick()`/`scheduleNextTick()`) never looks at backend tool discovery outcomes and
  never re-runs `resolveBackendApprovedSkills()`. `refreshToolCircuits()` is called at
  tick start today but only manages the unrelated `ToolCircuitBreaker` (per-tool-call
  failure circuit breaking), not discovery.
- Existing backoff convention to reuse: `FailureBackoffController`
  (`apps/worker/src/runtime-resilience.ts:12-54`) — consecutive-failure counting with
  interval doubling up to a cap, `recordFailure()` / `recordSuccess()`. It is currently
  wired to the shutdown-eligibility gate (`llm`/`redis`/`sandbox`/`startup` sources) via
  `handleRuntimeFailure`/`processRuntimeFailure`. Tool discovery is an **advisory**
  failure (never shuts the agent down), so this plan introduces a small sibling backoff
  tracker scoped to discovery rather than routing through the shutdown-eligible path.

Premise confirmed: tools discovery failures are logged but never retried, and a failure
at agent start silently removes trading tools for the whole session unless the LLM
happens to call `add_skills`.

## Goal

Close the gap with two complementary mechanisms, both advisory (never throw, never
block/crash agent start or a tick):

1. **Short retry-with-backoff inside the discovery call itself**, so a transient failure
   (one dropped connection, one slow backend) at agent start doesn't need a whole extra
   tick to resolve.
2. **Retry at tick start while discovery is still outstanding/failed**, so a backend that
   was down at agent start and recovers later gets picked up automatically, without
   requiring the LLM to call `add_skills`.

## Design

### 1. Bounded retry inside `discoverViaMcp` (fast path, agent-start latency bound)

Add a small retry loop around the single `discoverExternalBackendTools()` call in
`backend-tool-visibility.ts`, not inside `McpTransport` (keep the transport a pure,
single-attempt seam per its existing contract comment — "it owns NO idempotency, retry,
deadline arithmetic" — `mcp-transport.ts:1-14`).

- New pure helper in `packages/domain/src/external-backend/` (new file
  `retry-discovery.ts`, or a small function colocated in `discover-tools.ts` — exact
  placement decided at implementation time, but it must stay a **pure function over an
  injected delay**, no `setTimeout` baked in, so it stays unit-testable without timers):

  ```ts
  export interface DiscoveryRetryOptions {
    maxAttempts: number;       // e.g. 3
    baseDelayMs: number;       // e.g. 250
    maxDelayMs: number;        // e.g. 2_000
  }

  export async function discoverWithRetry(
    attempt: () => Promise<ListToolsOutcome>,
    options: DiscoveryRetryOptions,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<ListToolsOutcome> {
    let last: ListToolsOutcome = { kind: 'unreachable', message: 'no attempt made' };
    for (let i = 0; i < options.maxAttempts; i++) {
      last = await attempt();
      if (last.kind === 'ok') return last;
      if (i < options.maxAttempts - 1) {
        const delay = Math.min(options.baseDelayMs * 2 ** i, options.maxDelayMs);
        await sleep(delay);
      }
    }
    return last; // last unreachable outcome, after exhausting attempts
  }
  ```

- Wire it into `discoverViaMcp()` in `backend-tool-visibility.ts`: replace the single
  `await discoverExternalBackendTools(...)` call with
  `await discoverWithRetry(() => discoverExternalBackendTools(resolved.definition, resolved.hmacSecret), { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 })`.
  Defaults are deliberately small (worst case ~2.25s added latency at agent start across
  3 attempts) — this closes "one blip" gaps, not sustained outages; sustained outages are
  covered by mechanism 2 below.
- `maxAttempts`/`baseDelayMs`/`maxDelayMs` are **operator config**, not hardcoded
  literals (per `docs/best-practices/configuration.md`): add
  `externalBackendDiscoveryRetry: { maxAttempts, baseDelayMs, maxDelayMs }` to
  `config/default.yaml` with sane defaults, Zod-validated at startup alongside the rest
  of `EXTERNAL_BACKEND_CONFIG_JSON`'s schema in `packages/domain/src/config/`. Thread it
  through `BuildBackendToolVisibilityInput` so tests can override it without touching
  config loading.
- Logging: keep the existing single `logger.warn(...)` on final failure
  (`backend-tool-visibility.ts:88`), add one `logger.info`/`debug` per retried attempt
  with the attempt number, so operators can distinguish "failed once, retried, recovered"
  from "failed outright" in logs without a volume regression (no log line on the
  succeeding first attempt — only on retries).

### 2. Retry at tick start while backend-approved tools are still empty

Track, per session, whether the last discovery attempt left any backend-approved skill
with `outcome !== 'tools_exposed'` (i.e. `backend_unreachable` or `no_tools` is NOT the
same as unreachable — only retry on `backend_unreachable`, since `no_tools`/`not_approved`
are legitimate terminal states, not failures).

- Extend `RuntimeCompositionState` (`runtime-composition.ts:311`) with a small piece of
  session state, next to `externalSkills`:

  ```ts
  /** Phase 4 T8 follow-up — backend tool discovery retry state (advisory, never shuts the agent down). */
  interface BackendDiscoveryRetryState {
    /** True once at least one approved skill resolved to backend_unreachable. */
    pending: boolean;
    /** FailureBackoffController-shaped counters, scoped to this concern only. */
    consecutiveFailures: number;
    nextRetryAtMs: number;
  }
  ```

  (Exact shape decided at implementation time; may reuse `FailureBackoffController`
  directly if its shutdown-eligibility coupling can be bypassed by simply never passing
  `source` into the shutdown-eligible set — needs a quick look at `handleRuntimeFailure`
  call sites before deciding reuse vs. a small bespoke counter. Given the class is small
  and tightly scoped already, a bespoke 10-line counter is likely simpler than threading
  a new advisory source through the existing shutdown-gated path — avoid widening
  `FailureBackoffController`'s responsibility.)

- At the end of `resolveBackendApprovedSkills()` (`agent.ts:4036`), capture whether
  `result.outcomes` contains any `backend_unreachable` entry and update this state
  (`pending = true`, bump `consecutiveFailures`, compute `nextRetryAtMs` with the same
  doubling-with-cap shape as `FailureBackoffController` — e.g. base 30s, cap 10min — these
  are also operator config, `agentRiskDefaults`-style but under a neutral
  `externalBackendDiscoveryRetry.tickRetry.{baseIntervalMs,maxIntervalMs}` key since this
  is operational mechanics, not trading policy). On a run with zero
  `backend_unreachable` entries, clear `pending` and reset the counter (mirrors
  `recordSuccess()`).
- At the **start of `runActiveTick()`** (`agent.ts:2495`, right next to the existing
  `refreshToolCircuits()` call — same "per-tick housekeeping" neighborhood), add:

  ```ts
  if (backendDiscoveryRetry.pending && Date.now() >= backendDiscoveryRetry.nextRetryAtMs) {
    runtimeState.runtimeDescriptor.resolvedSkills = await resolveBackendApprovedSkills(
      runtimeState.runtimeDescriptor.resolvedSkills,
    );
    toolVisibility.snapshotToolBaselines();
    applyToolVisibility();
  }
  ```

  This reuses the exact same re-baseline sequence `onSkillsChanged` already uses
  (`agent.ts:2005-2008` plus the `snapshotToolBaselines()`/`applyToolVisibility()` pair),
  so a tick-start retry refreshes tool visibility identically to an `add_skills`-triggered
  refresh — no new code path for "tools becoming visible mid-session."
  Must run **before** the tick's gating logic
  (`shouldSkipTick`/`buildTickGateState`) only in the sense that it should not depend on
  whether the tick ends up dispatching to the LLM — the refresh should happen every
  eligible tick regardless of skip decisions, since the agent needs the tools visible
  whenever the LLM next runs, not just on LLM-dispatching ticks. Placing it at the very
  top of `runActiveTick()`, before the pause/skip checks, achieves this.
- Backoff interval choice: ticks already run on `effectiveTickIntervalMs` cadence
  (`scheduleNextTick`), so "retry at tick start" is naturally rate-limited by the tick
  interval already — the backoff on top of that exists to avoid retrying a backend that
  just failed on *every single tick* when the tick interval is short (e.g. a 5s tick
  interval scalping agent shouldn't hammer a down backend every 5s for a whole session).
  A base interval around 30s–60s with doubling to a 10 minute cap is a reasonable
  starting point; exact numbers are operator config, not hardcoded.

### Non-goals / explicitly out of scope

- No change to `McpTransport` itself — it stays a single-attempt, no-retry transport per
  its documented contract. Retry logic lives one layer up, where it can see
  skill-level/outcome-level context (which skills are actually affected) rather than a
  bare transport error.
- No change to the `add_skills`/`onSkillsChanged` path — it already triggers discovery
  as a side effect and keeps working unchanged; this plan only adds retry for the cases
  where the LLM never calls `add_skills` again.
- Not retrying `not_approved` or `no_tools` outcomes — these are correct terminal states,
  not failures, and retrying them would be pointless.
- No per-skill retry granularity — discovery is backend-scoped (one MCP connection per
  backend, serving all approved skills' tools in one `tools/list` call), so retry state
  is tracked once per backend/session, matching the existing `needsDiscovery`/`discovered`
  single-call-per-session shape in `buildBackendToolVisibility()`.

## Steps

1. **Domain: bounded retry helper**
   - Add `discoverWithRetry()` (pure, injectable sleep) in `packages/domain/src/external-backend/`.
   - Add `externalBackendDiscoveryRetry` config schema (maxAttempts/baseDelayMs/maxDelayMs
     for the fast in-call retry; baseIntervalMs/maxIntervalMs for the tick-start retry) to
     `packages/domain/src/config/` + `config/default.yaml`, with env override support and
     `.env.example` updated if any new env var is introduced.
   - Unit tests: succeeds on attempt 2/3 after simulated failures; exhausts attempts and
     returns the last `unreachable` outcome; respects `maxDelayMs` cap; never throws.

2. **Worker: wire the fast retry into `discoverViaMcp`**
   - `backend-tool-visibility.ts`: call `discoverWithRetry` instead of a bare single call;
     pass config-sourced options through `BuildBackendToolVisibilityInput` (new optional
     field, defaulted from config at the `agent.ts` call site so tests can override).
   - Update/extend existing tests in `backend-tool-visibility.test.ts` for: recovers on
     retry; still reports `backend_unreachable` after exhausting retries; log line present
     once per retried attempt, absent on first-try success.

3. **Worker: tick-start retry state + wiring**
   - Add the small backend-discovery retry counter (decide bespoke vs.
     `FailureBackoffController` reuse per the note above) to `RuntimeCompositionState`
     or as a sibling module-level variable in `agent.ts` next to `tickInFlight` et al.
     (match whichever existing pattern — session-scoped mutable state already lives both
     places in this file; prefer `RuntimeCompositionState` if the counter needs to survive
     a hot-reload-style refresh, module-level if it's purely process-lifetime).
   - Update `resolveBackendApprovedSkills()` to record success/failure into this counter
     based on `result.outcomes`.
   - Add the tick-start check at the top of `runActiveTick()`.
   - Tests: a tick with `pending=true` and `now >= nextRetryAtMs` re-runs discovery and
     applies tool visibility; a tick before `nextRetryAtMs` does nothing; a successful
     retry clears `pending` and resets backoff; repeated failures double the interval up
     to the cap.

4. **Docs**
   - `CHANGELOG.md` entry.
   - Note in `docs/best-practices/configuration.md` if the new config keys need a mention
     there (operator-config section) — only if that doc's existing structure expects every
     new default.yaml key to be indexed; check its current convention before adding.

## Verification

- `pnpm build && pnpm lint`
- `pnpm test` (new unit tests above)
- `pnpm --filter @herobids/worker exec vitest run src/external-backend` and
  `src/agent*.test.ts` (or the project's actual worker test invocation — confirm exact
  command from `package.json` at implementation time)
- Manual/integration check: `scripts/shell/run/reset-and-run-xstack.sh`, then simulate a
  Traderton backend outage at agent start (stop the traderton MCP endpoint before the
  agent container starts) and confirm (a) the agent starts without trading tools, (b) once
  the backend is brought back up, a subsequent tick (within the backoff window) picks up
  the tools without needing `add_skills` or a restart.

## Risks

- **Latency at agent start:** the fast retry (mechanism 1) adds up to ~2s to agent start
  in the worst case (3 attempts, full backoff) when the backend is genuinely down. This is
  bounded and small relative to the rest of agent start (DB connect, Redis connect, skill
  install), but worth confirming against any agent-start SLA/wall-clock budget check
  (`sandboxEnforcer`) if one exists.
- **Retry storms across many agents:** if a backend goes down while many agent containers
  are starting simultaneously, mechanism 1's retries plus mechanism 2's tick-start retries
  across all affected agents could add load back onto a recovering backend. The backoff
  caps bound this per-agent, but a thundering-herd effect across agents isn't addressed
  here — flagged for the operator to size `baseIntervalMs`/`maxIntervalMs` with this in
  mind; full jitter could be added later if this becomes an observed problem.
- **Scope of `FailureBackoffController` reuse:** decided to lean bespoke rather than widen
  the existing class's shutdown-eligibility semantics; confirm this doesn't duplicate logic
  the team would rather consolidate — flag for review before merging if a reviewer prefers
  a shared backoff utility.
