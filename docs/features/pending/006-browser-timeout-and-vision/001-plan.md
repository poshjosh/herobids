# Browser Automation Timeouts and Vision-Default Screenshots

**Status:** Ready to implement
**Estimated effort:** ~1.5 days

## Summary

Browser automation changes the timeout calculus. The current 60s LLM timeout and hardcoded 10s CDP command timeout are insufficient for browser-augmented agent workflows — page loads, screenshot captures, and vision-model inference all add latency that stacks on top of normal model inference time.

This plan increases the LLM timeout, replaces the hardcoded CDP constant with per-action operator-configurable timeouts, and defaults screenshot handling to vision mode (returning base64) with skill instructions documenting the vision capability requirement.

## Problem

An agent using `browse_interactive` to search Google Flights captured a screenshot (200KB+ base64 PNG). The screenshot entered conversation history as a tool result. On the next LLM call, the local 35B quantized model (`qwen3.6:35b-a3b-q4_K_M`) timed out at 60s processing the large context. Retried twice, timed out each time, tick died with `"This operation was aborted"`.

Three issues converged:
1. `llm.timeoutMs` (60s) is too short for vision-capable models processing image context.
2. The single `CDP_COMMAND_TIMEOUT_MS = 10_000` hardcoded constant is wrong for navigation (too short) and wrong for clicks (too generous).
3. The `browse_interactive` skill instructions don't mention that `screenshot` requires a vision-capable model.

## Decisions

1. **Default to vision.** Screenshots return full base64. Most models used for agentic workflows are already vision-capable (including our local test model). In 6 months this will be near-universal. A capable model working well is worth more than protecting an incapable model from failure.

2. **Increase the LLM timeout.** 120s default is more realistic for vision context on local hardware. Cloud models will respond well within this; local models need the headroom.

3. **Per-action browser timeouts from config.** Navigation legitimately takes 30s; a click should complete in 5s. Replace the hardcoded constant with per-action values in operator config.

4. **Skill instructions document the requirement.** The `system/browser` skill text tells the agent that `screenshot` produces image data that requires a vision-capable model, and to use `snapshot` (accessibility tree) if screenshots are not useful.

5. **No automatic fallback.** If a non-vision model receives a screenshot and fails, the error is the expected signal. The operator should either use a vision model or instruct agents to use `snapshot` instead.

## Non-Goals

- Vision model auto-detection (future — can use OpenRouter model metadata or `providers.yaml` flags).
- Configurable screenshot handling mode (`text_summary` / `artifact` / `full_base64`) — defaulting to vision makes this unnecessary for now.
- Token-count-based dynamic timeouts — adds complexity without sufficient payoff.
- Step-level timeouts spanning tool execution + LLM call — architecturally significant change to the tick loop.
- Capability grant timeout enforcement inside `browse_interactive` — worth doing but separate scope.

---

## Detailed Plan

### 1. Increase LLM timeout

**File:** `config/default.yaml`

```yaml
llm:
  timeoutMs: 120000    # was 60000
```

**Why 120s:** Local 35B quantized models need ~90s on large vision context. Cloud models (GPT-4o, Claude) respond in 10-30s even with images. 120s accommodates local hardware with headroom while not being so long that genuine failures hang forever.

**Backward compatible:** Existing deployments with `timeoutMs: 60000` in env or config overrides keep their value. Only the default changes.

### 2. Per-action browser timeouts in operator config

**File:** `packages/domain/src/config/schema.ts`

Add action timeout fields to `BrowserPoolConfigSchema`:

```typescript
export const BrowserPoolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(''),
  apiKey: z.string().default(''),
  maxSessionDurationMs: z.number().int().positive().default(60_000),
  defaultViewport: z.object({
    width: z.number().int().positive().default(1280),
    height: z.number().int().positive().default(720),
  }).default({}),
  // Per-action CDP timeouts (ms). These replace the hardcoded CDP_COMMAND_TIMEOUT_MS.
  actionTimeouts: z.object({
    navigationMs: z.number().int().positive().default(30_000),
    interactionMs: z.number().int().positive().default(5_000),
    screenshotMs: z.number().int().positive().default(10_000),
    snapshotMs: z.number().int().positive().default(10_000),
  }).default({}),
}).default({});
```

