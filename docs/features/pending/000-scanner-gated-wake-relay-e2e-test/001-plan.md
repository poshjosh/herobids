# Plan: scanner-gated wake-relay end-to-end shell test

- **Goal:** a `scripts/shell/tests/` script that proves the E1H-E3H wake/lifecycle
  pipeline works against a live stack — not just that a scanner_gated agent's
  worker session reaches `running` (already covered by
  `agent-scanner-gated-lifecycle-test.sh`), but that:
  1. herobids sends `scanMode`/`creatorStrategy` to traderton on create (Part A),
  2. traderton's actor reaches `running` (`agent_actor_runs.desired_state`) (Part L),
  3. a real scanner wake lands in traderton's `consumer_notifications` outbox and
     is republished by the herobids relay onto `agent:outbound:{agentId}` with
     `payload.source === 'scanner'` (Part B),
  4. the agent process actually dispatches the LLM off that wake instead of
     logging `timer tick without wake signal — skipping LLM dispatch` (Part R),
  5. stop/delete flips the traderton actor back to `stopped` (Part L).
- **Why now:** this is the only layer of the E1H-E3H plan with zero shell/E2E
  coverage today. Manual verification against the live `thyper` agent
  (2026-10-06) confirmed the pipeline works, but that was ad hoc, not a
  reusable regression test. The automated Vitest gates (Parts T/A/L/R/B/C in
  `docs/features/2026/09/18/001-trading-extraction-completion/plans/E1H-E3H-agent-wake-and-lifecycle-restore.md`)
  cover unit/integration behaviour with fakes; nothing exercises the real
  cross-stack wiring (herobids worker ↔ relay ↔ Redis ↔ traderton actor ↔
  traderton DB) the way `scripts/shell/tests/` does for other features.
- **Effort estimate:** **M** (half-to-one day). Rationale: new TS script
  (~300 lines) touching two Postgres databases and Redis, a real scan-interval
  wait (asynchronous, market-dependent timing), new wiring into
  `run-extra-tests.sh`, and debugging against the live xstack rather than
  mocks. Larger than the XS/S bar for "do it now."

---

## Scope

In scope:
- One new TS script `scripts/ts/agent-scanner-gated-wake-relay-test.ts` + shell
  wrapper `scripts/shell/tests/agent-scanner-gated-wake-relay-test.sh`, modelled
  on `agent-scanner-gated-lifecycle-test.sh`'s structure (auth, create, poll,
  cleanup) but extended to query traderton's DB and Redis.
- Wiring into `run-extra-tests.sh` as a new Tier-5 case (it needs the traderton
  boundary + a real venue connection + a real scan cycle, same bucket as
  `agent-trade-test.sh`).
- Assertions on: `agent_trading_profiles` (traderton), `agent_actor_runs`
  (traderton), `consumer_notifications` (traderton), `agent:outbound:{agentId}`
  (herobids Redis), and the agent container's log line distinguishing
  `routing to single-shot evaluator (scanner wake)` from the suppressed-tick
  log line.

