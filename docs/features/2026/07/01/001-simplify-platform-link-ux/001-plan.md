# Simplify Platform Connection UX

## Vision Alignment

HeroBids exists to bring AI agents to the masses. Users are not developers. They should never need to understand API keys, credential storage, connection tables, venue accounts, or binding chains. They have one goal: *connect my Hyperliquid account so my agent can trade.*

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

Rename `{ path: '/connections', ... }` to `{ path: '/links', label: 'Links', icon: '⊟' }` (or keep path `/connections` with a redirect — see router note below).

**i18n:**
- `'nav.connections'` → `'nav.links'` with value `'Links'`
- `'nav.credentials'` — remove from nav (keep key in file in case it's referenced elsewhere)

---

### 2. Router

**File:** `apps/web/src/app/router.tsx`

Add route `{ path: 'links', element: <LinksPage /> }`.

Keep `{ path: 'connections', element: <Navigate to="/links" replace /> }` as a redirect so existing bookmarks and any in-app deep links continue to work.

Keep `{ path: 'credentials', element: <CredentialsPage /> }` — the page stays, just removed from nav.

---

### 3. LinksPage (new, replaces ConnectionsPage as primary surface)

**File:** `apps/web/src/features/links/LinksPage.tsx` (new file)

This is the user-facing page. It replaces what `ConnectionsPage.tsx` was doing, but uses `ProviderSetupForm` instead of the low-level `CreateConnectionModal`.

**Layout:**
```
Links
─────────────────────────────────────────────
[+ Add link]                         (button, top right)

┌─────────────────────────────────────────┐
│ My Hyperliquid Account                  │
│ hyperliquid · active                    │
│ Used by: Alpha Bot, Scout Agent         │  ← agents using this link
│                                  [Revoke]│
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Jupiter Wallet                          │
│ jupiter · active                        │
│ Used by: (none)                         │
│                                  [Revoke]│
└─────────────────────────────────────────┘

Empty state (no links):
  "No platform links yet."
  "Link a platform so your AI agents can start working."
  [Link a platform]
```

**"Add link" / "Link a platform" button:**
Opens `ProviderSetupForm` in a modal. On success, proceeds to the **Agent Assignment Step** (see section 6 below).

**"Used by" agents:**
Query `GET /agents` and cross-reference `agent_connections` to display which agents are using each link. This is read-only display. The API already supports querying agent connections.

**Revoke:**
Calls `connectionsApi.revoke(id)` — same as today.

**i18n keys to add:**
```ts
'links.title': 'Links'
'links.subtitle': 'Platform accounts your AI agents can use.'
'links.addLink': 'Add link'
'links.linkPlatform': 'Link a platform'
'links.empty': 'No platform links yet.'
'links.emptyMessage': 'Link a platform so your AI agents can start working.'
'links.usedBy': 'Used by: {agents}'
'links.usedByNone': 'Not assigned to any agents'
'links.revoke': 'Revoke'
'links.revokeConfirm': 'Revoke this link? Agents using it will lose access.'
```

---

### 4. Agent Creation — Inline "Add New Link"

**File:** `apps/web/src/features/agents/AgentsPage.tsx`

**Current behaviour:**
- If connections exist: shows connection dropdown with current selection
- If no connections: shows "Set up trading now" button

**New behaviour:**
- Always show the connection picker (dropdown or list)
- At the bottom of the picker (or as a footer action), always show **"+ Add new link"** regardless of whether connections exist
- Clicking "Add new link" opens `ProviderSetupForm` in a modal
- On success: the new connection is added to `availableConnections` via query invalidation AND auto-selected in the picker
- Skip the agent assignment step here — the user is already creating an agent that will own it

**Concrete change in the "Where to trade" slot:**

```tsx
// Before: shown only when availableConnections.length === 0
<Button onClick={() => setShowSetup(true)}>Set up trading now</Button>

// After: shown always, either as part of the picker footer or as a standalone link
<button onClick={() => setShowSetup(true)} className="add-link-inline">
  + Add new link
</button>
```

This button appears:
- When `availableConnections.length === 0`: as the primary CTA (replaces "Set up trading now")
- When `availableConnections.length > 0`: as a secondary action below/beside the dropdown

**i18n:**
- `'agents.create.addNewLink'`: `'+ Add new link'`
- Remove or repurpose `'agents.create.setupTradingNow'` → keep for backwards compat but no longer rendered

---

### 5. AgentCapabilityPage — Add "Add Link" CTA

**File:** `apps/web/src/features/agents/AgentCapabilityPage.tsx`

In the "Available links" section (renamed from "Available connections"), add a `[+ Add link]` button at the top of the section header, alongside the section title.

Clicking opens `ProviderSetupForm` in a modal (same as agent creation). On success:
- Invalidate the `availableConnectionsQuery`
- The new link appears in the list
- Auto-bind it to this agent: call `agentsApi.update(agentId, { connectionIds: [...currentConnectionIds, newConnectionId] })`

**i18n changes in this file:**
```ts
'agents.capabilityPage.availableConnections' → 'agents.capabilityPage.availableLinks': 'Available links'
'agents.capabilityPage.noConnections' → 'agents.capabilityPage.noLinks':
  'No platform links yet. Add one here or from the Links page.'
'agents.capabilityPage.failedConnections' → 'agents.capabilityPage.failedLinks': 'Failed to load platform links'
'agents.capabilityPage.bind' → keep as 'agents.capabilityPage.bind': 'Assign to agent'  (rename label)
'agents.capabilityPage.unbind' → keep as 'agents.capabilityPage.unbind': 'Remove'
```

Add:
```ts
'agents.capabilityPage.addLink': '+ Add link'
```

---

### 6. Agent Assignment Step (new shared component)

**File:** `apps/web/src/features/setup/AgentAssignmentStep.tsx` (new)

This component is rendered AFTER `ProviderSetupForm` succeeds, in any context where agent assignment makes sense (Links page, Mission Control).

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
Link created! ✓ My Hyperliquid Account (hyperliquid)

Which agents should use this link?

  ☑ Alpha Bot          (trading · running)
  ☐ Scout Agent        (trading · stopped)
  ☐ DCA Agent          (trading · paused)

  (no agents yet — you can assign from an agent's settings later)

[Skip]   [Assign →]
```

**Logic:**
- `GET /agents` to populate the list
- Filter to agents that have a trading skill (or simply show all — assignment to non-trading agents is harmless, the agent just won't use it unless it has the skill)
- On "Assign": call `PATCH /agents/:id { connectionIds: [...existing, connectionId] }` for each checked agent
  - Parallel calls, one per selected agent
  - Show loading state
  - On complete: call `onDone()`
- On "Skip": call `onDone()` immediately

**i18n:**
```ts
'setup.agentAssignment.title': 'Which agents should use this link?'
'setup.agentAssignment.subtitle': 'You can change this later from any agent\'s settings.'
'setup.agentAssignment.skip': 'Skip'
'setup.agentAssignment.assign': 'Assign'
'setup.agentAssignment.noAgents': 'No agents yet. Create an agent and it will appear here.'
'setup.agentAssignment.linkCreated': '{label} ({provider}) linked successfully.'
```

---

### 7. Mission Control — Add Agent Assignment After Setup

**File:** `apps/web/src/features/mission-control/MissionControlPage.tsx`

**Current flow:**
1. User clicks "Link agent to platform"
2. `ProviderSetupForm` opens
3. On success: success banner shown, modal closes

**New flow:**
1. User clicks "Link agent to platform"
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
  setSetupResult(result);  // new state
  setSetupStep('assign'); // new state: 'setup' | 'assign'
};

const handleAssignmentDone = () => {
  setShowSetup(false);
  setSetupStep('setup');
  setSuccessMessage(...);
};
```

The modal renders either `ProviderSetupForm` or `AgentAssignmentStep` based on `setupStep`.

---

### 8. i18n — Full Key Inventory

**File:** `apps/web/src/app/i18n/locales/en.ts` (and hi.ts, ar.ts)

| Old key | New key | New value |
|---|---|---|
| `nav.connections` | `nav.links` | `'Links'` |
| *(remove from nav)* | `nav.credentials` | *(keep key, value `'Credentials'`, just not in sidebar array)* |
| `agents.capabilityPage.availableConnections` | `agents.capabilityPage.availableLinks` | `'Available links'` |
| `agents.capabilityPage.noConnections` | `agents.capabilityPage.noLinks` | `'No platform links yet. Add one here or from the Links page.'` |
| `agents.capabilityPage.failedConnections` | `agents.capabilityPage.failedLinks` | `'Failed to load platform links'` |
| *(add)* | `agents.capabilityPage.addLink` | `'+ Add link'` |
| *(add)* | `agents.capabilityPage.bind` (rename display) | `'Assign to agent'` |
| *(add)* | `agents.create.addNewLink` | `'+ Add new link'` |
| *(add)* | `links.title` | `'Links'` |
| *(add)* | `links.subtitle` | `'Platform accounts your AI agents can use.'` |
| *(add)* | `links.addLink` | `'Add link'` |
| *(add)* | `links.linkPlatform` | `'Link a platform'` |
| *(add)* | `links.empty` | `'No platform links yet.'` |
| *(add)* | `links.emptyMessage` | `'Link a platform so your AI agents can start working.'` |
| *(add)* | `links.usedByNone` | `'Not assigned to any agents'` |
| *(add)* | `setup.agentAssignment.title` | `'Which agents should use this link?'` |
| *(add)* | `setup.agentAssignment.subtitle` | `'You can change this later from any agent\'s settings.'` |
| *(add)* | `setup.agentAssignment.skip` | `'Skip'` |
| *(add)* | `setup.agentAssignment.assign` | `'Assign'` |
| *(add)* | `setup.agentAssignment.noAgents` | `'No agents yet. Create an agent and assign links from there.'` |
| *(add)* | `setup.agentAssignment.linkCreated` | `'{label} ({provider}) linked successfully.'` |

**Keep unchanged (already correct):**
- `missionControl.setup.title`: `'Link AI agent'` ✅
- `missionControl.setup.cta`: `'Link agent to platform'` ✅
- `missionControl.setup.message`: `'Connect a provider so your AI agents can use services like Hyperliquid or Gmail.'` ✅
- `setup.form.title`: `'Link agent to platform'` ✅
- `setup.form.tradingSubmit`: `'Link AI agent'` ✅
- `agents.create.whereToTrade`: `'Platform link'` ✅ (field label, keep)

---

## File Change Summary

| File | Action | What |
|---|---|---|
| `apps/web/src/app/layout/Sidebar.tsx` | Edit | Remove Credentials from nav; rename Connections → Links at `/links` |
| `apps/web/src/app/router.tsx` | Edit | Add `/links` route; redirect `/connections` → `/links`; keep `/credentials` |
| `apps/web/src/features/links/LinksPage.tsx` | **New** | User-facing Links page using ProviderSetupForm |
| `apps/web/src/features/setup/AgentAssignmentStep.tsx` | **New** | Post-setup agent selection component |
| `apps/web/src/features/mission-control/MissionControlPage.tsx` | Edit | Add agent assignment step after setup success |
| `apps/web/src/features/agents/AgentsPage.tsx` | Edit | Add persistent "+ Add new link" in connection picker |
| `apps/web/src/features/agents/AgentCapabilityPage.tsx` | Edit | Add "+ Add link" CTA; rename "connections" → "links" labels |
| `apps/web/src/app/i18n/locales/en.ts` | Edit | Add/rename keys per table above |
| `apps/web/src/app/i18n/locales/hi.ts` | Edit | Matching updates |
| `apps/web/src/app/i18n/locales/ar.ts` | Edit | Matching updates |

---

## Out of Scope

- Backend changes — not needed
- Renaming the DB table `connections` — keep as-is; this is a UI/UX rename only
- Credential key rotation UI — keep `/credentials` page functional, just deprioritise from nav
- Non-trading providers (Gmail, Telegram) — the flows are identical; the provider catalog drives available options
- Merging `user_credentials` into `connections` at the DB level — separate decision, separate plan

---

## Execution Order

1. Add i18n keys (en.ts, hi.ts, ar.ts) — no visual change, safe first step
2. New: `AgentAssignmentStep.tsx` component
3. New: `LinksPage.tsx`
4. Sidebar + Router changes (switches nav to new page)
5. Mission Control — add assignment step after setup
6. AgentsPage — add inline "+ Add new link"
7. AgentCapabilityPage — add "+ Add link" CTA and rename labels
