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
| `devOnly` | `boolean` | Provider is only available in non-production environments (e.g. local Ollama) |

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

## Removing a Provider

Remove its entry from `config/providers.yaml`.

## Testing

Provider catalog tests live in `apps/api/src/routes/ai.test.ts` and `packages/domain/src/models/llm-models.test.ts`. They verify:

- Static providers from `providers.yaml` produce correct catalog entries
- `deriveLatestVariants` generates `:latest` aliases from versioned model IDs
