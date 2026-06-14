# ADR 002: Web i18n Contract And Key Strategy

Status: Accepted
Date: 2026-06-10

## Context

HeroBids now supports multiple operator locales in the web app and API-facing UI flows. The implementation needs a single contract for how page chrome, persisted user preferences, API error payloads, and activity events are localized so later features do not regress into mixed English copy or ad-hoc formatting.

## Decision

Use `react-intl` as the sole web localization runtime and adopt the following rules:

- translation keys are stable dot-strings grouped by feature surface, for example `agents.detail.runtimeHealth` and `billing.checkout.invalid_plan_id`
- locale resolution order is persisted browser choice first, browser language list second, and English fallback last
- the active locale is persisted in both browser storage and the authenticated user profile so sessions and devices can converge on the same preference
- API errors exposed to the web app must use `error + message + params`, where `error` is the translation key and `params` contains only interpolation-safe primitives
- activity events exposed to the web app must use `messageKey + detail`, where `messageKey` is the translation key and `detail` is filtered client-side to primitive interpolation values only
- page chrome, operator controls, and framework-owned labels must come from catalogs; operator-authored prompts, goals, and other stored domain text remain source text and are not machine-translated at render time
- locale-aware formatting for dates, currency, and numbers must go through shared helpers rather than ad-hoc `toLocaleDateString()` or string concatenation in feature components

## Consequences

- frontend pages can localize backend validation and plan-limit errors without special-case mapping tables
- activity rendering stays safe because object payloads are filtered before ICU interpolation
- locale catalog parity can be enforced by tests because every feature uses stable keys instead of inline copy
- persisted locale preference becomes a product contract, so profile writes and session bootstrap must keep honoring `preferred_locale`
- future page migrations should add catalog entries and regression tests alongside UI changes instead of relying on manual review