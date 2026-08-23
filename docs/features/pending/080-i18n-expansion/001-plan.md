# Plan: i18n Expansion — Telegram, Locale Expansion, Tooling

**Feature:** i18n-expansion
**Date:** 2026-08-23
**Status:** Draft
**Prerequisite:** `docs/features/2026/08/23/002-web-i18n-completion/001-plan.md` must be complete first.

## Open Questions (Must Be Resolved Before Starting)

1. **Which locales to add?** Candidates: Spanish (es), Portuguese (pt), Turkish (tr), French (fr), Indonesian (id), Vietnamese (vi). Decision needed on which to include in the first expansion wave and whether machine translation is acceptable as a starting point.

2. **Email localization** — Login link email (including RTL renderer) is handled in Plan 1. Remaining emails (billing + safety alerts) are included in this plan's Phase C.

## Summary

Expand i18n coverage beyond the web frontend to server-to-user communication channels (Telegram), add new locales, and introduce tooling to prevent regressions at scale. This plan assumes the web frontend gaps from the prerequisite plan are already closed.

## Goals

- Telegram messages (platform safety alerts AND slash command responses) are delivered in the user's preferred locale.
- Remaining platform emails (billing notifications, safety alert emails) are localized using the same server-side i18n infrastructure.
- New locales are added to the platform (web catalogs + Telegram + email + API locale validation).
- An ESLint-based or vitest-based lint rule prevents new hardcoded English strings from entering the web codebase.
- Pluralization is audited and corrected for count-based strings across all locales.
- Translation workflow tooling is evaluated and optionally adopted.

## Non-Goals

- Email localization for the login link (handled in Plan 1).
- Admin page localization (internal, English-only).
- Localizing operator-authored content (goals, prompts, skill descriptions).
- Real-time machine translation of dynamic content.

## Architecture Decisions

### Server-side i18n approach

The backend (worker, API) currently has no i18n library. Rather than adding a heavy runtime like `i18next` server-side, introduce a lightweight message resolver:

```typescript
// packages/domain/src/i18n/server-messages.ts
export type ServerLocale = 'en' | 'ar' | 'hi' | ...; // extended set

export function resolveServerMessage(
  locale: ServerLocale,
  key: string,
  params?: Record<string, string | number>,
): string;
```

- Message catalogs stored as simple `Record<string, string>` objects (same pattern as web).
- Located in `packages/domain/src/i18n/server-locales/{en,ar,hi,...}.ts`.
- ICU message format support via `@formatjs/intl-messageformat` (already a transitive dep from react-intl).
- The resolver is a pure function — no global state, no singletons.

### Telegram locale resolution

The user's `preferredLocale` is stored in the database (`users.preferredLocale`). When sending a Telegram message:

1. Resolve the recipient's `preferredLocale` from the database (already fetched alongside `telegramChatId`).
2. Pass it to `resolveServerMessage()` for all user-facing text.
3. Fall back to `'en'` if null.

### Web catalog management at scale

When locale count exceeds ~5, managing TypeScript catalog files by hand becomes error-prone. Evaluate:
- **Option A:** Extract to JSON, use a translation management system (Crowdin, Lokalise, Tolgee).
- **Option B:** Keep TypeScript files but add a script that validates completeness and generates stubs for new locales.

Decision: defer to implementation time based on team preference.

## Implementation Steps

### Phase A: Server-side i18n Infrastructure

#### Step 1: Create server message resolver

**Files:**
- `packages/domain/src/i18n/server-messages.ts`
- `packages/domain/src/i18n/server-locales/en.ts`
- `packages/domain/src/i18n/server-locales/ar.ts`
- `packages/domain/src/i18n/server-locales/hi.ts`
- `packages/domain/src/i18n/index.ts` (barrel export)

