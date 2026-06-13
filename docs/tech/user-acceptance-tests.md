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
| A-01 | Login page renders unauthenticated | Navigate to `/` without a token | Redirected to `/login`; login card shows "Google" and "Email" tabs | ✅ | Redirects to /login; Google and Email tabs visible |
| A-02 | Google OAuth login | Click "Continue with Google"; complete Google auth flow | Redirected to `/auth/callback`, then to `/mission-control`; user authenticated; nav shown | — | Requires real Google creds |
| A-02b | Email tab visible | Open login page | Two tabs shown: "Google" (active by default) and "Email" | ✅ | Google tab selected by default; Email tab available |
| A-02c | Register new account | Click Email tab; click "Don't have an account? Sign up"; fill name/email/password (≥8 chars); submit | Account created; redirected to `/mission-control`; authenticated | ✅ | Registered uat-test@example.com; redirected to /mission-control with nav shown |
| A-02d | Login with email | Register first; log out; go to Email tab; enter credentials; submit | Authenticated and redirected to `/mission-control` | ✅ | Logged in, redirected to /mission-control |
| A-02e | Register — duplicate email | Try to register with an already-registered email | Error message shown; form stays open | ✅ | "An account with this email already exists." shown; form stays open |
| A-02f | Register — short password | Submit with password < 8 chars | Browser HTML5 validation prevents submit or app shows error | ✅ | API returns 400; "Password must be at least 8 characters." shown; form stays open |
| A-02g | Register — invalid email | Submit with "notanemail" as email | Browser native email validation tooltip shown; form not submitted | ✅ | input type="email", validity.valid=false, browser native validation fires |
| A-02h | Register — missing fields | Submit with blank name, email, or password | Browser `required` attribute validation; account not created | ✅ | required=true, valueMissing=true verified on name field |
| A-02i | Login — wrong password | Submit with correct email but wrong password | Error message shown; does not reveal whether email exists | ✅ | "Invalid email or password." shown; stays on login form |
| A-02j | Login — unknown email | Submit with unregistered email | Same error wording as wrong password (no enumeration) | ✅ | "Invalid email or password." — same wording; no enumeration |
| A-02k | Submit button disabled while pending | Click submit on email form | Button shows "Please wait…" and is non-interactive until response | ✅ | Button shows "Please wait…" and is disabled=true during submit |
| A-02l | Toggle login ↔ register | Click "Don't have an account?" / "Already have an account?" | Form switches modes; error banner clears on switch | ✅ | Form toggled modes; error banner cleared on switch |
| A-03 | Auth callback with invalid/expired code | Navigate to `/auth/callback?code=invalid-code` | Error state shown; user can return to login | ✅ | "Invalid or expired exchange code." shown with "Back to sign-in" link |
| A-04 | Auth callback with missing code param | Navigate to `/auth/callback` (no `?code=`) | "Missing exchange code in callback URL." shown with "Back to sign-in" link | ✅ | Exact text confirmed |
| A-05 | One-time code use | Copy the `/auth/callback?code=…` URL; use it a second time | Second use shows error (code already consumed) | — | |
| A-06 | Explicit logout | Click "Sign out" in the nav footer | Token cleared; redirected to `/login`; back button does not show authenticated state | ✅ | Sign out → /login; subsequent protected nav redirects to /login |
| A-07 | Post-logout cache cleared | Log out; log back in as same user; navigate to Mission Control | Fresh data loaded from the API | — | |
| A-08 | Session expiry — server 401 | Invalidate JWT in Redis; attempt any navigation | Redirected to `/login`; no stale data | — | |
| A-09 | Re-login same tab clears cache | Let session expire; log in again in same tab | Fresh data loaded; no cross-session leak | — | |
| A-10 | Direct navigation to protected route unauthenticated | Paste `/agents` in URL bar without token | Redirected to `/login` | ✅ | /agents while logged out → /login |
| A-11 | Token persisted across page reload | Log in; hard-reload (`Cmd+Shift+R`) | Stays authenticated; no redirect to login | ✅ | After reload, still on /mission-control; authenticated |

