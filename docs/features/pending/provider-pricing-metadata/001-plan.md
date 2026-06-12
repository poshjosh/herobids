# Provider Pricing Metadata

Surface model/provider pricing in the UI without maintaining a hand-curated price table. Use OpenRouter's machine-readable pricing fields when the provider is OpenRouter, and show `Free` only for truly local/self-hosted providers like Ollama when they are actually local.

## Background

The current AI model picker only returns provider names and model lists from the `/ai/available-models` path. That is enough to render a usable selector, but not enough to tell users whether a provider is free, local, or usage-based.

We already have a dynamic provider catalog and model fetch flow. What is missing is a pricing-aware metadata layer that can be sourced from provider APIs or provider-local configuration, instead of a static curated list.

## Scope

### In scope

- Extend the provider catalog response so it can carry pricing metadata alongside provider and model names.
- Use OpenRouter's model API pricing fields as the source of truth when the provider is OpenRouter.
- Mark `Free` only for providers that are actually local/self-hosted in the current deployment, such as Ollama when it is backed by a local/baseUrl-local service.
- Render provider name plus price label in the frontend model picker.
- Add focused tests for provider pricing metadata mapping and UI rendering.

### Out of scope

- Maintaining a manually curated global price table.
- Inferring pricing from model names or provider names alone.
- Building a full billing system or cost estimator.
- Showing a price for providers when no trusted pricing source exists.

## Constraints

### No curated price list

Pricing must come from the provider catalog or deployment configuration, not from a repository-maintained table of vendor prices.

### OpenRouter is the only provider with machine-readable pricing in this plan

OpenRouter's model list API includes a `pricing` object per model. That data should be used directly, rather than duplicated in the app.

### Local means local

Only show `Free` when the provider is truly local/self-hosted in the current deployment. Do not label a remote managed service as `Free` just because it is Ollama-compatible or self-hosted in another environment.

### Prefer a single source of truth per provider

If a provider exposes pricing in its own API payload, use that payload. If it does not, do not invent or duplicate the numbers in the frontend.

## Proposed Design

### 1. Extend the provider catalog response

Add an optional pricing shape to the provider model response returned by `/ai/available-models`.

Suggested shape:

```ts
interface AiAvailableModelProvider {
  provider: string;
  displayName?: string;
  models: string[];
  pricing?: {
    label: string; // e.g. "Free", "$5/$25", "Usage-based"
    source: 'openrouter' | 'local';
    inputUsdPer1M?: string;
    outputUsdPer1M?: string;
    requestUsd?: string;
  };
}
```

Keep the shape flexible enough to display a short label while still preserving the underlying numeric fields when they exist.

### 2. Populate pricing from OpenRouter when provider is OpenRouter

When the provider is OpenRouter, fetch the provider's model list and read the returned `pricing` object. Derive a human-friendly label from the model(s) returned for that provider.

If the provider catalog already groups OpenRouter models per provider, use the returned model payload as the source of truth for:

- prompt/input pricing
- completion/output pricing
- request pricing when present
- free pricing when all relevant values are zero

### 3. Mark local/self-hosted providers as `Free` only when local

For Ollama and any other local/self-hosted provider support added later, infer `Free` from deployment/runtime configuration that proves the provider is local.

Examples of valid signals:

- a local loopback base URL
- a local Unix socket or Docker-internal endpoint known to be on the same host
- explicit operator config marking the provider as local/self-hosted

Do not infer `Free` from the provider name alone.

### 4. Keep non-OpenRouter remote providers unlabeled unless metadata exists

For providers like OpenAI and Anthropic, do not create a curated pricing map in the app. If the provider does not expose trusted pricing metadata in the fetched payload, leave the pricing field absent or use a neutral label such as `Usage-based` only if that can be justified from authoritative data.

### 5. Render pricing alongside provider name in the UI

Update the model picker so the provider selector can show a compact label like:

- `OpenRouter · $0.00003/$0.00006`
- `Ollama · Free`
- `Anthropic · Usage-based`

Prefer a short, scannable label over a long tooltip-first design.

### 6. Add tests for pricing mapping and rendering

Add focused tests that cover:

- OpenRouter pricing metadata is passed through from the fetched model payload
- local/self-hosted providers render `Free` only when the config says they are local
- remote providers do not get an invented price label
- the provider selector renders the pricing suffix next to the provider name

## Plan

1. **Extend the AI available-models response shape**
   Update the shared API client types and the backend response model so provider entries can include optional pricing metadata.
   Dependency: none.

2. **Map pricing in the backend catalog layer**
   When fetching provider models, read OpenRouter's pricing fields from the model payload and convert them into a short provider-level label. Add a local/self-hosted pricing path for providers that are provably local in the current deployment.
   Dependency: step 1.

3. **Wire the new metadata through the frontend**
   Update the model picker to render provider name plus pricing label, keeping the existing model list behavior intact.
   Dependency: steps 1 and 2.

4. **Add targeted tests**
   Cover the OpenRouter pricing mapping, local-only `Free` labeling, and provider option rendering.
   Dependency: steps 1 through 3.

## Verification

- `pnpm lint` passes.
- The model picker shows a pricing label when provider pricing metadata is present.
- OpenRouter pricing comes from the fetched model payload, not a hard-coded table.
- Ollama is shown as `Free` only when the deployment is truly local.

## Notes

- This plan intentionally avoids a curated pricing registry.
- If a provider later exposes reliable pricing in its API, it can be added as a provider-specific path without changing the frontend contract.
