# Lessons from aitradingbot — carried forward into herobids

### 1. Never assume token decimals

The old project defaulted to 9 decimals when the cache was empty. A 6-decimal token (TRUMP) caused 1000× price inflation, phantom P&L, and false take-profit triggers. **Rule:** Fetch and persist decimals before any math. Never default. Fail loudly if unknown.

### 2. Every recurring async loop must reschedule itself on failure

The agent tick scheduler silently stalled because an unprotected DB call threw *outside* the inner try-catch. `scheduleTick()` was never called again. The container stayed alive and "healthy" — invisible failure. **Rule:** For recurring control loops, scan loops, background dispatchers, and heartbeat-driven workers, use a single top-level try-catch (or `finally`) that guarantees the next iteration is always scheduled or the actor is marked failed explicitly. One-shot async operations should usually fail visibly instead of quietly re-arming themselves.

### 3. Cooldowns after forced exits

Stop-loss closed a position, the next scan re-entered the same token on a stale signal, and the loop repeated — burning capital at ~12% per cycle. **Rule:** After any forced exit (stop-loss, circuit breaker, session end), apply a mandatory cooldown per instrument before re-entry is allowed.

### 4. Startup config failures and runtime validation failures are different

A config where confidence weights summed > 1.5 caused a fatal crash. An LLM that emitted `0` for unknown fields caused a fatal Zod error. These look similar on paper but they are different failure classes. **Rule:** Invalid startup or operator config should fail fast before the process starts trading. Invalid runtime payloads from an LLM, user, or external input should reject that payload, journal the failure, and keep the worker healthy unless continuing would be unsafe. Only crash on conditions that would cause financial harm or data corruption if ignored.

### 5. Config must flow through one resolved object

The old project had `config.trading.*`, `config.unifiedStrategy.*`, `config.filters.*`, `config.intervals.*`, `config.tradingSessions.*`, and `config.playbook.*` — all consumed directly from different call sites. When the schema restructured, 8+ files broke. **Rule:** Raw config enters the system once, is resolved into a typed runtime object (like the old `TradingParams` / `TimingPolicy` / `SessionPolicy`), and the hot path only reads the resolved object. Keep operator config and runtime instance config in separate resolution chains. Schema changes should affect one resolution function, not the entire codebase.

### 6. Migration files must match the journal

Drizzle's `migrate()` silently skips SQL files not listed in `_journal.json`. Two missing journal entries caused a production crash loop (tables didn't exist, API couldn't start). **Rule:** Always use `drizzle-kit generate`. If you write migration SQL manually, verify the journal entry exists before merging. Add a CI check: count of SQL files == count of journal entries.

### 7. Idempotent lifecycle operations

Stopping a container that was already removed caused a 404 → 500 → frontend retry storm. **Rule:** Stop, pause, destroy, unsubscribe, and similar lifecycle operations must be idempotent. If the resource is already gone or already in the requested state, return success. Match on status codes (404, 304) and common error strings defensively.

### 8. Paper/shadow must simulate realistic costs

Without simulated slippage, pool fees, and tx fees, paper results are systematically optimistic. Strategies tuned in paper underperform live. **Rule:** Apply the cost model (slippage + fee + tx cost) in paper and shadow modes. Make the cost parameters configurable per venue and visible in results.

### 9. LLM context grows without bound

Agents running 24/7 accumulate memories, bot listings, and datasets in their system prompt. The executor loop's multi-turn tool calling amplifies this quadratically (resends full history each turn). **Rule:** Budget and cap every context source. Impose hard character/token limits per provider. Truncate old tool results after N turns. Monitor input token counts per tick.

### 10. Provider abstraction with ordered fallback

When multiple providers serve the same data (GeckoTerminal, Birdeye, DexScreener for token info), wrap them behind one interface and try in order. If the primary returns null/empty or throws, fall to the next. **Rule:** Apply this only when providers are interchangeable. Don't abstract providers with unique capabilities (Jupiter routing has no substitute).

### 11. Foreign key chains must be satisfiable in every run mode

The old bot couldn't persist state in standalone mode because the FK chain (plans → users → configs → bots → bot_state) wasn't seeded. **Rule:** Every run mode (standalone dev, test, multi-tenant production) must either seed required parent records or not enforce FK constraints that don't apply in that context. Validate this in CI for each entry point.

### 12. Persist intent before side effects

The old project had to infer whether an action happened after a crash because the durable record lagged behind the real-world side effect. That turns recovery into guesswork. **Rule:** Persist the execution intent before any venue-side effect, then reconcile incomplete intents against external state on restart. Recovery should determine whether the side effect happened, not speculate.

---

**Meta-principle:** Most of these bugs share a root cause — *something failed silently and the system continued in a broken state rather than failing visibly or recovering gracefully.* Prefer loud failure (log + alert + stop trading) over quiet degradation. A trading system that doesn't know it's broken is more dangerous than one that crashes.
