# Simplify Platform Connection UX

## Vision Alignment

OpenAIdom exists to bring AI agents to the masses. Users are not developers. They should never need to understand API keys, credential storage, connection tables, venue accounts, or binding chains. They have one goal: *connect my Hyperliquid account so my agent can trade.*

This plan collapses the current fragmented UI into a single concept:

- **Noun: Connection** — what the user creates and manages
- **Verb: Connect** — what the user does

> "Connect agent to platform", "Connect AI agent" — consistent across every surface.

---

## Problem

### What Users See Today

The sidebar has two items under Manage:
- **Connections** — labeled internally as "advanced, for power users"
- **Credentials** — also labeled "advanced"

This creates immediate confusion:
- What is the difference between a connection and a credential?
- Where do I go to connect my Hyperliquid account?
- Why does Mission Control talk about "linking" but the nav says "Connections"?

### What Is Missing

1. **Creating a connection → no agent assignment step.** After a user creates a platform connection (via Mission Control or the Connections page), nothing asks "which agents should use this?" The user has to manually navigate to each agent's Capability page and bind it there.

2. **Creating an agent → no inline "add new connection".** During agent creation, the "Where to trade" section shows existing connections. If the user doesn't have one yet, they see "Set up trading now" — but if they *do* have connections but want to add a second one, there is no way to do it inline. They must leave the creation flow entirely.

3. **AgentCapabilityPage → no "add new" CTA.** The "Available connections" section lists existing connections but provides no way to create a new one from that page.

4. **Vocabulary mismatch.** Mission Control says "Link", the nav says "Connections", the agent creation form says "Platform link", the capability page says "Available connections". Multiple surfaces, inconsistent language — some using "link" as a verb, some using it as a noun.

---

## Goal

One concept. One word. One flow.

| User intent | Entry point | Result |
|---|---|---|
| "I want to connect my Hyperliquid account" | Sidebar → Connections, or Mission Control | Connection created → agents assigned |
| "I want to create an agent that trades on Hyperliquid" | Create agent → Where to trade | Agent created with connection assigned |
| "I want to connect my agent to an existing account" | Agent Capability page | Connection assigned to agent |
| "I want to add a new account for this agent" | Agent creation or Capability page | Connection created inline, assigned immediately |

---

## Terminology Decisions

**Noun: Connection** (a platform connection)
**Verb: Connect** ("Connect your agent to a platform")
**Page: Connections** (sidebar, URL `/connections` — existing, no rename)

| Old | New |
|---|---|
| Credentials (sidebar) | **Removed from nav** |
| "Available connections" | Keep — already correct |
| "Platform link" (agent creation field label) | Keep — already correct |
| "Set up trading now" button | **"+ Add connection"** (also shown when connections exist) |
| "Connect a provider so..." (Mission Control) | Keep — already correct |
| "Link AI agent" (Mission Control card title) | **"Connect AI agent"** |
| "Link agent to platform" (Mission Control CTA) | **"Connect agent to platform"** |
| "Link agent to platform" (setup form title) | **"Connect agent to platform"** |
| "Link AI agent" (setup form submit button) | **"Connect AI agent"** |

### What Happens to `/credentials`

The page still exists and still works — credential management is real and necessary for power users. It is just removed from the primary nav. It remains accessible:
- Directly at `/credentials` for power users who know it exists
- Potentially linked from the Connections page as "Advanced: manage individual secrets"
- Admin nav if an `isAdmin` gate makes sense

---

## Implementation Scope

### Frontend only. No backend changes required.

The backend already supports everything needed:
- `POST /setup/provider-link` — atomic credential + connection creation ✅
- `PATCH /agents/:id` with `connectionIds` — assigns connections to an agent ✅
- `GET /connections` — lists user's connections ✅
- `GET /agents` — lists agents for the assignment picker ✅

---

## Changes

### 1. Sidebar

**File:** `apps/web/src/app/layout/Sidebar.tsx`

Remove `{ path: '/credentials', label: 'Credentials', icon: '⊛' }` from `MANAGE_ITEMS`.

Keep `{ path: '/connections', label: 'Connections', icon: '⊟' }` — no rename needed. The nav item already says "Connections".

**i18n:**
- `'nav.connections'` — value stays `'Connections'`, no change
- `'nav.credentials'` — remove from the `MANAGE_ITEMS` array (keep the key in the locale file)

