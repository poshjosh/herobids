# Pending Feature Backlog

Sources consolidated here:
[production-core-cut-checklist](../2026/06/15/production-core-cut-checklist.md) ·
[06/14 feedback](../2026/06/14/feedback.md) ·
[06/15 feedback](../2026/06/15/feedback.md) ·
[gap analysis](2026-06-10-gap-analysis.md)

---
17 June 2026

| # | Issue | Reason |
|---|-------|--------|
| 1 | Make venue capabilities config-driven | Larger architectural change — needs plan/contemplation |
| 6 | Commit untracked order-update-decision.ts and order-lifecycle-manager.ts | These appear complete but were not in the original plan to address |
| 7 | `fillEvidence` on every decision path | Design decision — not a bug, needs broader discussion |

---

## Feature Plans

Items with dedicated plan documents, in suggested implementation order.

### 1. Advanced Live Limit Order Management

[Plan](advanced-live-limit-order-management/001-plan.md)

Expand live order handling beyond the minimal Phase 3 safety path: amend/replace workflows, richer venue-specific order semantics (TIF, post-only, reduce-only, client order ID behavior), stronger restart recovery for in-flight and partially filled orders, and a clear cross-venue capability model. Partial fills must be first-class lifecycle states. Safety beats convenience — if a venue does not support amend-in-place, fall back to cancel-and-replace.

### 2. Migrate herobids.com Domain to This Repository

[Plan](hetzner-deployment/001-migrate-herobids-domain-to-this-repo.md)

Move herobids.com to this repo using the existing Hetzner CPX22 VPS and IP (no DNS change required). Requires: production Docker Compose override, Caddy TLS termination, `.env.example` documenting all required secrets, and Terraform infra scripts under `infra/hetzner/`. Move after major code paths are stable.

### 3. Admin Perp Venue Observability Panel

[Plan](../2026/06/15/015-admin-perp-venue-observability/001-plan.md)

Dedicated admin panel for perp venue health. Deferred from MVP production cut (effort L, not a launch blocker).

Deferred scope: no orderbook depth, fills, or orders; no per-user exposure; no charting; no UI symbol selection; no acknowledgements; no auto-remediation. Open questions: whether stream health is required for v1, and who owns warning-threshold definitions.

### 4. Birdeye Market-Data Integration

[Plan](../2026/06/15/014-birdeye-provider/001-plan.md)

Solana-only opt-in Birdeye provider. Config, schema, registry, and admin-surface wiring already exist with `enabled: false`. Not a live integration yet. Deferred from MVP production cut (effort M, not a launch blocker).

Intentionally narrow scope: Solana-only, opt-in, no CoinMarketCap discovery or enrichment, no execution or strategy changes.

### 5. Dedicated-Wallet Strict Reconciliation

Deferred and descoped from MVP. Current swap semantics are shared-wallet observational only. Reconciliation infrastructure exists but the active runtime behavior for swap venues is observational, not authoritative. Effort XL.

See [production-core-cut-checklist](../2026/06/15/production-core-cut-checklist.md) row 7.

---

## Venue Validation Completion

[017-todo.md](../2026/06/14/002-production-readiness/017-todo.md)

The 1inch and Jupiter dry-run validations (quote + safety enforcement, no on-chain execution) are complete. The following steps remain before calling the full MVP release closed:

1. Set `ONEINCH_ROUTER_ADDRESS`.
2. Fund the Jupiter and 1inch validation wallets.
3. Re-run `bash validate-jupiter.sh --execute` and `bash validate-1inch.sh --execute`.
4. Update `016-venue-validation-results.md` with the live execution results.
5. Write the final release summary artifact required by `015-final-mvp-validation-and-release-evidence.md`.

Do not call the MVP release closed until `routerAddress` is configured and live `--execute` runs are done — the release rules in `015-final-mvp-validation-and-release-evidence.md` require real venue proof for swap submission, confirmation, and persisted execution evidence.

---

## Technical Gaps Without Plans

### From Gap Analysis

([2026-06-10-gap-analysis.md](2026-06-10-gap-analysis.md))

