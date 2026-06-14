# DIRECTION FOR PRODUCTION READINESS

## Problem Statement

HeroBids has a functioning trading pipeline that works end-to-end in paper mode for orderbook venues. However, a systematic audit reveals **32 gaps** preventing production deployment:

1. **Risk enforcement is theatre.** The risk gate exists and is wired into the decision pipeline, but the inputs that make it useful — drawdown, daily loss, equity, stop-loss state — are never computed. The system will happily let an agent lose its entire allocation with no circuit breaker.

2. **Swap execution is incomplete.** Shadow mode is blocked for agents (startup crash), live mode has no executor, Jupiter can't sign transactions, and there's no on-chain fill confirmation. Only paper mode works — and only for bots.

3. **Live execution lacks safety infrastructure.** No order timeouts, no idempotent resubmission, no graceful wind-down on crash, and no circuit breaker for consecutive venue errors. A live deployment today would be unmonitorable and unrecoverable.

4. **Configuration allows invalid states that crash at runtime.** The API accepts agent/venue/mode combinations that the worker cannot execute, producing immediate crashes instead of clear rejection at creation time.

---

## Goal

Make HeroBids safe to deploy with real capital on all supported venues (Hyperliquid, Bybit, Jupiter, 1inch) in all execution modes (paper, shadow, live) for both actor types (agent, bot).

**Specifically:**

- Risk limits are enforced with real data (equity, drawdown, daily loss, stop-loss, circuit breaker).
- Swap venues work in shadow and live mode with full fill confirmation and reconciliation.
- Live execution is crash-safe: idempotent, timeout-aware, and self-halting on failure.
- Invalid configurations are rejected at write time, not at runtime.

**Done signal:** An agent can be started on any venue/mode combination without crashes, its risk limits provably fire under adverse conditions, and a live orderbook trade round-trips (submit → fill → position update → reconciliation pass) without data loss across a simulated worker restart.

---

## Constraints

- **Backward compatibility is NOT a concern.** The system is not yet live. There are no production users, no running capital, and no external API consumers. Break any interface, rename any column, delete any migration, restructure any module if it produces a cleaner result. Do not add compatibility shims, deprecation paths, or feature flags to preserve old behaviour.