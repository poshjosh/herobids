**LLM / agent**
1. `agent-llm-runtime-hardening`
   - Tick loop must not fail arbitrarily.
   - Recoverable vs non-recoverable LLM/tool errors.
   - Retry, backoff, heartbeat, and fallback behavior.
   - How to avoid leaking internal thinking text into user-visible output.
2. `agent-context-prioritization-and-progress`
   - What must be in agent prompt context.
   - What order it should appear in.
   - What gets trimmed first under constrained context.
   - Progress score / objective progress at the end of the prompt.
3. `agent-cost-presets-and-spend-planning`
   - Daily spend presets and custom spend budgets.
   - How spend maps to tick interval, model tier, gating, and tool access.
   - Recommended spend by capital / runtime duration.
4. `agent-bootstrap-admin-and-credential-validation`
   - First admin creation.
   - Credential validation and fail-fast startup checks.
   - Minimum secrets/config required for an agent to run safely.
5. `agent-logs-and-observability`
   - Whether API/worker logs should stay JSON.
   - What fields must be present for agent debugging and cost attribution.
   - Which events should be structured vs plain text.

**Trading data / market-data**

1. `market-data-provider-strategy-and-coverage`
   - Provider matrix across aitradingbot and herobids.
   - What each provider supports.
   - Which data is free, which is paid, and what is actually worth keeping.
   - Clear recommendation on whether to add more providers or not.
2. `market-data-rate-limit-lab`
   - Multi-agent load testing against free-tier budgets.
   - Behavioral testing, not just functionality testing.
   - Report format for provider pressure, fallbacks, and degradation.
3. `market-data-fallback-and-degradation-policy`
   - What happens when one provider is missing, stale, or rate-limited.
   - Fallback order, TTLs, and stale-data acceptance rules.
   - What data is acceptable for agents under partial outage.
4. `agent-data-contract-by-venue`
   - Which data points agents should see for Hyperliquid, Bybit, Binance, Jupiter, DexScreener, GeckoTerminal.
   - What gets injected into context versus fetched lazily via tools.
   - Which data is critical for short bias, regime awareness, and execution quality.
