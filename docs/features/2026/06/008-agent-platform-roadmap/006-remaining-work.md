# Remaining Work

**Created:** 2026-06-05 (catch-up audit)
**Roadmap:** [000-roadmap.md](./000-roadmap.md)

This document tracks everything that is not yet `done` across all phases. Each item is scoped to the exact file(s) that need to change and describes precisely what needs to happen. Items are ordered by dependency — work items that unblock others come first.

---

## Phase 1 Remaining

### R1.1 — Rename residue: domain types

**Blocked by:** nothing  
**Blocks:** everything that imports these symbols

**Files:**
- `packages/domain/src/values/ids.ts` — `TradingInstanceId` branded type still exists
- `packages/domain/src/config/schema.ts` — `TradingInstanceConfigSchema` and `TradingInstanceConfig` still exist
- `packages/domain/src/config/index.ts` — re-exports the above

**What to do:**
1. In `ids.ts`: rename `TradingInstanceId` → `BotId`. The branded type alias is a one-liner.
2. In `schema.ts`: rename `TradingInstanceConfigSchema` → `BotConfigSchema`, `TradingInstanceConfig` → `BotConfig`.
3. In `config/index.ts`: update re-export names.
4. Find all import sites: `grep -r "TradingInstanceId\|TradingInstanceConfig" packages/ apps/ --include="*.ts"` — update each.  
   Known current importers: `packages/engine/src/`, `packages/strategy/src/`, `apps/api/src/routes/instances.ts`.

**Commit:** `feat(phase-1): rename TradingInstance* to Bot* in domain types`

---

### R1.2 — Rename API route instances.ts → bots.ts

**Blocked by:** nothing (can run in parallel with R1.1)  
**Blocks:** R1.3 (web rename uses the new route paths)

**Files:**
- `apps/api/src/routes/instances.ts` → rename to `apps/api/src/routes/bots.ts`
- `apps/api/src/routes/instances.test.ts` → rename to `apps/api/src/routes/bots.test.ts`
- `apps/api/src/index.ts` — update import from `./routes/instances.js` → `./routes/bots.js`

**What to do:**
1. Rename files.
2. In `bots.ts`: change route prefix from `/instances` to `/bots`.
3. In `bots.ts`: rename handler variables (`InstancesRoute` → `BotsRoute`; internal vars `instance` → `bot`, `instances` → `bots`).
4. In `apps/api/src/index.ts`: update import.
5. In `bots.test.ts`: update endpoint paths from `/instances` to `/bots`.
6. Update `apps/web/src/lib/api-client.ts`: rename the `instances` namespace → `bots`, update all endpoint paths.

**Note:** The existing `/instances` page in the web app is powered by the current `instances` API client namespace. After this rename, the web client namespace must also change — do both in the same commit.

**Commit:** `feat(phase-1): rename instances route to bots; update API client`

---

### R1.3 — Create /bots web feature page

**Blocked by:** R1.2 (API route must be renamed first)

**Files to create:**
- `apps/web/src/features/bots/BotsPage.tsx`

**Files to update:**
- `apps/web/src/app/router.tsx` — add `/bots` route, keep `/instances` redirect if needed
- `apps/web/src/app/layout/Sidebar.tsx` — update nav link from "Instances"/"Trading" → "Bots", pointing to `/bots`

