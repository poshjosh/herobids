# 025 — Provider Registry For Credentials And Connections

A backend-owned provider registry that defines supported providers, their
credential schemas, and connection behavior. The frontend fetches this registry
at runtime and renders Credentials and Connections forms from it — replacing
hard-coded provider suggestions and raw text inputs with a single evolvable
contract.

---

## Background

### The problem

The backend already knows provider-specific credential rules for Hyperliquid,
Bybit, and 1inch (alias normalization, field validation). But the frontend
doesn't — it renders a generic free-form editor and a local suggestion list.
Users discover required fields only when the backend rejects their submission.

The connection form is worse: it accepts free-text provider strings. A typo or
casing mismatch silently breaks trading binding creation because the backend
requires exact provider match between credentials and connections.

### What we need answered in one place

- Which providers are supported?
- What fields does each require? What aliases normalize to canonical keys?
- Which providers support connections? Which auto-create trading bindings?
- Which credentials are valid for which connections?

---

## Goals

1. Backend is the single source of truth for provider support and schema.
2. Frontend fetches provider definitions at runtime — no frontend deploy needed
   to add a provider.
3. Credentials form renders structured fields for known providers, free-form for
   custom.
4. Connections form selects from the same provider list and filters credentials
   by compatibility.
5. Backend remains authoritative for normalization and validation.

## Non-Goals

1. Moving validation into the frontend.
2. Replacing grants, bindings, or trading readiness architecture.
3. Removing custom/free-form credential support.
4. Making every credential provider automatically a trading provider.

---

## API Design

### `GET /providers/catalog`

**Auth:** Requires valid session (same as other API routes).

**Caching:** Response is immutable between deploys. Return
`Cache-Control: public, max-age=3600` and an `ETag` derived from a content
hash. Frontend should use `If-None-Match` to avoid re-downloading on every page
load.

**Error responses:**

| Status | Meaning |
|--------|---------|
| 401 | Unauthenticated |
| 500 | Registry misconfiguration (fail-fast; include error code) |

### Response shape

```ts
interface ProviderCatalogResponse {
  schemaVersion: 'v1';
  etag: string;
  providers: ProviderDefinition[];
  customMode: CustomModeDefinition;   // escape hatch — not a fake provider
}
```

Note: `customMode` is modeled separately from the provider array. It is not a
provider — it's an escape hatch for unsupported venues.

### Example (abbreviated)

```json
{
  "schemaVersion": "v1",
  "etag": "abc123",
  "providers": [
    {
      "id": "hyperliquid",
      "displayName": "Hyperliquid",
      "status": "supported",
      "categories": ["trading"],
      "credentials": {
        "description": "API wallet credentials for Hyperliquid trading",
        "fields": [
          {
            "key": "apiKey",
            "label": "API Key / Wallet Address",
            "secret": false,
            "required": true,
            "inputKind": "text",
            "placeholder": "0x...",
            "aliases": ["api-key", "apikey", "api_key"],
            "validation": { "pattern": "^0x[0-9a-fA-F]{40}$" }
          }
        ]
      },
      "logoUrl": "/assets/providers/hyperliquid.svg",
      "connections": {
        "requiresCredential": false,
        "allowsCredential": true,
        "credentialProviderIds": ["hyperliquid"],
        "autoCreatesTradingBinding": true
      }
    }
  ],
  "customMode": {
    "credentials": { "allowFreeformKeys": true },
    "connections": { "allowFreeformProvider": true, "autoCreatesTradingBinding": false }
  }
}
```

Full provider definitions for Bybit, 1inch, etc. follow the same shape. Omitted
here for brevity — the TypeScript types are the canonical reference.

---

## Type Design

### Shared wire types (`packages/domain/src/provider-catalog.ts`)

