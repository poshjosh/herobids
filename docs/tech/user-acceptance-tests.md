# Web UI — User Acceptance Tests

Manual test checklist for the OpenAIdom frontend dashboard.

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
| A-01 | Landing page renders for unauthenticated users | Navigate to `/` without a token | Landing page shown with brand logo, tagline ("Low cost AI agents…"), "Sign in" CTA linking to `/login`, and "Try it" CTA linking to `/try`; background image visible | — | 2026-08-06: Updated — `/` now renders a landing page (not a redirect to `/login`) |
| A-02 | Google OAuth login | Click "Continue with Google"; complete Google auth flow | Redirected to `/auth/callback`, then to `/mission-control`; user authenticated; nav shown | — | Requires real Google creds |
| A-02b | Email-first login page layout | Open login page | Email field shown; `Send login link` button on the left; `Sign in with password` link on the right; Google button below divider | ✅ | 2026-07-11: Updated — login/register toggle removed; email-link is primary CTA; password is inline expansion |
| A-02c | Send login link — valid email | Enter a valid email; click `Send login link` | Generic success screen shown: "Check your email" with mail icon and message; `Send another link` button visible | ✅ | 2026-08-05: "Check your email" + "A login link has been sent…" + `Send another link` button shown |
| A-02d | Login link sent — resend | After link sent, click `Send another link` | Resends the login link; success screen stays; no regression | ✅ | 2026-08-05: Rate-limited message "Please wait before requesting another login link." shown (expected rate limiting) |
| A-02e | Sign in with password expand | On login page, click `Sign in with password` link | Password field appears below email field; the link is replaced by a `Sign in` button; `Send login link` button remains visible and usable | ✅ | 2026-08-05: Password field appears; link replaced by `Sign in` button; `Send login link` remains |
| A-02f | Password visibility toggle | Expand password field; click the show/hide icon | Password text toggles between visible and hidden; aria-label updates accordingly | ✅ | 2026-08-05: Toggles between "Show password" / "Hide password" |
| A-02g | Password sign-in — valid credentials | Expand password; enter email + password for an account with local identity; click `Sign in` | Authenticated and redirected to `/mission-control` | — | |
| A-02h | Password sign-in — wrong password | Expand password; enter correct email but wrong password; click `Sign in` | Error message shown; does not reveal whether email exists | — | 2026-07-11: "Invalid email or password." returned |
| A-02i | Password sign-in — unknown email | Expand password; enter unregistered email with any password; click `Sign in` | Same error wording as wrong password (no enumeration) | — | |
| A-02j | Password sign-in — passwordless account | Expand password; enter email of a Google-only or login-link-only account; click `Sign in` | Dedicated error shown: "This account uses email-link or Google sign-in. Use those methods to sign in." | — | 2026-07-11: New error code `auth.login.password_not_available` returned |
| A-02k | Enter key — collapsed state | Focus the email field with password collapsed; press Enter | Sends a login link (not a password sign-in attempt) | — | 2026-07-11: Enter in collapsed state triggers `sendLoginLink` |
| A-02l | Enter key — expanded state | Expand password; focus the password field; press Enter | Triggers password sign-in (not login-link send) | — | 2026-07-11: Enter in password field triggers `auth.login` |
| A-02m | Login-link callback — valid token | From email client, click a valid login link (GET `/auth/login-link/callback?token=...`) | Redirected to `/auth/callback?code=...`, then to `/mission-control`; user authenticated | — | Existing exchange-code callback reused |
| A-02n | Login-link callback — invalid/expired token | Navigate to `/auth/login-link/callback?token=bad-token` | Error: "Invalid or expired login link." | — | |
| A-02o | Login-link callback — missing token | Navigate to `/auth/login-link/callback` (no `?token=`) | Error: "Missing login token." | — | |
| A-02p | First-time user creation via login link | Click a login link for an email not yet in the system | User created automatically with display name derived from email local-part; signed in and redirected to `/mission-control` | — | No separate registration step |
| A-02q | Send login link — invalid email | Enter "notanemail"; click `Send login link` | Client-side validation prevents submission or API returns 400 | ✅ | 2026-08-05: "Enter a valid email address" error shown |
| A-02r | Submit disabled while pending | Click `Send login link` or `Sign in` while an API call is in-flight | Button shows loading text and is non-interactive until response | — | |
| A-02s | Google OAuth still works | Click "Continue with Google"; complete Google auth flow | Redirected to `/auth/callback`, then to `/mission-control`; user authenticated | — | Google OAuth preserved unchanged |
| A-03 | Auth callback with invalid/expired code | Navigate to `/auth/callback?code=invalid-code` | Error state shown; user can return to login | ✅ | 2026-07-07: "Invalid or expired exchange code." shown with "Back to sign-in" link |
| A-04 | Auth callback with missing code param | Navigate to `/auth/callback` (no `?code=`) | "Missing exchange code in callback URL." shown with "Back to sign-in" link | ✅ | 2026-07-07: Exact text confirmed |
| A-05 | One-time code use | Copy the `/auth/callback?code=…` URL; use it a second time | Second use shows error (code already consumed) | — | |
| A-06 | Explicit logout | Click "Sign out" in the nav footer | Token cleared; redirected to `/login`; back button does not show authenticated state | ✅ | 2026-07-07: Sign out → /login; token cleared; subsequent protected nav redirects to /login |
| A-07 | Post-logout cache cleared | Log out; log back in as same user; navigate to Mission Control | Fresh data loaded from the API | — | |
| A-08 | Session expiry — server 401 | Invalidate JWT in Redis; attempt any navigation | Redirected to `/login`; no stale data | — | |
| A-09 | Re-login same tab clears cache | Let session expire; log in again in same tab | Fresh data loaded; no cross-session leak | — | |
| A-10 | Direct navigation to protected route unauthenticated | Paste `/agents` in URL bar without token | Redirected to `/login` | ✅ | 2026-07-07: /agents while logged out → /login |
| A-11 | Token persisted across page reload | Log in; hard-reload (`Cmd+Shift+R`) | Stays authenticated; no redirect to login | ✅ | 2026-07-07: After hard-reload, still on /agents/:id; authenticated |

