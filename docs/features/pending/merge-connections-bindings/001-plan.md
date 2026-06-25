# Simplify Credential → Connection → Agent Access

## Summary

Collapse the multi-table chain into a clean 3-entity model:

1. **`user_credentials`** — encrypted secrets (reusable, revocable, one row per API key/token)
2. **`connections`** — usable linkage to a provider (always references a credential; absorbs `trading_bindings`)
3. **`capability_grants`** — scoped agent access to a connection

**Dropped tables:** `trading_bindings`, `agent_credentials`.

All downstream FKs (`capability_grants.binding_id`, `bots.trading_binding_id`) now point directly at `connections.id`. The `agent_credentials` join table is eliminated — agents access credentials exclusively through `capability_grants → connections → user_credentials`.

### Why keep `user_credentials` separate?

- **Revocability:** Revoke/rotate one credential → all connections referencing it are immediately affected.
- **Reusability:** Theoretical future support (one credential, multiple connections). In practice 1:1 today.
- **Separation of concerns:** The encrypted blob is a distinct lifecycle artifact from the "am I connected and active" state.

## Motivation

- `connections` and `trading_bindings` are 1:1 (unique index on `connection_id`).
- They duplicate `user_id`, `provider`, `label`, `status`, `created_at`, `updated_at`.
- The "capability-agnostic connection → family-specific binding" abstraction never materialized — every connection today creates exactly one trading binding.
- The name `trading_bindings` is misleading — non-trading agents (automation, comms) also receive grants on these rows.
- Every resolution path JOINs both tables together. Collapsing them simplifies queries and removes a pointless indirection.
- `agent_credentials` creates a confusing second path to credential access. Agents should access everything through one mechanism: capability grants on connections.
- The user flow is confusing: "create credential → connect to provider → bind → grant to agent" becomes simply "create connection → grant to agent".

## Target Schema

### `user_credentials` (`venue` → `provider`)

```sql
CREATE TABLE user_credentials (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id),
  provider        text NOT NULL,  -- was venue; renamed for consistency with connections.provider
  label           text NOT NULL,
  encrypted_data  text NOT NULL,
  encryption_meta jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

### `connections` (merged)

```sql
CREATE TABLE connections (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id),
  credential_id   text REFERENCES user_credentials(id) ON DELETE SET NULL,
  provider        text NOT NULL,
  label           text NOT NULL,
  status          text NOT NULL DEFAULT 'active',  -- active | revoked
  -- Absorbed from trading_bindings:
  provider_ref    text,         -- was binding_ref; account/wallet reference at the provider
  profile         jsonb,        -- was binding_profile; normalized capability metadata
  meta            jsonb,        -- provider-specific cached metadata (non-secret)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_connections_user_id ON connections(user_id);
