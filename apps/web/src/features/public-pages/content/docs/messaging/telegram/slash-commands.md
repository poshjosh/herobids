# Telegram Slash Commands

HeroBids supports Telegram slash-command routing for agent instructions when you are not replying to a specific agent message.

## Command Format

Use `/to` followed by one or more agent targets and then the message body.

Examples:

- `/to Momentum buy BTC now`
- `/to "DCA Bot" pause trading`
- `/to Agent1 Agent2 send daily summary`
- `/to all stop`
- `/to * check positions`

## Target Rules

- Bare names work for agent names without spaces.
- Use single or double quotes for names with spaces.
- `all` and `*` broadcast to every agent you own that can currently receive messages.
- `all` and `*` are reserved and cannot be used as new agent names.

## Default Routing

If you send a plain Telegram message without `/to`:

- When exactly one of your agents is available, HeroBids delivers the message to that agent automatically.
- When multiple agents are available, HeroBids asks you to use `/to <agent name> <message>`.
- When no agents are available, HeroBids tells you that no running agents were found.

## Delivery Responses

HeroBids confirms delivery back in Telegram.

Possible responses include:

- `Delivered to <agent name>.`
- `No agent named <name> found.`
- `Agent <name> is stopped and cannot receive messages right now.`
- `Please include a message after the target.`

## Interaction With Reply Threading

Reply-threading still takes priority. If you reply directly to a HeroBids Telegram message, HeroBids routes that reply using the original message anchor instead of slash-command parsing.
