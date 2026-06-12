# Agent Judge User Prompt

## Purpose

This is the user-role message the judge phase receives when the runtime escalates to judge. Unlike the scout, the judge always gets the full current tick context plus an explicit escalation reason.

## Source

- `apps/worker/src/runtime-composition.ts` - `buildTickUserContext(...)`
- `apps/worker/src/agent.ts` - judge `messages` assembly and conversation history

## Current-Tick User Message Template

```text
{{full_tick_user_context}}

Escalation reason: {{resolved_scout_reason_or_unspecified}}
```

## Full Tick User Context

`{{full_tick_user_context}}` is always the full output of `buildTickUserContext(...)`, not the scout diff payload. In other words, it is:

```text
{{dynamic_context_blocks_in_rendered_order}}

## Performance Summary
Net P&L (after estimated costs): {{net_pnl_after_costs}}
LLM cost this session: {{llm_cost_usd}}
Estimated server cost: {{estimated_server_cost_usd}}
Win rate: {{win_rate_or_unavailable}}
Session duration: {{session_duration_label}}
Performance score: {{performance_score}}/10
```

The dynamic block order is the same as documented in [agent-scout-user-prompt.md](./agent-scout-user-prompt.md).

## Message Stack Around The Judge Prompt

The judge call does not receive this user message in isolation. The runtime builds a message array like this:

```text
system: {{judge_system_prompt}}
{{up_to_10_recent_history_messages}}
```

Recent history may include:

- prior judge user-context messages
- prior assistant messages when the assistant responded without tool calls
- tool results appended back into history as user-role messages

## Important Shape Details

- The escalation reason is appended after the full tick context, not embedded into a context block.
- Judge reminders created by the judge itself bypass scout and still arrive through this same judge user-message shape.
- The judge never receives the scout's compact diff payload; it receives the rebuilt full context.