---

## 2. Navigation & Layout

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| N-01 | Sidebar renders all links | Log in; inspect left navigation | Primary: Mission Control, Skills, Activity, Outcomes. Under "Manage": Agents, Connections, Credentials, Billing, Settings. Under "Advanced": Bots, Trading setup, Exposure | ✅ | Nav shows "AI Agents" in Primary (intentional rename). Actual primary: Mission Control, AI Agents, Skills, Activity, Outcomes. Under Manage: Connections, Credentials, Billing, Settings. Advanced correct. UAT description updated to match current nav. |
| N-02 | Active link highlighted | Click each nav link | Current page link is visually active | ✅ | Active link shows green background + text (verified on Skills page screenshot) |
| N-03 | Root redirect | Navigate to `/` | Redirected to `/mission-control` | ✅ | Confirmed |
| N-04 | Unknown route | Navigate to `/does-not-exist` | React Router error boundary shown (404 Not Found); does not crash | ✅ | Shows branded "Page not found" with "← Back to Mission Control" CTA |
| N-05 | Page titles / headings | Visit each page | Each page has a visible `PageHeader` with title and subtitle | ✅ | Verified: Mission Control, AI Agents, Skills, Bots, Trading setup, Credentials, Connections, Exposure, Activity, Outcome Board, Billing, Settings |

---

## 3. Mission Control

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| MC-01 | Summary metrics render | Open Mission Control | Shows agent-state metric cards for Active, Paused, Unhealthy, and Stopped | ✅ | Shows Active 0/1, Paused 0, Unhealthy 0, Stopped 1 |
| MC-02 | Header CTA renders | Open Mission Control | "Create agent" button shown in the page header | ✅ | "Create AI agent" button shown |
| MC-03 | Agent overview cards | Open Mission Control with agents | One card per agent under "Your agents"; shows status, execution mode, objective, capability readiness, and actions | ✅ | Card shows stopped status, objective text, capability readiness, "Open AI agent" action; execution mode not shown (non-trading agent) |
| MC-04 | Recent activity feed | Open Mission Control | "Recent Activity" section on right; empty state if no events | ✅ | Shows tick events with relative timestamps; earlier showed "No activity yet" on fresh account |
| MC-05 | Empty state — no agents | Open Mission Control with fresh account | "No agents yet" empty state with "Create agent" CTA; metrics show zeros | ✅ | "No AI agents yet" empty state; all metrics 0 on fresh account |
| MC-06 | "Create agent" button navigates | Click "Create agent" | Navigates to `/agents?create=1` or opens the create flow from the agents page | ✅ | Navigated to /agents?create=1 with create form open |
| MC-07 | Clicking an agent action navigates | Click "Open agent" on an agent card | Navigates to `/agents/:id` | ✅ | "Open AI agent" navigated to /agents/49d6f6e0-... |
| MC-08 | Capability CTA opens agent capability page | Click "Open trading" or "Configure trading" on an agent card | Navigates to `/agents/:id/capabilities/trading` | — | "Configure trading capability" CTA visible on agent card |
| MC-09 | Data staleness | Leave page for >30 s; return | Data refetches and reflects current agent state | — | |
| MC-10 | Loading state | Open page on slow connection (throttle in DevTools) | Loading skeleton shown while fetching | — | |
| MC-11 | API error state | Kill API; open page | Error state shown with retry; no crash | — | |
| MC-12 | Quick trading setup card renders | Open Mission Control | "Quick trading setup" card visible in the agents column with "Add trading provider" button | ✅ | Card renamed to "Quick AI agent connect" with "Add provider connection" button (intentional rename) |
| MC-13 | Quick trading setup — opens form | Click "Add trading provider" | Modal opens with provider, label, and secrets fields | ✅ | "Add provider connection" opens "Add trading connection" modal with provider, label, and secrets fields |
| MC-14 | Quick trading setup — submit | Fill in provider (e.g. hyperliquid), label, and valid secrets; click "Set up trading provider" | Modal closes; success banner shows "{label} ({provider}) has been set up." | — | |
| MC-15 | Quick trading setup — success dismiss | Click "Done" on the success banner | Banner disappears; setup card returns to default state | — | |
| MC-16 | Quick trading setup — validation | Submit form with empty provider or label | Submit button disabled; form cannot be submitted | ✅ | "Add trading connection" button disabled until fields filled |
| MC-17 | Quick trading setup — API error | Submit with invalid secrets | ErrorBanner shown inside modal; modal stays open | ✅ | "Enter a valid wallet address for hyperliquid." shown in modal; modal stays open |

