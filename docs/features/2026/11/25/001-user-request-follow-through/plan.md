# User request follow-through: an agent always reports an outcome, without being told to

Status: Revised 2026-11-26 after Phase 0 (`evidence.md`). Owner decisions D9 to D12 (2026-11-25) and D13 to D17 (2026-11-26) recorded. Phase 1 is built first; Phases 2 and 3 wait for the decision gate (D17). The token values in D13 were confirmed by the owner (O10, D18). O4, O7, O8 and O9 remain open. Phase 1 is being implemented.
Date: 2026-11-25, revised 2026-11-26
Follows: `docs/features/2026/11/17/001-continuation-guard/plan.md` (the `finish_run` tool, stop hook and nudge). This plan builds on that mechanism and does not replace it.

## Summary for leadership

When someone gives an assistant a job, they expect three things: "on it", then either "done" or "still going, here is where I am", and never silence. Today our agents can go quiet after saying "on it". In the incident behind this plan, the agent did not choose to stop. It ran out of room to write its answer, and the run ended with nothing sent.

The fix has three layers:

1. **Give the agent room to answer.** We set the space for an answer smaller than the space for thinking, so a long think could leave nothing for the answer. We fix the limits and, when an answer is cut off, retry in a way that fits.
2. **The platform remembers what the user is owed.** When the user asks for something, the platform notes that an outcome is owed. It reminds the agent while it works, will not let it close the job quietly, and wakes it if it fails or goes silent. Nothing depends on how the user phrases the request.
3. **The user can see what is happening.** A small status line in the chat shows "working since 09:32", "hit a problem, retrying at 09:50" or "waiting for your answer". The user no longer has to ask "No feedback?".

We build layer 1 first, together with a way to measure silences, and run it on staging for about a week. Layers 2 and 3 are built only if the measurements show they are still needed.

The platform never writes chat messages to the user. Only the agent does. All limits are settings, and every extra cost is capped.

## Decisions

| # | Decision |
|---|---|
| D1 | The platform, not the user's wording, guarantees follow-through. A user must never need to say "tell me when you're done". |
| D2 | An acknowledgement is not an outcome. An outcome stays owed until the agent sends a closing message. The platform decides what "closing" means from what the agent did, not only from what it declares. |
| D3 | **Revised 2026-11-26.** Delivery is in three phases, each shippable alone. Phase 1: output budget, recovery from cut-off output, prompt text, and measurement (the silence metric, the log check and the evaluation scenario). Phase 2: the run trace, per-turn reminder line and run-end report-back check, the owed-outcome record, `send_message` status, the `finish_run` precondition, the watchdog and the fast recovery wake. Phase 3: the chat status line and the remaining telemetry. Phase 1 removes the cause of the 2026-11-25 incident (R0). Phase 2 is the guarantee when a run still dies or an acknowledgement is the last word. |
| D4 | The report-back check applies to every agent that has a conversation with a user, not only to agents that see `finish_run`. It is capped (default 1 per run) and has its own setting. `0` turns it off. |
| D5 | **Revised.** The watchdog reuses the existing `reminder` wake source. No new `AgentWakeSource`. The agent cannot see, list or cancel it, and it does not count against `reminders.maxActivePerAgent`. It does not change the agent's own reminders. It skips a wake when one of the agent's reminders is due before the watchdog time plus a short grace (that reminder wakes the agent anyway, and the owed outcome is in the prompt on every wake). |
| D6 | **Revised.** `send_message` gains two optional parameters: `status` and `nextUpdateInMinutes`. The status values are the task states of MCP Tasks (spec 2025-11-25) and A2A: `working`, `input_required`, `completed`, `failed`, `cancelled`. When `status` is absent the platform infers it from the run trace (D2). No required parameter is added. |
| D7 | The existing `answeredUpToTs` marker and the `[awaiting reply]` label keep their meaning ("the agent has seen and replied to the message"). The owed-outcome record is added beside them. Nothing is migrated. |
| D8 | The `job-search` skill is not changed by this plan (the owner reconciles it with `long-running-task`, as decided on 2026-11-17, D6). `long-running-task` gets a small additive paragraph (section A5). |
| D9 | **Decided 2026-11-25.** The platform never writes a chat message to the user. An owed outcome that reaches the wake cap (`stalled`) is shown to the agent in its prompt, logged, counted in telemetry and shown in the status line (D16). |
| D10 | **Decided 2026-11-25.** No `enabled` flag for Phase 2, consistent with the continuation guard. Staged rollout uses the agent image pin. Roll back by releasing the previous image. |
| D11 | **Decided 2026-11-25.** The report-back check applies to trading agents' conversations too. |
| D12 | **Decided 2026-11-25.** Defaults: `minWorkCallsSinceMessage` 3, `reportBack.maxNudges` 1, `defaultUpdateMinutes` 15, `maxWakes` 3. |
| D13 | **Decided 2026-11-26 (values to confirm, O10).** Raise both `judgeMaxTokens` and `scoutMaxTokens`. Every output limit must leave room for an answer after the thinking budget: `judgeMaxTokens ≥ deepThinkingTokens + judgeOutputReserveTokens` and `scoutMaxTokens ≥ lightThinkingTokens + scoutOutputReserveTokens`. Not the model's absolute maximum: see section A1 for why. A test enforces the rule for every style default and the ceilings. |
| D14 | **Decided 2026-11-26.** One owed-outcome record per agent, not a ledger with one record per user message. Any closing message closes it. There is no `inReplyTo` (was O3). |
| D15 | **Decided 2026-11-26.** The MCP Tasks and A2A status names in D6 replace the earlier `done` and `question`. |
| D16 | **Decided 2026-11-26.** "No UI change" is dropped. Phase 3 adds a status line to the chat that is not a chat message. |
| D18 | **Decided 2026-11-26.** The token values in A1 are accepted (was O10): reserves 16,384 judge and 4,096 scout; ceilings 65,536 and 16,384; 32,000 for an unknown model. |
| D17 | **Decided 2026-11-26.** Phase 1 ships alone first and runs on staging for about a week. Phases 2 and 3 are built only as the decision gate (section "Decision gate after Phase 1") requires. |

