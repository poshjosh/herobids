# AGENT TOOLS

Check the code and update the tables below. Add/remove new tools or update the rows corresponding to tools. The tools are defined in `apps/worker/src/tools/`.

we want to prevent a case where an agent is expected to call a tool with one or more arguments it neither knows nor has any way of knowing/getting. For example, if tool `dummy_start_task` reqires a `taskId`, the agent must already have access to a `taskId`. Identify such cases? Exclude those args available in the agent's prompt or via other tool calls.

Using the tables below, identify all tool args that lack discoverable schemas/values, excluding args available in the agent prompt or obtainable via other tool calls.

## Agent Tool Arguments — Required Args & Info Availability

### Trading Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `submit_decision` | `instrumentId` | yes | **no** | Agent must reason from market data / user input to pick a symbol |
| `submit_decision` | `intent` | yes | **yes** | Agent decides go_long/go_short/go_flat/increase/decrease from analysis |
| `submit_decision` | `targetSize` | yes | **no** | Depends on capital, risk limits, position sizing — agent must compute or ask |
| `submit_decision` | `rationaleSummary` | yes | **yes** | Agent generates reasoning from its analysis |
| `submit_decision` | `limitPrice` | no | — | Optional; omit for market order |
| `submit_decision` | `confidence` | no | — | Optional 0-1 hint |
| `submit_decision` | `safetyOverrideId` | no | — | Only from prior rejection response |

### Messaging Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `send_message` | `body` | yes | **yes** | Agent composes the message content |
| `send_message` | `subject` | no | — | Optional, max 200 chars |
| `send_message` | `messageClass` | no | — | Enum: routine/alert/reminder |
| `send_message` | `emailDelivery` | no | — | Enum: if_allowed/never |
| `send_message` | `contextRef` | no | — | Optional ref string |
| `publish_artifact` | `artifactType` | no | — | Default: "text" |
| `publish_artifact` | `contentType` | no | — | Default: "text/plain" |
| `publish_artifact` | `summary` | no | — | Default: "Artifact published" |
| `publish_artifact` | `location` | no | — | Optional passthrough object |
| `publish_artifact` | `metadata` | no | — | Optional passthrough object |

### Memory Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `set_memory` | `key` | yes | **yes** | Agent chooses its own key names |
| `set_memory` | `value` | yes | **yes** | Agent provides the data to store |
| `get_memory` | `key` | yes | **no** | Must know the exact key previously used |
| `delete_memory` | `keys[]` | yes (array min 1) | **yes** | Agent knows keys from list_memory_keys |

### Bot Management Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `create_bot` | `config.symbol` | yes (nested) | **no** | Agent must discover/choose a symbol |
| `create_bot` | `config.strategy.type` | yes (nested) | **yes** | Agent picks strategy type |
| `create_bot` | `config.strategy.decisionMode` | yes (nested) | **yes** | Agent picks mechanical/llm/hybrid |
| `list_bots` | — | no | — | No required args; optional `days` filter |
| `get_bot_status` | `botId` | yes | **no** | Must get from list_bots first |
| `stop_bot` | `botId` | yes | **no** | Must get from list_bots first |
| `start_bot` | `botId` | yes | **no** | Must get from list_bots first |
| `adjust_bot_config` | `botId` | yes | **no** | Must get from list_bots first |
| `adjust_bot_config` | `config.strategy` | no | — | Optional partial merge |
| `adjust_bot_config` | `config.execution` | no | — | Optional partial merge |
| `adjust_bot_config` | `config.risk` | no | — | Optional partial merge |
| `adjust_bot_config` | `config.symbol` | no | — | Optional partial merge |

### Analytics Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `get_analytics` | `days` | no | — | Default: 7, max 90 |
| `list_positions` | — | no | — | No required args |

### Code Execution Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `execute_code` | `code` | yes | **yes** | Agent writes its own code |
| `execute_code` | `language` | no | — | Default: "javascript" |
| `execute_code` | `dependencies` | no | — | Default: [] |
| `execute_code` | `timeoutMs` | no | — | Optional 1000-600000 |
| `execute_code` | `description` | no | — | Optional audit string |

