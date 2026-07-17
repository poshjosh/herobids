# Gmail OAuth Connection for Agents

**Status:** draft
**Created:** 2026-07-17
**Depends on:** None (self-contained feature)

## Summary

Users can connect their Gmail account to the platform via OAuth, grant agents access, and agents can send and read emails on their behalf using `send_email` and `search_emails` tools, packaged as a system skill.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Gmail scope | `gmail.send` + `gmail.readonly` | Send + read inbox. Moderate permission surface. |
| Recipient control | Agent chooses any recipient | Tool-level guardrails (rate limits, allowlist) rather than hard lock to owner. |
| OAuth client | Separate Google Cloud project client | Different scopes, cleaner consent UX, no scope-mixing with login OAuth. |
| Token storage | Reuse `user_credentials` | Same AES-256-GCM encryption. `connections.credentialId` already points at it. No new table. |
| Skill packaging | System skill (`gmail`) | Curated, always-available like `base` and trading skills. |
| Token refresh | Lazy (on tool use) | No periodic sweep. Refresh token works for 6 months idle. Access token refreshed on-demand when near expiry. |
| OAuth state param | Encoded `{ userId, nonce }` in `oauth_state` cookie | Same CSRF pattern as login OAuth (`apps/api/src/routes/auth.ts`). |

## Design

### Architecture Overview

```
User clicks "Connect Gmail"
  → GET /connections/oauth/gmail/authorize
    → Redirect to Google OAuth consent (gmail.send + gmail.readonly)
      → Google redirects to GET /connections/oauth/gmail/callback?code=...
        → Exchange code for access + refresh tokens
        → Encrypt tokens → INSERT user_credentials
        → INSERT connections (credentialId → user_credentials)
        → Redirect to frontend success page

Agent calls send_email / search_emails
  → Tool resolves connection: agent_connections → connections → user_credentials
  → Decrypts OAuth tokens
  → Lazy-refreshes access token if expired
  → Calls Gmail API
```

### OAuth Flow Detail

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Browser  │     │   API    │     │  Google  │     │    DB    │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                 │
     │ GET /connections/oauth/gmail/authorize            │
     │────────────────>│                                 │
     │                 │ state = sign({userId, nonce})   │
     │ Set-Cookie: oauth_connection_state=<state>        │
     │<────────────────│                                 │
     │                 │                                 │
     │ 302 → accounts.google.com/o/oauth2/v2/auth        │
     │─────────────────────────────────>│                │
     │                                  │                │
     │   Google consent screen          │                │
     │<─────────────────────────────────│                │
     │                                  │                │
     │ 302 → /connections/oauth/gmail/callback?code=...&state=...
     │────────────────>│                                 │
     │                 │ verify state cookie             │
     │                 │ POST /token (code exchange)     │
     │                 │────────────────>│               │
     │                 │ {access_token, refresh_token,   │
     │                 │  expiry_date, scope}            │
     │                 │<────────────────│               │
     │                 │                                 │
     │                 │ BEGIN TX                        │
     │                 │ INSERT user_credentials         │
     │                 │ (encrypted tokens)              │
     │                 │─────────────────────────────>  │
     │                 │ INSERT connections              │
     │                 │ (credentialId, provider=gmail)  │
     │                 │─────────────────────────────>  │
     │                 │ COMMIT                          │
     │                 │                                 │
     │ 302 → /connections?setup=gmail&status=ok          │
     │<────────────────│                                 │
