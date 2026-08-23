# Plan: Web Frontend i18n Completion

**Feature:** web-i18n-completion
**Date:** 2026-08-23
**Status:** Implemented

## Summary

Complete the web frontend translation coverage for the existing three locales (en, ar, hi). Several pages were never migrated to use `react-intl`, some migrated pages still contain hardcoded English strings, API error keys are missing from the catalogs, date/number formatting bypasses locale-aware helpers, and there is no CI-level guard preventing future regressions in newly-migrated pages.

Additionally, localize the login link email (the first email a new user sees) including RTL support in the email renderer.

Telegram localization, remaining email localization (billing/safety alerts), locale expansion, and ESLint-based tooling are out of scope (see `docs/features/pending/080-i18n-expansion/001-plan.md`).

## Goals

- Every user-facing string in migrated pages comes from the locale catalog.
- Un-migrated pages (BotsPage, InstancesPage, InstanceDetailPage, TryPage) use `useIntl()` with proper catalog keys.
- All API error keys returned to the web app have corresponding entries in en/ar/hi catalogs.
- Date, number, and currency formatting in user-facing components use `intl.formatDate()` / `intl.formatNumber()` instead of ad-hoc `.toLocaleString()` / `.toFixed()`.
- The login link email is localized for en/ar/hi with proper RTL support for Arabic.
- The email renderer supports RTL layout via a `locale` parameter.
- The existing vitest-based i18n regression test is extended to prevent future regressions in newly-migrated pages.
- Admin pages remain English-only (internal/operator surface, explicitly out of scope).

## Non-Goals

- Localizing Telegram bot messages or slash command responses.
- Localizing remaining email templates (platform safety alerts, billing notifications) — deferred to Plan 2 where they share infrastructure with Telegram localization.
- Adding new locales beyond en/ar/hi.
- Setting up ESLint or `eslint-plugin-formatjs`.
- Localizing operator-authored content (agent goals, skill descriptions, prompts).
- Changing the API response format or adding server-side i18n (beyond what login link email needs).

## Current State

### Architecture (working well)

- `react-intl` (v10.1.13) with ICU message format.
- Three locale catalogs: `apps/web/src/app/i18n/locales/{en,ar,hi}.ts` (~1048 keys each).
- Locale resolution: localStorage → browser languages → English fallback.
- API returns `{ error: <translation_key>, message: <English fallback>, params }`.
- RTL support for Arabic.
- Parity enforced by `catalog-consistency.test.ts` and `i18n-regressions.test.ts`.
- ADR 002 governs the contract.

### Gaps

| Category | Pages/Surfaces | Issue |
|----------|---------------|-------|
| Un-migrated pages | BotsPage, InstancesPage (trading-instances), InstanceDetailPage, TryPage | No `useIntl()` at all — all strings are hardcoded English |
| Partial migrations | BillingDetails, GuidedSetupPanel, GuidedSetupActionRenderer, CredentialsPage | Mix of intl keys and remaining hardcoded strings |
| Missing API error keys | ~30+ error messages in routes/bots.ts, routes/skills.ts, routes/ai.ts, routes/backtests.ts, routes/agent-evaluations.ts | `error` field values not in the web catalog |
| Date/number formatting | BillingDetails, ApprovalsPanel, AdminBillingSection, AdminUsersSection, AdminMarketDataSection | `.toLocaleString()` / `.toFixed()` without explicit locale |
| No regression guard | Newly-migrated pages | Could re-introduce hardcoded English without detection |

## Implementation Steps

### Step 1: Migrate BotsPage — DONE

**Files:**
- `apps/web/src/features/bots/BotsPage.tsx`
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Add `useIntl()` to `BotsPage` and `CreateBotModal`.
- Extract all hardcoded strings to catalog keys under `bots.*` namespace:
  - Page header: "Bots", "Trading bots created by you or your AI agents"
  - Empty state: "No bots yet", "Create one or let an AI agent create bots on your behalf."
  - Actions: "Create Bot"
  - KV labels: "Strategy", "Mode", "Created", "Started"
  - Modal: "Create Bot" title, placeholder text
  - Error messages