**Changes:**
- Implement `resolveServerMessage(locale, key, params?)` using `@formatjs/intl-messageformat`.
- Server catalog keys follow the same dot-string convention as the web.
- Keys are namespaced: `telegram.alert.*`, `telegram.command.*`, `telegram.common.*`.
- Export `ServerLocale` type that stays in sync with web's `SupportedLocale` (enforced by test).

#### Step 2: Add locale to Telegram message context

**Files:**
- `apps/worker/src/alerting/platform-alert-service.ts`
- `apps/worker/src/alerting/telegram-client.ts`
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/api/src/routes/telegram-command-handlers.ts`
- `packages/db/src/repositories/agent-repository.ts` (if not already returning locale)

**Changes:**
- When resolving `telegramChatId`, also fetch `preferredLocale` from the user row.
- Thread locale through to all message-formatting functions.
- `PlatformAlertContext` gains a `locale: ServerLocale` field.
- Telegram command handlers receive locale from the authenticated user context.

### Phase B: Localize Telegram Surfaces

#### Step 3: Localize platform safety alerts

**Files:**
- `apps/worker/src/alerting/platform-alert-service.ts`
- `packages/domain/src/i18n/server-locales/{en,ar,hi}.ts`

**Changes:**
- Replace `formatPlatformAlert()` hardcoded strings with `resolveServerMessage()` calls.
- Keys:
  - `telegram.alert.header` → "🔔 [OpenAIdom Safety Alert]"
  - `telegram.alert.runtime_unhealthy` → "Runtime Unhealthy"
  - `telegram.alert.runtime_failed` → "Runtime Failed"
  - `telegram.alert.paused_by_guardrail` → "Agent Paused by Guardrail"
  - `telegram.alert.execution_critical_failure` → "Critical Execution Failure"
  - `telegram.alert.crash_loop_blocked` → "Agent Crash Loop Blocked"
  - `telegram.alert.agent_label` → "Agent: {name}"
- Replace `formatAlertMessage()` in telegram-client.ts similarly.

#### Step 4: Localize Telegram slash command responses

**Files:**
- `apps/api/src/routes/telegram-command-handlers.ts`
- `packages/domain/src/i18n/server-locales/{en,ar,hi}.ts`

**Changes:**
- Replace all hardcoded response strings in command handlers:
  - `handleAgents`: "You don't have any agents yet...", "Failed to list agents..."
  - `handleInfo`: "Usage: /info <agent name>", "Agent \"{name}\" not found.", field labels
  - `handleLog`: activity labels, "No recent activity", error messages
  - `handleConnections`: connection list formatting, empty state
  - `handleStart/Pause/Resume/Stop/Restart`: success/error messages
  - `handleConnect/Disconnect`: success/error messages
  - `handleMode`: mode labels, validation errors
  - `/help` response text
- Use `resolveServerMessage(locale, key, params)` throughout.
- Estimated ~60–80 new server catalog keys.

#### Step 5: Localize Telegram bot command descriptions

**Files:**
- `apps/worker/src/index.ts` (TELEGRAM_AGENT_COMMANDS array)

**Changes:**
- Telegram Bot API supports per-language command descriptions via `setMyCommands` with `language_code` parameter.
- Register commands for each supported locale using separate `setMyCommands` calls with `language_code` scope.
- Fall back to English for unrecognized locales.

#### Step 6: Localize session-started anchor message

**Files:**
- `apps/worker/src/index.ts` (`sendSessionStartedTelegramAnchor`)
- `packages/domain/src/i18n/server-locales/{en,ar,hi}.ts`

**Changes:**
- Resolve user locale before formatting the anchor message.
- Replace hardcoded text with `resolveServerMessage()`.

### Phase C: Localize Remaining Emails (Billing + Safety Alerts)

The login link email and RTL renderer support are handled in Plan 1. This phase covers the remaining platform emails that share the server-side i18n infrastructure built in Phase A.

#### Step 7: Localize platform safety alert emails

**Files:**
- `apps/worker/src/alerting/platform-alert-service.ts`
- `packages/domain/src/i18n/server-locales/{en,ar,hi,...}.ts`

**Changes:**
- Thread user locale through the `fireAlert()` email path (already resolved for Telegram in Step 2).
- Replace hardcoded subject/title/body in `formatPlatformAlert()` email rendering with `resolveServerMessage()`.
- Keys (~5 per alert type × 5 alert types = ~25 keys):
  - `email.alert.runtime_unhealthy.*`
  - `email.alert.runtime_failed.*`
  - `email.alert.paused_by_guardrail.*`
  - `email.alert.execution_critical_failure.*`
  - `email.alert.crash_loop_blocked.*`
- Pass `locale` to `renderEmail()` for RTL support (renderer already updated in Plan 1).

#### Step 8: Localize billing notification emails

**Files:**
- `apps/worker/src/agents/agent-message-broker.ts`
- `packages/domain/src/i18n/server-locales/{en,ar,hi,...}.ts`

**Changes:**
- Thread user locale through the billing notification email path.
- Replace hardcoded content in:
  - `buildSoftLimitEmailContent()` — soft spending cap notice
  - `buildInsufficientFundsEmailContent()` — agent stopped, needs credit
  - `buildAccountSuspendedEmailContent()` — account suspended
  - `buildHardLimitEmailContent()` — hard spending cap reached
- Keys (~5 per notification type × 4 types = ~20 keys):
  - `email.billing.soft_limit.*`
  - `email.billing.insufficient_funds.*`
  - `email.billing.account_suspended.*`
  - `email.billing.hard_limit.*`
- Pass `locale` to `renderEmail()` for RTL support.
- Fetch user locale alongside `getUserEmailByAgentId()` (add `getUserLocaleByAgentId()` or combine into a single query returning both).

### Phase D: Locale Expansion

#### Step 9: Add new locales to the platform

**Files:**
- `apps/web/src/app/i18n/resolveLocale.ts` (add to `SUPPORTED_LOCALES`)
- `apps/web/src/app/i18n/I18nProvider.tsx` (import new catalogs)
- `apps/web/src/app/i18n/locales/{new_locale}.ts` (new files)
- `apps/api/src/routes/auth.ts` (add to `SUPPORTED_LOCALES` Set)
- `packages/domain/src/i18n/server-locales/{new_locale}.ts` (new files)
- `apps/web/src/app/i18n/i18n-regressions.test.ts` (add new locale to parity check)
- `apps/web/src/app/i18n/catalog-consistency.test.ts` (add new locale)

**Changes:**
- For each new locale decided in the open question:
  1. Create web catalog file (machine-translate from en as starting point, mark for human review).
  2. Create server catalog file (same approach).
  3. Add to `SUPPORTED_LOCALES` in both web and API.
  4. Add to `LANGUAGE_MAP` in resolveLocale for browser language matching.
  5. Add RTL entry if applicable (none of the candidates are RTL).
  6. Update parity tests.
- Run full test suite to confirm no drift.

#### Step 10: Add locale picker entries

**Files:**
- `apps/web/src/lib/LocalePickerButton.tsx`
- Locale display name mapping (if one exists)

**Changes:**
- New locales appear in the locale picker dropdown.
- Display names shown in their own language (e.g., "Español", "Português", "Türkçe").

### Phase E: Tooling & Quality

#### Step 11: Add lint rule to prevent hardcoded strings

**Approach:** Since the project does not use ESLint, two options:

**Option A (preferred if low effort at implementation time):** Extend the existing vitest-based approach with a broader scan:
- Scan all `.tsx` files in `apps/web/src/features/` (excluding admin, tests).
- Flag files that contain JSX string literals matching a heuristic (>3 words, not a CSS value, not a key string, not a URL).
- Allowlist known exceptions (test files, admin pages).
- Fails the test suite if new hardcoded strings are detected.

**Option B (higher effort, better long-term):** Set up ESLint with `eslint-plugin-formatjs` and the `no-literal-string-in-jsx` rule.
- Requires adding eslint + config to `apps/web`.
- Provides IDE-level feedback.
- Higher initial setup cost.

Decision: evaluate at implementation time. If Option A takes <2 hours, do it. Otherwise, do Option B as a dedicated sub-task.

#### Step 12: Pluralization audit

**Files:**
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`
- `packages/domain/src/i18n/server-locales/{en,ar,hi}.ts`

