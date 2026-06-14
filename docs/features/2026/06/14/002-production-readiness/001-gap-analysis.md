## Production-Readiness Gap Matrix — HeroBids Trading System

### Key

| Effort | Meaning |
|--------|---------|
| **S** | Small — ≤ 1 day, isolated change |
| **M** | Medium — 2–5 days, crosses 2+ packages |
| **L** | Large — 1–2 weeks, new subsystem or significant rework |
| **XL** | Extra-large — 2–4 weeks, new infrastructure + tests |

---

### EXECUTION MODES

| # | Gap | Venue | Actor | Mode | Impact | Effort | Notes |
|---|---|---|---|---|---|---|---|
| 1 | **Live swap execution: no executor** | 1inch, Jupiter | Agent + Bot | Live | `LiveExecutor` only accepts `OrderbookVenuePort`. Swap orders (`type: 'swap'`) are unconditionally rejected. No `SwapLiveExecutor` exists. | L | Need: new executor that calls `SwapVenuePort.executeSwap()`, handles async tx confirmation, maps receipt to fills. |
| 2 | **Live gate blocks swap venues** | All swap | Agent + Bot | Live | `live-gate.ts` line 68: `if (input.venueType !== 'orderbook') throw LiveGateError('swap_not_supported')`. This is intentional today but means live swap is dead code even if executor existed. | S | Remove once #1 is done; keep gated by `allowedVenues` list. |
| 3 | **Agent shadow swap blocked at startup** | 1inch, Jupiter | Agent | Shadow | `index.ts:410` throws because `swapAssets` isn't available at agent startup (multi-instrument). The `AgentTradingActor` *has* shadow swap scaffolding but can never reach it. | M | Need: deferred swap adapter construction (on first instrument) or resolve from binding metadata. |
| 4 | **Live limit orders rejected** | All orderbook | Agent + Bot | Live | `LiveExecutor` rejects `planned.type !== 'market'`. Limit orders are marked `rejected`. Phase 4 docs confirm "market orders only". | M | Need: live limit order submission, monitoring for fill/cancel, timeout handling. |
| 5 | **Jupiter `executeSwap` doesn't sign the transaction** | Jupiter | Bot | Shadow/Live | Code comment: "In a real implementation, sign and submit the transaction here." Returns `'pending-signature'` as executionRef. | M | Need: Solana keypair integration, transaction signing, confirmation polling. 1inch is fully implemented. |
| 6 | **Agent intake fallback always uses PaperExecutor** | All | Agent | Shadow/Live | `AgentIntakeResolver` hardcodes `new PaperExecutor(...)` regardless of `agent.execution_mode`. Only relevant when `AgentTradingActor` is NOT running (edge case/race). | S | Low risk — the actor takes over in normal flow. But a race during startup could produce paper fills. |

---

### RISK MANAGEMENT

| # | Gap | Impact | Effort | Notes |
|---|---|---|---|---|
| 7 | **Drawdown tracking is a hardcoded zero** | `decision-intake.ts:237`: `currentDrawdown: price('0')`. The risk gate's `maxDrawdown` check never triggers regardless of losses. Also documented in 000a-blockers-preventing-agents-from-trading-directly.md. | M | Need: track peak equity, compute current drawdown from realized + unrealized P&L, pass to risk gate. Requires equity tracking per actor. |
| 8 | **Daily loss (`dailyLoss`) never computed or passed** | The risk gate has `dailyMaxLossPct` logic but `dailyLoss` is never supplied in `checkRisk()` call. The check is dead code. | M | Need: rolling 24h realized P&L aggregation from fills, pass to risk snapshot. |
| 9 | **Stop-loss cooldown never triggered** | Risk gate checks `lastStopLossExitMs` but nothing in the system ever records when a stop-loss exit happened. No stop-loss logic exists — only the cooldown enforcement. | M | Need: detect forced exits (max drawdown, forced go_flat) and record timestamp per instrument. |
| 10 | **No automatic stop-loss mechanism** | The system has no built-in stop-loss. If an agent/bot goes long and price crashes, only the (currently dead) drawdown gate could stop it — and it's hardcoded to 0. | L | Need: per-position stop-loss monitoring (mark-to-market vs threshold → force go_flat). |
| 11 | **No circuit breaker for consecutive venue errors** | `liveRollout.maxConsecutiveVenueErrors` is defined in config but never consumed by any code. Live actors don't track consecutive errors and don't self-halt. | M | Need: error counter in executor/actor, auto-pause or crash on threshold. |
| 12 | **Paper/shadow fees are always zero** | Both `PaperExecutor` and `ShadowExecutor` emit `fee: quantity('0')`. P&L calculations overstate returns. Production shadow should simulate realistic costs. | S | Best-practices doc says "Paper/shadow modes must simulate realistic costs (slippage + fees)". |
| 13 | **Paper mode has zero slippage** | Paper fills at exact mark price. No bid-ask spread simulation. Shadow at least uses bid/ask from ticker. | S | Minor for paper, but misleading if used for P&L projection. |

---

### CONFIGURATION VALIDATION

