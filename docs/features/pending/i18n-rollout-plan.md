# Internationalization Rollout Plan

## Status
`todo`

## Goal
Introduce product-grade internationalization for the web app and its supporting API contracts without treating i18n as a TSX-only string replacement exercise.

The rollout must make locale selection, formatting, validation errors, and activity/event text consistent and evolvable.

## Why This Needs A Planned Rollout

The current codebase is English-first in multiple layers:

- web chrome and page copy are hard-coded across the React app
- shared UI components generate English fallback text
- relative-time and some status text are hand-built in English
- the API often returns user-facing English text rather than stable code-plus-params contracts
- the dashboard activity feed already converts domain events into plain-language English on the server

That means i18n is not just a frontend content pass. It touches app architecture, formatting helpers, API response shape, and some persisted user preferences.

## Confirmed Baseline

Treat the following as current baseline, not open questions:

1. the web app has no i18n provider or locale layer at the application root
2. locale preference is not modeled on the user record yet
3. shared UI helpers still embed English labels such as generic error and retry states
4. date formatting is partially delegated to browser defaults and partially handwritten
5. API errors are inconsistent: some routes return stable codes, others return only English text
6. dashboard activity messages are composed server-side as English sentences

## Scope

### In scope

1. locale resolution and a web-level i18n provider
2. shared translation catalogs for web-owned UI strings
3. consistent locale-aware formatting for dates, times, relative time, numbers, and currency
4. migration of high-traffic pages and shared components to translation keys
5. API contract normalization for user-visible validation and error messages
6. client-localized rendering for dashboard/activity event messages
7. user preference persistence for locale selection
8. test coverage and guardrails to keep new strings from bypassing the i18n layer

### Out of scope for v1

1. machine translation of agent-authored summaries, artifact bodies, or other generated content
2. localized route paths or SEO-focused localized public marketing pages
3. runtime translation of operator-authored prompts, skill instructions, or stored domain content
4. full admin/operator translation coverage if those surfaces are not yet user-facing priorities

## Working Rules

1. UI-owned messages should resolve from translation keys, not raw English literals.
2. API responses should prefer stable `code` plus structured params over finalized English sentences.
3. Domain data and user-generated content stay as data; they are not silently rewritten through the i18n layer.
4. Formatting must go through shared locale-aware helpers rather than ad hoc `toLocaleDateString()` or handwritten relative-time strings.
5. Rollout should be incremental and keep English as the default fallback until a second locale is fully usable.

## Target Architecture

### Web layer

Add a locale provider at the app root and expose a small translation surface to all pages and shared components.

Preferred shape:

1. a single i18n provider mounted in `apps/web/src/app/App.tsx`
2. message catalogs organized by domain or route group
3. shared helpers for `t()`, pluralization, interpolation, and locale-aware formatters
4. a locale resolver that checks persisted user preference first, then browser language, then defaults to `en`

### API layer

Normalize user-visible responses toward this shape where localization matters:

```json
{
  "error": "plan.limit_exceeded",
  "message": "Venue account limit reached (3)",
  "params": {
    "resource": "venue_account",
    "limit": 3,
    "current": 3
  }
}
```

Notes:

1. `message` may remain temporarily for backward compatibility during migration.
2. the client should prefer localized rendering from `error` plus `params` when both are present.
3. once migration is complete, new endpoints should not introduce fresh user-facing English strings unless they are explicitly non-localized content.

### Event/activity layer

The dashboard activity feed should stop shipping only fully-rendered English text.

Preferred target shape:

```json
{
  "id": "...",
  "type": "order.filled",
  "category": "execution",
  "severity": "info",
  "messageKey": "activity.order.filled",
  "messageParams": {
    "side": "buy",
    "quantity": "0.5",
    "symbol": "BTC-PERP",
    "price": "70000"
  },
  "timestamp": "...",
  "detail": {}
}
```

This keeps categorization server-owned while final user phrasing becomes locale-owned.

## Ordered Delivery Phases

Ship these in order.

Do not start broad string replacement across feature pages before the shared i18n foundation and formatting rules exist.

### Phase 0: Contract And Library Decision Slice

Goal:
Settle the baseline architecture so the implementation does not fork between competing patterns.

Primary areas:

- `apps/web/package.json`
- `apps/web/src/app/App.tsx`
- `apps/web/src/lib/`
- `apps/api/src/`
- `packages/db/src/schema/users.ts`

Deliverables:

1. choose the web i18n library and document why it fits the repo
2. define the translation-key naming convention
3. define how locale is resolved on web bootstrap
4. define the API rule for user-visible error payloads: `code` plus optional `params`
5. define the event feed rule: server emits semantic event key plus params, not only English text
6. define whether locale preference is initially local-storage only or immediately persisted on the user profile

Acceptance checks:

1. one written decision doc exists and names the chosen library and key strategy
2. no implementation phase begins with unresolved disagreement about server-vs-client ownership of phrasing
3. the migration target for activity events and validation errors is explicit