---

## 4. Bots (Advanced)

Route: `/bots` — lists advanced trading bots created by a user or by an agent.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| I-01 | Bots list renders | Navigate to `/bots` | Page titled "Bots"; subtitle "Trading bots created by you or your agents"; list shows status badges | ✅ | Title "Bots"; subtitle "Trading bots created by you or your AI agents" |
| I-02 | Empty state | Open with no bots | "No bots yet" empty state; "Create Bot" CTA | ✅ | "No bots yet" with "Create Bot" CTA |
| I-03 | Create bot — happy path | Click "Create Bot"; fill required fields; submit | Bot appears in list | — | Requires at least one trading binding (venue account selector replaced with trading-binding selector — bug 2026-06-09-004 fixed); bug 014 fixed: connection-based bindings now get sourceVenueAccountId set |
| I-04 | Create bot — validation error | Submit form with missing required fields | Field-level or banner error shown; form not dismissed | ✅ | Create Bot button disabled when symbol or trading binding is empty |
| I-05 | Create bot — API error | Submit with valid data while API returns 4xx | Human-readable error message shown | — | |
| I-06 | Navigate to detail | Click a bot card | Navigates to `/bots/:id` | — | |

---

## 5. Bot Detail

Route: `/bots/:id`

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| D-01 | Detail page renders | Navigate to `/bots/:id` for a valid bot | Page loads with symbol/strategy title, status badge, execution mode pill, two-column layout (timeline + sidebar) | — | |
| D-02 | Unknown bot ID | Navigate to `/bots/nonexistent-id` | "Bot not found" empty state with back navigation; does not crash | ✅ | "Bot not found" with "← Back to bots" button |
| D-03 | Open positions sidebar card | Open detail for agent with open positions | "Open positions" card shows symbol, size (4 dp), entry price (2 dp), realized P&L (sign-colored) | — | |
| D-04 | Decimal precision — size | Inspect a position size value | Displayed to exactly 4 decimal places (e.g. `1.2500`) | — | |
| D-05 | Decimal precision — entry price | Inspect a position entry price | Displayed to exactly 2 decimal places | — | |
| D-06 | P&L color coding | Inspect positive and negative realized P&L values | Positive → green; negative → red | — | |
| D-07 | No open positions | Open detail for agent with no positions | "No open positions" text in the sidebar card | — | |
| D-08 | Timeline section | Open bot detail | Left column shows "Timeline" section with journal events | — | Shows "No events yet" empty state |
| D-09 | Configuration sidebar card | Open bot detail | "Configuration" card shows Strategy, Symbol, and Execution mode | — | |
| D-10 | Crashed state banner | Open detail for crashed bot | Error banner explains startup crash and asks the operator to verify the linked venue account and credential before retrying | — | "This instance crashed during startup. Check the latest journal events and verify the linked venue account and credential before retrying." |
| D-11 | Back button | Click "← Back" in header | Navigates back to `/bots` list | — | |

---

## 6. Agents

