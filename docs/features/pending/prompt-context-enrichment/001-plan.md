# Plan: Prompt Context Enrichment

Enriches the two LLM-facing prompts — the **scanner wake (hybrid evaluator)** and the
**regular tick (judge)** — with context that is currently absent or hard-coded.

Derived from analysis of the aitradingbot reference prompt and gaps identified in the
herobids hybrid/tick decision flow.

---

## Goals

### Scanner wake (hybrid evaluator)
- Auto-inject agent memory (currently inaccessible — no tools allowed in this path)
- Inject last N judge responses so the evaluator knows the agent's recent decisions

### Regular tick (judge)
- Auto-inject agent memory (currently pull-only via `get_memory` tool)
- Add a trading config reference block (strategy params, execution mode, indicator knobs)
- Surface queued wake signals (signals that arrived while the previous tick ran)
- Emphasise the wake trigger (more prominent than the current buried context block)

### Both
- Make all new knobs configurable via `AgentRuntimeConfigSchema` (operator config)
- Fix the existing hardcoded `slice(-10)` judge history limit

---

## Config Schema

Add a `promptEnrichment` section to `AgentRuntimeConfigSchema` in
`packages/domain/src/config/schema.ts`, alongside `contextDiff` and `defaultBudgets`.

```typescript
promptEnrichment: z.object({
  memory: z.object({
    enabled: z.boolean().default(true),
    /** Max memory keys rendered inline. Older keys listed by name with overflow indicator. */
    maxInlineKeys: z.number().int().min(1).max(50).default(12),
  }).default({}),
  judgeHistory: z.object({
    /** Judge responses injected into the hybrid evaluator prompt. */
    hybridMaxResponses: z.number().int().min(0).max(10).default(3),
    /** Judge history messages passed to the judge itself (fixes existing hardcode). */
    tickMaxDisplayed: z.number().int().min(1).max(30).default(10),
  }).default({}),
  configReference: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  queuedSignals: z.object({
    enabled: z.boolean().default(true),
    /** Max queued signals shown. Newer signals shown first. */
    max: z.number().int().min(1).max(10).default(5),
  }).default({}),
  wakeEmphasis: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
}).default({}),
```

Add corresponding defaults to `config/default.yaml` under `agentRuntime.promptEnrichment`.

---

## Implementation Phases

### Phase 1 — Config schema

**Files:** `packages/domain/src/config/schema.ts`, `config/default.yaml`,
`packages/domain/src/config/schema.test.ts`

- Add `promptEnrichment` sub-schema to `AgentRuntimeConfigSchema` as above.
- Add defaults to `config/default.yaml`.
- Add schema parse tests covering defaults and boundary validation.

---

### Phase 2 — Memory auto-injection

**Files:** `apps/worker/src/runtime-composition.ts`, `apps/worker/src/agent.ts`,
`apps/worker/src/hybrid-agent-evaluator.ts`, `apps/worker/src/hybrid-agent-prompt.ts`

#### 2a — Runtime state

Add to `RuntimeSessionMetrics`:

```typescript
/** Agent memory snapshot loaded at tick start. Null until first load. */
agentMemory: Record<string, { value: unknown; updatedAt?: string }> | null;
```

Add helper:

```typescript
export function recordAgentMemory(
  state: RuntimeCompositionState,
  memory: Record<string, string>,  // raw Redis HGETALL output
): void
```

Parse each raw value with `JSON.parse` (fallback to raw string on error). Store parsed
result in `state.metrics.agentMemory`.

#### 2b — Load at tick start

In `agent.ts`, before `buildTickUserContext`, load memory once per tick:

```typescript
if (agentRuntimePolicy.promptEnrichment.memory.enabled) {
  const raw = await redis.hgetall(`agent:memory:${AGENT_ID}`);
  recordAgentMemory(runtimeState, raw ?? {});
}
```

#### 2c — Static context provider (tick prompt)

Add a new `RUNTIME_CONTEXT_PROVIDERS` entry in `runtime-composition.ts`:

```typescript
{
  id: 'agent-memory',
  costTier: 'cheap',
  section: 'static',
  requiredFamilies: [],
  trimOrder: 1,       // after core-platform, before trading-venue
  preserveWhenTrimmed: true,
  build: (state) => {
    const mem = state.metrics.agentMemory;
    if (!mem || Object.keys(mem).length === 0) return null;
    // Sort by updatedAt desc (most recent first), render maxInlineKeys inline,
    // list remaining key names in an overflow line.
    // Format: "**key** (timestamp): value\n"
    // Overflow: "Older keys: key1, key2, ... (+N more — use list_memory_keys tool)"
  },
},
```

`buildSystemPrompt` already calls `buildContextSection(state, 'static')` so this renders
automatically once the provider is registered. No changes to `buildSystemPrompt` needed.