---

## 2. Navigation & Layout

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| N-01 | Sidebar renders all links | Log in; inspect left navigation | Primary: Agents, Skills, Connections, Activity, Billing, Settings. No "Advanced" section. | ✅ | 2026-08-10: Advanced section removed; Bots moved to Preview (admin-only) |
| N-02 | Active link highlighted | Click each nav link | Current page link is visually active | ✅ | 2026-07-07: Active link shows green background + green text (verified on AI Agents page screenshot) |
| N-03 | Root redirect (authenticated) | Navigate to `/` as authenticated user | Redirected to `/agents` | — | 2026-08-06: Updated — redirect target changed from `/mission-control` to `/agents` |
| N-04 | Unknown route | Navigate to `/does-not-exist` | React Router error boundary shown (404 Not Found); does not crash | ✅ | 2026-07-07: Shows "Page not found" with "← Back to Mission Control" button; no crash |
| N-05 | Page titles / headings | Visit each page | Each page has a visible `PageHeader` with title and subtitle | ✅ | 2026-07-07: Verified Mission Control, AI Agents, Connections, Billing, Settings, Credentials, Trading setup, Outcomes, 404 — all have h1 + subtitle |

---

## 3. Mission Control

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| MC-01 | Summary metrics render | Open Mission Control | Shows agent-state metric cards for Active, Paused, Unhealthy, and Stopped | ✅ | 2026-07-07: Shows Active 0/1, Paused 0, Unhealthy 0, Stopped 1 (after creating one agent) |
| MC-02 | Header CTA renders | Open Mission Control | No "Create agent" button in the page header — the create flow is a persistent panel below the tabs | ✅ | 2026-08-05: Header CTA removed; create flow panel is always present below the tabs |
| MC-03 | Agent overview cards | Open Mission Control with agents | One card per agent under "Your agents"; shows status, execution mode, objective, and capability readiness; clicking the card navigates to the agent detail page | ✅ | 2026-07-07: Card shows agent name, "stopped" badge, "Paper mode" pill, goal text, capability readiness; card is clickable. 2026-09-21: capability line now lists families generically ("Capabilities: trading, email" / "Capabilities: none") instead of a hardcoded "Trading: Ready/Unconfigured" badge |
| MC-04 | Recent activity feed | Open Mission Control | Activity feed moved to the sidebar ("Activity" nav item below Connections) and the `/activity` page; no right-panel feed on the agents page | ✅ | 2026-08-05: Right activity panel removed from agents page; activity lives on `/activity` via the sidebar |
| MC-05 | Empty state — no agents | Open Mission Control with fresh account | No "No agents yet" empty state; guided chat is the default entry point for new users; metrics show zeros | ✅ | 2026-08-05: Empty state removed — new users land on the guided chat instead; metrics show 0 on fresh account |
| MC-06 | "Create agent" button navigates | Click the create-flow title | Expands the create flow panel (guided chat by default); `?create=1` forces it open | ✅ | 2026-08-05: Clicking the "Create AI agent" title expands the flow; `?create=1` forces expansion |
| MC-07 | Clicking an agent card navigates | Click anywhere on an agent card | Navigates to `/agents/:id` | ✅ | 2026-07-07: Card click navigated to /agents/172b77b6-... |
| MC-08 | Capability CTA opens agent capability page | Open agent detail, expand Capabilities section, click capability button | Navigates to `/agents/:id/capabilities/trading` | — | Capability CTA moved from summary card to agent detail page |
| MC-09 | Data staleness | Leave page for >30 s; return | Data refetches and reflects current agent state | — | |
| MC-10 | Loading state | Open page on slow connection (throttle in DevTools) | Loading skeleton shown while fetching | — | |
| MC-11 | API error state | Kill API; open page | Error state shown with retry; no crash | — | |
| MC-12 | Quick trading setup card renders | Open Mission Control | "Quick trading setup" card visible in the agents column with "Add trading provider" button | ✅ | 2026-07-07: Card now titled "Connect AI agent to external platform" with "Connect AI agent" button (renamed again from previous "Quick AI agent connect") |
| MC-13 | Quick trading setup — opens form | Click "Add trading provider" | Modal opens with provider, label, and secrets fields | ✅ | 2026-07-07: "Connect AI agent" button opens dialog titled "Connect agent to external platform" with provider selector (Hyperliquid/Bybit/1inch/Jupiter), label, and secrets fields |
| MC-14 | Quick trading setup — submit | Fill in provider (e.g. hyperliquid), label, and valid secrets; click "Set up trading provider" | Modal closes; success banner shows "{label} ({provider}) has been set up." | — | |
| MC-15 | Quick trading setup — success dismiss | Click "Done" on the success banner | Banner disappears; setup card returns to default state | — | |
| MC-16 | Quick trading setup — validation | Submit form with empty provider or label | Submit button disabled; form cannot be submitted | ✅ | 2026-07-07: "Connect AI agent" button disabled until label is filled (provider has a default selection) |
| MC-17 | Quick trading setup — API error | Submit with invalid secrets | ErrorBanner shown inside modal; modal stays open | ✅ | 2026-07-07: "secret is required for hyperliquid." error shown inline in dialog; dialog stays open |

