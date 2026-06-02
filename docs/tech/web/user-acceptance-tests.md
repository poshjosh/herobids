# Web UI — User Acceptance Tests

Manual test checklist for the Phase 5e frontend dashboard.

**Status legend**

| Symbol | Meaning |
|--------|---------|
| `—` | Not yet run |
| `✅` | Pass |
| `❌` | Fail |
| `⏭` | Skip (not applicable / deferred) |
| `🔒` | Blocked (dependency not ready) |

Update the Status column and add Notes as you go. Keep this file up to date when features change.

---

## 1. Auth & Session

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| A-01 | Login page renders unauthenticated | Navigate to `/` without a token | Redirected to `/login`; login page shows Google sign-in button | — | |
| A-02 | Google OAuth login | Click "Sign in with Google"; complete Google auth flow | Redirected to `/auth/callback`, then to `/mission-control`; user is authenticated; nav shows | — | |
| A-03 | Auth callback with invalid/expired code | Navigate to `/auth/callback?code=invalid-code` | Error state shown; user remains on login page or sees meaningful error | — | |
| A-04 | Auth callback with missing code param | Navigate to `/auth/callback` (no `?code=`) | Error state shown; does not crash | — | |
| A-05 | One-time code use | Copy the `/auth/callback?code=…` URL; open it in a second tab after first use | Second tab shows error (code already consumed); does not grant a second session | — | |
| A-06 | Explicit logout | Click logout in the nav | Token cleared; redirected to `/login`; back button does not show authenticated state | — | |
| A-07 | Post-logout cache cleared | Log out; log back in as the same user; navigate to Mission Control | Fresh data loaded from the API, not cached data from the previous session | — | |
| A-08 | Session expiry — server 401 mid-session | Let a valid session expire (or manually delete the JWT from Redis); attempt any navigation | Redirected to `/login`; no stale data shown; clean login possible | — | |
| A-09 | Re-login in same tab clears old cache | Stay in tab; let session expire; log in again | Old user's data not visible; new session data loads correctly | — | |
| A-10 | Direct navigation to protected route unauthenticated | Paste `/instances` in the URL bar without a token | Redirected to `/login` | — | |
| A-11 | Token persisted across page reload | Log in; hard-reload the page (`Cmd+Shift+R`) | Stays authenticated; does not redirect to login | — | |

---

## 2. Navigation & Layout

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| N-01 | Sidebar renders all links | Log in; inspect left navigation | Links present: Mission Control, Activity, Outcomes, Exposure, Agents, Portfolios, Credentials, Venue Accounts | — | |
| N-02 | Active link highlighted | Click each nav link | The current page link is visually active/highlighted | — | |
| N-03 | Root redirect | Navigate to `/` | Redirected to `/mission-control` | — | |
| N-04 | Unknown route | Navigate to `/does-not-exist` | 404 page or graceful fallback; does not crash | — | |
| N-05 | Page titles / headings | Visit each page | Each page has a visible `PageHeader` with title and subtitle | — | |

---

## 3. Mission Control

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| MC-01 | Summary metrics render | Open Mission Control | Shows "Active agents X of Y", "Open positions", "Plan" metric cards | — | |
| MC-02 | Health strip renders | Open Mission Control with at least one instance | Health strip row shown with per-agent status pills | — | |
| MC-03 | Agent overview cards | Open Mission Control with instances | One card per agent; shows name, status, venue, symbol | — | |
| MC-04 | Recent activity feed | Open Mission Control | Up to 8 recent activity events shown on the right side | — | |
| MC-05 | Empty state — no instances | Open Mission Control with a fresh account | Empty state shown, not a crash or blank page | — | |
| MC-06 | "Manage agents" button navigates | Click "Manage agents" | Navigates to `/instances` | — | |
| MC-07 | Clicking an agent card navigates | Click an agent card | Navigates to `/instances/:id` | — | |
| MC-08 | Data staleness | Leave page for >30 s; return | Data refetches (TanStack Query `staleTime: 30 000 ms`) | — | |
| MC-09 | Loading state | Open page on slow connection (throttle in DevTools) | Skeleton/loading rows shown while fetching | — | |
| MC-10 | API error state | Kill API; open page | Error state shown with retry button; no crash | — | |

