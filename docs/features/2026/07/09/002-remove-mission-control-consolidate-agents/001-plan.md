# Remove Mission Control — Consolidate into AI Agents Page

**Created:** 2026-07-09
**Status:** in-progress
**Depends on:** none
**Branch:** `remove-mission-control`

## Problem

The app has two overlapping pages that both center on AI agents:

- **Mission Control** (`/mission-control`) — a read-only dashboard with metrics, an agent list, a setup card, and an activity preview. Every CTA on this page already redirects to `/agents?create=1`.
- **AI Agents** (`/agents`) — agent list with outcomes, plus the full create-agent flow.

This split forces users to navigate between two pages for the same domain. Mission Control adds no unique workflows — it's a pass-through layer that duplicates the agent list and adds a few dashboard widgets.

## Goal

1. **Delete** the Mission Control page and its dedicated route.
2. **Move** its dashboard widgets (metrics, setup card, activity preview) into the AI Agents page, making `/agents` the single home for authenticated users.
3. **Reserve `/`** for the future public landing page (design TBD). For now, authenticated users at `/` redirect to `/agents`.
4. **Add a compatibility redirect** from `/mission-control` → `/agents` so bookmarks and external links don't break.

## Non-Goals

- Designing or building the public landing page at `/` — that's a separate feature.
- Redesigning the Agents page layout beyond accommodating the moved sections.
- Consolidating `missionControl.*` i18n keys into `agents.*` — keep existing keys working, rename later.
- Changing the `/activity` page — it remains the dedicated full activity feed.
- Changing the `/outcomes`, `/exposure`, or `/bots` pages.

## Design

### Route Changes

```text
BEFORE                              AFTER
─────────────────────────────────────────────────────────────
/  → redirect /mission-control      /  → public landing page (placeholder for now)
                                    /  → (auth'd users) redirect /agents
/mission-control  → dashboard       /mission-control  → 301 redirect /agents
/agents           → agent list      /agents           → home (dashboard + agent list)
```

The router restructure:

- **`/` as a public route**: move the index route outside `RootLayout` so unauthenticated visitors land there. For now it renders a minimal placeholder (`LandingPagePlaceholder`) that links to `/login` or `/agents` depending on auth state. The real landing page replaces this later.
- **`/` for authenticated users**: inside `RootLayout`, add `{ index: true, element: <Navigate to="/agents" replace /> }` so signed-in users skip the landing page.
- **`/mission-control` redirect**: add a route inside `RootLayout` that redirects to `/agents` with `replace`.

### What Moves to `/agents`

From `MissionControlPage` into `AgentsPage`:

| Section | Placement on `/agents` |
|---|---|
| 5 metric cards (Active / Paused / Unhealthy / Stopped / Total P&L) | Row below the page header, above the agent list |
| "Connect AI agent to external platform" setup card | Dismissible banner between metrics and agent list (hidden when no agents exist) |
| Recent activity feed | Right sidebar or collapsible panel; "View all →" links to `/activity` |
| ProviderSetupForm + AgentAssignmentStep modals | Same modal pattern, triggered from the setup card |

### What Stays on `/agents` (unchanged)

- Page header ("AI Agents" title, subtitle, "New AI Agent" button)
- Agent list with outcomes
- Create Agent Flow modal (intent → review)

### Component Extraction

The `MetricCard` component is currently defined inside `MissionControlPage.tsx`. Extract it to `apps/web/src/lib/ui.tsx` (alongside other shared UI primitives) so both the old page (during transition) and the new Agents page can use it.

The setup flow (`ProviderSetupForm` + `AgentAssignmentStep`) is already imported from shared feature modules — no extraction needed.

### Data Fetching on `/agents`

The Agents page currently fetches:
- `agentsApi.list()` → agent list
- `agentsApi.outcomes()` → outcomes per agent
- `skillsApi.list()` → selectable skills (for create modal)

After consolidation, it additionally fetches:
- `dashboard.overview()` → P&L for the Total Realized P&L metric card
- `dashboard.activity({ limit: 8 })` → recent bot-level activity
- `dashboard.agentActivity({ limit: 8 })` → recent agent-level activity

These queries already exist in `MissionControlPage` and are lightweight — the dashboard endpoints are designed for frequent polling.

The event stream subscription (`useEventStream`) for live invalidation also moves to `AgentsPage`.

## Implementation Tasks

### Phase 1: Route & Navigation (foundation)

- [ ] **1.1** `apps/web/src/app/router.tsx`
  - Remove `MissionControlPage` import.
  - Add landing page placeholder import (create a minimal `LandingPagePlaceholder` component).
  - Move the root index route outside `RootLayout` to serve the landing page publicly.
  - Inside `RootLayout`, add `{ index: true, element: <Navigate to="/agents" replace /> }` for authenticated users.
  - Remove the `mission-control` route.
  - Add `{ path: 'mission-control', element: <Navigate to="/agents" replace /> }` for backward compat.

