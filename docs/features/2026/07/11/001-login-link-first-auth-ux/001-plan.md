# Login-Link-First Auth UX

## Status

`draft`

## Created

`2026-07-10`

## Goal

Make email login links the default authentication path for both sign-in and first-time registration, while keeping Google OAuth seamless and preserving password login as a secondary inline fallback.

The result should remove the current login/register mode split from the entrypoint and replace it with a single email-first screen that supports three paths:

1. send a login link
2. continue with Google
3. expand an inline password field and sign in with password

## Current Baseline

Today the codebase behaves like this:

1. `apps/api/src/routes/auth.ts` exposes:
   - `POST /auth/register` with `email`, `password`, and `displayName`
   - `POST /auth/login` with `email` and `password`
   - Google OAuth endpoints that already use a login-or-create flow
2. `apps/web/src/features/auth/LoginPage.tsx` renders a mode toggle between login and register.
3. `apps/web/src/features/auth/AuthCallbackPage.tsx` and `POST /auth/exchange` already provide a good callback handoff that keeps JWTs out of URLs.
4. SES-based outbound email infrastructure already exists in the repo for worker alerts, but the API does not yet send auth emails.

## Desired UX Contract

The login page should behave as follows:

1. Initial state shows:
   - email field
   - `Send login link` button
   - a small `Sign in with password` link immediately to the side of that button
   - `Continue with Google` below the divider
2. Clicking `Sign in with password` reveals a password field directly under the email field.
3. After that reveal:
   - the small link is replaced by a `Sign in` button
   - `Send login link` remains visible and usable
   - the password field includes a show/hide toggle
4. There is no separate register mode on the page.
5. Email-link and Google flows both cover login and first-time registration.
6. Password login remains available only for users who already have a local password identity.

## Product Decisions Encoded By This Plan

1. Email link is the primary auth path. The UI should optimize for that first and not visually compete with it.
2. Login and registration collapse into one email-link flow. Entering an email and proving inbox ownership is sufficient to create an account.
3. Google OAuth remains a first-class secondary option and continues to use the existing find-or-create behavior.
4. Password auth stays supported for backwards compatibility, but it becomes an opt-in inline fallback instead of the default path.
5. Clicking `Sign in with password` must not disable or replace the login-link path. Both actions remain available in the expanded state.
6. The system must not leak whether an email already exists when sending login links. The send-link response should be generic.
7. The existing exchange-code callback pattern should be reused for login-link completion so session tokens never appear in the browser URL.
8. If a user attempts password login for an account that has no local password identity, return a dedicated error. Do not silently send a login email as a side effect of password submission.

## Scope

In scope:

1. new email-link auth API endpoints and Redis-backed one-time tokens
2. email-link delivery from the API using the existing operator email transport conventions
3. login page redesign for email-first auth
4. inline password expansion and password visibility toggle
5. reuse of the existing frontend callback page and exchange-code flow
6. copy and i18n updates for the new auth states
7. tests for API auth flows, UI state transitions, and e2e helpers impacted by the removal of register mode

Out of scope:

1. removing password auth entirely
2. adding non-Google OAuth providers
3. passkeys or WebAuthn
4. a full onboarding/profile-completion flow
5. redesigning session storage or JWT semantics

## Key Design Constraints

1. Follow the operator-config vs runtime-config boundary. TTLs, resend windows, and auth email rate limits belong in operator config.
2. Do not duplicate unrelated auth surfaces. Reuse `AuthCallbackPage` and `POST /auth/exchange` instead of creating a second browser token-handoff path.
3. Preserve current Google OAuth behavior, including existing account linking by email.
4. Keep password login API-compatible for existing callers unless and until a separate cleanup intentionally removes it.

## Important Implementation Detail: First-Time Display Names

`users.displayName` is currently required, but the new primary auth flow only asks for an email address.

This plan assumes the first implementation will:

1. create first-time magic-link users only when the login link is redeemed, not when it is sent
2. derive an initial display name from the email local-part for those first-time users
3. avoid blocking auth on a separate name-capture step

This keeps the entry flow frictionless. A richer first-run profile flow can be handled separately later if needed.

