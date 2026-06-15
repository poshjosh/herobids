# Review: Telegram Reply Threading

## Verdict

Mostly implemented, with one operational gap.

The branch fixes webhook-secret validation, registers the webhook, adds `ForceReply` support and a session-started anchor, resolves replies via `telegram_message_id`, verifies the user via `telegram_chat_id`, and routes replies into `agent:outbound:{agentId}`. The main remaining issue is how the webhook work is executed.

## Findings

1. Medium: the webhook handler still performs routing, Redis writes, and Telegram confirmation calls inline before acknowledging Telegram.
   [apps/api/src/routes/agent-interactivity.ts](../../../../apps/api/src/routes/agent-interactivity.ts) does all DB lookups, stream writes, and `sendTelegramText()` calls inside the request path. The plan explicitly called out fast 200 responses with asynchronous processing when needed. Under Telegram API latency or a slow database, this increases the risk of Telegram retries and duplicate user-visible confirmations.

## Suggested Change List

1. Medium: modify [apps/api/src/routes/agent-interactivity.ts](../../../../apps/api/src/routes/agent-interactivity.ts) so the webhook acknowledges Telegram immediately and performs delivery/confirmation work asynchronously or through a small internal queue.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: if the team prefers synchronous confirmation for simplicity, document the latency budget and idempotency plan explicitly because Telegram retries will otherwise be hard to reason about.
   Test expectation: integration-test idempotent reply delivery under repeated webhook delivery; no visual verification needed.

2. Low: extract the reply-resolution query into a repository helper so the ownership and `telegram_message_id` contract is shared and directly testable.
   Files/functions: [apps/api/src/routes/agent-interactivity.ts](../../../../apps/api/src/routes/agent-interactivity.ts), [packages/db/src/agent-repository.ts](../../../../packages/db/src/agent-repository.ts).
   Change: add or modify.
   Dependencies: none.
   Risks/Open questions: this is mostly maintainability work, but it will make cross-user routing guarantees easier to lock down with tests.
   Test expectation: unit-test the repository helper; integration-test webhook routing.