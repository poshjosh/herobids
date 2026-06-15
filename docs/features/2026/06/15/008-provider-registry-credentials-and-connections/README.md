# 025 — Provider Registry For Credentials And Connections

Introduce a backend-owned provider registry that defines supported providers,
their credential schema, and their connection behavior. The frontend fetches
this registry and renders both the Credentials and Connections forms from it.

This replaces hard-coded provider suggestions and raw provider text inputs with
a single runtime contract that is flexible, extensible, and evolvable.

---

## Background

The current product has split behavior across credentials and connections.

### Credentials today

The backend already knows provider-specific credential rules for a small set of
providers:

- Hyperliquid
- Bybit
- 1inch

That logic lives in the credential route and includes alias normalization plus
provider-specific validation.

Examples:
- Hyperliquid normalizes `api-key` to `apiKey`
- Hyperliquid normalizes `account-address` to `walletAddress`
- 1inch validates `privateKey` shape
- Bybit requires `apiKey` and `secret`

However, the frontend still renders a generic free-form key/value form and only
shows a local suggestion list of provider names. The frontend does not know the
required fields for supported providers until the backend rejects the request.

### Connections today

The connection form is even more sensitive to provider correctness than the
credential form.

The frontend currently sends whatever free-text provider string the user typed.
The backend requires that a linked credential's `venue` exactly match the
connection `provider`. Trading bindings are also auto-created only for a fixed
set of provider strings.

This means typos or casing mismatches in the connection form can silently break
the intended trading setup flow.

### Why this matters

We need one source of truth that answers all of these questions:

- Which providers are supported?
- Which ones have structured credential schemas?
- Which fields are required?
- Which aliases normalize to canonical keys?
- Which providers support connections?
- Which providers auto-create trading bindings?
- Which providers allow free-form custom credentials only?

Without that, the frontend and backend drift.

---

## Goals

1. Backend is the source of truth for provider support and schema.
2. Frontend fetches provider definitions at runtime.
3. Credentials form renders structured fields for supported providers.
4. Credentials form supports a real Custom mode for unsupported providers.
5. Connections form uses the same provider list and does not rely on raw text.
6. Adding a new provider in the backend makes it available to the frontend
   without frontend code changes.
7. Backend remains authoritative for normalization and validation.
8. Credential and connection flows stay compatible with the current trading
   binding model.

---

## Non-Goals

1. Inferring runtime schemas from TypeScript interfaces alone.
2. Moving authoritative validation into the frontend.
3. Replacing grants, bindings, or trading readiness architecture.
4. Removing custom/free-form credential support.
5. Making every supported credential provider automatically a trading provider.

---

## Current Constraints

### Credentials

Current credential validation is hard-coded for Hyperliquid, Bybit, and 1inch
in the backend route.

The frontend credentials page still uses a local provider suggestion list and a
free-form secret key/value editor.

### Connections

The frontend connections page currently:
- uses a raw provider text input
- allows any provider string
- shows all credentials in the dropdown
- depends on exact provider match for linked credentials
- relies on hard-coded provider strings for trading binding creation

These constraints make the connection page a first-class part of this feature,
not an optional follow-up.

---

## Proposal

Introduce a backend provider registry that describes provider capabilities for:

- credentials
- connections
- optional trading-related metadata

The frontend fetches that registry and uses it to render both forms.

### Core design rules

1. Provider definitions are runtime data, not compile-time only types.
2. Provider definitions include both validation metadata and UI metadata.
3. Structured providers expose field definitions.
4. Custom mode remains available for unsupported providers.
5. The backend still canonicalizes aliases and validates payloads.
6. Connections use the same provider registry, not a separate hard-coded list.

---

## API Design

### Endpoint

```http
GET /providers/catalog
```

This endpoint returns all providers known to the backend, including:
- structured supported providers
- custom fallback entry
- per-resource behavior for credentials and connections

Optional future endpoint:

```http
GET /providers/catalog/:providerId
```

This is not required for the first implementation.

---

## Response Payload

### Response type

