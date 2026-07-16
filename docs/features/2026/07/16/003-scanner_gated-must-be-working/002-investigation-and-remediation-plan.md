# Scanner-Gated Investigation and Remediation Plan

**Date:** 2026-07-16  
**Status:** Investigation complete. No application-code change made by this work.  
**Scope:** `scanner_gated` hybrid agents from persisted config through scanner, wake delivery, hybrid evaluation, and decision submission.

## Expected Flow

```text
agent unified_config
  -> resolved TechnicalConfig
  -> AgentTradingActor scan loop
  -> candidate discovery + candle retrieval + scoring
  -> agent.technical.scan_completed
  -> agent.wake(source=scanner)
  -> agent container records scan and wake
  -> single-shot hybrid evaluator
  -> submit_decision
```

## Confirmed Findings

### 1. Existing scanner-gated agents can still receive unresolved config

`AgentRepository.getUnifiedConfig()` applies capability and Zod technical defaults, but the worker creates `AgentTradingActor` from the raw row returned by `getAgent()`.

- [`packages/db/src/agent-repository.ts`](../../../../../../packages/db/src/agent-repository.ts) applies `applyConfigDefaults()` only in `getUnifiedConfig()`.
- [`apps/worker/src/index.ts`](../../../../../../apps/worker/src/index.ts) loads the actor's `technicalConfig` and `isHybridMode` from `agent?.unifiedConfig` returned by `getAgent()`.
- [`apps/worker/src/agent-trading-actor.ts`](../../../../../../apps/worker/src/agent-trading-actor.ts) uses `technicalConfig.scanIntervalMs` for `setInterval()` and `technicalConfig.scanBatchSize` for arithmetic in the scanner.

Therefore a persisted row that omits `scanBatchSize` reaches the scanner as `undefined`. The batch loop advances with `i += undefined`, becomes `NaN`, and never fetches candles. An omitted `scanIntervalMs` creates an effectively immediate timer. This independently confirms the code path described in the deployment report.

The later API write-path change now persists a parsed `TechnicalConfig` for newly created or patched agents. The runtime must enforce that invariant strictly; backward compatibility for incomplete stored rows is not required.

### 2. The local smoke failure is a real candle-fetch failure, not merely bad log parsing

The local run in `001-agent-config-defaults-smoke-test.log` created agents whose JSONB config already contained `scanBatchSize` and `scanIntervalMs`. Worker logs from that run show repeated:

```text
Technical phase: candle fetch failed - skipping symbol
```

for ordinary assets including `SOL`, `BNB`, and `ETH`, as well as many less-common Hyperliquid assets. Consequently no candidate had candles and `candidatesScored` stayed zero.

A direct `SOLUSDT` klines request from the same worker container succeeded later with HTTP 200. That rules out a permanent worker-to-Binance connectivity failure and a basic `SOL` symbol-mapping failure. The exact HTTP status from the failing scan was not retained by the current log extraction, so the immediate cause of each rejected request remains unproven.

### 3. Candidate selection and candle-provider capacity are incompatible

The current discovery function obtains the complete Hyperliquid asset-context universe and only applies optional user filters. For the affected scan it discovers about 232 assets.

Every orderbook candidate is then sent to `VenueCandleFetcher`, which fetches Binance **spot** candles by appending/mapping to `USDT`. This introduces two independent failure modes:

1. A Hyperliquid perpetual may not have a Binance spot pair.
2. A scan performs one HTTP request per candidate. Multiple simultaneous agents turn roughly 232 candidates per agent into hundreds of requests per scan.

The shared Binance budget is 200 requests/minute. Requests beyond its initial burst must queue; an individual request is rejected once its wait exceeds 30 seconds. `runTechnicalScan()` also has no single-flight guard, so the next `setInterval()` invocation can overlap a scan still waiting on the shared budget. This makes backlog, request rejection, and repeated scans increasingly likely as agent count grows.

