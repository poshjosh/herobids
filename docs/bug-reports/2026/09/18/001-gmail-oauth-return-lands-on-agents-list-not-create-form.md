# Bug Report: Gmail OAuth return lands on the agents list instead of the create-agent form — stale `oauthReturnTo` contract from the pre-`/agents/new` era

- **Status:** OPEN (investigation complete 2026-09-17; fix deliberately deferred — to be scheduled separately)
- **Severity:** Medium (no data loss — the Gmail connection IS created successfully; the user loses their in-progress create-agent draft context and must reopen the form manually)
- **Date:** 2026-09-18 (filed; behaviour observed and root-caused 2026-09-17)
- **Discovered by:** Manual test — adding a Gmail connection from the create-agent form, then returning from Google's OAuth consent screen.

## Reproduction

1. Open the create-agent form (`/agents/new`).
2. Click "Add connection" → `ProviderSetupForm` opens (in-form setup, `defaultCapability="trading"`).
3. Choose Gmail → browser redirects to Google consent → approve.
4. Google → herobids callback → **user lands on `http://localhost:8090/agents?create=1&oauthReturn=1&setup=gmail&status=ok&connectionId=<id>`** — the agents **list** page, with raw query params.
5. Expected: return to the **create-agent form** (`/agents/new`) with the draft restored and the new `connectionId` pre-selected.

## What actually happens, step by step (code-verified)

1. `AgentsPage.tsx:776` hardcodes `oauthReturnTo="/agents?create=1&oauthReturn=1"` on the `ProviderSetupForm` — a **stale contract from the era when the create flow was a modal on `/agents`**. The dedicated create page (`/agents/new`, `CreateAgentPage` → `CreateAgentFlow`) shipped 2026-08-06 (commit `e06ac34c`); this return path was never updated.
2. That returnTo is POSTed to `POST /connections/oauth/gmail/authorize` (`connections-oauth.ts:140-144`), stored in a callback-scoped cookie, and honoured at the callback: redirect to `returnTo + setup=gmail&status=ok&connectionId=<id>` (`connections-oauth.ts:409-413`).
3. The browser therefore lands on `/agents` — the **list** page (router: `app/router.tsx:53`).
4. **Nothing on `/agents` consumes those params.** The only reference to `create=1` in the entire web app is the producer itself (`AgentsPage.tsx:776`). The draft-restore effect (`AgentsPage.tsx:369-404`) — which correctly restores the saved draft (`sessionStorage` key `create-agent-oauth-draft-v1`: step, full intent, auto-gen flags), merges the returned `connectionId`, invalidates connection queries, clears the draft, and strips the params — lives inside `CreateAgentFlow`, which **only mounts at `/agents/new`**. At `/agents` it never runs.
5. Result: the orphaned `sessionStorage` draft sits unconsumed, the URL params linger (user sees `?create=1&oauthReturn=1&setup=gmail&status=ok&connectionId=…` in the address bar), and the form context is lost.

## Impact

- The user is dumped on the agents list mid-creation; the filled form (name/goal/skills/settings) is not restored and the new connection is not pre-selected into the form.
- The Gmail connection itself **is** created successfully (status=ok) — it appears in the picker next time the form is opened. No data loss.
- Raw OAuth params remain in the URL (also a minor cosmetics/share-URL issue).

## Root cause

**Producer-side stale URL contract.** The OAuth return flow is otherwise complete and correct: the draft save (`onBeforeOAuthRedirect` → `saveCreateAgentOAuthDraft`), the API round-trip (`returnTo` cookie → callback redirect), and the restore effect all work — but the return URL targets the page that hosted the create flow *before* the 2026-08-06 refactor, and the consumer-side restore code never mounts at that URL.

## Cross-flow comparison (isolated defect — the sibling flows all work)

| Flow | Return URL | Restores? |
|---|---|---|
| Guided chat | `/agents/new?guided=1&oauthReturn=1&threadId=…&actionId=…` | ✅ `GuidedSetupPanel` restores thread + auto-submits connectionId |
| Edit agent | `/agents/:id?edit=1&oauthReturn=1` | ✅ `AgentDetailPage` reads `edit=1`, auto-opens modal |
| Connections page | default `/connections` (no returnTo) | ✅ consumes `setup`/`status`, shows toast |
| **Create form** | `/agents?create=1&oauthReturn=1` | ❌ **nothing consumes it at that path** |

## Recommended fix (when scheduled — NOT applied)

Minimal, producer-only, consistent with the sibling flows:

1. `AgentsPage.tsx:776`: change `oauthReturnTo` from `/agents?create=1&oauthReturn=1` to **`/agents/new?oauthReturn=1`**. That routes to `CreateAgentPage` (form is the default mode), mounts `CreateAgentFlow`, and the existing restore effect then does everything (draft restore + connectionId merge + param cleanup). No consumer-side code needed.
2. Verify `sanitizeFrontendReturnTo` accepts it (`connections-oauth.ts:107-121` accepts same-origin absolute paths — it does).
3. QA nuance to check during implementation: `CreateAgentPage`'s mode toggle writes `?ui=chat`/`{}` via `replace: true` on switch — confirm landing with `?oauthReturn=1` isn't clobbered before `CreateAgentFlow`'s mount effect reads it (it fires on mount via `location.search`, so it should be fine; needs one manual round-trip QA).
4. Optional hygiene: strip unknown legacy params (`create=1`) if ever received; migrate/discard orphaned `sessionStorage` drafts saved under the old contract.

## References

- `apps/web/src/features/agents/AgentsPage.tsx:776` (producer — the stale `oauthReturnTo`), `:369-404` (restore effect inside `CreateAgentFlow`), `:108-131` (draft helpers)
- `apps/web/src/features/agents/CreateAgentPage.tsx` (dedicated create page; hosts `CreateAgentFlow`)
- `apps/web/src/app/router.tsx:53-54` (`/agents` list vs `/agents/new`)
- `apps/api/src/routes/connections-oauth.ts:133-146` (begin: returnTo cookie), `:409-413` (callback redirect), `:107-121` (sanitizer)
- `apps/web/src/features/chat/GuidedSetupPanel.tsx:77-112` + `GuidedSetupActionRenderer.tsx:152` (working guided-chat pattern)
- `apps/web/src/features/agents/AgentDetailPage.tsx:31-41` (working edit-modal pattern)
- History: commit `e06ac34c` (2026-08-06, "Improve UX for guided setup") introduced `/agents/new`; the return path predates it and was not updated.
- Related prior report on the same surface: `docs/bug-reports/2026/08/23/001-oauth-connect-gmail-crash-create-agent-form.md`
- Companion audit entry: `docs/tech/trading/audits/2026/09/001-herobids-trading-logic-ownership-audit.md` §6 (not trading-related; filed separately at the user's request).