---

## 4. Agents (Instances)

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| I-01 | Instances list renders | Navigate to `/instances` | Table/list of agents with status badges, venue, symbol | — | |
| I-02 | Empty state | Open with no instances | Empty state shown; "Create agent" call to action | — | |
| I-03 | Create agent — happy path | Click "Create agent"; fill in all required fields; submit | Agent appears in list; status is `stopped` or `pending` | — | |
| I-04 | Create agent — validation error | Submit the create form with missing required fields | Field-level or banner error shown; form not dismissed | — | |
| I-05 | Create agent — API error | Submit with valid data while API returns 4xx | Error message from API shown (not "HTTP 400" literal) | — | |
| I-06 | Start agent | Click "Start" on a stopped agent | Status changes to `running` in the list; Mission Control summary updates | — | |
| I-07 | Stop agent | Click "Stop" on a running agent | Status changes to `stopped`; Mission Control summary updates | — | |
| I-08 | Start/stop updates list | Start or stop an agent | `['instances']` list query refreshes; no stale status shown | — | |
| I-09 | Navigate to detail | Click agent name or row | Navigates to `/instances/:id` | — | |

---

## 5. Instance Detail

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| D-01 | Detail page renders | Navigate to `/instances/:id` for a valid agent | Page loads with agent name, status, venue, symbol | — | |
| D-02 | Unknown instance ID | Navigate to `/instances/nonexistent-id` | Error state shown; does not crash | — | |
| D-03 | Open positions table | Open detail for agent with open positions | Table shows symbol, size (4 dp), entry price (2 dp), realized P&L (2 dp, sign-colored) | — | |
| D-04 | Decimal precision — size | Inspect a position size value | Displayed to exactly 4 decimal places (e.g. `1.2500`) | — | |
| D-05 | Decimal precision — entry price | Inspect a position entry price | Displayed to exactly 2 decimal places | — | |
| D-06 | P&L color coding | Inspect positive and negative realized P&L values | Positive → green; negative → red | — | |
| D-07 | No open positions | Open detail for agent with no positions | Empty state or "No open positions" message; not an empty table | — | |
| D-08 | Timeline tab | Click Timeline section | Event history renders with event type, timestamp | — | |
| D-09 | Config tab | Click Config section | Agent config JSON or fields rendered | — | |
| D-10 | Start from detail | Click "Start" on a stopped agent in detail view | Status updates on this page; list page also reflects new status | — | |
| D-11 | Stop from detail | Click "Stop" on a running agent in detail view | Status updates on this page; list page also reflects new status | — | |

---

## 6. Outcomes

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| O-01 | Outcome board renders | Navigate to `/outcomes` | Page loads with per-agent outcome sections | — | |
| O-02 | Total realized P&L aggregation | View an agent with multiple closed positions | Total P&L is the correct arithmetic sum (decimal, not float) | — | |
| O-03 | Total P&L sign coloring | Inspect positive vs negative total P&L | Green for profit, red for loss | — | |
| O-04 | Total P&L 2 decimal places | Inspect total P&L display | Always shows exactly 2 decimal places | — | |
| O-05 | No positions | View an agent with `openPositionsCount === 0` | Positions section hidden or empty state shown | — | |
| O-06 | Empty state — no instances | Open with fresh account | Empty state shown, not a crash | — | |

---

## 7. Exposure

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| E-01 | Exposure page renders | Navigate to `/exposure` | Page loads; cross-instance open positions shown | — | |
| E-02 | Includes stopped/crashed agents | Have a stopped agent with open positions | Their positions still appear in the exposure table | — | |
| E-03 | Position size decimal precision | Inspect size column | 4 decimal places | — | |
| E-04 | Entry price decimal precision | Inspect entry price column | 2 decimal places (not locale-formatted) | — | |
| E-05 | Realized P&L sign coloring | Inspect positive and negative P&L values | Green / red respectively | — | |
| E-06 | No open positions | All agents have no open positions | Empty state or "No open positions" shown | — | |