### Filesystem Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `write_file` | `path` | yes | **yes** | Agent chooses workspace-relative path |
| `write_file` | `content` | yes | **yes** | Agent provides content |
| `read_file` | `path` | yes | **no** | Must know the file path exists |
| `list_files` | `path` | no | — | Default: "" (workspace root) |
| `delete_file` | `path` | yes | **no** | Must know the file exists |

### Market Data Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `search_tokens` | `query` | yes | **yes** | Agent provides search term |
| `search_tokens` | `network` | no | — | Optional filter |
| `search_tokens` | `minLiquidityUsd` | no | — | Optional filter |
| `search_tokens` | `minVolume24hUsd` | no | — | Optional filter |
| `search_tokens` | `minTokenAgeHours` | no | — | Optional filter |
| `search_tokens` | `includeBlocked` | no | — | Optional, default false |
| `search_tokens` | `limit` | no | — | Optional 1-50 |
| `discover_tokens` | `network` | no | — | Optional filter |
| `discover_tokens` | `limit` | no | — | Optional 1-100 |
| `discover_tokens` | `minLiquidityUsd` | no | — | Optional filter |
| `check_regime` | — | no | — | All args optional; benchmark defaults to "BTC" |
| `get_funding_rates` | `symbols` | no | — | Omit for all venues |
| `get_funding_rates` | `venue` | no | — | Optional filter |
| `get_market_overview` | `venue` | no | — | Optional filter |
| `get_market_overview` | `symbols` | no | — | Omit for broad market |
| `get_price` | `symbol` | yes | **no** | Agent must know which token to look up |
| `get_price` | `chain` | yes | **no** | Agent may not know the chain; "any" is a fallback |

### Watch Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `watch_token` | `symbol` | yes | **no** | Agent must choose a token to watch |
| `watch_token` | `chain` | yes | **no** | Agent may not know the chain |
| `watch_token` | `thresholdPrice` | yes | **no** | Agent computes from analysis, but needs price data first |
| `watch_token` | `condition` | yes | **yes** | Agent chooses above/below |
| `watch_token` | `note` | no | — | Optional label |
| `list_watches` | — | no | — | No required args |
| `remove_watch` | `watchId` | yes | **no** | Must get from list_watches first |
| `check_watches` | `removeTriggered` | no | — | Default: false |

### Web Access Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `search_web` | `query` | yes | **yes** | Agent composes search query |
| `search_web` | `maxResults` | no | — | Optional 1-10 |
| `browse_url` | `url` | yes | **no** | Agent must know the URL to fetch |
| `read_document` | `url` | yes | **no** | Agent must know the document URL |

### Task Tools

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `create_task` | `title` | yes | **yes** | Agent composes its own task titles |
| `create_task` | `notes` | no | — | Optional, max 1000 chars |
| `create_task` | `dueAt` | no | — | Optional ISO 8601 datetime |
| `list_tasks` | `status` | no | — | Default: "pending" |
| `complete_task` | `id` | yes | **no** | Must get from list_tasks first |
| `schedule_reminder` | `message` | yes | **yes** | Agent composes reminder text |