```json
{
  "schemaVersion": "v1",
  "generatedAt": "2026-06-08T12:00:00.000Z",
  "providers": [
    {
      "id": "hyperliquid",
      "displayName": "Hyperliquid",
      "status": "supported",
      "categories": ["trading"],
      "resources": {
        "credentials": {
          "mode": "structured",
          "label": "Credential",
          "description": "API wallet credentials for Hyperliquid trading",
          "allowFreeformExtras": false,
          "fields": [
            {
              "key": "apiKey",
              "label": "API Key / Wallet Address",
              "secret": false,
              "required": true,
              "inputKind": "text",
              "placeholder": "0x...",
              "description": "Agent or main wallet address used as Hyperliquid API key",
              "aliases": ["api-key", "apikey", "api_key"],
              "validation": {
                "pattern": "^0x[0-9a-fA-F]{40}$",
                "normalize": ["trim"]
              }
            },
            {
              "key": "secret",
              "label": "Secret",
              "secret": true,
              "required": true,
              "inputKind": "password",
              "placeholder": "Enter secret",
              "description": "Signing secret for the Hyperliquid API wallet",
              "aliases": ["secret", "secret-key", "secret_key"],
              "validation": {
                "minLength": 1,
                "normalize": ["trim"]
              }
            },
            {
              "key": "walletAddress",
              "label": "Main Wallet Address",
              "secret": false,
              "required": true,
              "inputKind": "address",
              "placeholder": "0x...",
              "description": "Parent account address whose balances and positions are tracked",
              "aliases": ["wallet-address", "walletaddress", "account-address", "accountaddress"],
              "validation": {
                "pattern": "^0x[0-9a-fA-F]{40}$",
                "normalize": ["trim", "lowercase"]
              }
            }
          ]
        },
        "connections": {
          "mode": "structured",
          "label": "Connection",
          "description": "Reusable provider connection for capability bindings",
          "requiresCredential": false,
          "allowsCredential": true,
          "credentialProviderIds": ["hyperliquid"],
          "autoCreatesTradingBinding": true
        }
      }
    },
    {
      "id": "bybit",
      "displayName": "Bybit",
      "status": "supported",
      "categories": ["trading"],
      "resources": {
        "credentials": {
          "mode": "structured",
          "label": "Credential",
          "description": "Bybit API credentials",
          "allowFreeformExtras": false,
          "fields": [
            {
              "key": "apiKey",
              "label": "API Key",
              "secret": true,
              "required": true,
              "inputKind": "password",
              "aliases": ["api-key", "apikey", "api_key"],
              "validation": {
                "minLength": 1,
                "normalize": ["trim"]
              }
            },
            {
              "key": "secret",
              "label": "Secret",
              "secret": true,
              "required": true,
              "inputKind": "password",
              "aliases": ["secret", "secret-key", "secret_key"],
              "validation": {
                "minLength": 1,
                "normalize": ["trim"]
              }
            }
          ]
        },
        "connections": {
          "mode": "structured",
          "requiresCredential": false,
          "allowsCredential": true,
          "credentialProviderIds": ["bybit"],
          "autoCreatesTradingBinding": true
        }
      }
    },
    {
      "id": "1inch",
      "displayName": "1inch",
      "status": "supported",
      "categories": ["trading", "swap"],
      "resources": {
        "credentials": {
          "mode": "structured",
          "label": "Credential",
          "description": "1inch developer and signing credentials",
          "allowFreeformExtras": false,
          "fields": [
            {
              "key": "apiKey",
              "label": "API Key",
              "secret": true,
              "required": true,
              "inputKind": "password",
              "aliases": ["api-key", "apikey", "api_key"],
              "validation": {
                "minLength": 1,
                "normalize": ["trim"]
              }
            },
            {
              "key": "privateKey",
              "label": "Private Key",
              "secret": true,
              "required": true,
              "inputKind": "password",
              "aliases": ["private-key", "privatekey", "private_key"],
              "validation": {
                "pattern": "^(0x)?[0-9a-fA-F]{64}$",
                "normalize": ["trim"]
              }
            }
          ]
        },
        "connections": {
          "mode": "structured",
          "requiresCredential": true,
          "allowsCredential": true,
          "credentialProviderIds": ["1inch"],
          "autoCreatesTradingBinding": true
        }
      }
    },
    {
      "id": "custom",
      "displayName": "Custom",
      "status": "custom",
      "categories": ["generic"],
      "resources": {
        "credentials": {
          "mode": "custom",
          "label": "Credential",
          "description": "Custom provider credentials using free-form key/value pairs",
          "allowFreeformExtras": true,
          "fields": []
        },
        "connections": {
          "mode": "custom",
          "label": "Connection",
          "description": "Custom provider connection using a free-text provider id",
          "requiresCredential": false,
          "allowsCredential": true,
          "credentialProviderIds": [],
          "autoCreatesTradingBinding": false
        }
      }
    }
  ]
}
```

