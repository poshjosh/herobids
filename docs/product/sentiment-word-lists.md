# Sentiment Word Lists for Mechanical Strategy

**Status:** Proposed — not yet implemented  
**Date:** 2026-06-27  
**Prior art:** `aitradingbot/src/strategy/sentiment.ts` (Twitter + naive word-list scoring)

---

## Problem Statement

The `MechanicalStrategy` already supports an optional sentiment layer via the
`SentimentProvider` port (`packages/domain/src/ports/sentiment.ts`). When
enabled, the strategy calls `sentimentProvider.getScore(symbol)` and applies a
confidence boost proportional to the sentiment score.

However, the strategy config (`MechanicalParamsSchema`) only exposes a bare
toggle:

```typescript
sentiment: z.object({
  enabled: z.boolean().default(false),
}).default({}),
```

This is insufficient for several reasons:

1. **No tunability.** Users and agents cannot adjust sentiment sensitivity
   (e.g., "require at least 5 tweets before trusting sentiment"). A single
   tweet with "moon" shouldn't move the needle as much as 50 tweets.

2. **No word-list customization.** The aitradingbot reference implementation
   scores tweets by counting positive/negative keyword matches. Different
   trading styles need different vocabularies — a scalper cares about "pump"
   and "dump," a position trader cares about "accumulation" and "distribution."

3. **No threshold gating.** If sentiment is mildly bearish (-0.1), should we
   skip the trade? Or only skip at strong bearish (-0.5+)? The current binary
   "enabled/disabled" gives no control.

4. **No provider selection.** The port abstraction is correct, but the config
   doesn't let the user specify _which_ provider to use or fall back between
   them (Twitter vs LunarCrush vs on-chain social metrics).

---

## Alternative Solutions

### A: No-op / Port-only (Current State)

**What:** Keep `sentiment: { enabled: boolean }`. The `SentimentProvider` port
remains the sole integration point. All tuning (thresholds, word lists, min
tweets) is delegated to the concrete adapter implementation.

**Pros:**
- Zero schema changes
- Adapter authors have full freedom
- Clean separation of concerns

**Cons:**
- Every adapter must reimplement the same tuning concepts (thresholds, min
  tweets) — ad-hoc, inconsistent
- Users/agents cannot configure sentiment behavior from instance config —
  must configure at the adapter level (env vars, operator config)
- No shared vocabulary between adapters — an agent that works well with
  Twitter sentiment may break when switched to LunarCrush

### B: Full Config Parity with aitradingbot

**What:** Port the entire aitradingbot sentiment config directly into
`MechanicalParamsSchema`:

```typescript
sentiment: z.object({
  enabled: z.boolean().default(false),
  minTweetCount: z.number().int().default(5),
  positiveThreshold: z.number().default(0.2),
  negativeThreshold: z.number().default(-0.2),
  maxResults: z.number().int().default(50),
  sampleLimit: z.number().int().default(3),
  positiveWords: z.array(z.string()).default([...]),
  negativeWords: z.array(z.string()).default([...]),
}).default({}),
```

**Pros:**
- Full parity with the reference implementation
- Users and agents get rich control
- Word lists are transparent and auditable

**Cons:**
- Word lists are Twitter-specific — other providers (on-chain metrics, news
  sentiment APIs) don't use keyword matching
- Schema bloat: 2 arrays of 15+ strings each makes the config large and
  noisy for 90% of users who will never tune them
- Maintenance burden: word lists need updating as crypto slang evolves
  ("send it," "jeet," "nuke")
- The aitradingbot word lists include emoji — fragile and provider-specific

### C: Thresholds Only + Provider-Agnostic Config (Proposed)

**What:** Add the provider-agnostic tuning knobs (thresholds, min data points)
to the schema, but leave word lists and provider-specific configuration to
the concrete adapter's operator config.

```typescript
sentiment: z.object({
  enabled: z.boolean().default(false),
  minDataPoints: z.number().int().default(5),
    // Minimum tweets / mentions / data points before trusting
  positiveThreshold: z.number().min(0).max(1).default(0.2),
    // Score above this = bullish signal
  negativeThreshold: z.number().min(-1).max(0).default(-0.2),
    // Score below this = bearish → skip trade entirely
  maxBoost: z.number().min(0).max(0.5).default(0.1),
    // Cap on confidence boost from sentiment (0.1 = max +10%)
}).default({}),
```

Provider-specific configuration (word lists, API keys, circuit breaker
settings, max results, sample limits) stays in operator config under a
dedicated `sentiment` or `apis.sentiment` block — or in the adapter's
own configuration mechanism.

**Pros:**
- Provider-agnostic: works with Twitter, LunarCrush, on-chain social,
  news sentiment, or any future adapter
- Instance-config tunable: users and agents can adjust thresholds without
  touching operator config