Out of scope (explicitly, carried from the parent plan's follow-ups):
- D10 missed-stop reconciliation.
- Preset identity on swap venues (D3).
- The "full cross-stack CI leg" follow-up already recorded in the parent
  plan (Part C's integration test fakes the traderton side; this new script
  is the real cross-stack leg, but it stays a manual/opt-in Tier-5 shell test,
  not a CI-blocking unit test — matches how `agent-trade-test.sh` is treated).
- Relay failure-path testing (lease loss, cursor replay, malformed rows) —
  already covered by `actor-event-relay.test.ts` with fakes; not worth
  reproducing against a live stack.

---

## Design

### Script shape (mirrors `agent-scanner-gated-lifecycle-test.ts`)

1. **Setup**: authenticate (reuse `authenticate()` pattern), get/create an
   active Hyperliquid connection.
2. **Create** a `hybrid` + `scanner_gated` agent with `strategyPreset:
   'momentum'`, a real connection, `executionDefaults: { mode: 'paper' }`.
3. **Assert traderton profile** (new): query
   `traderton_xstack-postgres-1` for
   `SELECT scan_mode, creator_strategy IS NOT NULL, active_strategy IS NOT NULL
   FROM agent_trading_profiles WHERE actor_id = '<agentId>'` — expect
   `scan_mode = 'scanner_gated'`, both strategy columns non-null. This is the
   Part-A assertion the existing lifecycle test never makes.
4. **Start** the agent (`POST /agents/:id/start`), poll `GET /agents/:id`
   until the worker session is `running` (reuse existing poll loop).
5. **Assert traderton actor running** (new): query
   `agent_actor_runs.desired_state = 'running'` for the actor id, polling up to
   ~30s (the API's post-commit hook / worker's `onSessionActive` call is
   fire-and-forget, D5).
6. **Wait for a real scanner wake** (new, the expensive step): poll
   `consumer_notifications WHERE type = 'agent_wake' AND agent_id = '<id>'`
   up to a bounded deadline (default 180s, configurable via env — a scan
   interval is typically 60s per the plan's live-check step V2.3, so 3
   intervals gives headroom without being unbounded). If none appears,
   **do not fail** — record a `SKIP` for this assertion exactly like
   `agent-trade-test.sh` treats a no-trade window as best-effort, since wake
   emission depends on the scanner producing a signal (market-dependent).
7. **Assert relay republish** (new, only if step 6 found a wake): `XRANGE
   agent:outbound:{agentId}` on herobids Redis, find an entry with
   `type: 'agent.wake'` and `createdAt >=` the notification's `createdAt`;
   assert `JSON.parse(entry.envelope).payload.source === 'scanner'`.
8. **Assert agent dispatch** (new, only if step 7 passed): `docker logs
   herobids-agent-<id>` (bounded tail, since the container start) contains
   `routing to single-shot evaluator (scanner wake)` and does NOT contain
   `suppressing non-scanner wake` for an event at/after the wake's
   `requestedAt`. Best-effort / informational if the log format changes —
   treat a missing match as a soft warning, not a hard fail, documented
   in a comment (log-scraping is inherently brittle; this is a smoke check,
   not the source of truth — the DB/Redis assertions in steps 3/5/7 are).
9. **Stop + delete** (reuse `deleteAgent`), then **assert traderton actor
   stopped** (new): poll `agent_actor_runs.desired_state = 'stopped'` up to
   ~30s (health-monitor interval, D6/L1).
10. **Cleanup**: nothing persistent created outside the test agent itself
    (no relay cursor/lease keys touched — this test observes the real relay,
    doesn't run its own).
11. **Report**: same `record()`/`results[]` pass/fail/skip summary pattern as
    the existing lifecycle test; exit non-zero only on a hard-fail assertion
    (steps 3, 4, 5, 9), never on the best-effort wake/relay/log steps (6-8)
    unless `REQUIRE_WAKE=1` is set (mirrors `agent-trade-test.sh`'s
    `REQUIRE_TRADE=1` convention).

### New helpers needed

- `tradertonDbQuery(sql)`: same shape as the existing `dbQuery()` but targets
  `traderton_xstack-postgres-1` via `docker compose -p traderton_xstack exec -T
  postgres psql -U traderton -d traderton -c "..."`. Project name and
  container name confirmed live: `traderton_xstack-postgres-1`.
- `redisXRange(stream, sinceMs)`: shell out to `docker exec herobids-redis-1
  redis-cli XRANGE <stream> <sinceMs>-0 +` and parse the flat reply into
  envelope objects (reuse the inspection approach used manually in this
  session).
- `pollUntil(fn, deadlineMs, intervalMs)`: generic poll helper — several steps
  (3, 5, 6, 9) repeat the same wait-and-recheck shape currently copy-pasted
  per scenario in the existing script; worth factoring once since this script
  needs it four times (existing script only needed it once).

### Config / env

No new env vars for the running stack itself. Script-local tunables (with
sane defaults, overridable via env for local iteration):
- `WAKE_WAIT_TIMEOUT_MS` (default 180000)
- `ACTOR_STATE_TIMEOUT_MS` (default 30000)
- `REQUIRE_WAKE` (default unset → best-effort)

No `.env*.example` changes — nothing here is an operator-facing input.

### Wiring into `run-extra-tests.sh`

Add under Tier 5 (full stack + venue credentials), after `agent-trade-test.sh`
and before `bot-trade-test.sh` (keeps the single-agent, non-burst-start test
first, consistent with the existing comment about burst-start latency, bug
2026-09-05/001):

```bash
run_script "agent-scanner-gated-wake-relay (traderton actor + relay + scanner wake, best-effort)" \
  "${TESTS_DIR}/agent-scanner-gated-wake-relay-test.sh"
```

Update the Tier-5 dry-run plan listing and the file's header comment
accordingly. Does not need the `RUN_UNSTABLE_LLM_LATENCY_TESTS` gate — it
creates exactly one agent (not a burst), same as `agent-trade-test.sh`.

---

## Risks / open questions

1. **Timing flakiness.** Scan interval is config-driven (`scanIntervalMs`,
   observed 60000ms live); waiting for an actual signal-producing scan is
   market-dependent (regime filters can suppress signals indefinitely in a
   choppy market — observed live: `"choppy":true` yet still passed). Mitigated
   by making the wake-wait step best-effort/SKIP rather than FAIL, matching
   the existing `agent-trade-test.sh` convention for market-dependent outcomes.
2. **Cross-repo coupling.** The script hard-codes traderton's table/column
   names (`agent_trading_profiles`, `agent_actor_runs`, `consumer_notifications`).
   If traderton's schema changes, this test silently breaks without a herobids
   PR touching it. Document the coupling in the script header (same spirit as
   the parent plan's "Facts (verified)" callouts) so a future schema change is
   more likely to be caught.
3. **Container/compose naming assumptions.** `traderton_xstack-postgres-1`,
   `herobids-redis-1`, `herobids-agent-<id>` are Compose default names, not
   guaranteed — confirm with `docker ps` at script start and fail with a clear
   message if a container isn't found, rather than a cryptic `docker exec`
   error.
4. **Does this belong in CI?** No — like `agent-trade-test.sh`, this needs the
   full xstack + venue credentials + real wall-clock waits. It stays a Tier-5
   opt-in shell test, run manually or in a scheduled/nightly job, not blocking
   normal `pnpm test`/`pnpm lint` gates.

---

## Acceptance criteria

- New script passes against the current live stack (herobids `main` +
  traderton `main`) with `thyper`-equivalent fresh agent, both as a dry run
  (wake-wait skipped) and a full run that observes a real wake within the
  timeout.
- `run-extra-tests.sh --tier 5` runs it and reports PASS/SKIP correctly; a
  forced DB-assertion failure (e.g. temporarily rename a column) is caught as
  FAIL, not silently skipped.
- Script cleans up its test agent on every exit path (success, failure,
  Ctrl-C) — no leaked agents/connections, matching existing test hygiene.
- No changes required to `.env*.example` files (confirms no new operator
  inputs were introduced).
