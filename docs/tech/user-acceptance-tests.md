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
| A-02 | Google OAuth login | Click "Continue with Google"; complete Google auth flow | Redirected to `/auth/callback`, then to `/agents`; user authenticated; nav shown | — | Requires real Google creds |
| A-02b | Email-first login page layout | Open login page | Email field shown; `Send login link` button on the left; `Sign in with password` link on the right; Google button below divider | ✅ | 2026-07-11: Updated — login/register toggle removed; email-link is primary CTA; password is inline expansion |
| A-02c | Send login link — valid email | Enter a valid email; click `Send login link` | Generic success screen shown: "Check your email" with mail icon and message; `Send another link` button visible | ✅ | 2026-08-05: "Check your email" + "A login link has been sent…" + `Send another link` button shown |
| A-02d | Login link sent — resend | After link sent, click `Send another link` | Resends the login link; success screen stays; no regression | ✅ | 2026-08-05: Rate-limited message "Please wait before requesting another login link." shown (expected rate limiting) |
| A-02e | Sign in with password expand | On login page, click `Sign in with password` link | Password field appears below email field; the link is replaced by a `Sign in` button; `Send login link` button remains visible and usable | ✅ | 2026-08-05: Password field appears; link replaced by `Sign in` button; `Send login link` remains |
| A-02f | Password visibility toggle | Expand password field; click the show/hide icon | Password text toggles between visible and hidden; aria-label updates accordingly | ✅ | 2026-08-05: Toggles between "Show password" / "Hide password" |
| A-02g | Password sign-in — valid credentials | Expand password; enter email + password for an account with local identity; click `Sign in` | Authenticated and redirected to `/agents` | — | |
| A-02h | Password sign-in — wrong password | Expand password; enter correct email but wrong password; click `Sign in` | Error message shown; does not reveal whether email exists | — | 2026-07-11: "Invalid email or password." returned |
| A-02i | Password sign-in — unknown email | Expand password; enter unregistered email with any password; click `Sign in` | Same error wording as wrong password (no enumeration) | — | |
| A-02j | Password sign-in — passwordless account | Expand password; enter email of a Google-only or login-link-only account; click `Sign in` | Dedicated error shown: "This account uses email-link or Google sign-in. Use those methods to sign in." | — | 2026-07-11: New error code `auth.login.password_not_available` returned |
| A-02k | Enter key — collapsed state | Focus the email field with password collapsed; press Enter | Sends a login link (not a password sign-in attempt) | — | 2026-07-11: Enter in collapsed state triggers `sendLoginLink` |
| A-02l | Enter key — expanded state | Expand password; focus the password field; press Enter | Triggers password sign-in (not login-link send) | — | 2026-07-11: Enter in password field triggers `auth.login` |
| A-02m | Login-link callback — valid token | From email client, click a valid login link (GET `/auth/login-link/callback?token=...`) | Redirected to `/auth/callback?code=...`, then to `/agents`; user authenticated | — | Existing exchange-code callback reused |
| A-02n | Login-link callback — invalid/expired token | Navigate to `/auth/login-link/callback?token=bad-token` | Error: "Invalid or expired login link." | — | |
| A-02o | Login-link callback — missing token | Navigate to `/auth/login-link/callback` (no `?token=`) | Error: "Missing login token." | — | |
| A-02p | First-time user creation via login link | Click a login link for an email not yet in the system | User created automatically with display name derived from email local-part; signed in and redirected to `/agents` | — | No separate registration step |
| A-02q | Send login link — invalid email | Enter "notanemail"; click `Send login link` | Client-side validation prevents submission or API returns 400 | ✅ | 2026-08-05: "Enter a valid email address" error shown |
| A-02r | Submit disabled while pending | Click `Send login link` or `Sign in` while an API call is in-flight | Button shows loading text and is non-interactive until response | — | |
| A-02s | Google OAuth still works | Click "Continue with Google"; complete Google auth flow | Redirected to `/auth/callback`, then to `/agents`; user authenticated | — | Google OAuth preserved unchanged |
| A-03 | Auth callback with invalid/expired code | Navigate to `/auth/callback?code=invalid-code` | Error state shown; user can return to login | ✅ | 2026-07-07: "Invalid or expired exchange code." shown with "Back to sign-in" link |
| A-04 | Auth callback with missing code param | Navigate to `/auth/callback` (no `?code=`) | "Missing exchange code in callback URL." shown with "Back to sign-in" link | ✅ | 2026-07-07: Exact text confirmed |
| A-05 | One-time code use | Copy the `/auth/callback?code=…` URL; use it a second time | Second use shows error (code already consumed) | — | |
| A-06 | Explicit logout | Click "Sign out" in the nav footer | Token cleared; redirected to `/login`; back button does not show authenticated state | ✅ | 2026-07-07: Sign out → /login; token cleared; subsequent protected nav redirects to /login |
| A-07 | Post-logout cache cleared | Log out; log back in as same user; navigate to the agents page | Fresh data loaded from the API | — | |
| A-08 | Session expiry — server 401 | Invalidate JWT in Redis; attempt any navigation | Redirected to `/login`; no stale data | — | |
| A-09 | Re-login same tab clears cache | Let session expire; log in again in same tab | Fresh data loaded; no cross-session leak | — | |
| A-10 | Direct navigation to protected route unauthenticated | Paste `/agents` in URL bar without token | Redirected to `/login` | ✅ | 2026-07-07: /agents while logged out → /login |
| A-11 | Token persisted across page reload | Log in; hard-reload (`Cmd+Shift+R`) | Stays authenticated; no redirect to login | ✅ | 2026-07-07: After hard-reload, still on /agents/:id; authenticated |

---

## 2. Navigation & Layout

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| N-01 | Sidebar renders all links | Log in; inspect left navigation | Primary: Agents, Skills, Connections, Billing, Settings. No "Advanced" section. Admin users additionally see an "Admin" section (Dashboard). No "Preview" section. | ✅ | 2026-08-10: Advanced section removed. 2026-10-02: Preview section (Bots/Exposure/Outcomes/Activity) removed entirely along with those pages |
| N-02 | Active link highlighted | Click each nav link | Current page link is visually active | ✅ | 2026-07-07: Active link shows green background + green text (verified on AI Agents page screenshot) |
| N-03 | Root redirect (authenticated) | Navigate to `/` as authenticated user | Redirected to `/agents` | — | 2026-08-06: Updated — redirect target changed from `/mission-control` to `/agents` |
| N-04 | Unknown route | Navigate to `/does-not-exist` | React Router error boundary shown (404 Not Found); does not crash | ✅ | 2026-07-07: Shows "Page not found" with "← Back to AI Agents" button; no crash |
| N-05 | Page titles / headings | Visit each page | Each page has a visible `PageHeader` with title and subtitle | ✅ | 2026-07-07: Verified the agents page, AI Agents, Connections, Billing, Settings, Credentials, Trading setup, 404 — all have h1 + subtitle (Outcomes page retired 2026-10-02) |

---

## 3. Agents overview (agents page)

