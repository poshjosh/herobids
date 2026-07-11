# New-User Link + Unique Username

## Status

`draft`

## Created

`2026-07-11`

## Depends On

`docs/features/2026/07/11/001-login-link-first-auth-ux/001-plan.md`

## Goal

Add a familiar, optional registration affordance to the login-link-first auth screen without reintroducing a full login/register mode split.

The new flow should let a user click `New user`, optionally enter a username above the email field, and then send a registration link instead of a login link. If the user does not click `New user`, or clicks it but leaves the username blank, the system should still create the account successfully by generating a username automatically.

## Clarified Product Decisions

This plan encodes the following decisions:

1. `username` means a new unique user handle, not the existing `displayName` field.
2. The `New user` affordance is optional and additive. It does not create a separate page or hard registration mode.
3. If a user clicks `New user` and supplies a username, the system must validate availability before sending the email.
4. If the supplied username is already taken, the UI should show an error immediately and not send the email.
5. If the user does not click `New user`, or clicks it but leaves the username blank, the backend should generate a username automatically.
6. Email existence must remain private. Username availability is treated as public enough to validate directly.
7. Existing users who use the `New user` affordance by mistake should still be able to complete sign-in successfully through the email-link flow.
8. At account creation time, `displayName` is derived from `username`.
9. After account creation, `displayName` and `username` are not treated as permanently coupled.

## Current Baseline

Today the codebase behaves like this:

1. The login page is email-first and supports:
   - `Send login link`
   - inline password sign-in
   - Google OAuth
2. `POST /auth/send-login-link` accepts `email` only.
3. First-time email-link users are created on callback redemption, not when the email is sent.
4. First-time email-link users currently get `users.displayName` from the email local-part.
5. There is no `users.username` field in the database.
6. There is no username availability check, reservation flow, or username-specific frontend state.
7. Google OAuth creates users with `displayName` from the provider profile and no separate username concept.

## Desired UX Contract

The login page should behave as follows:

1. Initial state remains the existing email-first screen.
2. A small `New user` link is visible as a secondary affordance on the auth card.
3. Clicking `New user` reveals a username field above the email field.
4. When `New user` is active:
   - the primary CTA text changes from `Send login link` to `Send registration link`
   - all other auth paths remain available
   - the username field is optional
5. If `New user` is not active, sending the link behaves exactly as it does today.
6. If `New user` is active and the username field is blank, sending the link still works and the backend auto-generates a username.
7. If `New user` is active and the username is already taken, the user gets an inline validation error before the email is sent.
8. If `New user` is active and the username is available, the backend reserves it for the pending login-link flow and uses it if the callback creates a new account.
9. If the email already belongs to an existing user, redeeming the link signs into that user as normal; any submitted username is ignored for account mutation.

## Scope

In scope:

1. adding a unique `username` field to users
2. validating and reserving usernames during the login-link send flow
3. extending the login page with the `New user` affordance and optional username field
4. updating CTA copy and i18n strings
5. tests for username validation, reservation, fallback generation, and the new login-page behavior

Out of scope:

1. a separate registration page or hard register/login toggle
2. editing usernames after account creation
3. public profile pages or `@username` routes
4. a dedicated onboarding/profile-completion flow
5. changing Google OAuth or password-auth semantics

## Key Design Constraints

1. Do not regress the email-link-first design. `New user` must remain a lightweight hint, not a competing primary mode.
2. Keep email enumeration protections unchanged. `POST /auth/send-login-link` must not reveal whether the email already maps to a user.
3. Treat username availability as a direct validation surface. The system may reject a taken username before email delivery.
4. Avoid callback-time surprise failures by reserving usernames during the send flow rather than only checking at redemption time.
5. Preserve the existing exchange-code callback handoff so browser URLs still never carry session tokens.

## Data Model Design

### New user field

Add a new `users.username` field with the following characteristics:

1. stored in canonical lowercase form
2. unique across all users
3. intended as the primary stable handle for account creation and identity
4. required for all users in this environment

### Relationship to `displayName`

`displayName` remains a separate field, but its initial value is derived from `username` when the account is created.

Rules:

1. account creation first generates or accepts `username`
2. `displayName` is then initialized from that `username`
3. the system should not assume the two stay equal forever
4. future profile editing may allow `displayName` to diverge without changing `username`

### Username format

Use a conservative first-pass username format so the feature has clear rules and stable uniqueness semantics.

Proposed constraints:

1. lowercase letters, digits, and underscore only
2. minimum length 3
3. maximum length 30
4. trim whitespace before validation
5. reject anything outside the allowed character set