**What BotsPage needs:**
- List of bots owned by the authenticated user (calls `GET /bots`)
- "Create Bot" button that opens a create form with:
  - `venueAccountId` selector (dropdown of the user's registered venue accounts)
  - `strategyPreset` selector: `momentum` | `dca` | `range` (with description for each)
  - `executionMode` selector: `paper` | `shadow` | `live` (default: `paper`)
  - Optional: `config` JSON editor for power users
- Bot list item shows: name/id, status badge, strategy preset, execution mode, creator (agent name if agent-created, "you" if user-created)
- Empty state: "No bots yet. Create one or let an agent create bots on your behalf."

**Note:** This is a secondary surface (per plan decision). It does not need to be a primary nav item — it can sit under a sub-nav or as a tab on the agent detail page for agent-created bots. The primary path for bot creation is agent-autonomous via `manage_bot`. The `/bots` page is for power users.

**Commit:** `feat(phase-1): add /bots page with create form and strategy presets`

---

### R1.4 — Safety alert wiring: paused_by_guardrail + critical_execution_failure

**Blocked by:** nothing

**Files:**
- `apps/worker/src/agents/agent-session-manager.ts`

**What to do:**

Look for the existing `runtime_failed` and `runtime_unhealthy` alert calls in `agent-session-manager.ts`. Add the two missing calls:

1. `paused_by_guardrail` — should fire when the session manager forcibly pauses an agent due to a platform safety rule (e.g. daily loss limit breach detected in the broker, or an operator-triggered pause). Find the place where `status` is set to `'paused'` by the system (not by user request) and fire the alert there.

2. `critical_execution_failure` — should fire when a reconciliation or execution failure is unrecoverable (e.g. bot in unknown state after reconcile fails three times, session stuck in `launching` past the timeout). Find the error paths in `reconcileStartingSessions` and session health checks; fire there.

Reference: `apps/worker/src/alerting/platform-alert-service.ts` — `PLATFORM_ALERT_EVENTS` defines both event types. The call signature is the same as the existing `runtime_failed` calls.

**Commit:** `feat(phase-1): wire paused_by_guardrail and critical_execution_failure safety alerts`

---

### R1.5 — Delete control in AgentDetailPage

**Blocked by:** nothing

**Files:**
- `apps/web/src/features/agents/AgentDetailPage.tsx`
- `apps/web/src/lib/api-client.ts` (verify `agents.delete()` exists)

**What to do:**
1. Confirm `agentsApi.delete(id)` exists in `api-client.ts` (it should, since the API endpoint is implemented).
2. Add a "Delete agent" button in `AgentDetailPage`. Place it in the header/actions area, visually distinct (destructive color).
3. On click: show a confirmation dialog (native `confirm()` is fine for now) with text: "Delete this agent? This cannot be undone. Any running session will be stopped."
4. On confirm: call `agentsApi.delete(id)`, then navigate to `/agents`.
5. Only show the delete button when `agent.status === 'stopped'` or `agent.status === 'crashed'` — do not allow deletion of running agents from the UI (the API already enforces this, but the UI should not show the button to avoid confusion).

**Commit:** `feat(phase-1): wire delete control in AgentDetailPage`

---

## Phase 2 Remaining

### R2.1 — Activate docker runtime mode in docker-compose.yaml

**Blocked by:** nothing  
**Blocks:** agents actually using real containers in the deployed stack

**Files:**
- `docker-compose.yaml` — `worker` service `environment` block

**What to do:**
Add `AGENT_RUNTIME_MODE: docker` to the `worker` service environment in `docker-compose.yaml`. The env var already exists in `apps/worker/src/index.ts`; it just isn't set in the compose file, so the default `'stub'` is used.

```yaml
# apps/worker/src/index.ts reads AGENT_RUNTIME_MODE; must be 'docker' in production
AGENT_RUNTIME_MODE: docker
```

Also add the agent image reference (already used in index.ts default but good to make explicit):
```yaml
AGENT_IMAGE: herobids-agent:latest
```

**Note:** Once this is set, `docker compose up` will try to launch real agent containers. The `herobids-agent` image must be built first (`docker build -f docker/Dockerfile.agent -t herobids-agent:latest .`). Add a comment in the compose file documenting this dependency.

**Commit:** `feat(phase-2): set AGENT_RUNTIME_MODE=docker in docker-compose.yaml`

---

### R2.2 — Wire SandboxEnforcer on code_execute path in broker

**Blocked by:** nothing

**Files:**
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/agents/sandbox-enforcer.ts` (already exists — read it first)

**What to do:**
1. Read `sandbox-enforcer.ts` to understand the API (`SandboxEnforcer.execute(code, options)` or similar).
2. In `agent-message-broker.ts`, find the `CODE_EXECUTE` message type handler.
3. Import `SandboxEnforcer` and wrap the code execution call with it.
4. Pass the configured `timeoutMs` and `maxResponseBytes` from the `CapabilityPolicyEngine`-resolved grant for `code_execute`.
5. Ensure cleanup runs in `finally` (the sandbox process must be killed even if the broker handler throws).

**Commit:** `feat(phase-2): enforce SandboxEnforcer on code_execute production path`

---

## Phase 3 Remaining

### R3.1 — Strategy preset UI on bot create (blocked on R1.3)

**Blocked by:** R1.3 (`/bots` page)

This is part of the `/bots` page `BotsPage.tsx` create form (described in R1.3 above). The strategy preset selector (`momentum` | `dca` | `range`) is a deliverable of the bots create form.

No separate work item needed — it is captured in R1.3.

---

### R3.2 — Verify and complete progress context in agent prompt tick

**Blocked by:** nothing

**Files:**
- `apps/worker/src/agent.ts`

**What to do:**
1. Read `agent.ts`, specifically the section that builds the LLM prompt for each tick.
2. Verify that the following are included in the prompt context:
   - Net P&L (realized + unrealized, after fees and slippage)
   - Performance score (if defined — see plan 3 for the formula)
   - Elapsed active time
   - Current bot statuses (if the agent has any bots running)
3. If any of these are missing, add them. The data is available via the agent's DB records and the `decisions`/`fills`/`positions` tables.

**Note:** This is a verification step more than a build step. If the data is already injected, mark as done. If not, implement the missing fields.

**Commit (if needed):** `feat(phase-3): inject P&L and performance score into agent prompt context`

---

### R3.3 — 2-step intent + review create flow

**Blocked by:** nothing (but lower priority than R1.x and R2.x)

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx` (or extract to a separate `CreateAgentModal.tsx`)

**What to do:**
The current form collects all fields in one step. The plan specifies a 2-step flow:

- **Step 1 — Intent:** Collect `prompt` (free-text goal) and `skillPreset`. Keep it minimal — just these two fields.
- **Step 2 — Review:** Show a summary: "You're creating a `<skillPreset>` agent with this goal: `<prompt>`. It will be able to `<capabilities from preset>`. Proceed?" Plus optional fields: `name`, `telegramChatId`, `executionMode`, guard rail overrides.

This reduces cognitive load on first creation. The user just describes what they want; the system infers the rest.

**Commit:** `feat(phase-3): split agent create into 2-step intent + review flow`

---

## Priority Order

```
R1.1 (domain rename)     — no deps, do first
R1.2 (API route rename)  — no deps, do alongside R1.1
R1.4 (safety alerts)     — no deps, quick win
R1.5 (delete UI)         — no deps, quick win
R2.1 (docker mode)       — no deps, one-liner, critical for production
R2.2 (sandbox enforcer)  — no deps, security gap
R1.3 (bots page)         — depends on R1.2
R3.1 (strategy presets)  — part of R1.3
R3.2 (progress context)  — no deps, verification first
R3.3 (2-step flow)       — lowest priority
```

---

## Definition of Done for This Document

This document is complete (and can be archived) when every item above is removed, replaced by a `done` entry in the corresponding plan's Progress table.