---

### 2. Router

**File:** `apps/web/src/app/router.tsx`

No new routes or redirects needed. `/connections` stays as-is.

Keep `{ path: 'credentials', element: <CredentialsPage /> }` — the page stays, just removed from nav.

---

### 3. ConnectionsPage (redesign in place)

**File:** `apps/web/src/features/connections/ConnectionsPage.tsx` (edit existing)

Replace the current low-level `CreateConnectionModal` flow with `ProviderSetupForm`. Remove the "advanced use" subtitle. Add "Used by" agent display per connection card. On successful connection creation, proceed to the **Agent Assignment Step** (see section 6).

**Layout:**
```
Connections
─────────────────────────────────────────────
[+ Add connection]                   (button, top right)

┌─────────────────────────────────────────┐
│ My Hyperliquid Account                  │
│ hyperliquid · active                    │
│ Used by: Alpha Bot, Scout Agent         │  ← agents using this connection
│                                  [Revoke]│
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Jupiter Wallet                          │
│ jupiter · active                        │
│ Used by: (none)                         │
│                                  [Revoke]│
└─────────────────────────────────────────┘

Empty state (no connections):
  "No platform connections yet."
  "Connect a platform so your AI agents can start working."
  [Connect a platform]
```

**"Add connection" / "Connect a platform" button:**
Opens `ProviderSetupForm` in a modal. On success, proceeds to the **Agent Assignment Step**.

**"Used by" agents:**
Query `GET /agents` and cross-reference `agent_connections` to display which agents are using each connection. Read-only display.

**Revoke:**
Calls `connectionsApi.revoke(id)` — same as today.

**i18n keys to add:**
```ts
'connections.addConnection': 'Add connection'
'connections.connectPlatform': 'Connect a platform'
'connections.emptyMessage': 'Connect a platform so your AI agents can start working.'
'connections.usedBy': 'Used by: {agents}'
'connections.usedByNone': 'Not assigned to any agents'
'connections.revokeConfirm': 'Revoke this connection? Agents using it will lose access.'
```

**i18n keys to update:**
```ts
// Remove the "advanced use" subtitle copy
'connections.subtitle': 'Platform accounts your AI agents can use.'
```

---

### 4. Agent Creation — Inline "Add Connection"

**File:** `apps/web/src/features/agents/AgentsPage.tsx`

**Current behaviour:**
- If connections exist: shows connection dropdown with current selection
- If no connections: shows "Set up trading now" button

**New behaviour:**
- Always show the connection picker (dropdown or list)
- Always show **"+ Add connection"** regardless of whether connections exist
- Clicking opens `ProviderSetupForm` in a modal
- On success: the new connection is added to `availableConnections` via query invalidation AND auto-selected in the picker
- Skip the agent assignment step here — the user is already creating an agent that will own it

**Concrete change in the "Where to trade" slot:**

```tsx
// Before: shown only when availableConnections.length === 0
<Button onClick={() => setShowSetup(true)}>Set up trading now</Button>

// After: shown always, as a footer action on the picker
<button onClick={() => setShowSetup(true)} className="add-connection-inline">
  + Add connection
</button>
```

This button appears:
- When `availableConnections.length === 0`: as the primary CTA (replaces "Set up trading now")
- When `availableConnections.length > 0`: as a secondary action below/beside the dropdown

**i18n:**
- `'agents.create.addConnection'`: `'+ Add connection'`
- `'agents.create.setupTradingNow'` — keep key for backwards compat but stop rendering it

---

### 5. AgentCapabilityPage — Add "Add Connection" CTA

**File:** `apps/web/src/features/agents/AgentCapabilityPage.tsx`

In the "Available connections" section, add a `[+ Add connection]` button at the top of the section header, alongside the section title.

Clicking opens `ProviderSetupForm` in a modal. On success:
- Invalidate the `availableConnectionsQuery`
- The new connection appears in the list
- Auto-assign it to this agent: call `agentsApi.update(agentId, { connectionIds: [...currentConnectionIds, newConnectionId] })`

**i18n changes in this file:**
```ts
'agents.capabilityPage.noConnections':
  'No platform connections yet. Add one here or from the Connections page.'
'agents.capabilityPage.bind': 'Assign to agent'   // rename display label
'agents.capabilityPage.unbind': 'Remove'           // rename display label
```

