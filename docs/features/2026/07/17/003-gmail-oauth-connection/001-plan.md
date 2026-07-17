# Gmail OAuth Connection for Agents

**Status:** implemented
**Created:** 2026-07-17
**Implemented:** 2026-07-17
**Depends on:** None (self-contained feature)

> **Update (2026-07-17):** Superseded in part by [006-remove-unused-provider-table-and-gmail-readonly-scope](../006-remove-unused-provider-table-and-gmail-readonly-scope/001-plan.md). Gmail is now **send-only** — the `gmail.readonly` scope and the `search_emails` tool described below have been removed to avoid the Google scope-verification review burden. Inbox-read support returns only when scope verification is approved and the tool is intentionally re-enabled. The rest of this document (OAuth flow, token storage, connection model) still reflects the current implementation.

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
| OAuth state param | Encoded `{ userId, nonce }` in `oauth_connection_state` cookie | Same HMAC/CSRF pattern as login OAuth, but callback must also verify the authenticated user matches the state payload. |
| Connection surface | Gmail is a first-class generic connection in create/edit flows now | `connectionIds` are already generic on agents; the UI must stop treating connections as trading-only. |
| Connection selection | Frontend may auto-select the first active Gmail connection only when the form has no selection | Pure UX convenience. Runtime uses the same assigned/default connection model as every other capability family. |
| Setup UX | Reuse the same setup modal and flow used by other providers | Generalize the existing setup form to support OAuth redirect providers alongside manual-secret providers. |
| Config ownership | Gmail config lives in shared `AppConfig` plus both API and worker env loaders | OAuth authorize runs in the API, but token refresh runs in the worker. |

## Design

### Architecture Overview

```
User clicks "Connect Gmail"
  → GET /connections/oauth/gmail/authorize
    → Redirect to Google OAuth consent (gmail.send + gmail.readonly)
      → Google redirects to GET /connections/oauth/gmail/callback?code=...
        → Verify authenticated user + signed state payload
        → Exchange code for access + refresh tokens
        → In one TX: advisory lock + plan checks + INSERT user_credentials + INSERT connections
        → Redirect to frontend success page

Agent calls send_email / search_emails
  → Tool resolves the agent's default/assigned email connection: agent_connections → connections → user_credentials
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
    │                 │ verify state cookie + auth user │
     │                 │ POST /token (code exchange)     │
     │                 │────────────────>│               │
     │                 │ {access_token, refresh_token,   │
     │                 │  expiry_date, scope}            │
     │                 │<────────────────│               │
     │                 │                                 │
    │                 │ BEGIN TX                        │
    │                 │ advisory lock + plan checks     │
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
  const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.id, credentialId));
  const tokens = JSON.parse(decryptCredential(cred.encryptedData, key));

  // 5-minute expiry buffer
  if (Date.now() < tokens.expiry_date - 5 * 60 * 1000) {
    return ok(tokens.access_token);
  }

  // Refresh via Google
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.integrations.gmail.clientId,
      client_secret: config.integrations.gmail.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    return err({ code: 'gmail.token_refresh_failed', message: 'Gmail connection needs re-authorization.' });
  }

  const fresh = await res.json();
  const newTokens = { ...tokens, access_token: fresh.access_token, expiry_date: Date.now() + (fresh.expires_in * 1000) };
  const { encryptedData, encryptionMeta } = encryptCredential(JSON.stringify(newTokens), key);
  await db.update(userCredentials).set({ encryptedData, encryptionMeta, updatedAt: new Date() }).where(eq(userCredentials.id, credentialId));

  return ok(fresh.access_token);
}
```

No background sweep. If the refresh token has been revoked (6+ months idle, or user revoked in Google), the tool returns `gmail.token_refresh_failed` and the agent tells the user to reconnect.

### Connection Resolution at Runtime

```ts
// In tool execute():
const connectionId = await resolveDefaultFamilyConnectionId(db, ctx.agentId, 'email');
if (!connectionId) {
  return err({ code: 'connection.missing', message: 'No email connection is assigned to this agent.' });
}

const [connection] = await db
  .select({
    credentialId: connections.credentialId,
    email: sql<string>`${connections.profile} ->> 'email'`,
  })
  .from(agentConnections)
  .innerJoin(connections, eq(connections.id, agentConnections.connectionId))
  .innerJoin(providers, eq(providers.id, connections.provider))
  .innerJoin(userCredentials, eq(userCredentials.id, connections.credentialId))
  .where(and(
    eq(agentConnections.agentId, ctx.agentId),
    eq(agentConnections.connectionId, connectionId),
    eq(agentConnections.status, 'active'),
    sql`${providers.capabilities} @> '["email"]'`,
  ))
  .limit(1);
```

