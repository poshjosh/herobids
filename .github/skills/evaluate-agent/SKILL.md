---
name: evaluate-agent
description: 'Analyse agent(s) behaviour after a trading session — logs, database, Redis, journals, costs, memory, wake signals, session daa, market data, analytics, rate limits. Use when asked to evaluate an agent, analyse trading behaviour, audit a session, review agent performance, or run the evaluation prompt.'
argument-hint: 'agent-id/s (required), evaluation-period, deployment-target and expected-llm-cost (e.g. "agent-id=abc123 period=13:00-now Berlin")'
---

# Evaluate Agent

This skill analyses one or more agents after a trading session: downloads the export bundle, collects logs, database and other agent as well as bot records/data etc, saves everything to a versioned output folder, and produces a `REPORT.md`. 

## When to Use

- After a trade test run to evaluate agent behaviour.
- When asked to audit a session, review P&L, or check for anomalies.
- As part of the `test-agent-trading` skill.
- Any time the user wants to understand what an agent did and why.

## When Not to Use

- When the goal is to fix a bug (use `evaluate-agent` to identify, then fix separately or use `evaluate-agent-and-fix`).
- When infrastructure is unavailable and logs cannot be fetched.

## Inputs

| Parameter | Description | Default |
|-----------|-------------|---------|
| `agent-id` | One or more agent UUIDs to evaluate | Required |
| `evaluation-period` | Time window, e.g. `13:00 - now (Berlin)` | `Past 1 hour` |
| `deployment-target` | Where the stack is deployed | `local docker compose (development)` |
| `expected-llm-cost` | Expected LLM cost for the period | `unknown` |
| `output-folder` | Base path for saved data | `.ignore/eval/yyyy/MM/dd/<agent-id>/<serial>/` |

## Procedure

### Step 1 — Determine the output folder

Use `.ignore/eval/<yyyy>/<MM>/<dd>/<agent-id>/<serial>/` where `<serial>` is a zero-padded sequence starting at `01`. If the folder already exists, increment the serial to create a sibling version alongside the last run.

### Step 2 — Download the agent export bundle

```
GET /api/agents/<agent-id>/export/bundle
```

Save the response to `<output-folder>/bundle.json`. This includes agent state, bot info, config, and capabilities. Do not limit analysis to this file — supplement with logs, DB, Redis data etc.

### Step 3 — Collect logs

Download available container logs (API, worker, agent) from the running stack and save to `<output-folder>/logs/`. Scope logs to the evaluation period where possible.

### Step 4 — Collect database records

Query and save relevant records scoped to the evaluation period:
- `trading_instances`, `bots`, `decisions`, `execution_plans`, `fills`
- `agent_journal_events` for the agent(s)
- `agent_sessions`, `agent_memory`
- Capability grants, trading bindings, venue accounts
- any other tables relevant to the agent's behaviour or the evaluation questions

Save as JSON or CSV files under `<output-folder>/db/`.

### Step 5 — Collect Redis state

Inspect relevant Redis keys (reminders, rate-limit buckets, session state, agent memory) and save snapshots to `<output-folder>/redis/`.

> **Key-type awareness:** Always run `TYPE <key>` before reading a value. The `agent:memory:<id>` keys are Redis **hashes** — use `HGETALL agent:memory:<id>`, not `GET`. Using `GET` on a hash key returns `WRONGTYPE` and produces a false-alarm diagnostic. Other common key types: `agent:sessions:count:<id>` (string), `agent:wake:prefs:<id>` (string), rate-limit buckets (hash or sorted set depending on implementation).

### Step 6 — Analyse and answer the following questions

#### Trading behaviour
- What prompted each trade decision? Wake signal? Tool call result? Which signal/tool?
- How often did the scout agent hold vs escalate?
- What was the trade sequence — entries, position management, `go_flat`?

#### Anomalies

##### Policy anomalies (HIGH severity by default)
These map to bugs, security issues, or policy violations.

- **Execution-mode coherence:** For each agent under evaluation, query all bots where `creator_id = <agent-id>` and verify `config->'execution'->>'mode'` rank ≤ agent's `execution_mode`. Flag any bot where the bot mode outranks the agent mode as a HIGH anomaly. Include the bot's `created_at` and `updated_at` to determine whether the escalation happened at creation or via a config update.
- **Bot config escalation audit:** Query `agent_messages` for all `agent.tool.call` records where `payload->>'toolName' = 'adjust_bot_config'`. For each such call, if `args` are stored (Step 7 of agent-bot-mode-escalation-guard), inspect the `execution.mode` in the stored args and flag any escalation attempt above the agent's `execution_mode`. If args are not stored, join to the `bots` table and compare the bot's current `config->'execution'->>'mode'` against the agent's `execution_mode`; if the bot mode outranks the agent mode and the bot's `updated_at` is close to the tool call's `created_at`, flag this as a HIGH security anomaly: "agent escalated bot execution mode via adjust_bot_config".
- Are restrictions enforced? (e.g. if `15m` candle is unsupported, could the agent create a bot using it?)
- Unauthorised access attempts, risk-limit bypass attempts.

##### Operational anomalies
These map to degraded-but-expected behaviour.

- Are watches functioning as expected?
- Are rate limits working correctly? (Note: Birdeye may return 400 instead of 429 for rate-limit errors — treat 400s on Birdeye as potential rate-limit hits.)
- Is the wake signal system behaving as designed?
- Coordinator pricing anomalies?
- Trade lifecycle anomalies (stuck in pending/executing, missing `closedAt`, etc.)?
- Memory anomalies?

#### Market data
- Is market data being fetched? Trade signals, OHLCV, pools resolved?

#### Persistence
- Is data being saved to the database as expected?

#### Errors and security
- Any unexpected errors in logs?
- Any security issues, access control violations, or data leaks?

#### Cost
- If `expected-llm-cost` was provided, compare with actual LLM cost for the period.

#### Improvement opportunities
- What could be improved in agent behaviour, tooling, or infrastructure?

### Step 7 — Write the report

Save `<output-folder>/REPORT.md` containing:
1. **Summary** — agent ID(s), evaluation period, deployment target, key findings
2. **Trading Behaviour** — narrative of what the agent did and why
3. **Anomalies** — each anomaly with evidence
4. **Market Data** — fetch status
5. **Persistence** — DB write health
6. **Errors** — list with severity
7. **Cost** — actual vs expected
8. **Improvement Suggestions**
9. **Data References** — links to all files saved in `<output-folder>`

## Constraints

- **DO NOT fix anything.** Analyse, explain, report, and advise only.
- All output files must be written inside `<output-folder>`. Do not modify any source files.
- If asked to also fix problems after the eval, that is a separate workflow — complete the report first, then proceed with fixes.

## Decision Points

- If some data is unavailable, proceed with whatever data that is avaiable and note the gap in the report.
- If multiple agents are provided, create a sub-folder per agent under the output folder and one top-level `REPORT.md` that aggregates findings.