#### 2d — Hybrid evaluator

Extend `HybridEvaluatorInput`:

```typescript
agentMemory?: Record<string, { value: unknown; updatedAt?: string }> | null;
maxInlineMemoryKeys?: number;
```

In `agent.ts`, pass `runtimeState.metrics.agentMemory` and the policy value when calling
`runHybridEvaluator`.

In `buildHybridPrompt`, add a `## Agent Memory` section (same format as the tick provider,
same inline/overflow pattern).

---

### Phase 3 — Judge response history in hybrid prompt

**Files:** `apps/worker/src/agent.ts`, `apps/worker/src/hybrid-agent-evaluator.ts`,
`apps/worker/src/hybrid-agent-prompt.ts`

#### 3a — Ring buffer

Add module-level in `agent.ts` (alongside `conversationHistory`):

```typescript
/** Final no-tool-call assistant responses from past judge ticks, newest last. */
const judgeResponseHistory: string[] = [];
```

After each judge tick completes (when `addToHistory('assistant', assistantResponse)` is
called), also push to `judgeResponseHistory` and trim:

```typescript
judgeResponseHistory.push(assistantResponse);
while (judgeResponseHistory.length > agentRuntimePolicy.promptEnrichment.judgeHistory.tickMaxDisplayed) {
  judgeResponseHistory.shift();
}
```

#### 3b — Pass to hybrid evaluator

Extend `HybridEvaluatorInput`:

```typescript
recentJudgeResponses?: string[];
```

In `agent.ts`, pass `judgeResponseHistory.slice(-policy.judgeHistory.hybridMaxResponses)`.

#### 3c — Render in hybrid prompt

Add `## Recent Agent Decisions` section in `buildHybridPrompt`, between the open positions
table and the signals table:

```
## Recent Agent Decisions
[Tick -2]: Skipped BONK — volume ratio below threshold. Exited JUP at $0.83 (+4.1%).
[Tick -1]: Opened WIF long at $3.01. Regime pass. Passing on RAY (low ADX).
```

Label entries `[Tick -N]` counting back from current (avoids leaking absolute timestamps
that may be stale).

#### 3d — Fix hardcoded slice in judge path

Replace the hardcoded `conversationHistory.slice(-10)` in `agent.ts`:

```typescript
const recentHistory = conversationHistory.slice(
  -agentRuntimePolicy.promptEnrichment.judgeHistory.tickMaxDisplayed,
);
```

---

### Phase 4 — Config reference in tick prompt

**Files:** `apps/worker/src/runtime-composition.ts`

Add a new `RUNTIME_CONTEXT_PROVIDERS` entry:

```typescript
{
  id: 'trading-config-reference',
  costTier: 'cheap',
  section: 'static',
  requiredFamilies: ['trading'],
  trimOrder: 99,          // trim first — informational, not critical
  preserveWhenTrimmed: false,
  build: (state) => {
    // Pull from state.runtimeDescriptor:
    // - executionMode (paper/shadow/live)
    // - riskLimits (SL/TP, maxPositions, maxPositionSizePct, portfolioSL)
    // - decisionMode if available
    // Format as a compact key-value block similar to aitradingbot's ## System Reference
  },
},
```

Gate on `agentRuntimePolicy.promptEnrichment.configReference.enabled`. Pass the policy
into `buildSystemPrompt` (already receives `toolGuidanceByName`, add policy as third param
or extend existing param).

