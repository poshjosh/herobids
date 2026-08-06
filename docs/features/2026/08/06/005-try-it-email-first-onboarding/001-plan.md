# Plan: "Try It" — Email-First Onboarding for Unauthenticated Users

**Feature:** Try It — Email-First Onboarding (005)
**Date:** 2026-08-06
**Status:** In Progress

## Summary

Let unauthenticated visitors start the agent creation journey. A "Try it" button on the landing page navigates to a new `/try` page that **looks like** the guided setup chat — chat bubbles, typing animation, conversational messaging — but uses only static copy and the existing rate-limited login-link endpoint. No LLM is called. After the user enters a valid email, the existing generic "check your email" success UX is shown. Clicking the login link authenticates the user and redirects them to `/agents/new`.

From `/agents/new`, the authenticated experience may continue in one of two acceptable ways depending on the implementation choice:

- show the existing Guided Setup chat when billing allows it, including the existing Guided Setup billing gate when it does not
- switch the user directly to the existing plain create-agent form when that produces a clearer first-run flow

Zero anonymous LLM cost. This plan does not redesign Guided Setup billing semantics; it reuses the existing authenticated create-agent surfaces.

This plan is **related to but separate from** the AI-First UX feature (`docs/features/2026/08/01/005-ai-first-ux/`) which built the authenticated Guided Setup chat.

## Decisions (confirmed)

1. **No anonymous LLM calls.** The `/try` page uses static copy with a typing animation — no LLM is invoked. Zero cost for unauthenticated users.
2. **Separate `/try` page, not embedded in chat.** The `/try` page is a standalone route with its own component. It is NOT the `GuidedSetupPanel` with a pre-auth mode.
3. **`/try` mimics the guided setup chat visually.** Chat bubbles, sequential message reveal with typing delays, but no chat composer — only an email input after the second message.
4. **Messages on `/try`:**
   - Message 1 (after 0.5s typing): *"Hi! I can help you create an AI agent. Let's get you set up first."*
   - Message 2 (after 2.5s typing): *"I see you have not logged in, please provide your email address so your AI agents can communicate with you"* → email input below
   - Message 3 (after link sent): *"An email has been sent to you@example.com. Check your inbox — the link will set you up for a new AI agent."* → resend button below
5. **Keep the existing generic success behavior.** `/try` uses the same generic "check your email" success semantics as the login page. It does not attempt to distinguish delivery success from accepted request handling.
6. **Login link redirects back to `/agents/new`.** The emailed link still contains only the one-time token. The post-auth target is stored server-side in the login-link token payload and forwarded to `/auth/callback` after token consumption.
7. **Post-auth create-agent fallback is flexible.** Landing on `/agents/new` may result in the existing Guided Setup billing gate or a switch to the existing plain form, whichever the implementer judges more appropriate for the first blocked experience.
8. **Landing page gets "Try it" + redesign.** Replace "Learn more" with "Try it" linking to `/try`. Add encouraging copy, background image, tagline from `docs/vision.md`, responsive improvements.
9. **Guided setup prompt/flow fixes are OUT OF SCOPE.** Non-trading agent field filtering, skill selection, scanner-gated pre-selection, split greeting messages — separate plans.
10. **Authenticated users visiting `/try` are redirected to `/agents/new`.** The `/try` page is only for unauthenticated users.

## Current State

### What exists today

