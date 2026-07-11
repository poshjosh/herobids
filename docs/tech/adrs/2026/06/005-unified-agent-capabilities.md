# ADR 005: Unified Agent Capabilities (Technical + Intelligence)

Status: Accepted (revised 2026-07-11)
Date: 2026-06-16

> **2026-07-11 note:** The capability model remains correct — `technical` and
> `intelligence` are config sections, not agent types. What changed: the runtime
> behavior is now governed by explicit mode fields (`capabilityMode` and `hybridMode`)
> rather than being purely derived from which config sections are present.
> See D11–D13 in the [hybrid redesign decisions][decisions].

## Context

HeroBids needs to support three distinct trading behaviors:
1. Rule-based automation (zero LLM cost) — for cost-sensitive markets
2. Full LLM reasoning (current AI Agents) — for users who want AI intelligence
3. Rules pre-filter + LLM final judgment — cost-optimized AI trading

An earlier proposal introduced `agent_kind: 'ai' | 'automation'` as separate
actor types. This was rejected because:
- It creates an artificial taxonomy users must understand
- It doesn't model the hybrid case cleanly (is it a third type?)
- An AI agent wanting to add indicators has to "become" a different type
- The system gains complexity (two runtime actors, two config schemas, two API
  flows) for what is really one concept with two dimensions

## Decision

Model agent capabilities as **two optional config sections** rather than distinct
agent types:

```typescript
{
  technical?: TechnicalConfig,    // Rule-based: filters, indicators, regime
  intelligence?: IntelligenceConfig,  // LLM-based: provider, model, goal
  // At least one must be present
}
```

### Behavioral Emergence

The agent’s capabilities are determined by which sections are present:

| `technical` | `intelligence` | Available capabilities |
|---|---|---|
| ✅ | ❌ | Scanner-only (discovery → indicators → mechanical decision) |
| ❌ | ✅ | LLM-only (tools, reasoning → decision) |
| ✅ | ✅ | Both (scanner pre-filter + LLM ratification) |

Runtime behavior is controlled by explicit mode fields, not derived from capability
presence alone:
- `capabilityMode: 'intelligence'` — LLM-only agent
- `capabilityMode: 'hybrid'` — scanner + LLM agent
  - `hybridMode: 'mixed'` — scanner + other wake sources may trigger LLM
  - `hybridMode: 'scanner_gated'` — only scanner events trigger trading LLM turns

### No Type Discriminator

There is no `agent_kind`, `agent_type`, or similar column. The runtime inspects
config contents to determine which capability phases to execute. The explicit
`capabilityMode` and `hybridMode` fields control runtime policy (LLM gating,
wake sources), not which capabilities are available. This means:
- Adding `technical` to an existing intelligence agent is a config update +
  setting `capabilityMode` to `hybrid`.
- Removing `intelligence` from a hybrid agent makes it scanner-only.
- No migration, no type change, no new entity.

### Key Design Constraints

1. **At least one capability required.** Config validation rejects agents with
   neither `technical` nor `intelligence`.
2. **Agents cannot create agents.** Only users create agents. An agent that wants
   to test a strategy reconfigures itself or runs a backtest.
3. **Shared execution infrastructure.** Both capability modes use the same
   plan → order → fill pipeline. No duplication.
4. **Backward compatible.** Existing AI agents continue to work. Their config
   already maps to `{ intelligence: { ... } }`.

## Consequences

- One agent concept in the entire product — no taxonomy for users to learn
- Zero-cost trading is a config choice, not a product tier
- "Add AI to my strategy" is a config update, not a new entity
- The capability sections (`intelligence`, `technical`) determine what is possible;
  the mode fields (`capabilityMode`, `hybridMode`) determine how the runtime behaves.
- Presets ("Momentum Breakouts", "AI Swing Trader") are just default config
  templates with different sections filled
- No DB schema changes for agent types — config JSONB already supports it
- The runtime actor needs conditional phase execution (technical phase skipped
  if not configured, intelligence phase skipped if not configured)
- Self-configuration by AI agents is natural — they update their own config
  to add/remove `technical` as needed

[decisions]: ../../features/2026/06/22/002-hybrid-agent-redesign/000-decisions.md

## Alternatives Considered

**A. `agent_kind: 'ai' | 'automation' | 'hybrid'` discriminator.**
Rejected. Three types is worse than two. Adding a fourth later requires schema
migration. Doesn't model "AI agent temporarily tests a strategy" cleanly.

**B. Separate actor types with a cooperation protocol.**
Rejected. Introduces agent-to-agent communication complexity. One agent doing
both phases in sequence is simpler and has no coordination overhead.

**C. Strategy port expansion (multi-instrument Strategy interface for bots).**
Rejected. Bots are executors, not actors. Multi-instrument intelligence belongs
in the agent layer, not the strategy port.
