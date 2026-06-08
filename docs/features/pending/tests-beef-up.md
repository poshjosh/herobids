# TESTS BEEF UP

**Browser Additions**
I’d add these browser journeys, roughly in this order:

1. Full agent lifecycle through UI controls, not API shortcuts.
   Current journeys still short-circuit parts of the flow: pause/resume is explicitly skipped in 05-pause-resume-agent.spec.ts, and delete is still done through the API in 06-delete-agent.spec.ts. But the UI now has Pause, Resume, and Delete wired in AgentDetailPage.tsx and AgentDetailPage.tsx. A proper browser journey should exercise start, pause, resume, stop, and delete from the page itself.

2. Populated agent detail, not just empty states.
   Two current journeys explicitly verify empty-state rendering for decisions and messages in 02-agent-decision-visible.spec.ts and 03-agent-send-message.spec.ts. What is missing is a journey where an agent has actual decisions, outbound messages, protocol activity, and runtime health, and the detail page renders real data rather than placeholders.

3. Connection creation and capability enablement entirely from UI.
   The current capability journeys rely on helpers and seeded bindings instead of completing the setup path as a user would in the product, especially in 07-mission-control-renders.spec.ts and 08-mission-control-capability-reflects.spec.ts. Since there is a real Connections page in ConnectionsPage.tsx, one good journey is: create connection in UI, bind trading capability from the capability page, verify Mission Control reflects readiness.

4. Billing self-serve journey.
   Billing has a full page and multiple mutations in BillingPage.tsx, but there is no browser coverage for it. The minimum journey is: open Billing, see current plan, start checkout on mock provider, return with upgraded plan state, then cancel subscription and verify the page updates.

5. Activity feed journey with pagination.
   The Activity page exists in ActivityFeedPage.tsx and supports infinite paging through the dashboard activity API, but there is no browser test for it. A useful journey is: seed enough events to overflow one page, verify initial activity items, click “Load older events,” and assert stable ordering plus continuation.

6. Auth/session journey.
   The browser suite covers signup, but not the rest of the real auth/session surface. There is an auth callback page in router.tsx, sign-out in Sidebar.tsx, and explicit token invalidation behavior in SessionProvider.tsx. Good journeys here are: sign out redirects cleanly, stale token gets invalidated, OAuth callback stores session and lands on Mission Control.

7. Settings save/remove journey.
   Settings currently persists Telegram chat ID in SettingsPage.tsx. A browser journey should save a value, verify success state, reload, then remove it and verify persistence.

8. Skills discovery journey.
   The Skills page in SkillsPage.tsx has no browser coverage. This does not need to be first, but it is a cheap addition: verify built-in and user skill sections render, and the Create agent CTA takes the user into the right creation flow.

If the goal is to close the browser gap fastest, the first four above give the most value.

**Top 5 Non-Browser Tests**
For non-browser coverage, I would prioritize functional API tests first. The biggest reason is that the functional harness in helpers.ts currently mounts only part of the real server surface from index.ts, so some important route families never get exercised end-to-end with real auth, DB, and Redis.

1. Billing lifecycle functional suite.
   Routes in billing.ts.
   Why first: revenue, entitlements, and plan enforcement are business-critical.
   Minimum coverage:
   GET /billing/summary reflects current plan and subscription state.
   POST /billing/checkout-session validates plan and price mapping.
   Provider webhook updates entitlement state.
   POST /billing/upgrade-subscription and POST /billing/cancel-subscription mutate the subscription correctly.
   GET /billing/ledger is user-scoped and filter-scoped correctly.

2. Backtests workflow functional suite.
   Routes in backtests.ts.
   Why second: async workflow, queue interaction, ownership, and reporting all meet here.
   Minimum coverage:
   POST /backtests/corpora/import/csv imports a corpus and persists frames.
   POST /backtests rejects mismatched corpus venue and symbol.
   POST /backtests/validate creates a validation run.
   GET /backtests, GET /backtests/:runId, GET /backtests/:runId/report, and run event listing are scoped to the authenticated user.
   Queue enqueue failure is surfaced cleanly.

3. Dashboard read-model functional suite.
   Routes in dashboard.ts.
   Why third: this is the main user-facing summary surface, and it joins multiple tables plus event classification logic.
   Minimum coverage:
   GET /dashboard/overview returns the right bot counts, open-position counts, last activity, and venue labels.
   GET /dashboard/activity classifies events into decision, execution, risk, and system correctly.
   Pagination with before and beforeId is stable.
   Cross-user events and bots are excluded.

4. Trading-data access control suite for journal, positions, and reconciliation.
   Routes in views.ts and reconciliation.ts.
   Why fourth: this is sensitive trading data; the main failure mode is leaking another user’s data.
   Minimum coverage:
   GET /journal requires actorId or backtestRunId and enforces ownership.
   GET /bots/:botId/positions and GET /bots/:botId/positions/open return only the caller’s bot data.
   GET /bots/:id/reconciliation-events enforces ownership and query validation.
   Negative cases return 404 or 400 rather than leaking existence.

5. Admin authorization and degraded-mode functional suite.
   Routes in admin.ts.
   Why fifth: security boundary plus infrastructure introspection.
   Minimum coverage:
   Non-admin caller gets 403 for all admin endpoints.
   Admin caller can access /admin/stats and /admin/users with real auth plugin in place.
   /admin/containers degrades cleanly to docker_unavailable when Docker socket is absent.
   Best-effort session augmentation does not break the response.

**Next After Top 5**
The next two I would queue immediately after those are blueprints and sessions.

- Blueprints: blueprints.ts
  Reason: lots of mutation semantics, publish/unpublish visibility rules, clone behavior, config merge behavior, and delete blocked by running bots.

- Sessions: sessions.ts
  Reason: lower complexity than the top five, but still worth a real ownership/pagination suite because the web reads this data in the agent detail page.

If you want, I can turn this into a concrete test backlog with suggested filenames, one test case per endpoint family, and an implementation order that fits the current functional harness.