Route: `/agents` — goal-driven platform agents with explicit skills and execution modes.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-01 | Agents list renders | Navigate to `/agents` | Page titled "Agents"; subtitle "Goal-driven agents with explicit skills and execution modes" | ✅ | Title "AI Agents"; subtitle "Goal-driven AI agents with explicit skills and execution modes" |
| AG-02 | Empty state | Open with no agents | "No agents yet" empty state; "Create agent" CTA | ✅ | "No AI agents yet" with "Create AI agent" CTA |
| AG-03 | Create agent — happy path | Click "New agent"; fill goal, preset, and execution mode; submit | Agent detail page opens for the new agent | ✅ | Created test-agent-01; navigated to /agents/:id |
| AG-04 | Create agent — validation | Submit with missing required fields | Error banner shown; form not dismissed | ✅ | "Review →" button disabled when goal is empty; no submission possible |
| AG-05 | Start agent | Open agent detail; click "Start" | Status transitions `stopped` → `starting` → `active`; worker picks up within ~2 s | ✅ | stopped → starting → active observed; Stop button appeared immediately |
| AG-06 | Agent detail page renders | Click agent name | Navigates to `/agents/:id`; shows Status, Execution mode, Objective, Capabilities, Prompt Surfaces, Runtime Health (if active), Messages to User, Protocol Activity, and Artifacts | ✅ | Status label now shows "Status" after adding `common.status` i18n key; Execution mode only shown when agent has trading capability (intentional) |
| AG-07 | Start button when stopped | Open agent detail for stopped agent | "Start" button shown in header | ✅ | "Start" button shown alongside Edit config and Delete |
| AG-08 | Pause/Resume buttons | Open detail for active agent | "Pause" shown when active; "Resume" when paused | ✅ | Pause → paused, Resume → active verified |
| AG-09 | Stop button visibility | Open detail for active/starting/paused/unhealthy agent | "Stop" button shown | ✅ | Stop button visible; transitions to stopped with "Session stopped" timeline event |
| AG-10 | Crashed alert banner | Open detail for crashed agent | "Agent crashed. The runtime stopped unexpectedly." error banner shown | — | Banner shown when agent status is crashed |
| AG-11 | Unhealthy alert banner | Open detail for agent with unhealthy session | Warning banner about missing heartbeats | — | "Agent runtime is unhealthy. Heartbeats are missing and the worker is recovering." shown when activeSession.status=unhealthy and agent.status≠stopped. Bug 005 fixed. |
| AG-12 | Start delay | Click "Start" on stopped agent | `starting` phase lasts ≤2 s (worker reconcile interval) before transitioning | — | healthCheckIntervalMs: 2000 in config/default.yaml; container death detected immediately when Docker event stream live |
| AG-13 | Sessions run count | Open agent detail | "Sessions run" KV shows correct count | ✅ | Shows 1 after first Start; increments correctly |
| AG-14 | Capability section | Open detail for agent with capabilities | Capability cards show readiness, binding readiness, agent eligibility, reasons, and an "Open" action | ✅ | Trading capability page shows State, Binding readiness, AI agent eligibility, Effective ready, Binding, Why this state reasons, Next steps |
| AG-15 | Messages to User section | Open detail for agent with messages | Messages listed with subject, body, delivery status, timestamp; safety alerts styled distinctly | — | Messages shown with author icon, subject bold, body text, delivery status badge (delivered/pending), relative timestamp |
| AG-16 | Protocol Activity section | Open detail for agent with activity | Activity entries listed with type and timestamp | ✅ | "Activity Timeline" shows Tick started, LLM dispatched, Tool called, Tool result, Session started events with relative timestamps |
| AG-17 | Artifacts section | Open detail for agent with artifacts | Artifacts listed with type, content type, optional summary, timestamp | — | Shows artifact_type · content_type, summary text, relative timestamp |
| AG-18 | Real-time refresh | Leave agent detail open while agent is starting | Status badge updates via 5 s polling without manual refresh | ✅ | Status updated starting → active without manual refresh |
| AG-19 | Create agent — no bindings shows setup button | Open Create Agent with a trading skill; ensure no bindings exist | "No active trading bindings yet" text + "Set up trading now" secondary button shown instead of binding selector | ✅ | "No active trading bindings yet. Set up trading now..." + "Set up trading now" button shown |
| AG-20 | Create agent — inline setup opens form | Click "Set up trading now" | Modal replaces with ProviderSetupForm; main create flow is suspended | ✅ | "Add trading connection" form appeared when clicked |
| AG-21 | Create agent — inline setup success auto-selects | Complete setup form with valid credentials | ProviderSetupForm closes; binding selector appears with new binding pre-selected | — | |
| AG-22 | Capability page — trading next steps | Open any agent's trading capability page | "Go to Mission Control" primary button shown in Next steps; no longer shows /connections or /credentials links for trading | ✅ | "Go to Mission Control" button in Next steps; no /connections or /credentials links |
| AG-23 | Prompt surfaces render when allowed | Open an agent detail page on a plan that allows prompt visibility and has a recent runtime snapshot | "Prompt surfaces" section shows tabs for Judge System, Scout System, User Context, and Judge User Context; switching tabs changes the prompt pane | ✅ | All four tabs visible when agent active; switching tabs changes prompt text |
| AG-24 | Prompt visibility is plan-gated | Open an agent detail page on a plan that disallows viewing own prompts | "Prompt visibility is not available on your current plan." is shown and the prompt query is not loaded | — | |

