# Bug Report: Agent Submits Decisions for Tokens Not Available on Venue Chain

- **Status:** OPEN
- **Severity:** Medium
- **Date:** 2026-06-18
- **Discovered:** evaluate-agent-and-fix — t1inch agent (0d4b36a3) has 2 go_long decisions in "recent decisions" but nothing in "trade history".
- **Summary:** Agent submitted go_long for SOL/USDC on the 1inch/Base venue, but SOL does not exist on Base chain. The token safety check correctly rejected both decisions with `token.not_found`, resulting in decisions with no corresponding trades.

## Symptoms

- Agent has 2 `go_long` decisions for `SOL/USDC` with execution plans in `failed` status.
- Decision failure records:
  - 2× `token.not_found` — "Token SOL on base could not be resolved"
- No orders, fills, or positions were created.
- UI shows decisions in "recent decisions" but nothing in "trade history" (trade history correctly excludes failed decisions).

## Root Cause

The t1inch agent is configured with the 1inch venue on **Base** chain (chainId 8453). SOL is a Solana-native token and does not exist on Base chain with sufficient DEX liquidity for 1inch swaps.

`resolveSwapTokenData()` correctly:
1. Attempts canonical lookup for `SOL` on `base` network → no match (SOL is only canonical on `solana` network).
2. Searches DexScreener for SOL on Base → no exact match.
3. Returns `null` → triggers `token.not_found` rejection.

The engine's swap token safety guard correctly rejects the decision before execution. The rejection is **correct behavior** — the token genuinely does not exist on the venue's chain.

However, the agent does not learn from this rejection. It submitted the same `go_long` for `SOL/USDC` twice in the same judge loop, suggesting:
1. The rejection feedback is not being adequately incorporated into the LLM's context.
2. The agent lacks awareness of which tokens are available on its venue.

## Why the agent trade test did not catch this

The `scripts/ts/agent-trade-test.ts` test hardcodes `WETH` as the test instrument for the 1inch venue. `WETH` is a canonical token on Base and resolves correctly. The test would pass with WETH, giving false confidence that the agent can trade any token.

## Potential Fixes

| Approach | Effort | Risk |
|----------|--------|------|
| **A. Add SOL to Base canonical tokens** | Low | High — SOL is not a Base-native token; adding a fake/wrong address would cause execution failures downstream. |
| **B. Configure 1inch venue for Solana chain** | Medium | Medium — would require a separate venue config and trading binding for Solana-based 1inch. The agent would then have two venues (Base + Solana) and could trade SOL on Solana. |
| **C. Improve agent venue awareness** | High | Low — teach the agent which tokens are available on its venue via prompt/system context. The `discover_tokens` and `search_tokens` tools already support network filtering. |
| **D. Better rejection feedback** | Low | Low — ensure the rejection reason is prominently displayed in the tool result so the LLM can adapt. (The rejection message is already returned; the LLM may need prompt tuning.) |
| **E. Expand agent-trade-test to test multiple tokens** | Medium | Low — test with canonical AND non-canonical tokens to verify proper rejection behavior. |

## Recommended Next Steps

1. **Short-term:** Implement approach D — verify the rejection feedback is clear and actionable in the LLM's tool result. The current tool result already includes the error message; consider adding a hint like "This token is not available on your venue's chain (base). Try a different token or use discover_tokens to find available tokens."

2. **Medium-term:** Implement approach E — expand the agent trade test to verify both successful trades (canonical tokens) and proper rejection (non-canonical tokens).

3. **Long-term:** Implement approach C — give the agent venue/chain awareness so it knows which tokens are available before submitting decisions.

## Notes

- This is related to bug `2026/06/17/001-agent-decisions-no-trades.md` which fixed canonical token fallback for tokens that ARE in the whitelist. This bug is about tokens NOT in the whitelist.
- The agent did attempt to discover tokens via `discover_tokens` and `search_tokens` after the failures, which is correct exploratory behavior.
- The `agent-trade-test.ts` test should be run before deploying any new agent to verify basic trading functionality.
