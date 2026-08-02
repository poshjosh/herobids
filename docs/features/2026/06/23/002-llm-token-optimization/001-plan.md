# LLM Token Optimization — Implementation Plan

**Date:** 2026-06-23  
**Features:** `maxHistoryTokens`, stale tool result truncation, OpenRouter/Anthropic prompt caching  
**Status:** Implemented

---

## Background

Three unimplemented optimizations from `docs/features/pending/010-llm-optimization/001-llm-optimization-gap.md`:

- **#5 `maxHistoryTokens`** — replace the message-count-based trim with a token-budget check
- **#2 Stale tool result truncation** — after N retention turns in a tool loop, truncate older tool results to `maxStaleChars`
- **#1 Prompt caching** — `cache_control: { type: 'ephemeral' }` at the API request level

---

## What is currently in place

### History trimming

`apps/worker/src/agent.ts`, `addToHistory()`:

```typescript
conversationHistory.push({ role, content: normalizedContent });
while (conversationHistory.length > runtimeState.runtimeDescriptor.budgets.maxHistoryMessages) {
  conversationHistory.shift();
}
```

Pure message-count trim. The 20-message window is silent about its actual token cost — a 20-message window can easily hold 200K+ tokens if each tool result is 4K chars.

### Tool result truncation

`addToHistory` accepts `{ truncateToToolBudget: true }`, which slices the result to `maxToolResultChars` **at write time** (one-shot, on the newest entry). There is no retroactive truncation of older entries. Once a tool result is in the history it stays at full size for the rest of the tick.

### Prompt caching

Not implemented. `callOpenAiCompatibleProvider` and `callAnthropicProvider` in `packages/llm/src/llm-provider.ts` send no `cache_control` fields.

---

## Confirmed API behaviour (from Anthropic and OpenRouter docs)

### Anthropic (native `/messages` endpoint)

Two supported approaches:

**A — Automatic caching (new, recommended for multi-turn):**  
Add `cache_control: { type: 'ephemeral' }` as a **top-level field** on the request body. The system automatically places the cache breakpoint at the last cacheable block and advances it as the conversation grows. No per-message markup needed.

```json
{
  "model": "...",
  "max_tokens": 4096,
  "cache_control": { "type": "ephemeral" },
  "system": [{ "type": "text", "text": "..." }],
  "messages": [...]
}
```

**B — Explicit block-level breakpoint:**  
`cache_control` on a content block within the `system` array:

```json
{
  "system": [{ "type": "text", "text": "...", "cache_control": { "type": "ephemeral" } }]
}
```

The current `callAnthropicProvider` passes `system` as a plain string extracted from the messages array and placed at the top level as `system: [{ type: 'text', text: '...' }]`. To use explicit breakpoints the system block needs the `cache_control` field added.

### OpenRouter (OpenAI-compatible `/chat/completions` endpoint)

OpenRouter passes `cache_control` through to Anthropic. Two approaches work:

**A — Automatic caching (top-level):**

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "cache_control": { "type": "ephemeral" },
  "messages": [
    { "role": "system", "content": "..." },
    ...
  ]
}
```

**Important constraint confirmed from OpenRouter docs:** Top-level `cache_control` is only honoured when the request routes to the **Anthropic provider directly**. Bedrock and Vertex AI endpoints are excluded. This is fine for our usage — we use `openrouter` pointing to standard Anthropic models.

**B — Explicit per-block breakpoints:** Same syntax as Anthropic, works across Bedrock and Vertex too, but requires message content to be expressed as typed block arrays rather than plain strings.

### Cache discount rates (confirmed from Anthropic docs)

| Action | Cost multiplier |
|---|---|
| Cache write (5-min TTL) | 1.25× base input price |
| Cache read (hit) | 0.10× base input price |

5-minute TTL refreshes on each use. Within a tick's tool loop all LLM calls share the same system prompt — turns 2+ hit the cache at 10% of normal cost.

### Minimum cacheable prompt length

| Model family | Min tokens |
|---|---|
| Claude Sonnet 4.x | 1,024 tokens |
| Claude Opus 4.5 / 4.6 / 4.7 / 4.8 | 4,096 tokens |
| Claude Haiku 4.5 | 4,096 tokens |
| Claude Haiku 3.5 | 2,048 tokens |

Prompts below the minimum are silently not cached (no error, no write).

---

## Implementation

### Feature 1 — `maxHistoryTokens`

#### What changes

Replace the message-count trim in `addToHistory` with a token-budget trim. Keep `maxHistoryMessages` in the schema for backward-compatibility but make it optional / secondary.

#### Token estimator

No external tokeniser dependency. Use the standard approximation: **1 token ≈ 4 characters** (`Math.ceil(chars / 4)`). This is intentionally conservative — it may over-trim slightly, which is the safe direction.

```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