---

## 4. Bots (Advanced)

Route: `/bots` — lists advanced trading bots created by a user or by an agent.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| I-01 | Bots list renders | Navigate to `/bots` | Page titled "Bots"; subtitle "Trading bots created by you or your agents"; list shows status badges | ✅ | Title "Bots"; subtitle "Trading bots created by you or your AI agents" |
| I-02 | Empty state | Open with no bots | "No bots yet" empty state; "Create Bot" CTA | ✅ | Covered by E2E journey 17 |
| I-03 | Create bot — happy path | Click "Create Bot"; fill required fields; submit | Bot appears in list | — | Requires at least one active connection; manual UAT until test credentials are provisioned |
| I-04 | Create bot — validation error | Submit form with missing required fields | Field-level or banner error shown; form not dismissed | ✅ | Create Bot button disabled when connection is empty; covered by E2E journey 17 |
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
| AG-01 | Agents list renders | Navigate to `/agents` | Page titled "AI Agents"; subtitle "Affordable AI agents that get the job done" | ✅ | Title "AI Agents"; subtitle "Affordable AI agents that get the job done" |
| AG-02 | Empty state | Open with no agents | No "No agents yet" empty state; guided chat is the default entry point for new users | ✅ | 2026-08-05: Empty state removed — new users land on the guided chat instead |
| AG-03 | Create agent — happy path | Click "New agent"; fill goal, preset, and execution mode; submit | Agent detail page opens for the new agent | ✅ | Created test-agent-01; navigated to /agents/:id |
| AG-03a | Create flow panel — new user | Open `/agents` with 0 agents | Create flow is expanded by default showing guided chat; no header CTA button | ✅ | 2026-08-05: New user sees guided chat expanded; no "New AI agent" button |
| AG-03b | Create flow panel — returning user | Open `/agents` with ≥1 agent | Create flow is collapsed; "Create AI agent" title still visible; clicking it expands | ✅ | 2026-08-05: Collapsed with title visible; click expands to guided chat |
| AG-03c | Create flow — switch forms | Expand the flow; click the header switch | Toggles between guided chat and the plain form; switch label updates | ✅ | 2026-08-05: "Use the form" ↔ "Use guided chat" toggles correctly |
| AG-04 | Create agent — validation | Submit with missing required fields | Error banner shown; form not dismissed | ✅ | "Review →" button disabled when goal is empty; no submission possible |
| AG-05 | Start agent | Open agent detail; click "Start" | Status transitions `stopped` → `starting` → `active`; worker picks up within ~2 s | ✅ | stopped → starting → active observed; Stop button appeared immediately |
| AG-06 | Agent detail page renders | Click agent name | Navigates to `/agents/:id`; shows Status, Execution mode, Objective, Capabilities, Prompt Surfaces, Runtime Health (if active), Messages to User, Protocol Activity, and Artifacts | ✅ | Status label now shows "Status" after adding `common.status` i18n key; Execution mode only shown when agent has trading capability (intentional) |
| AG-07 | Start button when stopped | Open agent detail for stopped agent | "Start" button shown in header | ✅ | "Start" button shown alongside Edit and Delete |
| AG-08 | Pause/Resume buttons | Open detail for active agent | "Pause" shown when active; "Resume" when paused | ✅ | Pause → paused, Resume → active verified |
| AG-09 | Stop button visibility | Open detail for active/starting/paused/unhealthy agent | "Stop" button shown | ✅ | Stop button visible; transitions to stopped with "Session stopped" timeline event |
| AG-10 | Crashed alert banner | Open detail for crashed agent | "Agent crashed. The runtime stopped unexpectedly." error banner shown | — | Banner shown when agent status is crashed |
| AG-11 | Unhealthy alert banner | Open detail for agent with unhealthy session | Warning banner about missing heartbeats | — | "Agent runtime is unhealthy. Heartbeats are missing and the worker is recovering." shown when activeSession.status=unhealthy and agent.status≠stopped. Bug 005 fixed. |
| AG-12 | Start delay | Click "Start" on stopped agent | `starting` phase lasts ≤2 s (worker reconcile interval) before transitioning | — | healthCheckIntervalMs: 2000 in config/default.yaml; container death detected immediately when Docker event stream live |
| AG-13 | Sessions run count | Open agent detail | "Sessions run" KV shows correct count | ✅ | Shows 1 after first Start; increments correctly |
| AG-14 | Capability section | Open detail for agent with capabilities | Capability cards show readiness, connection readiness, agent eligibility, reasons, and an "Open" action | ✅ | Trading capability page shows State, Connection readiness, AI agent eligibility, Effective ready, Connection, Why this state reasons, Next steps |
| AG-15 | Messages to User section | Open detail for agent with messages | Messages listed with subject, body, delivery status, timestamp; safety alerts styled distinctly | — | Messages shown with author icon, subject bold, body text, delivery status badge (delivered/pending), relative timestamp |
| AG-16 | Protocol Activity section | Open detail for agent with activity | Activity entries listed with type and timestamp | ✅ | "Activity Timeline" shows Tick started, LLM dispatched, Tool called, Tool result, Session started events with relative timestamps |
| AG-17 | Artifacts section | Open detail for agent with artifacts | Artifacts listed with type, content type, optional summary, timestamp | — | Shows artifact_type · content_type, summary text, relative timestamp |
| AG-18 | Real-time refresh | Leave agent detail open while agent is starting | Status badge updates via 5 s polling without manual refresh | ✅ | Status updated starting → active without manual refresh |
| AG-19 | Create agent — no bindings shows setup button | Open Create Agent with a trading skill; ensure no connections exist | "No active connections yet" text + "Set up trading now" secondary button shown instead of connection selector | ✅ | "No active connections yet. Set up trading now..." + "Set up trading now" button shown |
| AG-20 | Create agent — inline setup opens form | Click "Set up trading now" | Modal replaces with ProviderSetupForm; main create flow is suspended | ✅ | "Add trading connection" form appeared when clicked |
| AG-21 | Create agent — inline setup success auto-selects | Complete setup form with valid credentials | ProviderSetupForm closes; connection selector appears with new connection pre-selected | — | |
| AG-22 | Capability page — trading next steps | Open any agent's trading capability page | "Go to Mission Control" primary button shown in Next steps; no longer shows /connections or /credentials links for trading | ✅ | "Go to Mission Control" button in Next steps; no /connections or /credentials links |
| AG-23 | Prompt surfaces render when allowed | Open an agent detail page on a plan that allows prompt visibility and has a recent runtime snapshot | "Prompt surfaces" section shows tabs for Judge System, Scout System, User Context, and Judge User Context; switching tabs changes the prompt pane | ✅ | All four tabs visible when agent active; switching tabs changes prompt text |
| AG-24 | Prompt visibility is plan-gated | Open an agent detail page on a plan that disallows viewing own prompts | "Prompt visibility is not available on your current plan." is shown and the prompt query is not loaded | — | |
| AG-25 | Create agent — connection selector shows connections | Open Create Agent with trading skill; have active connections | Dropdown lists active connections by label and provider | — | |
| AG-26 | Create agent — inline setup creates connection directly | Click "Set up trading now"; complete form | Connection created (no intermediate binding); connection appears in selector | — | |