- [ ] **1.2** `apps/web/src/app/layout/Sidebar.tsx`
  - Remove `{ path: '/mission-control', label: …, icon: '◈' }` from `NAV_ITEMS`.
  - `AI Agents` becomes the first (default) nav item.

- [ ] **1.3** Redirect target updates (4 files)
  - `apps/web/src/features/auth/AuthCallbackPage.tsx`: `navigate('/mission-control')` → `navigate('/agents')`
  - `apps/web/src/features/auth/LoginPage.tsx`: `navigate('/mission-control')` → `navigate('/agents')`
  - `apps/web/src/features/admin/AdminPage.tsx`: `<Navigate to="/mission-control">` → `<Navigate to="/agents">`
  - `apps/web/src/app/NotFoundPage.tsx`: `navigate('/mission-control')` → `navigate('/agents')`, update button text to "← Back to AI Agents"

- [ ] **1.4** `apps/web/src/features/agents/AgentCapabilityPage.tsx`
  - Change `setupOnMissionControl` link path from `/mission-control` to `/agents`.
  - Update the i18n key from `agents.capabilityPage.setupOnMissionControl` to a new key (e.g. `agents.capabilityPage.setupOnAgents`) or keep the key and update its English value.

### Phase 2: Extract Shared Component

- [ ] **2.1** `MetricCard` → `apps/web/src/lib/ui.tsx`
  - Move the `MetricCard` component definition from `MissionControlPage.tsx` into the shared UI library.
  - Export it as a named export.
  - Verify it has no mission-control-specific dependencies (it doesn't — it's pure presentational).

### Phase 3: Consolidate into AgentsPage

- [ ] **3.1** Add dashboard data fetching to `AgentsPage`
  - Add `useQuery` for `dashboard.overview()`, `dashboard.activity()`, `dashboard.agentActivity()`.
  - Add `useEventStream` subscription for live invalidation (same handler as MissionControlPage).
  - Add `mergeActivityFeedItems` import for the merged activity feed.

- [ ] **3.2** Add metrics row to `AgentsPage`
  - Insert a 5-column CSS grid of `MetricCard` components below the page header.
  - Cards: Active, Paused, Unhealthy, Stopped, Total Realized P&L.
  - Only render when `agentsQuery.data` is available (same guard as MissionControlPage).

- [ ] **3.3** Add setup card to `AgentsPage`
  - Insert the "Connect AI agent to external platform" card between the metrics row and the agent list.
  - Include the success-state banner (post-setup confirmation).
  - Wire up the "Connect AI agent" button to open the ProviderSetupForm modal.
  - Hide the card when the agent list is empty (first-time users should see the empty state instead, which already has a "Create agent" CTA).

- [ ] **3.4** Add activity feed to `AgentsPage`
  - Add the recent activity feed as a right sidebar column (two-column layout: agent list left, activity right).
  - On narrow viewports, stack vertically or hide behind a "Recent activity" toggle.
  - Include the "View all activity →" link to `/activity`.
  - Handle loading, error, and empty states.

- [ ] **3.5** Add setup modals to `AgentsPage`
  - Add state for `showSetup`, `setupStep`, `setupResult`, `setupSuccess`.
  - Render `ProviderSetupForm` modal when `showSetup && setupStep === 'form'`.
  - Render `AgentAssignmentStep` modal when `showSetup && setupStep === 'assign' && setupResult`.
  - Wire up the `onSuccess` and `onDone` callbacks (same logic as MissionControlPage).

### Phase 4: Cleanup

- [ ] **4.1** Delete `apps/web/src/features/mission-control/MissionControlPage.tsx`
- [ ] **4.2** Delete `apps/web/src/features/mission-control/MissionControlPage.setup.test.tsx`
  - The setup form test logic is covered by `ProviderSetupForm`'s own tests. No migration needed unless specific mission-control-only behavior is tested.
- [ ] **4.3** Delete `apps/web/src/features/mission-control/` directory (should be empty after the two files above are removed).
- [ ] **4.4** Delete `apps/web/src/features/mission-control/AgentOverviewCard.tsx` if it exists and is unused (verify with grep).

### Phase 5: i18n