- Add corresponding entries to ar.ts and hi.ts.

### Step 2: Migrate InstancesPage (trading-instances) — DONE

**Files:**
- `apps/web/src/features/trading-instances/InstancesPage.tsx`
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Add `useIntl()`.
- Extract: "Bots", "Advanced trading records kept for compatibility and history", "No bots yet", "This view is read-only. Create and manage agents from the Agents area."
- Keys: `instances.*` namespace.
- Add to ar.ts and hi.ts.

### Step 3: Migrate InstanceDetailPage — DONE

**Files:**
- `apps/web/src/features/instances/detail/InstanceDetailPage.tsx`
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Add `useIntl()`.
- Extract all hardcoded strings (~25 strings):
  - "Bot not found", "This bot does not exist or you don't have access."
  - "← Back to bots", "← Back"
  - Section labels: "Timeline", "Configuration", "Open positions"
  - States: "No open positions"
  - KV labels: "Strategy", "Execution Mode", "Connection"
  - Confirmation modals: "Stop bot?", "Delete bot?", body text, "Cancel", "Stop bot", "Delete permanently"
  - Status badges, lifecycle buttons
- Keys: `instanceDetail.*` namespace.
- Add to ar.ts and hi.ts.

### Step 4: Migrate TryPage — DONE

**Files:**
- `apps/web/src/features/try/TryPage.tsx`
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Add `useIntl()`.
- Extract all user-facing strings in the email verification flow (input labels, button text, success/error messages, instructions).
- Keys: `try.*` namespace.
- Add to ar.ts and hi.ts.

### Step 5: Fix partial migrations — BillingDetails — DONE

**Files:**
- `apps/web/src/features/billing/BillingDetails.tsx`
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Replace hardcoded filter options: "All meters", "All agents", "All periods", "All Entries", "Credits Only", "Debits Only".
- Replace hardcoded table headers: "Period", "Status", "Usage Charges", "Balance".
- Keys: `billing.details.*` namespace (extend existing `billing.*`).
- Add to ar.ts and hi.ts.

### Step 6: Fix partial migrations — GuidedSetupPanel — DONE

**Files:**
- `apps/web/src/features/chat/GuidedSetupPanel.tsx`
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Add `useIntl()` (if not already present) or use existing intl context.
- Extract: "Checking account...", "Starting chat...", "Processing your connection…", "After adding credit, click Try Again to continue."
- Keys: `guidedSetup.*` namespace.
- Add to ar.ts and hi.ts.

### Step 7: Fix partial migrations — GuidedSetupActionRenderer — DONE

**Files:**
- `apps/web/src/features/chat/GuidedSetupActionRenderer.tsx`
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Extract: "Do not enter secrets directly into the chat. Only enter them into secure forms provided for that purpose.", "✓ Confirmed", form fallback label.
- Keys: `guidedSetup.actions.*` namespace.
- Add to ar.ts and hi.ts.

### Step 8: Fix partial migration — CredentialsPage loading text — DONE

**Files:**
- `apps/web/src/features/credentials/CredentialsPage.tsx`
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Extract: "Loading provider catalog..." → `credentials.loadingCatalog`.
- Add to ar.ts and hi.ts.

### Step 9: Add missing API error keys to catalogs — DONE

**Files:**
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

**Changes:**
- Audit all `reply.status(...).send({ error: '...' })` patterns in:
  - `apps/api/src/routes/bots.ts`
  - `apps/api/src/routes/skills.ts`
  - `apps/api/src/routes/ai.ts`
  - `apps/api/src/routes/backtests.ts`
  - `apps/api/src/routes/agent-evaluations.ts`
  - `apps/api/src/routes/agent-platform-assessment-reviews.ts`