```

### Token Shape (Stored Encrypted in `user_credentials.encrypted_data`)

```json
{
  "access_token": "ya29.a0AfH6S...",
  "refresh_token": "1//0gR...",
  "expiry_date": 1699123456789,
  "scope": "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
  "token_type": "Bearer",
  "email": "user@gmail.com"
}
```

The `email` field is extracted from the token info or a follow-up `userinfo` call so the system knows which Gmail address this connection controls.

### Token Refresh (Lazy, On Tool Use)

```ts
async function getAccessToken(credentialId: string): Promise<Result<string, GmailError>> {
  const cred = await db.select().from(userCredentials).where(eq(userCredentials.id, credentialId));
  const tokens = JSON.parse(decryptCredential(cred.encryptedData, key));

  // 5-minute expiry buffer
  if (Date.now() < tokens.expiry_date - 5 * 60 * 1000) {
    return ok(tokens.access_token);
  }

  // Refresh via Google
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.gmailClientId,
      client_secret: config.gmailClientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    return err({ code: 'gmail.token_refresh_failed', message: 'Gmail connection needs re-authorization.' });
  }

  const fresh = await res.json();
  const newTokens = { ...tokens, access_token: fresh.access_token, expiry_date: Date.now() + (fresh.expires_in * 1000) };
  await db.update(userCredentials).set({ encryptedData: encryptCredential(JSON.stringify(newTokens), key), updatedAt: new Date() }).where(eq(userCredentials.id, credentialId));

  return ok(fresh.access_token);
}
```

No background sweep. If the refresh token has been revoked (6+ months idle, or user revoked in Google), the tool returns `gmail.token_refresh_failed` and the agent tells the user to reconnect.

### Connection Resolution at Runtime

```ts
// In tool execute():
const [grant] = await db
  .select({ connectionId: agentConnections.connectionId })
  .from(agentConnections)
  .where(and(eq(agentConnections.agentId, ctx.agentId), eq(agentConnections.status, 'active')))
  .innerJoin(connections, eq(connections.id, agentConnections.connectionId))
  .innerJoin(providers, eq(providers.id, connections.provider))
  .where(sql`${providers.capabilities} @> '["email"]'`)
  .innerJoin(userCredentials, eq(userCredentials.id, connections.credentialId))
  .limit(1);
```

Follows the documented pattern from `004-generalize-credentials-and-agent-connection-assignment/001-plan.md`.

---

## Phase 1: Config & Provider Registration

### 1.1 — Add Gmail OAuth Config

**File:** `config/default.yaml`

```yaml
integrations:
  gmail:
    clientId: ""                   # override: GMAIL_CLIENT_ID
    clientSecret: ""               # override: GMAIL_CLIENT_SECRET
    redirectUri: ""                # override: GMAIL_REDIRECT_URI (auto-derived if empty: {publicBaseUrl}/connections/oauth/gmail/callback)
```

**File:** `apps/api/src/config.ts` — Add `integrations.gmail` to the Zod config schema.

### 1.2 — Seed `gmail` Provider

**Migration SQL** (new file in `packages/db/drizzle/`):

```sql
INSERT INTO providers (id, name, capabilities, status, provider_type, meta)
VALUES (
  'gmail',
  'Gmail',
  '["email"]',
  'active',
  'messaging',
  '{
    "authMethod": "oauth2",
    "iconUrl": "/assets/providers/gmail.svg",
    "docsUrl": "https://developers.google.com/gmail/api",
    "oauth": {
      "authUri": "https://accounts.google.com/o/oauth2/v2/auth",
      "tokenUri": "https://oauth2.googleapis.com/token",
      "revokeUri": "https://oauth2.googleapis.com/revoke",
      "scopes": [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.readonly"
      ]
    }
  }'::jsonb
) ON CONFLICT (id) DO NOTHING;
```

### 1.3 — Add `gmail` to Provider Registry

**File:** `apps/api/src/providers/registry.ts`

Add a `gmail` entry to `PROVIDER_REGISTRY`:

```ts
{
  id: 'gmail',
  displayName: 'Gmail',
  status: 'supported',
  categories: ['messaging'],
  logoUrl: '/assets/providers/gmail.svg',
  connections: {
    description: 'Gmail account for sending and reading emails',
    requiresCredential: false,        // OAuth flow creates the credential
    allowsCredential: false,          // Users don't manually enter tokens
    autoCreatesTradingConnection: false,
  },
}
```

---

## Phase 2: OAuth Endpoints (API)

### 2.1 — OAuth CSRF State Helpers

**New file:** `apps/api/src/routes/connections-oauth-state.ts`

Reuse the pattern from `apps/api/src/routes/auth.ts`:
- `generateOAuthState(userId, secret)` → HMAC-signed state token
- `verifyOAuthState(state, cookieValue, secret)` → boolean

Dedicated cookie name: `oauth_connection_state` (distinct from login `oauth_state`).

### 2.2 — `GET /connections/oauth/gmail/authorize`

**New file:** `apps/api/src/routes/connections-oauth.ts`

1. Require authenticated user (JWT)
2. Check plan limits (`maxConnections`, `maxCredentials`)
3. Generate state token encoding `{ userId, nonce }`
4. Set `oauth_connection_state` cookie (HttpOnly, SameSite=Lax, Path=/connections/oauth/gmail/callback, Max-Age=600)
5. Redirect to `https://accounts.google.com/o/oauth2/v2/auth` with:
   - `client_id`: from `config.integrations.gmail.clientId`
   - `redirect_uri`: `{publicBaseUrl}/connections/oauth/gmail/callback`
   - `response_type`: `code`
   - `scope`: `https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly`
   - `access_type`: `offline` (required for refresh token)
   - `prompt`: `consent` (force re-consent to ensure refresh token is always issued)
   - `state`: the signed state token

