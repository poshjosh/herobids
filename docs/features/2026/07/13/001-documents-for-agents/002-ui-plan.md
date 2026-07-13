# Plan: Documents For Agents — UI Wiring

**Status:** draft  
**Created:** 2026-07-13  
**Parent:** [001-plan.md](./001-plan.md) — Item 6: Wire create/edit UI

## Problem

The backend for agent documents (Item 1–5, 7–11) is fully implemented. The API exposes:

- `POST /agents/:id/documents` — multipart upload (10 MiB limit, MIME-validated)
- `GET /agents/:id/documents` — list attached documents with lifecycle state
- `DELETE /agents/:id/documents/:documentId` — soft-delete + blob cleanup

The web UI (`apps/web/`) does not expose any of this. Users cannot upload documents during agent creation or editing.

## Scope

### In scope

- Add a file picker to the agent create/edit form
- Upload selected files after agent creation (two-step: create → upload)
- Show existing documents in the edit modal with delete support
- Add document API methods to the frontend API client

### Out of scope

- Drag-and-drop file upload
- Upload progress bars (browser-native progress is fine for v1)
- Document preview / inline viewing
- Editable document metadata (captions, etc.)

## Context

### Frontend stack

- **Framework:** React 19 + Vite + Tailwind CSS
- **State/API:** TanStack React Query (`useQuery`, `useMutation`)
- **Routing:** React Router v7
- **Forms:** Controlled components (no react-hook-form — custom state management via `AgentFormState`)

### Key files

| File | Role |
|------|------|
| `apps/web/src/lib/api-client.ts` (~L1038) | All API calls; `agents.create`, `agents.update`, etc. |
| `apps/web/src/features/agents/agent-form-state.ts` | `AgentFormState` interface + `agentToFormState()` |
| `apps/web/src/features/agents/AgentFormBody.tsx` | Reusable form body used by both create + edit |
| `apps/web/src/features/agents/AgentsPage.tsx` (~L597) | Create wizard (intent → review → submit) |
| `apps/web/src/features/agents/EditAgentModal.tsx` | Edit modal |

### How the create flow works today

1. User fills out the form (name, goal, skills, trading settings, etc.)
2. On submit, `mutation.mutate()` calls `agentsApi.create(...)` with the full payload
3. On success: `onCreated(agent.id)` fires → navigates to the new agent's detail page
4. No post-creation steps exist today

### How the edit flow works today

1. `EditAgentModal` receives `initialData: Agent`, converts to `AgentFormState` via `agentToFormState()`
2. User edits fields, submits via `agents.update(id, payload)`
3. On success, closes modal + invalidates queries

## Implementation Steps

### Step 1: Add document API client methods

**File:** `apps/web/src/lib/api-client.ts`

Add three methods to the `agents` object (after the existing `delete` method):

```ts
// List documents for an agent
listDocuments: (agentId: string) =>
  request<AgentDocument[]>(`/agents/${agentId}/documents`),

// Upload a document to an agent
uploadDocument: (agentId: string, file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  return request<AgentDocument>(
    `/agents/${agentId}/documents`,
    { method: 'POST', body: formData },
  );
},

// Delete a document
deleteDocument: (agentId: string, documentId: string) =>
  request<void>(`/agents/${agentId}/documents/${documentId}`, { method: 'DELETE' }),
```

Also define the `AgentDocument` type:

```ts
export interface AgentDocument {
  id: string;
  agentId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  extractionStatus: 'not_needed' | 'ready' | 'failed';
  lifecycleState: 'staged' | 'materialized' | 'deleted' | 'failed';
  source: 'control_plane' | 'telegram';
  captionOrPrompt: string | null;
  createdAt: string;
}
```

### Step 2: Add `pendingFiles` to form state

**File:** `apps/web/src/features/agents/agent-form-state.ts`

Add to `AgentFormState`:

```ts
/** Files selected in the document picker, pending upload after agent creation. */
pendingFiles: File[];
```

In `agentToFormState()` default: `pendingFiles: []`.

### Step 3: Add file picker to AgentFormBody

**File:** `apps/web/src/features/agents/AgentFormBody.tsx`

Add a new section at the bottom of the form:

```tsx
{/* Document upload */}
<SectionLabel>Documents (optional)</SectionLabel>
<p className="text-xs text-gray-500 mb-2">
  Upload PDFs, Word docs, or text files for the agent to reference.
  Documents are available while the agent is running.
</p>
<input
  type="file"
  multiple
  accept=".txt,.md,.csv,.html,.xml,.json,.pdf,.docx"
  onChange={(e) => {
    const files = Array.from(e.target.files ?? []);
    onChange({ pendingFiles: files });
  }}
  className={inputStyle}
/>
{value.pendingFiles.length > 0 && (
  <ul className="mt-2 text-sm text-gray-600">
    {value.pendingFiles.map((f, i) => (
      <li key={i} className="flex items-center gap-2">
        <span>{f.name}</span>
        <span className="text-xs text-gray-400">({(f.size / 1024).toFixed(0)} KB)</span>
        <button
          type="button"
          onClick={() => {
            const next = value.pendingFiles.filter((_, j) => j !== i);
            onChange({ pendingFiles: next });
          }}
          className="text-red-500 hover:text-red-700 text-xs"
        >
          Remove
        </button>
      </li>
    ))}
  </ul>
)}
```

