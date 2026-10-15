# 004 Trading removal from creation (narrow)

**Depends on:** 002 merged.

## Scope (owner decision D-1)

Remove trading from the creation form and the guided chat's create path. Guided chat is deferred, so its page and creation tool are removed here. The `POST /agents` trading branch stays, because blueprint instantiate and go-live clone use it (plan D7).

## Remove

**Web (create path only):**
- trading fields in `buildCreateAgentPayload` (`apps/web/src/features/agents/agent-payloads.ts`), if the edit path does not use them;
- `resolveCreateAgentConnectionIds`, if only create uses it;
- the create-time connection slot and the OAuth draft stash `CREATE_AGENT_OAUTH_DRAFT_KEY` in `AgentsPage.tsx`;
- create-flow `defaultCapability="trading"` call sites. Keep `GENERIC_FORM_SHOWS_TRADING_PROVIDERS` in `ProviderSetupForm.tsx` if the agent-triggered connection link (WP-A) still needs it.

**Guided chat (deferred, removed here):**
- the guided chat page route and its "Use guided chat" entry point (web);
- the `create_agent` tool in `apps/api/src/routes/chat.ts`, so nothing can create through chat (keep other chat routes);
- trading branches of `buildCustomPrompt` and the `guidedSetupTradingEnabled` parameter threaded through `chat.ts` (default `false`; no config key exists).

## Keep

- The `POST /agents` trading branch and its `executionDefaults` requirement.
- Blueprint instantiate and go-live clone paths.

## Method

1. Start from a grep for each term, then check every candidate for other callers.
2. Delete one slice at a time, running the affected suite after each.
3. Run the full web and API suites before the slice is done. Grep alone is not enough.

## Acceptance

- A grep of the create flow and guided chat finds no trading terms. Agree the term list at the start of the slice and record it in this file.
- Web and API suites pass.
- Blueprint instantiate and go-live clone tests pass.
