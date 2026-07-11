# Hybrid Agent Redesign — Decisions

Date: 2026-06-22  
Revised: 2026-07-11 (D11, D12 — explicit mode fields)

## Context

The system has three `decisionMode` values: `llm`, `hybrid`, `mechanical`. The hybrid mode's architecture was over-complicated: two parallel loops (scanner + LLM), context injection the agent could ignore, and no cost savings because the LLM ticked on a regular heartbeat regardless of whether signals existed.

This redesign simplifies the architecture by making the scanner the **gate** for LLM invocations on hybrid agents, achieving true token efficiency.

---

## Decision Matrix

| Actor | capabilityMode | hybridMode | Filter | Decision maker |
|-------|---------------|------------|--------|----------------|
| Agent | `intelligence` | — | Agent (tools, reasoning) | Agent (scout/judge LLM) |
| Agent | `hybrid` | `mixed` | Scanner + other wake sources | Agent (scout/judge LLM or hybrid evaluator) |
| Agent | `hybrid` | `scanner_gated` | Scanner only | Agent (single-shot LLM, scanner-triggered only) |
| Bot | `hybrid` | — | Scanner (mechanical pre-check) | LLM (single-shot, per-symbol) |
| Bot | `mechanical` | — | Scanner | Scanner (direct submission) |

---

## Decisions

### D1: Agent intelligence is mandatory  ⤵ FE — superseded by D11

Agents always have an `intelligence` config. An "agent" without LLM is an oxymoron — use a bot instead.

This decision stands. What changed: the presence of `technical` config no longer implicitly
implies a specific runtime mode. An explicit `capabilityMode` field now controls this (see D11).

### D2: No `technical.mode` field  ⤵ FE — superseded by D12

The scanner's behavior (autonomous vs advisory) is still derived from actor type and config.
What changed: the runtime mode (mixed vs scanner-gated) is now explicit via `hybridMode`
(see D12), not implicitly derived from the presence of `technical` config.

### D3: Hybrid agent ticks are fully event-driven — no polling

A hybrid agent does NOT follow the regular `tickIntervalMs` heartbeat for trading.
The scanner (and, in `mixed` mode, other configured wake sources) are the gates.
No qualifying event → no LLM call → no token cost.

In `scanner_gated` mode this is stricter: ONLY scanner events initiate LLM turns.
In `mixed` mode, `watch_threshold`, `discovery_delta`, and `regime_change` may also
wake the LLM, subject to per-source throttling.

**Liveness guarantee:** The scanner runs continuously on its own interval. If open positions exist, the scanner evaluates them every cycle and emits wakes for exit conditions. For periodic status reports, use the existing reminder wake source.

### D4: Hybrid agent uses single-shot structured-output prompt (no tools)

Applies to `scanner_gated` mode. When scanner signals wake a hybrid agent, the LLM receives:
- A table of pre-scored signals (multi-instrument for agents)
- Available capital and open positions
- A simple instruction: "For each signal, emit a decision or skip"

The LLM returns a JSON array. The **runtime** parses the response and submits decisions. No tool-calling round-trips, no scout phase — judge-only.

### D5: Autonomous exit is configurable (default: false)

Added to `technical` config:
```yaml
technical:
  autonomousExit: false  # default
```

- `false` (default): Scanner detects exit conditions → emits wake → LLM decides whether to exit
- `true`: Scanner submits exit decisions directly (time-critical, no LLM cost for exits)

### D6: `HybridStrategy` class stays for bots

The existing `HybridStrategy` in `packages/strategy/src/hybrid-strategy.ts` (mechanical pre-check → single-symbol LlmStrategy) is a bot-level concern. It stays as-is for `bot + hybrid` use cases.

### D7: Bots are single-instrument; agents are multi-instrument

- **Bot:** Trades one symbol, one strategy, one execution loop
- **Agent:** Multi-instrument portfolio with discovery, scanning, and capital allocation across signals

### D8: Rename wake infrastructure (non-trading-specific names only)

Rename names that are (or will be) used by non-trading agents. The wake system is general-purpose (reminders, scanner signals, etc.) — not exclusively market/trading.

