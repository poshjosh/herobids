# 002 — Post-Evaluation Fixes: Determinism, Artifacts, Backoff, Observability, Dead Agents

**Status:** In Progress
**Created:** 2026-07-24
**Depends on:** Evaluation `.ignore/eval/2026/07/23/REPORT.md`

## Context

An evaluation of staging agents (mo-day, swing, range) on 2026-07-23 revealed five
actionable issues. This plan covers their implementation.

Not in scope (deferred):
- Reducing `scanIntervalMs`
- Fixing watch evaluation for scanner-gated agents
- Investigating why scanner only runs for mo-day
- Increasing `maxOpenPositions`

---

## Item 1 [DONE] — Deterministic **and unbiased** candidate ordering

### Problem

`scanCandidates()` in [scan-engine.ts#L425-L438](packages/strategy/src/scan-engine.ts#L425)
sorts by confidence descending only:

```ts
.sort((a, b) => b.confidence - a.confidence);
```

The signal-dedup fingerprint ([complete-technical-scan.ts#L60-L69](apps/worker/src/complete-technical-scan.ts#L60))
is already rank-insensitive: it takes `signals.slice(0, topN)`, then sorts those N
alphabetically by `instrumentId` and buckets confidence. So the fingerprint is stable
**for a fixed set of top-N members**. The churn comes from *which* signals land inside
the top-N cut: when several signals tie at the boundary confidence (the report observed
many ties at `0.40`), the JS sort is not a total order, so the Nth member depends on the
non-deterministic input order (market-discovery order + rate-limit filtering).

### Fix (better than a pure alphabetical tiebreak)

Make the sort a **total order whose secondary key is signal quality, with
`instrumentId` only as the final deterministic fallback**:

```ts
.sort((a, b) =>
  b.confidence - a.confidence
  || b.reasons.length - a.reasons.length          // more confirming signals win the tie
  || a.instrumentId.localeCompare(b.instrumentId) // last-resort stable fallback
);
```

Why this beats `001`'s `|| a.instrumentId.localeCompare(...)` alone:

- **No alphabetical bias.** Ties are resolved by how many independent indicators
  confirmed the signal (`reasons.length`), which is a genuine strength proxy already
  computed by `scoreCandidate()`. Only exact quality ties fall through to the alphabetical
  fallback, so `ZEC-PERP` is no longer permanently disadvantaged versus `AAVE-PERP`.
- **Still fully deterministic.** The `instrumentId` fallback guarantees a total order.

### Honest scope note

This stabilizes the top-N *selection* when the same scored population is present. It does
**not** fix the report's dominant churn cause — rate-limiting produces a *different scored
population* each scan (`ZEC` present one scan, absent the next). That is addressed by
Item 3 (fewer transient failures) and Item 7 (root-cause the rate pressure). Item 1 is a
correct, cheap, necessary precondition — not a complete fix on its own.

### Files changed

| File | Action |
|------|--------|
| [scan-engine.ts](packages/strategy/src/scan-engine.ts) | Add quality-then-id tiebreak to `scanCandidates()` |
| [scan-engine.test.ts](packages/strategy/src/scan-engine.test.ts) | Test: equal confidence → higher `reasons.length` ranks first; equal both → alphabetical; assert top-N selection is stable under input shuffling |

---

## Item 2 [DONE] — `llm_decision_artifacts` persistence (minimal, complete)

### Problem

The hybrid single-shot evaluator (`runHybridEvaluator` in
[hybrid-agent-evaluator.ts](apps/worker/src/hybrid-agent-evaluator.ts)) calls the LLM
directly via `callLlmProvider` and never persists an artifact. Only `LlmStrategy` persists
via the `insertLlmArtifact` callback wired at [index.ts#L1251](apps/worker/src/index.ts#L1251)
and [backtest-runtime.ts#L147](apps/worker/src/backtest-runtime.ts#L147). Scanner-gated
agents (mo-day) route exclusively through the hybrid evaluator, so their table is empty —
matching the report's §4.3 CRITICAL finding.

The hybrid path is **1 LLM call → N decisions**, but the schema's `decision_id` is
`NOT NULL` (1:1). The schema must accommodate 1:N.

### Fix

#### Part A — Shared repository
Extract `insertLlmArtifact` into a standalone `LlmArtifactRepository` in `packages/db/`
so both `LlmStrategy` (worker) and the hybrid evaluator can call it.

#### Part B — Schema evolution (minimal)

| Column | Old | New |
|--------|-----|-----|
| `decision_id` | `text NOT NULL` | `text` (nullable — null for hybrid 1:N) |
| `decision_ids` | — | `jsonb` (array of decision UUIDs; null for `llm_strategy`) |
| `source` | — | `text NOT NULL DEFAULT 'llm_strategy'` (`'llm_strategy'` \| `'hybrid_evaluator'`) |

**Dropped from `001`:** the denormalized `prompt_text` / `response_text` columns. The
report only requires that artifacts be persisted for cost/audit; the full
`prompt_payload` / `raw_response` columns already carry that data. Duplicating large text
for hypothetical "searchability" is gold-plating (violates KISS/DRY in AGENTS.md). Add it
later only if a concrete query need appears.

#### Part C — Wire into hybrid evaluator
Add an `onArtifact` callback to `HybridEvaluatorInput`. After the LLM call resolves
(success **or** failure), build an `LlmDecisionArtifact` — with `source: 'hybrid_evaluator'`,
`decisionId: null`, `decisionIds: [<submitted decision ids>]` — and invoke `onArtifact`.
Wire it from [agent.ts](apps/worker/src/agent.ts) using the agent container's existing DB
connection (the one already used for `agentRepo` / `botRepo`).

#### Part D — Update existing writers **and readers**
- Writers: replace `backtestingRepo.insertLlmArtifact()` at
  [index.ts#L1251](apps/worker/src/index.ts#L1251) and
  [backtest-runtime.ts#L147](apps/worker/src/backtest-runtime.ts#L147) with
  `LlmArtifactRepository.insert()` (passing `source: 'llm_strategy'`, `decisionId` set).
- **Readers (missed by `001`):** audit every consumer that reads
  `llm_decision_artifacts.decision_id` and make it tolerate `null` + the new
  `decision_ids` array. Grep `insertLlmArtifact|decisionId|llm_decision_artifacts` across
  `apps/` and `packages/` before implementing; update cost-tracking / evaluation collectors
  accordingly. A write-only fix leaves cost attribution half-done.

### Files changed

| File | Action |
|------|--------|
| [llm-decision-artifacts.ts](packages/db/src/schema/llm-decision-artifacts.ts) | Nullable `decisionId`; add `decisionIds`, `source` |
| `packages/db/src/llm-artifact-repository.ts` | **New** — `insert()`, `getByDecisionId()` |
| [index.ts](packages/db/src/index.ts) | Export new repo |
| [backtesting-repository.ts](packages/db/src/backtesting-repository.ts) | Delegate to / remove `insertLlmArtifact` (no back-compat required) |
| [hybrid-agent-evaluator.ts](apps/worker/src/hybrid-agent-evaluator.ts) | Add `onArtifact`; emit on success + failure |
| [agent.ts](apps/worker/src/agent.ts) | Wire `onArtifact` via `LlmArtifactRepository` |
| [index.ts](apps/worker/src/index.ts) | Swap writer to new repo |
| [backtest-runtime.ts](apps/worker/src/backtest-runtime.ts) | Swap writer to new repo |
| Any artifact **readers** found by grep | Handle nullable `decisionId` / `decisionIds` |
| `packages/db/drizzle/` | Generate migration (run `pnpm --filter @herobids/db run migrate`) |

---

## Item 3 [DONE] — Bounded retry / backoff for transient candle failures (cadence-aware)

### Problem

`runTechnicalPhase` fetches candles in parallel batches. Transient failures (rate limits,
5xx, timeouts) classified by `classifyCandleError()` are silently skipped with no retry.
The report shows 10+ `transient_failure` per 60s cycle, wasting rate-limit budget and
producing a different scored population each scan.

### Fix (corrected design)

Two coordinated changes:

1. **In-cycle bounded retry with jitter (primary).** Within a single scan, retry a
   `transient_failure` symbol up to `maxRetries` times with short jittered delays
   (e.g. 250ms → 500ms → 1000ms + jitter) *before* giving up. This is what actually
   recovers symbols inside the current scan and stabilizes the scored population — the
   thing dedup cares about.
2. **Cross-scan circuit breaker (secondary, cadence-aware).** Only after a symbol fails
   *every retry across `N` consecutive scans* do we open a breaker that skips it for a
   duration **measured in scan cycles, not milliseconds**. Windows must exceed
   `scanIntervalMs` to have any effect, so express them as multiples of the scan interval
   (e.g. skip for `2, 4, 8` scans, capped). A 2s/4s/8s millisecond backoff (as in `001`)
   is useless against a 60s cadence and is removed.

**Removed claim:** `001` asserted backoff fixes "defeated signal deduplication." It does
not — skipping a symbol changes the fingerprint. The honest benefit is **reduced wasted
rate-limit budget and fewer flapping symbols**, which *indirectly* helps determinism only
via change (1) recovering symbols in-cycle. State this accurately in the code comment.

- `unsupported` failures (HTTP 400) never retry and never open a breaker — permanent.
- Breaker state keyed `scanner:candle-breaker:<agentId>:<providerSymbol>` in Redis, with a
  fail-count and a "skip until scan-epoch" marker.

### Operator config

```yaml
agentRuntime:
  candleFetchRetry:
    enabled: true
    maxRetries: 3           # in-cycle retries before giving up on a symbol this scan
    baseDelayMs: 250        # first retry delay; grows x2 with full jitter
    maxDelayMs: 2000        # per-retry ceiling (stays well within one scan)
  candleFetchBreaker:
    enabled: true
    failScansBeforeOpen: 3  # consecutive fully-failed scans before skipping the symbol
    baseSkipScans: 2        # skip this many scans when breaker opens
    maxSkipScans: 8         # ceiling, in scan cycles
```

### Files changed

| File | Action |
|------|--------|
| `apps/worker/src/candle-fetch-retry.ts` | **New** — in-cycle bounded retry with jitter |
| `apps/worker/src/candle-fetch-breaker.ts` | **New** — cross-scan circuit breaker (Redis, scan-cycle units) |
| [technical-phase.ts](apps/worker/src/technical-phase.ts) | Retry transient failures in-cycle; consult/record breaker |
| [agent-trading-actor.ts](apps/worker/src/agent-trading-actor.ts) | Inject retry + breaker into phase deps |
| [index.ts](apps/worker/src/index.ts) | Construct and pass retry + breaker |
| [default.yaml](config/default.yaml) | Add both config blocks |
| [schema.ts](packages/domain/src/config/schema.ts) | Zod schemas for both blocks |
| [redis-keys.ts](apps/worker/src/redis-keys.ts) | Add `candleBreakerKey(agentId, providerSymbol)` |

---

## Item 4 [PENDING] — `agent:memory` Redis `WRONGTYPE` (tooling fix, not a no-op)

### Finding

`redis-cli GET agent:memory:<id>` returned `WRONGTYPE` because the key is a Redis **hash**
(`HSET`/`HGETALL`), not a string. The memory subsystem is correct — the diagnostic command
was wrong.

### Fix (the one actionable output `001` missed)

Correct the evaluation runbook / skill so the next evaluation uses `HGETALL` (or `TYPE`
first) instead of `GET`, preventing a recurring false alarm. This is a one-line doc fix,
not "None."

### Files changed

| File | Action |
|------|--------|
| `.github/skills/evaluate-agent/SKILL.md` (or the runbook that emitted the `GET`) | Use `TYPE`/`HGETALL` for `agent:memory:*` |

---

## Item 5 [DONE] — Write `agent_scan_metrics` for **every** scan

### Problem

`agent_scan_metrics` ([agent-scan-metrics.ts](packages/db/src/schema/agent-scan-metrics.ts))
is never written. Zero rows for any agent. Without it we cannot distinguish "scanner ran
and found nothing" from "scanner never ran" — precisely the swing/range mystery (Item 6).

### Fix

Add an `onPersistScanMetrics` callback to the actor deps and invoke it after **every**
`completeTechnicalScan` — including `overlap_skipped`, `no_candidates`, and
`data_path_failure` outcomes, so silence is always distinguishable from absence.

Row shape maps directly from `TechnicalPhaseResult` + `deriveScannerHealth()`:

| Column | Source |
|--------|--------|
| `agent_id`, `preset_key`, `preset_behavior_version`, `venue_family`, `style_tier` | unified config metadata / binding |
| `scan_scope` | `{ discovered, symbolsSelected, eligible, fetched, scored, signals }` |
| `scanned_at` | now |
| `candidates_discovered` / `candidates_scored` / `signals_generated` | `phaseResult.*` |
| `scan_health` | `deriveScannerHealth().status` |
| `top_confidence` | max scored confidence, else null |
| `regime_bucket` | `phaseResult.regimeResult?.regimeBucket ?? null` |

### Schema reconciliation (correcting `001`'s "no changes" claim)

`001` said "verify schema matches — no changes expected." It does **not** match:
`scan_health` is documented as `healthy | degraded | no_signal | stale`, but
`deriveScannerHealth()` returns `healthy_signals | healthy_no_signal | data_path_failure |
no_candidates | overlap_skipped` ([complete-technical-scan.ts#L104-L133](apps/worker/src/complete-technical-scan.ts#L104)).
The column is free-text so inserts won't fail, but the documented enum is stale. Update the
schema comment to the actual value set so future readers/filters are correct.

### Honest scope note

Item 5 is **observational** — it makes swing/range's silence visible; it does not by itself
make them trade. It is the diagnostic feeder for Item 6.

### Files changed

| File | Action |
|------|--------|
| [agent-trading-actor.ts](apps/worker/src/agent-trading-actor.ts) | Add `onPersistScanMetrics`; call after every scan |
| [index.ts](apps/worker/src/index.ts) | Wire callback → insert into `agent_scan_metrics` |
| [agent-scan-metrics.ts](packages/db/src/schema/agent-scan-metrics.ts) | Correct stale `scan_health` doc comment |

---

## Item 6 [DONE] — Investigate why the scanner runs **only for mo-day** (report §2, §7 MEDIUM)

> This is the report's **headline finding** (`swing` and `range` produce zero candidates,
> zero decisions, zero fills). `001` deferred it outright. This plan does not fix it blind —
> it adds a **time-boxed investigation** that Item 5's new metrics make cheap.

### Investigation steps

1. Confirm all three agents actually schedule `runTechnicalScan` (worker logs showed only
   `agent-actor-ce7f3bb2`). Check the actor registration / scan-loop scheduling in
   [agent-trading-actor.ts](apps/worker/src/agent-trading-actor.ts) and its composition in
   [index.ts](apps/worker/src/index.ts).
2. With Item 5 live, read `agent_scan_metrics` for swing/range to classify: are scans
   *running but* `no_candidates` / `data_path_failure`, or *not running at all*?
3. If running-but-empty: inspect their candle-interval support (report hypothesizes `4H`
   swing / range intervals have thin or unsupported Hyperliquid data vs mo-day's `15m`) and
   their discovery filter criteria.
4. If not running: look for a scheduling/single-flight bug where mo-day's scan starves the
   others.

### Deliverable

A findings note appended here (or a follow-up plan) identifying root cause. Only then decide
the fix. Do **not** implement a speculative fix before the metrics land.

### Files touched

Investigation only (reads + Item 5 data). No code change in this item.

---

## Item 7 [PENDING] — Verify / restore watch evaluation (report §4.2.A MEDIUM — safety)

> The report calls stale watches *"a significant anomaly — stop-loss and take-profit monitors
> are not functional."* `001` deferred it. Non-functional protective exits is a safety issue
> and warrants at least confirmation.

### Investigation + fix steps

1. Locate the watch-evaluation loop (it is **not** in
   [agent-trading-actor.ts](apps/worker/src/agent-trading-actor.ts) — a grep for
   `watch`/`lastCheckedAt` there returns nothing). Find where `agent:watches:*` are read and
   `lastCheckedAt` is written.
2. Reproduce the stale-`lastCheckedAt` symptom (report: 11–24h stale) and determine whether
   the loop is not scheduled, throwing and not rescheduling (violating the AGENTS.md
   "every async loop reschedules on failure" rule), or gated off for scanner-gated agents.
3. Fix the smallest root cause; ensure the loop reschedules in `finally`.

### Deliverable

Either a confirmed fix (with a test asserting `lastCheckedAt` advances each tick) or a
findings note if the root cause is larger than a quick fix, promoted to its own plan.

### Files touched

TBD by investigation; expect the watch-evaluation module + a regression test.

---

## Explicitly out of scope (with rationale)

| Deferred | Rationale |
|----------|-----------|
| Reducing `scanIntervalMs` | Config/tuning decision; may be the right call but belongs with Item 7's rate-pressure findings, not a blind edit. Item 3 reduces the pressure first. |
| Increasing `maxOpenPositions` | LOW severity; agent-mutable operator default per AGENTS.md risk-gate rules — a tuning decision, not a bug. |
| Increasing Hyperliquid rate-limit budget | Addressed indirectly by Item 3; a budget raise is an operator decision requiring venue-limit headroom analysis. |

---

## Execution order

1. **Item 1** — trivial, no deps; ship first.
2. **Item 5** — observability; unblocks Item 6. Ship early.
3. **Item 6** — investigate using Item 5 data (no code until root cause known).
4. **Item 2** — largest; migration → shared repo → wire hybrid → update writers **and readers**.
5. **Item 3** — retry + breaker; independent of Item 1 (both touch scan determinism but do not depend on each other).
6. **Item 7** — investigate watches; promote to its own plan if the fix is large.
7. **Item 4** — one-line runbook doc fix; any time.

## Definition of done

- `pnpm lint` and `pnpm test` pass (AGENTS.md gate).
- Drizzle migration generated and applied for Item 2.
- New/changed behaviour covered by tests whose names describe behaviour
  (e.g. *"ranks higher-reason-count signal first on confidence tie"*,
  *"writes a scan-metric row even when overlap-skipped"*).
- No hard-coded magic numbers — all backoff/retry values come from operator config
  (AGENTS.md configuration rule).
- Items 6 and 7 end with either a fix or a written findings note — never silent deferral.