```ts
export type ProviderCatalogSchemaVersion = 'v1';

export interface ProviderCatalogResponse {
  schemaVersion: ProviderCatalogSchemaVersion;
  etag: string;
  providers: ProviderDefinition[];
  customMode: CustomModeDefinition;
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  status: 'supported' | 'deprecated';
  categories: string[];
  logoUrl?: string;
  credentials?: CredentialSchema;
  connections?: ConnectionSchema;
}

export interface CredentialSchema {
  description?: string;
  fields: FieldDefinition[];
}

export interface ConnectionSchema {
  description?: string;
  requiresCredential: boolean;
  allowsCredential: boolean;
  credentialProviderIds: string[];
  autoCreatesTradingBinding: boolean;
}

export interface FieldDefinition {
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  secret: boolean;
  required: boolean;
  inputKind: 'text' | 'password' | 'textarea' | 'number';
  aliases: string[];
  validation?: FieldValidation;
}

export interface FieldValidation {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface CustomModeDefinition {
  credentials: { allowFreeformKeys: boolean };
  connections: { allowFreeformProvider: boolean; autoCreatesTradingBinding: boolean };
}
```

Design decisions:
- No `hybrid` mode — YAGNI. Add when a real use case appears.
- `inputKind` uses only standard HTML-mappable kinds. No custom `'address'` or
  `'hex'` — those are just `'text'` with a regex pattern.
- `customMode` is a top-level escape hatch, not a fake provider in the array.
- `credentialProviderIds` on `ConnectionSchema` lists which provider credentials
  are valid for a connection. Most providers list only themselves, but
  multi-venue connections (e.g. a DEX aggregator accepting credentials from
  multiple underlying venues) list all compatible provider IDs.
- `logoUrl` points to a provider logo asset served by the frontend. Optional —
  custom-mode entries have no logo.
- Deprecated providers are included in the catalog response (existing users may
  have credentials/connections referencing them) but the frontend hides them
  from the provider picker when creating new credentials or connections. Existing
  resources tied to deprecated providers remain functional.

### Backend internal types (`apps/api/src/providers/types.ts`)

```ts
import type { ProviderDefinition, FieldDefinition } from '@herobids/domain';

/**
 * Registry entry — pure data. No closures, no methods.
 * Validation and normalization are handled by a separate ProviderValidator service.
 */
export interface RegistryEntry extends ProviderDefinition {
  /** Normalization rules beyond what's in FieldValidation (e.g. lowercase, trim) */
  normalization?: Record<string, NormalizationRule[]>;
}

export type NormalizationRule = 'trim' | 'lowercase' | 'uppercase';
```

Validation logic lives in a `ProviderValidator` service that takes
`(entry, input) => Result<Record<string, string>, ValidationError[]>`. This
keeps the registry serializable, testable, and consistent with ports-and-adapters
style.

---

## Backend Behavior

### Provider registry

A plain array of `RegistryEntry` objects, one per supported provider. Composed
in `apps/api/src/providers/registry.ts`. Each provider is defined in its own
file under `apps/api/src/providers/definitions/`.

### `ProviderValidator` service

```ts
interface ProviderValidator {
  normalize(entry: RegistryEntry, input: Record<string, string>): Record<string, string>;
  validate(entry: RegistryEntry, input: Record<string, string>): ValidationError[];
}
```

Shared logic:
- Alias resolution via entry's field definitions
- Required-field checks
- Pattern matching from `FieldValidation`
- Normalization rules (trim, lowercase)

### Credentials route refactor

1. Look up provider in registry. If not found and not custom mode → 400.
2. Call `validator.normalize(entry, secrets)` → canonical keys.
3. Call `validator.validate(entry, canonicalSecrets)` → errors or proceed.
4. Encrypt and store.

Replaces the current inline `SECRET_ALIASES_BY_VENUE` map and per-venue
`if/else` chains.

### Connections route refactor

1. Look up provider in registry. If not found and not custom mode → 400.
2. If credential provided, verify `credential.venue` is in
   `entry.connections.credentialProviderIds`.
3. Use `entry.connections.autoCreatesTradingBinding` instead of hard-coded
   `TRADING_CONNECTION_PROVIDERS` set.

### Catalog route