### 6.0a Capability-Agnostic Presentation (C3)

Run these after C3 updates them for the implemented UI and records the commit
under test. They are blocked until C3 is implemented.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-C01 | Generic agent surfaces omit trading presentation | Open `/agents` and an agent detail for a trading-capable fixture with execution mode, strategy, and P&L data | Generic list, summary, and detail header show lifecycle and generic capability readiness only. They show no execution mode, authorization mode, strategy, P&L, trade count, win rate, trade history, or trading-specific color treatment. | 🔒 | 2026-09-19; commit: `a506d95ae428af902e9913bf0b9343ed0be53c0c`; blocked: no running web/API stack or authenticated trading-capable fixture. Attempts to open localhost ports 5173, 8080, and 3000 failed. |
| AG-C02 | Capability presentation selects a bound connection | Bind two ready trading connections to one agent; mark one as the default; open its trading capability page | The page identifies and renders the default-ready connection through generic attributes and feeds; changing the selected/default binding refreshes the displayed connection without leaking the other connection's data | 🔒 | C3b; requires profile-backed presentation |
| AG-C03 | Unavailable capability presentation is explicit | Open a trading capability page with no ready bound connection, then simulate an unavailable capability read | A generic unavailable/error state is shown; no stale, guessed, or raw trading values appear. C3a may use the transitional adapter only when an existing source is available. | 🔒 | 2026-09-19; commit: `a506d95ae428af902e9913bf0b9343ed0be53c0c`; blocked: no running web/API stack or authenticated fixture available to exercise connection-unavailable state. Attempts to open localhost ports 5173, 8080, and 3000 failed. |
| AG-C04 | Backend semantic emphasis controls presentation | Use fixtures that return positive, negative, warning, and neutral attribute/feed emphasis | The same generic components apply their theme treatment from backend emphasis only; the frontend does not calculate P&L sign or receive CSS/color values | 🔒 | C3b |
| AG-C05 | Second capability uses the same renderer | Render a fixture non-trading capability with attributes and a feed | It renders through the same generic capability attribute/feed components with no trading-specific branch, label, formatter, or layout. | ✅ | 2026-09-19; commit: `a506d95ae428af902e9913bf0b9343ed0be53c0c`; evidence: focused static UI test renders a non-trading inbox/messages fixture through the generic components and asserts no `trading` label. |
| AG-C06 | Capability presentation is usable on mobile | Repeat AG-C01 and AG-C03 at a mobile viewport | Generic attributes, feeds, status, and connection selection remain readable, non-overlapping, and operable. | 🔒 | 2026-09-19; commit: `a506d95ae428af902e9913bf0b9343ed0be53c0c`; blocked: no running web/API stack, authenticated fixtures, or browser-renderable route for mobile validation. Attempts to open localhost ports 5173, 8080, and 3000 failed. |

