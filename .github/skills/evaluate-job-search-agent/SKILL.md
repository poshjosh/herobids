---
name: evaluate-job-search-agent
description: 'Evaluate a job-search agent after a run: did it follow openaidom-skills job-search and the platform long-running-task skill, did the continuation guard and finish_run behave, did the new make_http_request paging, web cache and references file get used, and did the agent find and verify jobs. Use when asked to evaluate, audit or compare a job-search agent run, to check the effect of skill, tool-limit or continuation-guard changes, or to compare against the 2026-11-17 baseline.'
argument-hint: 'agent-id (required), evaluation-period, deployment-target, baseline (e.g. "agent-id=abc123 period=since-start baseline=builtin")'
---

# Evaluate Job-Search Agent

Read-only analysis of one agent that runs `openaidom/skills@job-search` on top of `system/long-running-task`. It answers one question: did our changes make the agent search, validate and report better, and did the platform behave as designed? It collects evidence into a versioned folder, checks it against the lists below, and writes `REPORT.md`.

Use `evaluate-agent` for trading agents. This skill is for job-search agents and borrows its output-folder convention and memory hygiene.

## When to Use

- After a test run of a job-search agent on a rebuilt image or a new skill commit.
- To compare a run with the builtin baseline below or with an earlier evaluation folder.
- To validate a specific change: the long-running-task stop rule, the job-search Step 3 loop and run time allowance, `references/finding-and-validating-listings.md`, the `make_http_request` paging and web cache, the continuation guard, or the clearer `provider.invalid_tool_args` message.

## When Not to Use

- To fix anything (see Constraints).
- For trading agents (`evaluate-agent`).
- When the agent has not finished at least one judge run since it was (re)created. Say so and stop.

## Inputs

