# Remaining MVP Gaps

This document lists what is still missing to satisfy the MVP acceptance criteria and Step 6/7 deliverables from [001-mvp-delivery-plan.md](./001-mvp-delivery-plan.md).

The MVP backend and communication layer are complete. These are the remaining items before the acceptance criteria can be checked off.

---

## Gap 1 — `send_message` not in `DEFAULT_CAPABILITY_GRANTS`

**File:** `apps/worker/src/agents/capability-policy.ts`

**Problem:**
`DEFAULT_CAPABILITY_GRANTS` defines canonical policy for `decision_submit`, `web_fetch`, `code_execute`, `publish_artifact`, and the `never`-tier capabilities, but `send_message` is absent. The plan (Step 5 deliverable 1) requires explicit brokered tool semantics for `send_message` as a registered capability.

**What to add:**
```ts
{
  capability: 'send_message',
  tier: 'brokered',
  enabled: true,
  limits: { maxPerMinute: 10, maxConcurrent: 5, timeoutMs: 10_000, maxResponseBytes: 4096 },
},
```

**Why it matters:**
Without a registered grant, the capability engine cannot enforce, audit, or override `send_message` policy. The per-preset `toolPolicy` stored on each agent (e.g. `send_message.maxPerMinute: 5`) is never consulted — the broker uses a hardcoded constant instead of the agent's own policy record.

---

## Gap 2 — Broker ignores the agent's persisted `toolPolicy` for `send_message`

**File:** `apps/worker/src/agents/agent-message-broker.ts`

**Problem:**
`handleSendMessage` enforces a hardcoded `SEND_MESSAGE_MAX_PER_MINUTE = 10` constant. The agent's `toolPolicy` field (written at create time from preset defaults, e.g. `{ send_message: { enabled: true, maxPerMinute: 5 } }`) is never read. Step 7 deliverable 2 ("enforce capability and sandbox policy on the production path for enabled capabilities") requires the production path to honour the persisted policy.

**What to change:**
1. After resolving the agent record, read `agent.toolPolicy?.send_message?.maxPerMinute` and use it as the effective rate limit if set, falling back to the capability grant default.
2. Optionally route through `CapabilityPolicyEngine` constructed from the agent's merged grants (preset defaults + any overrides). This is the cleaner path but requires passing the engine (or constructing it inline) with the agent's `toolPolicy` applied over `DEFAULT_CAPABILITY_GRANTS`.

**Minimum acceptable:** read and honour `agent.toolPolicy?.send_message?.maxPerMinute` before the inline rate-limit check.

---

## Gap 3 — UI: No recent decisions card on `AgentDetailPage`

**Files:**
- `apps/web/src/features/agents/AgentDetailPage.tsx`
- `apps/web/src/lib/api-client.ts`
- `apps/api/src/routes/agents.ts`

**Problem:**
The UI has Protocol Activity (raw message type envelopes from `agent_messages`) but does not show actual decisions submitted by the agent. Step 6 deliverable 3 and MVP acceptance criterion 6 both require "recent decisions and outcomes" to be visible.

**What to add:**

API endpoint — add `GET /agents/:id/decisions` to `apps/api/src/routes/agents.ts`:
- Resolve the agent's active link to get `tradingInstanceId`.
- Query the `decisions` table with `actorType = 'agent'` and `actorId = agentId` (or `tradingInstanceId` + `actorType = 'agent'`), ordered by `createdAt` desc, limit 10.
- Return `id`, `intent`, `targetSize`, `limitPrice`, `instrumentId`, `createdAt`.

API client — add `decisions: (id, limit?) => request<AgentDecision[]>(...)` to the `agents` namespace.

UI card — add a "Recent Decisions" card to `AgentDetailPage` below the runtime health card:
- Show `intent`, `instrumentId`, `targetSize` and relative timestamp per row.
- Empty state: "No decisions submitted yet."

---

## Gap 4 — UI: No objective progress card on `AgentDetailPage`

**File:** `apps/web/src/features/agents/AgentDetailPage.tsx`

**Problem:**
The agent's `goal` appears only as a subtitle in the page header. There is no card that ties the agent's current health and activity back to its stated objective. MVP acceptance criterion 6 requires "simple progress toward objective" to be visible in the UI. Step 6 deliverable 4: "a simple progress summary toward the goal."

**What to add:**
A minimal "Objective" card below the Status card containing:
- `goal` text rendered clearly as the agent's stated mission.
- Active time: if there is an `activeSession`, compute elapsed time from `activeSession.startedAt` (needs to be returned by the agent `GET` endpoint).
- Session count from `/agents/:id/sessions` (count of historical sessions) — shows "has run N sessions".
- No AI-generated summary is required; static composition of the above is sufficient.

**API change needed:**
The `activeSession` object returned by `GET /agents/:id` needs to include `startedAt`. Check what `AgentSessionManager` writes and expose it in the agent detail response.

---

## Gap 5 — UI: No artifacts card on `AgentDetailPage`

**File:** `apps/web/src/features/agents/AgentDetailPage.tsx`

**Problem:**
`agentsApi.artifacts(id)` exists and the API endpoint is already implemented, but `AgentDetailPage` never calls it. Step 6 deliverable 6 requires "artifact and activity drill-downs that stay detail-page scoped."

**What to add:**
Add a "Artifacts" card at the bottom of the detail page:
- Call `agentsApi.artifacts(id!, 10)`.
- Render `artifactType`, `summary`, `contentType`, and relative timestamp per row.
- Empty state: "No artifacts published yet."

This is the lowest-effort gap — the API already exists.

---

## Implementation Order

| # | Gap | Effort | Blocks MVP criteria? |
|---|-----|--------|----------------------|
| 1 | `send_message` in capability grants | Trivial | Yes — Step 5/7 |
| 2 | Broker honours agent `toolPolicy` rate limit | Small | Yes — Step 7 |
| 5 | Artifacts card | Trivial | Marginal |
| 4 | Objective/progress card + `startedAt` in response | Small | Yes — criterion 6 |
| 3 | Decisions API endpoint + UI card | Medium | Yes — criterion 6 |

Do gaps 1 and 2 first — they are pure backend and require no frontend changes.
Do gap 5 next — it is a one-liner.
Then gaps 4 and 3 together since both touch the agent detail page in the same editing pass.