### 6.1 Edit Agent Form

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-E01 | Edit form opens | On agent detail, click "Edit" | Edit modal opens; all fields pre-filled from agent data (name, goal, style, capital, etc.) | — | |
| AG-E02 | Style selector pre-filled | Open edit form for an agent with a known style | Style selector reflects the agent's current style (or "Balanced" if unknown) | — | |
| AG-E03 | Style change drives defaults | In edit form, change Style from Careful to Bold | Cost preset, tick interval, and daily budget update to Bold defaults | — | |
| AG-E04 | Save changes — happy path | Edit name and goal; click "Save changes" | Modal closes; agent detail reflects updated name and goal | — | |
| AG-E05 | Save changes — validation | Clear name field; click "Save changes" | Error shown; form not dismissed | — | |
| AG-E06 | Shadow mode admin-only in edit | As non-admin: open edit form for a trading agent | Execution mode dropdown shows only "Paper" and "Live". As admin: "Shadow" also available. | — | |
| AG-E07 | Advanced settings tabs present | Open edit form; expand Advanced Settings | Three tabs visible: AI Configuration, Trading Setup, Strategy — same as create form | — | 2026-07-13: Updated — Skills tab removed; Hybrid Wake Mode moved from Strategy to Trading Setup |
| AG-E08 | Custom preset exposes skill picker | Open edit form; set Skill Preset = "Custom" | SkillPicker is shown inline above the objective field; skill changes are reflected on save | — | 2026-08-01: Updated — Skills tab was removed; custom skills now render inline in the main form |
| AG-E09 | Model selection visible | Open edit form for agent with intelligence capability | AI Configuration tab shows model provider/economy/premium fields directly (no inherit/override toggle) | — | |
| AG-E10 | Guardrails & authorization editable | Open edit form; expand Advanced Settings → Trading Setup | Trade Authorization (Auto / Require approval), daily max loss %, slippage (BPS), max open positions, stop-loss % fields present and editable | — | 2026-08-01: Trade Authorization moved into Trading Setup tab (after Venue/Execution Mode); labels shortened to "Auto" / "Require approval". WP7: field names updated to canonical vocabulary (dailyMaxLossPct, slippageBps, stopLossPct). | |
| AG-E11 | Edit non-trading agent — connections visible | Open edit form for a non-trading agent | "Connect to external platform" section is visible in the main form, but it is optional. If active connections exist, they can be selected; if none exist, the empty state still shows the add-connection action and the form remains saveable. | — | 2026-08-01: Updated after generic providers like Gmail were added for non-trading agents |

### 6.1a Agents — Forced Strategy Review

Route: `/agents/:id` — dedicated operator control to trigger a deterministic strategy review on demand.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-R01 | Force-review control visibility | Open an agent detail page for an agent with periodic strategy assessment enabled | A dedicated strategy-review control is visible in the Evaluations area | — | |
| AG-R02 | Force-review unavailable state | Open an ineligible agent detail page | The control is either hidden or disabled, and the UI does not present it as an active action | — | Final copy depends on implementation choice |
| AG-R03 | Force-review trigger — request accepted | Click the strategy-review control for an eligible agent | The UI enters a pending state and shows that the manual review request was accepted | — | |
| AG-R04 | Force-review terminal no-advice outcome | Trigger a review when the agent has no qualifying candidates | The request completes with a valid no-advice or no-candidate result, not a generic error | — | |
| AG-R05 | Force-review remains separate from evaluation | Trigger a strategy review from the agent detail page | No general evaluation run is created automatically; the feature remains distinct from Run Evaluation | — | |

---

## 6b. Agents — Simplified Creation Flow

