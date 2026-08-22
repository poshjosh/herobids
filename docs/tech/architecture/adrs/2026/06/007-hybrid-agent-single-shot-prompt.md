# ADR 007: Hybrid Agent Uses Single-Shot Structured-Output Prompt

Status: Accepted (scope narrowed 2026-07-11)
Date: 2026-06-23
Parent: [002-hybrid-agent-redesign decisions][decisions]

> **2026-07-11 note:** This ADR now applies specifically to `hybridMode: 'scanner_gated'`.
> In `mixed` mode, the LLM may still use the full scout/judge tool-calling loop
> depending on the wake source. See D12 in the [revised decisions][decisions].

## Context

Under the hybrid agent model, the scanner detects tradable signals and wakes the
LLM for ratification. The question is: what form should that LLM interaction take?

The current LLM-mode agent uses a tool-calling loop: the LLM invokes tools to scout
the market, then invokes `submit_decision` to act. This costs tokens on every
round-trip, and the "scout" phase is redundant when the scanner has already done the
technical analysis. For hybrid agents, the scanner IS the scout — the LLM only needs
to judge.

An alternative would be to keep tool-calling but give the agent a `read_scanner_results`
tool. However, this still incurs extra round-trips and the agent could ignore the
scanner or ask for redundant data.

## Decision

**In `scanner_gated` hybrid mode, agents receive a single-shot structured-output prompt — no tools.**

In `mixed` hybrid mode, the LLM may use the full scout/judge tool-calling loop
or the hybrid evaluator depending on which wake source triggered the turn.
This ADR describes the `scanner_gated` path.

When scanner signals wake a hybrid agent, the runtime constructs a prompt containing:

1. **A table of pre-scored signals** — multi-instrument for agents. Each row includes
   the instrument, the signal type (entry/exit/adjust), the scanner's confidence
   score, and relevant indicator values.
2. **Available capital and open positions** — so the LLM can reason about position
   sizing and portfolio allocation without querying tools.
3. **A simple instruction**: "For each signal, emit a decision or skip."

The LLM returns a JSON array. The **runtime** parses the response and submits
decisions to the engine on the agent's behalf. No tool-calling round-trips, no scout
phase — judge-only.

### Prompt Template (illustrative)

```
You are a trading agent with the following context:

## Signals (pre-scored by technical scanner)
| # | Instrument | Action | Confidence | Indicators |
|---|-----------|--------|------------|------------|
| 1 | ETH-PERP  | LONG   | 0.82       | RSI=32, MACD=cross |
| 2 | BTC-PERP  | CLOSE  | 0.91       | Stop hit, vol spike |

## Portfolio
- Available capital: $4,200
- Open positions: ETH-PERP (1.2 ETH, PnL +$18)

## Instruction
For each signal, return a JSON object with:
- action: "skip" | "submit"
- If submit: instrument, side, size (as % of available capital), and a brief reason.
- If skip: brief reason.

Return ONLY a JSON array. No other text.
```

The expected response shape:
```json
[
  { "action": "submit", "instrument": "ETH-PERP", "side": "long", "sizePercent": 25, "reason": "Oversold bounce setup, small position" },
  { "action": "submit", "instrument": "BTC-PERP", "side": "close", "reason": "Stop loss triggered" }
]
```

## Consequences

- **Token efficiency**: one prompt + one response per wake, vs. N tool-calling
  round-trips. For a typical hybrid agent, this reduces token consumption by 60-80%.
- **Predictable latency**: the LLM call is bounded — no looping, no retries for
  tool errors, no infinite reasoning chains.
- **Auditability**: the JSON response is a clean decision log. Every signal that
  was presented to the LLM is accounted for (submitted or skipped with reason).
- **Schema enforcement**: the runtime validates the JSON array against a Zod schema
  before submitting any decisions. Malformed responses are logged and treated as
  "skip all" (failsafe).
- **Loss of flexibility**: the agent cannot request additional data or run custom
  analysis beyond what the scanner provides. This is intentional — `scanner_gated`
  mode is for cost-efficient ratification, not deep reasoning. Agents that need
  exploratory analysis should use `intelligence` mode or `hybrid` with `mixed` mode.
- The `submit_decision` tool is not presented to the LLM in `scanner_gated` mode —
  the runtime owns submission, not the LLM.

[decisions]: ../../features/2026/06/22/002-hybrid-agent-redesign/000-decisions.md