This follows the documented connection-assignment model: frontend convenience may preselect a Gmail connection, but runtime does not implement any Gmail-specific "first row wins" rule.

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

**Files:**
- `packages/domain/src/config/schema.ts` — Add `integrations.gmail` to the shared `AppConfig` schema.
- `apps/api/src/config.ts` — Add env overrides for `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI`.
- `apps/worker/src/config.ts` — Add the same env overrides so the worker can refresh tokens using the resolved config.

The Gmail config is shared application config, not API-local schema.

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
2. Generate state token encoding `{ userId, nonce }`
3. Set `oauth_connection_state` cookie (HttpOnly, SameSite=Lax, Path=/connections/oauth/gmail/callback, Max-Age=600)
4. Redirect to `https://accounts.google.com/o/oauth2/v2/auth` with:
   - `client_id`: from `config.integrations.gmail.clientId`
   - `redirect_uri`: `{publicBaseUrl}/connections/oauth/gmail/callback`
   - `response_type`: `code`
   - `scope`: `https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly`
   - `access_type`: `offline` (required for refresh token)
   - `prompt`: `consent` (force re-consent to ensure refresh token is always issued)
   - `state`: the signed state token

### 2.3 — `GET /connections/oauth/gmail/callback`

**File:** `apps/api/src/routes/connections-oauth.ts`

1. Require authenticated user on the callback as well
2. Extract `code` and `state` from query params
3. Verify CSRF state via `oauth_connection_state` cookie
4. Verify `request.userId === state.userId` before writing anything
5. Exchange `code` for tokens (`POST https://oauth2.googleapis.com/token`)
6. Fetch user email (`GET https://www.googleapis.com/oauth2/v3/userinfo` or from ID token)
7. In one DB transaction:
  - acquire a per-user advisory lock
  - run `checkCredentialLimit()` and `checkConnectionLimit()`
  - encrypt token JSON blob with `encryptCredential()` and insert the `user_credentials` row
  - create the `connections` row:
    - `credentialId` → the new credential
    - `provider` → `gmail`
    - `label` → `{email}` (e.g. `user@gmail.com`)
    - `profile` → `{ email: "user@gmail.com" }`
8. Redirect to frontend: `{frontendOrigin}/connections?setup=gmail&status=ok`

### 2.4 — Authoritative Limit Enforcement at Callback

Reuse existing plan guards (`checkConnectionLimit`, `checkCredentialLimit`) from `apps/api/src/plan-guards.ts`, but enforce them inside the callback transaction using the same advisory-lock pattern as `POST /setup/provider-link`.

`GET /connections/oauth/gmail/authorize` may do a best-effort preflight later for UX, but the callback transaction is the only authoritative gate.

### 2.5 — Generic Agent Connection Read Endpoint

**File:** `apps/api/src/routes/agents.ts`

Add `GET /agents/:id/connections` returning the agent's assigned connections across all providers, not just trading-capable ones.

