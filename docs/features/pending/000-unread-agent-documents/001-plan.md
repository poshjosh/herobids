# Plan: Unread documents list and `list_agent_documents` tool

## Goal

Make sure an agent always knows the ids of documents it has not read yet, without putting every document it ever received into the prompt. This replaces the one-shot notice as the only way an agent learns a document id.

## Background

- The agent learns a document id only from a notice message: "User sent document `x` (document id `y`). To read it, call `read_agent_document`."
- The first-boot case is fixed by `docs/bug-reports/2026/11/16/001-document-notice-dropped-by-hydrated-caption-row.md`. A restart still loses the id, because the window is rebuilt from stored rows, which hold only the short caption.
- There is no tool to list documents. The agent has only `read_agent_document` (`apps/worker/src/tools/agent-documents.ts`).
- A "latest N documents" list does not work: a burst of 20 in one day hides documents, and old documents crowd out new ones. Unread is the useful filter.

## Scope

- In: a read marker per document, a `list_agent_documents` tool, an "Unread documents" prompt section, operator config, tests.
- Out: changing the notice flow, the caption row, or the web thread rendering. Deleting or archiving old documents. Images.

## Decisions

- A document is unread until `read_agent_document` serves its first page (offset 0). Later pages and re-reads do not change it.
- Prompt rule, rebuilt every tick:
  - 0 unread: no section.
  - 1 to `inlineMax` unread (default 5): list them inline (id, filename, upload time), oldest first, with the instruction to call `read_agent_document`.
  - More than `inlineMax` unread: show the count and one line telling the agent to call `list_agent_documents`, and how (paging arguments, `unreadOnly`).
- `list_agent_documents` returns newest first, paged, with `unreadOnly` defaulting to true. Each item: id, filename, mimeType, sizeBytes, extractionStatus, createdAt, readAt. A document with no readable text (`extractionStatus` failed) is listed and flagged, so the agent can tell the user.
- `inlineMax` and the tool page size come from operator config (`config/default.yaml`, under `agentRuntime.promptEnrichment`), not hard-coded.
- Access is `self`: an agent lists only its own documents, like `read_agent_document`.

## Steps

1. **DB:** add nullable `read_at` (timestamptz) to `agent_documents` in `packages/db/src/schema/agent-documents.ts` and a migration (next after `0091_merge_ext_prefixed_skills.sql`). Add repository methods `markRead(id)` (sets `read_at` only when null) and a paged `listByAgent` filter for unread. Follow `docs/best-practices/` for migrations.
2. **API:** in `apps/api/src/routes/agent-documents.ts`:
   - `GET /agents/:id/documents/:documentId/text` calls `markRead` when `offset` is 0 and the read succeeds.
   - Allow agent self-access on `GET /agents/:id/documents`, with `unreadOnly`, `limit` and `offset` query params, and return `readAt`. Keep the existing user response shape working.
3. **Platform client:** add `listAgentDocuments` next to `readAgentDocument` in `apps/worker/src/agents/agent-platform-client.ts`. Validate the response with Zod at the boundary.
4. **Tool:** add `list_agent_documents` to `apps/worker/src/tools/agent-documents.ts` and to the visible/read-only tool sets where `read_agent_document` is registered (`structured-tool-loop.ts`).
5. **Prompt section:** in `apps/worker/src/runtime-composition.ts`, add an "Unread documents" section built from a per-tick fetch. Fail soft: if the fetch fails, log a warning and omit the section, do not fail the tick.
6. **Config:** add `promptEnrichment.documents: { enabled, inlineMax, listPageSize }` to the schema and `config/default.yaml`. No `.env` variables are added, so no `.example` change is expected.
7. **Tests:**
   - Repository: `markRead` sets once and is not overwritten; unread filter and paging.
   - API: offset 0 read marks the document read; offset > 0 and a failed read do not; the agent cannot list another agent's documents; the user listing is unchanged.
   - Tool and client: paging, `unreadOnly`, error mapping.
   - Prompt: 0, exactly `inlineMax`, and `inlineMax` + 1 unread; fetch failure omits the section.
8. **Docs:** short bug-report follow-up note and an entry in the agent tool docs. Update `CHANGELOG.md`.

## Validation

- `pnpm lint`, then focused vitest runs for `packages/db`, `apps/api` and `apps/worker`.
- Manual (staging, after deploy): attach a CV in the create form, restart the agent before it reads it, and confirm the id still appears in the Unread section. Upload 6 documents and confirm the prompt shows the count and the tool instruction instead of the list. Confirm a read document leaves the section.

## Risks

- One extra DB read per tick. Keep it to a single indexed query on `agent_id` with a `read_at is null` filter and a small limit (`inlineMax + 1`) for the prompt.
- An agent that never reads a document keeps it in the prompt forever. Accepted: that is the intent. If it becomes noise, add an agent-callable "dismiss" later.
- The migration touches a table in use. A nullable column with no default is cheap and safe to roll forward. Per `docs/tech/agents/agent-runtime-rollout-guide.md` (ship the dependency first), deploy the API and DB first so the tool never calls a missing route.

## Effort

About 1 to 2 days with tests. Most of the time goes to the migration, the platform client and the prompt section tests.

## Open questions

- Should documents uploaded before this ships be treated as unread? Default proposal: set `read_at` for existing documents in the migration only if a `/text` read is known, otherwise leave them unread. Simplest is to leave all existing rows unread.
- Should the read marker be per agent session or permanent? Proposal: permanent.
