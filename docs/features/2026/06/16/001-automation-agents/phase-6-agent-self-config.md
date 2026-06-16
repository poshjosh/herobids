# Implementation Plan: Phase 6 — Agent Self-Configuration

Allow AI agents to add, modify, or remove their own `technical` config section
at runtime. This enables "test a strategy on live market" without creating child
agents or manual user intervention.

**Files:**
- `apps/worker/src/tools/update-own-config.ts` — new agent tool
- `packages/domain/src/config/schema.ts` — validation for partial config updates
- `packages/db/src/repositories/agent-repo.ts` — config update persistence

**Depends on:** Phase 3 (technical runtime must exist to be activated)

---

## Design

### Use Case

An AI agent wants to test a momentum strategy:

```
Agent thinks: "I want to test RSI + MACD on Hyperliquid perps before committing"

Agent calls: update_own_config({
  technical: {
    filters: { venue: 'hyperliquid', venueType: 'orderbook', minVolume24hUsd: 50000 },
    indicators: { rsi: { enabled: true }, macd: { enabled: true } },
    scanIntervalMs: 60000,
  },
  execution: { mode: 'paper' },
})

Result: Agent's next scan cycle includes the technical phase.
        Paper trades generated. Agent observes results over time.

Later, agent calls: update_own_config({
  execution: { mode: 'live' },  // Promote to live
})

Or: update_own_config({ technical: null })  // Remove technical, go back to pure LLM
```

### Tool Definition

```typescript
{
  name: 'update_own_config',
  description: 'Update this agent\'s configuration. Can add, modify, or remove the technical section. Can change execution mode. Cannot remove intelligence (would deactivate self).',
  parameters: {
    technical: { type: 'object | null', description: 'Technical config to set, or null to remove' },
    execution: { type: 'object', description: 'Execution config updates (mode, position sizing)' },
    risk: { type: 'object', description: 'Risk config updates' },
  }
}
```

### Constraints

| Rule | Reason |
|---|---|
| Cannot remove `intelligence` | Agent would deactivate its own reasoning capability |
| Cannot set `execution.mode: 'live'` directly from null | Must go through paper/shadow first (safety gate) |
| Config validated before applying | Rejects invalid indicator params, bad venue names, etc. |
| Change takes effect next cycle | No mid-cycle reconfiguration |
| Change persisted to DB | Survives restarts |
| Audit trail | Config changes journaled with before/after snapshot |

### Live Mode Safety Gate

To prevent an agent from immediately going live with an untested strategy:

```
null → paper: ✅ allowed
paper → shadow: ✅ allowed
shadow → live: ✅ allowed
null → live: ❌ rejected ("must test in paper or shadow first")
paper → live: ⚠️ allowed only if agent has > N successful paper cycles
```

The threshold for paper→live promotion is configurable (operator config):
`agentRiskDefaults.minPaperCyclesBeforeLive: 10`

---

## Checklist

### Tool Implementation

- [ ] Create `apps/worker/src/tools/update-own-config.ts`
- [ ] Define tool schema (Zod) for the update payload
- [ ] Validate partial config update against `UnifiedAgentConfigSchema`
- [ ] Reject removal of `intelligence` section
- [ ] Implement live mode safety gate
- [ ] Persist updated config to DB via agent repo
- [ ] Journal the config change (before/after snapshot for audit)
- [ ] Signal the agent runtime to reload config on next cycle
- [ ] Register tool in agent tool registry

### Runtime Integration

- [ ] Agent actor watches for config changes between cycles
- [ ] If `technical` added: start scan timer on next cycle
- [ ] If `technical` removed: stop scan timer, clear lastTechnicalScan
- [ ] If execution mode changed: switch executor on next cycle
- [ ] No mid-cycle interruption (current cycle completes, changes apply after)

### Tests

- [ ] Agent adds `technical` → next cycle runs technical phase
- [ ] Agent removes `technical` → scan timer stops
- [ ] Agent cannot remove `intelligence`
- [ ] Invalid config rejected (bad indicator params)
- [ ] Live mode safety gate prevents direct null→live
- [ ] Config change persisted to DB
- [ ] Config change journaled with audit trail
- [ ] Agent survives restart with updated config

---

## Definition of Done

- [ ] AI agent can add technical scanning to itself via tool
- [ ] AI agent can promote from paper → shadow → live
- [ ] AI agent can remove technical to revert to pure LLM
- [ ] Safety gates prevent reckless live deployment
- [ ] All changes auditable (journal entries)
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