### 2.3 — `GET /connections/oauth/gmail/callback`

**File:** `apps/api/src/routes/connections-oauth.ts`

1. Extract `code` and `state` from query params
2. Verify CSRF state via `oauth_connection_state` cookie
3. Exchange `code` for tokens (`POST https://oauth2.googleapis.com/token`)
4. Fetch user email (`GET https://www.googleapis.com/oauth2/v3/userinfo` or from ID token)
5. Encrypt token JSON blob with `encryptCredential()` → `user_credentials` row
6. Create `connections` row:
   - `credentialId` → the new credential
   - `provider` → `gmail`
   - `label` → `{email}` (e.g. `user@gmail.com`)
   - `profile` → `{ email: "user@gmail.com" }`
7. Redirect to frontend: `{frontendOrigin}/connections?setup=gmail&status=ok`

### 2.4 — Connection Limit Check

Reuse existing plan guards (`checkConnectionLimit`, `checkCredentialLimit`) from `apps/api/src/plan-guards.ts`. These already gate `POST /setup/provider-link` and `POST /connections`.

---

## Phase 3: Gmail API Adapter (Worker)

### 3.1 — Gmail Adapter

**New file:** `apps/worker/src/gmail-adapter.ts`

Thin wrapper over Gmail REST API. No SDK dependency — standard library `fetch`.

```ts
export interface GmailAdapterDeps {
  accessToken: string;
  timeoutMs?: number;
}

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  contentType?: 'text/plain' | 'text/html';
}

export interface SearchEmailsParams {
  query: string;       // Gmail search query syntax
  maxResults?: number; // default 20, max 50
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
}

export function createGmailAdapter(deps: GmailAdapterDeps) {
  return {
    async sendEmail(params: SendEmailParams): Promise<{ messageId: string; threadId: string }> {
      // Build RFC 2822 message, base64url encode
      // POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
    },

    async searchEmails(params: SearchEmailsParams): Promise<EmailSummary[]> {
      // GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q={query}&maxResults={n}
      // Then batch-fetch message details (GET .../messages/{id}?format=metadata)
    },
  };
}
```

The Gmail `messages.send` endpoint requires the raw email as a base64url-encoded RFC 2822 message. The adapter constructs this from the params — no external MIME library needed for basic text emails. HTML support can be added later by wrapping in `<html><body>...</body></html>`.

### 3.2 — Credential Resolution + Lazy Refresh

**New file:** `apps/worker/src/gmail-credential-resolver.ts`

```ts
export async function resolveGmailTokens(
  db: Database,
  agentId: string,
  config: GmailConfig,
): Promise<Result<{ accessToken: string; email: string; credentialId: string }, GmailError>> {
  // 1. Find active agent_connection → connection → credential for provider=gmail
  // 2. Decrypt credential
  // 3. If access token near expiry → refresh, re-encrypt, update DB
  // 4. Return { accessToken, email, credentialId }
}
```