**Changes:**
- Identify all strings that display counts (positions, trades, agents, sessions, bots, skills, etc.).
- Convert from static strings ("No open positions") to ICU plural format:
  ```
  {count, plural, =0 {No open positions} one {# open position} other {# open positions}}
  ```
- Arabic has 6 plural forms (zero, one, two, few, many, other) — ensure proper ICU coverage.
- Estimated ~20–30 strings to convert.

#### Step 13: Evaluate translation management tooling

**Deliverable:** A short evaluation document (not code).

**Evaluate:**
- Crowdin (popular, GitHub integration, free for open source)
- Lokalise (developer-focused, CLI)
- Tolgee (open-source, self-hostable)

**Criteria:**
- Integration with TypeScript catalog format (import/export).
- Support for ICU message format.
- Ability to flag untranslated keys.
- Cost.
- Team workflow fit.

**Outcome:** Recommendation + migration plan if adopted, or explicit "keep manual" decision with rationale.

## Verification

### Automated
1. `pnpm lint` passes.
2. All catalog parity tests pass (including new locales).
3. Server message resolver unit tests pass (key resolution, param interpolation, fallback to en).
4. Telegram command handler tests verify localized output for non-English users.
5. Platform alert service tests verify locale-aware message formatting (Telegram + email).
6. Billing notification email tests verify localized content for each locale.
7. Lint rule (Step 11) passes on existing codebase.