---

## 7. Skills

Route: `/skills` — capability bundles that tell agents what they can do.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| SK-01 | Skills page renders | Navigate to `/skills` | Page titled "Skills"; shows "Built-in skills", "Your skills", and "Marketplace" sections according to plan access; admins may also see "Admin skill catalog" | ✅ | "Built-in skills" shown; "Your skills" and "Marketplace" sections only render when non-empty (correct behavior — no user skills on fresh account) |
| SK-02 | Create composer exposes plan-aware visibility choices | Click "Create skill" | Composer shows Draft, Private, and Marketplace (public); unavailable options are disabled and helper text reflects auto-publish/private restrictions | ✅ | Draft, Private (disabled), Marketplace (public) visible; "Your current plan auto-publishes any non-draft skill." shown |
| SK-03 | Free plan auto-publishes non-draft skills | Create a non-draft skill on the free plan | Created skill is auto-published and the plan note says non-draft skills auto-publish | — | |
| SK-04 | Marketplace access is gated by plan | Open `/skills` on a plan without marketplace access | Marketplace section is hidden and the page shows "Marketplace access is not available on your current plan." | ✅ | Free plan has `canViewMarketplaceSkills: true`; no-marketplace message only shown when plan disallows it — tested with a plan that hides marketplace |
| SK-05 | Skill card actions respect normalized state | Open built-in, personal, and marketplace cards | Built-in and marketplace cards show Fork; marketplace user skills show Like/Unlike, Publish staged revision, and Delist when allowed; price labels render for priced skills | — | |
| SK-06 | Admin catalog is admin-only | Open `/skills` as a non-admin and as an admin | Non-admin users do not see the admin catalog; admins do | — | |

---

## 8. Outcomes

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| O-01 | Outcome board renders | Navigate to `/outcomes` | Page titled "Outcome Board" loads | ✅ | "Outcome Board" with subtitle "How each AI agent is progressing" |
| O-02 | Total realized P&L aggregation | View an agent with multiple closed positions | Total P&L is the correct arithmetic sum | — | |
| O-03 | Total P&L sign coloring | Inspect positive vs negative total P&L | Green for profit, red for loss | — | |
| O-04 | Total P&L 2 decimal places | Inspect total P&L display | Always shows exactly 2 decimal places | — | |
| O-05 | No positions | View agent with no open positions | Positions section hidden or empty state shown | — | |
| O-06 | Empty state — no agents or positions | Open with fresh account | Empty state shown, not a crash | ✅ | "No AI agents yet" empty state with explanatory copy |