This finding is the most likely explanation for the new-agent local smoke result, but the exact failure distribution must be measured before choosing a provider fallback policy.

### 4. The scan-to-agent message contract itself is coherent

The actor publishes `agent.technical.scan_completed` before `agent.wake` with `source: 'scanner'`. The agent runtime accepts the scan, records it as `lastTechnicalScan`, accepts the scanner wake, and routes a scanner-gated trading turn through the single-shot evaluator. Existing unit tests cover the payload schema and routing logic.

No code-level contract mismatch was found in this handoff. This remains a verification target because a healthy contract cannot compensate for zero scored candidates.

## Problems Preventing Correct Operation

| Priority | Problem | Affected agents | Consequence |
|---|---|---|---|
| Critical | Worker actor construction trusts an unvalidated raw config object. | Any hybrid row missing required resolved scan fields. | No candle loop body, timer storm, no scanner wake. |
| Critical | Scanner has zero usable candles in the local smoke run. | New and existing orderbook scanner agents. | `candidatesScored = 0`; no entry signal or exit advisory can wake the agent. |
| High | Hyperliquid candidate universe is sent to Binance spot without eligibility filtering, bounded scope, or overlap prevention. | Any multi-agent scanner deployment. | Unsupported symbols and rate-budget exhaustion make scans unreliable. |
| High | Failures degrade silently into a successful-looking zero-signal scan. | Operators and smoke tests. | The agent waits correctly for a wake that will never exist; no clear unhealthy state or alert identifies the data-path failure. |

## Remediation Plan

### Phase 1: Establish one resolved runtime config boundary

1. Make the API write path the sole configuration-resolution boundary: persist a complete `UnifiedAgentConfig` with all `TechnicalConfig` defaults applied, never a partial technical object.
2. At actor construction, parse the persisted unified config once and derive both `technicalConfig` and `capabilityMode` / `hybridMode` from that same validated object. Do not cast raw JSONB to `TechnicalConfig`.
3. Delete read-time defaulting/migration compatibility code once all writers persist complete config. The runtime must not repair incomplete config silently.
4. If a hybrid row is invalid or incomplete, fail actor startup with a clear `scanner.config_invalid` health/journal event. Do not start a timer, fall back to partial config, or continue as a healthy agent.
5. Recreate scanner-gated staging agents after deployment rather than backfilling or preserving old rows.

Do not solve this by duplicating defaults at the scanner call site. Persisted configuration must already be complete, and runtime validation must fail closed when it is not.

### Phase 2: Make the candle path venue-aware and bounded

1. Define a candle-provider policy for Hyperliquid orderbook agents. The preferred source is a Hyperliquid-compatible candle endpoint; Binance spot can be an explicit fallback only for symbols verified to be supported.
2. Convert candidate discovery from "all assets" to a bounded, deterministic candidate set. Apply explicit symbol filters first, then a configured liquidity/volume ranking and a maximum candidate count. The limit belongs in typed technical/config policy, not as a new magic number in the worker.
3. Track provider eligibility before dispatching a candle fetch. Unsupported symbols must be counted as `unsupported`, not treated as indistinguishable HTTP errors.
4. Make scan execution single-flight per actor. If a prior scan is still in progress, skip or coalesce the next tick and record the reason. Do not allow timer overlap to multiply a saturated request queue.
5. Preserve shared rate limiting, but size the bounded candidate universe and scan interval against the provider budget. Instrument queued time, rejected requests, HTTP statuses, and scan duration.

### Phase 3: Fail visibly when a scanner cannot evaluate its universe

1. Extend the technical scan result with at least: discovered, eligible, fetched, unsupported, fetch failures by class/status, scored, signals, duration, and whether a wake was emitted.
2. Treat `discovered > 0 && fetched === 0` as a scanner-data failure, not as a normal zero-signal outcome. Publish a health/journal event and alert through the existing operational path with rate limiting.
3. Keep a genuine zero-signal scan healthy: `fetched > 0`, `scored > 0`, and `signalsGenerated === 0` is a valid market result and must not wake a scanner-gated agent.