This endpoint is required for Gmail to be a first-class generic connection in the edit flow. The current trading-only capability endpoint is insufficient for non-trading providers.

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
  config: AppConfig['integrations']['gmail'],
): Promise<Result<{ accessToken: string; email: string; credentialId: string }, GmailError>> {
  // 1. Resolve the assigned/default email connection for this agent
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

### 4.3 — Tool Catalog & Registry Wiring

**Files:** `packages/domain/src/tools.ts` + `apps/worker/src/tools/index.ts`

Add `send_email` and `search_emails` to the shared tool catalog and known tool-name list, then register the concrete tool implementations in `apps/worker/src/tools/index.ts`.

Do not wire these only in `apps/worker/src/index.ts`. Built-in skill validation and registry/catalog consistency checks must pass at startup.

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

**File:** `apps/web/src/features/setup/ProviderSetupForm.tsx`

Reuse the existing setup modal and success/assignment flow for Gmail. Do not introduce a Gmail-only setup screen. The existing component must be generalized so the same UX works for both manual-secret providers and OAuth redirect providers.

Required adjustments:

1. Stop filtering setup options to providers that have credential fields. Gmail has connection support but no manual credential form.
2. For OAuth providers, keep the same modal shell, provider selection, and post-success assignment flow, but render a "Connect" CTA instead of secret-entry fields.
3. Trigger `/connections/oauth/gmail/authorize` from the shared setup component rather than routing the user to a dedicated Gmail page.

### 6.2 — OAuth Callback Handling

The callback redirects to `{frontendOrigin}/connections?setup=gmail&status=ok`. `ConnectionsPage` does not currently handle query-param-driven setup success, so add explicit handling for `setup=gmail&status=ok`, show the existing success treatment, and clear the query params after consumption.

### 6.3 — Gmail Connection in Agent Create/Edit

Gmail must be a first-class generic connection in agent create/edit now. That requires switching the connection picker away from trading-only data sources:

1. **Create flow:** load active connections from `GET /connections`, not only from `GET /capabilities/trading/connections`.
2. **Edit flow:** load the agent's current assigned connections from `GET /agents/:id/connections` plus the user's active connections from `GET /connections`.
3. Preserve trading-specific readiness UI separately; do not use trading-only endpoints as the source of truth for generic connection assignment.

### 6.4 — Auto-Select Matching Connection When Skill Is Picked

**Files:** `apps/web/src/features/agents/EditAgentModal.tsx` + `apps/web/src/features/agents/AgentsPage.tsx` (create flow)

When the user selects a skill and no connection has been selected yet, auto-select a matching connection to reduce friction:

| Skill selected | Auto-select rule |
|---|---|
| `gmail` | If no connection is selected yet, preselect the first active Gmail connection as a frontend convenience |
| `trading` or `bot-management` | Auto-select only if the user has **exactly one** active trading-capable connection (provider with `capabilities` including `"trading"`) |

If the user already has one or more connections selected, do nothing — don't override their explicit choice.

**Implementation:** The frontend already has access to all needed data once it switches to generic connection queries — skill definitions via `listSelectableSkills()`, provider registry via `GET /providers/catalog`, and user connections via `GET /connections`. The chain is:

```
selected skill → capabilityFamilies → providers with those capabilities → user's matching connections
```

The auto-select runs as a side effect when `selectedSkillIds` changes, before the form is submitted. It's a pure client-side convenience — it must not create a Gmail-specific runtime selection rule.

### 6.5 — Gmail Connection Detail View

Show in the connection list:
- Provider icon (Gmail logo)
- Label = Gmail address (`user@gmail.com`)
- Status indicator (active/revoked)
- "Reconnect" button if token is expired/revoked (triggers re-auth flow)

This stays inside the same shared Connections UI as every other provider.

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
| `GET /connections/oauth/gmail/callback` with mismatched authenticated user vs state payload → 403/400 | `apps/api/src/routes/connections-oauth.integration.test.ts` |
| Plan limit enforcement occurs inside the callback transaction | `apps/api/src/routes/connections-oauth.integration.test.ts` |
| `GET /agents/:id/connections` returns generic assigned connections | `apps/api/src/routes/agents.test.ts` |
| Connection appears in provider catalog | `apps/api/src/providers/registry.test.ts` |

### 7.3 — E2E Tests

| Test | File |
|---|---|
| Gmail provider is visible in the shared setup modal and launches OAuth from the shared flow | `tests/e2e/journeys/` |
| Agent create/edit flows show Gmail in the generic connection picker | `tests/e2e/journeys/` |
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
| `packages/domain/src/config/schema.ts` | Add `integrations.gmail` to the shared `AppConfig` schema |
| `apps/api/src/config.ts` | Add Gmail env overrides |
| `apps/worker/src/config.ts` | Add Gmail env overrides |
| `apps/api/src/providers/registry.ts` | Add `gmail` entry |
| `apps/api/src/routes/agents.ts` | Add `GET /agents/:id/connections` for generic assigned-connection reads |
| `packages/domain/src/tools.ts` | Add `send_email` and `search_emails` to the tool catalog |
| `apps/worker/src/tools/index.ts` | Register `emailTools` in the tool registry |
| `packages/domain/src/skills.ts` | Add `GMAIL_SKILL` to `SYSTEM_SKILLS`; add `'gmail'` to `personal-assistant` preset in `SKILL_PRESET_MAP` |
| `apps/web/src/features/agents/agent-display.ts` | Add `'gmail'` to `SKILL_PRESET_SKILL_IDS['personal-assistant']` |
| `apps/web/src/features/agents/EditAgentModal.tsx` | Switch to generic agent/user connection queries and add frontend-only Gmail/trading auto-select logic |
| `apps/web/src/features/agents/AgentsPage.tsx` | Switch to generic user connection queries and add frontend-only Gmail/trading auto-select logic |
| `apps/web/src/features/connections/ConnectionsPage.tsx` | Handle `setup=gmail` success param |
| `apps/web/src/features/setup/ProviderSetupForm.tsx` | Generalize the shared setup modal for OAuth providers |
| `apps/web/src/lib/api-client.ts` | Add Gmail OAuth methods and generic agent-connections read method |

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
GMAIL_REDIRECT_URI=https://your-api.example.com/connections/oauth/gmail/callback
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

## Risks

1. **Google OAuth verification:** If the app requests sensitive scopes (`gmail.send`, `gmail.readonly`), Google may require app verification unless the user count is below the unpublished threshold (~100 users). Plan: start with test users, apply for verification before broad rollout.

2. **Refresh token revocation after 6 months idle:** Covered — lazy refresh returns `gmail.token_refresh_failed`, agent prompts user to reconnect.

3. **Generic connection UI refactor:** The current create/edit flows still read trading-only connection endpoints in places. Gmail being first-class now means the picker data sources must become provider-agnostic without regressing trading readiness UX.

4. **`search_emails` privacy:** Agents can read all inbox content matching the query. The prompt instructions and recipient guardrails are behavioral, not cryptographic. For high-security use cases, a `gmail.readonly` scope limiting (labels-only) could be offered as a restricted variant.

5. **Rate limit on Gmail API:** Gmail's API has a per-user quota (~1,000,000 units/day for free Gmail, where `messages.send` costs 100 units). 10,000 emails/day is the effective ceiling. Our per-agent rate limit (default 50/day) is well within this.

6. **Shared setup flow generalization:** The existing setup modal is optimized for manual-secret providers. Reusing the same UX is correct, but the component needs careful refactoring so OAuth providers do not disappear from the list or hit secret-entry validation paths.

---

## Outstanding Issues (from Implementation Code Reviews)

### Phase 1: Config & Provider Registration

#### [1.1] Add Gmail OAuth Config
- **L1 (Low):** Missing section divider comment above `GmailIntegrationConfigSchema` in `packages/domain/src/config/schema.ts`. Other config blocks have divider comments like `// ── Nomad Runtime Backend ──`.
- **L2 (Low):** YAML `redirectUri` comment in `config/default.yaml` is on a single long line. Consider splitting across two lines for readability.

#### [1.2] Seed `gmail` Provider Migration
- **L1 (Low):** `capabilities` uses implicit `text→jsonb` cast while `meta` uses explicit `::jsonb` in the same statement. Minor inconsistency but matches prior migration conventions.
- **L2 (Low):** Migration filename uses descriptive snake_case (`gmail_provider`) while some prior migrations use Drizzle-generated names. Already consistent with other manually-named migrations.

#### [1.3] Add `gmail` to Provider Registry
- **L1 (Low):** Plan spec omits `credentialProviderIds` field which is required by the `ConnectionSchema` type. The implementation correctly includes `credentialProviderIds: []`. Plan document should be updated for completeness.

### Phase 2: OAuth Endpoints (API)

#### [2.1] OAuth CSRF State Helpers
- **M1 (Medium):** Dot-safety constraint (userId must not contain '.') is documented in JSDoc but not enforced at runtime. Adding `if (userId.includes('.')) throw new Error(...)` would make it fail-fast. Acceptable since userIds are UUIDs.
- **M2 (Medium):** Missing test for dot-containing userId behavior.
- **L1 (Low):** Generic `Error` used instead of namespaced error codes (`oauth_state.user_id_required`).
- **L2 (Low):** No guard for empty `secret` in `verifyConnectionOAuthState`.
- **L3 (Low):** Missing test for `verifyConnectionOAuthState` with empty secret.
- **L4 (Low):** Missing test for `OAUTH_CONNECTION_STATE_COOKIE` constant value.

#### [2.2–2.4] Gmail OAuth Endpoints + Limit Enforcement
- **M1 (Medium):** No deduplication check for duplicate Gmail connections. A user can OAuth-connect the same Gmail account multiple times, consuming plan slots. Consider a unique constraint on `(userId, provider, profile.email)`.
- **L1 (Low):** `request.query` cast without Zod schema validation — if duplicate query params sent, Fastify may parse `code` as `string[]`. Low risk (Google rejects at token exchange).
- **L2 (Low):** State cookie not cleared after successful callback (`Max-Age=0` cleanup). Harmless hygiene issue.
- **L3 (Low):** `stateUserId` (UUID) exposed in Google OAuth redirect URL. Standard OAuth practice, not a secret.

#### [2.5] GET /agents/:id/connections
- **M1 (Medium):** Ownership check uses two-step pattern (fetch agent, then compare userId) instead of combined query used by all other agent endpoints. Functionally correct but inconsistent.
- **L1 (Low):** Error code `agent.not_found` vs sibling endpoints' `not_found` — format inconsistency within the same route file.
- **L2 (Low):** Only filters `agentConnections.status = 'active'`, not `connections.status = 'active'`. If connection is revoked while agentConnections remains active, stale data returned.

### Phase 3: Gmail API Adapter (Worker)

#### [3.1] Gmail Adapter
- **M1 (Medium):** No unit tests for the adapter (`gmail-adapter.test.ts` missing).
- **L1 (Low):** `fetchWithTimeout` throws raw `Error` (not `GmailApiError`) on network/DNS failure. Callers need `try/catch` outside the `Result` pattern for network-level failures.
- **L2 (Low):** Individual message fetch failures silently swallowed in `searchEmails` (no warning log).

#### [3.2] Credential Resolution + Lazy Refresh
- **M1 (Medium):** No unit tests for the resolver (`gmail-credential-resolver.test.ts` missing).
- **L1 (Low):** `GmailCredentialError` lacks optional `context` field that `DomainError` has (`context?: Record<string, unknown>`).
- **L2 (Low):** `process.env` accessed directly instead of a helper function for encryption key resolution.
- **L3 (Low):** Crypto test (`crypto.test.ts`) uses a local `encryptForTest` helper rather than the exported `encryptCredential` — no round-trip test.

### Phase 4: Agent Tools (Worker)

#### [4.1–4.3] Email Tools + Registry Wiring
- **M1 (Medium):** No unit tests for email tools (`email.test.ts` missing). All other tool files have `.test.ts` counterparts.
- **L1 (Low):** `GMAIL_DAILY_SEND_LIMIT` env var not listed in worker `ENV_OVERRIDES` map in `apps/worker/src/config.ts`. No functional impact since env forwarding reads directly from `process.env`.
- **L2 (Low):** Redis hash TTL refreshed on every send — stale date-scoped fields accumulate but are negligible (~50 bytes/field).

### Phase 5: System Skill Definition
No outstanding issues — implementation cleanly aligned with plan spec.

### Phase 6: Frontend
No outstanding issues — all medium findings (auto-select heuristic, cross-provider accumulation, missing `useMemo`, i18n keys) were fixed during review iterations. Pre-existing TypeScript errors in unrelated files remain.

### Phase 7: Tests

#### [7.1] Unit Tests
- **M1 (Medium):** Missing test files for: `gmail-adapter.test.ts`, `gmail-credential-resolver.test.ts`, `email.test.ts`, `connections-oauth.test.ts` (integration). 13 CSRF state tests exist (`connections-oauth-state.test.ts`).

#### [7.2] Integration Tests
- **M1 (Medium):** No integration tests written for: OAuth authorize redirect, callback with valid/invalid state, plan limit enforcement, or provider catalog presence. All deferred.

#### [7.3] E2E Tests
- **M1 (Medium):** No E2E tests written for: Gmail provider in setup modal, agent create/edit connection picker, or Gmail skill in skill picker. All deferred.

### General
- **M1 (Medium):** `GMAIL_DAILY_SEND_LIMIT` not in worker `ENV_OVERRIDES` map (consistency nit, no functional impact).
- **L1 (Low):** `encryptCredential` return type is inline rather than referencing shared `EncryptedPayload`/`EncryptionMeta` types between API and worker.
