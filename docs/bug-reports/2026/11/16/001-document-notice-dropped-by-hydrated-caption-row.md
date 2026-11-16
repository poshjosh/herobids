# Bug Report: agent never learns the id of a document uploaded during agent creation

- **Status:** FIXED (in code, not deployed)
- **Severity:** Medium
- **Date:** 2026-11-16
- **Environment:** staging, agent `job-searcher` (`8365d836-7e09-470c-bbf0-06f69f3848b7`)
- **Related:** `docs/bug-reports/2026/11/15/003-agent-document-upload-via-control-plane-never-notifies-agent.md`

## Symptom

CV attached in the create-agent form. The agent's first message said it saw the upload but the file text did not reach it, and asked for a re-upload.

## Investigation (read-only, staging)

- Upload at 09:50:31: `agent_documents` row `extraction_status = ready`, extracted text 2,534 chars. The conversation row `Uploaded <file>` was marked `sent`.
- No `GET /agents/:id/documents/e65cdb7c.../text` request in the API log: the agent never called `read_agent_document` for that document.
- The CV re-sent in web chat at 09:52 (new document `7242fadd...`) was read at once (`/text` returned 200).

## Root Cause

Bug 003's fix records a caption row (`Uploaded <file>`) and publishes the full notice (document id + `read_agent_document` pointer) under the same message id. On the agent's first tick, `hydrateConversationWindow` loads the caption row, then `appendConversationEntry` skips the live envelope because the id is already in the window. The notice is discarded; the agent sees only the caption and has no document id.

Bug 003's reasoning that the live capture needs no stored row held for its first version (no row). It stopped holding once the row was recorded under the same id.

## Fix

`apps/worker/src/conversation-window.ts`: `preferDocumentNoticeText(storedText, liveText)`. `appendConversationEntry` (`apps/worker/src/agent.ts`) uses it when the id is already in the window: the live text replaces the stored text if it is a document notice and the stored text is not.

## Not fixed

A restart still rebuilds the window from the caption row alone, so the id is lost (accepted). A durable fix (unread-documents section plus a `list_agent_documents` tool) is a separate enhancement.

## Verification

- `apps/worker/src/conversation-window-document-notice.test.ts`: 3 tests pass; `conversation-window.test.ts` 22 pass.
- `pnpm lint` passes.
- Not run: end-to-end on staging after deploy.
