# Plan A8: Stabilization certification gate — "current state pinned"

- **Task:** A8 — the defined test procedure that certifies the current extraction state as stable, and the yardstick for every subsequent Track-C change
- **Repo:** both (procedure runs the existing cross-stack harnesses)
- **Status:** PLAN — **implementer-ready (2026-09-18).** The gate is *run* after Track A items (A1–A6) land; running it today is also a valid pre-A1 baseline.
- **Decision-gated:** No.

## For the implementer (no prior context needed)

- **Repos:** both. This gate composes EXISTING harnesses — build no new test infrastructure; at most add small assertions/checklist entries where a blind spot is found.
- Focused commits are allowed for completed work and any harness-only blind-spot assertion. Do not merge herobids into `main` yet.
- **The gate certifies; it does not repair.** Any product-code failure files a bug report (or attaches to the owning A1–A6 plan) rather than being fixed ad-hoc mid-gate.
- "Pinned" = **two consecutive clean gate runs** (fresh `down -v && up` between them). Record date, commits under test, both runs' evidence paths, and deviations.
- Run unit tiers from a clean shell (`env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY …`) or leaked env breaks the unit tier. Migrations run via the compose `migrate` service, never `pnpm migrate`.

## Context

You framed the goal as "pin down the current state (test it till it is stable) before moving forward." This plan defines what "pinned" means operationally, so stability is a checkable claim rather than a feeling. It composes existing harnesses — no new test infrastructure is built; at most small assertions are added where the gate finds a blind spot.

## Definition of "current state pinned"

All of the following pass, on a clean-slate cross-stack run, twice consecutively (same procedure, fresh `down -v && up` between runs — catches order/state dependence):

1. **Build & static:** both repos: per-package `tsc --noEmit -p packages/<pkg>` (NOT root lint — build-cache blind spot) + `pnpm lint` + full unit suites green.
2. **Cross-stack bring-up:** `herobids/scripts/shell/run/reset-and-run-xstack.sh` from `herobids/` — both stacks healthy, boundary `/health/ready` ok, provisioning verifies trading connections.
3. **Live trade path (the 09-17 fix certified end-to-end, plus A-track regressions):**
   - agent first tick (force-escalated) reaches the boundary; boundary log shows `agent-direct actor constructed + started` with the correct mode (A4) and capital (phase 3);
   - `submit_decision` × ≥2 → traderton `decisions` rows persisted, **shadow fills + open positions + journal_events > 0** (the pre-fix state was all-zero — this is the headline regression check);
   - risk-gate rejections (if any trigger) carry real equity math (limit ≠ $0.00).
4. **New A-track regression checks (added as the items land):**
   - A1/A2: after a simulated actor deregistration (in-container manual step during the gate), the next decision **recovers** (reconstructs) instead of failing `instance_not_running` forever; concurrent same-tick decisions produce exactly one actor rebuild.
   - A3 (Option X — decided): `get_risk_limits` over the boundary returns real limits; `get_account_summary.capital` populated; **`adjust_risk_limits` fails CLOSED with a typed precondition** (not a silent pass, not an in-process write) — assert BOTH the reads-work and the adjust-fails-closed halves so the fail-closed write cannot regress unnoticed before B1. Note: the read surface may be the 5-field contract only until the B1 profile store lands (`getProfile` optional) — expected, not a bug.
   - A4: constructed-actor log `mode:` reflects the wired default, not `paper`.
   - A5/A6: watch/resolver tools behave boundary-first; boundary-down fault-injection yields typed fail-closed errors (manual step).
5. **Read-surface parity sweep:** every boundary tool herobids invokes (the audit §4.1 inventory — ~40 tools) is invoked at least once during the gate (extend the eval script's tool checklist if gaps) — catches Zod-strip and context-gap class bugs (bug-001's whole family) before users do.
6. **Agent evaluation run:** the standard eval loop over the trading agents (as used for the 09-17 session), checking the report for: zero `precondition.not_ready` on submit_decision, no `*_unavailable` regressions beyond the documented set, sane LLM behaviour (messaging, watches).

## Procedure (the "gate run")

1. `git status` both repos — must be clean or contain only the changes under test.
2. Static tier (item 1) in a clean shell (`env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY` — repo memory: leaked env breaks the unit tier).
3. `reset-and-run-xstack.sh --down` then full up (from `herobids/`).
4. Quick-setup + create trading agents; start one trading agent; run through ≥2 natural ticks.
5. Execute items 3–5 (DB assertions via psql into both stacks; the manual fault-injection steps A1/A4 in-item).
6. Run the eval loop; archive the report under `.ignore/eval/<date>/` and link it from this plan when the gate passes.
7. Tear down with `--down`; repeat once from step 3 (the two-consecutive-runs rule).
8. Record the outcome: date, commits under test, both runs' evidence paths, deviations. **Pinned = both runs green.**

## Blind-spot fixes allowed during the gate

The gate may add *assertions/checklist entries* (small test code, harness flags) where it discovers a blind spot — but any **product-code** failure it finds files a bug report (or attaches to A1–A6 plans) rather than being fixed ad-hoc mid-gate. The gate certifies; it does not repair.

## Relation to existing harnesses

- `scripts/shell/tests/run-all-tests.sh --e2e` (clean shell, per repo memory) remains the broader tier gate — A8 *includes* its relevant tiers for the trading surface rather than duplicating them: run it before the cross-stack leg when convenient.
- The agent eval skill flow (`evaluate-agent`) is the report generator for item 6.

## Acceptance

- Two consecutive clean gate runs recorded above → Track A closed, "current state pinned" declared in the roadmap, Track B chat sessions may open.
- Any red item → the finding goes to its owning plan (A1–A6) or a new dated bug report; the gate re-runs after the fix.

## References

- `herobids/scripts/shell/run/reset-and-run-xstack.sh`; `scripts/shell/tests/run-all-tests.sh`
- Repo memory: test-tier env pitfalls; bug-reports/2026/09/17 #001 (the live-verification procedure items 3-4 derive from)
- Audit §4.1 boundary-tool inventory (item 5's checklist)