Route: `/agents?create=1` — simplified create-agent form with Style selector, auto-derived defaults, and inline validation.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-S01 | Create agent — simplified flow | Click "New agent"; fill Goal, select Skill Preset "trading", select Style "Balanced", enter 1000 in Capital; click Review → Create | Agent created with correct cost preset (standard), tick interval (30 min), and risk tolerance (moderate) derived from Style. Capital=1000, dailyLossLimit=50.00 | — | |
| AG-S02 | Create non-trading agent | Click "New agent"; select Skill Preset = "personal-assistant" | Capital and other trading-only controls are hidden. The "Connect to external platform" section remains visible so generic providers like Gmail can still be linked, but leaving it empty does not block create. Style selector is still visible and functional. | — | 2026-08-01: Updated after non-trading agents began supporting generic connections |
| AG-S03 | Style selector applies defaults | In create form, select each Style (Careful/Balanced/Bold) | Verify cost preset, tick interval, daily budget, and risk tolerance match the Style→Values mapping table. Open Advanced Settings after each change to verify. | — | |
| AG-S04 | Auto-generated name | In create form, change Style selection | Name field updates to `<style>-agent-<N>` (e.g., balanced-agent-0). Manually edit name → further style changes do not overwrite it. Close and reopen form → name is freshly auto-generated. | — | |
| AG-S05 | Capital → daily max loss % auto-fill | Enter capital = 1000 in create form | Open Advanced Settings → Trading Setup → daily max loss % is 5.00. Manually edit to 10.00. Change capital to 2000 → stays at 10.00 (not overwritten). Clear field → change capital → auto-fills to 10.00. | — | |
| AG-S06 | Shadow mode admin-only | As non-admin user: open create form with trading preset, expand Advanced Settings → Trading Setup | Execution mode dropdown shows only "Paper" and "Live" options. No "Shadow" option. As admin user: "Shadow" option is available. | — | |
| AG-S07 | Advanced settings accordion | In create form, click to expand "Advanced Settings" (or it may already be in accordion view) | Three sections visible: AI Configuration, Trading Setup, Strategy. Each independently expandable. Collapsing hides its fields. | — | 2026-07-13: Updated — Skills tab removed |
| AG-S08 | Inline validation on Review | Leave objective/prompt empty; click "Review →" | Error message shown below objective/prompt field: "Objective / prompt is required." Page scrolls to objective/prompt field. Fill in objective/prompt; error clears. Enter maxOpenPositions = 999 (exceeds platform limit) → click Review → error shown below that field. | — | |
| AG-S09 | Max bots plan-derived | In create form with bot-management skill, expand Advanced Settings → check for max bots | No max bots input field. Informational text reads "Maximum concurrent bots is determined by your plan." | — | |
| AG-S10 | Override Style in Advanced | Select Style = Careful; open Advanced Settings → AI Configuration; change cost preset to premium | Tick interval and daily budget update accordingly. The visual Style indicator may change (or show "Custom"). | — | |
| AG-S11 | Review step reflects simplified fields | Create agent with trading preset, Balanced style, capital=1000; click Review | Review summary shows: name, goal, capability mode ("Trading + Intelligence"), style label ("Balanced"), capital ("1000"), execution mode ("Paper"). No raw config IDs or internal field names. | — | |
| AG-W01 | Wake sources — non-trading agent | Create a non-trading agent (personal-assistant); open Advanced Settings → AI Configuration | No wake source checkboxes shown. Reminders are always-on — no UI needed. | — | |
| AG-W02 | Wake sources — trading agent layout | Create a trading agent (Filter Trades = Off); open Advanced Settings → Strategy | Title reads "Which notices should the agent receive?". Three checkboxes: Price alerts, Newly trending tokens, Market regime shifts — all pre-checked by default. No count text. Scanner is NOT listed (implicitly controlled by Filter Trades mode). Reminders is NOT listed (always-on, forced by design). | — | 2026-07-13: Updated — Filter Trades replaces pre-filter + hybrid mode; wake sources simplified to description-only labels |
| AG-W03 | Wake sources — toggle checkboxes | In Strategy tab, uncheck Price alerts; then re-check it | Checkbox toggles independently. No count or status text shown — just the title "Which notices should the agent receive?" and the three checkbox items. Unchecking all three is allowed (empty selection means no wake sources active). | — | 2026-07-13: Updated — simplified UI removes count text and default-fallback message |
| AG-W04 | Wake sources — edit preserves selection | Create a trading agent with specific wake sources; open the Edit modal → Advanced Settings → Strategy | Previously selected wake sources are reflected in the checkboxes. | — | 2026-07-13: Updated — wake sources moved to Strategy tab |
| AG-W05 | Wake sources — scanner implicit with Filter Trades | In Strategy tab, change Filter Trades from Off → Mixed → Filter | Filter Trades is a 3-way selector. Off: wake source checkboxes shown. Mixed: wake source checkboxes shown; strategy presets and technical config appear. Filter: wake source checkboxes hidden (filter is the sole wake source); strategy presets and technical config appear. Scanner is never shown as a checkbox. | — | 2026-07-14: Updated — Filter Trades option labels changed; "Scanner only" → "Filter" |

---

## 6c. Agents — Dedicated Create Page