---

## Phase 4: Agent Tools (Worker)

### 4.1 — `send_email` Tool

**New file:** `apps/worker/src/tools/email.ts` (or add to `messaging.ts`)

```ts
const SendEmailParamsSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(10)]),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  cc: z.union([z.string().email(), z.array(z.string().email()).max(10)]).optional(),
  bcc: z.union([z.string().email(), z.array(z.string().email()).max(10)]).optional(),
});

// Execute:
// 1. resolveGmailTokens()
// 2. createGmailAdapter({ accessToken })
// 3. adapter.sendEmail(params)
```

**Rate limit:** Enforce per-agent send cap (operator-configurable, e.g. 50 emails/day per agent). Store counter in Redis with daily TTL.

**Recipient guardrail:** Optionally check against an agent-level `emailRecipientAllowlist` JSONB field on `agents`. Empty/null = any recipient allowed. This gives users a knob to lock down their agent.

### 4.2 — `search_emails` Tool

```ts
const SearchEmailsParamsSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(50).default(20),
});

// Returns EmailSummary[]
```

---

## Phase 5: System Skill Definition

### 5.1 — `gmail` Skill

**File:** `packages/domain/src/skills.ts`

```ts
export const GMAIL_SKILL: SkillDefinition = {
  id: 'gmail',
  name: 'Gmail',
  description: 'Send and read emails via Gmail on behalf of the user.',
  instructions: `You can manage the user's Gmail inbox.

