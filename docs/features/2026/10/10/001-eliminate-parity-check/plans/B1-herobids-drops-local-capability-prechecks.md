# B1 — Herobids drops local capability and mode-rank pre-checks

Audit of every herobids call site of `validateExecutionCapability`,
`checkModeEscalation` and `MODE_RANK`, with the verified traderton-side equivalent
and the boundary error code to map. Written 2026-10-10 (B1.0).

## Call sites

### 1. `apps/api/src/routes/bots.ts:339` — PATCH `/bots/:id/config` (bot)

- **What it checks:** `validateExecutionCapability({ actorType: 'bot', executionMode, venueType })`
  — rejects `paper` + `swap` (and a null mode) with a 400 carrying
  `execution_capability.<code>`.
- **Traderton equivalent (verified):** the `adjust_bot_config` boundary path →
  `drive-target.ts` `adjustConfig` (line 585) runs `BotConfigSchema.safeParse`, whose
  `.refine` at `packages/domain/src/config/schema.ts:776-778` rejects
  `venueType === 'swap' && execution.mode === 'paper'`; it also runs
  `checkModeEscalation` at `drive-target.ts:606`. So paper+swap is still rejected
  behind the boundary.
- **Boundary error code to map:** `validation.invalid_payload` (the schema refine is a
  generic validation failure; the adjust path does **not** surface the dedicated
  `execution_capability.paper_swap_not_supported` code — only the create path does, at
  `drive-target.ts:300-311`). The PATCH route already maps `validation.invalid_payload`
  → 400.
- **Classification:** **safe to remove** (B1.1). The rejection still happens; the only
  change is the error *code* on the adjust path (dedicated → generic). No functional
  test asserts the PATCH path's dedicated code.

### 2. `apps/api/src/routes/capabilities/trading.ts:1286` — agent start (dead code)

- **What it checks:** `validateExecutionCapability({ actorType: 'agent', ... })` inside
  an `if (agentExecMode)` block where `agentExecMode` is hard-coded `undefined`
  (`const agentExecMode: string | undefined = undefined;`). The block is unreachable.
- **Traderton equivalent:** n/a — dead code.
- **Boundary error code to map:** none.
- **Classification:** **safe to remove** (B1.1) — dead code. Also removes the last
  `venueTypeFromProvider` / `validateExecutionCapability` use in this file.

### 3. `apps/worker/src/tools/bots.ts:260` — `adjust_bot_config` tool (mode-rank)

- **What it checks:** `checkModeEscalation(requestedMode, ctx.executionMode)` — rejects a
  bot execution mode that outranks the agent's own, returning `{ success: false, error }`.
- **Traderton equivalent (verified):** the tool now routes through the broker's
  `MANAGE_BOT` path → the boundary's `adjust_bot_config` → `drive-target.ts` `adjustConfig`
  (line 606) runs `checkModeEscalation(adjustedBotMode, deps.ownerMode, 'adjust')`; the
  traderton `adjust_bot_config` tool also re-checks at `tools/bots.ts:965`. The local
  check is defence-in-depth only (its own comment says "The broker re-checks it too").
- **Boundary error code to map:** the mode-escalation message (a thrown `Error` with the
  same human-readable text the local check produced).
- **Classification:** **safe to remove** (B1.1). The boundary re-checks it.

### 4. `apps/api/src/routes/agents.ts:1276` — agent execution-mode update (agent path)

- **What it checks:** `validateExecutionCapability({ actorType: 'agent', executionMode, venueType })`
  against the agent's active trading connection — rejects `paper` + `swap` for an agent.
- **Traderton equivalent:** **none.** Traderton's `validateExecutionCapability` is only
  called on the **bot** paths (`drive-target.ts:300`, `tools/bots.ts:1185`); the
  agent-direct `submit_decision` / actor-ensure path has no equivalent check.
- **Boundary error code to map:** none exists.
- **Classification:** **goes to B1.2** (heavyweight brief). Dropping it is a behavior
  change, not a pure de-duplication (Brief B O1).

## `venueTypeFromProvider` (not deleted in B1.1)

`venueTypeFromProvider` lives in `execution-capability.ts` but is **not** a capability
check — it is venue-type stamping. It stays in B1.1 (deleted in B1.3 when
`execution-capability.ts` goes). Remaining uses after B1.1:

- `apps/api/src/agents/agent-create-normalization.ts:195` — venue stamping (keep)
- `apps/api/src/routes/agents.ts:1645` — venue stamping (keep)
- `apps/api/src/routes/bots.ts:30` — `normalizeBotConfig` venue stamping (keep)

## B1.1 implementation plan

1. Remove the local `validateExecutionCapability` block at `routes/bots.ts:337-352`
   (PATCH config); drop `validateExecutionCapability` from the `@herobids/domain` import
   (keep `venueTypeFromProvider`).
2. Remove the dead `if (agentExecMode) { ... }` block at
   `routes/capabilities/trading.ts:1279-1298`; drop `validateExecutionCapability` and
   `venueTypeFromProvider` from the import.
3. Remove the `checkModeEscalation` block at `tools/bots.ts:258-264`; drop
   `checkModeEscalation` from the import.
4. Delete `packages/domain/src/trading/mode-rank.ts` and its test
   `packages/domain/src/trading/mode-rank.test.ts`; remove the export from
   `packages/domain/src/index.ts`; remove the `domain-trading-mode-rank` manifest entry
   and its required id.
5. Verify: checker test, both herobids recipes, `pnpm build`, `pnpm lint`, full
   `pnpm vitest run` (clean env). The POST `/bots` create path already proves the
   `execution_capability.paper_swap_not_supported` boundary mapping (unchanged).

## B1.2 (brief, human)

`routes/agents.ts:1276` — the agent-path capability check has no traderton equivalent.
See `decisions/B1.2-agent-path-capability-check.md`.