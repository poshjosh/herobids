# Deployment evaluation prompt

- deployment application = herobids
- deployment-environment = development   # development | staging
- deployment-target = local docker compose   # e.g. "local docker compose" | "remote hetzner server via infra/hetzner"
- evaluation-period = 15:15 - now (Berlin time)
- agent-id/s = (get the agent ids of all trading agents)
- output-folder = .ignore/eval/yyyy/MM/dd/<agent-id>/<serial>/
- expected-llm-cost = unknown

App deployed to <deployment-target>

## Architecture note — trading runs behind the traderton boundary

Trading has been extracted out of herobids into a separate service, **traderton**,
reached over a REST **boundary** (legal isolation). Assume both are deployed: the
herobids app AND the traderton boundary (herobids reaches it via
`TRADERTON_BOUNDARY_URL`, HMAC-signed). This changes WHERE trading data lives and
adds the boundary as something to inspect:

- **herobids DB holds platform state only** — agents, connections, agent_messages,
  agent_runtime_sessions, agent_artifacts, skills, market_assessment_* (preset
  reviews), plans. It NO LONGER holds trading state.
- **Trading state (fills/trades, positions, bots, decisions, journal events,
  venue accounts) lives in traderton** and is served over the boundary. Do NOT
  expect it in the herobids DB — empty herobids trading tables are not an anomaly,
  they were dropped. Read this data through the API (which reads over the
  boundary), NOT via direct herobids DB queries:
  - `GET /api/agents/<agent-id>/export/bundle` — the primary per-agent bundle.
  - `GET /api/agents/<agent-id>/trades` — fills attributed to the agent (+ its bots).
  - `GET /api/agents/<agent-id>/capabilities/trading/positions` — positions.
  - For deeper traderton-side data, inspect the traderton DB / boundary directly.
- **Rule out boundary connectivity before concluding a trading agent was
  inactive.** A trading agent that appears to have "done nothing" is often a
  boundary-unreachable / misconfigured situation, not behavioural inactivity.
  Check: is the boundary healthy (`/health/ready`)? Can the app reach it — i.e.
  is `TRADERTON_BOUNDARY_URL` the value that is actually reachable from where the
  app runs (resolve it for this environment; do not assume `localhost` — e.g. a
  containerised app cannot reach a host-published boundary via `localhost`), and
  do the HMAC creds match the boundary's? Are boundary calls succeeding, or
  returning `precondition.not_ready` / 503? Capture boundary + traderton-worker
  logs alongside the herobids app/agent logs.

## Resolve the targets (do not hardcode)

This prompt is environment-agnostic. Use `deployment-environment` /
`deployment-target` in the header to DISCOVER the concrete endpoints and access
paths for this run — do not assume fixed hosts, ports, or container names:

- **API base URL** — derive it from the deployment (compose/env for local; the
  infra access path/domain for remote). API paths below are relative to it.
- **DB / redis endpoints** — resolve herobids' and traderton's from the env/config
  (`.env`, compose files). They may be remapped to avoid collisions (the two
  stacks can run side by side), so confirm ports rather than assuming defaults.
- **Boundary target + creds** — read `TRADERTON_BOUNDARY_URL` (+ HMAC creds) as
  configured for this environment; that is the reachable boundary address.
- **Logs / containers** — locate the running app, worker, boundary, and
  traderton-worker log sources for this deployment (e.g. `docker`/compose locally;
  the infra log path remotely). Names/locations vary by environment.

If a target cannot be resolved, say so in the report rather than guessing.

Agent(s) started

Analyse agent(s), bot(s): logs, database, redis, records e.t.c. (e.g. state, trades, journals, memory, costs, sessions, config etc). Per the architecture note above: platform state (agents, sessions, messages, memory, preset reviews) is in the herobids DB/redis; trading state (trades, positions, bots, journals) comes over the boundary — read it via the API endpoints / traderton, not herobids trading tables.

For each agent, do the following:

Use `GET /api/agents/<agent-id>/export/bundle` to download agent info (which should include its bot's info) to <output-folder>; however do not limit yourself to that info. you can check the logs, database, redis etc for more data.

Download any logs you can from the running container (app, agent etc) to <output-folder>

Save any relevant data from the database to <output-folder>

Save data and a report (REPORT.md) to <output-folder>

In the report add references to all the data you saved, preferrably at the bottom.

If that folder already exists, create the next version of data you intend to save which will live side by side with the last version. Use a reasonable <serial> sequence.

Answer the following questions, and any other relevant:

- how did the agent behave:
  - when the agent traded, what prompted its decision to trade? For example did a wake signal? If yes, what wake signal? Or a tool call returning some data? What tool call? What prompted the agent to open a position? What prompted the agent to close a position.
  - how often did the scout agent hold or excalate
- where there any anomalies? For example: watches, coordinator pricing, trade lifecycle, memory, and the wake signal system:
  - are watches functioning as expected?
  - are rate limits working?
  - are restrictions working? For example if "15m" candle is not supported, could the agent create a bot using that?

- is market data being fetched? E.g. trade signals, OHLCV, pools resolved?

- are economic calendar events (e.g. FOMC, forex factory etc) being generated and made available to the agents?

- are strategy preset reviews being conducted and recommendations made available to the agents? are agents able to understand and initiate change of strategy preset? The canonical active preset is `strategy.type`, falling back to `unified_config.metadata.strategyPreset` (+ `metadata.strategyPresetStyle`) when unset. (Preset reviews / market_assessment_* remain platform state in the herobids DB.)

- is data being saved to the database as expected?

- are there any unexpeced errors?

- any security breaches, problems, bugs? for example did JWT token leak in access logs? or other problems.

- if a value was provided for <expected-llm-cost>, compare it with the actual llm cost.

- what could be improved?

Note

- Birdeye has been observed to return 400 for instead of 429 for rate-limit errors.

Critical

DO NOT FIX anything. Rather analyse, explain, report and advise.

All your work MUST BE LIMITED TO <output-folder>
