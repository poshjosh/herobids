# Phase 5c: Integration Tests — Auth

## Why this is needed

The current auth tests mock the DB as chained `vi.fn()` calls. Two code paths
are entirely untested in any form:
1. The JWT-issue → DB-verify round-trip (the `onRequest` hook path that reads
   `sessions` and `users` tables)
2. The Google OAuth callback (the `findOrCreateUser` transaction, the session
   insert, the duplicate-sub re-login path)

These tests close both gaps using a real Postgres database and a real Fastify
instance. Only external Google API calls remain mocked.

## Scope

Two new test files. Both reuse the shared `integration-db.ts` helper from the
5b plan.

---

## Test 1 — `apps/api/src/plugins/auth.integration.test.ts`

**Purpose:** Verify the `onRequest` hook resolves `userId`/`userPlanId` from
real DB rows, and that all session-validity checks (revoked, expired, missing)
reject with 401.

**Skip condition:** `!process.env['DATABASE_URL']`

**Setup / teardown:**
- `beforeAll`: `runMigrations`; register a Fastify app with `authPlugin` and a
  single GET `/protected` route that returns `{ userId: request.userId, planId: request.userPlanId }`
- `beforeEach`: `TRUNCATE users, sessions CASCADE` (user_plans too if present)
- `afterAll`: close client; call `app.close()`

**Shared fixture helpers:**
```ts
async function seedUser(db, id = 'u-1') {
  await db.insert(users).values({ id, displayName: 'Test', email: `${id}@test.com`, planId: 'free' });
  return id;
}

async function seedSession(db, userId: string, opts?: { revokedAt?: Date; expiresAt?: Date }) {
  const id = crypto.randomUUID();
  await db.insert(sessions).values({
    id, userId,
    expiresAt: opts?.expiresAt ?? new Date(Date.now() + 86_400_000),
    revokedAt: opts?.revokedAt ?? null,
  });
  return id;
}
```

**Tests (in order):**

1. `valid JWT with active session → 200 with userId and planId`
   - Seed user + active session
   - Issue JWT via `createSessionToken(config, userId, sessionId)`
   - `app.inject({ url: '/protected', headers: { Authorization: 'Bearer ...' } })`
   - Status 200; body `{ userId, planId: 'free' }`

2. `valid JWT but session is revoked → 401`
   - Seed session with `revokedAt: new Date()`
   - Issue matching JWT; inject → 401

3. `valid JWT but session is expired → 401`
   - Seed session with `expiresAt: new Date(Date.now() - 1000)` (in the past)
   - Issue matching JWT; inject → 401

4. `valid JWT but session row does not exist → 401`
   - Issue a JWT for a `sessionId` never written to the DB
   - inject → 401

5. `missing Authorization header → 401`
   - inject with no headers → 401

6. `malformed Bearer token → 401`
   - `Authorization: Bearer not-a-jwt` → 401

7. `OPTIONS request bypasses auth (CORS preflight)`
   - inject `{ method: 'OPTIONS', url: '/protected' }` without any token
   - should NOT return 401 (auth plugin exempts OPTIONS)

**Key assertion for test 1:** `request.userPlanId` must equal the value stored
in `users.plan_id` — confirms the second DB query (users lookup) also works.

---

## Test 2 — `apps/api/src/routes/auth-oauth.integration.test.ts`

**Purpose:** Verify the Google OAuth callback writes the correct rows to
`users`, `oauth_identities`, and `sessions`, and that re-login with the same
Google `sub` reuses the existing user.

**Skip condition:** `!process.env['DATABASE_URL']`

The external Google API calls (`/token` and `/userinfo`) are intercepted via
`vi.stubGlobal('fetch', ...)` before each test. All DB interaction is real.

**Setup / teardown:**
- `beforeAll`: `runMigrations`; build a Fastify app, register `authPlugin`,
  register `authRoutes`
- `beforeEach`: `TRUNCATE users, oauth_identities, sessions CASCADE`; reset
  fetch stub