> Note: the "Mission Control" label was retired in 2026-10; these tests run
> against the agents page (`/agents`). Test IDs keep the `MC-` prefix for history.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| MC-01 | Summary metrics render | Open the agents page (`/agents`) | Shows agent-state metric cards for Active, Paused, Unhealthy, and Stopped at the top of the "My Agents" tab | ✅ | 2026-07-07: Shows Active 0/1, Paused 0, Unhealthy 0, Stopped 1 (after creating one agent). 2026-10-01: All four cards now rendered on the agents page (previously only Active); matches the metrics moved off the admin-only Activity page |
| MC-02 | Header CTA renders | Open the agents page | No "Create agent" button in the page header — the create flow is a persistent panel below the tabs | ✅ | 2026-08-05: Header CTA removed; create flow panel is always present below the tabs |
| MC-03 | Agent overview cards | Open the agents page with agents | One card per agent under "Your agents"; shows status, execution mode, objective, and capability readiness; clicking the card navigates to the agent detail page | ✅ | 2026-07-07: Card shows agent name, "stopped" badge, "Paper mode" pill, goal text, capability readiness; card is clickable. 2026-09-21: capability readiness is now two generic lines listing the distinct capability families present — "Skills: trading, email" (from the agent's skills) and "Connections: email, trading" (from bound connections' providers), or "none" when empty — instead of a hardcoded "Trading: Ready/Unconfigured" badge |
| MC-04 | No activity feed on the agents page | Open the agents page | No right-panel activity feed on the agents page | ✅ | 2026-08-05: Right activity panel removed from agents page. 2026-10-02: the standalone `/activity` page was deleted with the Preview section — there is no longer a dedicated activity feed |
| MC-05 | Empty state — no agents | Open the agents page with a fresh account | No "No agents yet" empty state; new users are redirected to the create form at `/agents/new`; metrics show zeros | — | 2026-10-15: redirect target changed from guided chat to the create form (Wave 3 plan 004). The prior ✅ results (2026-08-05, 2026-10-02) applied to guided chat. |
| MC-06 | "Create agent" button navigates | Click "Create AI agent" | Opens the create form at `/agents/new` | — | 2026-10-15: the create-flow panel and `?create=1` no longer apply (Wave 3 plan 004) |
| MC-07 | Clicking an agent card navigates | Click anywhere on an agent card | Navigates to `/agents/:id` | ✅ | 2026-07-07: Card click navigated to /agents/172b77b6-... |
| MC-08 | Capability CTA opens agent capability page | Open agent detail, expand Capabilities section, click capability button | Navigates to `/agents/:id/capabilities/trading` | — | Capability CTA moved from summary card to agent detail page |
| MC-09 | Data staleness | Leave page for >30 s; return | Data refetches and reflects current agent state | — | |
| MC-10 | Loading state | Open page on slow connection (throttle in DevTools) | Loading skeleton shown while fetching | — | |
| MC-11 | API error state | Kill API; open page | Error state shown with retry; no crash | — | |
| MC-12 | Quick trading setup card renders | Open the agents page | "Quick trading setup" card visible in the agents column with "Add trading provider" button | ✅ | 2026-07-07: Card now titled "Connect AI agent to external platform" with "Connect AI agent" button (renamed again from previous "Quick AI agent connect") |
| MC-13 | Quick trading setup — opens form | Click "Add trading provider" | Modal opens with provider, label, and secrets fields | ✅ | 2026-07-07: "Connect AI agent" button opens dialog titled "Connect agent to external platform" with provider selector (Hyperliquid/Bybit/1inch/Jupiter), label, and secrets fields |
| MC-14 | Quick trading setup — submit | Fill in provider (e.g. hyperliquid), label, and valid secrets; click "Set up trading provider" | Modal closes; success banner shows "{label} ({provider}) has been set up." | — | |
| MC-15 | Quick trading setup — success dismiss | Click "Done" on the success banner | Banner disappears; setup card returns to default state | — | |
| MC-16 | Quick trading setup — validation | Submit form with empty provider or label | Submit button disabled; form cannot be submitted | ✅ | 2026-07-07: "Connect AI agent" button disabled until label is filled (provider has a default selection) |
| MC-17 | Quick trading setup — API error | Submit with invalid secrets | ErrorBanner shown inside modal; modal stays open | ✅ | 2026-07-07: "secret is required for hyperliquid." error shown inline in dialog; dialog stays open |

---

## 4. Bots (Advanced) — ❌ RETIRED 2026-10-02

The `/bots` page was deleted when the admin-only Preview section was removed.
Tests `I-01`–`I-06` no longer apply. See
[`../features/2026/10/02/003-orphan-i18n-key-sweep.md`](../features/2026/10/02/003-orphan-i18n-key-sweep.md)
and the Preview-page deletion in the Phase 2 program.

---

## 5. Bot Detail — ❌ RETIRED 2026-10-02

The `/bots/:id` instance-detail page was deleted alongside the Preview section.
Tests `D-01`–`D-11` no longer apply.

---

## 6. Agents

