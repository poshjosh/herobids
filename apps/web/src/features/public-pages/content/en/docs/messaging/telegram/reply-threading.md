# Telegram Reply Threading

OpenAIdom agent messages sent to Telegram now arrive with reply mode already armed. When you reply to one of those messages, OpenAIdom routes your reply back to the agent that sent it.

## How It Works

1. Link your Telegram chat ID through the existing account setup flow.
2. Start an agent session.
3. OpenAIdom sends a session-started message that says the agent is running.
4. Every agent message also includes Telegram `ForceReply` markup.
5. Reply directly to that message in Telegram.
6. OpenAIdom resolves the original Telegram message back to the owning agent and delivers your reply into that agent's runtime inbox.

## What You Will See

- A session-started anchor message when a new agent session becomes active.
- Normal agent messages with reply mode pre-opened in Telegram.
- A delivery confirmation after your reply is accepted.

## Delivery Rules

- Replies are only routed when they are direct replies to an OpenAIdom Telegram message.
- OpenAIdom verifies that the incoming Telegram `chat.id` matches the linked account owner before routing.
- If the target agent is stopped or crashed, the reply is not delivered.

## User-Facing Errors

- `I couldn't find which agent that reply belongs to. The message may be too old.`
  The original Telegram message could not be mapped back to a stored OpenAIdom outbound message.

- `Agent <name> is stopped and cannot receive messages right now.`
  The reply was valid, but the agent is not in a state that can consume new user input.
