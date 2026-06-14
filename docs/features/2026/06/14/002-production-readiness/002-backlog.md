# Backlog

**Phase 1 — Risk Foundation (~2.5 weeks)**

Status: completed. The implementation plan in `004-phase-1-risk-foundation.md` is done; all Phase 1 gaps below are now closed.

| # | Gap | Effort | Status | Why here |
|---|---|---|---|---|
| 7 | Drawdown tracking (hardcoded zero) | M | done | Core risk infra |
| 8 | Daily loss never computed | M | done | Same wiring as #7 |
| 17 | No real-time equity tracking | M | done | Required by #7 — can't compute drawdown without equity |
| 18 | No unrealized P&L in risk path | M | done | Same pass as #17 — mark-to-market positions |
| 10 | No automatic stop-loss | L | done | Depends on #17/#18 (needs mark-to-market to detect breach) |
| 9 | Stop-loss cooldown never triggered | M | done | Falls out naturally from #10 — record the exit timestamp |
| 11 | No circuit breaker for venue errors | M | done | Independent but same risk infra area |
| 12 | Paper/shadow fees always zero | S | done | Bolt on at the end — just modify executor fill price/fee |
| 13 | Paper slippage zero | S | done | Same pass as #12 |

---

**Phase 2 — Complete Swap Execution (~2.5 weeks)**

Status: completed for the current shared-wallet product boundary. The implementation plan in `005-phase-2-complete-swap-execution.md` landed the execution path, and `007-phase-2-shared-wallet-semantics-patch-plan.md` is now complete. Execution correctness, shared-wallet observational variance handling, and documentation are aligned. Dedicated/managed-wallet strict reconciliation remains deferred and out of scope for this phase.

| # | Gap | Effort | Status | Why here |
|---|---|---|---|---|
| 3 | Agent shadow swap blocked | M | done | Core swap gap |
| 1 | Live swap executor missing | L | done | Main feature work |
| 2 | Live gate blocks swap | S | done | Trivial removal once #1 done |
| 5 | Jupiter doesn't sign transactions | M | done | Needed for live swap |
| 24 | (Same as #5 — Jupiter signing) | — | done | Duplicate |
| 25 | No private stream for swap venues | L | done | Needed for live swap fill confirmation |
| 19 | Swap position model (fill-projection based for shared wallets) | M | done | Actor-local swap fill projections are kept without claiming wallet-truth accounting |
| 27 | Swap reconciliation skips position drift | M | done | Shared-wallet swap balance variance is now observational rather than synthetic authoritative drift; dedicated-wallet strict reconciliation is deferred |

---

**Phase 3 — Live Execution Safety (~2 weeks)**

| # | Gap | Effort | Status | Why here |
|---|---|---|---|---|
| 4 | Live limit orders rejected | M | todo | Extends LiveExecutor |
| 20 | No order timeout/cancellation | M | todo | Required for live safety |
| 22 | No idempotency for resubmission | M | todo | Required for crash recovery in live |
| 23 | No graceful wind-down on crash | L | todo | Last piece of live safety |
| 21 | No slippage alerting | S | todo | Quick add once live fills flow |

---

**Phase 4 — Config Validation & Operational Polish (~1 week)**

| # | Gap | Effort | Status | Why here |
|---|---|---|---|---|
| 14 | Agent mode vs venue validation | S | todo | Prevents invalid state at API |
| 15 | No agent paper+swap guard | S | todo | Same pass as #14 |
| 16 | Nullable execution_mode | S | todo | Schema cleanup |
| 29 | Export bundle serialisation bug | S | todo | Quick fix |
| 30 | Docker manager misclassifies crash | S | todo | Quick fix |
| 31 | No per-actor health check | M | todo | Observability |
| 32 | No dead-letter for failed decisions | M | todo | Reliability |
| 6 | Fallback resolver uses PaperExecutor | S | todo | Edge case cleanup |
| 26 | Bybit public stream | S | todo | Low priority, documented |
| 28 | No reconciliation for agent paper | S | todo | No real risk |