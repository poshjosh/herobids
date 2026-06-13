# Blockers preventing agents from trading directly

## Confirmed Blockers

### 1. **Hardcoded PaperExecutor** — agent-intake-resolver.ts
The `AgentIntakeResolver.getIntakeDeps()` always creates a `PaperExecutor`. Even if an agent has `executionMode: 'shadow'` or `'live'` configured in its DB row, direct `submit_decision` calls always simulate fills. The agent's `executionMode` is only passed into the runtime descriptor (for the LLM prompt context and bot creation), never into its own execution path.

**To fix:** The resolver needs to read the agent's configured execution mode, resolve credentials from the binding's venue account, and instantiate the appropriate executor (Shadow/Live) with the necessary venue adapters.

### 2. **No venue port or swap venue wired for agents** — agent-intake-resolver.ts
The `DecisionIntakeDeps` returned for agents omits `venueType`, `swapAssets`, `swapVenue`, `swapTokenSafety`, `swapNetwork`, and `swapBaseTokenAddress`. This means:
- Even if you fix the executor, the **planner** will always emit `'market'` orders (never `'swap'` type)
- Swap token safety pre-execution checks are skipped
- The shadow executor can't fetch real quotes for swap venues

### 3. **No `maxOrderNotional` limit** — agent-intake-resolver.ts
Risk limits are hardcoded to implausibly large values (`maxPositionSize: 1,000,000`, `maxDrawdown: 100,000`). There's no connection to:
- The agent's `capital` field (deployable allocation cap)
- The agent's `dailyLossLimit`
- Any user-configured risk parameters

A human's bot would get proper risk limits from `BotConfigSchema.risk`. The agent's direct path effectively has no risk gate.

## Caveats / Partial Blockers

### 4. **No reconciliation for agent-direct positions**
When a bot trades, the `TradingActor` performs venue state reconciliation on startup and periodically. Agent-direct trades have no reconciliation — if the worker restarts, there's no incomplete-plan recovery for agent-direct positions. For paper mode this is tolerable; for shadow/live it would be dangerous.

### 5. **No mark source used for risk context**
The intake resolver passes `markSource` but doesn't use it to build the risk gate's `currentDrawdown` (passed as `price('0')`). The risk gate's drawdown check is effectively disabled.

### 6. **No position count across instruments for the risk gate**
The agent is multi-symbol capable (the instrument mismatch check is correctly skipped at agent-decision-handler.ts), but when the risk gate receives `openPositionCount`, it only counts positions for the *current* instrument (via `getPosition` for that specific instrument). If the agent holds positions in 3 instruments, `maxOpenPositions` isn't enforced globally.

### 7. **No `credentialUsedEvent` audit for direct agent trades**
When a bot decrypts credentials, it emits `credentialUsedEvent` for audit. The agent intake path has no equivalent — if you add live execution, credential use won't be audited.

### 8. **Agent `executionMode` column comment is misleading**
The column comment in agents.ts says "for bots this agent creates" — implying it was never intended for the agent's own direct trades. But it's passed into the runtime descriptor's `executionMode` field, which the agent runtime reads.

**Resolution:** The column comment is wrong, not the column. `executionMode` should govern the agent's own direct trading mode. The `AgentTradingActor` will read it at construction time to select the appropriate executor. The column comment will be corrected during implementation.

## What Already Works Correctly

- DB schema uses `actorType`/`actorId` (not bot-specific keys) ✓
- Decision, Fill, Position, Order tables all support `actorType='agent'` ✓
- The `intakeResolver` routing correctly falls through from bot registry to agent grants ✓
- The session validity check works for agent-direct decisions (uses `getActiveSession`) ✓
- Multi-symbol trading is allowed for agents (instrument mismatch check skipped) ✓
- Position queries (`getOpenByActor('agent', agentId)`) work correctly ✓
- `list_positions` tool correctly shows agent-owned positions ✓
- The planner and paper executor handle `actorType='agent'` properly ✓

## Summary

The pipeline from "agent calls `submit_decision`" → "broker routes to handler" → "handler resolves deps" → "engine executes" **works end-to-end for paper mode**. But the agent intake resolver is a thin shim that hardcodes paper execution and trivial risk limits, making it impossible for agents to trade shadow or live directly. To reach parity with what a human gets through a bot, the resolver needs: execution mode awareness, venue adapter construction (with credential resolution), proper risk limits, and reconciliation infrastructure.