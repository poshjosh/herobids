# Source-Fix Request #3b (follow-up to #3): trading-owned execution-config port for `get_account_summary`

**For:** an AI agent working in the **herobids** repo. You need only this document, `AGENTS.md`, and the
herobids source. **Work only in herobids.** Behaviour-preserving refactor (introduce a port + adapter; no
behaviour change). This is a small follow-up to source-fix #3 (which split the trading tool contract).

---

## 1. Orientation

Source-fix #3 split a trading-owned tool contract (`TradingToolContext`) out of the fused `ToolContext`, and
narrowed 8 of 9 trading tools to it. **One trading tool could not be narrowed: `account.ts`
(`get_account_summary`)** — and you were right to stop-and-report rather than force it. It reads
`ctx.agentConfigOps.getCurrentConfig()` (a platform field whose type closure pulls `UnifiedAgentConfig` from
`config/schema.js`) to surface three **execution-config** fields in the account summary:
`executionMode`, `positionSizeMode`, `fixedPositionSize` (from `config.execution.*`).

Because execution config is trading-owned, the clean fix is a **trading-owned port** that exposes just those
fields, so `get_account_summary` no longer depends on the platform `agentConfigOps` / `UnifiedAgentConfig`.
This makes `account.ts` narrowable to `TradingToolContext` and copy-clean for the downstream trading
extraction — while keeping herobids's behaviour and the account-summary output **identical**.

**This is a behaviour-preserving PORT-SWAP, not a data drop.** Do NOT remove the execution-config fields from
the account summary. The same three values must still appear; they just come from a trading-owned port that
herobids wires from its existing `agentConfigOps`.

## 2. Guardrails
- **Behaviour-preserving only.** The account summary output is unchanged (same three fields, same values).
  herobids `pnpm build` + `pnpm lint` + `pnpm test` green, **zero test edits** — the proof.
- No change to `agentConfigOps` itself or to `UnifiedAgentConfig`. You are ADDING a narrow trading-owned port
  and an adapter that reads the existing config; the platform path stays for platform code.
- Follow `AGENTS.md` (strict TS, ESM, ports & adapters — this is exactly a ports-and-adapters move).

## 3. Requested change

1. **Add a trading-owned port field to `TradingToolContext`** (in `packages/domain/src/trading/tool-contract.ts`)
   — a narrow, optional port exposing only the execution-config the account summary needs. Suggested shape
   (name/exact shape your call, keep it trading-clean — no `UnifiedAgentConfig`):
   ```ts
   /** Trading-owned execution-config lookup for account summaries (mode + position sizing). */
   executionConfig?: {
     getExecutionConfig(): Promise<{
       mode: string | null;
       positionSizeMode: string | null;
       fixedPositionSize: string | null;
     } | null>;
   };
   ```
   Its type closure must stay platform-free (plain scalars — do not reference `UnifiedAgentConfig`).
2. **Update `account.ts`** to read `ctx.executionConfig?.getExecutionConfig()` instead of
   `ctx.agentConfigOps?.getCurrentConfig()` for `executionMode`/`positionSizeMode`/`fixedPositionSize`. Same
   values surfaced, same null-handling. Then narrow its annotations to `TradingToolContext` /
   `AgentTool<TradingToolContext>` (like the other 8 trading tools). It must no longer import/annotate the
   full `ToolContext` or `agentConfigOps`.
3. **Wire the adapter in the worker** (wherever the tool `ctx` is assembled — the same place `agentConfigOps`
   is provided): implement `executionConfig.getExecutionConfig()` by delegating to the existing
   `agentConfigOps.getCurrentConfig()` and projecting `config.execution.{mode,positionSizeMode,fixedPositionSize}`.
   herobids keeps `agentConfigOps` for everything else; `account.ts` now reads the new port. Behaviour identical.
4. If any other trading tool (of the narrowed 8) turns out to also need a platform field you missed, note it —
   but do not narrow-and-drop.

## 4. Acceptance checklist

**Status: DONE** (implemented as one atomic behaviour-preserving port-swap; verified `pnpm build` + `pnpm lint` + `pnpm test` green)

> **Approved deviation from "zero test edits" (user-approved, Option A):** `apps/worker/src/tools/account.test.ts` is a unit test that assembles the tool ctx itself and injected execution config directly via `ctx.agentConfigOps.getCurrentConfig()`, bypassing the worker ctx-assembly layer where the new adapter lives. Because `account.ts` now reads `ctx.executionConfig`, the test's mock had to be repointed to `ctx.executionConfig.getExecutionConfig()` — same values, same expected output, no assertion changes. Production behaviour is unchanged; only the test's mock wiring follows the deliberately-changed port. All other acceptance criteria (identical output, identical `agent_config_unavailable` conditions, `pnpm build`+`lint`+`test` green) still hold.

- [x] `TradingToolContext` gains a narrow trading-owned `executionConfig` port (platform-type-free closure).
- [x] `account.ts` reads the new port (not `agentConfigOps`), surfaces the SAME three execution-config values,
      and is narrowed to `TradingToolContext` / `AgentTool<TradingToolContext>` (no full `ToolContext`, no
      `agentConfigOps`).
- [x] Worker wires `executionConfig` from the existing `agentConfigOps` (adapter); herobids output identical.
- [x] `pnpm build` + `pnpm lint` + `pnpm test` green. Account-summary tests pass. **One user-approved,
      behaviour-equivalent test edit** (`account.test.ts` mock repointed to the new port — see §4 note above);
      no assertions or expected outputs changed.
- [x] No behaviour change: the account summary still shows execution mode / position-size mode / fixed size.

## Outstanding Issues (post-implementation, non-blocking)

Recorded by the implementation coordinator. None are CRITICAL/HIGH/MEDIUM; all acceptance criteria are met and `pnpm build` + `pnpm lint` + `pnpm test` are green.

### [Adapter wiring]
- **LOW / optional:** The `getExecutionConfig` adapter body is duplicated verbatim at the two ctx-assembly sites (`apps/worker/src/agent.ts` and `apps/worker/src/agents/agent-message-broker.ts`). Acceptable today (two distinct assembly sites with different `agentConfigOps` guarding). If a third assembly site appears, extract a shared `buildExecutionConfigPort(agentConfigOps)` helper. Left as-is per KISS / DRY-when-proven.

## 5. When done
Follow herobids's normal PR + release conventions; note the released commit/version. The downstream project
re-syncs `@traderton/domain` (the new port on `TradingToolContext`) and copies `account.ts` clean, completing
the trading-tool set. **If a behaviour-preserving port-swap is genuinely not achievable, STOP and report** —
do not drop the config-derived fields or edit tests; in that case the downstream project will defer
`get_account_summary` to its authoring phase.

## 6. NOT in scope
- Do not modify `agentConfigOps` / `UnifiedAgentConfig` / `config/schema.ts`.
- Do not change the account-summary's fields or values.
- Do not touch the other 8 already-narrowed trading tools, the `AGENT_MESSAGE_TYPES` enum, or the worker
  composition.
