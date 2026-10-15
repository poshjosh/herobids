# Wave 3: cut-over (WP-C S3 + S4)

**Status:** ready for handoff
**Created:** 2026-10-15
**Parent plan:** [006-simplified-agent-creation/001-plan.md](../../10/10/006-simplified-agent-creation/001-plan.md) (S3, S4, removal list)
**Epic:** [002-agent-onboarding-epic/000-roadmap.md](../../10/10/002-agent-onboarding-epic/000-roadmap.md)

## Goal

Creating an agent asks for two things only: an optional name and a channel. The create form and the guided chat both call one server-side create core. The edit form is unchanged.

## Already done (not in this wave)

S1 (optional name, `update_my_prompt`, first-turn guidance) and S2 (in-app conversation) are complete per the epic PROGRESS file.

## Decisions

| # | Decision | Source |
|---|---|---|
| D-1 | Narrow trading removal: the creation UIs and the guided chat stop offering trading. The `POST /agents` trading branch stays for blueprint instantiate and go-live clone. | Owner, 2026-10-15 |
| D-2 | No feature flag for the cut-over. The product is not public, and staging and production will be torn down and rebuilt. | Owner, 2026-10-15 |
| D-3 | Guided chat is deferred and not part of Wave 3. This supersedes the 2026-10-10 decision to keep it (R-5). | Owner, 2026-10-15 |
| D-4 | Deferred with guided chat. Decide when guided chat resumes. | Owner, 2026-10-15 |
| D-5 | The channel selector offers only "In this app" until the Telegram deep link ships in Wave 4. | Owner, 2026-10-15 |
| D-6 | When no name is given, the server generates it (`apps/api/src/services/agent-name-service.ts`). The web client stops generating names. | Recommendation: one source of names |
| D-7 | The shared create core is deferred. The form calls `POST /agents` directly. Revisit when guided chat resumes, or in Wave 5 cleanup if blueprint and go-live still duplicate creation. | Owner, 2026-10-15 |

## Work order

1. [002-simplified-create-form.md](002-simplified-create-form.md). Calls `POST /agents` directly (D-7).
2. [004-trading-removal-from-creation.md](004-trading-removal-from-creation.md). After 002 is merged. Guided chat ([003](003-guided-chat-simplification.md)) is deferred.
3. [005-tests-and-copy.md](005-tests-and-copy.md). Test updates travel with each slice; the copy and docs sweep runs last.
4. The shared core ([001](001-shared-create-core.md)) is deferred and not in this wave.

## Merge gate

Not a blocker for Wave 3 work (owner, 2026-10-15). Decide whether to require WP-A and WP-B verification when the cut-over is ready to merge. Gate G1 is not used here.

## Done when

- The form contains no trading references.
- The form calls `POST /agents`.
- The guided chat page is unreachable, and its create tool is removed.
- `pnpm test`, the per-project `tsc --noEmit` checks, and `scripts/shell/tests/run-all-tests.sh --e2e` pass. Root `pnpm lint` checks nothing, so use the per-project checks.
- The platform docs index is regenerated.

## Corrections to earlier plans

Checked against the code on 2026-10-15. These statements are superseded:

- The parent plan (006) says `POST /agents` requires `name`. It does not: `name` is optional and the server allocates one (`apps/api/src/routes/agents.ts`, around L673).
- The parent plan and the roadmap say S3 and S4 ship together, with one shared create core. Superseded: S4 and the core are deferred (D-7). The owner should update the roadmap and `IMPLEMENTATION.md` Wave 3 text when next editing the epic.
- Earlier drafts named a config flag `chat.guidedSetup.tradingEnabled`. No such config key exists. The real item is the `guidedSetupTradingEnabled` parameter in `apps/api/src/routes/chat.ts`, which defaults to `false`.

## Handoff

Each numbered file is self-contained. An implementer reads this README and the one file they own.