- Schema stays lean: 4 numeric fields vs 30+ with word lists
- Word lists stay where they belong: in the adapter's domain
- `positiveThreshold`/`negativeThreshold` map directly to the
  `SentimentResult.score` contract already in the port

**Cons:**
- Less granular than full aitradingbot parity
- Users who want custom word lists must configure the adapter, not the
  instance
- If we build a built-in word-list adapter later, it will need its own
  config block separate from the strategy params

---

## Proposed: Option C — Thresholds Only, Provider-Agnostic

### Rationale

1. **The port already separates concerns correctly.** `SentimentProvider`
   returns a normalized `SentimentResult { score, confidence, source,
   fetchedAt }`. The strategy should only care about "how bullish/bearish is
   the crowd and how confident is that reading?" — not "which words did we
   count?"

2. **Word lists are an implementation detail of one specific provider.**
   The aitradingbot uses Twitter + naive keyword matching. A LunarCrush
   adapter would return analyst-curated scores. An on-chain adapter would
   track whale accumulation. None of these use word lists. Baking word lists
   into the strategy schema couples the abstraction to one implementation.

3. **Thresholds are universal.** Every sentiment provider — whether it counts
   tweets, analyzes on-chain flows, or runs an ML model — produces a score
   in a normalized range. The strategy needs to know "at what score do I act?"
   and "how much do I boost confidence?" These are universal questions.

4. **The aitradingbot word lists were never user-facing.** They were
   hardcoded in `config.example.yaml` as defaults. No UI exposed them.
   They are a reasonable default for a Twitter adapter, not a strategy-level
   concern.

### Schema Addition

```typescript
// In MechanicalParamsSchema:
sentiment: z.object({
  enabled: z.boolean().default(false),
  minDataPoints: z.number().int().min(1).default(5),
  positiveThreshold: z.number().min(0).max(1).default(0.2),
  negativeThreshold: z.number().min(-1).max(0).default(-0.2),
  maxBoost: z.number().min(0).max(0.5).default(0.1),
}).default({}),
```

### Strategy Behavior Change

In `MechanicalStrategy.evaluate()`, the sentiment adjustment at line 125–130
changes from:

```typescript
// Current: simple additive boost with no gating
const boost = sentResult.data.score * sentResult.data.confidence * 0.1;
adjustedConfidence = Math.min(1, Math.max(0, signal.confidence + boost));
```

To:

```typescript
// Proposed: gated by thresholds, capped by maxBoost
const sent = sentResult.data;

// Hard skip if sentiment is strongly against us
if (sent.score < params.sentiment.negativeThreshold && sent.confidence > 0.5) {
  return ok(null); // sentiment veto
}

// Only boost if we have enough data points
if (sent.score > params.sentiment.positiveThreshold) {
  const boost = sent.score * sent.confidence * params.sentiment.maxBoost;
  adjustedConfidence = Math.min(1, Math.max(0, signal.confidence + boost));
}
```

### Future: Concrete Adapter with Word Lists

When we build a concrete Twitter adapter, its configuration (word lists, API
keys, circuit breaker) lives in operator config — not in instance config:

```yaml
# config/default.yaml
sentiment:
  provider: twitter  # twitter | lunarcrush | onchain | noop
  twitter:
    minTweetCount: 5
    maxResults: 50
    sampleLimit: 3
    positiveWords: [bullish, moon, pump, ...]
    negativeWords: [bearish, dump, sell, ...]
    circuitBreaker:
      maxConsecutive429s: 3
      cooldownMs: 300000
```

This keeps provider-specific config out of the JSONB instance config and out
of the strategy schema, while still giving operators full control.

---

## Decision

| Aspect | Decision |
|---|---|
| Add thresholds to `MechanicalParamsSchema`? | ✅ Yes — `minDataPoints`, `positiveThreshold`, `negativeThreshold`, `maxBoost` |
| Add word lists to `MechanicalParamsSchema`? | ❌ No — provider-specific, belongs in adapter config |
| Add provider selection to strategy config? | ❌ No — operator concern, not instance concern |
| Build a concrete Twitter adapter now? | ❌ Defer — `MechanicalStrategy` works fine with `sentimentProvider: null` |
| Reference aitradingbot word lists for adapter later? | ✅ Yes — keep as reference implementation for the future Twitter adapter |

---

## References

- `packages/domain/src/ports/sentiment.ts` — `SentimentProvider` port
- `packages/strategy/src/mechanical-strategy.ts:123–130` — current sentiment integration
- `aitradingbot/src/strategy/sentiment.ts` — reference Twitter + word-list implementation
- `aitradingbot/config.example.yaml#indicators.sentiment` — reference word lists
- `docs/features/2026/06/16/003-rich-strategy-parity/000-contemplations.md#decision-4` — original sentiment design decision