- **Wallet/self-custody UX for spot DEX flows** (effort M) — Generic credentials and trading bindings exist, but no wallet generation/import/CRUD surface comparable to aitradingbot. Matters if Solana/Base spot remains a strategic focus.
- **Binding-first startup/restart cleanup** (effort M) — Worker startup is still partly `venueAccountId`-first. See also Plan 005 deferred items below.
- **Deployment/runtime parity** (effort L-XL) — No ECS manager code or PM2-style deployment surface. Worth for scale/ops but not the best immediate product investment.

### From Phase 2/3/4 Deferrals

(Source: [06/14 feedback](../2026/06/14/feedback.md), `005a-phase2-problems.md`, `005-phase-2-complete-swap-execution.md`, `010-phase-4-config-validation-and-operational-polish.md`)

- **Funded-wallet baselines and rebaselining** — Unresolved product decision: how to handle external balance deltas and rebaselining. Until decided, avoid writing E2E tests that assume strict shared-wallet holdings truth. See `005a-phase2-problems.md`.
- **Explicit safety-lock states** — The runtime collapses `circuit-breaker-open` and `stop-loss-active` into `instance-not-running`. Returning explicit safety states is deferred. See `005a-phase2-problems.md`.
- **Phase 2 out-of-scope** — Swap WebSocket fill streaming, swap-specific unrealized PnL in the risk path, and cross-chain / richer routing semantics are explicitly deferred. See `005-phase-2-complete-swap-execution.md`.
- **Phase 4 deferrals** — No automated retry orchestration for dead-lettered decisions, no actor-health dashboard UI, no paper synthetic reconciliation, no direct-agent shadow/live execution outside the running actor lifecycle. See `010-phase-4-config-validation-and-operational-polish.md`.

---

## Per-Plan Deferred Items

Deferred items captured per plan from [06/15 feedback](../2026/06/15/feedback.md).

### Plan 001 — Skill Tool Validation ([plan](../2026/06/15/001-skill-tool-validation/001-plan.md))

- Open decisions: invalid fork behavior, stable error-code shape, and whether to expose the tool manifest later for a skill editor.
- `001-plan.md` has a duplicate in-place that should be cleaned up.

### Plan 002 — System Skill Startup Sync ([plan](../2026/06/15/002-system-skill-startup-sync/001-plan.md))

- Manual migration is still required for system skill removals; the plan intentionally does not auto-delete removed system skills.

### Plan 003 — Agent/Runtime State Mismatch ([plan](../2026/06/15/003-bug-mismatch-between-agent-and-runtime-state/001-plan.md))

- Open semantic questions: whether wall-clock expiry should remain `stopped`, whether graceful runtime activity should use a `stopped` event type rather than `started`, and whether runtime sessions should later store explicit terminal reasons.

### Plan 004 — Graceful Agent Deployment ([plan](../2026/06/15/004-graceful-agent-deployment/000-graceful-agent-deployment.md))

- Rolling replacement and fencing-token safety are explicitly later phases.
- Hot state migration and multi-worker failover are explicitly excluded from this plan.

### Plan 005 — Trading Binding Native Bot Startup ([plan](../2026/06/15/005-trading-binding-native-bot-startup-follow-through.md))

- `bots.venueAccountId` is not removed.
- Downstream fills, positions, orders, and reconciliation are not migrated away from venue-account anchoring. Legacy identifiers remain part of the runtime model even after this plan lands.

### Plan 006 — Agent Runtime Loop Controls ([plan](../2026/06/15/006-agent-runtime-loop-controls/001-plan.md))

- `maxToolCallsPerTurn` and `maxToolCallsPerTick` are deferred. The main remaining risk is configuration consumption drift — the integration guard at `config-propagation.integration.test.ts` helps but "parsed" and "actually used" can still diverge.

### Plan 007 — Agent Wake Semantics 2 ([plan](../2026/06/15/007-agent-wake-semantics-2/001-ideal-state-plan.md))

- Still an ideal-state document, not a concrete delivery plan. Biggest unresolved gaps: actual capability/subscription eligibility model, rollout compatibility while old producers or consumers exist, and final removal of legacy generic wake semantics.

### Plan 008 — Provider Registry, Credentials & Connections ([plan](../2026/06/15/008-provider-registry-credentials-and-connections/001-plan.md))

- A real migration and audit step for existing free-text provider values is still required. The product gap is migration safety and browser behavior, not route validation.