| Parameter | Description | Default |
|-----------|-------------|---------|
| `agent-id` | Agent UUID | Required |
| `evaluation-period` | Time window, e.g. `17:40-now (UTC)` or `since-start` | `since-start` (the agent's first tick) |
| `deployment-target` | Where the stack runs | `local docker compose (development)` |
| `baseline` | `builtin` (below), or the path of an earlier evaluation folder | `builtin` |
| `output-folder` | Base path for saved data | `.ignore/eval/yyyy/MM/dd/<agent-id>/<serial>/` |

Commands below are for local docker compose (containers `herobids-agent-<agent-id>`, `herobids-postgres-1`, `herobids-redis-1`, `herobids-worker-1`, `herobids-api-1`; database `herobids`, user `herobids`). For another target use the equivalent access and note it in the report.

## Builtin baseline (agent 42008a23, 2026-11-17, before these changes)

Model `anthropic/claude-haiku-5.5`, user-chosen search interval 15 minutes, 52 minutes observed.

- 6 judge runs: 23 to 63 s each (median about 47 s), 4 to 7 turns, 12 to 17 tool calls, all `finishReason: stop`, `nudgeCount: 0`, and every run ended `finish_run waiting` while units were pending.
- Index `runBudget` was `"one search or report cycle per run"`.
- 2 `search_web` queries in total, 8 leads, 0 verified open, none shown to meet the criteria.
- 0 calls to `make_http_request`; no read of a references file (none existed); search hits were aggregator category pages (one returned 524 characters for 89 jobs).
- Validation of the first batch of leads was deferred across three runs.
- Continuity was real but shallow. Every run began by reading its task list and index, and later runs built on earlier findings (an expired listing stayed dropped, a wrong link stayed flagged). But the same two category pages were fetched again in the next run, although the earlier run had already judged them useless, because only searches were written to the ledger and no fetch outcomes were.
- Memory held only `prefs/user`, `candidate-profile`, `jobsearch/status`, `ltt/jobsearch/index`, `jobs/summary`, `search/search-ledger`. No per-job records, strategies, statistics or report state.
- Tool errors: `add_skills` twice with `broker.timeout`, and one `create_task` with empty arguments.

## Procedure

### Step 1 — Determine the output folder

`.ignore/eval/<yyyy>/<MM>/<dd>/<agent-id>/<serial>/`, `<serial>` zero-padded from `01`; if it exists, increment.

### Step 2 — Collect evidence (to disk, never into context)

Save everything under `<output-folder>` and analyse it with `jq`, `grep`, `rg` and scoped SQL.

1. **Agent log:** `docker logs herobids-agent-<agent-id> > logs/agent.log 2>&1`. Also grep `logs/worker.log` and `logs/api.log` for the agent id.
2. **Database** (`docker exec herobids-postgres-1 psql -U herobids -d herobids ...`), scoped to the period:
   - `agent_messages` for the agent: types `agent.tick.started`, `agent.tick.completed`, `agent.tick.skipped`, `agent.llm.dispatch`, `agent.llm.completed`, `agent.tool.call`, `agent.tool.result`, `agent.message.send`, `agent.manage_skills`, `agent.runtime.heartbeat` (exclude heartbeats from the saved file; count them).
   - The agent's messages to and from the user: find the conversation first (`\d conversations`, `\d agents`; the conversation links to the agent through its owner or peer key), then save `conversation_messages` (`sender_type`, `channel`, `subject`, `body`, `delivery_status`, `created_at`).
   - `agent_artifacts`, `agent_runtime_sessions`, `billing_usage_events` for the agent, and the `agents` row (without secrets).
3. **Redis** (run `TYPE <key>` first; `agent:memory:*`, `agent:tasks:*` and `agent:reminders:*` are hashes):
   - `agent:memory:<id>`: all fields. Keep the CV-derived `candidate-profile` out of the report (see Constraints).
   - `agent:tasks:<id>`, `agent:reminders:<id>`.
   - `agent:prompt:judge-user-context:<id>` (a string with a 1-hour TTL: capture it right away, and note when).
4. **Workspace** (`docker cp herobids-agent-<agent-id>:/workspace/<path> workspace/`): `skills-lock.json`, `.agents/skills/job-search/` (SKILL.md and `references/`), a listing with sizes of `web-cache/` (not its contents), and the first 40 lines of two cached files.
5. **Resolved skills and policy:** extract only what you need from the container's `AGENT_CONFIG` with `docker inspect ... --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^AGENT_CONFIG=' | cut -d= -f2- | jq '.runtimeDescriptor.resolvedSkills[] | {id, slug, instructions}'`. Never print the whole variable.

### Step 3 — Confirm what was actually running (do this before judging anything)

Without it a test of old code looks like a failed change.

| Check | Evidence |
|-------|----------|
| P1 Job-search skill commit | `workspace/skills-lock.json` commit equals the pushed `openaidom-skills` commit you expect (`git -C <openaidom-skills> log origin/main -1`); the installed `SKILL.md` equals `git show <commit>:skills/job-search/SKILL.md` |
| P2 Skill markers | Installed `SKILL.md` contains "Before searching, read" and "Repeat this step until"; `references/finding-and-validating-listings.md` exists in the workspace |
| P3 long-running-task text | Resolved `long-running-task` instructions contain "Do as many units as you can until a stop condition is met" and "when a run must stop" |
| P4 Image age | `docker image inspect herobids-agent:latest --format '{{.Created}}'` is later than the commits you are testing (the tool changes live in the agent image) |
| P5 Skills present | Resolved skills include `long-running-task` (the agent adds it at run time with `add_skills`; note any `broker.timeout` on that call) |

If P1 to P4 fail, report "not testing the intended build" first, and mark every later check that depends on it UNVERIFIED.

### Step 4 — Run structure and timing

Build a per-run table from `agent.tick.started`, `agent.llm.completed` (phase `judge`) and `agent.tool.call`: start, `elapsedMs`, `turnsUsed`, `toolCallsUsed`, `finishReason`, `nudgeCount`, `finishRunStatus`, `finishRunReason`, `errorMessage`, units completed, searches made, listings validated, and the first thing the run worked on (listing id, URL or query).

Read the configured search interval from the agent's own saved settings (memory, or the user's reply in the conversation). The run's time allowance is half the interval, at least 1 and at most 30 minutes.

### Step 5 — long-running-task checks (LTT)

Use the `EACH RUN` procedure in `packages/domain/src/skills.ts` (`LONG_RUNNING_TASK_SKILL`).

| # | Check | Evidence |
|---|-------|----------|
| L1 | Each run starts with `list_tasks` and a read of the index | First tool calls of each tick |
| L2 | Index has `{goal, ongoing, endsAt, runBudget, storage, phase, lastSummary, updatedAt}`, and `runBudget` is a stopping rule with no unit count (flag any number of units, cycles, searches or "per run" quantity) | `ltt/<campaign>/index` |
| L3 | Campaign name is lowercase letters and digits; units are tasks titled `[<campaign>] ...`; reminder keys start `ltt-<campaign>-` | tasks, reminders, `schedule_reminder` calls |
| L4 | The continuation reminder is scheduled early in the run and replaced at the end; its `triggerAt` fits the search interval | order of `schedule_reminder` among the tick's tool calls |
| L5 | The run did as many units as it could: no `finish_run waiting` while units are pending unless a stop condition holds (allowance used, blocked on the user or on a later time, cannot progress). Compare `elapsedMs` with the time allowance | `list_tasks` just before `finish_run`, `elapsedMs`, reason |
| L6 | After each `complete_task`, `list_tasks` is called again before the next unit | tool call order |
| L7 | Task ids come from `list_tasks` (no failed `complete_task` on a made-up id); no failed `create_task` from empty arguments | `agent.tool.result` errors |
| L8 | Each unit's result is saved (`set_memory` or file write) before `complete_task`; completed units are not redone | tool call order, task titles |
| L9 | Under-run and over-run: elapsed below about 20% of the allowance with due work remaining is an under-run; above the allowance plus a margin is an over-run | run table |
| L10 | If the user asked to stop: phase `ending` then `ended`, reminders cancelled with `cancel_reminder`; otherwise N/A | memory, reminders |

### Step 6 — job-search skill checks (JS)

Use `.agents/skills/job-search/SKILL.md` as installed (P1), not the repository working copy.

**Setup and records**

| # | Check | Evidence |
|---|-------|----------|
| S1 | Configuration question asked once, as written; questions asked one at a time (flag a message with more than one question or request) | conversation |
| S2 | Goal question asked with the seven options; ranking criteria saved in the user's order | conversation, `prefs/user` |
| S3 | CV read from the uploaded document; profile saved and reused, not rebuilt each run | `read_agent_document` calls, `candidate-profile` |
| S4 | Records exist under the keys the skill names (`assignment-state`, `candidate-profile`, `preferences`, `jobs/<job-id>`, `jobs/summary`, `search/search-ledger`, `search/search-strategies`, `search/search-statistics`, `reports/report-state`); list what is missing against the baseline | `agent:memory:<id>` |
| S5 | Job records carry the fields the skill lists (company/title, workplace type, location/eligibility, pay with currency and period, score with reasons and gaps, URLs, source/evidence, dates, status) | `jobs/*` |

**Search and validation**

| # | Check | Evidence |
|---|-------|----------|
| S6 | `references/finding-and-validating-listings.md` is read (`read_file` on that path) before the first search of each run that searches; count runs with and without | tool call order |
| S7 | Queries target employer listings (for example `site:` ATS queries) and queryable sources; share of jobs with a direct employer or ATS URL versus an aggregator or category page | `search_web` args, `jobs/*` |
| S8 | Every found listing has a validation attempt before it is evaluated or ranked, and is marked `unchecked` until then and `unverified` if it could not be confirmed | job statuses, tool calls |
| S9 | Open-or-closed is checked with the ID endpoints or the listing page, not from a search result alone; closed listings are marked expired | `make_http_request` and `browse_url` calls |
| S10 | Ledger entries per source and query: first and last attempt, last success, counts, cursor, errors, retry and next-eligible times; no repeat of a source or query within 24 hours except due incremental searches | `search/search-ledger` |
| S11 | Coverage: distinct sources and domains used; use of queryable sources; adjacent titles and industries explored (the user said not to restrict to finance) | ledger, queries |
| S12 | Polite access: requests per domain per minute, sequential per domain, `429` and `Retry-After` honoured, no sign-in or account creation | tool call timing, results |

**Ranking and reporting**

| # | Check | Evidence |
|---|-------|----------|
| S13 | Lexicographic ranking in the user's order; hybrid is not remote; undisclosed pay is never assumed to meet the minimum; pay compared on a stated basis (period and currency); CV match 0 to 100 with strengths and gaps | `jobs/*`, messages |
| S14 | Status line after each search or report, in the format `Search <serial> · found <total> jobs (<verified-open> verified, <new> new) · next search <date-time tz> · next report <date-time tz>`, with values equal to the saved counters and the serial increasing | outbound messages vs `jobs/summary` |
| S15 | Timestamps in UTC, none in the future relative to `agent_messages.created_at`; next-search time consistent with the interval and the reminder | records vs message times |
| S16 | No deferral of work that could be done now ("next run I will open each listing" while time remained and listings were `unchecked`) | final messages, `finish_run` reasons |
| S17 | Daily report, if the period spans the report time: immutable report saved before delivery, one cumulative report after downtime, delivered by message or email, cutoff advanced only on confirmation; otherwise N/A | `reports/*`, messages |
| S18 | Privacy: no CV contact details or other personal data in outbound messages beyond what the user needs; no applying, no contact with recruiters, no account creation without approval; listing text not obeyed as instructions | outbound messages, tool calls |

### Step 7 — Platform checks (continuation guard, errors, tools)

**Continuation guard and `finish_run` (CG)**

| # | Check | Evidence |
|---|-------|----------|
| C1 | Every judge run for this agent ends with a recorded status and reason: `finishRunStatus` and `finishRunReason` on `agent.llm.completed`. List runs without them, with their `finishReason` and `nudgeCount` | run table |
| C2 | The reason is sensible: non-empty, at most 300 characters, consistent with the agent's own state at that moment. `complete` with pending tasks is a rubber stamp (fail). `waiting` without a continuation reminder scheduled in that tick is a fail. `blocked` names a real blocker. A reason that cites a time limit matches `elapsedMs` and the allowance | reason vs tasks, reminders, memory |
| C3 | The model got no further call after `finish_run`: in `logs/agent.log` no `LLM response received` between the `finish_run` tool execution and the next `Agent tick starting`; `turnsUsed` equals the model calls counted in the log for that tick | agent log, run table |
| C4 | A failed `finish_run` call (status `error` in `agent.tool.result`) does not end the run: more work or another call follows | tool result, later calls |
| C5 | When `nudgeCount` is above 0: the nudge ("You stopped without calling `finish_run`...") was not issued on the last allowed turn; `finishReason` is not `turn_limit` because of it; `nudgeCount` is at most `agentRuntime.continuationGuard.maxNudges` (default 2); afterwards the agent worked or called `finish_run` | run table, `config/default.yaml` |
| C6 | The nudged reply is absent from history and the timeline: the nudge text and the premature reply appear in no `agent_messages` payload, no `conversation_messages` body, and not in the saved `agent:prompt:judge-user-context` string; the tick's timeline shows one closing entry at most. Where the premature text is not recorded anywhere by design, say what could and could not be observed | DB, Redis, activity timeline in the web UI or activity feed |
| C7 | `waiting` only records: it does not wake the agent or schedule anything; the way back is `schedule_reminder` | reminders, wake signals |
| C8 | Activity timeline summary of an `agent.llm.completed` event shows the `finish_run` status and reason, and the nudge count when above 0 | web UI or activity feed (if not reachable, UNVERIFIED) |

**Errors and messages (ER)**

| # | Check | Evidence |
|---|-------|----------|
| E1 | The new message appears in `agent.llm.completed.errorMessage` for ticks with `finishReason: error` caused by bad tool arguments: `Invalid tool arguments for "<tool>" (call <id>, call N of M): not valid JSON. ...`, with the argument length and the finish reason, and without an excerpt of the arguments. The old bare `Expected ',' or '}' ... position N` means an old image | `errorMessage` |
| E2 | Retry warnings (`Retrying judge LLM call after backoff`, `Retrying scout tool turn after backoff`) carry the failure `message` | agent log |
| E3 | `unresolvedToolFailureCount` and `unresolvedToolFailures` are present on `agent.llm.completed` when tool calls failed and were not retried successfully | run table |
| E4 | Tool errors by `toolName` and `errorCode` (for example `broker.timeout`, `invalid parameters`) with `errorOwner`; compare with the baseline | `agent.tool.result` where `status = 'error'` |

**Tools, limits and cache (TL)**

| # | Check | Evidence |
|---|-------|----------|
| T1 | `make_http_request` is used (baseline: never), including the ID endpoints and queryable sources from the references file | `agent.tool.call` |
| T2 | A response longer than one page comes back as a first page with `totalChars`, `returnedChars`, `nextOffset`, `savedTo` and `hint`; the agent then uses `search_files` or `read_file_lines` on the saved file instead of repeating the request | tool results and following calls |
| T3 | A saved JSON response is indented (first lines of a cached file) | `workspace/web-cache` sample |
| T4 | `limit` is used to keep first pages small when the response is large | call args |
| T5 | Context cost: tool results and prompt sizes stay sane (no inline body in the hundreds of KB); input tokens per judge run from `billing_usage_events` or the log | usage events, results |
| T6 | Cache hygiene: size of `web-cache/` over time against the workspace quota (100 MiB on free and starter); `saveError` count; `delete_file` after extraction | workspace listing, results |
| T7 | No `file.limit_too_large` or other avoidable file-tool errors | tool results |

**Continuity across runs (CO)**

A run is a fresh model context. Whatever the agent knows at run N+1 about run N must come from saved state (memory, tasks, reminders, the conversation shown to it), because in-process history is lost on a restart and the workspace is not durable. Compare consecutive runs in the run table.

| # | Check | Evidence |
|---|-------|----------|
| CO1 | Each run reads its saved state before any external request: tasks, the index, and the records it needs next (job summary, ledger, preferences) | first tool calls of each tick |
| CO2 | Pick-up point: the first thing run N works on is what run N-1 recorded as unfinished (its `lastSummary`, `finishRunReason` and pending units), not a new topic | run table, index, tasks |
| CO3 | No repeated work: list every external request (tool plus normalised URL, query or endpoint) and flag one made again in a later run with no recorded reason (a due retry, a changed status, new information). Report the repeat ratio, repeated requests over all external requests | `agent.tool.call` args, ledger |
| CO4 | What a run learned is stored and honoured by the next one: a page judged useless, a link found to be wrong, a listing found expired, a question put to the user. The next run neither repeats the attempt, nor reinstates the listing as active, nor asks the question again | memory records vs later calls and messages |
| CO5 | Fetches and validation attempts are checkpointed per listing or request, not once at the end of a run, so a run cut off part-way loses at most the item in progress. Check the order of save calls against the work calls | tool call order |
| CO6 | Counters and identifiers carry on: the search serial rises by one per search with no reset or reuse; totals only grow or change with a stated reason; listings seen before are not counted as new again | status lines, `jobs/summary`, ledger |
| CO7 | A pending question to the user does not stall the other work, is asked once, and its answer is applied when it arrives | messages, later runs |
| CO8 | One campaign, one set of schedules: a single index, no duplicate tasks for the same unit, one continuation reminder key, no orphaned reminders from an earlier campaign | tasks, reminders, memory keys |
| CO9 | Timing continuity: each run starts close to the time the previous run scheduled, and a late or missed trigger leads to one catch-up run, not several | `triggerAt` vs `agent.tick.started` |
| CO10 | If a restart happened in the period (more than one runtime session, or a second `External skills installed at agent start` line), the agent rebuilt itself from saved state: same campaign reused, skills reinstalled, the CV re-read only if the profile record was missing, no second index. Otherwise N/A. This skill does not cause restarts; the owner may restart the agent between evaluations | `agent_runtime_sessions`, agent log, memory |

### Step 8 — Outcome metrics

Compute and compare with the baseline (Step 9 table). Compute per run and overall:

- Jobs found, verified open, expired, `unverified`, `unchecked` at the end; share validated before ranking.
- Share of jobs with a direct employer or ATS URL.
- Time to the first verified-open job; jobs meeting all of the user's criteria (remote, English, 2,000 EUR a month or more) with evidence.
- Searches per hour and distinct sources and domains.
- Run length (min, median, max) against the allowance; runs ending with pending work and no stop condition.
- Repeat ratio (CO3) and the number of facts learned in one run that a later run ignored (CO4).
- Model calls and cost per run; extra calls from nudges.
- Tool error rate.

### Step 9 — Verdict table and report

Write `<output-folder>/REPORT.md`:

1. **Summary:** agent id, period, deployment target, build under test (P1 to P5), headline result.
2. **Verdict per change** (PASS, FAIL, PARTIAL, N/A, UNVERIFIED, each with the check ids and a one-line reason):

   | Change | Checks |
   |--------|--------|
   | long-running-task stop rule and "do as many units as you can" | L2, L5, L6, L9 |
   | job-search Step 3 repeat and run time allowance | L5, L9, S16 |
   | `references/finding-and-validating-listings.md` | S6, S7, S8, S9, T1 |
   | `make_http_request` paging, 2 MiB limits, web cache | T2 to T7 |
   | Continuation guard and `finish_run` | C1 to C8 |
   | Continuity across runs | CO1 to CO10, L1, L6, L8 |
   | Clearer `provider.invalid_tool_args` message and related logging | E1 to E4 |
3. **Run table** (Step 4) and **baseline comparison**:

   | Metric | Baseline | This run |
   |--------|----------|----------|
   | Judge runs, length (min / median / max) | 6, 23 / 47 / 63 s | |
   | Turns and tool calls per run | 4 to 7, 12 to 17 | |
   | Runs ending `finish_run waiting` with pending units | 6 of 6 | |
   | `runBudget` wording | "one search or report cycle per run" | |
   | Jobs found / verified open | 8 / 0 | |
   | Validation attempted per found job | partial, deferred | |
   | `make_http_request` calls | 0 | |
   | Runs that read the references file | n/a | |
   | Repeated external requests across runs | 2 pages fetched again the next run | |
   | Tool errors | 3 | |

4. **Findings** (each with evidence, severity and the check ids), split into skill wording problems, platform problems, model-behaviour problems and test-setup problems.
5. **Success bar (proposals, adjust after the first comparison):** every run ends with `finish_run` and a sensible reason; no `complete` with pending tasks; no unit count in `runBudget`; the references file is read in every run that searches; every found listing has a validation attempt before the run ends; at least one verified-open job in the first hour; no run with an inline body in the hundreds of KB; no avoidable tool errors; no external request repeated in a later run without a recorded reason.
6. **Improvement suggestions**, separated into skill text, platform and test setup.
7. **Data references:** every file saved under `<output-folder>`.

## Constraints

- **DO NOT fix anything and do not change the agent.** Do not message the agent, change its memory, tasks or reminders, or restart it. Analyse, explain and report. Fixes are a separate workflow.
- Write only inside `<output-folder>`.
- **Privacy:** the agent holds a real CV. Do not copy CV text, contact details or the `candidate-profile` value into the report or the chat; refer to them by key and say what was checked. Do not print the full `AGENT_CONFIG` or any environment variable that may hold a key.
- **Memory hygiene:** persist artifacts to the folder and read back only the lines or rows each check needs.
- Mark a check UNVERIFIED rather than guessing when the evidence is absent (for example the activity timeline is not reachable, or the premature reply is not recorded anywhere).
- Do not compare across models; compare an agent with its own earlier run.

## Decision Points

- If P1 to P4 fail, put "not testing the intended build" at the top of the report and mark dependent checks UNVERIFIED.
- If the agent has fewer than one finished judge run, stop and say so.
- If the period does not reach a report time, a stop request or a nudge, mark S17, L10 and C5 or C6 N/A rather than PASS.
- If several agents are given, make a sub-folder per agent and one top-level `REPORT.md` that aggregates.
- If the stack is down or a data source is unavailable, evaluate what you have and list the gaps.