Route: `/agents/new` — dedicated page for agent creation with URL-driven form vs. chat mode.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-D01 | Default mode is form | Navigate to `/agents/new` with no query params | The plain form-based creation flow is shown (not the guided chat). URL remains `/agents/new`. | — | 2026-08-10: `/agents/new` now defaults to form; guided chat requires `?ui=chat` |
| AG-D02 | Query param enables chat | Navigate to `/agents/new?ui=chat` | The guided chat flow is shown. URL updates to `/agents/new?ui=chat`. | — | |
| AG-D03 | Toggle switch updates URL | On `/agents/new`, click the toggle to switch to guided chat | Mode switches to guided chat. URL updates to `/agents/new?ui=chat`. | — | |
| AG-D04 | Toggle switch removes query param | On `/agents/new?ui=chat`, click the toggle to switch to form | Mode switches to form. URL updates to `/agents/new` (no query param). | — | |
| AG-D05 | Chat "Use the form" link updates URL | In guided chat mode, click or follow the "Use the form" suggestion from the chat agent | Mode switches to form. URL updates to `/agents/new`. | — | Depends on GuidedSetupPanel's onSwitchToForm callback |
| AG-D06 | Direct navigation preserves mode | Navigate directly to `/agents/new?ui=chat` | Guided chat loads (not form). No redirect or mode flash. | — | |
| AG-D07 | Refresh preserves mode | On `/agents/new?ui=chat`, refresh the page | Stays in guided chat mode. URL unchanged. | — | |

---

## 7. Skills

Route: `/skills` — capability bundles that tell agents what they can do.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| SK-01 | Skills page renders | Navigate to `/skills` | Page titled "Skills"; shows "Built-in skills", "Your skills", and "Marketplace" sections according to plan access; admins may also see "Admin skill catalog" | ✅ | "Built-in skills" shown; "Your skills" and "Marketplace" sections only render when non-empty (correct behavior — no user skills on fresh account) |
| SK-02 | Create composer exposes plan-aware visibility choices | Click "Create skill" | Composer shows Draft, Private, and Marketplace (public); unavailable options are disabled and helper text reflects auto-publish/private restrictions | ✅ | Draft, Private (disabled), Marketplace (public) visible; "Your current plan auto-publishes any non-draft skill." shown |
| SK-03 | Free plan auto-publishes non-draft skills | Create a non-draft skill on the free plan | Created skill is auto-published and the plan note says non-draft skills auto-publish | — | |
| SK-04 | Marketplace access is gated by plan | Open `/skills` on a plan without marketplace access | Marketplace section is hidden and the page shows "Marketplace access is not available on your current plan." | ✅ | Free plan has `canViewMarketplaceSkills: true`; no-marketplace message only shown when plan disallows it — tested with a plan that hides marketplace |
| SK-05 | Skill card actions respect normalized state | Open built-in, personal, and marketplace cards | Built-in and marketplace cards show Copy icon (two overlapping sheets); marketplace user skills show Like icon (thumbs-up, fills solid when liked), Edit icon (pencil, toggles to X when editor open), Publish icon (eye), Delist icon (eye with slash); price labels render for priced skills | — | |

---

## 8. Outcomes

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| O-01 | Outcome board renders | Navigate to `/outcomes` | Page titled "Outcome Board" loads | ✅ | "Outcome Board" with subtitle "How each AI agent is progressing" |
| O-02 | Total realized P&L aggregation | View an agent with multiple closed positions | Total P&L is the correct arithmetic sum | — | |
| O-03 | Total P&L sign coloring | Inspect positive vs negative total P&L | Green for profit, red for loss | — | |
| O-04 | Total P&L 2 decimal places | Inspect total P&L display | Always shows exactly 2 decimal places | — | |
| O-05 | No positions | View agent with no open positions | Positions section hidden or empty state shown | — | |
| O-06 | Empty state — no agents or positions | Open with fresh account | Page renders without crashing; no "No AI agents yet" empty state (guided chat is the default entry point) | ✅ | 2026-08-05: Empty state removed — page renders cleanly with guided chat as the default |

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
| AF-01 | Activity feed renders | Navigate to `/activity` | Page loads with event list or empty state | ✅ | "Activity" heading with subtitle "What your AI agents have been doing"; All/Agents/Bots filter tabs shown; agent summary metrics (Active/Paused/Unhealthy/Stopped/Total P&L) shown at top |
| AF-02 | Pagination / infinite scroll | Scroll to bottom of activity list | Next page of events loads (or "Load more") | — | "Load older events" button appears; clicking it loads next page (fixed bug 017: Date object passed to SQL query caused 500) |
| AF-03 | Empty state | Fresh account with no activity | Empty state shown | ✅ | "No activity yet" with explanatory copy; agent summary metrics still shown above |
| AF-04 | Timestamps | Inspect event timestamps | Dates formatted readably; no epoch numbers | ✅ | All timestamps show relative format ("13 sec. ago", "1 min. ago"); no raw epoch or ISO strings |
| AF-05 | Sidebar nav | Open sidebar | "Activity" nav item appears below "Connections" under Manage | ✅ | 2026-08-05: "◈ Activity" nav item added below Connections |

---

