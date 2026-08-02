# Bug Report: Edit Agent "Add Connection" Flow Is Not Wired

- **Status:** OPEN
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

## Likely Cause

The edit-agent path appears to be incomplete relative to the create-agent path: the UI contains `Add Connection` triggers, but the state, setup form rendering, and OAuth return plumbing present in `AgentsPage.tsx` are absent from `EditAgentModal.tsx`.

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
- `apps/web/src/features/agents/AgentsPage.tsx`

## Verification

1. From the edit agent modal, clicking `Add Connection` opens the provider setup flow.
2. From that flow, a Gmail connection can be completed and associated back to the edit form.
3. The existing create-agent setup flow still works.
4. The connections-page setup flow still works.
5. `pnpm lint` passes.