- For each unique `error` value, add a catalog entry in en/ar/hi if not already present.
- Use the English `message` field as the en value; translate for ar/hi.
- Estimated ~30 new keys.

### Step 10: Fix date/number formatting in user-facing components — DONE

**Files:**
- `apps/web/src/features/billing/BillingDetails.tsx`
- `apps/web/src/features/agents/ApprovalsPanel.tsx`

**Changes:**
- Replace `new Date(entry.createdAt).toLocaleString()` → `intl.formatDate(entry.createdAt, { dateStyle: 'medium', timeStyle: 'short' })` or equivalent shared helper.
- Replace `row.quantity.toLocaleString()` → `intl.formatNumber(row.quantity)`.
- Replace `date.toLocaleString(undefined, {...})` in ApprovalsPanel → `intl.formatDate(...)`.
- Keep `formatMicrousd()` as-is (uses USD symbol explicitly, acceptable for now).

**Note:** Admin pages (AdminBillingSection, AdminUsersSection, AdminMarketDataSection, AdminOverviewSection) are excluded — they remain English-only and can use ad-hoc formatting.

### Step 11: Add RTL support to email renderer — DONE

**Files:**
- `packages/domain/src/email/renderer.ts`
- `packages/domain/src/email/renderer.test.ts`

**Changes:**
- Add optional `locale?: string` to `EmailContent` interface.
- Derive `dir` from locale: `'ar'` → `'rtl'`, everything else → `'ltr'`.
- Set `<html lang="{locale}" dir="{dir}">` (currently hardcoded `lang="en"`).
- Add `direction: {dir}` to the `<body>` style.
- Inner table cells get explicit `text-align: start` (respects `dir`) for body/title/footer.
- Brand header wordmark (`Open<span>AI</span>dom`) gets `dir="ltr"` to stay correct in RTL context.
- Plain-text renderer is unaffected (text direction is handled by the email client for plain text).
- Add tests: render with `locale: 'ar'` → HTML contains `dir="rtl"`, `lang="ar"`, `text-align: start`.
- Backward compatible: omitting `locale` defaults to `'en'` / `'ltr'` (existing behavior).

### Step 12: Localize login link email — DONE

