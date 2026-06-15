# Agent Risk Configuration UI

## Problem

The agent creation/edit UI currently exposes only `capital` and `dailyLossLimit`. Other risk parameters that affect agent trading behaviour (`maxOpenPositions`, `stopLossMaxUnrealizedLossPct`, `maxPositionSizePct`, `stopLossCooldownMs`) are applied as operator defaults without creator visibility or control.

Per the Agent Mode Purity rule (two-path model), risk limits that the user explicitly sets become immutable hard caps that the agent cannot override. Risk limits that the user does NOT set receive operator defaults that the agent CAN adjust at runtime. The UI must make this distinction clear so users can make informed choices.

## Target State

1. The agent create/edit modal exposes all risk parameters that affect the agent's trading behaviour.
2. Each field clearly communicates: "Set this to enforce a hard limit. Leave blank to use the platform default (the agent can adjust it)."
3. The API accepts and persists these fields on the `agents` table.
4. The worker reads user-configured values as immutable limits and fills gaps from `appConfig.agentRiskDefaults`.

## Schema Changes

### DB: `packages/db/src/schema/agents.ts`

Add columns to the `agents` table:

```sql
max_open_positions         integer          -- nullable; user-configured hard cap
max_position_size_pct      numeric(5,2)     -- nullable; 0-100
stop_loss_pct              numeric(5,2)     -- nullable; max unrealized loss % before forced exit
stop_loss_cooldown_ms      integer          -- nullable; min ms between stop-loss re-entry
```

All nullable — null means "use operator default (agent-adjustable)".

### API: Agent create/update payload

Extend `CreateAgentPayload` and `UpdateAgentPayload` with optional fields:

```typescript
maxOpenPositions?: number;
maxPositionSizePct?: number;
stopLossPct?: number;
stopLossCooldownMs?: number;
```

Validation: each must be within operator bounds defined in `appConfig.agentRiskDefaults` (user cannot set a value higher than the operator ceiling).

### Worker: Risk limit resolution

```typescript
// Pseudocode for building agent risk limits
const riskLimits = {
  maxOpenPositions: agent.maxOpenPositions ?? agentDefaults.maxOpenPositions,
  maxPositionSizePct: agent.maxPositionSizePct ?? agentDefaults.maxPositionSizePct,
  stopLossMaxUnrealizedLossPct: agent.stopLossPct ?? agentDefaults.stopLossMaxUnrealizedLossPct,
  stopLossCooldownMs: agent.stopLossCooldownMs ?? agentDefaults.stopLossCooldownMs,
  // ...
};
```

Fields where the user provided a non-null value → immutable (agent cannot override).
Fields where null → default applied, agent may adjust via `adjust_risk_limits` tool.

## UI Design

### Location

Agent create/edit modal → collapsible "Risk Limits" section below the existing "Capital" and "Daily Loss Limit" fields.

### Fields

| Label | Help text | Input type | Placeholder |
|-------|-----------|-----------|-------------|
| Max Open Positions | Hard cap on simultaneous positions. Leave blank for platform default (agent can adjust). | Number input | e.g. 10 |
| Max Position Size (%) | Max single position as % of capital. Leave blank for default. | Number input (0–100) | e.g. 100 |
| Stop-Loss (%) | Force exit if unrealized loss exceeds this % of equity. Leave blank for default. | Number input (0–100) | e.g. 10 |
| Stop-Loss Cooldown | Minimum wait after stop-loss exit before re-entering (seconds). Leave blank for default. | Number input | e.g. 300 |

### Behaviour

- Empty = null in DB = operator default applies, agent can adjust
- Non-empty = persisted, enforced as hard cap, agent cannot weaken
- Show current platform defaults as placeholder text so the user knows what "blank" means
- Existing agents with no values → treated as all-defaults (backward compatible)

## Migration

Generate a Drizzle migration adding the four nullable columns. No data migration needed — null is the correct default for existing rows.

## Testing

- Unit: API validation rejects values exceeding operator bounds
- Unit: Worker correctly resolves user-configured vs defaulted limits
- E2E: Create agent with explicit stop-loss → verify agent cannot override it
- E2E: Create agent without stop-loss → verify agent can read and adjust it

## Out of Scope

- Agent runtime tool (`adjust_risk_limits`) for modifying defaulted limits — separate plan
- Real-time WebSocket notification when agent adjusts its own limits