### Design notes

- `schemaVersion` allows the response shape to evolve safely.
- `status` distinguishes supported from custom.
- `resources.credentials.mode` controls structured vs custom credential rendering.
- `resources.connections.mode` controls structured vs custom connection rendering.
- `credentialProviderIds` tells the connection page which credentials are valid.
- `autoCreatesTradingBinding` exposes behavior already embedded in current backend
  logic.
- `allowFreeformExtras` gives room for hybrid providers later if needed.

---

## Type Design

These types define the wire contract between backend and frontend.

```ts
export type ProviderCatalogSchemaVersion = 'v1';

export interface ProviderCatalogResponse {
  schemaVersion: ProviderCatalogSchemaVersion;
  generatedAt: string;
  providers: ProviderDefinition[];
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  status: 'supported' | 'custom' | 'deprecated';
  categories: string[];
  resources: ProviderResources;
}

export interface ProviderResources {
  credentials?: CredentialResourceSchema;
  connections?: ConnectionResourceSchema;
}

export interface CredentialResourceSchema {
  mode: 'structured' | 'custom' | 'hybrid';
  label: string;
  description?: string;
  allowFreeformExtras: boolean;
  fields: ProviderFieldDefinition[];
}

export interface ConnectionResourceSchema {
  mode: 'structured' | 'custom' | 'hybrid';
  label?: string;
  description?: string;
  requiresCredential: boolean;
  allowsCredential: boolean;
  credentialProviderIds: string[];
  autoCreatesTradingBinding: boolean;
}

export interface ProviderFieldDefinition {
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  example?: string;
  secret: boolean;
  required: boolean;
  inputKind: 'text' | 'password' | 'address' | 'hex' | 'textarea' | 'number';
  aliases: string[];
  validation?: ProviderFieldValidation;
  ui?: ProviderFieldUiHints;
}

export interface ProviderFieldValidation {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  normalize?: Array<'trim' | 'lowercase' | 'uppercase' | 'stripNonAlnum'>;
}

export interface ProviderFieldUiHints {
  autocomplete?: string;
  monospace?: boolean;
  copyable?: boolean;
}
```

### Backend runtime types

The backend needs richer internal types than the wire response because it also
owns normalization and validation.

```ts
export interface ProviderRegistryEntry {
  id: string;
  displayName: string;
  status: 'supported' | 'custom' | 'deprecated';
  categories: string[];
  credentials?: BackendCredentialDefinition;
  connections?: BackendConnectionDefinition;
}

export interface BackendCredentialDefinition {
  mode: 'structured' | 'custom' | 'hybrid';
  allowFreeformExtras: boolean;
  fields: BackendFieldDefinition[];
  normalizeInput: (input: Record<string, string>) => Record<string, string>;
  validateInput: (input: Record<string, string>) => Array<{
    field: string;
    message: string;
  }>;
}

export interface BackendConnectionDefinition {
  mode: 'structured' | 'custom' | 'hybrid';
  requiresCredential: boolean;
  allowsCredential: boolean;
  credentialProviderIds: string[];
  autoCreatesTradingBinding: boolean;
}

export interface BackendFieldDefinition extends ProviderFieldDefinition {
  canonicalize?: (value: string) => string;
}
```

---

## Module Layout

### Shared contract types

Use `packages/domain` for shared API contract types only.

```text
packages/domain/
  src/
    provider-catalog.ts
```

Contents:
- `ProviderCatalogResponse`
- `ProviderDefinition`
- `CredentialResourceSchema`
- `ConnectionResourceSchema`
- `ProviderFieldDefinition`
- related enums and type aliases

This keeps the frontend and backend aligned on the wire format without moving
runtime validation into `domain`.

### Backend runtime registry

```text
apps/api/
  src/
    providers/
      index.ts
      registry.ts
      serializer.ts
      normalization.ts
      validation.ts
      catalog-routes.ts
      definitions/
        hyperliquid.ts
        bybit.ts
        oneinch.ts
        custom.ts
```

Responsibilities:
- `definitions/*.ts`
  provider-by-provider registry entries
- `registry.ts`
  compose all entries into one catalog
- `serializer.ts`
  convert internal registry entry to API payload
- `normalization.ts`
  shared alias normalization helpers
