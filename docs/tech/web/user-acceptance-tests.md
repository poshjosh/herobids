# Web UI — User Acceptance Tests

Manual test checklist for the Herobids frontend dashboard.

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
| A-01 | Login page renders unauthenticated | Navigate to `/` without a token | Redirected to `/login`; login card shows "Google" and "Email" tabs | ✅ | |
| A-02 | Google OAuth login | Click "Continue with Google"; complete Google auth flow | Redirected to `/auth/callback`, then to `/mission-control`; user authenticated; nav shown | — | Requires real Google creds |
| A-02b | Email tab visible | Open login page | Two tabs shown: "Google" (active by default) and "Email" | ✅ | |
| A-02c | Register new account | Click Email tab; click "Don't have an account? Sign up"; fill name/email/password (≥8 chars); submit | Account created; redirected to `/mission-control`; authenticated | ✅ | |
| A-02d | Login with email | Register first; log out; go to Email tab; enter credentials; submit | Authenticated and redirected to `/mission-control` | ✅ | |
| A-02e | Register — duplicate email | Try to register with an already-registered email | Error message shown; form stays open | ✅ | "An account with this email already exists" |
| A-02f | Register — short password | Submit with password < 8 chars | Browser HTML5 validation prevents submit or app shows error | — | |
| A-02g | Register — invalid email | Submit with "notanemail" as email | Browser native email validation tooltip shown; form not submitted | ✅ | Browser-native HTML5 validation, not a custom banner |
| A-02h | Register — missing fields | Submit with blank name, email, or password | Browser `required` attribute validation; account not created | — | |
| A-02i | Login — wrong password | Submit with correct email but wrong password | Error message shown; does not reveal whether email exists | ✅ | Was broken (tab switched to Google, no error); fixed in 003-login-error-not-shown |
| A-02j | Login — unknown email | Submit with unregistered email | Same error wording as wrong password (no enumeration) | ✅ | "Invalid email or password" — same wording |
| A-02k | Submit button disabled while pending | Click submit on email form | Button shows "Please wait…" and is non-interactive until response | ✅ | |
| A-02l | Toggle login ↔ register | Click "Don't have an account?" / "Already have an account?" | Form switches modes; error banner clears on switch | ✅ | |
| A-03 | Auth callback with invalid/expired code | Navigate to `/auth/callback?code=invalid-code` | Error state shown; user can return to login | — | |
| A-04 | Auth callback with missing code param | Navigate to `/auth/callback` (no `?code=`) | "Missing exchange code in callback URL." shown with "Back to sign-in" link | ✅ | |
| A-05 | One-time code use | Copy the `/auth/callback?code=…` URL; use it a second time | Second use shows error (code already consumed) | — | |
| A-06 | Explicit logout | Click "Sign out" in the nav footer | Token cleared; redirected to `/login`; back button does not show authenticated state | ✅ | |
| A-07 | Post-logout cache cleared | Log out; log back in as same user; navigate to Mission Control | Fresh data loaded from the API | — | |
| A-08 | Session expiry — server 401 | Invalidate JWT in Redis; attempt any navigation | Redirected to `/login`; no stale data | — | |
| A-09 | Re-login same tab clears cache | Let session expire; log in again in same tab | Fresh data loaded; no cross-session leak | — | |
| A-10 | Direct navigation to protected route unauthenticated | Paste `/agents` in URL bar without token | Redirected to `/login` | ✅ | |
| A-11 | Token persisted across page reload | Log in; hard-reload (`Cmd+Shift+R`) | Stays authenticated; no redirect to login | ✅ | |

---

## 2. Navigation & Layout

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| N-01 | Sidebar renders all links | Log in; inspect left navigation | Primary: Mission Control, Skills, Activity, Outcomes. Under "Manage": Agents, Connections, Credentials, Billing, Settings. Under "Advanced": Bots, Trading setup, Exposure | ✅ | "Trading setup" links to `/venue-accounts`. |
| N-02 | Active link highlighted | Click each nav link | Current page link is visually active | ✅ | |
| N-03 | Root redirect | Navigate to `/` | Redirected to `/mission-control` | ✅ | |
| N-04 | Unknown route | Navigate to `/does-not-exist` | React Router error boundary shown (404 Not Found); does not crash | ✅ | Shows React Router dev error page — no custom 404 page yet (see bug 2026-06-04-007) |
| N-05 | Page titles / headings | Visit each page | Each page has a visible `PageHeader` with title and subtitle | ✅ | |

