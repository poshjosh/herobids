# 005 Tests and copy

**Depends on:** 002 and 004 (runs alongside each slice; the final sweep runs last).

**Status (2026-10-16):** the E2E helper and journeys were updated to the current create form (name, then Advanced Settings → objective, then Review, then Create AI agent). Journey 3 checks the Activity Timeline; its "Messages to user" check was removed because that text is not in the app. Selectors use `[data-field="name"]`, `[data-field="goal"]` and the Advanced Settings summary. No `data-testid` was added, because that would change the create form. Journeys 1, 3, 4, 14, 18 and 19 pass against the running stack (`BASE_URL=http://localhost:8090`). The full E2E suite has not been rerun since these changes.

## Unit and component tests to change

- `apps/web/src/features/agents/agent-payloads.test.ts`: many `buildCreateAgentPayload` cases. Remove the create-only cases; keep the edit payload cases.
- `apps/web/src/features/agents/create-agent-setup.test.ts`: refers to `CreateAgentFlow`. Update or replace.
- `apps/api/src/routes/chat.test.ts`: trading-enabled prompt cases and `create_agent` cases.

## E2E journeys (under `tests/e2e/`)

- `helpers.ts` `createAgent(page, goal, options)` drives the old form (`/agents/new`, "Use the form", skill and preset selectors). Many journeys use this helper, so update it first.
- `journeys/14-create-agent-setup-escape-hatch.spec.ts`: old form, "Add skills", and the guided-chat toggle. Rewrite for the new flow and drop the guided-chat assertions.
- `journeys/16-strategy-preset-propagation.spec.ts`: creates an agent with a strategy preset through the form. Retire or move the preset check to the edit flow.
- Check journeys 13, 18 and 19 for the same dependency when you reach them.
- New journey: create with a name only, land on the stopped agent page, Start is available, composer is enabled after Start.

## Copy and docs

- Public content pages that describe the old create flow, under `apps/web/src/features/public-pages/content/**`. Find them with a search for create-flow wording, then update.
- Regenerate the platform docs index: `pnpm --filter @herobids/scripts run build-docs-index`. Its source is `scripts/ts/build-docs-index.ts`, and its output is `apps/worker/src/tools/platform-docs-data.ts`. Remove trading-creation wording from the source, then regenerate.
- Landing and help copy: "talk to your agent" replaces the trading-agent wording (plan R-4).

## Acceptance

- Every journey above passes on a running stack.
- `scripts/shell/tests/run-all-tests.sh --e2e` passes.
- The docs index is regenerated and committed with the source change.
- A search of public content for the old create wording returns nothing.