This is intentionally narrower than a free-form display name.

### Environment assumption

This plan assumes there are no existing users that need migration handling.

Implications:

1. `users.username` can be created as non-null from the start
2. uniqueness can be enforced directly on the column
3. no backfill or nullable transitional state is needed

## Backend Design

### Route input changes

Extend `POST /auth/send-login-link` to accept:

1. `email` — required
2. `username` — optional, only meaningful when the frontend is in `New user` state

The route should:

1. normalize and validate the email as today
2. if `username` is present and non-blank:
   - normalize it
   - validate format
   - reject if already taken
   - reserve it for the pending login-link flow
3. if `username` is absent or blank:
   - continue without reservation
   - let callback-time user creation generate a username automatically

This same username-generation rule should also be used by OAuth-created users so every account-creation path yields a username.

### Redis data model

Keep the existing login-link token storage and add username reservation state.

Suggested keys:

1. `auth:login-link:token:{token}` -> JSON payload with normalized email and optional normalized username
2. `auth:login-link:username-reservation:{username}` -> token or reservation payload, set with `NX` and the same TTL as the login link
3. existing cooldown and rate-limit keys remain unchanged

Requirements:

1. reservations expire with the login link
2. reservation creation is atomic
3. callback user creation trusts only the username reserved for that token
4. if the link is redeemed for an already-existing user, the reservation is ignored and can expire naturally

### Username generation

Add reusable helpers in the auth route layer for:

1. username normalization
2. username format validation
3. unique username generation for fallback cases

Generation strategy:

1. username generation happens server-side only
2. if a user supplies a username, normalize and validate that explicit value
3. if no username is supplied, derive a readable base candidate from the email local-part
4. generated usernames should combine a readable base with entropy so collisions are unlikely in normal operation
5. the exact suffix shape does not need to be fixed in the plan, but it must be deterministic enough for tests and random enough to avoid high collision rates
6. a provided username that is blank after trim is treated as omitted

Uniqueness guarantees:

1. `users.username` database uniqueness is the final source of truth
2. generation code must not assume a pre-insert availability check is sufficient
3. account creation must retry with a fresh generated candidate when a username unique-constraint conflict occurs
4. retries must be bounded to a small fixed number rather than looping forever
5. if bounded retries are exhausted, account creation should fail loudly with an internal error rather than silently degrading

Display-name behavior:

1. after the canonical username is determined, initialize `displayName` from it
2. the first-pass derivation should be humanized from username rather than copied literally when practical
3. a username like `jane_doe` should yield a display name like `Jane Doe`
4. the derivation must remain deterministic and based on username rather than email

### Callback behavior

Update the login-link callback path so that when a new user is created:

1. if a reserved username exists in the token payload, persist it as `users.username`
2. if no username was supplied, generate a unique username automatically
3. set `users.displayName` from the resolved username at account creation time
4. if a generated username collides at insert time, retry with a fresh candidate up to the configured bounded limit

For existing users:

1. sign into the resolved user as today
2. do not mutate `username` or `displayName`
3. do not fail because the request carried a username intended for registration

Update the OAuth user-creation path so that when a new OAuth user is created:

1. generate a canonical username if one does not already exist for the resolved user
2. initialize `displayName` from that username at creation time rather than relying on provider-specific name shape as the source of truth
3. continue using provider profile data for optional presentation fields like avatar where appropriate
4. use the same bounded retry-on-conflict strategy as the email-link path

### API response shape

Expose `username` on `GET /auth/me` so the authenticated client can read the canonical handle after sign-in.

This plan does not include a username-edit endpoint.

## Frontend Design

### Login page interaction model

Build on the current email-first page and add a separate `newUser` boolean or equivalent state.

Behavior:

1. initial screen stays unchanged except for a small `New user` link
2. clicking `New user` reveals a username field above the email field
3. the screen does not become a separate hard registration mode
4. `Send login link` changes to `Send registration link` while `New user` is active
5. password sign-in and Google OAuth remain visible and usable
6. the success state still uses the shared generic email-sent messaging pattern

### Validation behavior

Frontend validation should stay lightweight.

1. blank username is allowed
2. obviously invalid usernames may be blocked client-side for quick feedback
3. authoritative username availability validation happens via the API
4. username-taken errors should render inline on the login page without clearing email input

### Copy and i18n

Add or update locale strings for:

1. `New user`
2. username field label and placeholder
3. `Send registration link`
4. username format errors
5. username already taken error
6. optional helper copy if needed to explain that leaving the field blank is allowed