---

## 3. Mission Control

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| MC-01 | Summary metrics render | Open Mission Control | Shows agent-state metric cards for Active, Paused, Unhealthy, and Stopped | ✅ | |
| MC-02 | Header CTA renders | Open Mission Control | "Create agent" button shown in the page header | ✅ | |
| MC-03 | Agent overview cards | Open Mission Control with agents | One card per agent under "Your agents"; shows status, execution mode, objective, capability readiness, and actions | ✅ | |
| MC-04 | Recent activity feed | Open Mission Control | "Recent Activity" section on right; empty state if no events | ✅ | |
| MC-05 | Empty state — no agents | Open Mission Control with fresh account | "No agents yet" empty state with "Create agent" CTA; metrics show zeros | ✅ | |
| MC-06 | "Create agent" button navigates | Click "Create agent" | Navigates to `/agents?create=1` or opens the create flow from the agents page | ✅ | |
| MC-07 | Clicking an agent action navigates | Click "Open agent" on an agent card | Navigates to `/agents/:id` | ✅ | "Open agent" button visible on agent card |
| MC-08 | Capability CTA opens agent capability page | Click "Open trading" or "Configure trading" on an agent card | Navigates to `/agents/:id/capabilities/trading` | ✅ | "Configure trading capability" CTA visible on agent card |
| MC-09 | Data staleness | Leave page for >30 s; return | Data refetches and reflects current agent state | — | |
| MC-10 | Loading state | Open page on slow connection (throttle in DevTools) | Loading skeleton shown while fetching | — | |
| MC-11 | API error state | Kill API; open page | Error state shown with retry; no crash | — | |

---

## 4. Bots (Advanced)

Route: `/bots` — lists advanced trading bots created by a user or by an agent.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| I-01 | Bots list renders | Navigate to `/bots` | Page titled "Bots"; subtitle "Trading bots created by you or your agents"; list shows status badges | ✅ | |
| I-02 | Empty state | Open with no bots | "No bots yet" empty state; "Create Bot" CTA | ✅ | |
| I-03 | Create bot — happy path | Click "Create Bot"; fill required fields; submit | Bot appears in list | — | Requires at least one venue account |
| I-04 | Create bot — validation error | Submit form with missing required fields | Field-level or banner error shown; form not dismissed | — | |
| I-05 | Create bot — API error | Submit with valid data while API returns 4xx | Human-readable error message shown | — | |
| I-06 | Navigate to detail | Click a bot card | Navigates to `/bots/:id` | — | |

---

## 5. Bot Detail

Route: `/bots/:id`

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| D-01 | Detail page renders | Navigate to `/bots/:id` for a valid bot | Page loads with symbol/strategy title, status badge, execution mode pill, two-column layout (timeline + sidebar) | — | |
| D-02 | Unknown bot ID | Navigate to `/bots/nonexistent-id` | "Agent not found" empty state; does not crash | — | Current empty-state copy still says "Agent not found" |
| D-03 | Open positions sidebar card | Open detail for agent with open positions | "Open positions" card shows symbol, size (4 dp), entry price (2 dp), realized P&L (sign-colored) | — | |
| D-04 | Decimal precision — size | Inspect a position size value | Displayed to exactly 4 decimal places (e.g. `1.2500`) | — | |
| D-05 | Decimal precision — entry price | Inspect a position entry price | Displayed to exactly 2 decimal places | — | |
| D-06 | P&L color coding | Inspect positive and negative realized P&L values | Positive → green; negative → red | — | |
| D-07 | No open positions | Open detail for agent with no positions | "No open positions" text in the sidebar card | — | |
| D-08 | Timeline section | Open bot detail | Left column shows "Timeline" section with journal events | — | |
| D-09 | Configuration sidebar card | Open bot detail | "Configuration" card shows Strategy, Symbol, and Execution mode | — | |
| D-10 | Crashed state banner | Open detail for crashed bot | Error banner explains startup crash and asks the operator to verify the linked venue account and credential before retrying | — | |
| D-11 | Back button | Click "← Back" in header | Navigates back to `/bots` list | — | |

---

## 6. Agents