| # | Gap | Impact | Effort | Notes |
|---|---|---|---|---|
| 14 | **No agent execution_mode vs venue validation at creation** | This is the crash you just hit. API accepts `shadow`/`live` agents bound to swap venues and they crash at runtime. | S | Add `.refine()` or API-level check: if binding is swap, reject non-paper mode (until #1/#3 are done). |
| 15 | **BotConfigSchema rejects paper+swap but no equivalent agent guard** | Bots can't be paper+swap (no price source). But agents with swap bindings CAN be set to paper mode via the agent creation API with no validation. The agent crashes. | S | Add equivalent check for agent creation: swap binding → must be shadow (or paper if paper-swap is supported for agents). |
| 16 | **Agent `execution_mode` is nullable in DB** | Schema allows `null`, and the worker defaults to `'paper'` when null. This silent defaulting can mask intent. | S | Make it non-nullable with a default, or validate at creation. |

---

### POSITION & P&L TRACKING

| # | Gap | Impact | Effort | Notes |
|---|---|---|---|---|
| 17 | **No real-time equity tracking** | Agent `capital` is a static config value, never updated from actual P&L. Used as `equity` in risk gate (% checks). Over time it diverges from reality. | M | Need: compute current equity = starting capital + realized P&L + unrealized P&L (mark-to-market). |
| 18 | **No unrealized P&L calculation in risk path** | Risk gate only sees `currentDrawdown` (hardcoded 0). No mark-to-market on open positions flows into risk decisions. | M | Coupled with #7. Need position valuation at decision time. |
| 19 | **No position-level P&L tracking for swap venues** | Swap positions are balance-based, not directional. The system tracks them as long/flat but swap venues on-chain only have token balances. Reconciler explicitly skips swap positions to avoid false drift. | M | Need: swap-specific position model (balance delta tracking vs entry/exit directional model). |

---

### LIVE EXECUTION SAFETY

| # | Gap | Impact | Effort | Notes |
|---|---|---|---|---|
| 20 | **No order timeout/cancellation for live** | Live orders are submitted and tracked until the private stream reports terminal state. If the venue never responds (or stream disconnects), the order hangs in `executing` forever. | M | Need: configurable order timeout, auto-cancel stale orders, mark plan failed on timeout. |
| 21 | **No slippage alerting in live** | `liveRollout.slippageAlertBps` is in config, `live.slippage_alert` is in journal event taxonomy, but no code checks actual fill price vs expected price after a live fill. | S | Need: compare fill price vs mark at decision time, emit alert if delta > threshold. |
| 22 | **No idempotency for live order resubmission** | If the worker crashes between `submitOrder` and persisting the result, restart could submit a duplicate. `clientOrderId` helps but only if the venue supports idempotent submit (Hyperliquid may not). | M | Need: write-ahead clientOrderId persistence, check for existing venue order before re-submitting on recovery. |
| 23 | **Live mode has no graceful position wind-down on crash** | When a live actor crashes (max reconnect, reconciliation failure), it stops — but open positions remain on-venue with no monitoring. | L | Need: emergency go-flat on crash, or at minimum alert + manual intervention path. |

---

### VENUE ADAPTERS

| # | Gap | Impact | Effort | Notes |
|---|---|---|---|---|
| 24 | **Jupiter swap has no transaction signing** | `executeSwap` fetches the serialized transaction from Jupiter but returns `'pending-signature'` without signing or broadcasting it. | M | Need: Solana wallet integration (Keypair), sign tx, send via RPC, poll for confirmation. |
| 25 | **No private stream for swap venues** | `openPrivateStream()` only opens when `this.venuePort` exists (orderbook). Swap venues have no equivalent — no real-time fill notification from chain. | L | Need: on-chain transaction monitoring (websocket subscription to token account changes for Solana, event logs for EVM). |
| 26 | **Bybit public stream not implemented** | `subscribePublic` returns `err('venue.not_implemented')`. Must use the stream pool directly. If stream pool is unavailable, Bybit shadow mode falls back to polling. | S | Intentional — stream pool is the entry point. Low priority. |

---

### RECONCILIATION

| # | Gap | Impact | Effort | Notes |
|---|---|---|---|---|
| 27 | **Swap reconciliation skips position drift** | `createSwapVenueStateLoader` returns empty positions. Reconciler only checks balances. If the system believes it holds SOL but the on-chain balance is zero (e.g. manual withdrawal), position tracking diverges silently. | M | Need: reconcile token balances against expected holdings from position state. |
| 28 | **No reconciliation for agent paper mode** | Agent paper mode has no reconciler (no venue to reconcile against). If fills are lost due to crash, paper positions can diverge from DB. | S | Low severity — paper mode has no real capital at risk. |

---

### OPERATIONAL READINESS

| # | Gap | Impact | Effort | Notes |
|---|---|---|---|---|
| 29 | **Export bundle serialisation drops agent fields** | `agent.status` and `agent.createdAt` come back as `null`/`{}` from the export bundle endpoint (observed in crash report). | S | Serialisation bug — likely a Drizzle date/enum column not being mapped. |
| 30 | **Docker agent manager misclassifies crash as voluntary stop** | A container that exits within seconds of start due to an init error is logged as "voluntary stop". Masks failures in monitoring. | S | Check container uptime duration before labelling. |
| 31 | **No health check for trading actors** | API has `/health` but no endpoint to check if a specific bot/agent's trading actor is healthy (position synced, stream connected, reconciliation passing). | M | Need: per-actor health status with degradation signals. |
| 32 | **No dead-letter / retry for failed decisions** | If `submitDecisionForExecution` throws (not returns error), the decision is lost. No retry queue exists. | M | Need: at minimum, persist rejected decisions with failure reason for observability. |

---

### SUMMARY BY PRIORITY

**Must-fix before any live trading:**
- #1, #4, #7, #8, #10, #11, #14, #20, #22, #23 (total: ~8–12 weeks of work)

**Must-fix before live swap trading:**
- #1, #2, #3, #5, #24, #25, #27 (total: ~5–7 weeks additional)

**Should-fix for production confidence:**
- #9, #12, #13, #17, #18, #19, #21, #29, #30, #31, #32

**Acceptable deferrals (documented limitations):**
- #6, #15, #16, #26, #28