| Component | Status | Location |
|-----------|--------|----------|
| Magic link auth (send + callback) | ✅ Built | `apps/api/src/routes/auth.ts` |
| Rate limiting on login links | ✅ Built | Per-email cooldown (60s), window (5/hr), per-IP (10/hr) |
| User auto-creation from email | ✅ Built | `resolveOrCreateUserByEmail()` in `auth.ts` |
| `next` param in AuthCallbackPage | ✅ Built | `apps/web/src/features/auth/AuthCallbackPage.tsx:37` reads `next` from URL |
| Guided Setup chat (authenticated) | ✅ Built | `apps/api/src/routes/chat.ts`, `GuidedSetupPanel.tsx` |
| Guided Setup billing gate | ✅ Built | `GuidedSetupPanel` uses existing billing checks and can block chat before LLM use |
| Landing page | 🟡 Placeholder | `LandingPagePlaceholder.tsx` — basic "Sign in" + "Learn more" |
| `/agents/new` route | 🔒 Auth-gated | Inside `RootLayout`, redirects unauthenticated to `/login` |
| Login link callback → `/agents/new` redirect | ❌ Missing | Callback redirects to `/auth/callback` without `next` param |
| `/try` route | ❌ Does not exist | — |
| Redirect sanitization helper for frontend return paths | ✅ Existing pattern | `apps/api/src/routes/connections-oauth.ts` has a stricter relative-path sanitizer |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Landing Page (/)                                        │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Background image + central figure + tagline       │  │
│  │  "Low cost AI agents that trade, assist,           │  │
│  │   research and more"                               │  │
│  │                                                    │  │
│  │  [Sign in]  [Try it]                              │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────────┘
                       │ "Try it" navigates to /try
                       ▼
┌──────────────────────────────────────────────────────────┐
│  /try (unauthenticated — no LLM)                         │
│  ┌────────────────────────────────────────────────────┐  │
│  │  ┌─ Chat bubble (assistant) ────────────────────┐  │  │
│  │  │ "Hi! I can help you create an AI agent.      │  │  │
│  │  │  Let's get you set up first."                │  │  │
│  │  │  (shown after 0.5s typing animation)         │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  │                                                    │  │
│  │  ┌─ Chat bubble (assistant) ────────────────────┐  │  │
│  │  │ "I see you have not logged in, please        │  │  │
│  │  │  provide your email address so your AI       │  │  │
│  │  │  agents can communicate with you"            │  │  │
│  │  │  (shown after 2.5s typing animation)         │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  │                                                    │  │
│  │  ┌─ Email input ───────────────────────────────┐  │  │
│  │  │ [you@example.com                    ] [→]   │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │                                                    │  │
│  │  (No chat composer — email input is the only       │  │
│  │   interaction)                                     │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  After valid email submitted: POST /auth/send-login-link │
│                                                          │
│  ┌─ Chat bubble (assistant) ─────────────────────────┐  │
│  │ "An email has been sent to you@example.com.      │  │
│  │  Check your inbox — the link will set you up     │  │
│  │  for a new AI agent."                            │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  [Resend link]                                          │
└──────────────────────────────────────────────────────────┘
                       │ User clicks link in email
                       ▼
┌──────────────────────────────────────────────────────────┐
│  GET /auth/login-link/callback?token=...                   │
│  → issues session, exchange code                         │
│  → redirects to /auth/callback?code=...&next=/agents/new │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  AuthCallbackPage (/auth/callback)                       │
│  → exchanges code for JWT                                │
│  → reads next=/agents/new from URL                       │
│  → sanitizes next against frontend origin                │
│  → navigates to /agents/new                              │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  /agents/new (authenticated — inside RootLayout)         │
│  → either: Guided Setup chat starts normally            │
│  → or: existing Guided Setup billing gate is shown      │
│  → or: implementation switches user to plain form       │
└──────────────────────────────────────────────────────────┘
```

## Proposed Changes

### 1. Landing Page Redesign (`apps/web/src/features/landing/`)

Replace the placeholder landing implementation with the real landing page:

- **Background image:** `docs/product/brand/images/openaidom-background.avif` — central figure with a speech/thought bubble. Left-aligned on desktop, stacked on mobile. During implementation, copy the image to `apps/web/public/` and reference it from there.
- **Tagline:** *"Low cost AI agents that trade, assist, research and more"* from `docs/vision.md`.
- **Encouraging copy:** A short sentence or two above the fold reinforcing the value proposition for new visitors.
- **CTA buttons:** "Sign in" (links to `/login`) and "Try it" (links to `/try`). Both primary-styled.
- **Responsive:** mobile-specific adjustments scoped to the landing page only; no body-wide typography or global form-style overrides.
- **`BrandLogo`:** `display="full" variant="auto" size="lg"`.
- **Authenticated visitors:** Redirect to `/agents` (existing behavior).

**Files:**
- **Modify:** `apps/web/src/features/landing/LandingPagePlaceholder.tsx` or replace it with `LandingPage.tsx` if the implementer prefers the rename
- **Modify:** `apps/web/src/app/router.tsx` — update import
- **Modify:** `apps/web/src/styles.css` — landing-page-scoped styles and responsive rules
- **Copy:** `docs/product/brand/images/openaidom-background.avif` → `apps/web/public/openaidom-background.avif`

### 2. New `/try` Page (`apps/web/src/features/try/TryPage.tsx`)

A standalone page that mimics the guided setup chat appearance. No LLM calls, no auth required.

**Component structure:**

```
TryPage
  ├─ Chat-like message list (scrollable area, reusing the same visual language as GuidedSetupThread)
  │   ├─ Message 1: static assistant bubble (shown after typing animation)
  │   ├─ Message 2: static assistant bubble (shown after typing animation)
  │   │   └─ Email input (inline, below the bubble)
  │   └─ Message 3: static assistant bubble (shown after link sent)
  │       └─ Resend button (inline, below the bubble)
  └─ (No ChatComposer — deliberate omission)
