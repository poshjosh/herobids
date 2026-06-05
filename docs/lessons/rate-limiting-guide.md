# Rate Limiting — Survival Guide

Rate limit related wisdom from /Users/chinomso.ikwuagwu/dev_ai/aitradingbot/docs/tech/rate-limiting-guide.md. It covers what will bite you, why non-obvious decisions were made, and operational knowledge that took real debugging to discover.

For API reference (constructor params, config schema, method signatures), read `src/utils/rate-limiter.ts` directly — it's well-commented.

---

## The Core Problem: Tight Budgets

The primary market data provider (GeckoTerminal) gives you **10 API calls per minute** on the free tier. That's one call every 6 seconds — shared across every process that touches the API. Meanwhile, the bot needs to:

- Discover trending tokens (1 call)
- Look up pool addresses for each candidate (1 call per token)
- Fetch OHLCV candles for signal analysis (1 call per token)
- Monitor open positions' prices (continuous)

With 10/min budget, scanning 5 tokens for signals burns through your entire minute's budget instantly. This is the fundamental tension the rate-limiting system exists to manage: **discovery wants to explore broadly, but position monitoring needs guaranteed access to check stop-losses.**

### How the system handles this

The budget is split with a priority system. "Discovery" calls (trending, OHLCV, pool lookups) get a capped percentage (default 50%) of the total budget. "Default" priority calls (position price monitoring) can use the full budget. Both priorities share one counter — discovery just hits a lower ceiling.

Example at 10/min with 50% discovery budget:
- Discovery hits the wall at 5 calls in the window
- Position monitoring can use all 10
- Total actual calls never exceed 10

This means if you have 3 open positions being monitored, discovery still gets ~5 slots. If you have 8 positions hammering prices, discovery is starved but positions stay protected.

### Monthly budgets add another layer

GeckoTerminal's paid plans have monthly call limits (e.g., 100K/month for Basic). The rate limiter dynamically reduces the per-minute rate as the monthly budget depletes. It distributes remaining budget across remaining minutes in the billing cycle with a 3× burst multiplier for short-term flexibility.

At >90% monthly budget consumed, discovery is blocked entirely. The system preserves remaining calls for position monitoring only.

---

## Why Jupiter Is NOT Shared via Redis

This looks like a bug when you first encounter it — every other provider shares its rate counter via Redis, but Jupiter doesn't. Here's why:

**Jupiter rate-limits per IP address**, not per API key.

- On ECS/Fargate: each container has its own IP → each bot legitimately gets a full 30/min budget from Jupiter's perspective. Sharing via Redis would artificially restrict bots to 30/min total when they could each use 30/min independently.
- On local Docker: all containers share one IP, so aggregate calls *can* exceed Jupiter's limit. But the MarketDataCoordinator centralizes price polling, so bots rarely call Jupiter directly anyway.

If you're tempted to "fix" this by adding Redis to the Jupiter rate limiter, don't. You'll halve every bot's position monitoring capacity for no benefit. The design doc for a future shared-with-reservation approach lives at `docs/features/pending/per-bot-reservation-plan.md`.

---

## Coordinating Multiple Bots

### The right way: MarketDataCoordinator

The API server process runs a `MarketDataCoordinator` that polls providers centrally and publishes snapshots to Redis. All bots read snapshots. Zero rate-limit contention.

- Discovery: polled every 2 minutes, results written to `mdc:discovery`
- Prices: polled every 15 seconds for all demanded tokens, written to `mdc:price:{address}`
- Bots register "demand leases" when they open positions so the coordinator knows what to poll

When the coordinator is healthy, rate limiting barely matters for individual bots — they just read Redis.

### The fallback: shared counters

When the coordinator is down (or disabled), bots fall back to direct provider calls with shared Redis rate counters. This is where things get painful:

- **All processes share one sliding-window counter** in a Redis sorted set
- A Lua script atomically prunes old entries + checks count + adds new entry (no race conditions)
- But contention is severe. In production with bot + agent + coordinator sharing 10/min effective budget, the agent alone caused ~43% of rejections. It's doing broad discovery scans while the bot needs price checks.

### What happens when Redis goes down

Everything degrades gracefully but imperfectly:
- Rate limiting falls back to in-memory (per-process) counters — so multiple bots may independently exhaust provider limits
- Response cache becomes per-bot (no sharing) — redundant fetches occur
- The bot keeps running. It's degraded mode, not fatal.

---

## Gotchas & Hard-Won Lessons

### 1. Nested rate-limited calls poison the cache

This was a production bug that took hours to diagnose.