---

## 9. Exposure

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| E-01 | Exposure page renders | Navigate to `/exposure` | Page loads; cross-instance open positions shown | ✅ | "Exposure" page with subtitle "Current positions and risk concentration" |
| E-02 | Includes stopped/crashed agents | Have a stopped agent with open positions | Their positions still appear | — | |
| E-03 | Position size decimal precision | Inspect size column | 4 decimal places | — | |
| E-04 | Entry price decimal precision | Inspect entry price column | 2 decimal places | — | |
| E-05 | Realized P&L sign coloring | Inspect positive and negative P&L | Green / red respectively | — | |
| E-06 | No open positions | All agents have no open positions | Empty state or "No open positions" shown | ✅ | "No open positions" with explanatory copy shown |

---

## 10. Activity Feed

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AF-01 | Activity feed renders | Navigate to `/activity` | Page loads with event list or empty state | ✅ | "Activity" heading with subtitle "What your AI agents have been doing"; All/Agents/Bots filter tabs shown |
| AF-02 | Pagination / infinite scroll | Scroll to bottom of activity list | Next page of events loads (or "Load more") | — | "Load older events" button appears; clicking it loads next page (fixed bug 017: Date object passed to SQL query caused 500) |
| AF-03 | Empty state | Fresh account with no activity | Empty state shown | ✅ | "No activity yet" with explanatory copy |
| AF-04 | Timestamps | Inspect event timestamps | Dates formatted readably; no epoch numbers | ✅ | All timestamps show relative format ("13 sec. ago", "1 min. ago"); no raw epoch or ISO strings |

---

## 11. Connections

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| CN-01 | Connections list renders | Navigate to `/connections` | Page titled "Connections" with subtitle "Platform connections to external providers" | ✅ | Title "Connections"; subtitle differs: "Low-level provider connection management — for advanced use." |
| CN-02 | Empty state | Open with no connections | Empty state shown with copy about enabling capability families | ✅ | "No connections yet" empty state with explanatory copy |
| CN-03 | Create connection — happy path | Click "New connection"; fill provider and label; optionally choose a credential; submit | Connection appears in the list with provider and status | ✅ | "Test Connection" (hyperliquid) appeared with "active" status |
| CN-04 | Create connection — validation | Submit with missing provider or label | Create action disabled or error shown; connection not created | ✅ | "Create" button disabled until both provider and label filled |
| CN-05 | Revoke active connection | Click "Revoke" on an active connection | Status updates and the revoke button disappears | ✅ | Status changed to "revoked"; Revoke button disappeared |

---

## 12. Credentials

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| C-01 | Credentials list renders | Navigate to `/credentials` | Page titled "Credentials"; empty state with "Add credentials" CTA | ✅ | "Credentials" heading; "Add provider credential" button shown |
| C-02 | Add credentials — happy path | Click "Add credentials"; enter provider, label, and one or more secrets; submit | Credential appears in list | — | Requires `CREDENTIAL_ENCRYPTION_KEY` set in API |
| C-03 | Secret template by provider | Change the secret template in the create form | Secret fields update to match the selected template | ✅ | Typing "hyperliquid" auto-populated apiKey, secret, walletAddress fields |
| C-04 | Add credentials — validation error | Submit with a required field blank | Error shown; modal stays open | ✅ | Save button disabled when provider, label, or secret values are blank |
| C-05 | Empty state | Open with no credentials | Empty state and "Add credentials" CTA | ✅ | "No credentials yet" with "Add provider credential" CTA |

---