- `validation.ts`
  shared field validation helpers
- `catalog-routes.ts`
  add `GET /providers/catalog`

### Backend route integration

Existing routes should consume the registry instead of hard-coded provider
branches.

Affected routes:
- credentials create and rotate
- connections create
- future provider-aware UI routes

### Frontend integration

```text
apps/web/
  src/
    lib/
      api-client.ts
    features/
      providers/
        ProviderPicker.tsx
        ProviderFieldRenderer.tsx
        provider-form-types.ts
        provider-utils.ts
      credentials/
        CredentialsPage.tsx
      connections/
        ConnectionsPage.tsx
```

Responsibilities:
- `ProviderPicker.tsx`
  shared provider select + custom flow
- `ProviderFieldRenderer.tsx`
  render structured provider fields
- `provider-utils.ts`
  map response payload into form state helpers
- `CredentialsPage.tsx`
  render credential form from provider schema
- `ConnectionsPage.tsx`
  render connection form from same provider catalog

---

## Backend Behavior Changes

### Credentials route

Refactor credential create/rotate flow to:

1. Resolve the provider definition from registry.
2. If provider is structured or hybrid:
   - normalize aliases to canonical keys
   - validate required fields and formats
   - store only canonical keys
3. If provider is custom:
   - accept free-form keys
   - trim values
   - optionally normalize duplicate keys
4. Return structured validation errors using canonical field paths

This replaces provider-specific branching embedded in the route today.

### Connections route

Refactor connection create flow to:

1. Resolve provider definition from registry.
2. Validate that the provider exists unless explicit Custom mode is used.
3. If a credential is selected:
   - verify that the credential provider matches one of the allowed
     `credentialProviderIds`
4. Use `autoCreatesTradingBinding` instead of a route-local hard-coded set
5. Return provider-aware validation errors

This removes the current risk where raw provider text can break connection
behavior or trading binding creation.

---

## Frontend Plan

### Credentials Page

#### Current problem

The credentials page currently:
- keeps a local provider suggestion list
- uses a generic key/value editor
- does not know required fields for supported providers
- does not have a real Custom mode

#### New behavior

1. Fetch provider catalog on modal open or page load.
2. Render a shared provider picker.
3. If a structured provider is selected:
   - render fields from `resources.credentials.fields`
   - map field aliases only on the backend, not in the UI form state
   - submit canonical keys only
4. If Custom is selected:
   - reveal free-form provider name input
   - render free-form secret key/value editor
5. Show provider-specific help text, examples, and field descriptions.

#### UX details

- Supported providers render as a select list.
- Include an explicit Custom option, not a string suggestion.
- Structured providers should not default to the free-form editor.
- Validation errors from the backend should map to field keys like
  `secrets.walletAddress`.

### Connections Page

#### Current problem

The connection form currently:
- uses a raw provider text input
- allows any provider string
- shows all credentials in the dropdown
- depends on exact provider match for linked credentials
- relies on hard-coded provider strings for trading binding creation

This makes the connection form more fragile than the credentials form.

#### New behavior

1. Fetch the same provider catalog used by the credentials page.
2. Render a shared provider picker.
3. If a structured provider is selected:
   - use provider id from the catalog, not free text
   - show provider description if available
   - determine whether credentials are required, allowed, or optional from
     `resources.connections`
4. Filter the credential dropdown to allowed provider ids.
5. If a credential is selected:
   - optionally auto-fill or lock the provider when there is exactly one valid
     provider
6. If Custom is selected:
   - reveal a free-text custom provider input
   - optionally allow linking only custom credentials or no credential
7. Use `autoCreatesTradingBinding` in the UI to communicate whether the
   connection will create a trading binding.

#### UX details

- The provider should be selected before the credential dropdown is enabled.
- If the provider supports only one credential provider id, the dropdown should
  contain only matching credentials.
- The credential option label should not render empty suffixes.
- The connection form should show whether a trading binding will be created.

#### Result

The connections page becomes provider-safe and consistent with the credentials
page. This is required because the connection provider is operational state, not
just display text.

---

## Data Flow

### Credential flow

1. Frontend fetches provider catalog.
2. User selects provider or Custom.
3. Frontend renders structured or free-form fields.
4. Frontend submits provider id plus secrets.
5. Backend resolves provider definition.
6. Backend normalizes aliases and validates.
7. Backend stores canonicalized secret keys.