Estimated effort:

1. 0.5 to 1 day

### Phase 1: Web Foundation And Locale Formatting

Goal:
Introduce the app-wide i18n plumbing and replace all shared formatting primitives.

Primary files:

- `apps/web/src/app/App.tsx`
- `apps/web/src/main.tsx`
- `apps/web/src/lib/ui.tsx`
- `apps/web/src/lib/config.ts`
- new i18n files under `apps/web/src/app/` or `apps/web/src/lib/`

Deliverables:

1. install and wire the chosen i18n library
2. add a root locale provider and default English catalog
3. add shared helpers for date, number, currency, and relative-time formatting
4. replace handwritten relative-time strings in shared UI with locale-aware formatting
5. replace shared generic strings such as error, retry, loading, modal, and empty-state primitives with translation keys
6. add a temporary locale debug toggle or developer override for verification

Acceptance checks:

1. the app boots under the new locale provider with no route regressions
2. `RelativeTime` and shared formatting no longer hand-build English strings
3. shared components can render from translation keys without each page reimplementing formatting logic
4. English remains the fallback when no locale preference is available

Estimated effort:

1. 1 to 2 days

### Phase 2: Shell And Highest-Traffic Page Migration

Goal:
Localize the product shell and the most visible user journeys before broadening coverage.

Primary files:

- `apps/web/src/app/layout/RootLayout.tsx`
- `apps/web/src/app/layout/Sidebar.tsx`
- `apps/web/src/features/auth/LoginPage.tsx`
- `apps/web/src/features/auth/AuthCallbackPage.tsx`
- `apps/web/src/features/mission-control/MissionControlPage.tsx`
- `apps/web/src/features/activity/ActivityFeedPage.tsx`
- `apps/web/src/features/outcomes/OutcomeBoardPage.tsx`
- `apps/web/src/features/settings/SettingsPage.tsx`

Deliverables:

1. move shell navigation labels, ARIA labels, and page titles to catalogs
2. localize login/auth copy, CTA text, validation placeholders, and shared notices
3. localize Mission Control, Activity, Outcomes, and Settings chrome and empty states
4. convert repeated status labels and capability labels to shared translation helpers
5. add a string inventory for the remaining feature pages so migration scope is measurable

Acceptance checks:

1. navigation, auth, and home-shell pages are free of new hard-coded English UI copy
2. page headers, buttons, and empty/error states render from translation keys
3. status labels and common nouns are consistent across pages
4. the remaining untranslated pages are explicitly tracked rather than implicitly deferred

Estimated effort:

1. 2 to 4 days

### Phase 3: Error Contract Normalization

Goal:
Stop making the client depend on backend English text for validation and operational errors.

Primary files:

- `apps/web/src/lib/api-client.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/plan-guards.ts`
- `apps/api/src/routes/*`
- `apps/api/src/schemas.ts`

Deliverables:

1. define a shared error response shape with stable codes and optional interpolation params
2. update the web client to prefer local translation from code-plus-params over raw server message
3. migrate the most user-visible API routes first: auth, settings/profile, billing, agents, credentials, connections, capabilities
4. keep `message` temporarily for backward compatibility during rollout
5. document the rule for new endpoints: do not introduce new UI-owned English strings without a stable code

Acceptance checks:

1. auth and plan-guard failures no longer require raw English server strings to display correctly
2. the client can localize at least the top-tier API errors from translation catalogs
3. routes still behave correctly for existing callers during the compatibility window
4. new tests assert code-plus-params semantics rather than exact English phrasing where appropriate

Estimated effort:

1. 2 to 4 days

### Phase 4: Activity Feed And Event Message Localization

Goal:
Move activity phrasing ownership to the locale layer while preserving server-owned categorization and semantics.

Primary files:

- `apps/api/src/routes/dashboard.ts`
- `apps/web/src/lib/api-client.ts`
- `apps/web/src/features/activity/ActivityItem.tsx`
- `apps/web/src/features/mission-control/MissionControlPage.tsx`

Deliverables:

1. replace server-only plain-language activity messages with `messageKey` plus `messageParams`
2. keep category and severity logic on the server
3. update the web activity item rendering path to translate event messages locally
4. define fallback behavior for unknown event types
5. add catalog entries for known event types and common parameterized patterns

Acceptance checks:

1. known dashboard activity events render localized text on the client
2. unknown event types degrade predictably without blank states
3. server logic still owns event classification and security-sensitive event inclusion
4. at least one end-to-end activity event path is covered by tests

Estimated effort:

1. 1 to 3 days

### Phase 5: Preference Persistence And Broad Page Coverage

Goal:
Persist locale choice and finish the remaining important product surfaces.

Primary files:

- `packages/db/src/schema/users.ts`
- `apps/api/src/routes/auth.ts`
- `apps/web/src/app/providers/SessionProvider.tsx`
- remaining pages under `apps/web/src/features/`