## Backend Design

### Config additions

Extend `AuthConfigSchema` with operator-owned settings such as:

1. `loginLinkTtlSecs`
2. `loginLinkResendCooldownSecs`
3. `loginLinkMaxSendsPerWindow`
4. `loginLinkWindowSecs`
5. `loginLinkMaxSendsPerIpWindow`

These settings belong under `auth.*`, not in user runtime config.

### Email transport

Use the existing operator email provider conventions instead of inventing a second mail config surface.

Implementation direction:

1. reuse the existing SES-based operator email settings shape already used for alerts
2. add a small auth mailer surface for API-triggered login-link delivery
3. keep auth-specific concerns under `auth.*` and shared transport/provider concerns under the existing email configuration surface

Do not block this feature on a large mail-service refactor.

### Redis data model

Use Redis for short-lived, one-time login-link state.

Suggested keys:

1. `auth:login-link:token:{token}` -> JSON payload with normalized email
2. `auth:login-link:email-window:{emailHash}` -> rolling send counter / cooldown state
3. `auth:login-link:ip-window:{ip}` -> rolling send counter / cooldown state

Requirements:

1. tokens are random and high-entropy
2. tokens are single-use via atomic get-and-delete
3. send limits protect both email addresses and source IPs

### API endpoints

Add these routes:

1. `POST /auth/send-login-link`
   - input: `email`
   - validates email syntax
   - applies rate limiting / resend cooldown
   - stores short-lived token state in Redis
   - sends email when allowed
   - returns a generic success payload regardless of whether the email already maps to a user
2. `GET /auth/login-link/callback`
   - input: one-time token from the email
   - validates and consumes the token
   - resolves or creates the user by email
   - issues a normal session JWT
   - stores a one-time exchange code in Redis using the existing pattern
   - redirects to the existing frontend callback route

### User resolution

Refactor the current auth route logic so email-based user resolution becomes explicit and reusable.

Target behavior:

1. if the email already belongs to a local-auth user, sign into that user
2. if the email already belongs to a Google-created user, sign into that same user
3. if the email does not exist, create a new user and seed the canonical free-plan row exactly once

The backend should avoid creating a parallel “magic-link identity” table unless a clear future requirement appears. Email is already unique on `users` and is enough for this first pass.

### Password login behavior

Keep `POST /auth/login` as the password endpoint.

Add one refinement:

1. when the email belongs to a user who has no `local_identities` row, return a dedicated error code such as `auth.login.password_not_available`

That gives the UI a precise error instead of collapsing everything into invalid credentials.

## Frontend Design

### Login page interaction model

Replace the current login/register mode switch with a single email-first screen.

States:

1. `passwordCollapsed`
2. `passwordExpanded`
3. `sendingLoginLink`
4. `signingInWithPassword`
5. `loginLinkSent`

Behavior:

1. initial view shows only email plus the two side-by-side actions
2. clicking `Sign in with password` expands the password field below the email field
3. once expanded, the small link becomes a `Sign in` button
4. `Send login link` stays available in both states
5. the password field exposes a show/hide control
6. the UI shows a generic success message after a link is sent

### Button semantics

The page should make the action targets unambiguous:

1. pressing Enter in the collapsed state sends a login link
2. pressing Enter while focused in the password field triggers password sign-in
3. password sign-in should not require a separate hidden mode toggle

This likely means the component should stop treating the entire auth page as one simple single-submit form and instead model the two actions deliberately.

### Copy and messaging

Update locale catalogs for:

1. send-link CTA and success state
2. inline password expansion CTA and sign-in CTA
3. password visibility labels
4. dedicated password-unavailable error text
5. generic “check your email” / resend guidance

## Implementation Plan

### Slice 1 — Config and backend primitives

Goal: add the minimal config and reusable auth-link helpers needed for the new flow.

Tasks:

1. extend `packages/domain/src/config/schema.ts` with login-link TTL and rate-limit settings
2. document defaults in `config/default.yaml`
3. add helper utilities in the auth route layer for:
   - email normalization
   - derived default display names
   - login-link token creation and consumption
   - rate-limit key generation