Route: `/agents` — goal-driven platform agents with explicit skills and execution modes.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-01 | Agents list renders | Navigate to `/agents` | Page titled "AI Agents"; subtitle "Affordable AI agents that get the job done" | ✅ | Title "AI Agents"; subtitle "Affordable AI agents that get the job done" |
| AG-02 | Empty state | Open with no agents | No "No agents yet" empty state; new users are redirected to the create form at `/agents/new` | — | 2026-10-15: redirect target changed from guided chat to the create form (Wave 3 plan 004) |
| AG-03 | Create agent — happy path | Open `/agents/new`; enter a name; open Advanced Settings → AI and enter an objective; click "Review →"; click "Create AI agent" | Agent detail page opens for the new agent, stopped | — | 2026-10-16: steps updated to the current form. The ✅ result applied to the removed form |
| AG-03a | Create form — new user | Open `/agents` with 0 agents | Redirected to `/agents/new`; the create form shows the Name field prefilled with an adjective-noun name; objective, skills and connection are under Advanced Settings → AI | — | 2026-10-16: restored the full create form; guided chat removed (Wave 3 plan 004) |
| AG-03b | Create form — returning user | Open `/agents` with ≥1 agent; click "Create AI agent" | Opens `/agents/new` with the create form | — | 2026-10-15: guided chat removed (Wave 3 plan 004) |
| AG-03c | Retired 2026-10-15 | — | The guided chat and its header switch were removed (Wave 3 plan 004). | — | |
| AG-04 | Create agent — validation | Type `all` as the name; submit | Error banner shown; form not dismissed | — | 2026-10-15: goal-required validation was removed with the old form (plan 002); Name is optional |
| AG-05 | Start agent | Open agent detail; click "Start" | Status transitions `stopped` → `starting` → `active`; worker picks up within ~2 s | ✅ | stopped → starting → active observed; Stop button appeared immediately |
| AG-06 | Agent detail page renders | Click agent name | Navigates to `/agents/:id`; shows Status, Execution mode, Objective, Capabilities, Prompt Surfaces, Agent Health (if active), Protocol Activity, Artifacts, and the chat card titled "Chat with {name}" | ✅ | Status label now shows "Status" after adding `common.status` i18n key; Execution mode only shown when agent has trading capability (intentional) |
| AG-07 | Start button when stopped | Open agent detail for stopped agent | "Start" button shown in header | ✅ | "Start" button shown alongside Edit and Delete |
| AG-08 | Pause/Resume buttons | Open detail for active agent | "Pause" shown when active; "Resume" when paused | ✅ | Pause → paused, Resume → active verified |
| AG-09 | Stop button visibility | Open detail for active/starting/paused/unhealthy agent | "Stop" button shown | ✅ | Stop button visible; transitions to stopped with "Session stopped" timeline event |
| AG-10 | Crashed alert banner | Open detail for crashed agent | "Agent crashed. The runtime stopped unexpectedly." error banner shown | — | Banner shown when agent status is crashed |
| AG-11 | Unhealthy alert banner | Open detail for agent with unhealthy session | Warning banner about missing heartbeats | — | "Agent runtime is unhealthy. Heartbeats are missing and the worker is recovering." shown when activeSession.status=unhealthy and agent.status≠stopped. Bug 005 fixed. |
| AG-12 | Start delay | Click "Start" on stopped agent | `starting` phase lasts ≤2 s (worker reconcile interval) before transitioning | — | healthCheckIntervalMs: 2000 in config/default.yaml; container death detected immediately when Docker event stream live |
| AG-13 | Sessions run count | Open agent detail | "Sessions run" KV shows correct count | ✅ | Shows 1 after first Start; increments correctly |
| AG-14 | Capability section | Open detail for agent with capabilities | Capability page leads with a plain-language Status headline (ready / not-ready) + a human reason + a single clear action; the technical fields (connection readiness, agent eligibility, effective ready, connection) sit behind a **Details** toggle | ✅ | 2026-10-03 (plan 002, browser-verified @ localhost:8090): single "Capability readiness" Status card — headline "Not ready — no trading connection yet", reason "This agent needs a trading connection before it can trade.", one "Assign a connection" action. "Details" disclosure expands to Connection readiness=Unconfigured, AI agent eligibility=Ineligible, Effective ready=No, Connection=Not assigned. Old "Why this state" / "Next steps" / standalone "Readiness" cards all gone. |
| AG-15 | Chat card titled with the agent name | Open detail for an agent with messages | One card titled "Chat with {name}" holds the thread and composer. Messages are bubbles, oldest first: the agent's and safety alerts on the left, the user's on the right. The collapsed "Messages to user" section is removed | — | 2026-10-15: sections combined. Delivery status and subject are no longer shown on this page (activity feed keeps history). 2026-10-16: your messages are stored and shown on the right |
| AG-15b | Chat round trip keeps both sides | Open detail for a running agent; send "Buy more ETH."; wait for the agent's reply; reload the page | Your message appears on the right at once and is still there after reload; the agent's replies and safety alerts appear on the left, oldest first, and a new reply shows within about 3 seconds without a reload | — | 2026-10-16: new row. The send endpoint stores the user's message before publishing it. 2026-10-25 (CH2W P3): replies and alerts are also stored in the same chat; see CH2W-01 to CH2W-10 |
| AG-15c | Platform faults are reported to the admin, not left to the user | With `OPERATOR_ALERT_TELEGRAM_CHAT_ID` and `TELEGRAM_BOT_TOKEN` set, make an agent's shell tool fail with a sandbox infrastructure error; read the agent's chat message; repeat within 15 minutes | The operator chat gets one "Platform fault reported by an agent" message (the repeat is not sent). The agent tells the user briefly that something on the platform is not working, that the system admin has been informed, and that it is waiting. With the operator chat unset, the agent says it cannot continue until the platform is fixed and does not say the admin was informed | — | 2026-10-16: new row |
| AG-15d | Agent does not set its own objective | Create an agent and leave its objective blank; start it; send "help me trade crypto"; open the detail page. Then set the objective to "Monitor ETH" in the edit form and tell the agent "also watch SOL" | The agent replies and asks what you would like it to do; the objective stays blank. With "Monitor ETH" set, the agent asks whether to replace it or add to it, and changes it (with your wording) only after you answer. If you ask it to change the objective, it does | — | 2026-10-16: new row |
| AG-17 | Chat composer | Open detail for a running agent; type a message; press Enter; press Shift+Enter | Enter sends the message; Shift+Enter adds a line; the bottom bar shows n/4000 and the Send button; Send is disabled when empty or when the agent is not running | — | 2026-10-15: composer restyled to match the objective input. No attachment control yet (text only) |
| AG-18 | Detail page section order | Open detail for an agent | Chat card sits above the Activity Timeline; Agent Health (shown when the agent has an active session) sits directly below the chat card; Activity Timeline is the last section, after Artifacts | — | 2026-10-16: Activity Timeline moved to the bottom; Agent Health moved below the chat |
| AG-19 | Section titles and chat hints | Open detail for a running agent with no messages | Section titles (Objective, Capabilities, Chat with {name}, Agent Health, Prompt Surfaces, Artifacts, Activity Timeline) are bold, primary-colour and larger, in Title Case (not all capitals); the agent name in "Chat with {name}" keeps its own capitalisation. Chat hints such as "No messages yet." are muted and smaller than the title | — | 2026-10-16: emphasis changed on the agent detail page only; other pages unchanged |
| AG-16 | Protocol Activity section | Open detail for agent with activity | Activity entries listed with type and timestamp | ✅ | "Activity Timeline" shows Tick started, LLM dispatched, Tool called, Tool result, Session started events with relative timestamps |
| AG-17 | Artifacts section | Open detail for agent with artifacts | Artifacts listed with type, content type, optional summary, timestamp | — | Shows artifact_type · content_type, summary text, relative timestamp |
| AG-18 | Real-time refresh | Leave agent detail open while agent is starting | Status badge updates via 5 s polling without manual refresh | ✅ | Status updated starting → active without manual refresh |
| AG-19 | Create agent — no bindings shows setup button | Open Create Agent with a trading skill; ensure no connections exist | "No active connections yet" text + "Set up trading now" secondary button shown instead of connection selector | ✅ | "No active connections yet. Set up trading now..." + "Set up trading now" button shown |
| AG-20 | Create agent — inline setup opens form | Click "Set up trading now" | Modal replaces with ProviderSetupForm; main create flow is suspended | ✅ | "Add trading connection" form appeared when clicked |
| AG-21 | Create agent — inline setup success auto-selects | Complete setup form with valid credentials | ProviderSetupForm closes; connection selector appears with new connection pre-selected | — | |
| AG-22 | Capability page — trading action | Open an agent's trading capability page in a not-ready state | The Status card shows a single state-aware action: "Assign a connection" scrolls to (and briefly highlights) the Available connections card; "Finish trading setup" opens the add-connection form inline. The old "Go to AI Agents" Next-steps button no longer exists | ✅ | 2026-10-03 (plan 002, browser-verified @ localhost:8090): trading capability page (not-ready) showed the single "Assign a connection" action (helper "Pick a connection below to let this agent trade.") that stays on the page / scrolls to the Available connections card. No "Go to AI Agents" button. For a non-trading (email) family the action is instead a "Manage connections" link → /connections (see email verification note under GC-08). |
| AG-23 | Prompt surfaces render when allowed | Open an agent detail page on a plan that allows prompt visibility and has a recent runtime snapshot | "Prompt Surfaces" section shows tabs for Judge System, Scout System, User Context, and Judge User Context; switching tabs changes the prompt pane | ✅ | All four tabs visible when agent active; switching tabs changes prompt text |
| AG-24 | Prompt visibility is plan-gated | Open an agent detail page on a plan that disallows viewing own prompts | "Prompt visibility is not available on your current plan." is shown and the prompt query is not loaded | — | |
| AG-25 | Create agent — connection selector shows connections | Open Create Agent with trading skill; have active connections | Dropdown lists active connections by label and provider | — | |
| AG-26 | Create agent — inline setup creates connection directly | Click "Set up trading now"; complete form | Connection created (no intermediate binding); connection appears in selector | — | |

> **Retired 2026-10-15 (Wave 3 plan 002):** AG-19, AG-20, AG-21, AG-25, and AG-26 tested the create form's connection selector, which was removed. Test connection setup from the agent detail page's Connections section (GC-08).

### 6.0a Capability-Agnostic Presentation (C3)

