# LLM Provider Registry

How to add, remove, or modify LLM providers.

## Single Source of Truth

All LLM provider metadata lives in **one file**:

```
packages/domain/src/models/llm-models.ts → PROVIDER_DEFINITIONS
```

The API layer (`apps/api/src/llm-model-catalog.ts`) imports `PROVIDER_DEFINITIONS` directly — there is no
duplicate metadata.

## Adding a New Provider

For a provider with a static model list and no custom catalog behavior, add one entry to `PROVIDER_DEFINITIONS` in `packages/domain/src/models/llm-models.ts`:

```typescript
export const PROVIDER_DEFINITIONS = {
  // ...existing providers...
  deepseek: {
    id: 'deepseek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    catalogMode: 'static',       // 'static' | 'dynamic'
    // isMultiProvider: true,    // optional: routes to multiple backend providers
    // devOnly: true,            // optional: only available in non-production
  },
} as const satisfies Record<string, LlmProviderDefinition>;
```

For that static-provider case, that's it. `KNOWN_LLM_PROVIDERS` and `LLM_PROVIDER_MODELS` are automatically derived and stay in sync.

Providers with runtime-discovered catalogs or provider-specific pricing/discovery behavior still need a matching API-layer implementation in `apps/api/src/llm-model-catalog.ts`. The registry remains the single source of truth for provider metadata, but it does not by itself implement a new dynamic catalog strategy.

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
| `openrouter` | dynamic | ✓ | — |
| `together` | static | — | — |
| `fireworks` | static | — | — |
| `mistral` | static | — | — |
| `cohere` | static | — | — |
| `google` | static | — | — |
| `ollama` | dynamic | — | ✓ |

## Architecture

```
┌─────────────────────────────────────────────┐
│ packages/domain/src/models/llm-models.ts     │
│                                             │
│  PROVIDER_DEFINITIONS  ← single source      │
│  ├─ KNOWN_LLM_PROVIDERS (derived)           │
│  └─ LLM_PROVIDER_MODELS  (derived)          │
│                                             │
│  LlmProviderDefinition  ← interface         │
└────────────────────┬────────────────────────┘
                     │ import
┌────────────────────▼────────────────────────┐
│ apps/api/src/llm-model-catalog.ts           │
│                                             │
│  PROVIDER_METADATA = PROVIDER_DEFINITIONS   │
│  (runtime catalog: OpenRouter fetch,        │
│   Ollama discovery, pricing metadata)       │
│                                             │
│  Domain owns WHAT providers exist.          │
│  API owns HOW to fetch/catalog them.        │
└─────────────────────────────────────────────┘
```

## Removing a Provider

Remove its entry from `PROVIDER_DEFINITIONS`. If any code still references the provider by string
literal, TypeScript will flag it as an error because `LlmProviderId` narrows to the remaining keys.

## Testing

Provider registry tests live in `packages/domain/src/models/llm-models.test.ts`. They verify:

- Every definition has required fields (`id`, `models`, `catalogMode`)
- `KNOWN_LLM_PROVIDERS` matches `PROVIDER_DEFINITIONS` keys
- `LLM_PROVIDER_MODELS` is consistent with `PROVIDER_DEFINITIONS.models`
- Adding a static provider is a single-line operation
