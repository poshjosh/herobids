# Implementation Plan: Move Venue to Trading Setup

## Status: Phase 1 — Frontend Only

## Prerequisite

This plan assumes **002-merge-connections-bindings** has completed. All references use
post-merge terminology: `connectionId` (not `tradingBindingId`), `connections` table
(no `trading_bindings`), `capabilitiesApi.tradingConnections()` (not `tradingBindings()`).

## Current State Assessment

Most of Phase 1 from the problem statement is **already implemented**:

| Item | Status | Notes |
|---|---|---|
| Rename "Platform link" → "Where to trade" | ✅ Done | `agents.create.whereToTrade` i18n key |
| Derive venue/venueType from selected connection | ✅ Done | `useEffect` in `CreateAgentFlow` uses `VENUE_TYPE_MAP` |
| Paper mode: show venue dropdown when no connections | ✅ Done | Renders dropdown with hyperliquid/jupiter |
| Remove venue dropdown from TechnicalConfigSection | ✅ Done | `TechnicalConfigSection` has no venue field |
| Validation: venue only required for live/shadow | ✅ Done | `form-validation.ts` gates on `isLiveOrShadow` |
| Inject venue into `technicalFormStateToPayload` | ✅ Done | Create flow passes `intent.venue`, `intent.venueType` |
| `deriveCapabilityMode` unchanged | ✅ Done | `both` no longer triggers venue gate |
| EditAgentModal: inject venue from connection | ❌ Not done | Uses stale stored `technicalConfig.filters.venue` |
| Paper mode: venue dropdown when connections exist but none selected | ❌ Not done | Only shows when `availableConnections.length === 0` |
| Read-only venue display when derived from connection | ✅ Done | Shows "Venue: **X** Type: **Y**" below selector |

## Remaining Work

### Task 1: EditAgentModal — Inject Connection Venue into Technical Payload

**Problem:** `EditAgentModal` calls `technicalFormStateToPayload(form.technicalConfig)` without
external venue/venueType. If the agent's connection changes post-creation, the stored venue
in `technicalConfig.filters.venue` is stale.

**Fix:**

1. In `EditAgentModal`, query the agent's active trading connection:
   ```ts
   const tradingConnectionQuery = useQuery({
     queryKey: ['agents', agentId, 'capabilities', 'trading', 'connections'],
     queryFn: () => agentsApi.tradingConnections(agentId),
     enabled: requiresTradingSetup,
   });
   ```

2. Derive venue/venueType from the connection's `provider`:
   ```ts
   const activeConnection = tradingConnectionQuery.data?.connections
     ?.find(c => c.status === 'active' && c.connectionStatus === 'active');
   const connectionVenue = activeConnection?.provider ?? '';
   const connectionVenueType = VENUE_TYPE_MAP[connectionVenue] ?? '';
   ```

3. Pass derived venue into the mutation's payload builder:
   ```ts
   const technicalPayload = form.technicalPreFilterEnabled
     ? technicalFormStateToPayload(form.technicalConfig, connectionVenue || undefined, connectionVenueType || undefined)
     : null;
   ```

4. Move `VENUE_TYPE_MAP` to a shared module (e.g. `venue-mapping.ts`) importable by
   both `AgentsPage.tsx` and `EditAgentModal.tsx`.

**Files:**
- `apps/web/src/features/agents/venue-mapping.ts` (new — exports `VENUE_TYPE_MAP`)
- `apps/web/src/features/agents/EditAgentModal.tsx` (edit)
- `apps/web/src/features/agents/AgentsPage.tsx` (edit — import from shared module)

### Task 2: Paper Mode Venue Dropdown — Show When Connections Exist But None Selected

**Problem:** If a user has active connections but creates a paper agent WITHOUT selecting one,
there's no way to manually specify a venue. The venue dropdown only renders when
`availableConnections.length === 0`.

**Fix:** Show the venue dropdown in paper mode whenever no connection is selected (regardless
of whether connections exist).

**Logic change in `AgentsPage.tsx` trading binding slot:**
```tsx
{/* Show venue dropdown in paper mode when no connection is selected */}
{intent.executionMode === 'paper' && !intent.connectionId && (
  <div data-field="venue">
    <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.venue' })}</FieldLabel>
    <select value={intent.venue} onChange={...}>
      <option value="">Select venue…</option>
      <option value="hyperliquid">Hyperliquid</option>
      <option value="jupiter">Jupiter</option>
    </select>
    {formErrors.venue && <div ...>{formErrors.venue}</div>}
  </div>
)}
```

This replaces the current check `intent.executionMode === 'paper'` nested inside the
`availableConnections.length === 0` branch.

