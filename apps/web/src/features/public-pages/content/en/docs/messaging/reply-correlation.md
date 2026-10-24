# Reply Correlation

When you reply to a message from one of your agents, OpenAIdom must work out which agent sent the message you are replying to. This page explains how that matching works.

## Why Matching Is Needed

- Telegram links a reply to the original message, so the match is usually exact.
- WhatsApp and SMS often do not link a reply to the message it answers.
- One platform number is shared by many agents, so the sender's number alone does not identify an agent.

## How a Message Is Matched

OpenAIdom checks these rules in order and uses the first one that gives a clear answer:

1. **Quoted message.** If your reply quotes a message the platform sent, the agent that sent that message is used.
2. **Explicit prefix.** `/to <agent> <message>` routes the message to the named agent. This is available on Telegram today. Other channels will use it when they are added.
3. **Only one running agent.** If you have exactly one running agent, a plain message with no quote or prefix goes to it.
4. **No clear match.** OpenAIdom does not guess. If several agents are running, it asks you to use the `/to` prefix. If none is running, it tells you to start an agent or reply to one of its messages.

## Examples

- You reply to a message from `Researcher` on Telegram and the reply is linked to it. The reply goes to `Researcher` (rule 1).
- You send `/to Researcher check the price` (rule 2).
- You send a plain message while only `Researcher` is running. The message goes to `Researcher` (rule 3).
- You send a plain message while several agents are running. OpenAIdom asks you to use `/to <agent> <message>` (rule 4).

## Opt-Out and Pending Addresses

- An address that has opted out (revoked) or is pending confirmation is not used.
- Messages are not sent to that address, and replies from it are not routed.
- OpenAIdom never falls back to an older address. If an agent goes quiet after you opted out or changed numbers, this is why.
- To receive messages again, confirm the address is active.

## Platform-Wide Opt-Out

The platform number is shared, so an address that has opted out for a provider is blocked for every user on the platform for that provider. Opting out is not limited to one agent or one account.

## Telegram

Telegram chat IDs are per user, so the shared-number rule does not affect Telegram in the same way.

## User-Facing Errors

- `I couldn't find which agent that reply belongs to. The message may be too old.`
  A reply could not be matched to an agent. This also applies when the address is opted out or pending confirmation.

- `Agent <name> is stopped and cannot receive messages right now.`
  The message matched an agent, but that agent cannot receive input in its current state.

- `Multiple running agents found. Use /to <agent name> <message> to choose a target.`
  Several agents are running and the message did not name one (rule 4).

- `No running agents found. Start an agent or reply to one of its Telegram messages.`
  No agent is running for a plain message.

- `No agent named <name> found.`
  A `/to` prefix named an agent that does not belong to your account.

- `Please include a message after the target.`
  A `/to` prefix was sent without message text.

## See also

- [Telegram Reply Threading](/docs/messaging/telegram/reply-threading) — How direct replies to agent Telegram messages are routed.
