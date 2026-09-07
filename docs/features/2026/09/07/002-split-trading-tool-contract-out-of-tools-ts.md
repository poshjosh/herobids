# Source-Fix Request #3: split a trading-owned tool contract out of `tools.ts`

**For:** an AI agent working in the **herobids** repo. You need only this document, `AGENTS.md`, and the
herobids source. **Work only in herobids.** This is a behaviour-preserving refactor (split a fused module;
no behaviour change).

---

## 1. Orientation — what this is and where it comes from

A downstream project extracts herobids' **trading** code into a standalone library. The trading **tool
modules** (the implementations behind `get_price`, `submit_decision`, `create_bot`, `get_account_summary`,
`watch_token`, etc. — in `apps/worker/src/tools/`) all import the **tool contract** from
`packages/domain/src/tools.ts`:

- `AgentTool`, `ToolResult`, `ToolContext` (+ the record types `ToolBotRecord`, `ToolPositionRecord`,
  `ToolAnalyticsResult`, and `ToolCategory`, `ToolDefinition`, category helpers).

`tools.ts` is a **fused module**: its `ToolContext` interface interleaves trading dependencies (bot repo,
market data, price service, risk-contract ops, instrument repo) with **agent/platform** dependencies
(`permissionLevel`, agent `phase`, skills, browser capability engine, usage billing, unified-agent config).
The trading tools only use the trading fields — but they can't import a clean trading contract because it
doesn't exist as a separable unit. You are asked to **split a trading-owned tool contract out of `tools.ts`**
so the trading layer can depend on it without dragging in agent/platform types.

Think of it as: factor `ToolContext`'s platform-only members into an agent extension, and move the
trading-owned contract types into a trading-owned domain module. Behaviour identical; herobids's public API
surface preserved.

## 2. Guardrails

- **Behaviour-preserving only.** No field renames, no shape changes, no logic changes. Same public exports
  under the same names. herobids `pnpm build` + `pnpm lint` + `pnpm test` green **with no test edits** — that
  is the acceptance bar and the proof nothing changed.
- **Public API surface unchanged.** Everything still exported from the domain barrel
  (`packages/domain/src/index.ts`) under the same name. Existing herobids importers keep working with no
  edits (they can keep importing `ToolContext` etc. from `@herobids/domain`).
- Follow `AGENTS.md` (strict TS, ESM, ports). This is types/interfaces only.

## 3. The verified trading vs platform split (from downstream investigation)

I mapped exactly what the trading tools use. In `ToolContext` (packages/domain/src/tools.ts, ~line 106):

### TRADING fields (the trading tools use these — must be in the trading contract)
`agentId`, `sessionId`, `executionMode`, `authorizationMode`, `redis`, `publishToInbound`, `botRepo`
(→ `ToolBotRecord`/`ToolAnalyticsResult`/`ToolPositionRecord`), `marketDataRegistry`,
`recordMarketDataAttempt`, `recordMarketDataRejection`, `marketDataConfig`, `sessionMetrics` (the inline
`{ decisionsSubmitted: number }`), `priceService`, `riskContractOps`
(→ `ResolvedAgentRiskContract`/`ResolvedAgentRiskProfile` from `./agent-risk-contract.js`), `instrumentRepo`,
`agentRepo`, `operatorDefaults`, `db?: unknown`.
(Note: `agentId`/`sessionId`/`executionMode`/`authorizationMode` are plain scalars — trading-safe.)

### PLATFORM/AGENT fields (the trading tools do NOT use these — factor out)
- `phase: 'scout' | 'judge'` (agent reasoning phase)
- `permissionLevel: PermissionLevel` (from `./config/schema.js` — platform)
- `agentConfigOps` (→ `UnifiedAgentConfig` from `./config/schema.js` — platform)
- `capabilityEngine`, `externalSkillProvider` (`./ports/external-skill-provider.js`), `skillOps`,
  `onSkillsChanged`, `usageBilling`

### The contract types
- **Trading-clean, move to the trading module:** `ToolResult`, `ToolBotRecord`, `ToolPositionRecord`,
  `ToolAnalyticsResult`, `ToolCategory`, `ToolDefinition`, `isReadOnlyCategory` / `getCategoryOperation` /
  `getCategoryTarget`.