---

## 8. Activity Feed

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AF-01 | Activity feed renders | Navigate to `/activity` | List of events with type label, description, timestamp | — | |
| AF-02 | Pagination / infinite scroll | Scroll to bottom of activity list | Next page of events loads (or "Load more" button) | — | |
| AF-03 | Empty state | Fresh account with no activity | Empty state shown | — | |
| AF-04 | Timestamps | Inspect event timestamps | Dates formatted readably; no epoch numbers shown | — | |

---

## 9. Portfolios

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| P-01 | Portfolios list renders | Navigate to `/portfolios` | List of portfolios with name and created date | — | |
| P-02 | Create portfolio — happy path | Click "New portfolio"; enter a name; submit | Portfolio appears in list | — | |
| P-03 | Create portfolio — empty name | Submit with blank name | Error shown; portfolio not created | — | |
| P-04 | Empty state | Open with no portfolios | Empty state and "Create portfolio" CTA shown | — | |

---

## 10. Credentials

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| C-01 | Credentials list renders | Navigate to `/credentials` | List with label, venue, added date | — | |
| C-02 | Add credentials — happy path | Click "Add credentials"; select venue; fill secret fields; submit | Credential appears in list | — | |
| C-03 | Secret fields by venue | Change venue in the create form | Secret fields update to match venue schema (e.g. Hyperliquid shows `apiKey`, `secret`, `walletAddress`) | — | |
| C-04 | Add credentials — validation error | Submit with a required field blank | Error shown; modal stays open | — | |
| C-05 | Empty state | Open with no credentials | Empty state and "Add credentials" CTA shown | — | |

---

## 11. Venue Accounts

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| VA-01 | Venue accounts list renders | Navigate to `/venue-accounts` | List with label, venue, credential link status | — | |
| VA-02 | Add venue account — happy path | Click "Add venue account"; fill fields; submit | Account appears in list | — | |
| VA-03 | Credential dropdown in form | Open create form | Dropdown populated from existing credentials | — | |
| VA-04 | Venue account ref shown | Create account with a `venueAccountRef` | Ref shown in the list alongside venue name | — | |
| VA-05 | "No credentials" label | Create account without linking a credential | Label "No credentials" shown in list | — | |
| VA-06 | Empty state | Open with no venue accounts | Empty state and "Add venue account" CTA shown | — | |

---

## 12. Error & Edge States

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| ER-01 | API error message quality | Trigger a 4xx from the API (e.g. create duplicate) | Human-readable message shown, not "HTTP 400" | — | |
| ER-02 | Network offline | Disconnect network; attempt any data load | Error state with retry; does not crash or show raw error object | — | |
| ER-03 | Retry button | Trigger error state; click "Retry" | Query refetches; success state restores if API comes back | — | |
| ER-04 | Form submission during pending | Submit a form; immediately submit again | Button disabled or only one request fires | — | |
| ER-05 | Long labels / names | Create an agent/portfolio with a very long name | Layout does not overflow or break; text truncates or wraps gracefully | — | |

---

## 13. Session & Cache Integrity

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| SC-01 | Logout clears cache | Log in as User A; note Mission Control data; log out; log in as User B | User B sees their own data, not User A's cached data | — | |
| SC-02 | Server 401 clears cache | Mid-session; invalidate JWT in Redis; navigate to any page | Redirected to login; cache cleared so no stale data on next login | — | |
| SC-03 | Re-login same tab clears cache | Let session expire; log in again in the same browser tab | Fresh data loaded; no cross-session data leakage | — | |
| SC-04 | Mutations invalidate related queries | Start/stop an agent | Both the instances list and Mission Control overview reflect updated state within the same page visit | — | |
| SC-05 | 30 s stale time | Stay on Mission Control for 31 s without navigating away; refocus the window | Data automatically refetches | — | |