### Manual / UAT
8. Set `preferredLocale` to Arabic → trigger a platform safety alert → Telegram message arrives in Arabic.
9. Set `preferredLocale` to Arabic → trigger a platform safety alert → email arrives in Arabic with RTL layout.
10. Set `preferredLocale` to Hindi → use `/agents` command → response is in Hindi.
11. Set `preferredLocale` to Hindi → agent hits hard spending cap → email arrives in Hindi.
12. Switch web app to a new locale → all existing pages render correctly.
13. Locale picker shows new locales with native-language display names.
14. Arabic plural forms render correctly for zero/one/two/few/many/other cases.

## Risks / Considerations

1. **Telegram message length.** Some translations (especially Arabic) may be longer than English. Ensure `truncateForTelegram()` still works correctly and doesn't cut mid-word in RTL text.

2. **Server catalog size.** With ~80 Telegram keys × N locales, the server catalogs are manageable. But if expanding significantly, consider lazy-loading by locale.

3. **Machine translation quality.** Initial translations will be machine-generated. Plan for a human review pass before public launch of new locales. Consider flagging machine-translated content with a `// REVIEW` comment.

4. **Telegram Bot API limitations.** `setMyCommands` with `language_code` only supports BCP 47 language codes. Verify that all chosen locales are supported by Telegram's API.

5. **Breaking change for existing ar/hi users.** Telegram messages switch from English to their locale. This is an improvement but could briefly confuse users who are accustomed to English bot messages. No mitigation needed — this is the desired behavior.

6. **`@formatjs/intl-messageformat` bundle size on server.** This is a server-side package (Node.js), so bundle size is irrelevant. Tree-shaking is not a concern here.

## Dependencies

- Plan 1 (`002-web-i18n-completion`) must be complete — ensures web catalogs are comprehensive, patterns are established, and the email renderer already supports RTL via the `locale` param.
- Open question #1 (locale selection) must be answered before Phase D.