Add:
```ts
'agents.capabilityPage.addConnection': '+ Add connection'
```

---

### 6. Agent Assignment Step (new shared component)

**File:** `apps/web/src/features/setup/AgentAssignmentStep.tsx` (new)

This component is rendered AFTER `ProviderSetupForm` succeeds, in any context where agent assignment makes sense (Connections page, Mission Control).

It is NOT shown in the agent creation flow (the user is already creating the agent).

**Props:**
```ts
interface AgentAssignmentStepProps {
  connectionId: string;
  connectionLabel: string;
  onDone: () => void;  // closes the whole flow
}
```

**UI:**
```
Connection created! ✓ My Hyperliquid Account (hyperliquid)

Which agents should use this connection?

  ☑ Alpha Bot          (trading · running)
  ☐ Scout Agent        (trading · stopped)
  ☐ DCA Agent          (trading · paused)

  (no agents yet — you can assign from an agent's settings later)

[Skip]   [Assign →]
```

**Logic:**
- `GET /agents` to populate the list
- Show all agents — assignment to non-trading agents is harmless
- On "Assign": call `PATCH /agents/:id { connectionIds: [...existing, connectionId] }` for each checked agent
  - Parallel calls, one per selected agent
  - Show loading state
  - On complete: call `onDone()`
- On "Skip": call `onDone()` immediately

**i18n:**
```ts
'setup.agentAssignment.title': 'Which agents should use this connection?'
'setup.agentAssignment.subtitle': 'You can change this later from any agent\'s settings.'
'setup.agentAssignment.skip': 'Skip'
'setup.agentAssignment.assign': 'Assign'
'setup.agentAssignment.noAgents': 'No agents yet. Create an agent and it will appear here.'
'setup.agentAssignment.connectionCreated': '{label} ({provider}) connected successfully.'
```

---

### 7. Mission Control — Update Copy + Add Agent Assignment After Setup

**File:** `apps/web/src/features/mission-control/MissionControlPage.tsx`

**Current flow:**
1. User clicks "Link agent to platform"
2. `ProviderSetupForm` opens
3. On success: success banner shown, modal closes

**New flow:**
1. User clicks "Connect agent to platform"
2. `ProviderSetupForm` opens
3. On success: transition to `AgentAssignmentStep` within the same modal
4. User selects agents (or skips)
5. Modal closes, success message shown

**Concrete change:**
```tsx
// Before: onSuccess closes immediately
const handleSetupSuccess = (result: ProviderSetupResult) => {
  setShowSetup(false);
  setSuccessMessage(...);
};

// After: onSuccess transitions to assignment step
const handleSetupSuccess = (result: ProviderSetupResult) => {
  setSetupResult(result);
  setSetupStep('assign'); // new state: 'setup' | 'assign'
};

const handleAssignmentDone = () => {
  setShowSetup(false);
  setSetupStep('setup');
  setSuccessMessage(...);
};
```

The modal renders either `ProviderSetupForm` or `AgentAssignmentStep` based on `setupStep`.

**i18n keys to update:**
```ts
'missionControl.setup.title': 'Connect AI agent'          // was: 'Link AI agent'
'missionControl.setup.cta': 'Connect agent to platform'    // was: 'Link agent to platform'
'missionControl.setup.successMessage': '{label} ({provider}) is ready for your AI agents.'  // keep
```

---

### 8. i18n — Full Key Inventory

**File:** `apps/web/src/app/i18n/locales/en.ts` (and hi.ts, ar.ts)

**Update existing keys:**

| Key | Old value | New value |
|---|---|---|
| `missionControl.setup.title` | `'Link AI agent'` | `'Connect AI agent'` |
| `missionControl.setup.cta` | `'Link agent to platform'` | `'Connect agent to platform'` |
| `setup.form.title` | `'Link agent to platform'` | `'Connect agent to platform'` |
| `setup.form.tradingTitle` | `'Link agent to platform'` | `'Connect agent to platform'` |
| `setup.form.tradingSubmit` | `'Link AI agent'` | `'Connect AI agent'` |
| `connections.subtitle` | `'Low-level provider connection management — for advanced use...'` | `'Platform accounts your AI agents can use.'` |
| `agents.capabilityPage.noConnections` | `'No platform links yet...'` | `'No platform connections yet. Add one here or from the Connections page.'` |
| `agents.capabilityPage.bind` | `'Bind to agent'` | `'Assign to agent'` |
| `agents.capabilityPage.unbind` | `'Unbind'` | `'Remove'` |

