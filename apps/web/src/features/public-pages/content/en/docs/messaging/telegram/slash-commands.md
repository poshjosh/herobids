# Telegram Slash Commands

OpenAIdom supports a rich set of Telegram slash commands for agent discovery, status checks, lifecycle control, and configuration — all from your Telegram chat.

## Command Reference

Commands are grouped by category. All command names are case-insensitive. Agent names with spaces must be wrapped in single or double quotes (e.g., `"DCA Bot"`). Bot mention suffixes (e.g., `/help@MyBot`) are stripped automatically.

### Help

| Command | Description |
|---|---|
| `/help` | List all available commands grouped by category |
| `/help <command>` | Show detailed help for a specific command (e.g., `/help start`) |

### Discovery & Read-Only

| Command | Description |
|---|---|
| `/agents` | List all your agents with their current status |
| `/status` | Compact summary of all your agents |
| `/status <agent>` | Detailed status for a specific agent |
| `/info <agent>` | Full agent details: status, mode, capital, risk limits, skills, session |
| `/skills` | List all skills available to you |
| `/skills <agent>` | List skills assigned to an agent |
| `/log <agent>` | Last 5 activity entries (decisions, messages, errors) |
| `/connections` | List your active connections |
| `/connections <agent>` | List connections assigned to an agent |

### Lifecycle

| Command | Description |
|---|---|
| `/start <agent>` | Start a stopped agent |
| `/pause <agent>` | Pause a running agent |
| `/resume <agent>` | Resume a paused agent |
| `/stop <agent>` | Stop an agent immediately |
| `/restart <agent>` | Stop then start an agent |

### Configuration (agent must be stopped)

| Command | Description |
|---|---|
| `/mode <agent>` | Show current execution mode |
| `/mode <agent> <test\|live\|paper\|shadow>` | Set execution mode (agent must be stopped) |
| `/connect <agent>` | List connections or generate a setup link |
| `/connect <agent> <id\|label>` | Grant a connection to an agent |
| `/disconnect <agent> <id\|label>` | Revoke a connection from an agent |

### Messaging

| Command | Description |
|---|---|
| `/to <agent> <message>` | Send a message to an agent |

## Usage Examples

```text
/help
/help start
/agents
/status
/status "DCA Bot"
/info Momentum
/skills
/skills Momentum
/log Momentum
/connections
/connections Momentum
/start Momentum
/pause Momentum
/resume Momentum
/stop "DCA Bot"
/restart Momentum
/mode Momentum
/mode Momentum live
/connect Momentum
/connect Momentum conn_abc123
/connect Momentum "Hyperliquid Main"
/disconnect Momentum conn_abc123
/to Momentum what's the market looking like?
```

## Command Semantics

### Help

- `/help` returns a formatted list of all available commands, grouped by category.
- `/help <command>` returns detailed usage for a specific command. Both `/help start` and `/help /start` are accepted (the leading slash is normalized).

### Discovery & Read-Only

- `/agents` lists all agents you own with their current status (e.g., `active`, `paused`, `stopped`).
- `/status` returns a compact summary of all agents, including session status and pause reason when applicable.
- `/status <agent>` returns detailed status for one agent, including last session, decision count, and pause reason.
- `/info <agent>` returns a full detail block: status, execution mode, capital (n/a for non-trading agents), daily loss limit, max drawdown, position size, stop loss, style, strategy preset, assigned skills, last session, pause reason, and connection count.
- `/skills` lists all skills available to you (entitled + free published skills), with names and IDs.
- `/skills <agent>` lists skills currently assigned to that agent.
- `/log <agent>` returns the 5 most recent activity entries (decisions, messages, errors) in chronological order.
- `/connections` lists your active connections with provider, label, and truncated ID.
- `/connections <agent>` lists connections currently granted to that agent.

### Lifecycle

All lifecycle commands use the same validation and state transition rules as the web app (POST endpoints).

- `/start <agent>` starts a stopped agent. Validates model selection, capital, and risk limits before accepting.
- `/pause <agent>` pauses an active or starting agent. Idempotent — already paused returns success.
- `/resume <agent>` resumes a paused agent. Rejects if the agent is not paused.
- `/stop <agent>` stops any non-stopped agent immediately. Idempotent — already stopped returns success.
- `/restart <agent>` stops the agent, polls briefly for `stopped` status, then starts it. If the agent does not settle to stopped within the poll window, responds with instructions to retry.

### Configuration

All configuration commands (`/mode`, `/connect`, `/disconnect`) require the target agent to be in `stopped` status. Read-only forms (`/mode <agent>` and `/connections <agent>`) work regardless of agent status.

- `/mode <agent>` shows the current execution mode: `test (simulated)`, `live`, or `not applicable` for non-trading agents.
- `/mode <agent> <test|live|paper|shadow>` sets the execution mode. `paper` and `shadow` are accepted as aliases for `test`. The agent must have trading skills; non-trading agents are rejected.
- `/connect <agent>` without an ID or label: if you have active connections, lists them. If you have none, generates a one-time auto-expiring setup link that opens the "Connect AI agent to external platform" form in your browser.
- `/connect <agent> <id|label>` grants a connection to the agent by UUID or label (case-insensitive exact or unique prefix match). Idempotent — already granted returns success. Rejects ambiguous label matches.
- `/disconnect <agent> <id|label>` revokes a connection from the agent by UUID or label. Idempotent — already revoked returns success.

### `/start` Compatibility

A bare `/start` with no agent name acts as onboarding/help, not as a lifecycle action. Use `/start <agent name>` to start an agent.

### `/to` Messaging

- `/to <agent> <message>` sends a message to the named agent.
- Use quotes for agent names with spaces: `/to "DCA Bot" check positions`.
- `all` and `*` broadcast to every agent you own that can receive messages.
- `all` and `*` are reserved and cannot be used as agent names.

## Setup Link Flow

When you run `/connect <agent>` and have no active connections, OpenAIdom generates a one-time auto-login link:

1. The link opens your browser and logs you in automatically.
2. You are taken to the "Connect AI agent to external platform" form.
3. After creating the connection, use `/connect <agent> <id>` to assign it.

Links expire in 10 minutes and must not be shared. A per-user cooldown prevents rapid re-generation.

## Default Routing

If you send a plain Telegram message without a slash command:

- When exactly one of your agents is available, OpenAIdom delivers the message to that agent automatically.
- When multiple agents are available, OpenAIdom asks you to use `/to <agent name> <message>`.
- When no agents are available, OpenAIdom tells you that no running agents were found.

## Response Examples

Here are examples of what OpenAIdom returns for common commands.

### /info Agent

```
MyAgent:
Status: active
Execution mode: test (simulated)
Capital: $1,000.00
Daily loss limit: $500.00
Max drawdown: 15%
Position size: $100.00
Stop loss: 5%
Style: momentum
Strategy preset: standard
Skills: trading
Last session: 2026-07-14 12:30:00 UTC
Pause reason: -
Connections: 1
```

### /log Agent

```
MyAgent activity (last 5):
12:45 — [decision] Submitted BUY 0.5 SOL @ $22.40
12:30 — [message] User: check positions
12:15 — [decision] Submitted SELL 0.3 SOL @ $22.80
12:00 — [system] Session started
11:45 — [error] Venue timeout on get_price
```

### /restart Agent

```
Stopped MyAgent.
Waiting for agent to settle…
MyAgent is now stopped.
Started MyAgent.
```

## Interaction With Reply Threading

Reply-threading still takes priority. If you reply directly to an OpenAIdom Telegram message, OpenAIdom routes that reply using the original message anchor instead of slash-command parsing.