Run these after C3 updates them for the implemented UI and records the commit
under test. They are blocked until C3 is implemented.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-C01 | Generic agent surfaces omit trading presentation | Open `/agents` and an agent detail for a trading-capable fixture with execution mode, strategy, and P&L data | Generic list, summary, and detail header show lifecycle and generic capability readiness only. They show no execution mode, authorization mode, strategy, P&L, trade count, win rate, trade history, or trading-specific color treatment. | ✅ | 2026-09-21; commit: `4bce03a5`; verified against a running cross-stack with an authenticated trading-capable fixture (`t1inch`, trading + gmail connection). Generic surfaces show only lifecycle + generic capability families ("Skills: trading" / "Connections: email, trading"), no trading-specific color treatment or P&L. 2026-09-23 final visual audit: operator again confirmed no trading-specific presentation on generic UI surfaces; unrelated observations recorded as future TODOs.
| AG-C02 | Capability presentation selects a bound connection | Bind two ready trading connections to one agent; mark one as the default; open its trading capability page | The page identifies and renders the default-ready connection through generic attributes and feeds. The P&L summary tiles and the Trades ledger rows belong ONLY to the selected connection's venue account — the other connection's seeded positions/fills are absent. Changing the selected/default binding refreshes the displayed connection without leaking the other connection's data. | won't do | Plan 003 re-run pending (herobids `85601309` / traderton `e8c37a0`). Prior evidence (plan C3): profile-backed presentation endpoint resolves the default-ready then first-ready connection server-side; explicit connectionId must be an active binding; no usable binding returns connection:null + empty attributes/feeds. Backend unit tests in `apps/api/src/routes/capabilities/trading-presentation.test.ts` now also assert cross-connection rows are excluded from BOTH the summary totals and the trades/fills feeds (commit `85601309`). Live two-connection browser confirmation of the ledger scoping is the pending re-run. |
| AG-C03 | Unavailable capability presentation is explicit | Open a trading capability page with no ready bound connection, then simulate an unavailable capability read | A generic unavailable/error state is shown; no stale, guessed, or raw trading values appear, and no P&L tiles or Trades/Decisions/Fills tables are rendered. | won't do | Plan 003 re-run pending (herobids `85601309` / traderton `e8c37a0`). Prior evidence: 2026-09-21, commit `4bce03a5`, verified against a running cross-stack with a trading-capable fixture with no ready bound connection — generic unavailable/error state shown, no stale/raw trading values. Re-run under the ledger UI to confirm tiles/tables are absent. |
| AG-C04 | Backend semantic emphasis controls presentation | Use fixtures that return positive, negative, warning, and neutral attribute/feed emphasis | The same generic components apply their theme treatment from backend emphasis only — on attributes/tiles AND on table cells and list badges. The frontend does not calculate P&L sign or receive CSS/color values; the sign (`+`/`-`) stays in the text so colour is not the only cue. | ✅ | 2026-10-04 browser-verified @ `http://localhost:8090` (herobids `85601309` / traderton `e8c37a0`, ledger fixture on agent `bcefc264…`): computed styles confirm green=oklch hue 142 / red=oklch hue 25 applied as TEXT `color` (transparent background) on both tiles AND trades/fills cells; `+`/`-` sign embedded in the text (not colour-only); the "Failed" decision badge is warning-amber. Unit evidence (commit `85601309`): `trading-ledger.test.ts` + `trading-presentation.test.ts` cover signed rounding/emphasis incl. `-0.004`→`0.00` neutral; `CapabilityPresentation.test.tsx` asserts a negative-looking value with positive emphasis still renders the success token. |
| AG-C05 | Second capability uses the same renderer | Render a fixture non-trading capability with attributes and a feed (including a tabular/`columns` feed) | It renders through the same generic capability attribute/feed/overview components with no trading-specific branch, label, formatter, or layout. A feed that declares `columns` renders through the same generic table path with no trading branch. | ✅ | 2026-09-19 (commit `a506d95a`): focused static UI test renders a non-trading inbox/messages fixture through the generic components and asserts no `trading` label. Reconfirmed under plan 003 (commit `85601309`): `CapabilityPresentation.test.tsx` renders a generic `columns`+`cells` fixture through the same `CapabilityFeeds` table path and a non-trading fixture with no `trading` wording. |
| AG-C06 | Capability presentation is usable on mobile | Repeat AG-C01 and AG-C03 at a 390×844 mobile viewport, with the ledger fixture seeded | Generic attributes, feeds, status, and connection selection remain readable, non-overlapping, and operable. The P&L tiles wrap; the Trades table scrolls horizontally inside its own region without overflowing the page; the Details / Decisions / Fills disclosures are operable. | ✅ | 2026-10-04 browser-verified @ 390×844 (herobids `85601309` / traderton `e8c37a0`): no page-wide horizontal overflow (doc scrollWidth 384 == clientWidth 384); the 4 tiles wrap to a single full-width stacked column; the Trades table (content width 819) scrolls horizontally inside its own `overflow-x:auto` region (region clientWidth 310); disclosures operable (Decisions expanded to 3 articles). |
| AG-C07 | Trading P&L summary tiles | Bring up the cross-stack (`scripts/shell/run/reset-and-run-xstack.sh`), seed via `scripts/shell/run/seed-ledger-fixture.sh <agentId>` (1 winning closed +12.34, 1 losing closed −20.00, 1 open), open the agent's trading capability page | Four primary tiles render: Total profit / loss, From closed trades (`-7.66` = +12.34 − 20.00), From open trades (open position's unrealized, or `—` if no mark), Winning trades `1 of 2`. P&L values show `+`/`-` text coloured green/red by backend emphasis. When the open mark is unavailable, the total tile reads "Total profit / loss (closed trades only)" = `-7.66`. | ✅ | 2026-10-04 browser-verified @ `http://localhost:8090` (herobids `85601309` / traderton `e8c37a0`, agent `bcefc264…`): four tiles — Total profit / loss `+239.57` (green), From closed trades `-7.66` (red), From open trades `+247.23` (green), Winning trades `1 of 2`. The open BTC position received a LIVE Hyperliquid mark (unrealized `+247.23`), so the total includes it (not the closed-only fallback) — this also exercises the Item 0 marks path end-to-end. No old flat six-attribute grid. |
| AG-C08 | Trades ledger shows signed, coloured P&L | Same fixture; view the Trades table on the capability page | One row per position, newest first (open BTC, then SOL loss, then ETH win). Columns When · Asset · Direction (Long/Short) · Size · Entry price · Exit price · Profit / loss · Held for · Status. Closed rows: realized P&L (`+12.34` green, `-20.00` red), Exit price shown, Size `—`, Status Closed. Open row: unrealized P&L (or `—`), Exit price `—`, Size `0.01`, Status Open. Prices full-precision; P&L 2dp with sign. | ✅ | 2026-10-04 browser-verified (herobids `85601309` / traderton `e8c37a0`): 3 rows newest-first — open BTC-PERP Long 0.01 entry 60000 exit `—` P&L `+247.23` green Status Open; SOL-PERP Closed Size `—` entry 150 exit 140 P&L `-20.00` red; ETH-PERP Closed exit 2024.68 P&L `+12.34` green. Closed-row direction (Long) inferred from the sell closing fill. E2E journey 19 also mocks `/presentation` and asserts the 3-row table + success/danger tokens. |
| AG-C09 | Decisions / Fills collapsed by default | Same fixture; inspect the sections below the Trades table | Account Details, Decisions, and Fills render inside `<details>` collapsed by default; clicking each expands it. Decisions list shows localized intents with status badges: "Done" (neutral), "Failed" (warning), and "Not executed" (no plan). Fills table shows When · Asset · Side (Buy/Sell) · Quantity · Price · Profit / loss. | ✅ | 2026-10-04 browser-verified (herobids `85601309` / traderton `e8c37a0`): Details, Decisions, Fills all collapsed `<details>` by default. Decisions expanded → "Open long / Not executed" (neutral), "Open short / Failed" (warning-amber), "Open long / Done" (neutral). Fills expanded → table with Buy/Sell rows and signed P&L (`-20.00` red, `+12.34` green). |
| AG-C10 | Ledger labels localized (ar/hi) | Seed the fixture, then switch display language to Arabic, then Hindi, and reopen the capability page | Tile labels, column headers, Long/Short, Open/Closed, Buy/Sell, decision statuses, and durations are translated. Numeric P&L stays `+12.34` / `-20.00` (no locale digit/separator change this round). In Arabic the RTL layout is not broken (table + tiles remain readable). | ✅ | 2026-10-04 browser-verified (herobids `85601309` / traderton `e8c37a0`) via Settings → Display language. Arabic (`html dir=rtl`, "قدرة التداول"): headers + Long→شراء, Open→مفتوحة, Closed→مغلقة, Buy/Sell, statuses (لم يُنفَّذ/فشل/مكتمل) and durations localized; RTL not broken. Hindi ("ट्रेडिंग क्षमता"): headers + लॉन्ग/खुला/बंद + statuses निष्पादित नहीं/विफल/पूर्ण + durations localized. Numeric P&L stayed `+247.23`/`-20.00`/`+12.34` (Western digits, signs intact) in both. |