Route: `/agents` — goal-driven platform agents with explicit skills and execution modes.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-01 | Agents list renders | Navigate to `/agents` | Page titled "Agents"; subtitle "Goal-driven agents with explicit skills and execution modes" | ✅ | |
| AG-02 | Empty state | Open with no agents | "No agents yet" empty state; "Create agent" CTA | ✅ | |
| AG-03 | Create agent — happy path | Click "New agent"; fill goal, preset, and execution mode; submit | Agent detail page opens for the new agent | ✅ | Skills (bot-management, risk-monitoring) visible in create form |
| AG-04 | Create agent — validation | Submit with missing required fields | Error banner shown; form not dismissed | — | |
| AG-05 | Start agent | Open agent detail; click "Start" | Status transitions `stopped` → `starting` → `active`; worker picks up within ~2 s | ✅ | Button shows "Starting...", then Stop button appears; status updates via polling |
| AG-06 | Agent detail page renders | Click agent name | Navigates to `/agents/:id`; shows Status, Execution mode, Objective, Capabilities, Runtime Health (if active), Messages to User, Protocol Activity, and Artifacts | ✅ | All sections present |
| AG-07 | Start button when stopped | Open agent detail for stopped agent | "Start" button shown in header | ✅ | |
| AG-08 | Pause/Resume buttons | Open detail for active agent | "Pause" shown when active; "Resume" when paused | — | |
| AG-09 | Stop button visibility | Open detail for active/starting/paused/unhealthy agent | "Stop" button shown | ✅ | Stop button appeared after clicking Start |
| AG-10 | Crashed alert banner | Open detail for crashed agent | "Agent crashed. The runtime stopped unexpectedly." error banner shown | — | |
| AG-11 | Unhealthy alert banner | Open detail for agent with unhealthy session | Warning banner about missing heartbeats | — | |
| AG-12 | Start delay | Click "Start" on stopped agent | `starting` phase lasts ≤2 s (worker reconcile interval) before transitioning | — | Fixed: worker healthCheckIntervalMs reduced to 2 s |
| AG-13 | Sessions run count | Open agent detail | "Sessions run" KV shows correct count | ✅ | Shows 1 after first start |
| AG-14 | Capability section | Open detail for agent with capabilities | Capability cards show readiness, binding readiness, agent eligibility, reasons, and an "Open" action | ✅ | Shows Unconfigured, Binding readiness, eligibility, reasons |
| AG-15 | Messages to User section | Open detail for agent with messages | Messages listed with subject, body, delivery status, timestamp; safety alerts styled distinctly | — | |
| AG-16 | Protocol Activity section | Open detail for agent with activity | Activity entries listed with type and timestamp | — | |
| AG-17 | Artifacts section | Open detail for agent with artifacts | Artifacts listed with type, content type, optional summary, timestamp | — | |
| AG-18 | Real-time refresh | Leave agent detail open while agent is starting | Status badge updates via 5 s polling without manual refresh | — | |

---

## 7. Outcomes

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| O-01 | Outcome board renders | Navigate to `/outcomes` | Page titled "Outcome Board" loads | ✅ | Shows agent with active status, metrics |
| O-02 | Total realized P&L aggregation | View an agent with multiple closed positions | Total P&L is the correct arithmetic sum | — | |
| O-03 | Total P&L sign coloring | Inspect positive vs negative total P&L | Green for profit, red for loss | — | |
| O-04 | Total P&L 2 decimal places | Inspect total P&L display | Always shows exactly 2 decimal places | — | |
| O-05 | No positions | View agent with no open positions | Positions section hidden or empty state shown | — | |
| O-06 | Empty state — no agents or positions | Open with fresh account | Empty state shown, not a crash | ✅ | Page renders; agent card shown with no positions |

---

## 8. Exposure

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| E-01 | Exposure page renders | Navigate to `/exposure` | Page loads; cross-instance open positions shown | ✅ | |
| E-02 | Includes stopped/crashed agents | Have a stopped agent with open positions | Their positions still appear | — | |
| E-03 | Position size decimal precision | Inspect size column | 4 decimal places | — | |
| E-04 | Entry price decimal precision | Inspect entry price column | 2 decimal places | — | |
| E-05 | Realized P&L sign coloring | Inspect positive and negative P&L | Green / red respectively | — | |
| E-06 | No open positions | All agents have no open positions | Empty state or "No open positions" shown | — | |

---