#### Algorithm

After pushing to `conversationHistory`:

1. Sum `estimateTokens(entry.content)` across all entries.
2. While the sum exceeds `maxHistoryTokens`, `shift()` the oldest entry and subtract its token estimate.
3. Also keep the existing `maxHistoryMessages` guard as a hard ceiling.

Both limits are enforced; whichever fires first wins.

#### Config changes

**`packages/domain/src/config/schema.ts`** — `defaultBudgets` object:

```typescript
defaultBudgets: z.object({
  maxHistoryMessages: z.number().int().min(1),
  maxHistoryTokens: z.number().int().min(1),          // NEW
  maxRecentToolMessages: z.number().int().min(1),
  maxToolResultChars: z.number().int().min(1),
  maxVisibleToolSchemas: z.number().int().min(1),
  maxContextBlockChars: z.number().int().min(1),
}),
```

**`packages/domain/src/runtime-composition.ts`** — `RuntimeBudgetPolicy`:

```typescript
export interface RuntimeBudgetPolicy {
  maxHistoryMessages: number;
  maxHistoryTokens: number;   // NEW
  maxRecentToolMessages: number;
  maxToolResultChars: number;
  maxVisibleToolSchemas: number;
  maxContextBlockChars: number;
}
```

**`config/default.yaml`**:

```yaml
defaultBudgets:
  maxHistoryMessages: 20
  maxHistoryTokens: 40000      # NEW — ~160KB of text; safety net
  maxRecentToolMessages: 6
  maxToolResultChars: 4000
  ...
```

**`apps/worker/src/agent.ts`** — `addToHistory`:

```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function addToHistory(role: 'user' | 'assistant', content: string, options?: { truncateToToolBudget?: boolean }): void {
  const normalizedContent = options?.truncateToToolBudget
    ? content.slice(0, runtimeState.runtimeDescriptor.budgets.maxToolResultChars)
    : content;
  if (normalizedContent.length === 0) return;

  conversationHistory.push({ role, content: normalizedContent });

  // Token-budget trim (primary)
  const maxTokens = runtimeState.runtimeDescriptor.budgets.maxHistoryTokens;
  let totalTokens = conversationHistory.reduce((sum, e) => sum + estimateTokens(e.content), 0);
  while (conversationHistory.length > 1 && totalTokens > maxTokens) {
    const removed = conversationHistory.shift()!;
    totalTokens -= estimateTokens(removed.content);
  }

  // Message-count trim (secondary hard ceiling)
  while (conversationHistory.length > runtimeState.runtimeDescriptor.budgets.maxHistoryMessages) {
    conversationHistory.shift();
  }
}
```

> Keep `conversationHistory.length > 1` guard in the token loop so the latest entry is never trimmed away.

#### Tests to update

All tests that assert `maxHistoryMessages: 20` and `maxToolResultChars: 4000` on config objects will need a `maxHistoryTokens: 40000` (or whatever sentinel) added. Files:

- `apps/worker/src/config.test.ts` (many snapshots)
- `apps/api/src/config.test.ts`
- `apps/api/src/billing/billing-config.test.ts`
- `apps/worker/src/__tests__/integration/config-propagation.integration.test.ts`
- `packages/domain/src/config/schema.test.ts`
- Any fixture helper that spreads `defaultBudgets`

---

### Feature 2 — Stale tool result truncation

#### What changes

After N retention turns in a tool loop, retroactively truncate the content of older `role: 'tool'` messages in the `messages` array inside `runStructuredToolLoop` to `maxStaleChars`.

