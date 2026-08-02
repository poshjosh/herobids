# Bug Report: Edit Agent "Add Connection" Flow Is Not Wired

- **Status:** CLOSED
- **Severity:** High (blocks core UX)
- **Date:** 2026-08-02
- **Discovered:** Manual testing — clicking "Add Connection" from the **edit agent modal** does not start the provider setup flow. The same flow works from the **connections page** and the **create agent form**.
- **Summary:** The edit-agent flow is not wired to the same provider setup / OAuth flow used elsewhere. In `EditAgentModal.tsx`, the connection UI references `setShowAddConnection(true)` in two button handlers, but there is no matching state declaration in that file. Also, unlike the create-agent flow in `AgentsPage.tsx`, `EditAgentModal.tsx` does not import or render `ProviderSetupForm`, and it contains no `oauthReturn` handling.

## Reproduction

1. Open `Agents`.
2. Open the edit modal for an existing agent.
3. In the connections section, click `Add Connection`.
4. Observe that the provider setup flow does not open.

## Expected

Clicking `Add Connection` from the edit agent modal should open the same provider setup flow used by the create-agent experience, allowing a Gmail connection to be added from that context.

## Actual

Clicking `Add Connection` from the edit agent modal does not open the provider setup flow.

## Confirmed Findings

### `EditAgentModal.tsx` references an undeclared setup state

`EditAgentModal.tsx` contains two handlers that call `setShowAddConnection(true)`:

- one on the secondary `Add Connection` button in the empty-state branch
- one on the text-style `Add Connection` button below the selected connections list

Search results in the same file show no declaration for `showAddConnection` or `setShowAddConnection`; only the two usages are present.

### `EditAgentModal.tsx` does not render `ProviderSetupForm`

Search results for `ProviderSetupForm` in `apps/web/src/features/agents/EditAgentModal.tsx` return no matches.

### `EditAgentModal.tsx` contains no `oauthReturn` handling

Search results for `oauthReturn` in `apps/web/src/features/agents/EditAgentModal.tsx` return no matches.

### The create-agent flow in `AgentsPage.tsx` is wired for provider setup and OAuth return

Confirmed from `apps/web/src/features/agents/AgentsPage.tsx`:

- imports `ProviderSetupForm`
- renders `ProviderSetupForm` when `showSetup` is true
- passes `oauthReturnTo="/agents?create=1&oauthReturn=1"`
- saves draft state via `saveCreateAgentOAuthDraft(...)` before OAuth redirect
- detects `oauthReturn=1` in a `useEffect`, restores draft state via `loadCreateAgentOAuthDraft()`, invalidates connection queries on `status=ok`, and clears the URL params afterward

## Confirmed Scope

This issue is confirmed for the **edit agent modal**.

The original report was about Gmail. Based on the code, the failure happens before any provider-specific setup flow is launched, so the bug is consistent with a provider-agnostic failure in this UI path. However, only the Gmail user report is explicitly confirmed.

## Root Cause

This is a recent regression introduced by commit `b85ba45b` (`Improve UX`, 2026-08-01).

That change refactored the edit-agent connection picker to always render an `Add Connection` affordance, including:

- an empty-state `Add Connection` button when no connections exist
- a secondary `Add Connection` link under the selected connection chips

However, the same change did **not** add the supporting edit-flow plumbing those handlers require:

- no `showAddConnection` / `setShowAddConnection` state in `EditAgentModal.tsx`
- no `ProviderSetupForm` import or render path in `EditAgentModal.tsx`
- no OAuth return draft/restore handling analogous to the create flow in `AgentsPage.tsx`

Git history confirms this is the first commit that added `agents.create.addConnection` / `setShowAddConnection(true)` to `EditAgentModal.tsx`; earlier versions of that file had no edit-modal add-connection entry point at all. In other words, the regression was not in the underlying connection setup mechanism itself, which continued to work from the create-agent flow and connections page. The regression was that the new edit-modal trigger was merged without the state and OAuth wiring needed to make it functional.

The regression also escaped tests because the accompanying render test in `apps/web/src/features/agents/EditAgentModal.render.test.tsx` only verifies static text rendering. Specifically, `shows the add-connection empty state for non-trading agents with no existing connections` asserts that the modal contains:

- `agents.create.connections`
- `agents.create.noConnections`
- `agents.create.addConnection`

but it does not simulate clicking `Add Connection`, does not assert that any setup state toggles, does not verify that `ProviderSetupForm` renders, and does not cover OAuth return restoration. That allowed the dead `setShowAddConnection(true)` handlers to ship unnoticed.

## Suggested Fix Direction

Implement the edit-agent `Add Connection` path using the same setup flow pattern already used by `AgentsPage.tsx` for agent creation.

At minimum, this likely requires:

1. Add explicit setup state to `EditAgentModal.tsx`.
2. Render `ProviderSetupForm` from the edit flow.
3. Add a return path for OAuth similar to the create flow, if the edit modal must survive a full-page redirect.
4. Ensure the newly created connection is added back into the edit form state after return.

The exact implementation details should be confirmed during the fix, especially how the parent page re-opens the edit modal after OAuth return.

## Files Involved

- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/features/agents/AgentDetailPage.tsx`

## Fix

### `EditAgentModal.tsx`

1. **Added `showAddConnection` state** — `const [showAddConnection, setShowAddConnection] = useState(false)` — the state that the two existing `setShowAddConnection(true)` callbacks were already referencing.

2. **Imported and rendered `ProviderSetupForm`** — when `showAddConnection` is `true`, the same provider setup flow used by the create-agent experience is now rendered inside the edit modal. The `onClose` callback hides it; `onSuccess` (for credential-based providers) adds the new connection to `form.connectionIds` and closes the form.

3. **Added OAuth draft/restore plumbing** — a `saveEditAgentOAuthDraft` / `loadEditAgentOAuthDraft` / `clearEditAgentOAuthDraft` pattern (mirroring the create flow) saves the current `agentId` + `connectionIds` to `sessionStorage` before the OAuth redirect. After the redirect returns, a `useEffect` on mount reads `window.location.search` for `oauthReturn=1`, restores the draft, adds the new `connectionId` from the URL params, invalidates connection queries, and cleans up the URL params via `history.replaceState`.

4. **`oauthReturnTo`** set to `/agents/${agentId}?edit=1&oauthReturn=1` so the browser returns to the agent detail page after OAuth completes.

5. **`onBeforeOAuthRedirect`** saves the draft before the full-page redirect to the OAuth provider.

### `AgentDetailPage.tsx`

1. **Auto-opens edit modal on OAuth return** — a `useEffect` on mount detects `edit=1` in the URL search params and sets `isEditing = true`, so the `EditAgentModal` renders immediately after the OAuth redirect back to the detail page.

### Design decisions

- Used `window.location.search` directly (not `useLocation` from react-router) in `EditAgentModal.tsx` to avoid a router context dependency that would break the existing `renderToStaticMarkup`-based render tests.
- The OAuth draft key is scoped to edit-agent (`edit-agent-oauth-draft-v1`) to avoid collisions with the create-agent draft (`create-agent-oauth-draft-v1`).
- The `AgentDetailPage` `edit=1` detector uses a `useRef` guard to prevent re-triggering on re-renders.

## Files Changed

- `apps/web/src/features/agents/EditAgentModal.tsx` — added state, ProviderSetupForm render, OAuth draft plumbing
- `apps/web/src/features/agents/AgentDetailPage.tsx` — auto-open edit modal on OAuth return

## Verification

1. `pnpm lint` — no new type errors introduced.
2. `pnpm --filter @herobids/web exec vitest run src/features/agents/edit-agent-oauth-draft.test.ts` — all 21 tests pass (10 storage + 11 `applyOAuthReturnToForm`).
3. `pnpm --filter @herobids/web exec vitest run src/features/agents/EditAgentModal.render.test.tsx` — all 11 render tests pass.
4. Manual verification:
   - Open agent detail page → click Edit Config → in Connections section, click "Add Connection" → ProviderSetupForm opens.
   - For credential-based providers: complete setup → connection added to edit form's connectionIds.
   - For OAuth providers (Gmail): redirected to provider → on return, edit modal re-opens with all unsaved form edits preserved (name, goal, trading guards, model overrides, style, etc.) and the new connection added.
   - Existing create-agent flow and connections-page flow continue to work.

## Tests Added

### `edit-agent-oauth-draft.test.ts` (new file, 21 tests)

| Group | Tests | Coverage |
|-------|-------|----------|
| Storage helpers | 10 | Save/load round-trip, null on empty, clear, corrupted JSON, missing agentId, missing form, non-object value, key isolation from create-agent draft, empty connectionIds, clear scoped to key |
| `applyOAuthReturnToForm` | 11 | Null on null draft, null on agentId mismatch, restores full form state, merges new connectionId, deduplicates, preserves pendingFiles, restores style/skillPreset/modelOverrideEnabled/modelForm, uses draft connectionIds when no new id, empty array fallback |

### `EditAgentModal.render.test.tsx` (+3 tests, 11 total)

| Test | Coverage |
|------|----------|
| renders connection dropdown when active connections exist | `<select>` with group labels and "Choose a connection" renders |
| renders secondary Add Connection link below the connection picker | Text-style `+ Add connection` renders as secondary affordance |
| renders loading state when connections query is pending | "Loading platform links…" message |

## Post-Review Improvements

After code review, the following improvements were applied:

1. **Preserve full edit form state across OAuth redirects** — The OAuth draft now saves the entire `AgentFormState` (minus non-serializable `pendingFiles`), `style`, `skillPreset`, `modelOverrideEnabled`, `modelForm`, and `runtimePolicyOverrides`. Previously only `agentId` and `connectionIds` were saved, causing all unsaved edits to be lost after an OAuth redirect.

2. **Extract restoration logic into a pure function** — `applyOAuthReturnToForm()` is exported from the draft module, making the OAuth return state computation independently testable without sessionStorage or browser APIs.

3. **Move draft helpers to dedicated module** — `saveEditAgentOAuthDraft`, `loadEditAgentOAuthDraft`, `clearEditAgentOAuthDraft`, and `applyOAuthReturnToForm` now live in `edit-agent-oauth-draft.ts` instead of `EditAgentModal.tsx`, keeping the component module surface smaller.

## Files Changed

- `apps/web/src/features/agents/edit-agent-oauth-draft.ts` — new module: draft type, storage helpers, pure restoration logic
- `apps/web/src/features/agents/edit-agent-oauth-draft.test.ts` — new file, 21 unit tests
- `apps/web/src/features/agents/EditAgentModal.tsx` — imports from new module, expanded draft save, full state restoration on OAuth return
- `apps/web/src/features/agents/AgentDetailPage.tsx` — auto-open edit modal on OAuth return
- `apps/web/src/features/agents/EditAgentModal.render.test.tsx` — added 3 render tests
- `apps/web/src/features/agents/EditAgentModal.oauth-draft.test.ts` — removed (replaced by edit-agent-oauth-draft.test.ts)
