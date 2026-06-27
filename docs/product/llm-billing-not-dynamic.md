# LLM BILLING NOT DYNAMIC

## PROMPT

Why do we have PROVIDER_DEFINITIONS in packages/domain/src/models/llm-models.ts when we can dynamically loaded those same values, and I guess we do?

## RESPONSE

Good catch — the situation is more nuanced than it first appears. There **is** dynamic pricing fetching, but it's only used for **UI display**, not for **billing**. Here's how it breaks down:

### Two separate concerns, two separate code paths:

| Purpose | Where it happens | For which providers |
|---------|-----------------|---------------------|
| **UI catalog display** | llm-model-catalog.ts → `fetchOpenRouterCatalog()` dynamically fetches pricing from OpenRouter's API | Only OpenRouter (the rest use static `PROVIDER_DEFINITIONS`) |
| **Billing / charging users** | `getLlmModelRateCardItems()` reads from static `PROVIDER_DEFINITIONS` | ALL providers including OpenRouter |

### So what actually happens with OpenRouter?

1. The user sees **live pricing** in the UI (fetched dynamically via OpenRouter API)
2. The user selects a model and starts an agent
3. The agent runs, usage events are emitted
4. `computeCharge()` looks up the rate card seeded from **static** `PROVIDER_DEFINITIONS` — NOT the dynamic data
5. If OpenRouter changed their prices since you wrote the static config, **you charge the wrong amount**

### The static pricing is the billing source of truth — and that's the bug

The `PROVIDER_DEFINITIONS` serves a real purpose as the **rate card seed** — every model must have a price in the billing system. But for OpenRouter, the static prices can go stale because you're not updating the rate card from the dynamically fetched data.

The dynamic fetch gets the prices from OpenRouter... but nobody writes them back to `billing_rate_card_items`. So the UI says "$0.25/1M tokens" but billing charges the static "$0.30/1M tokens" from the config.

So removing the dynamic fetch wouldn't help — the real fix would be to **close the loop**: seed rate card items from the dynamically fetched OpenRouter prices, so billing always matches reality.