**File:** `config/default.yaml`

```yaml
browserPool:
  enabled: true
  url: "http://browser-pool:3000"
  apiKey: ""
  maxSessionDurationMs: 60000
  defaultViewport:
    width: 1280
    height: 720
  actionTimeouts:
    navigationMs: 30000    # page loads, form submissions
    interactionMs: 5000    # click, fill, get_text
    screenshotMs: 10000    # Page.captureScreenshot
    snapshotMs: 10000      # Accessibility.getFullAXTree
```

### 3. Wire action timeouts into `browse_interactive`

**File:** `apps/worker/src/tools/browser.ts`

Remove the hardcoded constant:
```typescript
// DELETE: const CDP_COMMAND_TIMEOUT_MS = 10_000;
```

Add an `ActionTimeouts` interface and accept it in `createBrowserTools`:

```typescript
export interface BrowserActionTimeouts {
  navigationMs: number;
  interactionMs: number;
  screenshotMs: number;
  snapshotMs: number;
}

const DEFAULT_ACTION_TIMEOUTS: BrowserActionTimeouts = {
  navigationMs: 30_000,
  interactionMs: 5_000,
  screenshotMs: 10_000,
  snapshotMs: 10_000,
};

export function createBrowserTools(
  browserPool: BrowserPoolPort | undefined,
  actionTimeouts?: BrowserActionTimeouts,
): AgentTool[] {
```

Update the `CdpClient` to accept a per-call timeout:
```typescript
async send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const timeout = timeoutMs ?? 10_000; // fallback if not specified
  // ... use timeout instead of CDP_COMMAND_TIMEOUT_MS
}

async connect(endpoint: string, timeoutMs?: number): Promise<void> {
  // ... use timeoutMs ?? 10_000
}
```

Each action handler uses the appropriate timeout:
- `handleOpen` → `actionTimeouts.navigationMs` for `Page.navigate` and the `waitForLoad` polling
- `handleClick`, `handleFill`, `handleGetText` → `actionTimeouts.interactionMs`
- `handleScreenshot` → `actionTimeouts.screenshotMs`
- `handleSnapshot` → `actionTimeouts.snapshotMs`

### 4. Forward action timeouts from agent config to tool factory

**File:** `apps/worker/src/agent.ts`

Read `browserPool.actionTimeouts` from the app config (already available via `AGENT_RUNTIME_CONFIG_JSON` or direct config access) and pass to `createBrowserTools`:

```typescript
const browserActionTimeouts = appConfig?.browserPool?.actionTimeouts ?? undefined;
const browserTools = createBrowserTools(browserPool, browserActionTimeouts);
```

**File:** `apps/worker/src/agents/runtime-lifecycle.ts`

If the browser action timeouts aren't already forwarded in `AGENT_RUNTIME_CONFIG_JSON`, add them. Check the existing serialization path — the `agentRuntimeConfigJson` field already carries `tools.codeExecute` defaults. Browser action timeouts should flow the same way.

### 5. Update skill instructions

**File:** `packages/domain/src/skills.ts`

Update `BROWSER_SKILL.instructions` to document the vision requirement for screenshots:

```typescript
instructions: `You have access to browser automation tools.

## Platform browser tool