- Use \`send_email(to, subject, body)\` to send emails. You may include cc and bcc recipients.
- Use \`search_emails(query)\` to find and read emails from the inbox using Gmail search syntax.
- Before sending to unfamiliar recipients, confirm with the user via \`send_message\`.
- Respect the user's privacy — only search for emails relevant to the task at hand.`,
  promptHint: 'e.g. "Monitor my inbox for flight booking confirmations and alert me" or "Send a weekly summary email to my team"',
  requiredTools: ['send_email', 'search_emails'],
  capabilityFamilies: ['email'],
  bindingRequirements: {
    email: { minBindings: 1, requireReady: true },
  },
  contextRequirements: [],
  requiredContextBlocks: [],
  promptRendererHints: [],
  requiredGuardrails: [],
  suggestedTickIntervalMs: 300_000, // 5 min — email is not real-time
  visibility: 'public',
};
```

Add to `SYSTEM_SKILLS` array so it's upserted on API startup.

### 5.2 — Add `gmail` to the `personal-assistant` Skill Preset

**File:** `packages/domain/src/skills.ts`

Email is a natural companion to personal assistant work — sending reminders via email, emailing people the agent has researched, monitoring inbox for actionable items. The `gmail` skill stays a separate, independently versioned skill, but is included in the `personal-assistant` preset so any personal-assistant agent automatically gets email capability alongside task management and web access:

```ts
export const SKILL_PRESET_MAP: Record<string, string[]> = {
  trading: ['bot-management', 'trading'],
  'direct-trading': ['trading'],
  'personal-assistant': ['task-management', 'web-access', 'gmail'],  // ← add gmail
  custom: [],
};
```

Users can also add `gmail` as a standalone skill to any agent (e.g. trading agents who want to send trade alerts via email) without being tied to the personal-assistant preset.

---

## Phase 6: Frontend

### 6.1 — Gmail Provider Card in Mission Control

**File:** `apps/web/src/features/setup/provider-setup-form.tsx`

The existing provider setup form already renders from the provider registry. Adding `gmail` to the registry (Phase 1.3) automatically surfaces it. Two adjustments needed:

1. **OAuth providers render a "Connect" button instead of credential fields.** The form checks `provider.connections.allowsCredential` — when `false` for a provider, render an OAuth initiation button instead of manual fields.

2. **The button triggers** `window.location.href = '/api/connections/oauth/gmail/authorize'` (or uses the API client, which handles auth headers).

### 6.2 — OAuth Callback Handling

The callback redirects to `{frontendOrigin}/connections?setup=gmail&status=ok`. The `ConnectionsPage` already handles query params for setup flows. Add handling for `setup=gmail` to show a success toast.

### 6.3 — Gmail Connection in Agent Create/Edit

The connection picker already lists all user connections. Gmail connections (provider: `gmail`) appear alongside trading connections. The agent create/edit flow accepts `connectionIds` — a Gmail connection can be assigned like any other.

### 6.4 — Auto-Select Matching Connection When Skill Is Picked

**Files:** `apps/web/src/features/agents/EditAgentModal.tsx` + `apps/web/src/features/agents/AgentsPage.tsx` (create flow)

When the user selects a skill and no connection has been selected yet, auto-select a matching connection to reduce friction:

| Skill selected | Auto-select rule |
|---|---|
| `gmail` | First active Gmail connection (provider = `gmail`), even if multiple exist |
| `trading` or `bot-management` | Auto-select only if the user has **exactly one** active trading-capable connection (provider with `capabilities` including `"trading"`) |

If the user already has one or more connections selected, do nothing — don't override their explicit choice.

**Implementation:** The frontend already has access to all needed data — skill definitions via `listSelectableSkills()`, provider registry via `GET /providers`, and user connections via `GET /connections`. The chain is:

```
selected skill → capabilityFamilies → providers with those capabilities → user's matching connections
```

The auto-select runs as a side effect when `selectedSkillIds` changes, before the form is submitted. It's a pure client-side convenience — the API's `POST /agents` validation is the authoritative gate.

### 6.5 — Gmail Connection Detail View

Show in the connection list:
- Provider icon (Gmail logo)
- Label = Gmail address (`user@gmail.com`)
- Status indicator (active/revoked)
- "Reconnect" button if token is expired/revoked (triggers re-auth flow)

---

## Phase 7: Tests

### 7.1 — Unit Tests

| Test | File |
|---|---|
| CSRF state generation & verification | `apps/api/src/routes/connections-oauth-state.test.ts` |
| Token encryption round-trip for OAuth shape | `apps/api/src/crypto.test.ts` (extend) |
| Gmail adapter: builds valid RFC 2822 message | `apps/worker/src/gmail-adapter.test.ts` |
| Gmail adapter: search query encoding | `apps/worker/src/gmail-adapter.test.ts` |
| Lazy token refresh: fresh token returned as-is | `apps/worker/src/gmail-credential-resolver.test.ts` |
| Lazy token refresh: expired token refreshed | `apps/worker/src/gmail-credential-resolver.test.ts` |
| Lazy token refresh: revoked token → error | `apps/worker/src/gmail-credential-resolver.test.ts` |
| `send_email` tool: resolves connection, calls adapter | `apps/worker/src/tools/email.test.ts` |
| `send_email` tool: no email connection → error | `apps/worker/src/tools/email.test.ts` |
| `search_emails` tool: resolves connection, calls adapter | `apps/worker/src/tools/email.test.ts` |

### 7.2 — Integration Tests

| Test | File |
|---|---|
| `POST /connections/oauth/gmail/authorize` redirects to Google with correct params | `apps/api/src/routes/connections-oauth.integration.test.ts` |
| `GET /connections/oauth/gmail/callback` with valid code → creates credential + connection | `apps/api/src/routes/connections-oauth.integration.test.ts` |
| `GET /connections/oauth/gmail/callback` with invalid state → 400 | `apps/api/src/routes/connections-oauth.integration.test.ts` |
| Plan limit enforcement on OAuth connection creation | `apps/api/src/routes/connections-oauth.integration.test.ts` |
| Connection appears in provider catalog | `apps/api/src/providers/registry.test.ts` |

### 7.3 — E2E Tests

| Test | File |
|---|---|
| Gmail provider card visible in Mission Control | `tests/e2e/journeys/` (extend setup journey) |
| Agent create flow with Gmail connection in picker | `tests/e2e/journeys/` |
| Gmail skill selectable in agent skill picker | `tests/e2e/journeys/` |

---

## Files to Create

| File | Purpose |
|---|---|
| `apps/api/src/routes/connections-oauth-state.ts` | CSRF state helpers for OAuth connections |
| `apps/api/src/routes/connections-oauth.ts` | `authorize` + `callback` endpoints |
| `apps/worker/src/gmail-adapter.ts` | Thin Gmail REST API wrapper |
| `apps/worker/src/gmail-credential-resolver.ts` | Connection → credential → token resolution + lazy refresh |
| `apps/worker/src/tools/email.ts` | `send_email` + `search_emails` tool definitions |
| `packages/db/drizzle/XXXX_gmail_provider.sql` | Migration: seed `gmail` provider |

## Files to Modify

| File | Change |
|---|---|
| `config/default.yaml` | Add `integrations.gmail` block |
| `apps/api/src/config.ts` | Add `integrations.gmail` to Zod schema |
| `apps/api/src/providers/registry.ts` | Add `gmail` entry |
| `apps/api/src/routes/connections.ts` | No changes needed — OAuth endpoints are separate |
| `apps/worker/src/index.ts` | Register `emailTools` in tool registry |
| `packages/domain/src/skills.ts` | Add `GMAIL_SKILL` to `SYSTEM_SKILLS`; add `'gmail'` to `personal-assistant` preset in `SKILL_PRESET_MAP` |
| `apps/web/src/features/agents/agent-display.ts` | Add `'gmail'` to `SKILL_PRESET_SKILL_IDS['personal-assistant']` |
| `apps/web/src/features/agents/EditAgentModal.tsx` | Add `'gmail'` to `ASSISTANT_SKILL_IDS`; add auto-select logic for Gmail/trading connections |
| `apps/web/src/features/agents/AgentsPage.tsx` | Add auto-select logic for Gmail/trading connections in create flow |
| `apps/web/src/features/connections/ConnectionsPage.tsx` | Handle `setup=gmail` success param |
| `apps/web/src/features/setup/provider-setup-form.tsx` | OAuth button for non-credential providers |
| `apps/web/src/lib/api-client.ts` | Add `connections.oauth` methods if needed |

## Config Changes (Operator)

```yaml
# config/default.yaml
integrations:
  gmail:
    clientId: ""       # from Google Cloud Console → APIs & Services → Credentials
    clientSecret: ""   # from Google Cloud Console
    redirectUri: ""    # auto-derived: {publicBaseUrl}/connections/oauth/gmail/callback