```

**State machine:**

```
IDLE
  → after 500ms: show message 1
  → after 2500ms: show message 2 + email input

EMAIL_ENTERED (user typed valid email and submitted)
  → SENDING_LINK (POST /auth/send-login-link in flight)
  → LINK_SENT: show message 3 + resend button
  → ERROR: inline error below email input

LINK_SENT
  → RESENDING: show resend spinner
  → back to LINK_SENT on success
  → ERROR: show error above resend button
```

**Messages (static):**

| # | Content | Timing |
|---|---------|--------|
| 1 | *"Hi! I can help you create an AI agent. Let's get you set up first."* | After 0.5s typing animation |
| 2 | *"I see you have not logged in, please provide your email address so your AI agents can communicate with you"* | After 2.5s delay from message 1 |
| 3 | *"An email has been sent to {email}. Check your inbox — the link will set you up for a new AI agent."* | After `POST /auth/send-login-link` returns ok |

This is intentionally the same generic success behavior already used by the existing login-link flow.

**Email input behavior:**
- Client-side validation: regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- Invalid → inline red error below input: *"Enter a valid email address"* (no server call)
- Valid → call `POST /auth/send-login-link` with `{ email, next: '/agents/new' }`

**Resend behavior:**
- Calls `POST /auth/send-login-link` again with same email
- Shows spinner on button while in flight
- Rate-limited by server (existing cooldown); if 429, show error *"Please wait before requesting another link"*

**Typing animation:**
- An ellipsis-style typing indicator using the same visual pattern as GuidedSetupThread (pulsing dot + label). Do not overstate component reuse if the implementation only reuses styles or markup.
- Message appears after the animation completes

**Auth redirect:** Authenticated users visiting `/try` are redirected to `/agents/new`.

**Post-auth behavior note:** This plan accepts either of these existing `/agents/new` outcomes:

- the user sees Guided Setup normally
- the user sees the existing Guided Setup billing gate
- the implementation chooses to place the user into the existing plain form instead

**Files:**
- **New:** `apps/web/src/features/try/TryPage.tsx`
- **Modify:** `apps/web/src/app/router.tsx` — add `/try` route (public, outside `RootLayout`)
- **Modify:** `apps/web/src/styles.css` — `/try`-scoped styles (reuse guided setup chat styles where possible, without page-global overrides)

### 3. Wire `next` Param Through Login-Link Flow (`apps/api/src/routes/auth.ts`)

Three changes in `auth.ts`:

**a) `POST /auth/send-login-link` — accept optional `next` param:**
- Parse `next` from request body
- Sanitize using the same pattern already used for frontend return paths elsewhere: require a single-leading-slash relative path, reject `//`, normalize via `new URL(value, frontendOrigin)`, and require same-origin result
- Pass to `createAndStoreLoginLinkToken`

**b) `createAndStoreLoginLinkToken` — include `next` in Redis payload:**
- Add optional `next?: string` parameter
- Store in JSON payload: `{ email, username?, next? }`