- `afterAll`: close client + app

**Fetch mock helper:**
```ts
function mockGoogleFetch(opts: {
  tokenOk?: boolean;
  userInfo?: Partial<GoogleUserInfo>;
} = {}) {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({              // /token endpoint
      ok: opts.tokenOk ?? true,
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
    })
    .mockResolvedValueOnce({             // /userinfo endpoint
      ok: true,
      json: vi.fn().mockResolvedValue({
        sub: 'google-sub-1',
        email: 'alice@example.com',
        email_verified: true,
        name: 'Alice',
        ...opts.userInfo,
      }),
    }),
  );
}
```

The CSRF state cookie must be crafted correctly. Approach: call
`GET /auth/google` first (inject), capture the `Set-Cookie` header, then use
that state value in the callback request. This avoids re-implementing
`generateOAuthState` in the test.

**Tests (in order):**

1. `first login creates user, oauth_identity, and session; returns JWT`
   - `GET /auth/google` → capture `oauth_state` cookie and extract state from
     the redirect query string
   - `GET /auth/google/callback?code=abc&state=<state>` with matching cookie
   - Response: 302 redirect (or 200 JSON with `{ token }`) — check actual
     route shape
   - `users` table has 1 row with email `alice@example.com`
   - `oauth_identities` has 1 row with `provider='google'`, `providerUserId='google-sub-1'`
   - `sessions` has 1 row

2. `second login with same Google sub reuses user, creates new session`
   - Run the full callback flow twice with the same mock Google `sub`
   - After two logins: `users` count = 1, `oauth_identities` count = 1,
     `sessions` count = 2

3. `CSRF state mismatch → 400`
   - Send callback with `state=tampered` and cookie `oauth_state=different`
   - 400 `{ error: 'Invalid or missing OAuth state parameter' }`

4. `missing code → 400`
   - Valid state cookie; callback URL has no `code` param
   - 400 `{ error: 'Missing authorization code' }`

5. `email_verified: false → 401`
   - mockGoogleFetch with `userInfo: { email_verified: false }`
   - Valid state; 401 `{ error: 'Email address not verified by Google' }`

6. `Google token exchange fails (non-200) → 502`
   - mockGoogleFetch with `tokenOk: false`
   - Valid state; 502

**Note on CSRF helper:** the safest implementation-independent approach for
extracting state in tests 1–5 is to call `GET /auth/google`, parse the
`Set-Cookie` header to get `oauth_state=<value>`, and then pass that same value
as both the query param and the cookie. This works because `generateOAuthState`
embeds a valid HMAC signature in the value — no need to recompute it.

---

## Dependency between test files

Test 2 depends on no schema not already in Test 1. Both can run independently.
Run order within a test suite does not matter because each `beforeEach` truncates
tables.

---

## vitest config

No change to `vitest.config.ts`. The `skipIf` gate handles CI automatically.

For a dedicated integration run:

```bash
DATABASE_URL=postgres://herobids:herobids@localhost:5432/herobids \
  pnpm vitest run --reporter=verbose packages/db packages/api
```

---

## Risk and open questions

- **Callback response shape**: the current `authRoutes` code issues a redirect
  after OAuth success (check the route handler end — if it does
  `reply.redirect(...)` with the JWT in a query param, the test should check
  `res.statusCode === 302` and parse the location header). Verify exact shape
  before implementing test 1's final assertions.
- **`findOrCreateUser` onConflictDoNothing + re-read**: the upsert pattern
  requires two DB round-trips on a new user. Test 2's "second login" case
  confirms the re-read path works and returns the same `userId`.
- **user_plans table**: some routes use `user_plans` for plan lookups. If
  `auth.integration.test.ts` truncates it, auth plugin test 1 may break when
  looking up `planId`. Use `users.planId` column (which is `notNull().default('free')`)
  rather than a joined `user_plans` query — check that auth plugin reads from
  `users.plan_id` directly (it does, confirmed in `auth.ts`: `users.planId`
  column).
