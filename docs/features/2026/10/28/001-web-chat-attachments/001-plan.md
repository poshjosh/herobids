# Plan: Web chat attachments (Option B, no images)

## Goal

Let users attach a supported document (text, JSON, XML, CSV, PDF, DOCX; max 10 MiB) when sending a web chat message to a running agent. The agent receives the file the same way Telegram document messages work today.

## Scope

- In: web composer file picker, message endpoint accepting an optional file, `web_chat` document source, shared delivery notification, tests.
- Out: images and photos, attachment rendering in the thread, changes to Telegram behaviour.

## Decisions

- Keep the existing 10 MiB cap and allow-list for web.
- Agent not running: reject the send before storing the file, with a clear message (for example `409 agent_not_running`: "Start the agent to send a document."). This matches the Telegram behaviour and the existing running-state gate on `POST /agents/:id/message`. The composer keeps the selected file so the user can retry after starting the agent.
- Staged documents are only materialized when a session starts, so storing a file for a stopped agent would not notify it. Rejecting first avoids orphaned uploads.

## Steps

1. **Domain/DB:** add `'web_chat'` to `DocumentSource` in [agent-documents-repository.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/agent-documents-repository.ts) and update the schema comment in [agent-documents.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/db/src/schema/agent-documents.ts). Check for any DB check constraint first.
2. **Shared helper:** extract the agent-notification text and delivery from `processWebhookDocument` in [agent-interactivity.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agent-interactivity.ts) so Telegram and web use the same code.
3. **API:** extend `POST /agents/:id/message` to accept multipart with an optional `file` field. Keep JSON bodies working. Check running state first, then store the file via `AgentDocumentService.uploadDocument` with `source: 'web_chat'` and `captionOrPrompt` set to the message text. Keep `clientMessageId` idempotency and rate limits. Reject unsupported types and oversize files with the existing error codes.
4. **Web:** add a file picker to [AgentConversation.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/AgentConversation.tsx) and send multipart in `agentsApi.sendMessage` in [api-client.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/lib/api-client.ts). Show size, type, and not-running errors, plus a file chip before send.
5. **Tests:** functional tests for JSON and multipart sends, retry with the same `clientMessageId`, rejected types/sizes, and the not-running rejection. Component test for the picker.
6. **Docs:** update the messaging docs if they describe what agents can receive.

## Validation

- Run the smallest affected test suites for `apps/api`, `apps/web`, and `packages/documents`/`db`.
- Manual check: send a PDF from web chat to a running agent and confirm the file appears under `docs/original/` and the agent is notified.
- Manual check: send with a stopped agent and confirm the rejection and that no document row is created.

## Risks

- The message route is JSON-only today. Switching to multipart must not break retries or idempotency.
- A file stored but the message publish failing would leave a document without a notification. Consider storing only after the publish succeeds, or flagging the document on failure.

## Open questions

- None outstanding.