### Plan 009 — Agent Risk Config UI ([plan](../2026/06/15/009-agent-risk-config-ui/001-plan.md))

- Runtime adjust-risk tool and real-time notifications are explicitly deferred.
- Open product question: whether percentage-based limits without a capital baseline are meaningful enough to allow.

### Plan 010 — Payment Provider Selection & Usage Dashboard ([plan](../2026/06/15/010-payment-provider-selection-and-usage-dashboard/001-plan.md))

- Does not redesign the billing model, rate cards, or live-trading rules.
- Ongoing risk: guarding against a shadow `enabled` flag sneaking back in under a different name.

### Plan 011 — Telegram Reply Threading ([plan](../2026/06/15/011-telegram-reply-threading/001-plan.md))

- Deferred: slash commands, inline keyboards, per-agent bot tokens, multi-user shared bots. Depends on a public HTTPS webhook URL in dev (operational caveat, not a code gap).

### Plan 012 — Telegram Slash Commands ([plan](../2026/06/15/012-telegram-slash-commands/001-plan.md))

- Deferred: reply threading, `/agents` listing, and all other slash commands.
- Parser-design risk: target parsing must stay pure and must not depend on known-agent-name lookup.

### Plan 013 — Backtesting Agent Tools ([plan](../2026/06/15/013-backtesting-agent-tools.md))

- Depends on plans 022 and 023 (not yet filed). Rejects LLM strategy backtests. No true mid-run cancellation. 90-day date-range cap. Limited momentum parameters.
- `backtests.test.ts` already exists — needs a re-baseline before more work is added.

---

## Tests Beef Up

[Plan](tests-beef-up.md)

Widen test coverage across browser journeys, functional API suites, and shell-level smokes. The plan covers the primary backlog. Additional smokes to fold in:

**From [06/14 feedback](../2026/06/14/feedback.md):**
- Orderbook live-recovery crash-window smoke (two crash windows: after local submit persistence but before venue ack, and after venue ack but before local ack persistence).
- Live minimal-limit lifecycle smoke: submit, open/resting state, timeout, cancel, partial/full fill, post-timeout escalation.
- Swap smoke for Jupiter and 1inch (separate harness): quote, execution, on-chain confirmation, restart with pending confirmation, ambiguous-confirmation halt, swap slippage alerts.
- Deterministic safety-lock functional test: trip stop-loss, cooldown, and circuit breaker on a mocked/seeded adverse path; assert correct safety state is reported.
- API/worker integration test for health and dead-letter visibility: verify real degradation reasons and failed decisions surface correctly (not just that a health card renders).
- Shared-wallet observational-variance integration test: inject an external balance delta after a confirmed swap; assert startup continues and the journal emits observational variance, not authoritative drift.
- Matrix runner across paper/shadow/live modes for the existing happy-path orderbook smoke.

**From [06/15 feedback](../2026/06/15/feedback.md):**
- Binding-first bot startup smoke: create bot from a trading binding, start with only `tradingBindingId`, restart with only `botId`, then boot-time rehydration.
- Ordering-sensitive integration test for plans 003 + 004: runtime sends `session-ended`, Docker die arrives later; activity feed shows correct terminal semantics.
- Graceful deployment drain smoke: agent mid-tick receives SIGTERM, stops opening new work, exits cleanly within timeout, new worker does not duplicate action.
- Telegram idempotency and cold-start anchor tests: repeated webhook delivery and the `session started` ForceReply anchor path.
- Playwright provider-catalog journey: credentials and connections render from the fetched catalog, filter compatible credentials, and handle custom mode.
- Playwright billing journey: billing page always visible, usage sections render empty states, provider choice decoupled from dashboard visibility.
- Browser + runtime risk-config test: explicit user-set limits remain hard caps; blank fields fall back to platform defaults and stay agent-adjustable.
- Dedicated backtesting smoke: real async run/poll/cancel flow with queue + DB + result summary, plus concurrency-cap enforcement.
- Birdeye integration test: Solana-only gating, disabled-config skip, enabled-without-key fail-fast, and 400 warn-and-skip behavior.
- Admin perp observability route and UI smokes: Redis-snapshot route test plus browser rendering across healthy/stale/unavailable/warning states.