**c) `GET /auth/login-link/callback` — forward `next` to callback redirect:**
- After consuming the token, read `next` from payload
- Append to callback URL: `/auth/callback?code=...&next=/agents/new`
- If `next` is missing or invalid, default to `/agents` (existing behavior)
- Update `AuthCallbackPage` to apply the same stronger sanitization instead of a bare `startsWith('/')` check

**Security:** Reuse one strict relative-path sanitization rule on both the API and frontend callback path.

**Files:**
- **Modify:** `apps/api/src/routes/auth.ts` — three changes above
- **Modify:** `apps/web/src/features/auth/AuthCallbackPage.tsx` — replace the current weak `next` check with the stricter sanitizer

### 4. API Client — `sendLoginLink` with `next` Param (`apps/web/src/lib/api-client.ts`)

Add optional `next` parameter to the `auth.sendLoginLink` client function:

```ts
sendLoginLink(email: string, username?: string, next?: string): Promise<{ ok: true }>
```

Pass `next` in the request body to `POST /auth/send-login-link`.

**Files:**
- **Modify:** `apps/web/src/lib/api-client.ts`

### 5. Responsive & Mobile Improvements (`apps/web/src/styles.css`)

- Scope responsive rules to `.landing-page*` and `.try-page*` selectors; do not change `body` typography or all form controls globally
- Make landing and try layouts full-width and comfortable on mobile
- Keep input affordances visually clear within those surfaces
- Ensure the landing page background image scales responsively

**Files:**
- **Modify:** `apps/web/src/styles.css`

### 6. Tests & UAT Updates

Add focused coverage for the new and changed behavior:

- **API tests (`apps/api/src/routes/auth.test.ts`):**
  - `POST /auth/send-login-link` accepts and stores a valid `next`
  - invalid `next` values are sanitized or rejected according to the chosen route contract
  - `GET /auth/login-link/callback` forwards stored `next` to `/auth/callback`
  - missing/invalid `next` falls back to `/agents`
- **Frontend tests:**
  - `AuthCallbackPage` sanitizes `next` before navigation
  - `TryPage` reveals messages in sequence, validates email client-side, sends `next: '/agents/new'`, and handles resend/rate-limit states
  - landing-page CTA routes to `/try`
- **UAT doc update (`docs/tech/user-acceptance-tests.md`):** add or update cases for `/try`, login-link redirect-to-create-agent, and the accepted post-auth outcomes (Guided Setup, Guided Setup billing gate, or plain form fallback)

## Scope

### In Scope

- Landing page redesign with "Try it" button, background image, tagline, encouraging copy
- New `/try` page with chat-like static messages, typing animation, email input
- Client-side email format validation
- `POST /auth/send-login-link` call with `next` param
- "Check your email" message with resend button
- server-stored `next` passthrough in login-link → callback → redirect flow
- Authenticated-user redirect from `/try` to `/agents/new`
- page-scoped responsive/mobile improvements for landing and `/try`
- focused tests and UAT updates for the new flow

### Out of Scope

- Anonymous LLM calls (intentionally avoided)
- Redesigning Guided Setup billing semantics
- Changing whether Guided Setup itself uses a billing gate
- Broad global typography or form-style changes outside landing and `/try`
- Guided setup prompt fixes (non-trading fields, skill selection, scanner-gated, split greeting)
- Gmail connection fix from create/edit agent form
- Agent ranking in marketplace
- Telegram messaging fix
- Full "Chat With AI" implementation
- Inline top-up / billing in the `/try` flow

## Implementation Order

1. **[DONE]** Wire `next` param through login-link flow — use one server-stored redirect target and strict sanitization
2. **[DONE]** Auth callback sanitization update — replace the weak frontend `next` check to match the API rule
3. **[DONE]** API client update — add `next` param to `sendLoginLink`
4. **[DONE]** New `/try` page — static messages, typing animation, email input, resend
5. **[DONE]** Add `/try` route — public, outside `RootLayout`, with auth redirect
6. **[DONE]** Landing page redesign — "Try it" button linking to `/try`, background image, tagline
7. **[DONE]** Scoped responsive/mobile CSS — landing and `/try` only
8. **[IN PROGRESS]** Tests and UAT updates — cover redirect safety, `/try` flow, and post-auth outcomes
