# Phase 0 evidence: how the 2026-11-25 09:32 run ended

Collected: 2026-11-26, read-only, staging, agent `job-searcher` (`da94c8e1-3b79-42ef-96e3-6a1a5d2ec9d2`), Nomad allocation `77531881-f8cf-6d73-d985-945605cabdef` (created 09:29:14 UTC, the `reconnect_recovery` restart). Source: `nomad alloc logs` (stdout and stderr) for the `agent` task. No `agent.llm.completed` line is written to the allocation log, so `finishReason`, `nudgeCount` and `finishRunStatus` were read from the log lines below, not from that event.

## Timeline (UTC)

| Time | Log line | Meaning |
|---|---|---|
| 09:32:21 | `Received user message between ticks`, `Agent tick starting` (tick 3), `Escalated to judge … reason: user_message` | The user's rebuild request starts a run. |
| 09:32:29 | `Executing tool send_message` | The acknowledgement "Rebuild started …". |
| 09:32 to 09:34 | About 50 `Executing tool` lines (`list_files`, `read_file`, `write_file` ×18, `make_http_request`, `search_files`, `set_memory`, …) | Real work. |
| 09:34:35 | `Retrying judge LLM call after backoff`, attempt 1, `llm.invalid_tool_args`: `write_file` arguments "not valid JSON … probably cut off (token limit) … finished with reason "length"" | Output cut off at the token limit. |
| 09:35:13 | Same, attempt 2, `search_files` | Cut off again. |
| **09:36:19** | **`Judge model returned an empty reply with no tool call`: `turnIndex 16`, `finishReason "length"`, `outputTokens 0`, `thinkingTokens 8192`, `finishRunCalled false`, `latencyMs 34835`** | **The run ends silently. Thinking used the whole output limit.** |
| 09:44:30 | `Received user message between ticks` (tick 4) | "No feedback?" |
| 09:44:40 | `Executing tool send_message` | Second acknowledgement. |
| 09:46:43 to 09:48:18 | Three `Retrying judge LLM call` lines, all `llm.invalid_tool_args` with finish reason `length` (`read_file_lines`, `append_file`, `write_file`) | Output cut off three more times. |
| **09:48:54** | **`Agent runtime failure classified`: `source llm`, `mode degraded`, `llm.invalid_tool_args`; then `Tick failed; outbound entries stay pending for the next read`** | **The second run fails. No message to the user.** |
| 10:02:02 | `Received market wake signal between ticks` (the `ltt-jobsearch-continue` reminder) | The agent's own continuation reminder wakes it. |
| 10:04:00 | `Executing tool send_message` | First message after the failures. |
| 10:04:07 | `Executing tool finish_run`, `Resetting consecutive failure counter after successful tick` | Clean end. |

## Conclusions

1. Neither silent ending matches R4 or R5 in the first draft of the plan. `finish_run` was not called (`finishRunCalled: false`) and no continuation nudge was sent. An empty reply is never nudged (by design), and a failed tick never reaches a run-end check.
2. The cause is the output token budget (new root cause R0). The judge output limit for this agent was 8,192 tokens. The thinking used all 8,192, leaving 0 for visible text or tool calls. In every style default in `packages/domain/src/config/schema.ts` the judge output limit is smaller than the deep-thinking budget (4,096 vs 10,240, 8,192 vs 20,480, 16,384 vs 32,768), and the scout output limit is smaller than or equal to the light-thinking budget. Claude models get effort-based thinking (`resolveReasoningParams` in `packages/llm/src/llm-provider.ts`), which is not capped by the thinking budget at all, only by the output limit.
3. Retrying a cut-off call with the same request repeats the cut-off (09:34 to 09:35 and 09:46 to 09:48).
4. The agent's continuation reminder was the only recovery, 26 minutes after the first silent ending.
5. R1 and R2 (an acknowledgement counts as a reply) are confirmed by the Conversation section: only the 09:44 message was marked `[awaiting reply]`. R3 (restart) is confirmed by the 09:29 allocation start.

## Unrelated defects seen (not in this plan)

- A job-search agent with no trading skills runs trading reads on every tick (`get_agent_positions`, `get_economic_calendar`, `list_watches`, "Processing market wake signal").
- The Conversation section lists `#26c7f840` (09:30) before `#cf8ca737` (09:29).
- `LLM_TIMEOUT_MS` defaults to 60 seconds and calls are not streamed; the cut-off turn at 09:36 took 34.8 seconds for 8,192 tokens.
