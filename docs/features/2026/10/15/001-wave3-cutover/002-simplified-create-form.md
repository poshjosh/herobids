# 002 Simplified create form (S3)

**Depends on:** nothing. **Blocks:** 004.

## Current state

- `apps/web/src/features/agents/CreateAgentPage.tsx` wraps `CreateAgentFlow` from `AgentsPage.tsx`. The flow has goal, style, skill preset, skills, connections, capital, execution mode, strategy, Telegram id, email override, and advanced settings.
- The payload is built by `buildCreateAgentPayload` in `apps/web/src/features/agents/agent-payloads.ts`.
- The client generates names with `apps/web/src/features/agents/agent-name.ts`.

## Build

1. The create page shows:
   - **Name** (optional). Placeholder text: "Generated for you if left blank."
   - **Channel**, a radio group with one option, "In this app", preselected.
   - A short line under the channel: connect Telegram or WhatsApp so the agent can reach you outside the app. Copy in `en.ts`, `ar.ts`, `hi.ts`.
2. Hide the channel section when the user already has a bound channel. Today that means a Telegram chat id on the profile.
3. On submit, call `POST /agents` with `{ name }` if the user typed one, otherwise `{}`. Navigate to the agent page. The agent is stopped; the existing S2 Start control applies.
4. Remove the client name generator from the create path. Check other callers of `agent-name.ts` before deleting the file.
5. Keep `CreateAgentFlow` only where the edit path still uses parts of it. Check with a search and the full web suite before deleting anything; do not delete on search results alone.
6. The edit form is unchanged. Do not modify `EditAgentModal` or `PATCH /agents`.

## Acceptance

- Empty name creates a stopped agent and lands on its page.
- A typed name is used as given.
- The only channel offered is "In this app".
- A user with a bound channel does not see the channel section.
- Edit form tests pass unchanged.
- i18n keys in all three locales, and the i18n regression test passes.