**Files:**
- `apps/web/src/features/agents/AgentsPage.tsx`

### Task 3: Post-002 Terminology Adaptation

After 002 completes, rename all binding references in the venue-related code:

| Old | New |
|---|---|
| `tradingBindingId` (IntentState field) | `connectionId` |
| `tradingBindingsQuery` | `tradingConnectionsQuery` |
| `availableTradingBindings` | `availableConnections` |
| `selectedTradingBinding` | `selectedConnection` |
| `binding.bindingId` | `connection.id` |
| `binding.provider` | `connection.provider` |
| `binding.connectionStatus` | `connection.status` |
| `capabilitiesApi.tradingBindings()` | `capabilitiesApi.tradingConnections()` |
| `TradingBindingSummary` | `ConnectionSummary` |

**Note:** This task may be fully handled by the 002 plan itself. Verify after 002 completes —
if the form code was updated as part of 002, this task is a no-op.

**Files (if not already done by 002):**
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/lib/api-client.ts`

### Task 4: Cleanup Stale Venue i18n Keys

Remove i18n keys that reference the old "filters.venue.required" message since venue
validation messaging moved from "technical" to "trading setup" context.

**Keys to review/remove:**
- `agents.technical.filters.venue.required` — no longer used; validation uses inline `errors.venue` string

**Files:**
- `apps/web/src/app/i18n/locales/en.ts`
- `apps/web/src/app/i18n/locales/hi.ts`
- `apps/web/src/app/i18n/locales/ar.ts`

## Open Questions — Recommendations

### Q1: What if the user has multiple connections?

**Recommendation:** The selected connection's provider becomes the venue. The UI already
handles this correctly — the user picks one connection from the dropdown, and the `useEffect`
derives venue from that single selection. No change needed.

### Q2: Should changing the connection after agent creation update the technical config venue?

**Recommendation:** **Yes, but lazily.** Implement in Task 1: the EditAgentModal derives venue
from the agent's *current* active connection (not the stored technical config). This means:
- Opening the edit modal shows the live venue (from connection)
- Saving the agent writes the updated venue into the technical config payload
- The stored `technical.filters.venue` is a snapshot at last save, but the scanner reads
  it at runtime, so the next agent session will use the correct venue

This is sufficient for Phase 1. A Phase 2 enhancement could automatically sync venue
when a connection changes via the capability management page (without requiring edit-modal
save), but that's non-essential.

### Q3: The venueType mapping is hardcoded. How to handle new providers?

**Recommendation:** The `VENUE_TYPE_MAP` already includes forward entries:
```ts
const VENUE_TYPE_MAP = {
  hyperliquid: 'orderbook',
  jupiter: 'swap',
  bybit: 'orderbook',
  '1inch': 'swap',
};
```

This is adequate. When a genuinely new provider category appears (e.g., an options venue),
add it to the map. The map is small and changes infrequently — no need for a dynamic
registry or config-driven approach. Keep it as a simple object.

## Out of Scope (Phase 2+)

- Backend: elevate venue to a first-class agent field (agent.venue) separate from technicalConfig
- Backend: agent-intake-resolver auto-populates discovery venue from execution venue
- Auto-sync: connection change → agent venue update without user visiting edit modal
- Multi-venue agents: one agent trading on multiple venues simultaneously

## Execution Order

1. Task 1 (EditAgentModal venue injection) — highest impact fix
2. Task 2 (Paper mode dropdown) — UX improvement
3. Task 3 (Post-002 renames) — mechanical, may be a no-op
4. Task 4 (i18n cleanup) — housekeeping

Total estimated scope: ~4 files modified, 1 new file created, ~50–80 lines of net change.

---

## Outstanding Issues

### [Task 1] EditAgentModal Venue Injection

- **M1**: `agentConnectionsQuery` missing `enabled: requiresTradingSetup` gate (plan deviation). Deliberate — the query feeds multiple consumers, not just venue derivation. Low practical impact.
- **M2**: Venue derived from pre-save DB connections, not form-state connections. If user changes connection in same edit session, venue reflects old connection. Accepted for Phase 1 (lazy approach) per plan.
- **L1**: Redundant `as` cast on `connectionVenueType` in `EditAgentModal.tsx`. TypeScript already infers the correct type. Remove when convenient.
- **L2**: Pre-existing unsafe `as 'orderbook' | 'swap'` cast on `intent.venueType` in `AgentsPage.tsx` line ~345. Align with `|| undefined` pattern.
- **L3**: New `venue-mapping.ts` missing module-level JSDoc. Add brief doc comment.
- **L4**: No test coverage for edit-modal venue derivation. Add unit test.