- Use \`browse_interactive\` for structured browser automation via the platform.
  Actions: open, snapshot, click, fill, screenshot, get_text, close.

### Action guide

- **open** — navigate to a URL. Always call this first to start a session.
- **snapshot** — get the page content as an accessibility tree (text). Fast, lightweight, works with any model. Prefer this for reading page content.
- **screenshot** — capture the page as a PNG image (base64). Requires a vision-capable model to interpret the result. Use when you need to see visual layout, charts, or images that the accessibility tree cannot convey.
- **click** — click an element by CSS selector.
- **fill** — fill a form field by CSS selector and value.
- **get_text** — read text content from an element by CSS selector.
- **close** — release the browser session. Always close when done to free resources.

### Tips

- Use **snapshot** as your default for reading page content — it is fast and produces structured text.
- Use **screenshot** only when visual context matters (layout, charts, images, CAPTCHAs). If screenshot results seem garbled or unusable, your model may not support vision — switch to snapshot.
- Always close browser sessions when done.

## agent-browser CLI
...
```

Keep the existing `agent-browser CLI` section unchanged.

### 6. Increase `maxSessionDurationMs` to match navigation timeout

**File:** `config/default.yaml`

The current `maxSessionDurationMs: 60000` (60s) is the pool-level session lifetime cap. With navigation timeouts up to 30s and agents doing multi-step workflows (open → snapshot → click → snapshot → close), a single session can easily exceed 60s.

```yaml
browserPool:
  maxSessionDurationMs: 120000   # was 60000
```

This gives the agent room for 3-4 navigation steps per session before the pool reclaims it.

---

## Testing

### Config schema
- `BrowserPoolConfigSchema` accepts `actionTimeouts` with all four fields.
- Missing `actionTimeouts` falls back to defaults.
- Partial `actionTimeouts` (e.g. only `navigationMs`) fills in defaults for the rest.

### Browser tool
- `handleOpen` uses `navigationMs` timeout for CDP `Page.navigate` calls.
- `handleClick`/`handleFill`/`handleGetText` use `interactionMs` timeout.
- `handleScreenshot` uses `screenshotMs` timeout.
- `handleSnapshot` uses `snapshotMs` timeout.
- Screenshot returns full base64 (existing behavior unchanged — just no longer times out with a higher LLM timeout).

### Skill instructions
- `BROWSER_SKILL.instructions` contains "vision-capable model" text.
- `BROWSER_SKILL.instructions` recommends `snapshot` as the default for reading page content.

### Integration
- Agent with `qwen3.6:35b-a3b-q4_K_M` (local, vision-capable) can take a screenshot and continue reasoning without timeout at 120s.
- Agent with a non-vision model that takes a screenshot receives base64 in the tool result — the model may or may not handle it, which is the expected behavior.

---

## Rollout

1. **Config changes** — increase `llm.timeoutMs` to 120s, add `actionTimeouts` to `browserPool`, increase `maxSessionDurationMs` to 120s. Backward compatible (defaults change, overrides preserved).
2. **Code changes** — replace hardcoded `CDP_COMMAND_TIMEOUT_MS` with per-action timeouts, update `createBrowserTools` signature, update skill instructions.
3. **Deploy** — no migration needed. Config-only changes take effect on restart.

---

## Effort Estimate

| Item | Estimate |
|------|----------|
| Config schema + default.yaml | ~1 hour |
| Wire action timeouts into CdpClient and action handlers | ~2 hours |
| Forward config to tool factory | ~30 min |
| Update skill instructions | ~30 min |
| Tests | ~2 hours |
| **Total** | **~1.5 days** |

---

## Future Work

- **Vision model auto-detection.** Use OpenRouter model metadata (`architecture.modality`) or a `supportsVision` flag in `providers.yaml` to determine model capabilities at runtime. When known non-vision, the screenshot action could auto-fallback to snapshot with a note. When unknown, default to vision (current behavior).
- **Capability grant timeout enforcement.** The `browse_interactive` tool should enforce the capability grant's `timeoutMs` as an outer bound on the entire tool invocation, not just individual CDP commands.
- **Token-count-based dynamic LLM timeout.** Scale the LLM timeout based on estimated input token count for large-context calls.