## 11. Connections

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| CN-01 | Connections list renders | Navigate to `/connections` | Page titled "Connections" with subtitle "External platforms your AI agents can connect to" | ✅ | Title "Connections"; subtitle: "External platforms your AI agents can connect to" |
| CN-02 | Empty state | Open with no connections | Empty state shown with copy about enabling capability families | ✅ | "No connections yet" empty state with explanatory copy |
| CN-03 | Create connection — happy path | Click "New connection"; fill provider and label; optionally choose a credential; submit | Connection appears in the list with provider and status | ✅ | Created "UAT Test Connection" (hyperliquid) with "active" status; connection card visible |
| CN-04 | Create connection — validation | Submit with missing provider or label | Create action disabled or error shown; connection not created | ✅ | "Create" button disabled until both provider and label filled |
| CN-05 | Revoke active connection | Click "Revoke" on an active connection | Status updates and the revoke button disappears | ✅ | Status changed to "revoked"; Revoke button disappeared (verified 2026-06-30) |
| CN-06 | Connection shows profile/providerRef | Create connection via provider-link setup | Connection card shows provider reference (e.g. wallet address) if present | — | |

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
| BL-02 | Usage summary cards render | Open the billing page with usage billing enabled | "AI Usage — Current Period" shows Account Status, Usage Charges, Credits Applied, Balance, and Hard Cap, plus threshold chips when a limit is reached | ✅ | 2026-08-05: "AI Usage — Current Period" card shown with "Usage Limit Reached" banner and "$0.0001 over limit" |
| BL-03 | Spend controls and top-ups render | Inspect the usage billing card | "Spend Controls" shows soft cap and hard cap inputs, "Update Spend Caps", and a top-up selector / "Buy Top-up" CTA when top-ups are enabled | — | |
| BL-04 | Usage filters and breakdown render | Open billing usage history | "Usage Filters", "Usage by Meter", "Usage by Agent", and "Billing Periods" sections render. "Billing Ledger" and "Usage Events" are admin-only. | — | 2026-08-10: Ledger + Usage Events gated to admin; "View details" toggle removed — all breakdowns always visible |
| BL-05 | Spend-state banner appears | Force the account into a soft or hard limited state | Banner says either "Approaching usage limit" or "Usage limit reached" and explains the operational impact | — | |
| BL-06 | Soft cap does not change agent behavior | Set a low soft cap; let the agent reach it | Agent continues running normally; no tick skip, no model downgrade, no scout suppression. Notification is sent. | — | |
| BL-07 | Hard cap stops the agent | Set a low hard cap; let the agent reach it | Agent halts on next tick; `TICK_SKIPPED` event emitted with reason `billing.limit_exceeded`. Notification sent with open-position context if applicable. | — | |
| BL-08 | Hard cap with open positions notifies clearly | Create an agent with an open position; force hard cap | Notification includes list of open positions and a statement that they are now unmanaged. Agent does not close or modify positions. | — | |
| BL-09 | Caps can be raised to unblock | After hard-cap stop, raise the cap from the Billing page | Agent resumes on next tick; status returns to active. | — | |
| ST-01 | Settings page renders | Navigate to `/settings` | Settings page loads without crash | ✅ | Shows Language, AI models, and Telegram Notifications sections; Save button disabled by default |
| ST-02 | Adaptive reasoning checkboxes visible | Navigate to `/settings` → AI models section | Two checkboxes visible: "Adaptive scout reasoning" and "Adaptive judge reasoning" — both checked by default | — | |
| ST-03 | Adaptive reasoning checkboxes toggleable | Uncheck both adaptive reasoning checkboxes; click Save | Settings saved; refresh page → both checkboxes remain unchecked | — | |
| ST-04 | Adaptive reasoning checkboxes visible to all users | Log in as non-admin user; navigate to `/settings` | Both adaptive reasoning checkboxes visible and functional | — | |
| ST-05 | Agent creation inherits adaptive prefs from settings | Set adaptive reasoning OFF in Settings → create a new agent | New agent's `runtimePolicyOverrides` includes `adaptScoutReasoning: false` and `adaptJudgeReasoning: false` | — | |
| ST-06 | Non-adaptive agent has deterministic reasoning | Create an agent with `adaptJudgeReasoning: false` and `judgeReasoning: medium` | Every tick uses the same reasoning level — no escalation variance | — | |

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

---

## 17. Try-It Email-First Onboarding

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| TRY-01 | Landing page shows "Try it" button | Visit `/` as unauthenticated user | "Try it" CTA links to `/try` | — | |
| TRY-02 | `/try` page loads for unauthenticated users | Visit `/try` without being logged in | Chat-like UI with typing animation, messages appear in sequence | — | |
| TRY-03 | Email validation on `/try` | Enter invalid email (e.g., "not-an-email") and submit | "Enter a valid email address" error shown | — | |
| TRY-04 | Email submission sends login link | Enter valid email and submit | "An email has been sent to..." message appears, check inbox for link | — | |
| TRY-05 | Login link redirects to guided chat | Click login link from email | Redirects to `/agents/new?ui=chat` after authentication | — | `/try` login links now point to guided chat (`?ui=chat`), not the form default |
| TRY-06 | `/try` resend button works | After link sent, click "Resend link" | Another email sent, rate-limit message if clicked too quickly | — | |
| TRY-07 | Authenticated user visiting `/try` | Log in, then navigate to `/try` | Redirected to `/agents/new?ui=chat` | — | |
| TRY-08 | `/try` page works on mobile | Visit `/try` on a mobile viewport (or resize browser) | Layout adjusts, inputs are full-width, messages readable | — | |
| TRY-09 | Post-auth experience after `/try` | Complete flow: `/try` → email → click link → authenticate | User lands at `/agents/new?ui=chat` and sees the guided chat | — | |