## Problem

A user asked a long-running agent to do a multi-step job and said it must report back. The agent acknowledged, worked, and went quiet. After 12 minutes the user had to write "No feedback?". The second run then also failed silently. The user heard nothing until 10:04, 32 minutes after the request.

Users do not phrase requests as a protocol. The user here did say "don't stop till you report back", and it still failed. So wording from the user cannot be the fix. The platform has to make a human-assistant habit the default: "On it" → work → "Done", or "Still going, here is where I am".

## Evidence (staging, agent `job-searcher`, 2026-11-25)

Full detail in `evidence.md` (Phase 0, collected 2026-11-26 from the allocation logs).

| Time (UTC) | What happened |
|---|---|
| 09:29 | The agent restarts (`reconnect_recovery`, new allocation). Workspace files are gone. |
| 09:32 | User: "Strictly follow the instructions in openaidom/skills/job-search -> rebuild all the files, if need. Don't stop till you report back to me that you have rebuilt all the files." |
| 09:32 | Agent `send_message`: "Rebuild started … I will tell you when the rebuild is done, or if something blocks it." Then about 50 tool calls. |
| 09:34 to 09:35 | Two judge calls fail with `llm.invalid_tool_args`: the tool-call JSON was cut off, finish reason `length`. The retries resend the same request. |
| **09:36** | **The judge returns an empty reply: finish reason `length`, 8,192 thinking tokens, 0 output tokens, `finish_run` not called. The run ends with no message.** |
| 09:44 | User: "No feedback?". The agent sends a second acknowledgement and works. |
| 09:46 to 09:48 | Four more cut-off tool calls (`length`). |
| **09:48** | **The tick fails (`llm.invalid_tool_args`, mode `degraded`). No message.** |
| 10:02 | The agent's own `ltt-jobsearch-continue` reminder wakes it. |
| 10:04 | The agent messages the user and calls `finish_run`. |

## Root causes

| # | Cause | Where |
|---|---|---|
| R0 | **The output limit is smaller than the thinking budget, so thinking can use all of it.** Every style default has `judgeMaxTokens` below `deepThinkingTokens` (4,096/10,240, 8,192/20,480, 16,384/32,768) and `scoutMaxTokens` at or below `lightThinkingTokens`. Claude models get effort-based thinking, capped only by the output limit. A cut-off call is retried unchanged, so it is cut off again. An empty `length` reply ends the run silently, and a failed tick sends nothing. This caused both silent endings. | `packages/domain/src/config/schema.ts` (`AGENT_STYLE_RUNTIME_DEFAULTS`, `RUNTIME_POLICY_CEILINGS`); `packages/llm/src/llm-provider.ts` (`resolveReasoningParams`); the judge retry in `structured-tool-loop.ts`; the empty-reply path in `agent.ts` |
| R1 | The prompt tells the agent to reply, then carry on: "After responding, continue your job". An acknowledgement satisfies "reply". | `apps/worker/src/runtime-composition.ts` (Instructions block, about line 2723) |
| R2 | One coarse marker. Any successful `send_message` advances `answeredUpToTs` past every user message in the window, so an acknowledgement closes the request. | `computeAdvancedAnsweredMarker` (`runtime-composition.ts`, about line 2875); `advanceAnsweredMarker` (`agent.ts`) |
| R3 | "Report back" lives only in the chat, not in saved state. The window is trimmed by size and a restart loses conversation memory. | `conversation-window.ts` `trimConversationWindow` |
| R4 | Latent, not seen in this incident: the run-end rules are about units of work, not about the user. With an empty task list, "no unit is pending" is true at once, and `finish_run(waiting)` is allowed for an `ongoing` goal and skips the nudge. | `packages/domain/src/skills.ts` (`LONG_RUNNING_TASK_SKILL`, step 7); `continuation-guard.ts` |
| R5 | The nudge is generic and says nothing about the user or what was promised. | `CONTINUATION_NUDGE_TEXT` |
| R6 | Agents without `finish_run` get no end-of-run check, and the plain-text reply fallback only runs when the agent sent no message in the run. | `agent.ts` (about line 4594) |
| R7 | Nothing measures the failure, and the user cannot see that the agent is working, failed or is waiting. Asking is their only option. | n/a |

## Goal