- **`ToolContext`** — the split point (see §4). The downstream trading tools annotate their `execute`'s
  context parameter as `ToolContext` **by name** (e.g. `async execute(params, ctx: ToolContext)`), and each
  tool object is typed `: AgentTool` — so BOTH `AgentTool` and the context type the trading tools reference
  must resolve to a trading-owned type after the split (see §4 for the exact requirement + the known hard
  part).
- **`AgentTool`** — moves with the trading contract, BUT its typing is the delicate part (see §4, "the hard
  part"). Do NOT blindly narrow it — read §4 first.
- **STAY in the platform-facing module (do NOT move):** `ToolCatalogEntry`, `TOOL_CATALOG`,
  `KNOWN_AGENT_TOOL_NAMES` / `AgentToolName` / `isKnownAgentToolName`, `TOOL_CATEGORY_LABELS`,
  `getToolCatalogEntry`, `findUnknownSkillTools`. `ToolCatalogEntry` is the element type of `TOOL_CATALOG`;
  they belong together and are platform-facing (mixed trading+platform tool-name registry — the
  mechanical-first-registry precedent). It only needs `ToolCategory` (import it from the trading module).
  The downstream trading extraction does NOT copy the name catalog — only the contract types above.

## 4. Requested change (behaviour-preserving) — goal + the known hard part

Create a **trading-owned tool-contract module**, e.g. `packages/domain/src/trading/tool-contract.ts`
(name/location your call, consistent with the existing `trading/` grouping and the `trading-protocol.ts`
precedent from source-fix #2).

### The goal (what "done" means, structurally)
After the split, the trading layer can import a trading-only tool contract — a trading `ToolContext`
(suggested name `TradingToolContext`, trading fields only), the trading-clean contract types (§3), and an
`AgentTool` whose `execute` context is the trading context — WITHOUT any platform type
(`PermissionLevel`, `UnifiedAgentConfig`, skills/browser/capability/usage-billing) in its type closure. AND
herobids's existing platform code (platform tools, registries) must compile and behave EXACTLY as before,
with no test edits.

### Steps
1. **Move the trading-clean contract types** (§3 list — `ToolResult`, the three record types,
   `ToolCategory`, `ToolDefinition`, the category helpers) into the trading module, verbatim.
2. **Split `ToolContext`:** define `TradingToolContext` (trading fields only, per §3) in the trading module;
   make the existing `ToolContext` = `TradingToolContext` + the platform fields, structurally identical to
   today. Preferred: `export interface ToolContext extends TradingToolContext { <platform fields> }` in
   `tools.ts` (so `ToolContext` is a superset of `TradingToolContext`). Existing importers of `ToolContext`
   are unchanged.

### ⚠️ The hard part — `AgentTool.execute` context typing (read carefully; this is where a naive split breaks the build)
`AgentTool.execute(params, ctx: ...)` and the tool objects typed `: AgentTool` are used by BOTH trading and
platform tools. **The platform tools' `execute` bodies read platform-only ctx fields heavily** (verified in
herobids: `ctx.capabilityEngine` ~43 uses, `ctx.skillOps` ~19, `ctx.agentConfigOps` ~8, `ctx.permissionLevel`
~4, plus `externalSkillProvider`/`onSkillsChanged`/`usageBilling`/`phase`). So:

- **DO NOT** simply retype `AgentTool.execute`'s `ctx` to `TradingToolContext` — that removes the platform
  fields from the type the platform tools rely on, breaking the platform build (or forcing behaviour-touching
  edits to platform tools). That is NOT acceptable.
- The requirement is: **trading tools end up depending only on the trading context; platform tools keep the
  full context; both compile unchanged.** How you achieve that is your call. Options that can be
  behaviour-preserving (pick what fits herobids best — verify against a full `pnpm build`):
  - **(a) Generic `AgentTool`:** `interface AgentTool<Ctx extends TradingToolContext = ToolContext> { execute(params: unknown, ctx: Ctx): Promise<ToolResult>; … }`. Trading tools use `AgentTool<TradingToolContext>` (or the trading module re-exports a `TradingAgentTool = AgentTool<TradingToolContext>`); platform tools keep `AgentTool` (defaulting to the full `ToolContext`). Because the tool objects are *consumed* by a registry that calls `execute(params, fullCtx)`, passing a full `ToolContext` to a tool expecting `TradingToolContext` is safe (the full context is assignable to the base).
  - **(b) Two contract interfaces:** a trading `AgentTool` (ctx: `TradingToolContext`) in the trading module and herobids's platform `AgentTool` (ctx: `ToolContext`) — if that doesn't create duplicate-name export conflicts and the registry accepts both.
  - Whatever you choose, the trading tool source files (`apps/worker/src/tools/{account,price,trading,watch,…}.ts`) currently annotate `async execute(params, ctx: ToolContext)` and `const fooTool: AgentTool = …`. For the trading layer to be platform-type-free, **those annotations must resolve to the trading context** — i.e. you will likely also update those trading tool files to annotate `ctx: TradingToolContext` and `: AgentTool<TradingToolContext>` (or the `TradingAgentTool` alias). That is an allowed, behaviour-preserving edit (the runtime is identical; only the static type narrows to what those tools actually use). The downstream project copies the *improved* trading tool files verbatim (same as source-fix #1/#2).
- **If a behaviour-preserving shape that satisfies both sides is not achievable, STOP and report** (see §7) — do not force it by editing platform tool behaviour or by widening the trading context back to include platform fields.

3. **Re-export** everything moved from the domain barrel under the same names (e.g.
   `export * from './trading/tool-contract.js'`), and update `tools.ts` (and any other definer) to import the
   moved types where it still references them. Net public surface identical.
4. Keep `KNOWN_AGENT_TOOL_NAMES` / `TOOL_CATALOG` / `ToolCatalogEntry` / `TOOL_CATEGORY_LABELS` / etc. where
   they are (platform-facing); have them import `ToolCategory` from the trading module.

## 5. Also needed: `tool-schemas.ts` reachability (the `get_schema` tool)

The trading `schema` tool (`get_schema`) imports `getToolSchema` + `listToolSchemaNames` from
`@herobids/domain` (defined in `packages/domain/src/tool-schemas.ts`). `tool-schemas.ts` imports only
trading-owned schemas (`StrategySchema` from `config/schema.js`; `TransitionModeSchema`,
`MarketAssessmentPresetRankingSchema`, `MarketAssessmentIdentitySchema` from `market-assessment.js`) — all of
which already exist in the downstream trading domain. Its schema registry is mostly trading (strategy-preset,
market-assessment) with a couple of platform entries (`publish_artifact.*`, `execute_code.dependencies`).

**Requested (lighter):** ensure `getToolSchema` / `listToolSchemaNames` / `SchemaEntry` and the module's
trading schema content remain importable from the domain barrel and do not depend on any platform-only type.
If `tool-schemas.ts` currently imports NO platform-only types (verify — it appears not to), **no split is
needed** — the downstream project can copy it as-is (trimming the 2 platform registry entries on its side as
a within-file deletion). Only if `tool-schemas.ts` pulls a platform-only type should you relocate the
trading schema registry into a trading-owned module the same way as §4. Please confirm which case holds in
your PR notes.

## 6. Acceptance checklist

**Status: DONE** (implemented as one atomic behaviour-preserving refactor; verified `pnpm build` + `pnpm lint` + `pnpm test` green with zero test edits)

- [x] Trading-owned tool-contract module created; the trading-clean contract types (§3) + `TradingToolContext`
      (trading fields only) + a trading-context `AgentTool` form live there.
- [x] `TradingToolContext`'s type closure contains **NO** platform type (`PermissionLevel`,
      `UnifiedAgentConfig`, `ExternalSkillProvider`, skills/browser/capability/usage-billing). Verify by
      importing ONLY the trading module in a scratch check — it must not transitively pull `config/schema` or
      `ports/external-skill-provider`. (See Outstanding Issues for the type-only risk-contract note.)
- [x] `tools.ts` `ToolContext` remains structurally identical to today (superset of `TradingToolContext` +
      the platform fields); **all platform tools compile and behave unchanged** (they still see
      `permissionLevel`/`skillOps`/`capabilityEngine`/… on their ctx).
- [x] The trading tool files (`apps/worker/src/tools/*` — trading ones) annotate their `execute` ctx +
      tool-object type against the trading context/`AgentTool` form, so the trading layer is platform-type-free
      (runtime identical — a pure type-annotation narrowing).
- [x] `ToolCatalogEntry`/`TOOL_CATALOG`/`KNOWN_AGENT_TOOL_NAMES`/etc. stayed platform-facing; they import
      `ToolCategory` from the trading module.
- [x] Domain barrel re-exports every moved symbol under its original name (public surface unchanged).
- [x] `tool-schemas.ts` case confirmed (no split needed) — `getToolSchema`/`listToolSchemaNames`
      importable and free of platform-only type deps.
- [x] `pnpm build` + `pnpm lint` + `pnpm test` green, **zero test edits**.
- [x] No behaviour change: diff is "types moved + `ToolContext` factored into trading base + platform superset
      + trading tools' ctx annotations narrowed + imports/exports rewired." Every change is types/annotations —
      no runtime logic touched.

## 7. When done

Follow herobids's normal change/PR + release conventions; note the released commit/version in the PR. The
downstream project will re-sync `@traderton/domain` to copy the trading tool-contract module, then copy the
trading tool modules as clean copies. If any listed type turns out genuinely entangled with agent/platform
behaviour such that a behaviour-preserving split is impossible, **stop and report that finding** rather than
changing behaviour.

## 8. NOT in scope
- Do not split or move the mixed `KNOWN_AGENT_TOOL_NAMES` / `TOOL_CATALOG` / `ToolCatalogEntry` name registry
  (keep it platform-facing; it may import `ToolCategory` from the trading module).
- Do not change any tool's RUNTIME behaviour. The ONLY edits to the trading tool files are type annotations
  (`ctx: ToolContext` → `ctx: TradingToolContext`, and the tool-object `AgentTool` form) — no logic.
- Do not touch platform tool implementations' logic, `config/schema.ts`, skills, browser, or usage-billing —
  and do NOT remove the platform fields from what platform tools see on their ctx.
- `ReasoningLevel`, `AppConfig`, `AGENT_MESSAGE_TYPES`, and the worker composition are separate concerns, not
  part of this request. (Note: the trading tools `bots.ts` + `trading.ts` additionally use
  `AGENT_MESSAGE_TYPES` — a separate mixed messaging enum — and are handled downstream in a later step, not
  by this request. This request unblocks the other trading tools; do not attempt to split
  `AGENT_MESSAGE_TYPES` here.)

---

## Outstanding Issues (post-implementation, non-blocking)

Recorded by the implementation coordinator. None are CRITICAL/HIGH; all acceptance criteria are met and `pnpm build` + `pnpm lint` + `pnpm test` are green with zero test edits.

### [Acceptance checklist — trading tool ctx narrowing]
- **LOW / out-of-scope for this request:** The `TradingToolContext` narrowing was applied to 7 trading tool files (`analytics.ts`, `find-instrument.ts`, `market-data.ts`, `price.ts`, `resolvers.ts`, `risk-limits.ts`, `watch.ts`). Some other trading-domain tool files still annotate `ctx: ToolContext` / `: AgentTool`:
  - `account.ts`, `memory.ts` — could optionally be narrowed later for fuller trading-layer purity. Harmless today (the full `ToolContext` is a superset of `TradingToolContext`).
  - `tasks.ts` — legitimately reads `ctx.phase` (a platform field), so it correctly stays on the full `ToolContext`.
  - `bots.ts`, `trading.ts` — explicitly deferred by this request (§8) because they use `AGENT_MESSAGE_TYPES` (a separate mixed messaging enum handled downstream in a later step).

### [Acceptance checklist — TradingToolContext closure]
- **LOW / informational:** `tool-contract.ts` is free of the platform types the spec enumerates. Its `riskContractOps` field references the trading-owned risk-contract types from `agent-risk-contract.ts`, which itself has a type-only `import type { RiskPosture } from './config/schema.js'`. This is a type-only (runtime-erased) edge to a risk-domain enum, not to any platform type (`PermissionLevel`/`UnifiedAgentConfig`/`ExternalSkillProvider`/skills/browser/capability/usage-billing), and is inherent to the agreed split (§3 lists the risk-contract types as trading-owned). The downstream trading domain already contains these risk-contract/config-schema risk types.

### §5 — `tool-schemas.ts` determination
- **No split needed.** `tool-schemas.ts` imports only trading-owned schemas: `StrategySchema` from `config/schema.js` and `TransitionModeSchema` / `MarketAssessmentPresetRankingSchema` / `MarketAssessmentIdentitySchema` from `market-assessment.js`. It pulls no platform-only type, so `getToolSchema` / `listToolSchemaNames` / `SchemaEntry` remain importable from the domain barrel with no relocation. The downstream project can copy it as-is (trimming the 2 platform registry entries on its side as a within-file deletion).
