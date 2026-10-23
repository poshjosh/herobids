# 004 Trading removal from creation (narrow)

> **Status: DEFERRED / SUPERSEDED (owner, 2026-10-23).** Do not implement the removals below for the cut-over.
>
> - Trading fields stay in the create form for now: execution mode, venue, trading guardrails, and the trading auto-select and grouping in the connection picker.
> - The connection picker stays generic (connections are not only trading).
> - Future direction: trading setup is shown in a form hosted by Traderton, the way a payment provider hosts a payment form. Herobids will hand off to that form instead of rendering trading fields itself.
> - Guided chat removal (003) is unchanged.
> - The cut-over "done" criterion "no trading references in the form" no longer applies. Use "the create form calls `POST /agents`, and guided chat is removed" instead.
> - The term list and removal list below are kept for history only.

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

## Term list (proposed 2026-10-15, pending owner agreement)

Searched in the create path and guided chat: `trading`, `capital`, `executionMode` / `execution mode`, `strategyPreset` / `strategy preset`, `venue`, `authorizationMode` / `authorization mode`, `filterTrades` / `Filter Trades`, `tradingEnabled`, `guidedSetupTradingEnabled`, `create_agent`.

## Acceptance

- A grep of the create flow and guided chat finds no trading terms. Agree the term list at the start of the slice and record it in this file.
- Web and API suites pass.
- Blueprint instantiate and go-live clone tests pass.
