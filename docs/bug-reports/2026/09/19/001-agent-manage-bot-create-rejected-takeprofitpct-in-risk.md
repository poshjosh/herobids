# Bug Report: Agent `manage_bot` `create_bot` rejected — `takeProfitPct` leaked into `risk`, traderton strict `BotRiskSchema` rejects it

- **Status:** FIXED (2026-09-19). Root cause: the LLM's `manage_bot` `create_and_start` config placed the strategy-level exit-target keys `takeProfitPct` / `trailingStopPct` inside the bot's `risk` object; herobids forwarded that object verbatim to traderton's `create_bot`, whose strict `BotRiskSchema` (`.strict()`) rejects unknown keys with `internal.non_retryable` / "Unrecognized key(s) in object: 'takeProfitPct'". Fix: herobids `applyAgentCapitalLimit` (agent-message-broker.ts) now strips `takeProfitPct` + `trailingStopPct` from `risk` before forwarding.)
- **Severity:** High (agent cannot create a bot: `manage_bot` create path fails closed at the boundary; the A8 gate's full open+close trade cycle could not complete).
- **Date:** 2026-09-19
- **Discovered by:** A8 stabilization-certification gate, item 5 (read-surface parity sweep) via `scripts/shell/tests/agent-trade-test.sh` (Phase 2.5 bot creation).
- **Environment:** development, local docker compose cross-stack (herobids api `localhost:3000`; traderton boundary `localhost:8080`). LLM `ollama`. `VENUE=1inch`.

## Root cause — CONFIRMED

1. The agent's `manage_bot` tool schema declares `config.risk: z.record(z.unknown())` (herobids `apps/worker/src/tools/bots.ts:36`), so the LLM is free to emit any keys — including `takeProfitPct` / `trailingStopPct`.
2. `takeProfitPct` / `trailingStopPct` are **strategy-level exit targets** — in both repos they live in the *strategy params* (`MechanicalParamsSchema`), NOT the risk-guard schema:
   - traderton `packages/domain/src/config/schema.ts` `MechanicalParamsSchema` (line ~543) has `stopLossPct`, `takeProfitPct`, `trailingStopPct` as "Exit targets (strategy-level, not risk guards)".
   - traderton `BotRiskSchema` (line ~739) is `.strict()` and lists ONLY the 9 risk-guard fields (`maxPositionSizePct`, `maxOpenPositions`, `stopLossPct`, `stopLossCooldownMs`, `dailyMaxLossPct`, `maxDrawdownPct`, `maxNewPositionsPerDay`, `avoidParabolicMovePct`, `maxOrderNotional`) — **`takeProfitPct`/`trailingStopPct` are absent**.
3. herobids' broker forwards the LLM's raw `config` (including `risk`) to `create_bot` without stripping strategy-level keys (`apps/worker/src/agents/agent-message-broker.ts` `create_and_start` branch → `invokeBotLifecycle('create_bot', { config: rawConfig })`).
4. traderton's `create_bot` Zod-validates `config.risk` against the strict `BotRiskSchema` → rejects the unknown `takeProfitPct` → dispatcher maps to `internal.non_retryable` "Bot config is invalid: risk: Unrecognized key(s) in object: 'takeProfitPct'".

Observed error (worker log):
```
Bot create_bot rejected by trading boundary: Bot config is invalid: risk: Unrecognized key(s) in object: 'takeProfitPct' (internal.non_retryable)
```
`agent-trade-test.sh` Phase 2.5 then timed out: "Bot was not created within 90s".

## Fix

herobids `apps/worker/src/agents/agent-message-broker.ts` `applyAgentCapitalLimit` (the single config-normalization pass before `create_bot`/`adjust_config` forwarding) now filters `takeProfitPct` + `trailingStopPct` out of the `risk` object regardless of capital presence. Covered by a new unit test in `agent-broker.test.ts` ("strips strategy-level exit-target keys …").

This is the same Zod-strip / context-gap defect family as bug-reports/2026/09/17 #001 — the parity sweep (A8 item 5) exists precisely to catch these before users do.

## Not touched

- traderton's `BotRiskSchema` remains strict (correct — strategy exit targets belong in `strategy.params`, not `risk`).
- No schema change on either side; the fix is a consumer-side normalization at the single forwarding point.

## Verification

- `npx tsc --noEmit -p apps/worker` clean.
- `npx vitest run apps/worker/src/agents/agent-broker.test.ts` → 95 passed (incl. the new strip test).