#### Where to implement

Inside **`apps/worker/src/structured-tool-loop.ts`** — this is the right place because:
- `conversationHistory` in `agent.ts` only holds `user` / `assistant` roles (no `tool` role).
- Tool results are added to the `messages` array inside `runStructuredToolLoop` directly as `{ role: 'tool', ... }`.
- The truncation must happen per-loop, not globally.

#### Algorithm

At the start of each turn in the `for` loop, after incrementing `turnIndex`:

```typescript
// Truncate tool results from turns older than retentionTurns
if (toolResultFullRetentionTurns !== undefined && toolResultMaxStaleChars !== undefined) {
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.addedAtTurn !== undefined) {
      const age = turnIndex - msg.addedAtTurn;
      if (age > toolResultFullRetentionTurns && msg.content.length > toolResultMaxStaleChars) {
        msg.content = msg.content.slice(0, toolResultMaxStaleChars) + '...[truncated]';
      }
    }
  }
}
```

This requires storing `addedAtTurn` on each tool message. Extend `LlmMessage`:

```typescript
// In packages/llm/src/llm-provider.ts
export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; toolName?: string; isError?: boolean; addedAtTurn?: number };
```

And when pushing tool messages in the loop:

```typescript
messages.push({
  role: 'tool',
  content: toolResult ?? '',
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  isError: toolResult === null,
  addedAtTurn: turnIndex,   // NEW
});
```

#### New options on `StructuredToolLoopOptions`

```typescript
export interface StructuredToolLoopOptions {
  // ... existing fields ...
  /** After this many retention turns, truncate older tool results. Omit to disable. */
  toolResultFullRetentionTurns?: number;
  /** Max chars to keep in a stale tool result (appends '...[truncated]'). Required if toolResultFullRetentionTurns is set. */
  toolResultMaxStaleChars?: number;
}
```

#### Config changes

**`packages/domain/src/config/schema.ts`** — `defaultBudgets`:

```typescript
defaultBudgets: z.object({
  // ... existing ...
  toolResultFullRetentionTurns: z.number().int().min(0).optional(),   // NEW
  toolResultMaxStaleChars: z.number().int().min(1).optional(),        // NEW
}),
```

Both are optional — if absent, stale truncation is disabled. This avoids a breaking change for callers that do not care.

**`packages/domain/src/runtime-composition.ts`** — `RuntimeBudgetPolicy`:

```typescript
export interface RuntimeBudgetPolicy {
  // ...
  toolResultFullRetentionTurns?: number;   // NEW
  toolResultMaxStaleChars?: number;        // NEW
}
```

**`config/default.yaml`**:

```yaml
defaultBudgets:
  # ...
  toolResultFullRetentionTurns: 3    # NEW — keep full results for 3 turns, truncate older
  toolResultMaxStaleChars: 500       # NEW — stale results trimmed to 500 chars
```

#### Wiring in `agent.ts`

When invoking `runStructuredToolLoop` for both scout and judge loops, pass the new options:

```typescript
const budgets = runtimeState.runtimeDescriptor.budgets;

const judgeLoopResult = await runStructuredToolLoop({
  // ...existing options...
  toolResultFullRetentionTurns: budgets.toolResultFullRetentionTurns,
  toolResultMaxStaleChars: budgets.toolResultMaxStaleChars,
});
```

Same for the scout loop.

---

### Feature 3 — Prompt caching

#### Strategy

Use **automatic caching** (top-level `cache_control`) for both the OpenRouter and Anthropic code paths. This is the simplest approach: one field on the request body, no restructuring of message content needed.

- **OpenRouter**: add `requestBody['cache_control'] = { type: 'ephemeral' }` in `callOpenAiCompatibleProvider` when `config.provider === 'openrouter'`.
- **Anthropic native**: add `cache_control: { type: 'ephemeral' }` to the top-level request body in `callAnthropicProvider`.

Both are confirmed to be supported by the current API versions.

#### File: `packages/llm/src/llm-provider.ts`

**In `callOpenAiCompatibleProvider`**, after `requestBody` is assembled and before the `fetch` call:

```typescript
// Enable provider-side prompt caching for OpenRouter → Anthropic models.
// Top-level cache_control triggers automatic caching: system prompt + conversation
// history up to the last cacheable block are cached at ~10% of normal input cost
// on cache hits (5-minute TTL, refreshed on use). Only routes to Anthropic directly
// — Bedrock/Vertex endpoints are excluded by OpenRouter automatically.
if (config.provider === 'openrouter') {
  requestBody['cache_control'] = { type: 'ephemeral' };
}
```

**In `callAnthropicProvider`**, add `cache_control` to the `requestBody`:

```typescript
const requestBody: Record<string, unknown> = {
  model: config.model,
  max_tokens: maxTokens,
  temperature,
  system: [{ type: 'text', text: systemMessage?.content ?? '' }],
  messages: toAnthropicMessages(chatMessages),
  cache_control: { type: 'ephemeral' },   // NEW
};
```

Note: `cache_control` at the top level is distinct from `cache_control` inside content blocks. The Anthropic API accepts it at both positions.

#### No config flag needed

Caching is always-on for these two providers. It degrades silently for prompts below the minimum token threshold (e.g. unit tests with tiny prompts simply won't cache — no error is thrown). There is no cost if no cache hit occurs — the write is 1.25× base, the read is 0.10× base, and the net over a 20-turn loop is strongly positive. Adding a feature flag would add complexity with no benefit.

#### Cache hit tracking in `LlmResponse`

The `cached` field already exists on `LlmResponse` but is hardcoded to `false` everywhere. Update both providers to detect cache hits:

**OpenRouter response** — check `usage.prompt_tokens_details.cached_tokens`:

```typescript
const cachedTokens = (data.usage as Record<string, unknown> | undefined)?.['prompt_tokens_details'] as { cached_tokens?: number } | undefined;
return {
  ok: true,
  data: {
    // ...
    cached: (cachedTokens?.cached_tokens ?? 0) > 0,
    // ...
  },
};
```

**Anthropic response** — check `usage.cache_read_input_tokens`:

```typescript
const cacheReadTokens = (data.usage as Record<string, unknown>)?.['cache_read_input_tokens'] as number | undefined;
return {
  ok: true,
  data: {
    // ...
    cached: (cacheReadTokens ?? 0) > 0,
    // ...
  },
};
```

---

## Files changed summary

| File | Change |
|---|---|
| `packages/domain/src/config/schema.ts` | Add `maxHistoryTokens`, `toolResultFullRetentionTurns?`, `toolResultMaxStaleChars?` to `defaultBudgets` |
| `packages/domain/src/runtime-composition.ts` | Add same three fields to `RuntimeBudgetPolicy` |
| `config/default.yaml` | Add default values for all three fields |
| `packages/llm/src/llm-provider.ts` | Add top-level `cache_control` to OpenRouter and Anthropic requests; set `cached` from response usage |
| `packages/llm/src/llm-provider.ts` | Add `addedAtTurn?: number` to `LlmMessage` tool role |
| `apps/worker/src/agent.ts` | Add `estimateTokens()`, update `addToHistory()` with token-budget trim |
| `apps/worker/src/agent.ts` | Pass `toolResultFullRetentionTurns` / `toolResultMaxStaleChars` to both `runStructuredToolLoop` calls |
| `apps/worker/src/structured-tool-loop.ts` | Add new options; stamp `addedAtTurn` on tool messages; truncate stale tool results each turn |
| Test snapshots (many) | Add `maxHistoryTokens: 40000` (or sentinel) wherever `defaultBudgets` shape is asserted |

---

## Order of implementation

1. **Schema + config** — add the three new fields to `schema.ts`, `runtime-composition.ts`, and `config/default.yaml`. Fix all snapshot tests. Lint passes.
2. **`maxHistoryTokens`** — add `estimateTokens()` and update `addToHistory()` in `agent.ts`.
3. **Stale tool truncation** — extend `LlmMessage`, update `structured-tool-loop.ts`, wire budgets through `agent.ts`.
4. **Prompt caching** — add `cache_control` in `llm-provider.ts` and update `cached` detection.
5. **`pnpm lint && pnpm test`** — all must pass.
