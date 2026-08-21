# LLM Provider Registry

How to add, remove, or modify LLM providers.

## Single Source of Truth

LLM provider metadata lives in two places:

```
config/providers.yaml            ← operator-configurable registry (single source)
PostgreSQL llm_pricing_snapshots ← active pricing snapshots (fetched hourly by worker)
```

The API layer (`apps/api/src/llm-model-catalog.ts`) reads `providers.yaml` at startup and queries
`llm_pricing_snapshots` for runtime pricing. Static providers are seeded on first deploy;
OpenRouter pricing is refreshed hourly by the worker.

## Adding a New Provider

Add an entry to `config/providers.yaml` under `providers:`:

```yaml
# config/providers.yaml
providers:
  # ...existing providers...
  deepseek:
    catalogMode: static         # 'static' | 'dynamic'
    # isMultiProvider: true     # optional: routes to multiple backend providers
    # devOnly: true             # optional: only available in non-production
    models:
      deepseek-chat:
        inputUsdPerM: 0.32
        outputUsdPerM: 0.89
      deepseek-reasoner:
        inputUsdPerM: 0.55
        outputUsdPerM: 2.19
```

For static providers, that's it — deploy and the provider appears in the catalog. For dynamic
providers (e.g. OpenRouter), the worker fetches pricing into `llm_pricing_snapshots` automatically.

### Catalog Modes

| Mode | When to use | Example |
|------|------------|---------|
| `static` | Fixed model list known at build time | OpenAI, Anthropic, Together |
| `dynamic` | Models discovered at runtime via API and backed by an existing catalog implementation | OpenRouter, Ollama |

### Optional Fields

| Field | Type | Purpose |
|-------|------|---------|
| `isMultiProvider` | `boolean` | Provider routes to multiple backend LLM providers (e.g. OpenRouter) |
| `devOnly` | `boolean` | Provider is only available in development environments (e.g. local Ollama) |

## Current Providers

| Provider | Catalog Mode | Multi-Provider | Dev Only |
|----------|-------------|----------------|----------|
| `openai` | static | — | — |
| `anthropic` | static | — | — |
| `deepseek` | static | — | — |
| `google` | static | — | — |
| `openrouter` | dynamic | ✓ | — |
| `ollama` | dynamic | — | ✓ |

## Architecture

```
┌─────────────────────────────────────────────┐
│ config/providers.yaml                       │
│                                             │
│  providers:  ← operator-configurable        │
│    openai:     catalogMode: static          │
│    openrouter: catalogMode: dynamic         │
│    ...                                      │
└────────────────────┬────────────────────────┘
                     │ loaded at startup
┌────────────────────▼────────────────────────┐
│ apps/api/src/llm-model-catalog.ts           │
│                                             │
│  Reads providers.yaml + llm_pricing_        │
│  snapshots (DB). Static providers seeded    │
│  from YAML; OpenRouter pricing refreshed    │
│  hourly by worker into DB.                  │
└─────────────────────────────────────────────┘
```

## OpenRouter Request Privacy Controls

OpenRouter account-wide privacy settings (configured in the OpenRouter dashboard) remain recommended, but application requests also enforce privacy and routing controls at the request level. Neither layer alone is sufficient for compliance-sensitive guarantees (e.g. Google Limited Use); both must be active.

### Supported Fields

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `dataCollection` | `'allow' \| 'deny'` | `'deny'` | Controls whether downstream providers can use prompts for training |
| `zdr` | `boolean` | `true` | Zero Data Retention — no prompts/completions stored by OpenRouter |
| `allowFallbacks` | `boolean` | unset | Whether to allow fallback to alternative models |
| `only` | `string[]` | unset | Restrict routing to listed provider slugs |
| `order` | `string[]` | unset | Preferred provider order |

### Phase 1 Defaults

The initial rollout enforces the minimum controls needed for compliance:

- `dataCollection: deny` — always set
- `zdr: true` — always set
- `allowFallbacks`, `only`, `order` — intentionally unset

Rationale: `dataCollection: deny` and `zdr: true` directly address compliance concerns (Google Limited Use). More restrictive controls like `only`, `order`, and `allowFallbacks: false` narrow routing and can reduce resilience — reserved for later phases after live validation.

### Configuration

Operator config in `config/default.yaml`:

```yaml
llm:
  openRouterProviderControls:
    dataCollection: deny
    zdr: true
    # allowFallbacks, only, order intentionally unset — see plan Phase 2/3
```

Zod schema (`packages/domain/src/config/schema.ts`):

```ts
export const OpenRouterProviderControlsSchema = z.object({
  dataCollection: z.enum(['allow', 'deny']).default('deny'),
  zdr: z.boolean().default(true),
  allowFallbacks: z.boolean().optional(),
  only: z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
});
```

When the config block is omitted entirely, defaults apply (`dataCollection: 'deny'`, `zdr: true`).

### Wire Format

The shared LLM client emits a `provider` object in OpenRouter request bodies. Only defined fields are sent; the object is omitted entirely for non-OpenRouter providers.

```json
{
  "model": "deepseek/deepseek-v4-pro",
  "messages": [...],
  "provider": {
    "data_collection": "deny",
    "zdr": true
  }
}
```

Field mapping: `dataCollection` → `data_collection`, `allowFallbacks` → `allow_fallbacks`. Other fields map 1:1.

### Two-Layer Enforcement

| Layer | Where | What it covers |
|-------|-------|----------------|
| Account-level | OpenRouter dashboard | Global default for all requests from the org |
| Request-level | This feature (`openRouterProviderControls`) | Per-request enforcement regardless of dashboard state |

Both layers must be active. The account-level setting protects against application bugs or misconfiguration. The request-level setting protects against dashboard drift or multi-tenant account sharing.

## Removing a Provider

Remove its entry from `config/providers.yaml`.

## Testing

Provider catalog tests live in `apps/api/src/routes/ai.test.ts` and `packages/domain/src/models/llm-models.test.ts`. They verify:

- Static providers from `providers.yaml` produce correct catalog entries
- `deriveLatestVariants` generates `:latest` aliases from versioned model IDs