CREATE INDEX idx_connections_provider ON connections(provider);
CREATE INDEX idx_connections_status ON connections(status);
```

### `capability_grants` (FK change only)

```sql
-- binding_id renamed to connection_id
ALTER TABLE capability_grants RENAME COLUMN binding_id TO connection_id;
-- FK now points at connections(id) instead of trading_bindings(id)
```

### `bots` (FK change only)

```sql
-- trading_binding_id renamed to connection_id
ALTER TABLE bots RENAME COLUMN trading_binding_id TO connection_id;
-- FK now points at connections(id) instead of trading_bindings(id)
```

### `agent_credentials` (DROPPED)

```sql
DROP TABLE agent_credentials;
```

Agents no longer hold direct references to credentials. Instead, any agent that needs access to a provider's secrets gets a `capability_grant` on the relevant connection. The `capability_family` field distinguishes the type of access (`"trading"`, `"messaging"`, `"automation"`, etc.).

## Column Mapping

| Old (`trading_bindings`) | New (`connections`) | Notes |
|---|---|---|
| `id` | (dropped) | Connection's own `id` is the identity now |
| `user_id` | (already exists) | Redundant |
| `connection_id` | (self) | Eliminated |
| `provider` | (already exists) | Redundant |
| `label` | (already exists) | Redundant |
| `binding_ref` | `provider_ref` | Renamed for generality |
| `status` | (already exists) | Redundant |
| `binding_profile` | `profile` | Renamed for generality |
| `source_venue_account_id` | (dropped) | Migration traceability; no longer needed |
| `created_at` / `updated_at` | (already exists) | Redundant |

## Migration Strategy

Single migration file. No backward compatibility required.

```
1. Add columns to connections: provider_ref, profile
2. Copy data from trading_bindings into connections (UPDATE connections SET provider_ref = tb.binding_ref, profile = tb.binding_profile FROM trading_bindings tb WHERE tb.connection_id = connections.id)
3. Drop FK constraint bots.trading_binding_id → trading_bindings.id
4. Add column bots.connection_id; populate from: UPDATE bots SET connection_id = tb.connection_id FROM trading_bindings tb WHERE tb.id = bots.trading_binding_id
5. Drop column bots.trading_binding_id
6. Drop FK constraint capability_grants.binding_id → trading_bindings.id
7. Rename column capability_grants.binding_id → connection_id; add FK → connections.id
8. Drop table trading_bindings
9. Drop table agent_credentials
10. Drop redundant indexes; add new ones as needed
```

**Note on `user_credentials.venue → provider`:** also rename in all code that reads/writes this column (credential routes, credential service, setup route). The old agent-credentials join logic is deleted entirely.

**Note on `agent_credentials` removal:** any code that currently resolves agent→credential via `agent_credentials` must be migrated to use `capability_grants → connections`. Search for all imports of `agentCredentials` schema and usages of the `agent_credentials` table.

**Note:** Since we don't care about backward compat and use Drizzle, the practical approach is:
- Update the Drizzle schema files to the target state.
- Run `drizzle-kit generate` to produce the migration.
- Manually review and adjust the generated SQL for data copy steps.

## Code Changes

### Schema Layer (`packages/db/src/schema/`)

| Action | File |
|---|---|
| Edit | `user-credentials.ts` — rename `venue` → `provider` |
| Edit | `connections.ts` — add `providerRef`, `profile` columns |
| Delete | `trading-bindings.ts` |
| Delete | `agent-credentials.ts` |
| Edit | `capability-grants.ts` — rename `bindingId` → `connectionId`, update FK target |
| Edit | `bots.ts` — rename `tradingBindingId` → `connectionId`, update FK target |
| Edit | `index.ts` — remove `tradingBindings` and `agentCredentials` exports |

### Domain Layer (`packages/domain/`)

| Action | File |
|---|---|
| Edit | `src/platform.ts` — update `Connection` interface (add `providerRef`, `profile`); update `CapabilityGrant` (rename `bindingId` → `connectionId`) |

### API Layer (`apps/api/`)

| Action | File | What |
|---|---|---|
| Edit | `src/routes/connections.ts` | Remove binding auto-creation on POST; revocation no longer cascades to binding table |
| Edit | `src/routes/capabilities/trading.ts` | Replace 3-table JOINs with 2-table JOINs (grants ↔ connections); rename fields in response |
| Edit | `src/routes/bots.ts` | Replace `tradingBindingId` with `connectionId` in lookups and validation |
| Edit | `src/grant-service.ts` | Simplify join chain |
| Edit | `src/plan-guards.ts` | Remove `tradingBindings` import/usage |
| Edit | `src/credential-dependents.ts` | Remove `agentCredentials` from dependents check; adjust connection→binding chain |
| Edit | `src/routes/setup.ts` | No longer needs to create a binding row post-connection |
| Delete/Edit | `src/routes/agent-credentials.ts` (if exists) | Remove routes for managing agent_credentials; agent access is now exclusively via capability_grants |

### Worker Layer (`apps/worker/`)

| Action | File | What |
|---|---|---|
| Edit | `src/startup-context.ts` | Remove binding JOIN; read `providerRef`/`profile` from `connections` directly |
| Edit | `src/agents/agent-intake-resolver.ts` | Simplify: `capability_grants.connection_id` → `connections` (one JOIN, not two) |

### Web Frontend (`apps/web/`)

#### User Flow Changes

The user journey simplifies — the "binding" concept disappears entirely from the UI:

| Before | After |
|---|---|
| Create credential → Create connection → Connection auto-creates trading binding → Select binding during agent creation | Create credential → Create connection → Select connection during agent creation |
| `POST /setup/provider-link` returns `{ credential, connection, venueAccount, tradingBinding }` | `POST /setup/provider-link` returns `{ credential, connection }` |
| Agent creation: "Platform link" dropdown lists trading bindings | Agent creation: "Platform link" dropdown lists connections |
| Bot creation: select trading binding | Bot creation: select connection |
| Capability page: "Available bindings" | Capability page: "Available connections" |

The Connections page already exists and already renders active connections. It stays as-is (minus any reference to "binding auto-created" helper text). The ProviderSetupForm still creates credential + connection in one shot — it just no longer produces a binding row.

#### File-by-File Changes

| Action | File | What |
|---|---|---|
| Edit | `src/lib/api-client.ts` | Rename `tradingBindingId` → `connectionId` in bot schema; rename types `TradingBindingSummary` → `ConnectionSummary`, `TradingBindingReadiness` → `ConnectionReadiness`; update `tradingBindings()` endpoint to `connections()` or equivalent; update `ProviderSetupResult` to drop `tradingBinding` and `venueAccount` fields |
| Edit | `src/features/connections/ConnectionsPage.tsx` | Remove helper text about "auto-creates a trading binding"; connection is now the final entity |
| Edit | `src/features/setup/ProviderSetupForm.tsx` | Update `onSuccess` result type (no `tradingBinding` in response); adjust success toast messaging |
| Edit | `src/features/bots/BotsPage.tsx` | Rename `tradingBindingId` → `connectionId` in create-bot form and API calls |
| Edit | `src/features/agents/AgentsPage.tsx` | Rename binding selector: query connections directly; `bindingId` → `connectionId` in bind action; filter by `connection.status === 'active'` (no more `connectionStatus` indirection) |
| Edit | `src/features/agents/` (capability page) | Rename "Available bindings" → "Available connections"; update bind/unbind actions |
| Edit | `src/features/credentials/CredentialsPage.tsx` | Rename `venue` display field → `provider` (column header, filter labels) |
| Edit | `src/app/i18n/locales/en.ts` | Rename all `tradingBinding` keys; update labels (see table below) |

#### i18n Key Changes

| Old Key | New Key | New Value |
|---|---|---|
| `agents.create.tradingBinding` | `agents.create.connection` | `'Platform link'` (unchanged text, key renamed) |
| `agents.create.loadingBindings` | `agents.create.loadingConnections` | `'Loading platform links…'` |
| `agents.create.noBindings` | `agents.create.noConnections` | `'No active platform links yet. Set up now or create the AI agent and link it later.'` |
| `agents.create.chooseBinding` | `agents.create.chooseConnection` | `'Choose a connection'` |
| `agents.capabilityPage.availableBindings` | `agents.capabilityPage.availableConnections` | `'Available connections'` |
| `agents.capabilityPage.noBindings` | `agents.capabilityPage.noConnections` | `'No platform links yet. Complete setup from Mission Control or when creating an agent, then return here to link.'` |
| `credentials.venue` (if exists) | `credentials.provider` | `'Provider'` |

### Scripts

| Action | File |
|---|---|
| Edit | `scripts/ts/audit-orphaned-connections.ts` — remove LEFT JOIN to trading_bindings |
| Edit | `scripts/shell/ops/quick-setup.sh` — parse `.connection.id` instead of `.tradingBinding.id` |
| Edit | `scripts/shell/ops/quick-setup.prod.sh` — same |
| Edit | `scripts/ts/agent-trade-test.ts` — parse connection from response |

### Tests

| Action | File |
|---|---|
| Edit | `apps/api/src/__tests__/functional/agent-interactivity.functional.test.ts` |
| Edit | `apps/api/src/routes/connections.test.ts` |
| Edit | `apps/api/src/routes/capabilities/trading.test.ts` |
| Edit | `apps/api/src/routes/agents.test.ts` |
| Edit | `apps/worker/src/__tests__/integration/agent-native-decision.integration.test.ts` |
| Edit | `apps/worker/src/startup-context.test.ts` |
| Edit | `apps/worker/src/agents/capability-sandbox.test.ts` |

### Documentation

| Action | File |
|---|---|
| Edit | `AGENTS.md` — update execution context resolution paths |
| Edit | `docs/tech/agents/runtime-boundary-and-message-contract.md` — if it references binding chain |
| Edit | `docs/tech/user-acceptance-tests.md` — see UAT changes below |

### UAT Changes (`docs/tech/user-acceptance-tests.md`)

The following test cases reference "binding" or the old three-table flow and must be updated:

#### Section 4 — Bots

| ID | Change |
|---|---|
| I-03 | Replace "trading binding" with "connection"; replace "venue account selector replaced with trading-binding selector" with "connection selector" |

#### Section 6 — Agents

| ID | Change |
|---|---|
| AG-14 | Replace "Binding readiness" → "Connection readiness"; "binding readiness" in expected column |
| AG-19 | Replace "No active trading bindings yet" → "No active platform links yet"; "binding selector" → "connection selector" |
| AG-21 | Replace "binding selector appears with new binding pre-selected" → "connection selector appears with new connection pre-selected" |
| AG-22 | No change needed (already doesn't mention bindings directly) |

#### Section 6b — Simplified Creation Flow

| ID | Change |
|---|---|
| AG-S01 | No change (doesn't reference bindings directly) |

#### Section 11 — Connections

| ID | Change |
|---|---|
| CN-03 | Add note: connection is now the grantable entity directly (no binding auto-created) |

#### Section 12 — Credentials

| ID | Change |
|---|---|
| C-02 | Replace `venue` with `provider` in expected response |
| C-03 | No change (field labels are provider-driven) |

#### Section 13 — Trading Setup

This entire section describes `venue_accounts` which is a separate concern from this migration. However, any mention of "trading binding" in the notes should be updated to "connection."

#### New Test Cases to Add

| ID | Test Case | Steps | Expected |
|---|---|---|---|
| AG-25 | Create agent — connection selector shows connections | Open Create Agent with trading skill; have active connections | Dropdown lists active connections by label and provider |
| AG-26 | Create agent — inline setup creates connection directly | Click "Set up trading now"; complete form | Connection created (no intermediate binding); connection appears in selector |
| CN-06 | Connection shows profile/providerRef | Create connection via provider-link setup | Connection card shows provider reference (e.g. wallet address) if present |

## Naming Decisions

| Old Name | New Name | Reason |
|---|---|---|
| `user_credentials.venue` | `provider` | Consistent with `connections.provider`; credentials aren't trading-venue-only |
| `trading_bindings` table | (absorbed into `connections`) | Eliminated |
| `agent_credentials` table | (dropped) | Single access path: capability_grants → connections |
| `binding_id` (in capability_grants) | `connection_id` | Points at connections now |
| `trading_binding_id` (in bots) | `connection_id` | Points at connections now |
| `binding_ref` column | `provider_ref` | Provider-agnostic |
| `binding_profile` column | `profile` | Shorter, general |
| `TradingBindingSummary` type | `ConnectionSummary` | General |
| `TradingBindingReadiness` type | `ConnectionReadiness` | General |

## Access Model (Single Path)

All agent access to external providers follows one path:

```
agent → capability_grants → connections → user_credentials
         (scoped by family)    (linkage)     (encrypted secret)