### bots.ts

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `create_bot` | `bindingId` | no | **no** | Must find from Capability Readiness section as "binding=<id>"; omit to use default |
| `create_bot` | `config.symbol` | yes (nested) | **no** | Agent must discover/choose a symbol |
| `create_bot` | `config.strategy.type` | yes (nested) | **yes** | Agent picks from: momentum, range, contrarian, swing, scalper, dca |
| `create_bot` | `config.strategy.decisionMode` | yes (nested) | **yes** | mechanical / llm / hybrid |
| `create_bot` | `config.strategy.params` | no | — | Optional record; strategy-specific params |
| `create_bot` | `config.execution.mode` | no | **yes** | paper / shadow / live |
| `create_bot` | `config.execution.slippageBps` | no | **no** | Agent must estimate or ask; not provided by system |
| `create_bot` | `config.risk` | no | **no** | Optional record; agent must reason about risk params |
| `create_bot` | `rationale` | no | **yes** | Agent composes brief rationale (max 500 chars) |
| `list_bots` | `days` | no | — | Optional filter; returns bots created within N days |
| `get_bot_status` | `botId` | yes | **no** | Must get from list_bots first |
| `stop_bot` | `botId` | yes | **no** | Must get from list_bots first |
| `start_bot` | `botId` | yes | **no** | Must get from list_bots first |
| `start_bot` | `rationale` | no | **yes** | Brief rationale for restarting (max 500 chars) |
| `adjust_bot_config` | `botId` | yes | **no** | Must get from list_bots or get_bot_status first |
| `adjust_bot_config` | `config.strategy.type` | no | **yes** | Partial update; same enum as create_bot |
| `adjust_bot_config` | `config.strategy.decisionMode` | no | **yes** | Partial update; mechanical / llm / hybrid |
| `adjust_bot_config` | `config.strategy.params` | no | — | Optional partial strategy params |
| `adjust_bot_config` | `config.execution.mode` | no | **yes** | paper / shadow / live |
| `adjust_bot_config` | `config.execution.slippageBps` | no | **no** | Agent must estimate or ask |
| `adjust_bot_config` | `config.risk` | no | **no** | Optional record; agent must reason about risk params |
| `adjust_bot_config` | `config.symbol` | no | **no** | Optional symbol override |

### index.ts

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| — | — | — | — | No tools defined; re-exports all tool groups and creates the registry |

### price.ts

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `get_price` | `symbol` | yes | **no** | Agent must reason from market data / user input to pick a token |
| `get_price` | `chain` | yes | **no** | Must know the chain context; use "any" when unsure — supports hyperliquid, solana, ethereum, bsc, base, arbitrum, polygon, avalanche, any |

### registry.ts

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| — | — | — | — | No tools defined; infrastructure for registration and JSON Schema conversion |

### risk-limits.ts

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `get_risk_limits` | — | no | — | No args; returns effective limits with source, mutability, and operator ceiling |
| `adjust_risk_limits` | `maxOpenPositions` | no | **no** | Optional; set null to reset to operator default |
| `adjust_risk_limits` | `maxPositionSizePct` | no | **no** | Optional 0-100; agent must reason about position sizing |
| `adjust_risk_limits` | `stopLossPct` | no | **no** | Optional 0-100; agent may adjust based on strategy |
| `adjust_risk_limits` | `stopLossCooldownMs` | no | **no** | Optional; agent may adjust cooldown duration |

### update-own-config.ts

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| `update_own_config` | `technical` | no | **no** | Optional; TechnicalConfigSchema or null to remove. Agent may not know valid scanning params |
| `update_own_config` | `intelligence` | no | **yes** | Optional; IntelligenceConfigSchema or null. Agent knows its own reasoning mode |
| `update_own_config` | `execution.mode` | no | **yes** | paper / shadow / live; agent may request mode changes (with safety gates) |
| `update_own_config` | `execution.positionSizeMode` | no | **yes** | fixed / percent_equity; agent chooses sizing approach |
| `update_own_config` | `execution.fixedPositionSize` | no | **no** | String; agent must compute based on capital |
| `update_own_config` | `risk.maxPositions` | no | **no** | min 1; agent reasons about concurrency needs |
| `update_own_config` | `risk.maxPositionSizePct` | no | **no** | 0-100; agent reasons about position sizing |
| `update_own_config` | `risk.dailyMaxLossPct` | no | **no** | 0-100; agent may adjust based on strategy |
| `update_own_config` | `risk.stopLossPct` | no | **no** | min 0; agent may adjust stop-loss threshold |
| `update_own_config` | `risk.takeProfitPct` | no | **no** | min 0; agent may adjust take-profit threshold |

### workspace.ts

| Tool | Arg | Required | Agent Has Info? | Comments |
|------|-----|----------|-----------------|----------|
| — | — | — | — | No tools defined; utility functions for workspace path resolution and sandbox management |