For every message a user (or a child's creator) sends, the agent reports an outcome, or says it is still working and when the user will hear next, with no special wording from the user. A run cannot end silently after the agent promised something. If a run dies, the agent is woken quickly to say so. The user can always see what state the agent is in.

## Non-goals

- The platform does not decide whether the work is done, how long it should take, or how the agent splits it. It only checks that the user has been told the outcome or the state (Agent Mode Purity, `docs/best-practices/agent-runtime.md`).
- The platform never writes a chat message to the user (D9). The status line (D16) is not a chat message.
- No wall-clock cap on runs and no forced continuation beyond the caps below.
- No new wake source and no change to the tick gate.
- No change to trading agents' trading behaviour.
- No database migration. The owed-outcome record lives in Redis, like `agent:conversation:answered_at:*` and the reminders.
- No change to the job-search skill (D8) and no change to `finish_run`'s tool schema.
- Not solved here: the job-search skill storing records in workspace files that do not survive a restart. That belongs to the owner's reconciliation of the two skills. Also not here: the unrelated defects listed in `evidence.md`.

## Behaviour (what the user and the operator will see)

1. A model call always has room for an answer after thinking. When an answer is still cut off, the platform retries once with less thinking and a hint to make smaller tool calls, instead of resending the same request.
2. A user message is received. The agent replies as today. If the reply is an acknowledgement and the agent then works, an outcome stays owed.
3. While the agent works, each model call shows it one line: when it last told the user something and that the outcome is still owed.
4. Before the run ends (no tool call, or `finish_run`) after work since its last message, the agent is asked once, with the concrete facts, to tell the user what is done, what remains and when they will hear next.
5. If a run ends or fails with an outcome owed, the platform wakes the agent: about 2 minutes after a failed run, or at the next-update time it gave (default 15 minutes). At most 3 wakes per owed outcome. A wake is skipped when one of the agent's own reminders is about to wake it anyway.
6. The user sees a status line in the chat: "Working since 09:32", "Last run failed at 09:48, retrying at 09:50", "Waiting for your answer" or "Next run at 10:02".
7. A plain question ("Do you have my CV?") is answered in one message, owes nothing afterwards, and costs no extra model call.
8. Agents that have not been given any user message behave as today, except for fix 1, which applies to every model call.

## Design

### A. Output budget, cut-off recovery, prompt text (Phase 1)

**A1. Output budget (R0, D13).** In `packages/domain/src/config/schema.ts`:

- Add `judgeOutputReserveTokens` (default 16,384) and `scoutOutputReserveTokens` (default 4,096) to the runtime policy, with ceilings.
- Raise the style defaults so the rule in D13 holds. Proposed values (O10):

  | Style | `scoutMaxTokens` now → proposed | `judgeMaxTokens` now → proposed |
  |---|---|---|
  | careful | 1,024 → 6,144 | 4,096 → 26,624 |
  | balanced | 2,048 → 8,192 | 8,192 → 36,864 |
  | bold | 4,096 → 12,288 | 16,384 → 49,152 |
  | ceiling | 4,096 → 16,384 | 16,384 → 65,536 |

- `resolveAgentRuntimePolicy` raises a resolved limit that breaks the rule (for example an older override) to the minimum the rule needs, and logs it once. An override cannot recreate the incident.
- Why not "the maximum possible": (1) a limit above the model's maximum output is rejected by the provider, and there is no per-model output maximum in the code today, so add `maxOutputTokens` per model (default 32,000 for an unknown model) and clamp each request to it; (2) calls are not streamed and `LLM_TIMEOUT_MS` defaults to 60 seconds (the cut-off call took 34.8 s for 8,192 tokens), so the timeout must scale with the limit: `timeoutMs = max(LLM_TIMEOUT_MS, limit × llm.timeoutMsPerOutputToken)` (config, default 6 ms, so 49,152 tokens get about 5 minutes); (3) a model given more room tends to think longer. Billing is for tokens produced, not for the limit, so a higher limit costs nothing on calls that do not need it. The reserve rule gives every call room for an answer without paying for an unbounded think.
- `apps/worker/src/tools/platform-docs-data.ts` lists the per-style token values; update it.

**A2. Cut-off recovery (R0).** When a judge or scout call ends with finish reason `length`, either as an empty reply or as `llm.invalid_tool_args` from cut-off arguments:

- Retry at most `llm.lengthRecovery.maxRetries` (default 1) times per turn with the reasoning level one step lower (`high` → `medium` → `low`) and a turn-context line: "Your last response was cut off at the output limit. Think briefly and make smaller tool calls (split long file content across `append_file` calls)." This replaces the current retry of the same request for that cause only. Other causes keep today's retry.
- An empty reply with finish reason `length` is not the end of the run. After the recovery retries are used, it is handled like any other stop (B and C apply).
- Log each recovery with the old and new reasoning level.
- Find the exact retry site before implementing (the "Retrying judge LLM call after backoff" path in `structured-tool-loop.ts` or `packages/llm`).

**A3. Instructions block** (`runtime-composition.ts`, about line 2723). Replace "After responding, continue your job, if any." with:

> An acknowledgement is not an outcome. When you start work that takes more than a moment, use `send_message` to inform the user what you will do, and when you will next update them, and send another when you finish or when you cannot finish this run. Do not end a run while you owe the user an outcome. If you cannot finish, say what is done, what remains and when you will continue.

Update the test that pins this text (`runtime-composition.test.ts`, about line 192).

**A4. Base skill** (`BASE_SKILL.instructions`, near the `send_message` line). Phase 1 adds the principle in one sentence. Phase 2 adds one short block on `status` and `nextUpdateInMinutes`. Re-measure the base-skill size and record it.

**A5. `long-running-task`** (`skills.ts`), additive only, in EACH RUN:
- Step 1: "If a user message woke you, or the Conversation section shows an owed outcome, add that request as a unit (a task) before other work, including a final unit 'tell the user the outcome'."
- Step 7, before `finish_run`: "Check that nothing you told the user you would do is still undone. If something is, it must be a pending unit, and you must have told the user when they will hear next."

This text helps but is not the guarantee. Sections B and C are.

### B. Run trace, reminder line and run-end report-back check (Phase 2)

A pure module `apps/worker/src/follow-through.ts`, easy to test.

**Run trace.** The judge wiring in `agent.ts` records, per run, an ordered list of events: a message to the user (with its optional `status`), or a tool call classified as `work` or `bookkeeping`. It is fed from `onToolResult` (where `judgeSentReply` and `judgeToolCallsUsed` are set).

**Classification.** A fixed map from tool name to `message`, `bookkeeping` or `work`:
- `message`: `send_message`. (`send_email`, `message_peer_agent` and `message_child_agent` do not tell the user, so they are `work`.)
- `bookkeeping`: `finish_run`, memory tools, task tools, reminder tools, skill tools, `list_*` and `get_*` reads of the agent's own state, `read_skill`, `get_thread`, `get_message`.
- Everything else is `work`. A missed classification costs at most one extra nudge, never a missed one.
- A drift-guard test checks that every registry tool is either in the bookkeeping list or knowingly `work`.

**Reminder line (new).** The loop already adds a run-status line to each model call (`getTurnContext`, sent for that request only and not stored). When the run owes the user an outcome (below) and at least `minWorkCallsSinceMessage` `work` calls followed the last message, append:

> Last message to the user: 09:32 (9 min ago). Their request at 09:32 has no outcome message yet.

It adds no model call. It covers silence inside a long run, which no end-of-run check sees. In Phase 2 it reads the owed-outcome record instead of the run trace, so it also works after a restart.

**The check.** `decideReportBack(input)` returns `allow` or `nudge(text)`. It nudges when all hold:
1. The run owes the user an outcome: the run began with a pending user message (`hasPendingUserMessage`) and the agent sent at least one message in this run. (If it sent none, the existing plain-text fallback handles it.) An open owed-outcome record (section C) is a second reason.
2. At least `minWorkCallsSinceMessage` (default 3) `work` calls succeeded after the last message to the user.
3. No message with a closing status (`completed`, `input_required`, `failed`, `cancelled`) was sent after that work.
4. The per-run cap is not reached (`reportBack.maxNudges`, default 1).
5. It is not the last allowed turn.
6. `send_message` is in `allowedTools()` now.

**Where it runs (`agent.ts`):**
- **No tool call**, in `onNoToolCalls`, before the continuation nudge. The report-back text takes priority, so one stop produces one nudge. It applies even when `finish_run` is not visible (D4), and after an empty `length` reply once A2's retries are used.
- **`finish_run`**, in the `executeTool` closure, before running it. A nudge refuses the call with `{ ok: false, retryable: false, fault: false, refusal: 'follow_through', error: <text> }`. `recordFinishRun` records nothing for `ok: false`, so the loop continues. The refusal shares the per-run cap and does not count in the tool circuit breaker or the unresolved-failure tracker.

**Nudge text (facts only):**

> You told the user at {time}: "{first 120 chars of your last message}". Since then you made {n} tool calls and have not told them the outcome. Use  `send_message` now, to inform the user what is done, what remains, and when they will hear from you next. Then end the run.

**Side effects.** A nudged turn's reply is not written to history, the judge response history or the timeline (`decideFinalTextPersistence` already takes `continues`). Cost recording and billing still run.

### C. Owed-outcome record, status, precondition, watchdog (Phase 2)

Section B cannot help when the run dies (restart, crash, provider failure, `turn_limit`), as at 09:48. Phase 2 saves the obligation.

**C1. `send_message` parameters (D6, D15).** In `apps/worker/src/tools/messaging.ts` and `SendMessagePayloadSchema` (`packages/domain/src/agent-protocol.ts`):
- `status`: optional enum.
  - `working`: started, not finished, expect more.
  - `input_required`: I need an answer from you before I can go on. The platform does not wake the agent for this.
  - `completed`: this finishes what you asked.
  - `failed`: I could not do it; here is why.
  - `cancelled`: stopped at your request.
- `nextUpdateInMinutes`: optional integer, only meaningful with `working`. Above `maxUpdateMinutes` it is rejected with an error that names the maximum.
- The tool result echoes the status applied. The worker records it on the run trace and the owed-outcome record, not on the conversation row.
- Update the agent-activity mapper (`apps/api/src/routes/agent-activity-mapper.ts`) and `TOOL_CATALOG` (`packages/domain/src/tools.ts`).

**C2. Owed-outcome record (D14).** One Redis string per agent, `agent:owed_outcome:{agentId}`, JSON, parsed with a Zod schema (malformed: skipped with a warning, never crash):

```
{
  since: ISO,                 // first user message that is still owed an outcome
  requests: [{ ref, at, excerpt }], // up to 5 most recent, excerpt 200 chars, for the prompt and nudges
  lastAgentMessageAt?: ISO,
  lastAgentMessageExcerpt?: string,
  lastStatus?: 'working',
  nextUpdateDueAt: ISO,
  lastRunFailedAt?: ISO,
  wakesSent: number,
  state: 'open' | 'stalled'
}
```

- **Open or extend.** When a run starts with a new user message, create the record (or add the message to `requests`). Done for every user message, including plain questions, which are closed again in the same run.
- **Settle at run end**, after the judge loop and the fallback delivery, before `agent.llm.completed`:
  - **Delete** the record when the last message to the user after the newest request has a closing status, or has no status and **no `work` call followed it** (it was the last action, so it was an answer).
  - **Keep open** otherwise, with `nextUpdateDueAt = now + (nextUpdateInMinutes ?? defaultUpdateMinutes)`. This is what stops an unlabelled acknowledgement from closing it (R2), even for a model that never sets `status`.
- **Failed run.** On the tick-failure path (`Tick failed; …`) and on `turn_limit`, keep the record and set `lastRunFailedAt = now` and `nextUpdateDueAt = now + recoveryWakeMinutes` (default 2). If the process dies before this, the record keeps the due time it had (at creation, `since + defaultUpdateMinutes`). A failure path never deletes the record.
- **Expiry.** The key has a Redis TTL of `maxAgeHours` (default 24), refreshed on each write. The `requests` list keeps the 5 newest.
- A user's "stop" or "cancel" is a normal message; the agent answers with `cancelled` and the record is deleted.

**C3. Prompt.** `buildConversationSection` renders the record before the message list, so window trimming cannot lose it (R3):

```
## Outcome owed to the user
Since 09:32: "Strictly follow the instructions in openaidom/skills/job-search -> rebuild all the files…" (#554be48d), "No feedback?" (#c8713684).
You last told the user at 09:44: "Rebuild resumed…". No outcome sent yet. Your last run failed at 09:48.
```

A stalled record says so. `[awaiting reply]` is unchanged (D7).

**C4. `finish_run` precondition.** When the record is open, `finish_run` is refused until the agent has sent, in this run, a closing message or a `working` message (which sets the next update time). This closes the `waiting` loophole for an `ongoing` goal (R4). It shares the per-run cap in B. `blocked` needs a `failed` or `input_required` message (O7).

**C5. Watchdog** (`apps/worker/src/reminder-coordinator.ts`). `tick()` already loops over active agents and calls `processAgentReminders`. Add `processOwedOutcome(agentId, now)`:
- When the record is `open`, `nextUpdateDueAt <= now` and `wakesSent < maxWakes` (default 3):
  - If one of the agent's reminders is due at or before `now + reminderGraceMinutes` (default 5), skip this poll (D5). The reminder wakes the agent and the prompt shows the owed outcome.
  - Otherwise publish `emitAgentWake(agentId, { source: 'reminder', priority: 'normal', context: { reminderId: 'owed-outcome', key: 'owed-outcome', scheduledBy: 'judge', message } })`. The message states the facts, says what to send, and ends "If you already told the user the outcome, do nothing."
- After a successful publish: `wakesSent += 1`, `nextUpdateDueAt = now + backoff` (doubling from `defaultUpdateMinutes`: 15, 30, 60). On a publish failure leave the record unchanged; the next poll retries.
- At the cap, set `state: 'stalled'`: shown in the prompt and the status line, logged, counted, not woken again.
- Paused or stopped agents are skipped (`listActiveAgents`). After a resume a due record produces one wake, not a burst.
- No schema change: `ReminderWakeContextSchema` already has these fields.

**C6. Cleanup.** Delete `agent:owed_outcome:{agentId}` where `agent:reminders:*` and `agent:conversation:answered_at:*` are deleted with an agent (find the path before implementing).

### D. Measurement (Phase 1), chat status line and telemetry (Phase 3)

**D1. Chat status line (D16, Phase 3).** A single line in the agent chat in `apps/web`, near the message input, not a chat message and not stored in the conversation. States, in priority order:

| State | Text | Source |
|---|---|---|
| Run in progress | "Working since 09:32" (with "last update to you 09:32" when an outcome is owed) | Tick start/finish activity events |
| Last run failed, outcome owed | "Hit a problem at 09:48. Retrying at 09:50." | Owed-outcome record (`lastRunFailedAt`, `nextUpdateDueAt`) |
| Stalled | "No update since 09:32. The agent has not responded to 3 retries." | Record `state: 'stalled'` |
| Waiting on the user | "Waiting for your answer" | Last message status `input_required` |
| Idle | "Next run at 10:02" or "Idle" | Next reminder or expected tick |

- One read-only API endpoint returns the state, built from the owed-outcome record, the latest tick events and the next reminder. Find the existing chat component, the API route pattern and whether the activity stream can push updates before implementing; prefer the existing stream over polling.
- It shows times in the user's time zone.
- It never shows tool names, error codes or internal detail.

**D2. Telemetry.** Phase 1 adds `lengthRecoveries` to the judge `agent.llm.completed` event and a log line per recovery. Phase 3 adds the rest. `agent.llm.completed` (judge) gains optional fields beside `nudgeCount` and `finishRunStatus`: `reportBackNudges`, `lengthRecoveries`, `owedOutcomeAtEnd` (`none`, `open`, `closed`, `stalled`). Built by a helper in `follow-through.ts`. Log lines: record opened, settled (and why), watchdog woke or skipped (and why), stalled, length recovery.

**D3. Measurement and evaluation (Phase 1).** It changes nothing at runtime, so it ships with Phase 1 and gives the decision gate its numbers. The "No feedback?" metric: a user message within 15 minutes of an agent's last message, with no agent message in between. Computed from stored conversation rows. Add it, and a check for `length` finish reasons and `llm.invalid_tool_args` in the logs, to `.github/skills/evaluate-job-search-agent/SKILL.md` and `evaluate-agent`. Scenario: a multi-step request in plain wording, no mention of reporting, and a second run where the worker is stopped mid-run. Record what the user saw and when. Phase 1 passes when the user sees a start message, then an outcome or a progress message. The forced-stop result is recorded for the gate, not required to pass, because only Phase 2 adds the recovery wake. When Phase 2 or 3 ships, add their checks: a message within `recoveryWakeMinutes` plus one poll after the forced stop, and the status line showing each state.

### E. Docs

- `docs/best-practices/agent-runtime.md`: a "Request follow-through" section next to "Continuation Guard" (run trace, reminder line, check, record, watchdog, config, cost, Cost Review Checklist outcome). A note in the runtime-policy section on the output-reserve rule (D13). Say the report-back check is not opt-in by skill (D4).
- `CHANGELOG.md` (Unreleased): Added and Changed entries per phase.
- `apps/worker/src/tools/platform-docs-data.ts`: token values per style and the `send_message` fields. `scripts/ts/build-docs-index.ts` mirrors skill text and runs in `pnpm build`.

## Config

All limits live in the schema. In `packages/domain/src/config/schema.ts`:

Runtime policy (per style, with ceilings): `judgeOutputReserveTokens` (default 16,384), `scoutOutputReserveTokens` (default 4,096), and the raised `judgeMaxTokens` and `scoutMaxTokens` in A1.

Beside `continuationGuard` (`llm.*` in Phase 1; `followThrough` only in Phase 2):

```
llm: {
  lengthRecovery: z.object({ maxRetries: z.number().int().min(0).default(1) }).default({}), // 0 = today's retry
  timeoutMsPerOutputToken: z.number().int().min(0).default(6),
  // plus a per-model maxOutputTokens table and its default for unknown models (32_000)
}
followThrough: z.object({
  reportBack: z.object({
    maxNudges: z.number().int().min(0).default(1),          // 0 turns the check off
    minWorkCallsSinceMessage: z.number().int().min(1).default(3),
  }).default({}),
  owedOutcome: z.object({
    defaultUpdateMinutes: z.number().int().min(1).default(15),
    maxUpdateMinutes: z.number().int().min(1).default(120),
    recoveryWakeMinutes: z.number().int().min(1).default(2),
    reminderGraceMinutes: z.number().int().min(0).default(5),
    maxWakes: z.number().int().min(0).default(3),           // 0 = no watchdog
    maxAgeHours: z.number().int().min(1).default(24),
  }).default({}),
}).default({}),
```

- Defaults live in the schema only, so workers and agent images of different ages agree.
- No `enabled` flag for Phase 2 (D10). `maxWakes: 0` turns off only the wakes.
- Fit `llm.*` into the existing `llm` config block if there is one; do not create a second.

## Files expected to change

| Phase | File | Change |
|---|---|---|
| 1 | `packages/domain/src/config/schema.ts` | Token values, reserves, ceilings, the D13 rule in `resolveAgentRuntimePolicy`, `llm.lengthRecovery`, `llm.timeoutMsPerOutputToken` |
| 1 | `packages/llm/src/*` (verify) | Per-model `maxOutputTokens` and clamping; scaled timeout |
| 1 | `apps/worker/src/structured-tool-loop.ts` (verify retry site) | `length` recovery: lower reasoning, hint line, one retry |
| 1 | `apps/worker/src/agent.ts` | Empty `length` reply handling; `lengthRecoveries` on the judge event |
| 1 | `apps/worker/src/runtime-composition.ts` | Instructions text (R1) |
| 1 | `packages/domain/src/skills.ts` | `BASE_SKILL` sentence and `LONG_RUNNING_TASK_SKILL` text |
| 1 | `apps/worker/src/tools/platform-docs-data.ts` | Token values per style |
| 1 | `.github/skills/evaluate-job-search-agent/SKILL.md`, `evaluate-agent` | Silence metric, log check, scenario |
| 2 | `packages/domain/src/config/schema.ts` | `followThrough.reportBack`, `followThrough.owedOutcome` |
| 2 | `apps/worker/src/follow-through.ts` (new) | Classification, run trace, reminder line, `decideReportBack`, nudge text, telemetry fields |
| 2 | `apps/worker/src/agent.ts` | Trace in `onToolResult`; reminder line in `getTurnContext`; check in `onNoToolCalls` and the `finish_run` closure; circuit-breaker exclusion; open at message capture, settle at run end, mark failed runs, hydrate for the prompt, `finish_run` precondition |
| 2 | `packages/domain/src/agent-protocol.ts`, `apps/worker/src/tools/messaging.ts` | `status`, `nextUpdateInMinutes` |
| 2 | `apps/worker/src/owed-outcome/owed-outcome-record.ts` (new) | Zod schema and parser |
| 2 | `apps/worker/src/owed-outcome/owed-outcome-store.ts` (new) | Open, extend, settle, fail, read |
| 2 | `apps/worker/src/runtime-composition.ts` | `## Outcome owed to the user` |
| 2 | `apps/worker/src/reminder-coordinator.ts` | `processOwedOutcome` |
| 2 | `apps/api/src/routes/agent-activity-mapper.ts`, `packages/domain/src/tools.ts` | Mapper and catalog for the new fields |
| 2 | `packages/domain/src/skills.ts` | `BASE_SKILL` block on `status` and `nextUpdateInMinutes` |
| 3 | `apps/web` chat (verify), `apps/api` route (verify) | Status line and its endpoint |
| 3 | `apps/worker/src/agent.ts`, `follow-through.ts` | Remaining telemetry fields |
| all | `docs/best-practices/agent-runtime.md`, `CHANGELOG.md` | Docs (section E) |

## Rule fit

- **Agent Mode Purity.** Nothing limits what the agent may do or how long it works. A larger output limit gives it more room. The platform enforces only that the user is told, with facts, not judgements.
- **No hardcoded thresholds.** All numbers are in the schema.
- **Reuse over invention.** The `finish_run` refusal path, `getTurnContext`, the reminder wake source and coordinator, the Redis pattern, the nudge plumbing. Status names from MCP Tasks and A2A.
- **Tool circuit breaker.** A follow-through refusal is not a tool failure.
- **No migration.** Redis only.

## Cost and interactions

- **A1 output budget.** Billing is per token produced, so a higher limit costs nothing on calls that do not need it. Calls that would have been cut off now complete, which costs more per call but removes the retries and the wasted run. Watch average output tokens per judge call on staging before and after. Longer non-streamed calls hold a connection longer; the scaled timeout covers it.
- **A2 length recovery.** At most 1 extra call per cut-off turn, and it replaces today's identical retry, so it adds nothing in the worst case.
- **B.** The reminder line adds about 120 characters to a model call only while an outcome is owed. The report-back check adds at most `reportBack.maxNudges` (1) call per run, only when a run ends after work with no outcome. A well-behaved run pays nothing.
- **C.** Each watchdog wake is one judge tick. Worst case 3 per owed outcome, plus none when an agent reminder covers it. One Redis read per active agent per coordinator poll, the same order as `agent:reminders:*`.
- **D.** One API read per open chat; no model cost.
- **Cost Review Checklist** (`agent-runtime.md`), to record after implementation:
  - New `requestWakeDrivenTick()` path: yes, the watchdog. Source `reminder`, already in the taxonomy.
  - Conditional `instance.context.snapshot` emission: none added.
  - New repeating failure mode: the watchdog, bounded by `maxWakes` and the TTL; a failed run sets a 2-minute wake but `wakesSent` still caps it. Proposed: no `SessionCircuitBreaker` plumbing (owner to confirm).
  - Re-run `apps/worker/src/runtime-resilience.test.ts`.
- **Continuation guard.** Report-back first; then the continuation nudge as before. Worst case per run: `reportBack.maxNudges` + `continuationGuard.maxNudges` extra calls.
- **Stop hook.** A refused `finish_run` records nothing, so `shouldStopAfterToolResults` stays false.
- **Reminders.** The watchdog skips when an agent reminder is due soon. If both still fire close together, the second tick sees the record closed and the wake text says to do nothing.

## Edge cases (each needs a test or an explicit decision)

1. Plain question answered in one message: the record opens and is deleted in the same run. No nudge, no wake.
2. Acknowledgement, 1 or 2 quick lookups, then an answer: no nudge.
3. Acknowledgement, 10 work calls, `finish_run` with no message: refused once with the concrete text; after the report, allowed.
4. The agent ignores the refusal and calls `finish_run` again: allowed after the cap. The record stays open and the watchdog covers it.
5. `completed` sent, then housekeeping `work` calls: the record stays deleted. A later `work` call does not reopen it.
6. Two messages in one run: only the last decides.
7. Several user messages while the agent works: all join one record; one closing message deletes it.
8. The run fails (provider error, `turn_limit`): the record stays open with a 2-minute wake. The process dies: the record keeps its earlier due time.
9. The agent is paused when a wake is due: no wake. After resume, one wake.
10. A child agent: the creator's instruction arrives as a USER entry, so the same mechanism applies.
11. An empty reply with finish reason other than `length`: unchanged, ends the run, never nudged. With `length`: A2 recovery first, then B.
12. Last allowed turn: no nudge and no refusal.
13. `send_message` hidden by the circuit breaker or allowance: the check returns `allow`.
14. Redis read failure: warn and treat as nothing owed for this tick. A write failure does not fail the tick.
15. A wake for a record that was closed meanwhile: the agent sees nothing owed; the wake text says to do nothing.
16. A wake published but the record update fails: a second wake on the next poll, bounded by `maxWakes`.
17. "ok" or "thanks": opens and closes in the same run.
18. An override sets `judgeMaxTokens` below the rule: raised at resolve time and logged.
19. A model whose maximum output is below the computed limit: clamped to the model maximum; the reserve rule is then met by lowering the reasoning level for that call, and logged.
20. All stored times are UTC ISO strings; the prompt renders `HH:MM` UTC; the status line renders the user's time zone.

## Test plan (behaviour-named, per `AGENTS.md`)

Phase 1:
- Schema: every style default and the ceilings satisfy the D13 rule; an override below the rule is raised; the scaled timeout; clamping to a model's maximum output.
- Length recovery: a cut-off tool call is retried once with a lower reasoning level and the hint; an empty `length` reply is retried, not ended; other failure causes keep today's retry; `maxRetries: 0` behaves as today; `lengthRecoveries` is counted on the event.
- `runtime-composition.test.ts`, `skills.test.ts`: the new text.

Phase 2:
- `follow-through.test.ts`: nudges after an acknowledgement plus enough work and no outcome; not below the threshold; not after a closing status; not when nothing is owed; never on the last turn; stops at the cap; not when `send_message` is unavailable; the nudge text has the time, excerpt and call count; the reminder line appears only when owed and past the threshold.
- Tool classification drift guard.
- Judge-loop wiring: report-back takes priority over the continuation nudge; a refused `finish_run` records nothing and the loop continues; a refusal is not a circuit-breaker failure; a nudged turn's reply is not stored.
- `maxNudges: 0`: the loop behaves as before.
- `owed-outcome-record.test.ts`: valid and malformed records.
- `owed-outcome-store.test.ts`: open on capture; extend with a second message; delete on a closing status; delete on an unlabelled message that is the last action; keep open when work followed; failed run sets the recovery due time; the TTL is refreshed; fail-soft on Redis errors.
- `messaging.test.ts`: `status` and `nextUpdateInMinutes` optional; out-of-range rejected with the maximum named; the result echoes the status.
- `runtime-composition.test.ts`: the owed-outcome section renders, survives window trimming, labels a stalled record and a failed run.
- Reminder coordinator: wakes when due; skips when an agent reminder is due within the grace; increments and backs off; stops at `maxWakes` and stalls; leaves the record unchanged on publish failure; ignores closed records; skips inactive agents.
- `finish_run` precondition: refused while owed with no message; allowed after a closing or `working` message; shares the cap.
- `runtime-resilience.test.ts` still passes.

Phase 3:
- Status endpoint: each state from its inputs, in the priority order, with no internal detail.
- Web: the line renders each state and updates without a reload.

## Verification (live)

Phase 0: done 2026-11-26, see `evidence.md`.

After Phase 1 on staging (`job-searcher` and at least one other agent with chat traffic), for about a week:
1. Send the same request in plain wording. Expect a start message, then an outcome or a progress message, and no `length` finish reason or `llm.invalid_tool_args` in the logs.
2. Run the evaluation scenario, including stopping the worker mid-run, and record what the user saw and when.
3. A plain question: one message, no extra call.
4. A trading agent with a chat message: no change in trading behaviour.
5. Each day, record: cut-off calls, `lengthRecoveries`, failed ticks, "No feedback?" events, average judge output tokens and cost per tick (compared with the week before).
6. Write the numbers and the gate decision in `results.md`.

## Decision gate after Phase 1

Decided by the owner from `results.md`:

| What we see | Decision |
|---|---|
| No cut-off calls, no "No feedback?" events, and the forced-stop test still leaves the user waiting | Phase 1 worked for its cause. Build the failed-run part of Phase 2 (record, recovery wake, watchdog), or accept the restart and outage risk. |
| Silences after an acknowledgement still happen | Build Phase 2 in full. |
| Users still ask what the agent is doing | Build Phase 3 (status line). |
| Cost per tick rose noticeably | Lower the output reserves before going further. |
| Cut-off calls still happen | Revisit A1 and A2 before anything else. |

After Phase 2:
7. Same request, then stop the worker mid-run. Expect a wake within `recoveryWakeMinutes` plus one poll, and a message to the user.
8. Check `agent:owed_outcome:<id>`: created, then deleted on a closing message.
9. An agent that never answers: `maxWakes` stops the wakes and the prompt shows `stalled`.
10. Re-run `evaluate-job-search-agent` and compare with the 2026-11-17 and 2026-11-19 baselines.

After Phase 3:
11. Watch the status line through a run, a forced failure and a question.

## Rollout

- Phase 1 ships on staging with the agent image pin and runs there for about a week (D17). It moves to production when the staging numbers show no cost problem; it does not wait for the gate's decision on Phases 2 and 3. Roll back by releasing the previous worker and agent image together, or first revert the token values with per-agent overrides and then release the previous image. Before releasing the previous worker, clear any per-agent `judgeMaxTokens` override above 16,384 and any `scoutMaxTokens` override above 4,096. Reverted token values in per-agent overrides take effect only after the previous worker is released, because the new worker raises an override that is below the thinking budget plus the output reserve. `lengthRecovery.maxRetries: 0` turns off only the cut-off recovery.
- Phase 2 is built only if the decision gate calls for it. It has no flag (D10), so it ships on staging first and moves to production only after its staging checks (7 to 10) pass. `reportBack.maxNudges: 0` turns off its run-end check. Leftover Redis keys expire by TTL; the previous image ignores them.
- Phase 3 needs the API and web release as well as the agent image; the status line tolerates a missing record.
- Each phase gets a CHANGELOG entry and a `results.md` in this folder.

## Work packages

Phase 1:
1. **WP0 Evidence.** Done (`evidence.md`).
2. **WP1 Output budget.** A1, with tests.
3. **WP2 Length recovery.** A2 and `lengthRecoveries`, with tests.
4. **WP3 Text.** A3, the A4 sentence and A5, with pinned tests.
5. **WP4 Measurement.** D3: silence metric, log check and scenario in the `evaluate-*` skills.
6. **WP5 Phase 1 docs** and CHANGELOG, then `pnpm test`, lint and build.
7. **WP6 Staging week and `results.md`**, with the gate decision.

Phase 2 (only if the gate calls for it):
8. **WP7 Config and pure module.** `followThrough.*`, `follow-through.ts`, with tests.
9. **WP8 Wiring.** `agent.ts` for B.
10. **WP9 `send_message` fields.**
11. **WP10 Owed-outcome record**, store, settle, failed-run marking, prompt section.
12. **WP11 Precondition.**
13. **WP12 Watchdog.**

Phase 3 (only if the gate calls for it):
14. **WP13 Status line** (endpoint and web).
15. **WP14 Remaining telemetry.**

## Risks

- **Bigger calls.** A higher output limit lets some calls run longer and cost more. Mitigation: the reserve rule, not the model maximum; measure before and after (verification 5).
- **Provider rejects the limit.** Mitigation: per-model `maxOutputTokens` clamp.
- **Timeouts on long calls.** Mitigation: the scaled timeout.
- **False-positive nudges.** Mitigation: threshold of 3 work calls, cap of 1, one model call, not a user message.
- **Over-messaging.** Mitigation: the prompt asks for "when you will next update them", not "update often".
- **Classification drift.** Mitigation: default `work` and the drift guard.
- **Inference is a guess.** An answer followed by a housekeeping write keeps the record open and costs one harmless nudge. A declared `status` overrides inference.
- **Prompt growth.** Measure and record.
- **Phase 2 blast radius.** New Redis state and wakes, no flag. Mitigation: staged image rollout, caps, TTL, fail-soft reads.
- **Two wakes racing.** Mitigation: the reminder-grace skip and the "do nothing" text.

## Open questions (for the owner)

Decided: O1 (D9), O2 (D10), O3 (D14, no `inReplyTo`), O5 (D12), O6 (D11), O10 (D18).

- **O4.** When the agent sent an acknowledgement and then writes its outcome as plain text without `send_message`, should that text be delivered automatically? Proposed: no; the report-back nudge covers it.
- **O7.** `finish_run(blocked)`: proposed to require a `failed` or `input_required` message. Confirm.
- **O8.** Rename `[awaiting reply]`, or leave it (D7)?
- **O9.** Skill-set trimming per goal type is out of scope. Confirm.

## Acceptance criteria

Phase 1:
- Every style default and ceiling satisfies the D13 rule; no request exceeds the model's maximum output.
- A cut-off call is retried with less thinking, not resent unchanged.
- On staging, a week with no cut-off call and no failed tick caused by `length`.
- A plain question gives one reply and no extra call.
- `lengthRecovery.maxRetries: 0` restores today's retry.
- The silence metric, log check and scenario are in the `evaluate-*` skills, and `results.md` records the week's numbers and the gate decision.
- `pnpm test`, lint and build pass.

Phase 2:
- With no special wording, an agent that acknowledges, works and stops without a message is made to report once.
- A refused `finish_run` records nothing, is not a circuit-breaker failure and cannot loop. `reportBack.maxNudges: 0` restores today's loop.
- A failed run with an outcome owed gets a wake within `recoveryWakeMinutes` plus one poll, and the user gets a message.
- The prompt shows the owed outcome after a restart.
- `finish_run` is refused while an outcome is owed and unreported.
- Wakes are bounded and `maxWakes: 0` turns them off.

Phase 3:
- The chat status line shows working, failed-and-retrying, stalled, waiting for the user and idle, with no internal detail.
- Judge completion events carry the remaining fields.

## Implementation Task List

Phase 1:
- [x] WP0 Evidence note for the 2026-11-25 run (`evidence.md`)
- [x] DONE WP1 Output budget (A1)
- [ ] PENDING WP2 Length recovery (A2) and `lengthRecoveries`
- [ ] PENDING WP3 Instructions block, base-skill sentence and `long-running-task` text
- [ ] PENDING WP4 Measurement in the `evaluate-*` skills
- [ ] PENDING WP5 Phase 1 docs and CHANGELOG; full test, lint and build
- [ ] NOT STARTED (needs a staging deploy and a week of traffic; owner-run) WP6 Staging week, `results.md` and gate decision

Phase 2 (if the gate calls for it):
- [ ] WP7 `followThrough` config and `follow-through.ts`
- [ ] WP8 `agent.ts` wiring for B
- [ ] WP9 `send_message` `status` and `nextUpdateInMinutes`
- [ ] WP10 Owed-outcome record, store, settle, failed-run marking and prompt section
- [ ] WP11 `finish_run` precondition
- [ ] WP12 Watchdog
- [ ] Staging verification of Phase 2

Phase 3 (if the gate calls for it):
- [ ] WP13 Chat status line
- [ ] WP14 Remaining telemetry

## Outstanding Issues

- Not checked while drafting (verify before implementing): the retry site for `llm.invalid_tool_args`; whether any LLM call is streamed; where a per-model output maximum should live; where user messages are captured (`agent.ts` about lines 3056 to 3190); the tick-failure path for marking a failed run; where per-agent Redis keys are cleaned up on delete; the web chat component and how it receives activity updates; whether the tick gate lets a `reminder` wake through while a run is active.
- Unrelated defects from Phase 0, to file separately: trading reads on a non-trading agent's ticks; Conversation section ordering (`#26c7f840` before `#cf8ca737`).

### WP1 Output budget (from the last code review, no critical or high)

- MEDIUM (owner decision): for token-budget (non-Claude) models not in the output table, the 32,000 default makes bold step down to `low` while balanced steps to `medium`, so bold thinks less than balanced. Option: keep the level and cap the thinking budget at `maxTokens − reserve` instead (changes edge case 19 wording).
- LOW: `AgentOutputLimitsSchema` is declared below `resolveAgentLlmTimeoutMs` in `runtime-lifecycle.ts`.
- LOW: the hybrid evaluator passes `LLM_BASE_TIMEOUT_MS` through unvalidated (NaN if the env value is malformed; pre-existing for `LLM_TIMEOUT_MS`).
- LOW: the container timeout for older images is scaled from the unclamped limit (overestimates; safe direction). Worth a comment.
- LOW: a future model id such as `claude-opus-4-9` matches `claude-opus-4` (32,000, safe but low); add new models to the table when they ship.
- Not done: the web overrides form does not expose the two reserve fields; a user's low override is silently raised (the API returns the effective value).