4. introduce an API-side auth email sender surface that follows existing SES operator config conventions

Expected result:

The API can generate and send login links safely without yet touching the web UI.

### Slice 2 — API routes for login links

Goal: land the backend flow end to end.

Tasks:

1. add `POST /auth/send-login-link`
2. add `GET /auth/login-link/callback`
3. refactor shared user-resolution logic so Google and email-link auth both resolve the same user correctly
4. reuse `issueSession()` and the existing exchange-code redirect handoff
5. add the dedicated `password_not_available` error path to password login

Expected result:

The backend supports email-link login/registration without changing session semantics.

### Slice 3 — Login page redesign

Goal: replace the current login/register split with the new interaction contract.

Tasks:

1. remove the login/register mode toggle from `LoginPage.tsx`
2. add the side-by-side action row:
   - `Send login link`
   - small `Sign in with password` link that becomes a `Sign in` button when expanded
3. render the password field conditionally under the email field
4. add password visibility toggle behavior
5. call the new `auth.sendLoginLink()` API client method
6. preserve the existing Google CTA
7. show generic success and precise password errors

Expected result:

The page defaults to passwordless auth while still supporting password users cleanly.

### Slice 4 — Tests and helper updates

Goal: cover the behavior change at the API, component, and e2e-helper levels.

Tasks:

1. add API route tests for:
   - successful login-link send
   - generic response behavior
   - invalid/expired/consumed token callback failures
   - callback into existing user
   - callback creating a first-time user
   - password login for passwordless account returns dedicated error
2. add web tests for:
   - password field expansion/collapse behavior
   - button/link state transitions
   - password visibility toggle
   - Enter-key semantics for collapsed vs expanded states
3. update e2e helpers that currently assume register mode exists
4. add or update a focused auth journey test for the revised login page

Expected result:

The new UX is protected against regression, and existing tests no longer depend on the removed register toggle.

## Likely Files To Modify

Backend:

1. `packages/domain/src/config/schema.ts`
2. `config/default.yaml`
3. `apps/api/src/routes/auth.ts`
4. `apps/api/src/routes/auth.test.ts`
5. `apps/api/src/routes/auth-oauth.integration.test.ts` and/or new auth route tests
6. `apps/api/package.json` only if the implementation chooses an API-local SES dependency rather than extracting a shared helper

Frontend:

1. `apps/web/src/features/auth/LoginPage.tsx`
2. `apps/web/src/lib/api-client.ts`
3. `apps/web/src/app/i18n/locales/en.ts`
4. `apps/web/src/app/i18n/locales/ar.ts`
5. `apps/web/src/app/i18n/locales/hi.ts`
6. `apps/web/src/features/auth/LoginPage.test.tsx` (new)

E2E:

1. `tests/e2e/helpers.ts`
2. auth-related journey specs that currently assume register/login mode toggles

## Acceptance Criteria

1. The login page defaults to an email-only login-link flow.
2. `Send login link` and the password CTA/button appear on the same action row.
3. Clicking `Sign in with password` reveals the password field under the email field.
4. Once revealed, the small link becomes a `Sign in` button while `Send login link` remains usable.
5. The password field supports show/hide visibility.
6. Google OAuth still works for both sign-in and first-time registration.
7. Redeeming a valid login link signs the user in through the existing exchange-code callback flow.
8. First-time email-link users are created successfully without a separate registration screen.
9. Password login for accounts without a local password returns a dedicated error.
10. `pnpm lint` passes and focused auth tests pass.

## Risks To Watch

1. The current required `displayName` field can create hidden coupling if first-time user creation is not handled deliberately.
2. Sending auth emails from the API may tempt duplication of existing SES transport logic; keep the first cut small and aligned with existing operator config.
3. Removing the register mode will break existing e2e helpers unless they are updated together with the UI.
4. Multiple submit paths on one screen can create confusing keyboard behavior if the component remains a single implicit-submit form.

## Recommended Implementation Order

1. backend config + login-link routes
2. route tests for callback/send-link behavior
3. login page redesign and API client updates
4. component tests for UI state transitions
5. e2e helper cleanup and focused auth journey validation