> **Plan 003 regression re-runs:** AG-14 (per-family capability Status card is unchanged by the ledger redesign) and AG-C01 (generic `/agents` list + agent-detail surfaces still show no P&L / win rate / trade history) must be re-run alongside AG-C02–AG-C10 and confirmed unchanged.


### 6.0b Phase 2 T1.1 — Genericized Agent Capability UI

Visual UAT of the frontend genericization change. Run against a live cross-stack
(local Postgres + Redis + API + Vite web). Date: 2026-10-01. All agents created
through the UI create flow by an authenticated test user. Since 2026-10-15 the create form takes no skills (Wave 3 plan 002): add skills on the agent detail page before re-running GC-01–GC-06.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| GC-01 | Email-only — Advanced Settings has generic Capabilities tab, hidden for email | Create flow; select only the Email skill; expand Advanced Settings | Only an "AI" tab is shown; no "Capabilities" tab (and no "Trading"/"Strategy" tabs). The Capabilities tab is hidden because the email family needs no config. | ✅ | 2026-10-01: Advanced Settings tablist showed a single "AI" tab; no "Capabilities"/"Trading"/"Strategy" tab. Matches `AdvancedSettingsSection` hiding the capabilities slot when `null`. |
| GC-02 | Email-only — detail shows ONE email readiness card (not empty state) | Open the email-only agent detail; expand Capabilities | One readiness card for the email family; NOT the "No capability setup required" empty state. | ❌ | 2026-10-01: Capabilities section rendered EMPTY — no email card and no empty state. Root cause: backend `GET /agents/:id/capabilities/readiness` hardcodes `knownFamilies = ['trading']` (apps/api/src/routes/capabilities/index.ts) and never emits an `email` family. Frontend derives `['email']` from skills then intersects with the readiness response (`familyCapabilities`), which is empty → nothing renders. |
| GC-03 | Trading+email — detail shows TWO cards (email + Trading) | Create agent with Trading + Email skills; open detail; expand Capabilities | Two capability cards: email and Trading. | ❌ | 2026-10-01: Only ONE card ("Trading capability readiness") rendered; email card missing. Same root cause as GC-02 — readiness endpoint returned only `{family:"trading"}`. |
| GC-04 | Trading+email — Advanced Settings Capabilities tab present (trading setup + strategy) | Create agent with Trading + Email skills; expand Advanced Settings | "Capabilities" tab present alongside "AI"; contains trading setup + strategy config. | ✅ | 2026-10-01: Tablist showed "AI" + "Capabilities"; the Capabilities tab contained execution mode, venue, trade authorization, guardrails, premium-handover cadence, trade filtering, and wake notices. |
| GC-05 | Trading-only — one Trading card on detail | Create agent with Trading skill; open detail; expand Capabilities | One Trading capability card (unchanged behavior). | ✅ | 2026-10-01: One "Trading capability readiness" card shown (Unconfigured, with trading note + Configure button). |
| GC-06 | Trading-only — Capabilities tab has trading setup + strategy | Create agent with Trading skill; expand Advanced Settings → Capabilities | Capabilities tab contains trading setup + strategy. | ✅ | 2026-10-01: Confirmed, identical content to GC-04. |
| GC-07 | Create form shows the Name, objective and Review step | Open `/agents/new`; inspect the form | Name is the first field (`[data-field="name"]`). The objective is under Advanced Settings → AI (`[data-field="goal"]`). "Review →" shows the review step, and "Create AI agent" creates the agent. | — | 2026-10-16: rewritten to match the form as it is now. The 2026-10-15 Name-and-Channel description was never built, and the form must not change. The prior ✅ (2026-10-01/02) described the removed form. |
| GC-08 | No-skills agent shows "No capabilities yet" empty state with inline setup | Create an agent with no skills; open detail; expand Capabilities | Capabilities section shows the "No capabilities yet" empty state + a short explainer, plus the inline Add-skills picker and connection field (headed "Connect to external platform", with no separate "Connections" label above it) so a capability can be added without leaving the page. | ✅ | 2026-10-03: redundant "Connections" label above the inline connection field removed (key `agents.detail.capabilities.connections` deleted); the field's own "Connect to external platform" heading remains — re-verify visually. 2026-10-03 (plan 002, browser-verified @ localhost:8090): heading "No capabilities yet"; body "Give this agent a capability by adding a skill (like Trading or Email) or connecting to an external platform." Inline "Add skills" (SkillPicker) + "Connections" picker ("+ Add connection") present. Old "No capability setup required" / "connecting an account" wording absent. Also verified the family-neutral email capability page (headline "Not ready — no connection yet", reason "This agent needs a connection for this capability before it can be used.", helper "Connect an account to enable this capability.", "Manage connections" link; no trading wording) and the Skills create-form name placeholder now reads "Deal finder". Readiness endpoints (trading/email/list) all returned 200; 0 console errors. |
| GC-09 | Guided-chat intent → preset classification | Retired 2026-10-15 | Guided chat was removed from the web app (Wave 3 plan 004). Not run. | — | 2026-10-02 row for change 009 (skill-first guided chat) |

**Summary:** Scenarios 3, 4, 5 PASS. Scenario 1's create/edit Advanced Settings
behavior PASSES; Scenarios 1 & 2 detail-page card expectations FAIL. The frontend
genericization is correct (families derived from skills; one card per family;
generic Capabilities tab), but the non-trading (`email`) family capability card
never renders because the backend readiness endpoint only reports the `trading`
family. This is a backend gap surfaced by the genericized UI, not a frontend
regression. Note: lint + unit tests + typecheck were reported passing prior to
this visual UAT.

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
| AG-E08 | Tick change keeps a stored max hold | In edit form, leave Max hold at the style default (balanced, 90 min); change tick interval from 30 to 60 min; save | Save succeeds; max hold stays 90 min and no max-hold override is saved. Raising the tick above the stored max hold re-derives it (tick × 3 for balanced) | — | 2026-10-15: edit form keeps a stored max hold that still covers the tick, matching the server rule. Unit tests cover the rule |
| AG-E09 | Edit form has no Telegram field | Open the edit form on any agent | No Telegram or Chat ID field is shown. Telegram is connected once, in Settings | — | 2026-10-26: per-agent Telegram removed. Telegram is user-level only |
| AG-E10 | Edit form field order | Open the edit form on any agent | Name is the first field; the Objective and the rest follow | — | 2026-10-26: the Telegram Chat ID field was removed from the top, so Name comes first |
| AG-E08 | Custom preset exposes skill picker | Open edit form; set Skill Preset = "Custom" | SkillPicker is shown inline above the objective field; skill changes are reflected on save | — | 2026-08-01: Updated — Skills tab was removed; custom skills now render inline in the main form |
| AG-E09 | Model selection visible | Open edit form for agent with intelligence capability | AI Configuration tab shows model provider/economy/premium fields directly (no inherit/override toggle) | — | |
| AG-E10 | Guardrails & authorization editable | Open edit form; expand Advanced Settings → Trading Setup | Trade Authorization (Auto / Require approval), daily max loss %, slippage (BPS), max open positions, stop-loss % fields present and editable | — | 2026-08-01: Trade Authorization moved into Trading Setup tab (after Venue/Execution Mode); labels shortened to "Auto" / "Require approval". WP7: field names updated to canonical vocabulary (dailyMaxLossPct, slippageBps, stopLossPct). | |
| AG-E11 | Edit non-trading agent — connections visible | Open edit form for a non-trading agent | "Connect to external platform" section is visible in the main form, but it is optional. If active connections exist, they can be selected; if none exist, the empty state still shows the add-connection action and the form remains saveable. | — | 2026-08-01: Updated after generic providers like Gmail were added for non-trading agents |

