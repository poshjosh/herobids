# Agent Scout User Prompt

## Purpose

This is the user-role message sent to the scout phase. It is derived from runtime context each tick and may be sent either as a full context payload or as a compact context diff.

## Source

- `apps/worker/src/runtime-composition.ts` - `buildTickUserContext(...)`
- `apps/worker/src/context-diff.ts` - `buildIncrementalContext(...)`
- `apps/worker/src/agent.ts` - scout `initialMessages` assembly

## Full-Context Shape

When the runtime chooses `mode: full`, the scout sees the complete current tick context:

```text
{{dynamic_context_blocks_in_rendered_order}}

## Performance Summary
Net P&L (after estimated costs): {{net_pnl_after_costs}}
LLM cost this session: {{llm_cost_usd}}
Estimated server cost: {{estimated_server_cost_usd}}
Win rate: {{win_rate_or_unavailable}}
Session duration: {{session_duration_label}}
Performance score: {{performance_score}}/10

{{if_first_tick}}This is your first tick. Start working towards your goal.
```

## Context-Diff Shape

When the runtime chooses `mode: diff`, the scout sees only the changed lines:

```text
## Context Diff
- {{previous_line}}
+ {{current_line}}
{{additional_changed_lines}}

{{if_first_tick}}This is your first tick. Start working towards your goal.
```

If there are no material changes, the diff body becomes:

```text
## Context Diff
- No material changes from the prior tick.
```

## Dynamic Context Block Order

When the scout receives full context, the worker renders dynamic blocks in this order when they are available and permitted by capability gating:

1. `## Capability Readiness`
2. `## A reminder you set for yourself is now due`
3. `## Watch Trigger Context`
4. `## Discovery Trigger Context`
5. `## Regime Change Context`
6. `## Degraded Capabilities`
7. `## Portfolio Summary`
8. `## Open Positions`
9. `## Market Regime`
10. `## Venue Intelligence`
11. `## Recent Events`
12. `## Managed Bots`
13. `## Performance Summary`

## Current Reminder Block Shape

Today, when a reminder wake is active, the current full-context block is rendered as:

```text
## A reminder you set for yourself is now due
Message: {{reminder_message}}
Requested at: {{requested_at_or_unavailable}}
Reminder ID: {{reminder_id_or_unavailable}}
Wake ID: {{wake_id}}
```

## Important Shape Details

- A heading change between ticks forces the runtime back to full-context mode instead of diff mode.
- Reminder and market-wake blocks are single-tick context only; they are cleared after the tick context is built.
- The scout sees the incremental `userContext` value, not the later judge-specific escalation suffix.