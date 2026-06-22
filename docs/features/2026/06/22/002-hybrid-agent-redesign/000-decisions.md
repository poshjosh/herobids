# Hybrid Agent Redesign — Decisions

Date: 2026-06-22

## Context

The system has three `decisionMode` values: `llm`, `hybrid`, `mechanical`. The hybrid mode's architecture was over-complicated: two parallel loops (scanner + LLM), context injection the agent could ignore, and no cost savings because the LLM ticked on a regular heartbeat regardless of whether signals existed.

This redesign simplifies the architecture by making the scanner the **gate** for LLM invocations on hybrid agents, achieving true token efficiency.

---

## Decision Matrix

| Actor | decisionMode | Filter | Decision maker |
|-------|-------------|--------|----------------|
| Agent | llm | Agent (tools, reasoning) | Agent |
| Agent | hybrid | Scanner (technical) | Agent (single-shot LLM) |
| Bot | hybrid | Scanner (mechanical pre-check) | LLM (single-shot, per-symbol) |
| Bot | mechanical | Scanner | Scanner (direct submission) |

---

## Decisions

### D1: Agent intelligence is mandatory

Agents always have an `intelligence` config. An "agent" without LLM is an oxymoron — use a bot instead. The presence of `technical` config on an agent implies hybrid mode; no explicit `decisionMode` field is needed on agents.

### D2: No `technical.mode` field

The scanner's behavior (autonomous vs advisory) is derived from the actor type and `decisionMode`:
- `decisionMode: 'mechanical'` → scanner submits directly
- `decisionMode: 'hybrid'` → scanner wakes LLM for ratification
- Agent with `technical` config → always advisory (scanner wakes LLM)

No new config field required.

### D3: Hybrid agent ticks are fully event-driven — no polling

A hybrid agent does NOT follow the regular `tickIntervalMs` heartbeat for trading. The scanner is the gate. No signals → no LLM call → no token cost.

**Liveness guarantee:** The scanner runs continuously on its own interval. If open positions exist, the scanner evaluates them every cycle and emits wakes for exit conditions. For periodic status reports, use the existing reminder wake source.

### D4: Hybrid agent uses single-shot structured-output prompt (no tools)

When scanner signals wake a hybrid agent, the LLM receives:
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

## Non-decisions (deferred)

- Whether to rename `decisionMode` values themselves (not needed now — only bots use it)
- User-facing naming ("hybrid" vs "reactive" vs "on-demand") — UI/UX concern, not architectural
- Cost-efficient-trading skill — orthogonal and complementary; can be added later as a skill that guides LLM agents to use scanner results without being in hybrid mode