The block renders effective runtime values (what's actually configured), not schema docs.
This is more useful than a generic reference since the agent sees its own live settings.

---

### Phase 5 — Queued signals in tick prompt

**Files:** `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`

#### 5a — Capture signals in polling loop

The current `pollWakeSignals` loop parses wake envelopes and immediately discards the
payload after calling `requestWakeDrivenTick`. Change it to also buffer the signal
summary:

```typescript
// Module-level buffer
const pendingWakeSignalBuffer: Array<{
  source: string;
  reason: string;
  receivedAt: number;
}> = [];
```

When a valid `agent.wake` envelope is received, push `{ source, reason, receivedAt: Date.now() }`
to the buffer before acknowledging.

#### 5b — Drain into metrics at tick start

At the start of `runTick`, drain the buffer into `runtimeState.metrics.queuedWakeSignals`
(excluding the signal that triggered the current tick, which is already in
`currentMarketWake`):

```typescript
export interface RuntimeQueuedWakeSignal {
  source: string;
  reason: string;
  receivedAt: number;
}
// Add to RuntimeSessionMetrics:
queuedWakeSignals: RuntimeQueuedWakeSignal[];
```

After draining, clear the buffer. Apply `max` limit — keep newest N.

#### 5c — Dynamic context provider

Add to `RUNTIME_CONTEXT_PROVIDERS`:

```typescript
{
  id: 'queued-signals',
  costTier: 'free',
  section: 'dynamic',
  requiredFamilies: [],
  trimOrder: 1,         // show near the top of dynamic context
  preserveWhenTrimmed: true,
  build: (state) => {
    if (state.metrics.queuedWakeSignals.length === 0) return null;
    // Format each signal with age: "price:ratchet — WIF crossed ratchet-up (23s ago)"
    // Sort newest first
  },
},
```

---

### Phase 6 — Wake trigger emphasis

**Files:** `apps/worker/src/runtime-composition.ts`

The existing wake context providers (`watch-trigger-context`, `regime-change-context`,
`discovery-trigger-context`) already surface the triggering event in dynamic context.
Two changes:

1. **Instruction line**: Append `→ Prioritize evaluating and acting on this signal.` to
   the `content` of each wake context provider when `wakeEmphasis.enabled` is true. This
   matches the aitradingbot pattern.

2. **`trimOrder`**: Ensure all three wake providers use `trimOrder: 1` and
   `preserveWhenTrimmed: true` (they already do — no change needed there).

Gate the instruction append on `agentRuntimePolicy.promptEnrichment.wakeEmphasis.enabled`.
Pass policy into `buildContextSection` or pass it into each provider's `build` function
via a second argument. The cleanest approach is to add an optional `policy` parameter to
the `build` signature:

```typescript
build: (state: RuntimeCompositionState, policy?: PromptEnrichmentPolicy) => RuntimeContextBlock | null;
```

---

## Files Affected

| File | Change |
|---|---|
| `packages/domain/src/config/schema.ts` | Add `promptEnrichment` to `AgentRuntimeConfigSchema` |
| `packages/domain/src/config/schema.test.ts` | Schema parse tests |
| `config/default.yaml` | Add `agentRuntime.promptEnrichment` defaults |
| `apps/worker/src/runtime-composition.ts` | New context providers, new metrics fields, `recordAgentMemory` helper |
| `apps/worker/src/agent.ts` | Load memory at tick start, judge response ring buffer, queued signal buffer, fix `slice(-10)` hardcode |
| `apps/worker/src/hybrid-agent-evaluator.ts` | Extend `HybridEvaluatorInput` with memory + judge responses |
| `apps/worker/src/hybrid-agent-prompt.ts` | Render `## Agent Memory` and `## Recent Agent Decisions` sections |

---

## Checklist

### Phase 1 — Config schema
- [ ] Add `promptEnrichment` schema to `AgentRuntimeConfigSchema`
- [ ] Add defaults to `config/default.yaml`
- [ ] Schema parse tests for defaults and boundaries

### Phase 2 — Memory auto-injection
- [ ] `agentMemory` field in `RuntimeSessionMetrics`
- [ ] `recordAgentMemory` helper in `runtime-composition.ts`
- [ ] Memory load at tick start in `agent.ts`
- [ ] `agent-memory` static context provider (tick prompt)
- [ ] `agentMemory` + `maxInlineMemoryKeys` in `HybridEvaluatorInput`
- [ ] `## Agent Memory` section in `buildHybridPrompt`
- [ ] Unit test: overflow indicator renders correctly at `maxInlineKeys` boundary

### Phase 3 — Judge response history in hybrid prompt
- [ ] `judgeResponseHistory` ring buffer in `agent.ts`
- [ ] Push to ring buffer after judge `addToHistory('assistant', ...)` call
- [ ] Trim buffer to `tickMaxDisplayed`
- [ ] `recentJudgeResponses` in `HybridEvaluatorInput`
- [ ] Pass `slice(-hybridMaxResponses)` from `agent.ts`
- [ ] `## Recent Agent Decisions` section in `buildHybridPrompt`
- [ ] Fix hardcoded `slice(-10)` → `slice(-tickMaxDisplayed)`
- [ ] Unit test: hybrid prompt omits section when `judgeResponseHistory` is empty

### Phase 4 — Config reference in tick prompt
- [ ] `trading-config-reference` static context provider
- [ ] Gate on `configReference.enabled`
- [ ] Unit test: renders correct values from `runtimeDescriptor`

### Phase 5 — Queued signals in tick prompt
- [ ] `RuntimeQueuedWakeSignal` type + `queuedWakeSignals` in `RuntimeSessionMetrics`
- [ ] `pendingWakeSignalBuffer` in `agent.ts` populated by polling loop
- [ ] Drain + trim buffer at tick start
- [ ] `queued-signals` dynamic context provider
- [ ] Unit test: signals older than current tick are surfaced; current wake is excluded

### Phase 6 — Wake trigger emphasis
- [ ] Append `→ Prioritize...` to wake provider content when `wakeEmphasis.enabled`
- [ ] Policy threading into `build` function signature (or equivalent)
- [ ] Unit test: emphasis line present/absent based on policy flag

### Final
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