`getOHLCV()` internally called `getTopPoolAddress()`. Both went through the rate limiter. When the inner pool lookup was rate-limited, it returned `null`. The outer OHLCV call then saw `null` pool → returned `[]` → **cached `[]` for the full 60s TTL**. For the next minute, every scan of that token got cached empty results.

**Fix**: Pool lookup was moved OUTSIDE the outer `call()`. Now if the pool lookup fails, the OHLCV call isn't even attempted — no outer rate slot wasted, no empty result cached.

**General rule**: Never nest `rl.call()` inside another `rl.call()`. Resolve dependencies first, then make the outer call.

### 2. Empty results need short cache TTLs

Even after un-nesting, empty/null results can still get cached (e.g., a token genuinely has no pools yet, or the API returned an error). If cached at the full 60s TTL, retries are blocked for a full minute.

The system now uses `Math.min(baseTtl, 30_000)` for empty results. This is a reasonable balance — 30s is enough to prevent hammering a genuinely-missing resource, but short enough to recover quickly from transient failures.

### 3. The +1ms boundary trap

The wait-for-capacity code calculates: `(oldestInWindow + 60_000) - now + 1`

That `+ 1` is not sloppy math. The sliding window prunes entries with `score <= windowStart`. If you sleep exactly to the boundary, the oldest entry has score **equal to** windowStart and is pruned — but the implementation uses `>=` for the window start comparison when counting. Sleeping +1ms pushes past this boundary reliably.

### 4. Pacing is local, rate limiting is shared

These are separate mechanisms that people confuse:
- **Pacing** (`minIntervalMs`): Per-process only. Spaces YOUR calls evenly. At 10/min, it adds a 6s delay between consecutive calls from the same process. Prevents one process from bursting.
- **Rate limiting** (sliding window): Shared via Redis. Hard cap on total calls from ALL processes within 60s.

Pacing runs first. Even after pacing passes, the shared rate limit can still reject you (because other processes filled the window while you were sleeping).

### 5. `maxStalenessMs` prevents silent disasters

Without this, a prolonged rate-limit episode would keep returning older and older cached prices. Imagine a stale price from 2 hours ago being used for stop-loss evaluation — you'd either miss a real crash or trigger a false stop.

The staleness check ensures cached entries older than `maxStalenessMs` are discarded and the fallback value is returned instead. For Jupiter (position monitoring), this is 30s — you never want to evaluate SL/TP against a price more than 30s old.

### 6. The system self-heals via pressure backoff

When rate-limit rejections pile up, `getPressure()` rises (0–1 scale). The trading loop uses this to automatically double its scan interval:

```
pressure > 0.4  →  backoff ramps quadratically (1× → 4× at saturation)
```

This means: when the rate limiter is under stress, the bot automatically scans less frequently, reducing demand, which reduces pressure, which eventually restores normal scanning. It's a negative feedback loop that prevents the system from thrashing.

### 7. Provider APIs rate-limit differently — know your enemy

| Provider | Limit basis | Typical free tier | Key insight |
|---|---|---|---|
| GeckoTerminal | API key | 10/min (demo), 30/min (demo key) | Tightest budget; the one that dominates design decisions |
| Jupiter | IP address | ~60/min | Per-container budget; don't share |
| Birdeye | API key | 10/min | Solana only; opt-in |
| DexScreener | IP address? | 30/min | No OHLCV support; discovery + overview only |
| Binance | IP address | 1200/min | Practically unlimited for our needs |
| CoinMarketCap | API key | 5/min, 10K/month | Monthly budget is the real constraint |

---

## When Things Go Wrong — Debugging Checklist

1. **"No signals generated"** — Check if discovery is being rate-limited. Look for `[geckoterminal] Rate limit reached (discovery)` in logs. The bot might be scanning 0 candidates because trending/OHLCV calls are all rejected.

2. **"Stale prices / missed stop-losses"** — Check `maxStalenessMs`. If it's too permissive (or Infinity), the system might be using ancient cached prices. Also check if Jupiter is reachable — it's the primary price source for positions.

3. **"Works with 1 bot, breaks with 2"** — Classic shared-counter contention. Either enable the MarketDataCoordinator (preferred) or increase the provider's plan to get more API calls.

4. **"Monthly budget exhausted mid-month"** — The agent is often the culprit. It does broad discovery scans consuming many calls. Check `getBudgetStatus()` for runway analysis. Consider reducing agent scan frequency or increasing `cacheTtlMs` to reduce call volume.

5. **"Pool lookups succeeding but OHLCV returning empty"** — Might be cache poisoning from an earlier failure. Wait 30s (the short-TTL for empty results) and check again. If persistent, the token genuinely has no OHLCV data on that provider.
