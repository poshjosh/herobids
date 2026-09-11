# L3d Plan — delete the in-tree trading code (the deletion register)

**Status:** LIVE register (authored 2026-09-08). **L3c APPENDS to this as it defers deletions**, then L3d
executes it. **Branch:** `consume-traderton` ONLY. **Do NOT edit the sibling `traderton` repo.**
**Depends on:** L3c committed + reviewed (nothing here is deleted until side-effecting traffic goes to the
boundary). **Authority for decisions:** `traderton/docs/CANONICAL-STATE.md` §3.1/§3.2.

## Why this doc exists (read this)

L3c rewires the side-effecting path to the boundary but **deliberately leaves dead code behind** (disabled
maxBots enforcement, orphaned `bots`-table writes, now-unused trading imports) rather than delete mid-rewire.
That deferral is a **dropped-work hazard**: once L3c commits and we pause, the dead trading-policy code
(maxBots) and the `bots` table sit in herobids with nothing tracking that they MUST be deleted — which is
exactly the legal-isolation leak #4 exists to close (trading policy/state must not live on the platform).

**So this register is the durable home for every deferred deletion.** The rule:

> **L3c may defer a deletion ONLY by recording the exact file + symbol here (§C, the append log).**
> A fresh session picking up L3d executes §A + §B + §C and nothing is lost.

## §A — Known DELETE set (the big subtraction; seeded now)

The trading-execution code herobids imports in-process, to delete once nothing references it:

- **Packages (whole):** `packages/engine`, `packages/venues`, `packages/market-data`, `packages/strategy`,
  `packages/backtesting`.
- **Worker execution slices:** `apps/worker/src/agent-trading-actor.ts`, `trading-actor.ts`,
  `execution-actor.ts`, `runtime.ts` (the `trading-instance-lifecycle` `WorkerRuntime`/BullMQ consumer), and
  the technical/scanner/tick/candle/swap/`venue-adapter-factory`/`venue-instrument-cache` helpers.
- **Trading DB tables + repos** (`packages/db`): `positions`, `fills`, `orders`, `execution-plans`,
  `decisions`, `decision-*`, `balance-snapshots`, `reconciliation-events`, `backtest-runs`, `instruments`,
  **`bots`**, `venue_accounts`, `user_credentials` (the last two now Traderton-owned — deleted here once
  L3-P1 provisioning is live) + their repos (`position-repository`, `reconciliation-repository`,
  `backtesting-repository`, `instrument-repository`, `decision-*-repository`, the trading slices of
  `repositories.ts`).
- **Trading-package imports** in `apps/worker/src/index.ts` (`@herobids/{engine,venues,market-data,strategy,
  backtesting}`) once the composition root no longer constructs the actor/runtime.

## §B — #4-specific deletions (maxBots + bots state — the legal-isolation closers)

These are the trading-POLICY/STATE items #4 requires gone from herobids. **They are the highest-priority
deletions** — leaving them is the leak.

- **`bots` table + repo** (see §A) — herobids owns no bot state.
- **maxBots enforcement:** `botLimitCheck` / `tryMarkBotRunningWithLimit` wiring in the broker; `checkBotLimit`
  in `apps/api/src/routes/bots.ts`; the maxBots resolution in `apps/api/src/agents/agent-create-normalization.ts`
  (~:368–390) and any `agentRiskDefaults.maxBots`/plan-entitlement bot-cap logic.
- **Any `bots`-table read/write** left in the rewired tools/routes.

## §C — Deferred-deletion append log (L3c POPULATES THIS — one line per item)

> **L3c: every place you disable/orphan trading code instead of deleting it, add a line here** with the
> exact `path:symbol` + one-word reason (`dead` / `orphaned` / `unused-import`). This is a hard L3c
> done-criterion (see `003-l3c-plan.md`). Do not leave the log empty if L3c left anything behind.

| # | `path:symbol` | kind | left by | delete-at |
|---|---------------|------|---------|-----------|
| _(seeded empty — L3c appends)_ | | | | L3d |

## §D — Consumer audit (from L3c; must be complete before deleting)

L3c's `bots`-table + trading-repo consumer audit lands here — every reader/writer of the DELETE-set,
confirmed either (a) trading-path/deletable or (b) re-pointed at a boundary read tool
(`list_bots`/`get_bot_status`). **L3d does not delete a table/module until its consumers are all in this
list as (a) or (b).**

| consumer (`path:symbol`) | of | disposition | notes |
|--------------------------|----|-------------|-------|
| _(L3c fills)_ | | | |

## §E — Execution order (L3d)

1. Confirm §D is complete (no un-audited consumers).
2. Delete §B first (maxBots + `bots` — the legal closers), verify build/suite green.
3. Delete §C's logged items.
4. Delete §A (packages, worker exec slices, trading DB) leaf-first; build + suite green after each.
5. Delete `venue_accounts`/`user_credentials` only AFTER L3-P1 (Traderton provisioning) is live.
6. Full herobids build/lint/suite green; run the L3e differential. Pause for human.

## Done criteria (L3d)

- §B, §C, §A all deleted; no `@herobids/{engine,venues,market-data,strategy,backtesting}` import remains in
  the platform code; no `bots` table; no maxBots logic anywhere in herobids.
- Build + lint + full suite green. Do NOT commit — the coordinator commits. Pause for human before L3e.