## 9. Activity Feed

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AF-01 | Activity feed renders | Navigate to `/activity` | Page loads with event list or empty state | ✅ | Heading "Activity"; subtitle shown |
| AF-02 | Pagination / infinite scroll | Scroll to bottom of activity list | Next page of events loads (or "Load more") | — | |
| AF-03 | Empty state | Fresh account with no activity | Empty state shown | — | |
| AF-04 | Timestamps | Inspect event timestamps | Dates formatted readably; no epoch numbers | — | |

---

## 10. Connections

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| CN-01 | Connections list renders | Navigate to `/connections` | Page titled "Connections" with subtitle "Platform connections to external providers" | ✅ | Subtitle: "Platform connections to reusable providers" |
| CN-02 | Empty state | Open with no connections | Empty state shown with copy about enabling capability families | ✅ | "No connections yet. Create one to enable capability families." |
| CN-03 | Create connection — happy path | Click "New connection"; fill provider and label; optionally choose a credential; submit | Connection appears in the list with provider and status | — | |
| CN-04 | Create connection — validation | Submit with missing provider or label | Create action disabled or error shown; connection not created | — | |
| CN-05 | Revoke active connection | Click "Revoke" on an active connection | Status updates and the revoke button disappears | — | |

---

## 11. Credentials

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| C-01 | Credentials list renders | Navigate to `/credentials` | Page titled "Credentials"; empty state with "Add credentials" CTA | ✅ | |
| C-02 | Add credentials — happy path | Click "Add credentials"; enter provider, label, and one or more secrets; submit | Credential appears in list | — | Requires `CREDENTIAL_ENCRYPTION_KEY` set in API |
| C-03 | Secret template by provider | Change the secret template in the create form | Secret fields update to match the selected template | — | |
| C-04 | Add credentials — validation error | Submit with a required field blank | Error shown; modal stays open | — | |
| C-05 | Empty state | Open with no credentials | Empty state and "Add credentials" CTA | ✅ | |

---

## 12. Trading Setup

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| VA-01 | Trading setup list renders | Navigate to `/venue-accounts` (sidebar label "Trading setup") | Page titled "Trading setup"; empty state with "Add trading account" CTA | ✅ | Advanced surface only |
| VA-02 | Add trading account — happy path | Click "Add trading account"; fill fields; submit | Account appears in list | — | |
| VA-03 | Credential dropdown in form | Open create form | Dropdown populated from existing credentials filtered to the selected venue where applicable | — | |
| VA-04 | Venue account ref shown | Create account with `venueAccountRef` | Ref shown in list alongside venue name when the venue uses it | — | |
| VA-05 | "No credentials" label | Create account without linking a credential | "No credentials" shown in list | — | |
| VA-06 | Empty state | Open with no trading accounts | Empty state and "Add trading account" CTA | ✅ | |

---

## 13. Billing & Settings

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| BL-01 | Billing page renders | Navigate to `/billing` | Billing page loads without crash | ✅ | Shows current plan "free" |
| ST-01 | Settings page renders | Navigate to `/settings` | Settings page loads without crash | ✅ | Shows Telegram notifications config section |

---

## 14. Error & Edge States

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| ER-01 | API error message quality | Trigger a 4xx (e.g. create duplicate) | Human-readable message shown, not "HTTP 400" | — | |
| ER-02 | Network offline | Disconnect network; attempt data load | Error state with retry; no crash or raw error object | — | |
| ER-03 | Retry button | Trigger error state; click "Retry" | Query refetches; success state restores | — | |
| ER-04 | Form submission during pending | Submit a form; immediately submit again | Button disabled or only one request fires | — | |
| ER-05 | Long labels / names | Create agent/portfolio with very long name | Layout does not overflow; text truncates or wraps | — | |

---

## 15. Session & Cache Integrity

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| SC-01 | Logout clears cache | Log in as User A; log out; log in as User B | User B sees their own data, not User A's | — | |
| SC-02 | Server 401 clears cache | Invalidate JWT in Redis; navigate to any page | Redirected to login; cache cleared | — | |
| SC-03 | Re-login same tab clears cache | Let session expire; log in again | Fresh data loaded; no cross-session leakage | — | |
| SC-04 | Mutations invalidate related queries | Start/stop an agent | Instances list and Mission Control both reflect updated state | — | |
| SC-05 | 30 s stale time | Stay on Mission Control for 31 s without navigating away; refocus window | Data automatically refetches | — | |