### 6.1a Agents — Forced Strategy Review

Route: `/agents/:id/capabilities/trading` — dedicated operator control to trigger a deterministic strategy review on demand. (Moved from the agent detail page to the trading capability page.)

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-R01 | Force-review control visibility | Open an agent's trading capability page for an agent with periodic strategy assessment enabled | A dedicated strategy-review control is visible on the trading capability page | — | 2026-10-12: Moved from the agent detail page (Evaluations area) to the trading capability page. NOT RUN. |
| AG-R02 | Force-review unavailable state | Open an ineligible agent's trading capability page | The control is either hidden or disabled, and the UI does not present it as an active action | — | 2026-10-12: Moved to the trading capability page. NOT RUN. |
| AG-R03 | Force-review trigger — request accepted | Click the strategy-review control for an eligible agent | The UI enters a pending state and shows that the manual review request was accepted | — | 2026-10-12: Moved to the trading capability page. NOT RUN. |
| AG-R04 | Force-review terminal no-advice outcome | Trigger a review when the agent has no qualifying candidates | The request completes with a valid no-advice or no-candidate result, not a generic error | — | 2026-10-12: Moved to the trading capability page. NOT RUN. |
| AG-R05 | Force-review remains separate from evaluation | Trigger a strategy review from the trading capability page | No general evaluation run is created automatically; the feature remains distinct from Run Evaluation | — | 2026-10-12: Moved to the trading capability page. NOT RUN. |

---

## 6b. Agents — Create Form

Route: `/agents/new` — create form with an optional Name and a Channel choice only (Wave 3 plan 002, 2026-10-15). Retired 2026-10-15: AG-S01–AG-S11 tested the Style, capital, auto-name, skills, advanced-settings, and Review steps of the removed form; set those values from the Edit form (AG-E*) or the agent detail page (GC-08). AG-W* steps: create the agent, then use Edit → Advanced Settings.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-N01 | Create with prefilled name | Open `/agents/new`; leave the prefilled Name; click "Review →", then "Create AI agent" | Agent created with the prefilled adjective-noun name; app opens `/agents/:id`; Start button available | — | 2026-10-16: the Name is prefilled client-side; a blank name is no longer the default |
| AG-N02 | Create with typed name | Open `/agents/new`; type ` market-watch-01 ` (with surrounding spaces); submit | Agent named `market-watch-01`; app opens `/agents/:id` | — | Surrounding spaces are trimmed before sending |
| AG-N03 | Reserved name rejected | Type `all`; submit | Error banner shown; form not dismissed; no agent created | — | Server rejects names reserved for Telegram broadcast |
| AG-N04 | Connect Telegram shown when not linked | Sign in with no Telegram linked; open `/agents/new` | A "Connect Telegram" control is shown with the help text "Connect Telegram so this agent can message you there. Optional: you can create the agent without it." No Chat ID field is shown. Creating the agent without connecting still works | — | 2026-10-26: Chat ID field replaced by the Connect Telegram deep link (`https://t.me/<bot>?start=link_<token>`). Tap Connect, tap Start in Telegram, and the control disappears once the web app sees the link (it polls `/auth/me`) |
| AG-N05 | Connect Telegram hidden once linked | Connect Telegram in Settings; open `/agents/new` | No Connect Telegram control is shown on the create form | — | 2026-10-26: replaces the Chat ID prefill check. Telegram is user-level only, so no per-agent Telegram field exists |
| AG-N06 | Trading skill added to a name-only agent | Create an agent with only a name; open it; expand Capabilities; tick the Crypto trading skill | Save succeeds with no error. The agent's tick becomes 30 min and its max hold 90 min (balanced style). Start stays available. | — | 2026-10-15: server derives the trading tick when a trading skill is added and no tick is sent (`PATCH /agents`). Verified by API tests; no E2E journey covers it yet |
| AG-N07 | Blank name is rejected | Open `/agents/new`; clear the Name field | "Create AI agent" is disabled. After "Review →", the Name field shows "Name is required." No agent is created. | — | 2026-10-16: corrected. The form requires a name. The server still allocates a name when none is sent (API only, not reachable from the form). |
| AG-W01 | Wake sources — non-trading agent | Create a non-trading agent (personal-assistant); open Advanced Settings → AI Configuration | No wake source checkboxes shown. Reminders are always-on — no UI needed. | — | |
| AG-W02 | Wake sources — trading agent layout | Create a trading agent (Filter Trades = Off); open Advanced Settings → Strategy | Title reads "Which notices should the agent receive?". Three checkboxes: Price alerts, Newly trending tokens, Market regime shifts — all pre-checked by default. No count text. Scanner is NOT listed (implicitly controlled by Filter Trades mode). Reminders is NOT listed (always-on, forced by design). | — | 2026-07-13: Updated — Filter Trades replaces pre-filter + hybrid mode; wake sources simplified to description-only labels |
| AG-W03 | Wake sources — toggle checkboxes | In Strategy tab, uncheck Price alerts; then re-check it | Checkbox toggles independently. No count or status text shown — just the title "Which notices should the agent receive?" and the three checkbox items. Unchecking all three is allowed (empty selection means no wake sources active). | — | 2026-07-13: Updated — simplified UI removes count text and default-fallback message |
| AG-W04 | Wake sources — edit preserves selection | Create a trading agent with specific wake sources; open the Edit modal → Advanced Settings → Strategy | Previously selected wake sources are reflected in the checkboxes. | — | 2026-07-13: Updated — wake sources moved to Strategy tab |
| AG-W05 | Wake sources — scanner implicit with Filter Trades | In Strategy tab, change Filter Trades from Off → Mixed → Filter | Filter Trades is a 3-way selector. Off: wake source checkboxes shown. Mixed: wake source checkboxes shown; strategy presets and technical config appear. Filter: wake source checkboxes hidden (filter is the sole wake source); strategy presets and technical config appear. Scanner is never shown as a checkbox. | — | 2026-07-14: Updated — Filter Trades option labels changed; "Scanner only" → "Filter" |

---

## 6c. Agents — Dedicated Create Page

Route: `/agents/new` — dedicated page for agent creation (form only; guided chat removed, Wave 3 plan 004).

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| AG-D01 | Default mode is form | Navigate to `/agents/new` | The create form is shown. The card header "Create AI agent" is the only title; it is not a heading element. URL remains `/agents/new`. | — | 2026-10-16: checked against the code. The page uses no `PageHeader`, so there is no `<h1>`. The form is the only mode. |
| AG-D02 | Retired 2026-10-15 | — | The `?ui=chat` mode and the mode toggle were removed (Wave 3 plan 004). Former AG-D02–AG-D07 no longer apply. | — | |

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

## 8. Outcomes — ❌ RETIRED 2026-10-02