Deliverables:

1. add a persisted locale or preferred-language field to the user profile if phase 0 chose server persistence
2. expose read/write support through `/auth/me` or an equivalent profile endpoint
3. migrate remaining feature pages: agents, billing, connections, credentials, capability pages, exposure, bots, venue accounts
4. centralize shared domain-label mapping such as execution modes, capability states, billing statuses, and plan labels
5. remove temporary ad hoc page-level formatting and translation helpers superseded by the shared layer

Acceptance checks:

1. changing locale persists across refresh and a new login session
2. remaining priority pages no longer depend on hard-coded English chrome
3. status and enum labels are sourced from a consistent translation map
4. the user profile response shape remains backward compatible where needed

Estimated effort:

1. 3 to 5 days

### Phase 6: Hardening, Tooling, And Second-Locale Readiness

Goal:
Make the i18n layer maintainable and safe to extend beyond English.

Primary areas:

- web tests
- API tests
- lint or validation scripts
- translation catalogs

Deliverables:

1. add tests for locale switching, fallback behavior, error localization, and activity localization
2. add a lightweight check for missing translation keys in the default catalog
3. add a policy or script to detect newly introduced hard-coded UI strings in migrated areas where practical
4. validate one second locale end to end on the shell and primary journeys
5. document how new strings, error codes, and event types must be added going forward

Acceptance checks:

1. core translated flows pass in English and one additional locale
2. missing-key failures are visible during development or CI
3. localized formatting behaves correctly for dates, numbers, and relative time
4. documentation exists for future contributors

Estimated effort:

1. 1 to 3 days

## Effort Summary

### MVP slice

Phases 0 through 2 only:

1. roughly 3 to 5 engineering days
2. delivers a real web i18n foundation and localized shell/high-traffic pages
3. does not fully solve backend English error and activity coupling

### Proper product i18n slice

Phases 0 through 5:

1. roughly 1.5 to 3 weeks
2. includes contract cleanup, activity-event localization, and locale persistence
3. is the minimum truthful scope for saying the product supports i18n rather than isolated translated screens

### Full hardening slice

Phases 0 through 6:

1. roughly 3 to 6 weeks depending on second-locale breadth and testing depth
2. includes safeguards that keep the codebase from regressing back into English literals

## Risks

1. translating only TSX literals will leave server-generated errors and activity messages in English, creating an inconsistent product.
2. event-message migration can introduce regressions if the fallback path for unknown events is not explicit.
3. adding locale persistence too early can slow down the initial rollout if the foundation is not already stable.
4. generated content such as agent-authored summaries may be mistaken for UI copy; that requires a separate product decision.
5. enum and status labels can diverge across pages unless they are centralized during migration.

## Open Decisions

These should be resolved in Phase 0, but they do not block writing this plan.

1. Q: Which i18n library should be the standard for the web app? A: standardize on react-intl, use semantic dot-separated keys like activity.order.filled and errors.plan.limitExceeded, mount a single provider at app root, and route all date/number/relative-time formatting through a shared intl wrapper instead of ad hoc browser calls.

2. Q: Is locale preference local-storage first, or do we persist it on the user profile immediately? A: local storage first in Phase 1, but explicitly design for server persistence as the target and implement that in Phase 5. In other words, do not choose “local-only” as the end state; choose it as the rollout strategy. That also aligns with the risk already called out in the plan that adding persistence too early can slow the rollout.

3. Q: Do we want region-aware locales such as `en-US` and `fr-FR`, or language-only locales first? A: Yes, but also support plain `en`.

4. Q: Should API responses retain `message` indefinitely for third-party callers, or only during migration? A: No need for backward compatibility. Remove `message` entirely if it has no long-term future.

5. Q: For agent-authored summaries and artifact bodies, do we show source language only or introduce an explicit translate-on-demand feature later? A: Show language only, for now.

## Suggested Initial File Inventory

These are the highest-value early anchors for implementation:

1. `apps/web/src/app/App.tsx`
2. `apps/web/src/lib/ui.tsx`
3. `apps/web/src/lib/api-client.ts`
4. `apps/web/src/app/layout/RootLayout.tsx`
5. `apps/web/src/app/layout/Sidebar.tsx`
6. `apps/web/src/features/auth/LoginPage.tsx`
7. `apps/web/src/features/mission-control/MissionControlPage.tsx`
8. `apps/api/src/routes/auth.ts`
9. `apps/api/src/plan-guards.ts`
10. `apps/api/src/routes/dashboard.ts`
11. `packages/db/src/schema/users.ts`

## Release Rule

Do not describe the product as fully i18n-enabled until at least:

1. the web shell and primary flows are catalog-driven
2. shared formatting is locale-aware
3. top-tier API errors do not require English server strings to render correctly
4. activity feed messages are localizable without server-side English phrasing as the only source

Before that point, describe the work more narrowly as translated UI coverage or i18n foundation rollout.