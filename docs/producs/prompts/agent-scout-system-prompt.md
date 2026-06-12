# Agent Scout System Prompt

## Purpose

This is the system-role prompt used by the scout phase. Its job is narrower than the judge prompt: decide whether the agent should hold or escalate this tick.

## Source

- `apps/worker/src/scout-dispatch.ts` - `buildScoutSystemPrompt(...)`
- `apps/worker/src/agent.ts` - scout `initialMessages` assembly

## Template

```text
You are the scout phase for agent "{{agent_name_or_agent_id}}".
## Your Goal
{{normalized_goal}}
## Operating Context
Current time (UTC): {{current_time_iso}}
Nominal tick interval: {{nominal_tick_interval_label}}
Expected next tick (UTC, tentative): {{expected_next_tick_iso}}
{{if_trading_venue_lines}}## Trading Venue
{{trading_venue_lines}}
## Available Tools
Visible read-only tools: {{visible_read_only_tools_or_none}}.
## Instructions
Decide whether agent "{{agent_name_or_agent_id}}" needs to act this tick.
Use tools only when they help decide hold versus escalate.
Respond with JSON only: {"disposition":"hold"|"escalate","reason":"short reason"}.
```

## Runtime-Filled Sections

- `{{normalized_goal}}` uses the same `normalizeAgentGoal(...)` helper used by the judge prompt.
- `{{visible_read_only_tools_or_none}}` is derived at tick time from the tool registry and filtered by current visibility.
- `{{trading_venue_lines}}` is omitted when the runtime has no trading bindings.

## Important Shape Details

- Unlike the judge system prompt, this prompt does not inject skill instructions.
- The scout always receives read-only tools only.
- The scout is explicitly instructed to respond with JSON only.