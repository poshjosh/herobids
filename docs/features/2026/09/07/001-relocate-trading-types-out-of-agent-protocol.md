# Source-Fix Request: relocate trading-owned types out of `agent-protocol.ts`

**For:** an AI agent working in the **herobids** repo. You do not need any outside context beyond
this document, `AGENTS.md`, and the herobids source itself. Everything you need to do is in herobids.
**Work only in herobids.** This is a self-contained, behaviour-preserving refactor.

---

## 1. Orientation — what this is and where it comes from

A downstream project is extracting herobids' **trading** code into a standalone library. During that
work it found that a handful of **trading-owned types currently live in a platform module**
(`packages/domain/src/agent-protocol.ts`) and in the config schema. Because those types are trading —
not agent/platform — they should live in a **trading-owned domain module**, so the trading layer can be
depended on without dragging in the agent-protocol module.

You are being asked to perform that relocation **inside herobids only**, as a pure, behaviour-preserving
refactor. You are **not** changing any behaviour, schema shape, enum value, or validation. You are moving
type/schema declarations from one file to another and fixing up imports/exports so herobids compiles and
all its tests still pass, exactly as before.

Think of it as a "Move to a new file + re-export" refactor. Nothing else.

## 2. Guardrails (read before editing)

- **Behaviour-preserving only.** Same declarations, same values, same Zod shapes, same exported names.
  No renames, no field changes, no logic changes. If you find yourself changing what a schema *accepts*
  or *rejects*, stop — that is out of scope.
- **Public API surface unchanged.** Every symbol you move must remain exported from the domain barrel
  (`packages/domain/src/index.ts`) under the **same name**, so every existing importer across herobids
  keeps working without edits. (The barrel already does `export * from './agent-protocol.js'` and
  `export * from './config/index.js'` — you will add a `export * from './<new-module>.js'` and remove the
  moved declarations from their old homes; net exported surface is identical.)
- **Follow `AGENTS.md`:** TypeScript `strict`, ESM, `Result`/ports conventions (not that you'll need them
  here — this is types only). Respect the two-layer config rule (operator vs instance) — you are moving a
  config *enum type*, not touching config loading.
- **Acceptance bar = herobids's own suite.** `pnpm build`, `pnpm lint` (tsc --noEmit), and `pnpm test`
  must all be green after your change, with **no test edits** (the tests are the proof the behaviour did
  not change). If a test needs editing to pass, you've changed behaviour — stop and reconsider.

## 3. Exactly what to move (verified locations)

All paths under `packages/domain/src/`.

### Group A — from `agent-protocol.ts`
1. **Watch purpose taxonomy** (currently ~lines 312–314):
   - `WATCH_PURPOSE_VALUES` (the `as const` string tuple `['entry','exit','stop_loss','take_profit','monitor','alert']`)
   - `WatchPurposeEnum` (`z.enum(WATCH_PURPOSE_VALUES)`)
   - `WatchPurpose` (`z.infer<typeof WatchPurposeEnum>`)
2. **Context snapshot payload** (currently ~lines 179–205):
   - `ContextSnapshotPayloadSchema` (the `z.object({...})`)
   - `ContextSnapshotPayload` (`z.infer<...>`)
3. **Agent wake payload** (currently ~lines 474–491):
   - `AgentWakePayloadSchema` (the `z.discriminatedUnion('source', [...])`)
   - `AgentWakePayload` (`z.infer<...>`)
   - **Its dependencies (move together):** `AgentWakePayloadBaseSchema` and the five wake-context schemas
     the union references — `ReminderWakeContextSchema`, `WatchThresholdWakeContextSchema`,
     `DiscoveryDeltaWakeContextSchema`, `RegimeChangeWakeContextSchema`, `ScannerWakeContextSchema`
     (verified present in `agent-protocol.ts`, ~lines 375–472; `AgentWakePayloadBaseSchema` ~line 474).
     **Move each wake-context schema together with its inferred `type` export** (`ReminderWakeContext`,
     `WatchThresholdWakeContext`, `DiscoveryDeltaWakeContext`, `RegimeChangeWakeContext`,
     `ScannerWakeContext`) so no dangling `type` alias is left behind. `ScannerWakeContextSchema` is
     itself a `z.discriminatedUnion` — move any small schemas it composes too. The goal: the new module is
     self-contained and `agent-protocol.ts` no longer *defines* these, only imports what it still needs.

