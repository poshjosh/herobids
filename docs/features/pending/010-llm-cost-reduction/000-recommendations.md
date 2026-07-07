# RECOMMENDATIONS TO SAVE LLM COST

The fastest savings are from suppressing useless LLM invocations, not from prompt micro-optimizations. Across the seven eval folders under 2026-07-06, the sessions burned about `24.2M` input tokens and `4.1M` output tokens, while cached input was already very high, about `29.5M`. That tells me caching is already helping; the remaining waste is mostly repeated reasoning under broken or unchanged state, not a cache miss problem.

1. Add a hard session-level circuit breaker for error and drift loops.
Evidence is strongest in REPORT.md, which shows `17,114` strategy errors, `1,425` disconnects, `1,319` drift detections, and `3.58M` input tokens plus `604k` output tokens for only six fills; the report explicitly recommends a breaker in REPORT.md. The same pattern appears in REPORT.md, where no decisions happened after the first minute but the session still consumed `1.08M` input tokens, and in REPORT.md where drift dominated the session. If you only do one thing, do this: after something like `N` consecutive `strategy.error` or `strategy.fatal`, or `M` drift detections in `T` minutes, stop all LLM calls and put the session into cooldown or terminate it.

2. Stop timer-based LLM polling when the state is unchanged and all watches are `not_met`.
You already have deterministic watch infrastructure, and the snapshots show it. redis-snapshot.json shows the agent effectively waiting on a single unmet LIT breakout watch. redis-snapshot.json shows ten unmet TP/SL watches. redis-snapshot.json shows six unmet fail-safe or stop-loss watches. In those states, scheduled LLM reasoning should be skipped until one of a small set of wake conditions happens: a watch flips, a fill lands, a position changes, a risk limit changes, or a disconnect/recovery event materially changes state. This is probably the cleanest quick win after the breaker.

3. Add an unchanged-context gate before every LLM call.
REPORT.md says the journal had exactly two plans, two decisions, and two fills, then the loop effectively went dormant, yet the cost file still shows heavy burn in costs.json. That is a classic context-hash miss: if positions, pending orders, watch statuses, risk state, and regime summary have not changed, there is no reason to re-run the model. This is cheaper and safer than trying to compress prompts further.

4. Fail invalid bot configs before launch, and do not retry them into the reasoning loop.
There are repeated `strategy.config_invalid` fatals across multiple sessions: journal.json, journal.json, journal.json, journal.json, and journal.json. That is an easy savings target: validate before spawn, mark the bot/session invalid, and block all further LLM-driven retries until the config changes.

5. Enforce `maxBots` as a cost-control mechanism, not only a risk rule.
Several sessions exceeded the configured two-bot/two-position intent and then spiraled into drift and noisy state repair: REPORT.md, REPORT.md, and REPORT.md. The raw Redis state for redis-snapshot.json even shows six positions at 20% cap and zero idle capital. This is probably a slightly larger fix than the breaker, but it likely saves a lot because phantom or excess actors create the drift that then wakes the LLM again.

One thing I would not prioritize first is more prompt caching or a scout/judge rewrite. Prompt caching is already materially active in files like costs.json, costs.json, and costs.json. The bigger leak is calling the model when the system is broken or nothing meaningful changed.