| Current | New |
|---------|-----|
| `agent.market.wake` | `agent.wake` |
| `AgentMarketWakePayloadSchema` | `AgentWakePayloadSchema` |
| `AgentMarketWakePayloadBaseSchema` | `AgentWakePayloadBaseSchema` |
| `AgentMarketWakeSourceSchema` | `AgentWakeSourceSchema` |
| `AgentMarketWakeSource` (type) | `AgentWakeSource` |
| `AgentMarketWakePayload` (type) | `AgentWakePayload` |
| `emitAgentMarketWake()` | `emitAgentWake()` |

Keep as-is (genuinely market-specific):
- `MarketWatchTriggeredPayloadSchema`
- `MarketDiscoveryDetectedPayloadSchema`
- `MarketRegimeChangedPayloadSchema`
- `MARKET_MONITOR_MESSAGE_TYPES` (the constant group — it IS the market monitor's namespace)

### D9: Prerequisite — tool schema improvement

`docs/features/2026/06/22/001-tool-schema-improvement/001-solution-guide.md` is a prerequisite. It is currently being implemented. The hybrid agent's single-shot prompt needs capital/sizing info injected, which that feature enables. Confirm that capital/sizing info is available.

### D10: Add `scanner` as a wake source

Extend the wake source enum to include `'scanner'` (or `'technical_scan'`) so the technical scanner can wake agents via the existing wake infrastructure.

---

### D11: Explicit `capabilityMode` field (2026-07-11)

Agents have an explicit `capabilityMode` field: `intelligence` | `hybrid`.

- `intelligence`: LLM-only agent. No technical scanner. Full scout/judge tool-calling loop.
- `hybrid`: Agent has both `intelligence` and `technical` config. The scanner pre-filters
trade candidates. The LLM is event-driven (see D3).

This replaces the previous implicit derivation (“technical config present → hybrid”).
The explicit field prevents configuration ambiguity and makes the runtime path clear.

### D12: Explicit `hybridMode` field (2026-07-11)

When `capabilityMode` is `hybrid`, an additional `hybridMode` field selects the
wake policy: `mixed` | `scanner_gated`.

- `mixed`: Scanner exists, but other wake sources (`watch_threshold`, `discovery_delta`,
`regime_change`) can also trigger LLM turns. The LLM may use the full scout/judge
loop or the hybrid evaluator depending on the wake source.
- `scanner_gated`: The LLM is invoked ONLY when the scanner produces entry or exit
candidates. No other wake source triggers a trading LLM turn. The LLM uses the
single-shot structured-output path (D4). Reminders and user messages are unaffected.

The default is `mixed` for backward compatibility. `scanner_gated` is the
cost-optimised mode.

### D13: Scanner-gated mode and exits (2026-07-11)

In `scanner_gated` mode, exits are also scanner-triggered:
- The scanner evaluates open positions every cycle and emits exit advisories.
- The LLM is woken to ratify exit decisions when advisories are present.
- When `autonomousExit` is `true`, the scanner submits exits directly without
waking the LLM. This is the recommended pairing for strict cost reduction.
- When `autonomousExit` is `false` and the scanner flags an exit, the LLM is
woken to decide — but ONLY for that exit, not for general reasoning.

Deterministic backstops (per-trade stop-loss/take-profit, portfolio stop-loss)
continue to execute directly without LLM involvement in all modes.

---

## Non-decisions (deferred)

- Whether to rename `decisionMode` values themselves (not needed now — only bots use it)
- Cost-efficient-trading skill — orthogonal and complementary; can be added later as a skill that guides LLM agents to use scanner results without being in hybrid mode

## Superseded decisions

- **D1 (original)**: Implicit mode derivation from config presence. Replaced by D11 (explicit `capabilityMode`).
- **D2**: No explicit mode field. Replaced by D12 (explicit `hybridMode`).
- **Non-decision "User-facing naming"**: Resolved. The modes are `intelligence`, `hybrid (mixed)`, and `hybrid (scanner_gated)`.