**Add new keys:**

| Key | Value |
|---|---|
| `connections.addConnection` | `'Add connection'` |
| `connections.connectPlatform` | `'Connect a platform'` |
| `connections.emptyMessage` | `'Connect a platform so your AI agents can start working.'` |
| `connections.usedBy` | `'Used by: {agents}'` |
| `connections.usedByNone` | `'Not assigned to any agents'` |
| `connections.revokeConfirm` | `'Revoke this connection? Agents using it will lose access.'` |
| `agents.capabilityPage.addConnection` | `'+ Add connection'` |
| `agents.create.addConnection` | `'+ Add connection'` |
| `setup.agentAssignment.title` | `'Which agents should use this connection?'` |
| `setup.agentAssignment.subtitle` | `'You can change this later from any agent\'s settings.'` |
| `setup.agentAssignment.skip` | `'Skip'` |
| `setup.agentAssignment.assign` | `'Assign'` |
| `setup.agentAssignment.noAgents` | `'No agents yet. Create an agent and it will appear here.'` |
| `setup.agentAssignment.connectionCreated` | `'{label} ({provider}) connected successfully.'` |

**Keep unchanged:**
- `missionControl.setup.message`: `'Connect a provider so your AI agents can use services like Hyperliquid or Gmail.'` ✅
- `missionControl.setup.successMessage`: `'{label} ({provider}) is ready for your AI agents.'` ✅
- `agents.create.whereToTrade`: `'Platform link'` ✅ (field label, keep)
- `agents.capabilityPage.availableConnections`: `'Available connections'` ✅
- `agents.capabilityPage.failedConnections`: `'Failed to load platform links'` → update to `'Failed to load platform connections'`
- `nav.connections`: `'Connections'` ✅

---

## File Change Summary

| File | Action | What |
|---|---|---|
| `apps/web/src/app/layout/Sidebar.tsx` | Edit | Remove Credentials from nav; Connections stays |
| `apps/web/src/app/router.tsx` | Edit | Keep `/connections`; keep `/credentials`; no redirects needed |
| `apps/web/src/features/connections/ConnectionsPage.tsx` | Edit | Replace CreateConnectionModal with ProviderSetupForm; add "Used by" agents; remove "advanced" subtitle |
| `apps/web/src/features/setup/AgentAssignmentStep.tsx` | **New** | Post-setup agent selection component |
| `apps/web/src/features/mission-control/MissionControlPage.tsx` | Edit | Update copy ("Connect" not "Link"); add agent assignment step after setup success |
| `apps/web/src/features/agents/AgentsPage.tsx` | Edit | Add persistent "+ Add connection" in connection picker |
| `apps/web/src/features/agents/AgentCapabilityPage.tsx` | Edit | Add "+ Add connection" CTA; update "bind/unbind" labels; update empty state copy |
| `apps/web/src/app/i18n/locales/en.ts` | Edit | Update and add keys per table above |
| `apps/web/src/app/i18n/locales/hi.ts` | Edit | Matching updates |
| `apps/web/src/app/i18n/locales/ar.ts` | Edit | Matching updates |

---

## Out of Scope

- Backend changes — not needed
- Renaming the DB table `connections` — keep as-is; this is a UI/UX change only
- Credential key rotation UI — keep `/credentials` page functional, just deprioritised from nav
- Non-trading providers (Gmail, Telegram) — the flows are identical; the provider catalog drives available options
- Merging `user_credentials` into `connections` at the DB level — separate decision, separate plan

---

## Execution Order

1. Update i18n keys (en.ts, hi.ts, ar.ts) — no visual change, safe first step
2. New: `AgentAssignmentStep.tsx` component
3. Edit: `ConnectionsPage.tsx` — replace create modal with ProviderSetupForm + agent assignment step
4. Sidebar — remove Credentials from nav
5. Mission Control — update copy + add assignment step after setup
6. AgentsPage — add inline "+ Add connection"
7. AgentCapabilityPage — add "+ Add connection" CTA and update labels