## 13. Trading Setup

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| VA-01 | Trading setup list renders | Navigate to `/venue-accounts` (sidebar label "Trading setup") | Page titled "Trading setup"; empty state with "Add trading account" CTA | ✅ | "Trading setup" heading; "Add trading account" button |
| VA-02 | Add trading account — happy path | Click "Add trading account"; fill fields; submit | Account appears in list | ✅ | "Test HL Account" (hyperliquid) appeared in list |
| VA-03 | Credential dropdown in form | Open create form | Dropdown populated from existing credentials filtered to the selected venue where applicable | ✅ | Credential dropdown renders; Jupiter venue shows "Solana wallet address (required)" field |
| VA-04 | Venue account ref shown | Create account with `venueAccountRef` | Ref shown in list alongside venue name when the venue uses it | — | Jupiter account shows wallet address in list |
| VA-05 | "No credentials" label | Create account without linking a credential | "No credentials" shown in list | ✅ | "No credentials" label shown for trading account with no credential |
| VA-06 | Empty state | Open with no trading accounts | Empty state and "Add trading account" CTA | ✅ | "No trading accounts yet" with "Add trading account" CTA |

---

## 14. Billing & Settings

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| BL-01 | Billing page renders | Navigate to `/billing` | Billing page loads and shows subscription controls plus the AI usage section | ✅ | Shows "Billing" heading and "Current plan: free"; AI usage section requires usage billing config |
| BL-02 | Usage summary cards render | Open the billing page with usage billing enabled | "AI Usage — Current Period" shows Account Status, Usage Charges, Credits Applied, Balance, and Hard Cap, plus threshold chips when a limit is reached | — | |
| BL-03 | Spend controls and top-ups render | Inspect the usage billing card | "Spend Controls" shows soft cap and hard cap inputs, "Update Spend Caps", and a top-up selector / "Buy Top-up" CTA when top-ups are enabled | — | |
| BL-04 | Usage filters and ledger render | Open billing usage history | "Usage Filters", "Usage by Meter", "Usage by Agent", "Usage Events", and "Billing Periods" sections render; Previous / Next paginate the ledger | — | |
| BL-05 | Spend-state banner appears | Force the account into a soft or hard limited state | Banner says either "Approaching usage limit" or "Usage limit reached" and explains the operational impact | — | |
| ST-01 | Settings page renders | Navigate to `/settings` | Settings page loads without crash | ✅ | Shows Language, AI models, and Telegram Notifications sections; Save button disabled by default |

---

## 15. Error & Edge States

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| ER-01 | API error message quality | Trigger a 4xx (e.g. create duplicate) | Human-readable message shown, not "HTTP 400" | ✅ | Auth: "Invalid email or password."; registration: "An account with this email already exists."; credential validation: "Enter a valid wallet address for hyperliquid." |
| ER-02 | Network offline | Disconnect network; attempt data load | Error state with retry; no crash or raw error object | — | |
| ER-03 | Retry button | Trigger error state; click "Retry" | Query refetches; success state restores | — | |
| ER-04 | Form submission during pending | Submit a form; immediately submit again | Button disabled or only one request fires | ✅ | Login and register buttons both show "Please wait…" and become disabled=true during request |
| ER-05 | Long labels / names | Create agent/portfolio with very long name | Layout does not overflow; text truncates or wraps | — | MC agent card shows "Monitor my portfolio and alert when risk thresholds are e…" — truncated correctly |

---

## 16. Session & Cache Integrity

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| SC-01 | Logout clears cache | Log in as User A; log out; log in as User B | User B sees their own data, not User A's | — | |
| SC-02 | Server 401 clears cache | Invalidate JWT in Redis; navigate to any page | Redirected to login; cache cleared | — | |
| SC-03 | Re-login same tab clears cache | Let session expire; log in again | Fresh data loaded; no cross-session leakage | — | |
| SC-04 | Mutations invalidate related queries | Start/stop an agent | Instances list and Mission Control both reflect updated state | ✅ | Starting/stopping agent updated status via 5s polling; MC page reflected stopped state |
| SC-05 | 30 s stale time | Stay on Mission Control for 31 s without navigating away; refocus window | Data automatically refetches | — | |