## Implementation Plan

### Slice 1 — Schema and migration

Goal: introduce `users.username` as a required unique field with no transitional compatibility layer.

Tasks:

1. add `username` to the users schema
2. create a migration that adds the column as non-null and unique
3. update any read models or API types that should expose the field

Expected result:

All users created in this environment must have a stable unique username.

### Slice 2 — Auth route username support

Goal: extend the login-link backend flow to validate, reserve, and persist usernames.

Tasks:

1. extend `POST /auth/send-login-link` to accept optional `username`
2. add username normalization and format validation helpers
3. add a username availability check against `users.username`
4. reserve usernames in Redis when a valid explicit username is supplied
5. store the optional username in the token payload
6. update callback user creation to persist reserved usernames for new users only
7. update OAuth user creation to generate usernames using the same shared helper
8. initialize a humanized `displayName` from the resolved username at account creation time
9. expose `username` from `GET /auth/me`
10. bound retry-on-conflict logic for generated usernames and fail loudly when the retry budget is exhausted

Expected result:

The backend can safely support optional unique usernames without callback-time races.

### Slice 3 — Login page `New user` affordance

Goal: add a familiar registration hint without reintroducing a mode split.

Tasks:

1. add a `New user` secondary link to the auth card
2. reveal a username field above the email field when activated
3. change the primary CTA copy to `Send registration link` while active
4. submit optional `username` alongside `email` when sending a link
5. show inline username validation errors returned by the API
6. preserve all current password and Google flows

Expected result:

New users have an obvious path to initiate account creation, while returning-user flows stay as simple as they are now.

### Slice 4 — Tests

Goal: cover the new uniqueness and UX behavior.

Tasks:

1. add API tests for:
   - valid explicit username reserves successfully
   - taken username returns an error before email send
   - blank username falls back to generated username
   - generated usernames include the configured uniqueness strategy shape at a high level
   - callback persists reserved username for first-time users
   - callback initializes a humanized `displayName` from the resolved username
   - generated-username insert conflict retries successfully within the retry budget
   - generated-username insert conflict fails loudly when the retry budget is exhausted
   - OAuth first-time user creation generates username and initializes a humanized `displayName` from it
   - existing-user callback ignores submitted username
2. add migration or schema validation coverage for required unique username semantics
3. add frontend tests if web test infrastructure exists for:
   - `New user` toggle reveals the username field
   - CTA text swaps between login and registration link modes
   - username errors render inline
   - blank username still allows send
4. update e2e helpers or auth journeys as needed

Expected result:

The new registration hint and unique-username path are protected against regressions.

## Likely Files To Modify

Backend:

1. `packages/db/src/schema/users.ts`
2. new DB migration files under `packages/db`
3. `apps/api/src/routes/auth.ts`
4. `apps/api/src/routes/auth.test.ts`
5. `apps/api/src/lib` or route-local helpers if username logic is extracted

Frontend:

1. `apps/web/src/features/auth/LoginPage.tsx`
2. `apps/web/src/lib/api-client.ts`
3. `apps/web/src/app/i18n/locales/en.ts`
4. `apps/web/src/app/i18n/locales/ar.ts`
5. `apps/web/src/app/i18n/locales/hi.ts`

E2E / tests:

1. `tests/e2e/helpers.ts`
2. auth-related journey specs if they assert old copy or old payload shapes

## Acceptance Criteria

1. The login page shows a `New user` affordance without restoring a separate register mode.
2. Clicking `New user` reveals a username field above the email field.
3. While `New user` is active, the primary CTA reads `Send registration link`.
4. If the username field is blank, the flow still succeeds and the backend auto-generates a unique username.
5. If the username is provided and available, the backend reserves and persists it for a newly created user.
6. If the username is already taken, the user sees an inline error before any email is sent.
7. Existing users can still complete sign-in even if they accidentally used the `New user` affordance.
8. The feature does not leak whether the email already exists.
9. Newly created email-link and OAuth users get a reasonable humanized `displayName` initialized from the resolved username.
10. Focused auth tests pass and `pnpm lint` passes.

## Risks To Watch

1. Username availability is now a public validation surface; product and support should be comfortable with that tradeoff.
2. Reservation logic must prevent races between send-time validation and callback-time account creation.
3. The term `username` may invite future product expectations like public profiles or mentions; keep this first pass scoped to account identity only.

## Recommended Implementation Order

1. schema + migration design
2. auth route validation, reservation, and callback persistence
3. login page `New user` affordance and copy updates
4. tests and e2e/helper cleanup