```

**Examples:**
- Trading agent on Hyperliquid: `capability_grant(family="trading")` → `connection(provider="hyperliquid")` → `credential(encrypted Hyperliquid API key)`
- Messaging agent on Telegram: `capability_grant(family="messaging")` → `connection(provider="telegram")` → `credential(encrypted bot token)`
- Automation agent on Twitter: `capability_grant(family="automation")` → `connection(provider="twitter")` → `credential(encrypted API key)`

**No more dual paths.** The old `agent_credentials` shortcut is eliminated.

## Checklist

- [ ] Update Drizzle schema files (packages/db/src/schema/)
  - `user_credentials`: rename `venue` → `provider`
  - `connections`: add `providerRef`, `profile`; drop `trading-bindings.ts`
  - `capability-grants`: rename `bindingId` → `connectionId`
  - `bots`: rename `tradingBindingId` → `connectionId`
  - Delete `agent-credentials.ts`; remove from `index.ts`
- [ ] Run `drizzle-kit generate` and review migration SQL
- [ ] Add data-copy step to migration (provider_ref, profile from trading_bindings)
- [ ] Update domain types (packages/domain/src/platform.ts)
- [ ] Update API routes and services
  - `POST /setup/provider-link`: stop creating binding row; response drops `tradingBinding`/`venueAccount`
  - `POST /agents/:id/trading/action`: `bindingId` → `connectionId`
  - `GET /capabilities/trading/bindings` → update endpoint/response shape
  - Bot routes: `tradingBindingId` → `connectionId`
- [ ] Update worker (intake resolver, startup context)
- [ ] Update web frontend
  - API client types (`TradingBindingSummary` → `ConnectionSummary`, etc.)
  - Agent creation flow (binding selector → connection selector)
  - Bot creation form (`tradingBindingId` → `connectionId`)
  - Credentials page (`venue` → `provider` display)
  - Connections page (remove binding helper text)
  - ProviderSetupForm (update response handling)
  - Capability page ("Available bindings" → "Available connections")
  - i18n keys (all `tradingBinding`/`binding` keys)
- [ ] Update scripts
- [ ] Update tests
- [ ] Update documentation
  - `AGENTS.md`
  - `docs/tech/user-acceptance-tests.md` (binding → connection; new test cases AG-25, AG-26, CN-06)
- [ ] Run `pnpm lint` — must pass
- [ ] Run `pnpm test` — must pass