### Connection flow

1. Frontend fetches provider catalog.
2. User selects provider or Custom.
3. Frontend filters credentials based on provider definition.
4. Frontend submits provider id plus optional credential id.
5. Backend validates provider support and credential/provider match.
6. Backend creates connection.
7. Backend creates trading binding when provider definition says to do so.

---

## Implementation Notes

### Why not infer from TypeScript interfaces?

Interfaces such as `HyperliquidCredentials` are compile-time only. They do not
exist at runtime and cannot directly drive frontend rendering or backend route
validation.

A runtime registry or Zod-based runtime schema is required.

### Suggested validation implementation

For each structured provider:
- field list drives UI metadata
- shared helpers handle common validation primitives
- provider definition owns any extra semantic rules

Examples:
- EVM address regex for `walletAddress`
- hex private key regex for 1inch
- required `apiKey` and `secret` for Bybit

### Zod integration

This registry can be implemented with:
- plain metadata objects plus custom validators
- or Zod-first definitions plus serializer metadata

Recommended approach:
- keep UI metadata in the provider registry
- keep runtime validation functions in provider definitions
- optionally add Zod schemas later if beneficial

---

## Rollout Plan

1. Add shared wire types in `packages/domain`.
2. Add backend provider registry and serializer.
3. Add `GET /providers/catalog`.
4. Refactor credentials route to use provider registry.
5. Refactor connections route to use provider registry.
6. Update frontend API client with provider catalog types and request.
7. Build shared `ProviderPicker` and `ProviderFieldRenderer`.
8. Update credentials page to structured/custom rendering.
9. Update connections page to structured/custom rendering and filtered
   credential selection.
10. Add tests.

---

## Test Plan

### Backend

1. Provider catalog endpoint returns supported providers and custom fallback.
2. Hyperliquid alias normalization still maps:
   - `api-key` -> `apiKey`
   - `account-address` -> `walletAddress`
3. Structured provider validation returns canonical error paths.
4. Custom provider credentials are accepted in custom mode.
5. Connection creation filters credential/provider matches through registry.
6. Trading binding auto-creation is driven by provider definition, not route-local
   hard-coded strings.

### Frontend

1. Credentials page renders structured fields for supported providers.
2. Credentials page reveals free-form editor for Custom.
3. Connection page renders shared provider picker.
4. Connection page filters credentials by provider.
5. Connection page does not show empty credential label suffixes.
6. Structured provider selection submits canonical provider id.
7. Custom provider selection reveals free-text provider entry.

---

## Caveats

1. Backend must remain authoritative even if the frontend renders from schema.
2. Do not expose secrets or sensitive defaults in the catalog response.
3. Not every credential provider is a connection provider.
4. Not every connection provider is a trading provider.
5. Custom mode is necessary to avoid blocking unsupported providers.
6. Schema versioning is required for safe evolution.
7. Field metadata must be stable enough for frontend caching and error mapping.

---

## Alternatives Considered

### Alternative 1 — Frontend-only hard-coded provider forms

Rejected because:
- duplicates backend validation knowledge
- requires frontend edits for every new provider
- does not solve connection/provider drift

### Alternative 2 — Infer everything from TypeScript interfaces

Rejected because:
- interfaces are compile-time only
- no runtime metadata for rendering or validation
- weak support for aliases and semantic rules

### Alternative 3 — JSON Schema or OpenAPI-first contract

Viable later, but not required initially.

Pros:
- standard format
- reusable outside the web app

Cons:
- more ceremony
- weaker ergonomics for alias normalization and UI hints

### Recommended approach

Backend-owned provider registry with shared wire types and runtime validation.

---

## Open Decisions

1. Whether `GET /providers/catalog` should include deprecated providers or hide
   them by default.
2. Whether structured providers should allow free-form extra fields in a hybrid
   mode.
3. Whether connection provider should auto-lock after credential selection.
4. Whether provider catalog should be cached in the frontend for the full session
   or refetched on form open.
5. Whether future provider definitions should move into a shared workspace
   package once the registry grows further.

---

## Summary

This feature introduces a single backend-owned provider registry that powers both
Credentials and Connections.

That solves:
- missing credential field discovery in the frontend
- raw provider text risk in the connection form
- provider drift between frontend and backend
- inability to add providers without frontend changes

It also preserves:
- backend authority
- custom/free-form provider support
- current trading binding model
- evolvability as more providers are added