# 006 — Full Prompt Visibility

**Status:** Done  
**Created:** 2026-06-12  
**Goal:** Surface all four LLM prompt surfaces (scout system, scout user-context, judge system, judge user-context) in the frontend so prompt engineers can inspect exactly what the agent sees each tick.

---

## Context

Today only the judge system prompt is persisted (`agent:prompt:${agentId}`, 1 hr TTL) and shown in the UI. The scout system prompt, scout user-context, and judge user-context are ephemeral — computed, sent to the LLM, then discarded. This makes prompt debugging opaque.

**Option A** (chosen): persist all four surfaces to Redis with an overwrite-per-tick policy, extend the API to return them, and display them in a tabbed card on the agent detail page.

---

## Prompt Surfaces

| Key (Redis) | Content | Source |
|---|---|---|
| `agent:prompt:${id}` | Judge system prompt (already exists) | `composeSystemPrompt()` |
| `agent:prompt:scout:${id}` | Scout system prompt | `buildScoutSystemPrompt()` |
| `agent:prompt:user-context:${id}` | Scout user-context (tick context) | `buildTickUserContext()` |
| `agent:prompt:judge-user-context:${id}` | Judge user-context (tick context + escalation reason) | reconstructed in judge branch |

All keys expire after 3600 s (same as existing judge prompt).

---

## Implementation Plan

### Phase 1 — Worker: persist prompts to Redis

**File:** `apps/worker/src/agent.ts`

1. After line 1481 (scout system prompt built), add:
   ```ts
   await redis.set(`agent:prompt:scout:${AGENT_ID}`, scoutSystemPrompt, 'EX', 3600);
   ```

2. After line 1512 (scout messages assembled), persist the user-context:
   ```ts
   await redis.set(`agent:prompt:user-context:${AGENT_ID}`, userContext, 'EX', 3600);
   ```

3. In the judge branch (after line 1617 where judge user-context is finalized), persist:
   ```ts
   await redis.set(`agent:prompt:judge-user-context:${AGENT_ID}`, fullUserContext, 'EX', 3600);
   ```
   (Use the actual variable name holding the final judge user-context string.)

**Validation:** Run existing tests; no new unit tests needed for Redis writes (side-effect, covered by integration).

---

### Phase 2 — API: extend prompt endpoint

**File:** `apps/api/src/routes/agent-interactivity.ts`

Modify `GET /agents/:id/prompt` (line 239) to fetch all four keys and return a richer shape:

```ts
// Response shape (backward-compatible: old `prompt` field still present)
interface AgentPromptsResponse {
  agentId: string;
  /** @deprecated Use judgeSystem instead */
  prompt: string | null;
  judgeSystem: string | null;
  scoutSystem: string | null;
  userContext: string | null;
  judgeUserContext: string | null;
}
```

Implementation sketch:
```ts
const [judgeSystem, scoutSystem, userContext, judgeUserContext] = await Promise.all([
  redis.get(`agent:prompt:${id}`),
  redis.get(`agent:prompt:scout:${id}`),
  redis.get(`agent:prompt:user-context:${id}`),
  redis.get(`agent:prompt:judge-user-context:${id}`),
]);

if (!judgeSystem && !scoutSystem && !userContext && !judgeUserContext) {
  return reply.status(404).send({ error: 'prompt_not_available' });
}

return {
  agentId: id,
  prompt: judgeSystem,          // backward compat
  judgeSystem,
  scoutSystem,
  userContext,
  judgeUserContext,
};
```

**Validation:** Add/update route test asserting 200 with full shape when keys exist.

---

### Phase 3 — Frontend: tabbed prompt display

**Files:**
- `apps/web/src/lib/api-client.ts` — update `AgentCompiledPrompt` interface
- `apps/web/src/features/agents/AgentDetailPage.tsx` — replace single `<pre>` with tab component

#### 3a. API client type update

```ts
export interface AgentCompiledPrompt {
  agentId: string;
  prompt: string | null;         // deprecated
  judgeSystem: string | null;
  scoutSystem: string | null;
  userContext: string | null;
  judgeUserContext: string | null;
}
```

#### 3b. UI component

Replace the current single-prompt Card content (lines ~328–359) with a tabbed panel:

| Tab label | Data field | Fallback |
|---|---|---|
| Judge System | `judgeSystem` | *(no prompt available)* |
| Scout System | `scoutSystem` | *(no prompt available)* |
| User Context | `userContext` | *(no prompt available)* |
| Judge User Context | `judgeUserContext` | *(no prompt available)* |

Use existing UI primitives (tabs or segmented control already in the design system) or introduce a lightweight `<Tabs>` wrapper. Each tab content renders the same `<pre className="...">` block that currently displays the judge prompt.

**Validation:** Visual check; optional: Playwright snapshot test.

---

## Migration & Rollout

- No database migration required.
- Redis keys auto-expire; no cleanup needed.
- Backward-compatible API response (old `prompt` field preserved).
- Frontend gracefully handles `null` for any surface not yet populated (agent hasn't ticked since deploy).

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Slightly larger Redis memory per agent | 4 keys × ~5 KB avg = ~20 KB/agent; negligible at current scale |
| Stale prompts shown if agent hasn't ticked recently | UI shows "last updated" timestamp (optional enhancement) or "no prompt available" |
| Extra Redis round-trips on API call | Single `Promise.all` with 4 `GET` commands (pipelining) — < 1 ms |

---

## Out of Scope (future)

- Historical prompt retention (ring buffer / time-series).
- Diff view between ticks.
- Per-strategy prompt inspection.
- Role/plan gating (currently open to agent owner, same as existing).

---

## Checklist

- [ ] Worker: persist scout system prompt
- [ ] Worker: persist scout user-context
- [ ] Worker: persist judge user-context
- [ ] API: extend `GET /agents/:id/prompt` response
- [ ] API: route test update
- [ ] Frontend: update `AgentCompiledPrompt` type
- [ ] Frontend: implement tabbed prompt panel
- [ ] `pnpm lint` passes
- [ ] Manual smoke test on dev