Accept attribute: `.txt,.md,.csv,.html,.xml,.json,.pdf,.docx` — matches `ALLOWED_UPLOAD_MIME_TYPES` in the backend.

### Step 4: Wire create flow — upload after agent creation

**File:** `apps/web/src/features/agents/AgentsPage.tsx`

In the create mutation's `mutationFn`, after `agentsApi.create(...)` succeeds:

```ts
// After agent creation, upload any selected documents
const uploadedDocs: AgentDocument[] = [];
if (intent.pendingFiles.length > 0) {
  for (const file of intent.pendingFiles) {
    try {
      const doc = await agentsApi.uploadDocument(agent.id, file);
      uploadedDocs.push(doc);
    } catch (err) {
      // Partial failure: agent was created, individual doc upload failed.
      // Log but don't block — the user can retry from the detail page.
      console.warn('Document upload failed:', file.name, err);
    }
  }
}
return { agent, uploadedDocs };
```

The mutation's `onSuccess` already navigates to the agent detail page. Documents will be materialized into the workspace by the worker's periodic refresh (Item 8).

**Partial failure UX:** If some documents fail to upload after the agent is created, the agent still exists and the user can upload documents from the edit flow. No error modal is needed for v1 — the files simply won't appear.

### Step 5: Wire edit flow — list + upload + delete

**File:** `apps/web/src/features/agents/EditAgentModal.tsx`

#### 5a) Fetch existing documents

Add a `useQuery` to fetch existing documents when the modal opens:

```ts
const docsQuery = useQuery({
  queryKey: ['agent-documents', agentId],
  queryFn: () => agentsApi.listDocuments(agentId),
  enabled: true,
});
```

#### 5b) Show existing documents below the form

Add a document list section after the form body but before the action buttons:

```tsx
{/* Existing documents */}
{docsQuery.data && docsQuery.data.length > 0 && (
  <div className="mt-4">
    <SectionLabel>Documents ({docsQuery.data.length})</SectionLabel>
    <ul className="space-y-1">
      {docsQuery.data.map((doc) => (
        <li key={doc.id} className="flex items-center justify-between text-sm">
          <span className="truncate">{doc.originalFilename}</span>
          <span className="text-xs text-gray-400 shrink-0 ml-2">
            {doc.extractionStatus === 'ready' ? '✓ extracted' : doc.extractionStatus}
          </span>
          <button
            type="button"
            onClick={async () => {
              await agentsApi.deleteDocument(agentId, doc.id);
              docsQuery.refetch();
            }}
            className="text-red-500 hover:text-red-700 text-xs ml-2 shrink-0"
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  </div>
)}
```

#### 5c) Add file picker for new uploads in edit mode

Same `input[type=file]` as in `AgentFormBody`, plus an "Upload" button that calls `agentsApi.uploadDocument(agentId, file)` and refetches the list.

### Step 6: Show document count on agent summary card (optional)

**File:** `apps/web/src/features/agents/AgentSummaryCard.tsx`

Add a small indicator showing document count if > 0. This is a nice-to-have; skip if it adds complexity.

## Rollout Order

1. [PENDING] Add `AgentDocument` type + `listDocuments`/`uploadDocument`/`deleteDocument` to API client
2. [PENDING] Add `pendingFiles` to `AgentFormState` + file picker to `AgentFormBody`
3. [PENDING] Wire create flow: upload after agent creation in `AgentsPage.tsx`
4. [PENDING] Wire edit flow: list existing docs + upload new + delete in `EditAgentModal.tsx`

## Verification

- Create an agent with a PDF file → agent detail shows the document
- Edit an agent → existing documents are listed, can delete them
- Upload an unsupported file type → API returns 400, UI shows error (or console warning)
- Upload a file > 10 MiB → API returns 413, handled gracefully
- Create an agent without documents → agent created normally, no document section shown

## Risks

1. **No upload progress indicator.** Browser-native progress via `XMLHttpRequest` would be nicer but adds complexity. Start with `fetch` + no progress bar; add later if users complain.
2. **Sequential uploads on create.** Files are uploaded one at a time. For v1 with small files this is fine; parallel uploads can be added later.
3. **Partial create success.** If agent creation succeeds but document uploads fail, the agent exists without documents. The user can add them from the edit flow. No error modal for v1.
