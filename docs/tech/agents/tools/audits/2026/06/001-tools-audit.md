# AGENT TOOLS

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