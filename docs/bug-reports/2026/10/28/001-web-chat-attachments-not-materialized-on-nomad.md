# Bug Report 001 — Web chat attachments never reach Nomad-run agents

- **Status:** FIXED (option B: `read_agent_document` tool reads text through the platform API; option C: notice names the document id and the tool, not a file path; uncommitted, pending review; not deployed to staging)
- **Severity:** High (user-sent documents are silently unavailable to the agent on staging)
- **Date:** 2026-10-28
- **Environment:** staging (`herobids-staging`, `138.199.172.202`), `RUNTIME_BACKEND=nomad`
- **Related:** bug report 002 (2026-09-26, agent image distribution); feature plan `docs/features/2026/10/28/001-web-chat-attachments/001-plan.md`

## Summary

A file attached in web chat is stored and recorded, and the agent receives a message saying it is at `docs/original/<id>-<name>`. On the Nomad runtime that file is never copied into the agent workspace, so the agent cannot find it and reports that the document did not arrive.

Observed on staging for agent `30fd88fb-97ce-4ac9-b664-9ed3bfcfbcbb`: two uploads (`document-09f934ed.md`, created 2026-10-28 20:28 and 20:34 UTC) are both `lifecycle_state = 'staged'` with `materialized_session_id` null.

## Root Cause

1. `apps/api/src/routes/agent-interactivity.ts` (`POST /agents/:id/message`) stages the file in `LocalDocumentStore` on the control plane and appends a notice built by `buildDocumentNoticeText` (`packages/documents/src/agent-document-notice.ts`) that names `docs/original/...` and `docs/extracted/...`.
2. Copying a staged document into the workspace happens only in `AgentRuntimeLauncher.materializeStagedDocuments()` (`apps/worker/src/agents/agent-runtime-launcher.ts`). It is skipped unless `documentMaterializer` is set.
3. The Docker backend sets `documentMaterializer: new DockerRuntimeDocumentMaterializer(...)` (`apps/worker/src/index.ts`, ~line 394). The Nomad branch (~line 440) does not, with the comment "Document materialization is skipped for Nomad". The skip is silent: no error and no log line.
4. `refreshLiveDocuments()` has the same guard, so documents uploaded to a running Nomad agent are never copied either.

Local development uses the Docker backend, which explains why attachments appear to work there.

## Why It Was Not Caught

The 2026-10-28 plan's manual check ("file appears under `docs/original/`") was only run on the local Docker backend. The plan does not mention Nomad.

## Expected

A document sent in web chat is available to the agent on every runtime backend, at the path named in the notice (or the notice is changed to match what the agent can actually read).

## Files

- `apps/worker/src/index.ts` — Nomad branch omits `documentMaterializer`
- `apps/worker/src/agents/agent-runtime-launcher.ts` — `materializeStagedDocuments`, `refreshLiveDocuments`
- `apps/worker/src/agents/docker-document-materializer.ts` — Docker-only copy (uses `putArchive`)
- `apps/worker/src/agents/stub-document-materializer.ts` — filesystem copy, not usable on a remote node
- `apps/api/src/routes/agent-interactivity.ts` — stages file, appends notice
- `packages/documents/src/agent-document-notice.ts` — notice text with workspace paths

## Options

- **A.** Copy documents into the Nomad allocation (exec/upload into the running task) on launch and on refresh.
- **B.** Give the agent a read tool that fetches a document by id from the API's document store. Changes the tool contract and the notice text.
- **C.** Interim: change the Nomad-path notice so it does not promise a workspace file. Does not deliver the document.

## Design Notes (review follow-up)

- The agent container does not have the document store. `read_agent_document` calls `GET /agents/:id/documents/:documentId/text` through the agent's own platform client, and the API reads the blob. An earlier version read the store from the agent process, which would not have found the file on Nomad or Docker.
- Access: the route is `agentAccess: 'self'`. A document owned by another agent returns `document.not_found`.
- Paging: 100,000 characters per call (code points, so surrogate pairs are not split). Blobs over 5 MiB are refused before reading. Continue with `nextOffset`.
- Lifecycle: a read does not change `lifecycle_state`. Documents stay `staged` on Nomad. `materialized` still means only "copied into a runtime workspace" (Docker). The earlier expectation of `materialized` is dropped.
- Stale history: agents prompted before this change may still mention `docs/extracted/...`. The Docker backend still writes those files, so the paths still resolve there. On Nomad they do not, and the agent should call `read_agent_document` with the document id.

## Verification (to run after deploy; not done)

- Unit: `packages/documents/src/agent-document-read.test.ts` and `apps/worker/src/tools/agent-documents.test.ts` (pass locally).
- Staging, read-only: confirm `herobids-api-1` has `AGENT_DOCUMENTS_DIR` set and that its mount holds the uploaded blobs. Reads only happen in the API, so the upload and read paths share one volume by construction.
- Staging: send a `.md` file from web chat to a running Nomad agent; the agent calls `read_agent_document` and its reply includes the file contents.
- Staging: a PDF whose extraction failed returns `document.no_text` (HTTP 422) and the agent reports it.
- Docker backend: local attachment flow still passes its tests.