The `/outcomes` page was deleted when the admin-only Preview section was removed.
Tests `O-01`–`O-06` no longer apply.

---

## 9. Exposure — ❌ RETIRED 2026-10-02

The `/exposure` page was deleted when the admin-only Preview section was removed.
Tests `E-01`–`E-06` no longer apply.

---

## 10. Activity Feed — ❌ RETIRED 2026-10-02

The `/activity` page was deleted when the admin-only Preview section was removed.
Tests `AF-01`–`AF-05` no longer apply. The agent-state metrics it once showed
(Active/Paused/Unhealthy/Stopped) now live on the agents page — see MC-01.

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
| SC-04 | Mutations invalidate related queries | Start/stop an agent | The agents list reflects updated state | ✅ | Starting/stopping agent updated status via 5s polling; agents page reflected stopped state |
| SC-05 | 30 s stale time | Stay on the agents page for 31 s without navigating away; refocus window | Data automatically refetches | — | |

---

## 17. Try-It Email-First Onboarding

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| TRY-01 | Landing page shows "Try it" button | Visit `/` as unauthenticated user | "Try it" CTA links to `/try` | — | |
| TRY-02 | `/try` page loads for unauthenticated users | Visit `/try` without being logged in | Chat-like UI with typing animation, messages appear in sequence | — | |
| TRY-03 | Email validation on `/try` | Enter invalid email (e.g., "not-an-email") and submit | "Enter a valid email address" error shown | — | |
| TRY-04 | Email submission sends login link | Enter valid email and submit | "An email has been sent to..." message appears, check inbox for link | — | |
| TRY-05 | Login link redirects to the create form | Click login link from email | Redirects to `/agents/new` after authentication | — | 2026-10-15: `/try` targets the create form (D-9, Wave 3 plan 004) |
| TRY-06 | `/try` resend button works | After link sent, click "Resend link" | Another email sent, rate-limit message if clicked too quickly | — | |
| TRY-07 | Authenticated user visiting `/try` | Log in, then navigate to `/try` | Redirected to `/agents/new` | — | 2026-10-15: D-9 (Wave 3 plan 004) |
| TRY-08 | `/try` page works on mobile | Visit `/try` on a mobile viewport (or resize browser) | Layout adjusts, inputs are full-width, messages readable | — | |
| TRY-09 | Post-auth experience after `/try` | Complete flow: `/try` → email → click link → authenticate | User lands at `/agents/new` and sees the create form | — | 2026-10-15: D-9 (Wave 3 plan 004) |

## 18. Trading Wording Cleanup (docs/product/trading-wording-audit.md)

Verifies the content-page reword/removal, the one reworded i18n string, and
the legal-page trading-clause removal implemented by
`docs/features/pending/trading-wording-cleanup/001-plan.md`.

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| TW-01 | Agents docs index — no presets, Authorization heading | Open `/docs/agents` | No Agent Presets table; "Authorization" h2 heading; body says "proposal" not "trade proposal" | ✅ | 2026-10-06: Confirmed via browser snapshot |
| TW-02 | FAQs — approvals heading reworded | Open `/help/faqs` | "How do approvals work?" heading; no "Trade Authorization"/"trade proposal" | ✅ | 2026-10-06: Confirmed; cross-ref link correctly points to `/docs/agents/#authorization` |
| TW-03 | Get Started — no preset list | Open `/help/get-started` | Reworded onboarding; no Trading/Direct Trading/Trading Assistant preset list; steps 3–4 describe the name-and-channel create form and in-app conversation | ✅ | 2026-10-06: Confirmed. 2026-10-15: en steps 3–4 rewritten for the new create flow; ar/hi steps 3–4 translated to match, pending native review |
| TW-04 | What are AI agents — new capability list | Open `/docs/agents/what-are-ai-agents` | New capability bullets (web browser, Gmail/Telegram) replace old Trade crypto/forex bullets | ✅ | 2026-10-06: Confirmed; "Connecto" typo also fixed |
| TW-05 | Telegram slash commands — Approvals heading | Open `/docs/messaging/telegram/slash-commands` | "Approvals" heading, not "Trade Approvals" | ✅ | 2026-10-06: Confirmed on content page. Known gap: live bot `/help` output still says "Trade Approvals" (`apps/api/src/routes/telegram-slash-commands.ts`) — logged as a deliberate out-of-scope follow-up in the plan's Outstanding Issues, not a regression of this change |
| TW-06 | Connections cascade-delete-blocked wording | Delete a connection with a linked agent/bot | Error message says "linked account", not "trading account" | 🔒 | 2026-10-06: Source string confirmed correct (`en.ts`/`ar.ts`/`hi.ts` `cascadeDeleteBlocked`, commit `eadfcd6d`). Could not reproduce live in this pass — fresh stack had no agent linked to the connection, so delete hit a 503 venue-boundary error instead (traderton boundary not running in that stack). Needs `reset-and-run-xstack.sh` + a provisioned agent to verify the live rendering; blocked on availability, not a defect |
| TW-07 | Privacy Policy — trading clauses removed, Traderton link | Open `/legal/privacy-policy` | Trading data/venues/records clauses gone; working link to Traderton's privacy policy | ✅ (content) / 🔒 (link) | 2026-10-06: Content fully verified correct (all removed/reworded clauses). The link to `https://traderton.com/legal/privacy-policy.html` currently 404s on the live staging host — expected, not a defect: traderton's legal-pages commits are on an unpushed local branch, staging deploys from `main` via CI. Re-verify the link returns 200 once that branch is merged/pushed and deployed |
| TW-08 | User Agreement — trading clauses removed, Traderton link | Open `/legal/user-agreement` | Trading Agents/decisions/risk/Trading sections, no-advice/no-guarantees, Test/Live definitions all gone; working link to Traderton's user agreement | ✅ (content) / 🔒 (link) | 2026-10-06: Content fully verified correct, including the new "Trading-specific terms" section naming all six migrated concepts. Same link-not-yet-deployed situation as TW-07 — re-verify once traderton's branch ships |
| TW-09 | ar/hi mirrors reworded, RTL intact | Switch to Arabic and Hindi locales; open about-us, faqs, get-started | Reworded content renders; RTL layout intact for Arabic | ✅ | 2026-10-06: Confirmed both locales; `dir="rtl"`/`lang="ar"` correct for Arabic, `dir="ltr"` for Hindi; no stale "trading bots"/preset wording in either |

## 19. Messaging — typing, reply correlation, Web Push, email fallback

Recorded results: the owner ran the Telegram, Web Push, and email checks on 2026-10-24 and reported them passed. The agent did not re-run them. Rows marked `—` have not been recorded.

Verifies the messaging changes in `docs/features/2026/10/10/007-multi-provider-chat-messaging/`
(T, W, E). Web Push and email need configuration: `messaging.notifications.enabled`,
`messaging.notifications.webPush.*` (with `VAPID_PRIVATE_KEY` set for the worker), and
`messaging.notifications.email.*` (SES). See [081](../features/2026/10/10/007-multi-provider-chat-messaging/081-web-push-implementation-plan.md)
and [082](../features/2026/10/10/007-multi-provider-chat-messaging/082-email-fallback-implementation-plan.md).