### Group B — from `config/schema.ts`
4. **Trading session windows** (currently ~lines 191–199):
   - `TRADING_SESSION_NAMES` (the `as const` tuple)
   - `TradingSessionName` (`typeof TRADING_SESSION_NAMES[number]`)
   - `TradingSessionNameSchema` (`z.enum(TRADING_SESSION_NAMES)`)

> **NOTE — verify before moving.** Line numbers drift; find each symbol by name, not by line. After
> moving, grep the whole repo for each moved name to find every in-file reference that now needs an
> import (see Step 4 below). `agent-protocol.ts` itself references some of these internally (e.g.
> `WatchPurposeEnum` is used by other schemas in the file around lines 329/392; `ContextSnapshotPayloadSchema`
> and `AgentWakePayloadSchema` are referenced in message-type maps around lines 741/758) — those become
> imports from the new module.

### Explicitly NOT in scope (do not move)
- `ReasoningLevel` / `ReasoningLevelSchema` — leave in `config/schema.ts`.
- `AppConfig` / `AppConfigSchema` — leave as-is.
- Anything else in `agent-protocol.ts` or `config/schema.ts` not listed above.

## 4. Step-by-step

1. **Create the new trading-owned module.** Suggested path:
   `packages/domain/src/trading/watch-protocol.ts` (herobids has a `trading/`-style grouping;
   pick the location most consistent with the existing domain layout — the exact filename is your call,
   but it must be a trading-owned domain module, not under an agent/platform grouping). Add a short header
   comment: "Trading-owned protocol/enums relocated from agent-protocol.ts for trading-layer independence
   (behaviour-preserving; source-fix request 002)."
2. **Move Group A + Group B declarations** into the new module **verbatim** (cut, paste, keep identical).
   Add the necessary `import { z } from 'zod';` and any imports the moved schemas need.
3. **Re-export from the domain barrel:** add `export * from './trading/watch-protocol.js';` (adjust path)
   to `packages/domain/src/index.ts`. Confirm the moved names are no longer *also* exported from their old
   files (avoid duplicate-export conflicts).
4. **Fix up references in the old files:** in `agent-protocol.ts` and `config/schema.ts`, replace the
   moved declarations with `import { … } from './trading/watch-protocol.js';` (or `../trading/…` from the
   config subdir) wherever those files still *use* the moved symbols. Grep the whole repo for each moved
   name and confirm every consumer still resolves (most resolve via the barrel and need no change).
5. **Build + lint + test:** `pnpm build && pnpm lint && pnpm test`. All green, **no test edits**.

## 5. Acceptance checklist (all must hold)

- [x] New trading-owned domain module contains the 4 groups of declarations, verbatim (same names/values/shapes).
- [x] `agent-protocol.ts` and `config/schema.ts` no longer *define* the moved symbols; they import them where needed.
- [x] Domain barrel re-exports every moved symbol under its original name (public surface unchanged — verify with a grep that each name is still exported exactly once).
- [x] `pnpm build` green. `pnpm lint` (tsc --noEmit) green. `pnpm test` green — **with zero test-file changes**.
- [x] No behaviour change: no schema field/enum/union altered; diff is "declarations moved + imports/exports rewired."

## 6. When done

Follow herobids's normal change/PR + release conventions (see `AGENTS.md`). Note the released version/commit
in the PR description. The downstream consumer will pick up the relocated module from that release. If you
discover any of the listed symbols is genuinely entangled with agent/platform behaviour such that a clean
move isn't possible without a behaviour change, **stop and report that finding** rather than altering
behaviour — that would need a separate decision.

## Outstanding Issues

### Item: Relocate trading-owned types (LOW severity, non-blocking)

1. ~~**Module naming** — `watch-protocol.ts` under-describes its contents.~~ **RESOLVED** — module renamed to `trading/trading-protocol.ts`.
2. ~~**Source-fix reference mismatch** — Header comments cite "source-fix request 002" but the plan document is titled `001-...`.~~ **RESOLVED** — header now references the plan document path directly.
3. **Group B placement** — The trading-session block sits at the very bottom of `trading-protocol.ts`, slightly detached from the rest. A short section divider is already present; no action needed.