```

```bash
# .env overrides
GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-xxx
```

The Google Cloud project must have the Gmail API enabled and the OAuth consent screen configured with scopes `gmail.send` and `gmail.readonly`. The authorized redirect URI must match `{publicBaseUrl}/connections/oauth/gmail/callback`.

## Caddy Routing

The `/connections/oauth/*` path must be routed to the API container (same as `/auth/*`):

```
# In Caddyfile.prod / Caddyfile.staging
handle /connections/oauth/* {
  reverse_proxy api:3000
}
```

## Risks & Open Questions

1. **Google OAuth verification:** If the app requests sensitive scopes (`gmail.send`, `gmail.readonly`), Google may require app verification unless the user count is below the unpublished threshold (~100 users). Plan: start with test users, apply for verification before broad rollout.

2. **Refresh token revocation after 6 months idle:** Covered — lazy refresh returns `gmail.token_refresh_failed`, agent prompts user to reconnect.

3. **Multiple Gmail connections per agent:** The design allows it. The tool would use the first active Gmail connection found. A future enhancement could let the agent choose which connection to use.

4. **`search_emails` privacy:** Agents can read all inbox content matching the query. The prompt instructions and recipient guardrails are behavioral, not cryptographic. For high-security use cases, a `gmail.readonly` scope limiting (labels-only) could be offered as a restricted variant.

5. **Rate limit on Gmail API:** Gmail's API has a per-user quota (~1,000,000 units/day for free Gmail, where `messages.send` costs 100 units). 10,000 emails/day is the effective ceiling. Our per-agent rate limit (default 50/day) is well within this.
