# Bug Report: `GET /journal?actorId=<agent-id>` returns empty for agent-direct trades — route only handles bot-scoped journal

- **Status:** FIXED (2026-09-19). Root cause: herobids `apps/api/src/routes/views.ts` `/journal` route always built a **user/bot** subject and called `get_owner_bot_journal` with `actorId` treated as a **bot id**, never routing the **agent** case. Fix: `journalRoutes` now disambiguates via the platform `agents` table — an owned-agent `actorId` routes to `get_agent_journal_events` with an `{ actor: { type: 'agent', id } }` subject and filters `type` in-app; otherwise the bot branch is unchanged. Unit tests updated/added in `views.test.ts`.
- **Severity:** Medium-High (test/gate false-failure; agent-direct journal is invisible through the API. The data is NOT lost — `journal_events` has agent rows; the read surface is missing.)
- **Date:** 2026-09-19
- **Discovered by:** A8 stabilization-certification gate, item 5/6 (full open+close cycle via `agent-trade-test.sh`, hyperliquid/paper).
- **Environment:** development, local docker compose cross-stack.

## Root cause — CONFIRMED

1. `agent-trade-test.sh` phase 3.5 asserts `fetchDirectAgentJournalEvents` → `GET /journal?actorId=<agent-id>&limit=20`, expecting `body.events` attributed to the agent.
2. herobids `views.ts` `/journal`:
   - builds `subject = { ownerId: userId, actor: { type: 'user', id: userId } }` (user-scoped),
   - calls `get_owner_bot_journal` with `botId: actorId` (bot-scoped),
   - returns `events` — empty for an agent actor, because the traderton rows are `actor_type='agent'`, not a bot.
3. traderton's `get_agent_journal_events` exists (`packages/worker/src/tools/bots.ts:1254`) and returns agent-native + agent-owned-bot journal, but requires the boundary context `ctx.agentId` — i.e. the subject must be `{ actor: { type: 'agent', id: agentId } }` (as `capabilities/trading.ts:174` does for `get_agent_positions`/`get_agent_fills`).
4. The `/journal` route has NO agent branch — it treats `actorId` as a bot id unconditionally (the code comment at `views.ts:34` even documents "the sole live consumer is the instance dashboard's bot journal").

Observed: journal DB has 36 rows incl. `decision.created`, `fill.recorded`, `plan.created`, `order.filled`, `plan.completed` (`actor_type='agent'`), but `GET /journal?actorId=<agent>` returns `[]` → phase 3.5 wrongly reports "silent rejection".

## Fix (applied)

`views.ts` `journalRoutes` now distinguishes agent vs bot actor: it looks up `actorId` in the platform `agents` table (still local); an owned agent takes `get_agent_journal_events` with `{ ownerId, actor: { type: 'agent', id: actorId } }` subject (mirroring `capabilities/trading.ts`), filtering the `type` query in-app (the agent tool takes only `from`/`to`). Otherwise the bot branch (`get_owner_bot_journal`) is unchanged. `journalRoutes` now takes the previously-unused `db` (wired at `index.ts:272`).

Added `views.test.ts` coverage: "routes an OWNED agent actorId through get_agent_journal_events (agent subject)". The three existing bot-branch tests updated to pass a `makeJournalDb()` stub.

## Not a data-loss bug

`journal_events` is correctly populated with agent rows — only the API read surface was bot-only. No migration/backfill needed.

## References

- `herobids/apps/api/src/routes/views.ts:39-80` (`/journal`)
- `herobids/apps/api/src/routes/capabilities/trading.ts:174` (correct agent-subject precedent)
- `traderton/packages/worker/src/tools/bots.ts:1246-1282` (`get_agent_journal_events`)
- A8 plan item 5/6 (parity sweep + eval) — this is the class of read-surface gap the gate is meant to inventory.