- [ ] **5.1** `apps/web/src/app/i18n/locales/en.ts`
  - Remove `'nav.missionControl'` key.
  - Keep all `missionControl.*` keys (they're still referenced by the moved UI sections). Rename/consolidate in a follow-up.
  - Update `agents.capabilityPage.setupOnMissionControl` value from `'Go to Mission Control'` to `'Go to AI Agents'` (or add a new key).

- [ ] **5.2** `apps/web/src/app/i18n/locales/ar.ts` — same changes as `en.ts`.
- [ ] **5.3** `apps/web/src/app/i18n/locales/hi.ts` — same changes as `en.ts`.

### Phase 6: Tests

- [ ] **6.1** `apps/web/src/app/i18n/i18n-regressions.test.ts`
  - Update the `setupOnMissionControl` test to reflect the new key/value.
  - Verify `missionControl.setup.*` keys still pass (they remain in the locale files).
  - Remove or update the test that asserts `nav.missionControl` exists.

- [ ] **6.2** Add tests for the new Agents page sections
  - Metric cards render with correct counts.
  - Setup card appears/disappears correctly.
  - Activity feed renders merged items.
  - Setup modal flow works (form → assign → success).

- [ ] **6.3** Verify existing Agents page tests still pass (no regressions from added queries/components).

### Phase 7: Landing Page Placeholder

- [ ] **7.1** Create `apps/web/src/features/landing/LandingPagePlaceholder.tsx`
  - Minimal component: HeroBids logo, tagline, "Sign In" and "Learn More" buttons.
  - The real landing page replaces this file later — keep it deliberately bare-bones.

- [ ] **7.2** Wire into router as the public `/` route (see Phase 1.1).

## Files Changed

| File | Change |
|---|---|
| `apps/web/src/app/router.tsx` | Restructure routes: public `/` landing page, auth `/` → `/agents`, `/mission-control` → `/agents` redirect |
| `apps/web/src/app/layout/Sidebar.tsx` | Remove Mission Control nav item |
| `apps/web/src/app/NotFoundPage.tsx` | Redirect target + button text |
| `apps/web/src/features/auth/AuthCallbackPage.tsx` | Post-login redirect target |
| `apps/web/src/features/auth/LoginPage.tsx` | Post-login redirect target |
| `apps/web/src/features/admin/AdminPage.tsx` | Non-admin redirect target |
| `apps/web/src/features/agents/AgentCapabilityPage.tsx` | Setup CTA link target + i18n key |
| `apps/web/src/features/agents/AgentsPage.tsx` | Add metrics, setup card, activity feed, setup modals |
| `apps/web/src/lib/ui.tsx` | Add `MetricCard` component |
| `apps/web/src/features/mission-control/MissionControlPage.tsx` | **Delete** |
| `apps/web/src/features/mission-control/MissionControlPage.setup.test.tsx` | **Delete** |
| `apps/web/src/features/mission-control/AgentOverviewCard.tsx` | **Delete** (if unused) |
| `apps/web/src/features/landing/LandingPagePlaceholder.tsx` | **Create** (minimal placeholder) |
| `apps/web/src/app/i18n/locales/en.ts` | Remove `nav.missionControl`, update capability CTA value |
| `apps/web/src/app/i18n/locales/ar.ts` | Same |
| `apps/web/src/app/i18n/locales/hi.ts` | Same |
| `apps/web/src/app/i18n/i18n-regressions.test.ts` | Update key assertions |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `/agents` page becomes too dense with all sections | Use a two-column layout (agent list left, activity right). On mobile, stack vertically. Activity feed is collapsible. |
| Bookmarked `/mission-control` URLs break | Compatibility redirect (`/mission-control` → `/agents`) handles this. |
| `missionControl.*` i18n keys feel out of place on the Agents page | Keep them working for now; rename in a follow-up PR to avoid scope creep. |
| Landing page placeholder looks unpolished | It's temporary — the real landing page is a separate feature. The placeholder just prevents a blank page at `/`. |
| Test coverage gap from deleting setup test | The setup flow is covered by `ProviderSetupForm`'s own tests. The modal wiring in Agents page needs new tests (Phase 6.2). |

## Outstanding Issues

### [Phase 1.1] Router Restructure
- **MEDIUM**: Orphaned dead code — `MissionControlPage.tsx` and `MissionControlPage.setup.test.tsx` still exist on disk but are unreachable. Will be deleted in Phase 4 cleanup.
- **LOW**: Mixed path styles at top level — some routes use absolute paths, `createPublicRoutes()` uses relative. Both work correctly, but consistency would improve readability.
- **LOW**: Inline styles in `LandingPagePlaceholder` — acceptable for a placeholder, should migrate to CSS modules when real landing page is built.

### [Phase 3] Consolidate into AgentsPage
- **MEDIUM**: `overviewQuery` never invalidated by event stream — P&L can go stale after initial load. Consider adding `refetchInterval: 30_000` or adding `['dashboard', 'overview']` to event handler invalidations (pre-existing from MissionControlPage).
- **MEDIUM**: Setup card always shown when agents exist, even if all agents already have connections. UX papercut, pre-existing.
- **LOW**: Inline style objects recreated on every render — extract to CSS modules in follow-up.
- **LOW**: Potential double event-stream subscription if MissionControlPage still mounted (resolves when deleted in Phase 4).

## Rollback Plan

If the consolidated Agents page is problematic in production:

1. Revert the commit.
2. Restore `MissionControlPage.tsx` and its route from git history.
3. The `/mission-control` → `/agents` redirect means no data loss — just a degraded UX during the revert window.
