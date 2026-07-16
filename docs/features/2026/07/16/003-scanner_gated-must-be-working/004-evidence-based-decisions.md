# Evidence-Based Scanner-Gated Decisions

**Date:** 2026-07-16  
**Status:** Decision record. No application-code, deployment, or staging mutation was made by this work.

## New Staging Evidence

The staging capture in [`003-staging-read-only-diagnostic.md`](003-staging-read-only-diagnostic.md) proves the currently active failure:

- All seven active `scanner_gated` agents have `technical.scanBatchSize = NULL` and `technical.scanIntervalMs = NULL`.
- Each agent discovers 232 candidates, scores zero, creates zero signals, and logs no error because the candle-fetch loop never enters.
- Each agent scans repeatedly within a second, driving worker CPU to 62.53% and producing 220,789 lines in 90 minutes.
- No `agent.technical.scan_completed` or scanner `agent.wake` messages exist, so the agent-side hybrid evaluator has nothing to consume.
- Binance is reachable from the staging worker for `SOLUSDT` klines. It is not implicated in the *current* staging failure because the broken batch loop issues no candle requests.

## Correction to the Diagnostic's Deployment Conclusion

The statement that staging does not contain commits `094b7da2` / `ed02323d` is false.

Local Git ancestry and direct source inspection establish that both commits are ancestors of staging HEAD `913f4ae0`:

```text
094b7da2 (getUnifiedConfig read defaults) -> ... -> ed02323d (API persists defaults) -> 913f4ae0
```

The deployed source at `913f4ae0` contains:

1. `applyConfigDefaults()` in `AgentRepository.getUnifiedConfig()`.
2. API create/PATCH parsing through `TechnicalConfigSchema` before persistence.
3. The still-broken actor factory that uses `getAgent()` and casts raw `agent.unifiedConfig.technical`.

Therefore deploying or cherry-picking the earlier defaulting commits again would not repair the seven existing rows and is not an immediate remedy.

## Decisions

### D1: Quarantine the current scanner storm now

Stop the seven affected scanner-gated agents. They cannot produce signals or trades in their current state; leaving them active only consumes worker/Redis CPU and emits expensive log noise.

Do not delete their connections as part of the emergency action. A stopped agent preserves its connection grants, making controlled replacement possible.

### D2: Do not repair old rows through read-time compatibility or a defaults backfill

Backward compatibility is not required. Do not extend `getUnifiedConfig()` as a recovery path and do not write a migration that silently fills fields in existing JSONB.

The product implementation must instead enforce this invariant:

```text
Every persisted hybrid technical config is a complete TechnicalConfig.
Every actor validates persisted config before it can start a scan timer.
```

An incomplete or invalid hybrid row must fail actor startup as `scanner.config_invalid`. It must never run with `undefined` arithmetic or interval values.

### D3: Replace, do not patch, malformed staging agents after the product fix

After the strict write/runtime validation change is deployed, create replacement scanner-gated agents from the intended current presets and settings. Validate each replacement before stopping and deleting its predecessor.

Create the replacement before deleting the old agent. Agent deletion can revoke a connection when no other agent holds a grant; overlapping the grants avoids accidental loss of the active Hyperliquid connection.

Do not start all replacements immediately. Start one bounded test agent first.

### D4: Candidate scope and scan concurrency are release blockers, not optional hardening

The current implementation discovers approximately 232 Hyperliquid assets per agent and asks Binance spot for one candle series per asset. With seven agents on a 60-second cadence this is approximately 1,624 candle requests/minute before retries, while the shared Binance budget is 200 requests/minute.

Even if all the assets had matching Binance symbols, the current configuration cannot complete reliably. Many Hyperliquid perpetuals also have no matching Binance spot pair. A fixed 60-second timer without single-flight protection can start overlapping scans once requests queue.

Before starting any replacement agent beyond the bounded test agent, implement:

1. An explicit, persisted candidate scope/ranking policy with a low bounded candidate count.
2. Provider eligibility handling so unsupported symbols are recorded and skipped before a network call.
3. Per-actor single-flight scanning; a scan that is still running must prevent timer overlap.
4. Structured scan-health metrics separating discovered, eligible, fetched, unsupported, failed, scored, signals, duration, and wake emission.

The eventual candidate limit must be sized against the shared provider budget and concurrent active scanner count. It cannot be justified only as a per-agent constant.

### D5: Separate deterministic product verification from live-provider smoke verification

The current smoke script incorrectly uses `candidatesScored > 0` and implicit live signal generation as the proof that defaults work. Those assertions combine configuration persistence, provider availability, universe eligibility, rate capacity, indicator calculation, and market state.

The release gate must have two layers:

1. **Deterministic integration:** fixture candles produce a known signal; assert scan-completed event, scanner wake, single-shot evaluator routing, and decision intake in order. Use a fake LLM that returns a valid structured decision. This is the proof that scanner-gated routing works.
2. **Live-provider smoke:** use a bounded known-supported symbol set such as `BTC` and `ETH`; assert that the scan completes with fetched/scored candidates, a sane duration, no unexpected provider failures, and no overlap. Zero signals is valid in this layer.

Do not make a staging release contingent on unpredictable live-market signal generation.

## Required Implementation Sequence

1. Stop the currently storming staging agents.
2. Implement strict complete-config persistence and actor-startup validation; remove read-time repair behaviour rather than expanding it.
3. Implement bounded candidate selection, provider eligibility classification, single-flight scans, and structured scan health.
4. Add deterministic scan-to-decision integration coverage and split the existing defaults smoke script into configuration and live-provider checks.
5. Deploy the product changes to staging.
6. Create one bounded scanner-gated test agent using a known-supported symbol set. Confirm two successful non-overlapping scans and inspect its Redis stream and runtime activity.
7. Run the deterministic integration harness against the staging image or an isolated staging test stack.
8. Replace the seven malformed agents progressively, validating each replacement before retiring its predecessor.

## What the Current Staging Evidence Does Not Prove

The staging evidence cannot prove that the existing candle path will succeed after fixing configuration because it never executed a candle fetch during the 90-minute capture. The local smoke failure and the capacity calculation justify treating the scanner design as a release blocker, but the post-fix staging test must record exact fetch statuses and provider eligibility before declaring it operational.