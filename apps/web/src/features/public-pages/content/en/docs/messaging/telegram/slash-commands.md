# Control your AI Agent from your messaging app

OpenAIdom supports a rich set of slash commands that you use from within messaging apps. The commands are useful for agent discovery, status checks, lifecycle control, and configuration.

## Command Reference

Agent names with spaces must be wrapped in single or double quotes (e.g., `"DCA Bot"`). Bot mention suffixes (e.g., `/help@MyBot`) are stripped automatically.

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
| `/mode <agent> <test\|live>` | Set execution mode (agent must be stopped) |
| `/connect <agent>` | List connections or create a new connection for the agent, if there is no connection |
| `/connect <agent> <connection id or name>` | Grant a connection to an agent |
| `/disconnect <agent> <connection id or name>` | Revoke a connection from an agent |

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

## Default Routing

If you send a plain Telegram message without a slash command:

- When exactly one of your agents is available, OpenAIdom delivers the message to that agent automatically.
- When multiple agents are available, OpenAIdom asks you to use `/to <agent name> <message>`.
- When no agents are available, OpenAIdom tells you that no running agents were found.

## Interaction With Reply Threading

Reply-threading still takes priority. If you reply directly to an OpenAIdom Telegram message, OpenAIdom routes that reply using the original message anchor instead of slash-command parsing.