**Files:**
- `apps/api/src/auth-mailer.ts`
- `apps/api/src/auth-mailer.test.ts`
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts` (optional — if keys are shared with web)

**Changes:**
- Add `locale` parameter to `sendLoginLink(to, link, ttlSecs?, locale?)`.
- Create a small inline message map for login link strings (5 keys):
  - `email.login.subject` — "Sign in to OpenAIdom"
  - `email.login.preheader` — "Your sign-in link is ready"
  - `email.login.title` — "Sign in to OpenAIdom"
  - `email.login.body` — "Click the button below to sign in. This link expires in {ttlMinutes} minutes.\n\nIf you did not request this link, you can safely ignore this email."
  - `email.login.cta` — "Sign In"
- The message map is a simple `Record<SupportedLocale, Record<string, string>>` defined locally in `auth-mailer.ts` (no heavy i18n library needed for 5 keys × 3 locales).
- Pass `locale` to `renderEmail()` so RTL layout is applied for Arabic.
- Update tests to verify localized rendering for each supported locale.

### Step 13: Thread user locale to login link email — DONE

**Files:**
- `apps/api/src/routes/auth.ts` (where `sendLoginLink` is called)

**Changes:**
- When sending the login link email, resolve the user's `preferredLocale` from their profile (if the user exists — for new registrations, fall back to `'en'`).
- For the login-link request flow: the user is already identified by email at this point. Look up `preferredLocale` from the user row (if one exists) and pass to `sendLoginLink()`.
- For brand-new users (no row yet), use `'en'` as default.

### Step 14: Extend i18n regression test — DONE

**Files:**
- `apps/web/src/app/i18n/i18n-regressions.test.ts`

**Changes:**
- Add banned-string entries for newly-migrated pages (following the existing pattern):
  ```typescript
  {
    file: new URL('../../features/bots/BotsPage.tsx', import.meta.url),
    banned: ['Trading bots created by you or your AI agents', 'No bots yet', 'Create Bot'],
  },
  {
    file: new URL('../../features/instances/detail/InstanceDetailPage.tsx', import.meta.url),
    banned: ['Bot not found', 'Open positions', 'Stop bot?', 'Delete bot?'],
  },
  {
    file: new URL('../../features/trading-instances/InstancesPage.tsx', import.meta.url),
    banned: ['Advanced trading records', 'No bots yet'],
  },
  {
    file: new URL('../../features/chat/GuidedSetupPanel.tsx', import.meta.url),
    banned: ['Checking account', 'Starting chat', 'Processing your connection'],
  },
  ```
- Add a test that verifies no `toLocaleString(` calls exist in `BillingDetails.tsx` or `ApprovalsPanel.tsx` (extending the existing `toLocaleDateString` ban to these specific files).

## Verification

### Automated
1. `pnpm lint` passes (tsc --noEmit).
2. `catalog-consistency.test.ts` passes — ar/hi have all en keys.
3. `i18n-regressions.test.ts` passes — banned strings no longer present in migrated files, no `toLocaleDateString` usage in web app, no `toLocaleString` in BillingDetails/ApprovalsPanel.
4. `pnpm test` passes — no broken imports or missing keys.
5. `renderer.test.ts` passes — RTL rendering verified for Arabic locale.
6. `auth-mailer.test.ts` passes — login link email renders in all 3 locales.

### Manual / UAT
7. Switch locale to Arabic → navigate BotsPage, InstanceDetailPage, BillingDetails, GuidedSetupPanel → all text renders in Arabic, RTL layout is correct.
8. Switch locale to Hindi → same surfaces → all text renders in Hindi.
9. Trigger an API error covered by a new catalog key → error renders in active locale (not English fallback key string).
10. Check date/time rendering in BillingDetails and ApprovalsPanel in each locale — format matches locale conventions.
11. Create a bot, view detail, stop it, delete it — all modal text localized.
12. Set `preferredLocale` to Arabic → request a login link → email arrives with Arabic text and RTL layout.
13. Set `preferredLocale` to Hindi → request a login link → email arrives with Hindi text and LTR layout.
14. New user (no `preferredLocale` set) → request a login link → email arrives in English.

## Risks / Considerations

1. **ar/hi translation quality.** New keys need proper translation. If human translators are not immediately available, machine-translate with a note to review. The catalog-consistency test guarantees keys exist but not quality.

2. **Key naming conflicts.** The `bots.*` namespace is new. Confirm it doesn't collide with any existing key prefix in the catalog (currently `nav.bots` exists but no `bots.*` section).

3. **ApprovalsPanel toLocaleString.** The current code uses `date.toLocaleString(undefined, { month: 'short', day: 'numeric', ... })`. Replacing with `intl.formatDate` changes the output format slightly. Verify the UI still looks good.

4. **Admin pages intentionally excluded.** If admin pages later become customer-facing, they will need a separate migration pass.

5. **RTL email rendering across clients.** Gmail, Outlook, and Apple Mail all support `dir="rtl"` on `<html>`, but some older clients may not honor it on inner table cells. The `text-align: start` approach is the most compatible. Test with Litmus or Email on Acid if possible.

6. **Login link for new users.** New users have no `preferredLocale` yet. The email will be English. This is acceptable — the user hasn't had a chance to set a preference yet. After first login, subsequent emails will respect their choice.

## Deferred (see pending/080-i18n-expansion)

- Telegram message localization.
- Remaining email localization (billing notifications, platform safety alerts) — shares server-side i18n infrastructure with Telegram.
- Adding new locales (es, pt, tr, etc.).
- ESLint-based `no-literal-string-in-jsx` rule.
- Pluralization audit (ICU plural format for count-based strings).
- Translation management tooling (Crowdin, Lokalise).
- RTL visual regression tests.
