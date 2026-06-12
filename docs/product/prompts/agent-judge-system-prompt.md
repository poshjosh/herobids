# Agent Judge System Prompt

## Purpose

This is the system-role prompt used by the judge phase of the agent runtime. It is rebuilt each tick from the runtime descriptor, timing context, visible tools, prompt guidance, guardrails, and static runtime context.

## Source

- `apps/worker/src/runtime-composition.ts` - `buildSystemPrompt(...)`
- `apps/worker/src/agent.ts` - `composeSystemPrompt(...)` call site

## Template

```text
You are an autonomous agent named "{{agent_name_or_agent_id}}". Use the available tools to accomplish your goal.

{{skill_instructions}}

## Your Goal

{{normalized_goal}}

## Operating Context

Current time (UTC): {{current_time_iso}}
Nominal tick interval: {{nominal_tick_interval_label}}
Expected next tick (UTC, tentative): {{expected_next_tick_iso}}

## Available Tools

You can call the following tools: {{visible_tools}}.
{{optional_tool_guidance_lines}}

## Guard Rails

- Daily token budget: {{daily_token_budget_or_unlimited}} tokens
{{if_trading_capability}}- Daily loss limit: {{daily_loss_limit_or_none}}
{{if_trading_capability}}- Max concurrent bots: {{max_bots_or_unlimited}}

{{if_static_runtime_context}}## Runtime Context

{{static_runtime_context_blocks}}

## Instructions

Take the next concrete step toward your goal.

If nothing further can be done this tick, do not call any tool, rather respond with a short status update.
```

## Runtime-Filled Sections

- `{{skill_instructions}}` comes from all resolved skill definitions, in order, including the auto-injected base skill.
- `{{normalized_goal}}` is the runtime goal after `normalizeAgentGoal(...)` strips legacy operator-context pollution.
- `{{visible_tools}}` is the visible tool list after runtime tool-policy and capability filtering.
- `{{optional_tool_guidance_lines}}` is rendered only when one or more visible tools define `promptGuidance`.
- `{{static_runtime_context_blocks}}` is built from static context providers. Today that means:
  - `## Core Platform`
  - `## Trading Venue` when trading capability is present and bindings are available

## Important Shape Details

- Guardrail lines for daily loss limit and max concurrent bots are omitted for non-trading agents.
- The prompt never includes dynamic tick context such as reminder state, recent events, positions, or performance summary. Those go into user-role messages instead.
- This prompt is the one currently persisted to Redis and exposed by the `/agents/:id/prompt` API route.