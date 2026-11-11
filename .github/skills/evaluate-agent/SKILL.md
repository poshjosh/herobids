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

Discover what data (database/cache/other etc.) exists and query everything relevant to the agent.

1. **Discover all public tables:**
   ```sql
   SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;
   ```
2. **Read the Drizzle schema index** at `packages/db/src/schema/index.ts` to understand
   each table's purpose. This is the canonical registry — use it as a semantic decoder,
   not as a checklist of tables that "should" exist.
3. **Query every table in these semantic domains** for the agent(s) under evaluation,
   scoped to the evaluation period where the table has a timestamp column:

   | Domain | What to look for |
   |--------|------------------|
   | **Agent identity & config** | Agent records, bots created by the agent, blueprint/preset bindings, skills |
   | **Runtime lifecycle** | Runtime sessions, heartbeats, container status |
   | **Trading decisions & execution** | The append-only audit trail: decisions, execution plans, orders, fills, positions, decision contexts, decision failures, decision approvals |
   | **Venue connections** | Connections, agent connections, connection audit log, venue accounts |
   | **Strategy & review** | Preset bindings, preset transitions, review advice, assessment runs, scan metrics, scan candidates. Also extract `config->'strategy'->>'preset'` from all bots owned by the agent to document the active strategy preset per bot and any changes over time. |
   | **Messages & artifacts** | Agent messages, outbound messages, artifacts |
   | **Journal & reconciliation** | Journal events, reconciliation events, balance snapshots |
   | **Cost & billing** | Usage events, ledger entries, billing periods |
4. **Save** each table's relevant rows as JSON or CSV under `<output-folder>/db/<tablename>.json`.
   **Analyse on disk — do not inhale.** Save artifacts to the output folder,
   then inspect them with targeted tools (`jq`, `grep`, `rg`, `tail`, or scoped
   SQL) rather than reading whole files into context. A single eval can collect
   tens of MB across the bundle, logs, and every DB table; pulling all of that
   into the agent context is a primary cause of IDE memory exhaustion during a
   long run. Read back only the specific rows/lines a given question needs
   (see the Memory Hygiene note under Constraints).
5. **If a semantic domain has no matching tables**, note it as informational — not a bug.
   For example, agent memory is stored in Redis (`agent:memory:*` keys), so no DB table
   is expected for that domain.

### Step 5 — Collect Redis state

Inspect relevant Redis keys (reminders, rate-limit buckets, session state, agent memory, economic calendar) and save snapshots to `<output-folder>/redis/`.

> **Key-type awareness:** Always run `TYPE <key>` before reading a value. The `agent:memory:<id>` keys are Redis **hashes** — use `HGETALL agent:memory:<id>`, not `GET`. Using `GET` on a hash key returns `WRONGTYPE` and produces a false-alarm diagnostic. Other common key types: `agent:sessions:count:<id>` (string), `agent:wake:prefs:<id>` (string), rate-limit buckets (hash or sorted set depending on implementation).

> **Economic calendar keys:** Check for keys matching patterns like `calendar:*`, `economic:*`, `events:*`, or `news:*`. These may store upcoming macro events (FOMC, CPI, NFP etc.) that agents should be aware of. If no such keys exist, note the absence in the report.

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

#### Economic calendar awareness
- Is there a service, worker, or scheduled job that fetches economic calendar events (e.g. from Forex Factory, Investing.com, or an equivalent provider)?
- Are upcoming macro events (FOMC, CPI, NFP, rate decisions, etc.) stored in Redis or the database? Check for tables like `economic_events`, `calendar_events`, or `news_events`, and Redis keys matching `calendar:*`, `economic:*`, `events:*`, `news:*`.
- Do agents have access to a tool that surfaces upcoming high-impact events? Search agent tool calls in `agent_messages` for tool names containing "calendar", "economic", "news", or "events".
- Did any agent **reference** a macro event in its decision reasoning during the evaluation period? Search decision contexts and agent memory for keywords like "FOMC", "CPI", "NFP", "rate decision", "economic event".
- If economic calendar data is absent entirely, flag this as an **improvement opportunity**: agents trading without macro-event awareness risk being caught off-guard by high-impact announcements that cause extreme volatility and slippage.

#### Strategy preset review
- **Current preset state:** For each bot created by the agent, extract `config->'strategy'->>'preset'` (or `unified_config->'metadata'->>'strategyPreset'` if the schema has migrated). Document the active preset per bot.
- **Preset appropriateness:** Given the observed market regime (from `check_regime` results or technical indicators in the period), is the active preset reasonable? For example, a `scalper` preset during a low-volatility sideways regime, or a `position` preset during an extremely choppy intraday market, may signal a mismatch.
- **Preset transitions:** Check for evidence that the agent changed presets during the evaluation period:
  - Query `agent_messages` for `adjust_bot_config` tool calls where the payload modifies `strategy.preset`.
  - Check for bot creation events where a new bot with a different preset replaced a stopped bot.
  - Look for tables like `preset_transitions` or `strategy_transitions` that log preset changes with timestamps and reasoning.
- **Review system status:** Is there an automated strategy preset review mechanism?
  - Check for tables like `review_advice`, `assessment_runs`, `preset_reviews`, or `strategy_assessments`.
  - Check for scheduled jobs or workers that evaluate preset performance and recommend transitions.
  - Search agent memory (Redis `agent:memory:<id>`) for keys or entries related to "preset review", "strategy review", or "regime mismatch".
- **Agent awareness of preset options:** Did the agent demonstrate understanding of when to switch presets? Search decision contexts and agent messages for references to preset names (`position`, `swing`, `day`, `intraday`, `scalper`, `contrarian`) and reasoning about why a preset is or isn't appropriate.
- **Recommendations:**
  - If no preset review system exists, flag as an **improvement opportunity**: agents should periodically reassess whether their active preset matches the current market regime and adjust accordingly.
  - If preset transitions occurred without logged reasoning, flag as an **operational anomaly**: preset changes should be auditable with clear justification.
  - If the agent is stuck on a single preset despite regime changes, flag as an **improvement opportunity**: the agent may lack awareness of when conditions warrant a preset switch.

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
4. **Economic Calendar Awareness** — whether macro events are available, consumed, and factored into decisions
5. **Strategy Preset Review** — preset appropriateness, transitions, review system status
6. **Market Data** — fetch status
7. **Persistence** — DB write health
8. **Errors** — list with severity
9. **Cost** — actual vs expected
10. **Improvement Suggestions**
11. **Data References** — links to all files saved in `<output-folder>`

## Constraints

- **DO NOT fix anything.** Analyse, explain, report, and advise only.
- All output files must be written inside `<output-folder>`. Do not modify any source files.
- If asked to also fix problems after the eval, that is a separate workflow — complete the report first, then proceed with fixes.
- **Memory hygiene (this skill is the heaviest collector).** Persist bundle,
  logs, DB rows, and Redis snapshots to `<output-folder>`, then analyse them on
  disk with `jq`/`grep`/`rg`/`tail`/scoped SQL. Never read a large artifact
  wholesale into context — extract only the rows or lines each question needs.
  Downloading logs and every DB table into the agent context is a primary
  cause of IDE memory exhaustion, especially when this skill is run repeatedly
  in a loop (e.g. by `evaluate-agent-and-fix`). If invoked in a loop, do not
  carry collected data forward between iterations — the output folder is the
  durable record.

## Decision Points

- If some data is unavailable, proceed with whatever data that is avaiable and note the gap in the report.
- If multiple agents are provided, create a sub-folder per agent under the output folder and one top-level `REPORT.md` that aggregates findings.
