# Provider Catalog Filters — Minimal Config Shape

This note sketches the smallest useful operator-config shape for a long-term
`dynamic catalog + curated filters` model-selection system.

It is intentionally narrower than a full provider-catalog redesign. The goal is
to define the minimum config surface that lets the platform:

- discover models dynamically,
- filter out noisy or unsupported models,
- preserve the currently configured model,
- and avoid maintaining a brittle allowlist that falls behind vendor catalogs.

Related backlog item:

- [002-ollama-dynamic-model-discovery.md](./002-ollama-dynamic-model-discovery.md)

---

## Design Intent

The long-term source of truth is the discovered provider catalog, not a static
allowlist.

The platform then applies a small filter policy to remove models it does not
want to expose in the `lightModel` / `heavyModel` UI.

That means the config should focus on exclusion and fallback behavior, not on
enumerating every valid model.

---

## Minimal YAML Shape

```yaml
llm:
  catalog:
    mode: dynamic
    timeoutMs: 3000
    cacheTtlMs: 15000
    preserveConfiguredModel: true
    baseFilters:
      excludeCapabilities: []
      excludeLifecycle: []
      excludePatterns: []
    providers:
      ollama:
        filters:
          excludeCapabilities: ['embedding']
          excludeLifecycle: []
          excludePatterns:
            - '^nomic-embed'
            - 'embed$'
      openai:
        filters:
          excludeCapabilities: ['embedding', 'image', 'audio', 'moderation']
          excludeLifecycle: ['deprecated', 'preview']
          excludePatterns:
            - '^whisper'
            - '^tts'
            - 'audio'
      openrouter:
        filters:
          excludeCapabilities: ['embedding', 'image', 'audio', 'moderation']
          excludeLifecycle: ['deprecated', 'preview']
          excludePatterns: []
```

---

## Meaning Of Each Field

### `llm.catalog.mode`

```yaml
mode: dynamic
```

Top-level policy switch for how provider model lists are sourced.

Expected values:

- `static` — current-style static provider lists
- `dynamic` — discover first, then filter

For the long-term direction discussed here, `dynamic` is the intended default.

Note: `mode: dynamic` applies only to providers that have an explicit catalog
client. Hosted providers without a dynamic discovery endpoint continue using
their static model lists regardless of this setting.

### `llm.catalog.timeoutMs`

```yaml
timeoutMs: 3000
```

Short fetch timeout for catalog discovery. This should be independent from
`llm.timeoutMs`, which is tuned for actual generation calls and is too large for
settings-page model discovery.

### `llm.catalog.cacheTtlMs`

```yaml
cacheTtlMs: 15000
```

Short in-memory cache TTL for discovered catalogs. This reduces UI latency and
avoids hitting providers repeatedly while still allowing local catalog changes to
show up quickly.

### `llm.catalog.preserveConfiguredModel`

```yaml
preserveConfiguredModel: true
```

If enabled, the operator-configured or user-saved selected model is kept in the
returned model set even when discovery metadata is incomplete or filter rules
would otherwise remove it.

This is a safety valve to avoid breaking the UI or invalidating existing saved
config during catalog churn.

### `llm.catalog.baseFilters`

```yaml
baseFilters:
  excludeCapabilities: []
  excludeLifecycle: []
  excludePatterns: []
```

Baseline filter policy applied before any provider-specific filters.

This keeps the config surface small and avoids duplicating common filter rules
for every provider.

Provider-specific filters under `providers.*` are **additive**: they augment
`baseFilters`, not replace them. An empty `excludePatterns: []` at the provider
level means no additional patterns beyond the base, not "clear the base
patterns."

### `excludeCapabilities`

```yaml
excludeCapabilities: ['embedding', 'image', 'audio', 'moderation']
```

Exclude models by inferred or provider-supplied capability class.

Suggested canonical values:

- `embedding`
- `image`
- `audio`
- `moderation`
- `transcription`
- `reranking`

This should be used only when the provider exposes enough metadata to classify
models reliably, or when the platform has a provider-specific classifier.

### `excludeLifecycle`

```yaml
excludeLifecycle: ['deprecated', 'preview']
```

Exclude models based on vendor lifecycle state.

Suggested canonical values:

- `deprecated`
- `preview`
- `legacy`

This is most useful for hosted providers that expose lifecycle metadata.

### `excludePatterns`

```yaml
excludePatterns:
  - '^whisper'
  - '^tts'
  - 'audio'
```

Provider-specific name-pattern filters used when metadata is incomplete,
inconsistent, or absent.

This is the smallest useful escape hatch and probably the most important field
for a first implementation.

Pattern semantics should be simple and explicit:

- regex strings, evaluated case-insensitively
- exclude if any pattern matches
- preserve configured model after filtering if `preserveConfiguredModel=true`

---

## Minimal TypeScript Shape

```ts
export interface LlmCatalogFilterConfig {
  excludeCapabilities: string[];
  excludeLifecycle: string[];
  excludePatterns: string[];
}

export interface LlmCatalogProviderFilterConfig {
  filters: LlmCatalogFilterConfig;
}

export interface LlmCatalogConfig {
  mode: 'static' | 'dynamic';
  timeoutMs: number;
  cacheTtlMs: number;
  preserveConfiguredModel: boolean;
  baseFilters: LlmCatalogFilterConfig;
  providers: {
    [provider: string]: LlmCatalogProviderFilterConfig;
  };
}
```

This is intentionally minimal. It avoids policy fields for ranking, provider
health, preferred defaults, or UI labels until those needs are real.

---

## Expected Filter Order

The platform should apply filters in a fixed order:

1. Discover provider catalog.
2. Normalize model names and metadata.
3. Apply `default` filters.
4. Apply provider-specific filters.
5. Re-add the configured model if `preserveConfiguredModel=true`.
6. Deduplicate and sort.

That order keeps the rules predictable and makes debugging easier.

---

## Why This Is Minimal

This shape intentionally does **not** include:

- explicit allowlists,
- per-model labels,
- ranking weights,
- per-user overrides,
- provider-specific discovery URLs,
- separate light/premium filtering policies.

Those may become useful later, but they are not needed to prove the core model:
`discover broadly, filter narrowly, preserve configured model`.

---

## Recommended First Slice

If this ever gets implemented, the smallest high-value first slice is:

1. support `excludePatterns` only,
2. support `preserveConfiguredModel`,
3. add `timeoutMs` and `cacheTtlMs`,
4. leave `excludeCapabilities` and `excludeLifecycle` as schema fields that may
   remain unused until a provider actually supplies usable metadata.

That gives the platform a working filter policy with very little complexity.