## Verification Strategy

### A. Deterministic automated tests

Add or extend tests before implementation for these cases:

1. **Persisted config completeness:** API create and PATCH persist all technical defaults; actor construction receives a fully populated config.
2. **Invalid config safety:** an invalid hybrid technical block fails actor startup with `scanner.config_invalid`; it cannot create an undefined timer or a `NaN` batch increment.
3. **Provider selection:** known supported Hyperliquid symbols use the selected provider; unsupported assets are reported as unsupported without a request.
4. **Budget behaviour:** a candidate universe larger than the permitted scan scope is bounded; scans do not overlap while a prior scan is in flight.
5. **Technical phase outcomes:** fixture candles produce both a deterministic signal and a valid no-signal result. Fetch failure and all-candles-unavailable paths produce distinct health results.
6. **Full in-process message flow:** fixture signal -> scan-completed event -> scanner wake -> `lastTechnicalScan` -> hybrid evaluator -> submitted decision. Assert event order and payloads, not log strings.
7. **Scanner-gated constraints:** non-scanner market wakes remain suppressed; reminders and user messages remain functional; exit-only advisory emits a scanner wake with `signalCount: 0`.

### B. Upgrade `agent-config-defaults-smoke-test`

Keep it for config persistence and rename or split it because it currently attempts to prove several unrelated properties. It should not use live signal occurrence as its pass condition.

1. Retain the create/PATCH/default matrix, but assert that persisted JSONB is complete and that a runtime actor accepts it without a compatibility/defaulting path.
2. Constrain live smoke candidates to known provider-supported assets such as `BTC` and `ETH`.
3. Assert scanner completion with `eligible > 0`, `fetched > 0`, `scored > 0`, zero unexpected fetch failures, and a sane scan duration/interval.
4. Treat `signalsGenerated === 0` as valid for the live smoke. Market conditions must not determine release health.
5. Move the deterministic signal -> wake -> evaluator -> decision assertion into an integration test with fixture candles and a fake LLM/provider. That test is the release gate for scanner-gated behaviour.
6. Add a separate negative smoke scenario that deliberately uses an unsupported symbol and asserts a clear scanner-data failure without timer churn or LLM wake.

### C. Staging release gate

1. Deploy the strict persisted-config and candle-path changes to staging.
2. Delete and recreate the scanner-gated staging agents, then restart the worker. Do not run a defaults backfill or retain incomplete hybrid rows.
3. Before starting a test agent, query its persisted scan fields and verify `scanBatchSize`, `scanIntervalMs`, `candles`, and `filters` are present and valid.
4. Run the bounded real-provider smoke agent for at least two completed scans. Check the structured scan metrics, Redis stream events, agent runtime activity, and decision-intake result.
5. Run the deterministic scanner-gated integration harness against the staging image or an isolated staging test stack. Verify the exact event chain through accepted/rejected decision handling.
6. Confirm non-scanner wakes do not produce a trading LLM tick for the test agent.
7. Monitor worker CPU, Redis CPU, technical scan duration, provider rejection rate, concurrent scans, and log volume for at least three scan intervals with multiple agents.
8. Only promote after all release gates pass. A dashboard/log line showing zero signals alone is insufficient evidence either way.

## Staging Access Limitation During This Investigation

The prescribed Hetzner helper could not resolve staging in this environment because the local Terraform state has no `staging` workspace and no staging SSH key is configured. DNS resolution for `staging.openaidom.com` also timed out. No remote mutation was attempted.

The conclusions above are therefore based on checked-out code, the supplied deployment evidence, and a local reproduction of the smoke run. Before implementing Phase 1, rerun the read-only staging diagnostic from an environment with the staging Terraform workspace/key and capture: deployed commit, active hybrid JSONB fields, Redis scanner flags, structured scanner results, stream entries, and agent-container routing logs.