Serialize registry entries to `ProviderCatalogResponse`. Compute ETag from
content hash. Return with cache headers.

---

## Frontend Behavior

### Credentials page

1. Fetch catalog (cache-aware).
2. Render provider picker from `providers` array + "Custom" option.
3. If structured provider selected: render fields from `credentials.fields`.
4. If Custom selected: reveal free-form provider name input + key/value editor.
5. Submit canonical field keys. Backend still normalizes aliases as a safety net.

### Connections page

1. Fetch same catalog.
2. Render provider picker.
3. Filter credential dropdown: show only credentials whose `venue` is in the
   selected provider's `credentialProviderIds`.
4. Show whether a trading binding will be auto-created (informational).
5. If Custom selected: reveal free-text provider input.
6. Hide deprecated providers from the picker. Show them only in read views for
   existing resources.

### Schema version handling

If the frontend receives a `schemaVersion` it doesn't recognize, it should
display a "please refresh" banner rather than silently breaking. This handles
the deploy-mismatch window.

---

## Data Migration

Existing credentials and connections use free-text venue/provider strings.
Before this feature launches:

1. Audit existing `venue` values in `user_credentials` and `provider` values in
   `connections` for case mismatches against registry IDs.
2. Write a one-time migration to lowercase/normalize existing values that match
   known providers (e.g. `"Hyperliquid"` → `"hyperliquid"`).
3. Rows that don't match any known provider remain untouched — they're
   effectively custom-mode entries.

---

## Rollout Plan

1. Add shared wire types in `packages/domain`.
2. Implement backend registry (pure data) + `ProviderValidator` service.
3. Add `GET /providers/catalog` route with caching.
4. Refactor credentials route to use registry + validator.
5. Refactor connections route to use registry.
6. Run data migration for existing rows.
7. Update frontend credentials page.
8. Update frontend connections page.
9. Remove old hard-coded `SECRET_ALIASES_BY_VENUE` and
   `TRADING_CONNECTION_PROVIDERS`.

---

## Test Plan

### Backend

| Scenario | Verifies |
|----------|----------|
| Catalog returns all supported providers + custom mode | Serialization |
| Catalog returns correct ETag and responds 304 on match | Caching |
| Hyperliquid alias normalization: `api-key` → `apiKey` | Backward compat |
| Structured provider rejects missing required fields | Validation |
| Custom mode accepts arbitrary keys | Escape hatch |
| Connection rejects credential not in `credentialProviderIds` | Provider matching |
| Connection accepts credential from any listed provider ID | Multi-venue |
| Trading binding created only when registry says so | Registry authority |
| Deprecated provider still returned in catalog | Deprecation flow |
| Unknown provider in non-custom mode → 400 | Input validation |
| Catalog includes `logoUrl` for providers that have one | Logo field |

### Frontend

| Scenario | Verifies |
|----------|----------|
| Structured provider renders expected fields | Schema-driven UI |
| Custom mode reveals free-form editor | Escape hatch UX |
| Connection credential dropdown filters by `credentialProviderIds` | Compatibility |
| Deprecated providers hidden from picker, visible in existing resources | Deprecation UX |
| Provider logo rendered when `logoUrl` present | Logo display |
| Unrecognized schema version shows refresh banner | Deploy safety |

### Migration

| Scenario | Verifies |
|----------|----------|
| Existing `"Hyperliquid"` credential resolves post-migration | Data compat |
| Unknown venue values remain unchanged | No data loss |

---

## Decisions Log

1. **Multi-venue connections:** Yes. `ConnectionSchema` includes
   `credentialProviderIds: string[]` so a single connection can accept
   credentials from multiple providers (e.g. a DEX aggregator).
2. **Deprecated providers:** Included in the catalog response but hidden from
   the provider picker for new creation. Existing resources referencing
   deprecated providers remain visible and functional in read/edit views.
3. **Provider logos:** Catalog includes an optional `logoUrl` field. The
   frontend serves static SVG assets at a conventional path
   (`/assets/providers/<id>.svg`).