| ID | Test Case | Steps | Expected | Status | Notes |
|----|-----------|-------|----------|--------|-------|
| MSG-01 | Typing indicator while agent works | Link Telegram chat; send a message to the agent; watch the chat | "typing…" appears within a few seconds of the message | ✅ | Plan 070 (T) |
| MSG-02 | Typing stops when reply is sent | Continue MSG-01 until the reply arrives | "typing…" disappears when the reply appears; does not reappear afterwards | ✅ | Plan 070 (T), stop signal |
| MSG-03 | Quoted reply goes to the right agent | Quote an agent message in Telegram and reply | Reply is delivered to the agent that sent the quoted message; confirmation shown | ✅ | Reply correlation |
| MSG-04 | Plain message with one running agent | With exactly one agent running, send a message with no quote | Message delivered to that agent | ✅ | Reply correlation rule 3 |
| MSG-05 | Plain message with several running agents | With two or more agents running, send a message with no quote | Reply says "Multiple running agents found. Use /to …"; nothing delivered | ✅ | Reply correlation rule 4 |
| MSG-06 | `/to` routes to named agent | Send `/to <agent name> <message>` | Message delivered to that agent only | ✅ | Reply correlation rule 2 |
| MSG-07 | `/to` with unknown agent | Send `/to unknown hello` | "No agent named unknown found." | ✅ | |
| WP-01 | Notifications option appears | Open an agent page (or Settings) while Web Push is enabled | Notifications opt-in control is shown; hidden when feature is off | — | Plan 081 W8 |
| WP-02 | Permission asked only on click | Load the page; do not click | No browser permission prompt on load | — | Plan 081 D2 |
| WP-03 | Enable notifications | Click the opt-in button and allow the browser prompt | Button shows enabled state; a `push_subscriptions` row exists for the user | ✅ | Manual check M1. Owner-reported 2026-10-24. |
| WP-04 | Push notification content | Trigger an agent reply while the browser is closed or in the background | Notification shows the agent name and "You have a new message"; no message text | ✅ | Manual check M1. Owner-reported 2026-10-24. |
| WP-05 | Clicking notification opens the agent | Click the notification | Opens `/agents/<id>` in the app | ✅ | Manual check M1. Owner-reported 2026-10-24. |
| WP-06 | Install as app | Chromium menu: install the app; check DevTools > Manifest | Manifest has no errors; app installs and opens in its own window | ✅ | Manual check M2. Owner-reported 2026-10-24. |
| WP-07 | Android Chrome push | Install the app on Android; trigger a reply with the app closed | Notification arrives; tapping opens the agent | ✅ | Manual check M3. Owner-reported 2026-10-24. |
| WP-08 | iOS Safari push | iOS 16.4+: Add to Home Screen; open from the icon; enable notifications; lock screen; trigger reply | Notification arrives; tapping opens the agent | ✅ | Manual check M4. Owner-reported 2026-10-24. |
| WP-09 | Turn off notifications | Click the opt-in button to turn off | Subscription revoked (`revoked_at` set); no further push arrives | ✅ | Manual check M5. Owner-reported 2026-10-24. |
| EM-01 | Email when push cannot reach user | With no push subscription, trigger an agent question | Email received naming the agent and linking to the conversation; no message text | ✅ | Plan 082 E-D1; manual check M-E2 (email with no push). Owner-reported 2026-10-24. |
| EM-02 | Email cap | Trigger more than 10 agent questions in 24 hours with no push subscription | No more than 10 fallback emails sent in 24 hours | — | Plan 082 cap; manual check M-E2 |
| EM-03 | Email toggle shows effective state | Open Settings with no saved choice | Email fallback toggle is ON while `userDefaultEnabled` is true | — | Toggle fix |
| EM-04 | Turn email fallback off | Set the Settings toggle to OFF; trigger an agent question with no push subscription | No email sent for that question | ✅ | Manual check M-E4 (opt-out, no fallback email). Owner-reported 2026-10-24. |
| EM-05 | Email link opens conversation | Click the link in the email | Opens `/agents/<id>` after sign-in | ✅ | Manual check M-E1 (email link opens the agent). Owner-reported 2026-10-24. |
| EM-06 | Push succeeds, no email | User with a working push subscription; trigger an agent question | Push arrives; no email for that event | ✅ | Manual check M-E3. Owner-reported 2026-10-24. |
| EM-07 | SES bounce and complaint metrics | After the first run, check the metrics for `alerts.email.ses.configurationSetName` | Bounce and complaint rates within SES limits | — | Manual check M-E5. Needs SES console access. Not recorded. |
| OPT-01 | Opt-out blocks sends on every account | Mark a chat address as revoked for one user (DB or admin); send from another account that uses the same address | Messages to that address are not sent for any account; the send reports the suppressed status | — | Decision: platform-wide opt-out (060) |
| OPT-02 | Opt-out blocks inbound too | With a revoked chat address, send `/help`, a plain message, and a quoted reply from that chat | No reply of any kind, nothing recorded in the agent's chat, nothing published to the agent | — | CH2W P3 (I4). Automated: `telegram-conversation.functional.test.ts`, `agent-interactivity.test.ts`. Manual run: pending |
| CH2W-01 | Telegram message appears in the web chat | Link Telegram; with one agent running, send it a plain message; open the agent page | The message is in the "Chat with {name}" card on the right, in order, and stays after reload; Telegram answers "Delivered to {name}." | — | CH2W P3. Automated: `telegram-conversation.functional.test.ts` (recorded on the `telegram` channel, published under the row id). Manual run: pending |
| CH2W-02 | Agent reply reaches both places | Ask the agent a question on Telegram; wait for its `send_message` reply | The reply arrives on Telegram and appears on the left of the web chat, once | — | CH2W P3. Automated: broker and `thread-delivery` unit tests (recorded before the send, marked `sent` on `telegram`). E2E: owner hand-off |
| CH2W-03 | Quoted reply uses the stored message | Quote an agent message on Telegram and reply (also after an API restart) | The reply goes to the agent that sent the quoted message; "Delivered to {name}."; the reply is in that agent's web chat | — | CH2W P3 (DEC-51 index). Automated: `chat-address-resolution.integration.test.ts`, `telegram-conversation.functional.test.ts`. Manual run: pending |
| CH2W-04 | No chat address is not a failure | Remove the Telegram address; let the agent send a message | The message shows in the web chat with no failed or "Not sent" state | — | CH2W P3. Automated: `thread-delivery.test.ts` (`not_applicable`). Manual run: pending |
| CH2W-05 | Platform alert and session anchor in the chat | Start an agent session; trigger a platform alert (for example a guardrail pause) | The "session started" message and the alert show in the web chat (left, safety alert label) and on Telegram | — | CH2W P3. Automated: `platform-alert-service.test.ts`. E2E: owner hand-off |
| CH2W-06 | `/log` reads the chat | Send `/log <agent>` on Telegram after a short exchange | The last entries show `YOU:`, `AGENT:` and `ALERT:` lines from the chat, merged with protocol events | — | CH2W P3. Automated: `telegram-command-handlers.test.ts`, `telegram-conversation.functional.test.ts` |
| CH2W-07 | Telegram message too long | Send the agent a Telegram message longer than the chat limit | "Your message is too long (the limit is 4000 characters)…"; nothing delivered or recorded | — | CH2W P3 decision. Automated: `agent-interactivity.test.ts`, `telegram-channel.test.ts` |
| CH2W-08 | Activity feed lists chat messages without a session | Open the agent's Activity Timeline after a reply and an alert | The agent and platform messages are entries; they carry no session; your own messages are not entries | — | CH2W P3 (DEC-52). Automated: `agent-interactivity.functional.test.ts`, `agent-activity-feed.test.ts` |
| CH2W-09 | Old messages endpoint is gone | `GET /agents/<id>/messages` with a valid token | 404 | — | CH2W P3 (DEC-32). Automated: `agent-interactivity.functional.test.ts` |
| CH2W-10 | Two-way chat end to end | `scripts/shell/tests/run-all-tests.sh --e2e` (send a message, see it, see the agent's reply) | The E2E journey passes before P2 and P3 close | — | Plan 002 section 6 gate. Owner hand-off (ENTRYPOINT section 7); not run by the agent |
