# TODO

Some of these may no longer be valid (they may have been done/implemented). 

I’m checking the latest unstaged blueprint and bot changes for remaining behavioral issues, especially places where the new locking and validation logic may still leave edge-case failures or contract gaps.

Ran terminal command:  git status --short && git --no-pager diff -- apps/api/src/index.ts apps/api/src/routes/blueprints.ts apps/api/src/routes/blueprints.test.ts apps/api/src/routes/bots.ts apps/api/src/schemas.ts packages/db/src/schema/blueprints.ts packages/db/src/schema/bots.ts packages/db/drizzle/0003_wonderful_inhumans.sql

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/blueprints.ts#220-220), lines 220 to 340

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/bots.ts#1-1), lines 1 to 140

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/schemas.ts#1-1), lines 1 to 30

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/blueprints.test.ts#288-288), lines 288 to 760

I’ve confirmed the current code shape after the last fixes. I’m checking one more slice around the bot test coverage and the blueprint mutation endpoints to separate real defects from test-only gaps.

Read [](file:///Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/blueprints.test.ts#760-760), lines 760 to 835

Searched for regex `app.post\('/blueprints'|app.post\('/blueprints/from-preset'|app.post<\{ Params: \{ id: string \} \}>\('/blueprints/:id/(publish|unpublish)'|app.delete<\{ Params: \{ id: string \} \}>\('/blueprints/:id'` (`**/apps/api/src/routes/blueprints.ts`), 3 results

Searched for regex `resolveBlueprintForWrite\(|resolveBlueprintForRead\(` (`**/apps/api/src/routes/blueprints.ts`), 8 results

I’ve isolated two realistic remaining issues: one mutation race the new advisory lock doesn’t fully close, and one still-ambiguous `POST /bots` request shape. I’m pulling exact lines for both so the findings map cleanly to the current code.

Searched for regex ``app.put<\{ Params: \{ id: string \}; Body: unknown \}>\('/blueprints/:id'|await tx.execute\(sql`SELECT pg_advisory_xact_lock\(2, hashtext\(\$\{request.params.id\}\)\)`\)|await tx.update\(blueprints\)\.set\(updateFields\)\.where\(eq\(blueprints.id, request.params.id\)\)|app.delete<\{ Params: \{ id: string \} \}>\('/blueprints/:id'|app.post<\{ Params: \{ id: string \} \}>\('/blueprints/:id/publish'|app.post<\{ Params: \{ id: string \} \}>\('/blueprints/:id/unpublish'`` (`**/apps/api/src/routes/blueprints.ts`), 6 results

Searched for regex `blueprintId: z.string\(\)\.min\(1\)\.optional\(\)|config: z.record\(z.unknown\(\)\)\.optional\(\)|configOverrides requires blueprintId` (`**/apps/api/src/schemas.ts`), 3 results

Searched for regex `if \(parsed.data.blueprintId\) \{|const usingDeprecatedInlineConfig = !parsed.data.blueprintId;` (`**/apps/api/src/routes/bots.ts`), 2 results

- [ ] blueprints.ts:226, blueprints.ts:235, blueprints.ts:266, blueprints.ts:277, blueprints.ts:321, and blueprints.ts:333 still leave blueprint mutations only partially serialized. PUT /blueprints/:id now takes an advisory lock, but DELETE, publish, and unpublish do not participate in that same lock. So a concurrent delete or visibility change can still interleave with the locked update path, and PUT can return 200 with an empty body or stale post-update assumptions if the row disappears or changes mid-transaction. If the intent is “one blueprint mutation at a time,” every mutating endpoint for the same blueprint id needs to use the same lock key.

- [ ] schemas.ts:8, schemas.ts:12, bots.ts:27, and bots.ts:29 still accept an ambiguous POST /bots body containing both blueprintId and legacy inline config. The route silently prefers blueprintId and ignores config, which is better than the old configOverrides hole, but it is still a silent conflict in the public contract. This should be rejected at validation time so callers do not think their inline config was applied when it was discarded.

- [ ] bots.ts and bots.ts still break `/bots/:id/sessions` pagination. The route now builds session pairs correctly, but it fetches the first `maxEvents` lifecycle events in ascending order before pairing and reversing. Once a bot has more than `(limit + offset) * 2 + 2` lifecycle events, page 1 stops reflecting the newest sessions and instead returns the newest sessions from the oldest slice of history. This is a real data-loss bug for any bot with longer history. The current stub test at bots.test.ts only checks that `sessions` exists, so it would not catch this.

- [ ] agents.ts and agents.ts return different response shapes for `/agents/:id/trades`. When an agent has no managed bots, the route returns `{ agentId, trades: [] }`; otherwise it returns `{ agentId, trades, limit, offset }`. That makes the contract data-dependent and forces clients to special-case the empty state. The matching test at agents.test.ts only asserts that `trades` is an array, so this drift is currently untested.

- [ ] agents.ts still imports `PgJournal` and `FillRepository`, but neither is used anymore. It is not a runtime defect, but it obscures the actual dependencies in this route and makes the file look like it still relies on abstractions that were bypassed in the new implementation.

- [ ] agent permission updates are still stale after first use because the broker caches the capability engine by agent ID and never invalidates it. The cache is established in agent-message-broker.ts, while the API now updates and re-derives toolPolicy in agents.ts. After an agent has made one tool call, later PATCH changes to skillIds or toolPolicy can be stored successfully but remain unenforced until the worker restarts.

- [ ] Sandbox enforcement on code execution has only been partially implemented. SandboxEnforcer and sandbox-exec.sh exist, and code_execute is in the capability grants, but no broker handler routes code_execute calls — the capability is defined but not wired on the production path

- [ ] Plan quota TOCTOU - Plan quotas are still bypassable under concurrency because every new limit check is a read-then-write sequence with no atomicity. The new guards in plan-guards.ts, plan-guards.ts, plan-guards.ts, plan-guards.ts, and plan-guards.ts run before inserts in endpoints like accounts.ts, credentials.ts, instances.ts, and backtests.ts. Two parallel requests can both observe “under limit” and both insert, so users can exceed every new plan cap. This needs a transactional counter/locking strategy or DB-enforced quota model; the current application-side checks are advisory only. WE SKIPPED EARLIER BECAUSE: the read-then-insert pattern in each create route is advisory-only under concurrency. Fixing it correctly requires wrapping every `checkXxxLimit` + `db.insert(...)` in a shared transaction with per-user serialization (advisory lock or `FOR UPDATE`), which is a cross-cutting change across 6 routes and all guard function signatures. This is a known limitation; for a soft billing limit the business impact of one extra row under a rare race is low.

- [ ] Checkout failover still has one unscoped cross-provider lookup. In billing.ts, the route derives the selected interval with resolveIntervalFromPriceId before handing off to the provider manager, but the helper in billing.ts searches Stripe first and then Creem without taking the owning provider. If two providers ever reuse the same ID string for the same plan but different intervals, the fallback path can preserve the wrong interval and create the wrong subscription variant. This should be scoped the same way as the other provider-aware helpers.

- [ ] There is still no regression test for the selected-price failover path, which is why the issue above is currently unprotected. The fallback coverage in provider-manager.test.ts exercises only the no-price case; it does not assert that a caller-selected month or year variant survives a primary-provider outage. Adding one test there would make this class of bug much harder to reintroduce.

- [ ] Consider getting HYPERLIQUID_TESTNET_API_KEY and setting it, to enable the related integration tests. 

- [ ] After monorepo scaffold: add `eslint-plugin-boundaries` if deep-path imports across packages become a recurring review issue. Until then, pnpm workspace resolution + clean barrel exports (`src/index.ts`) enforce dependency direction at build time.

- [ ] After monorepo scaffold: move §21 Conventions (Result type, error code naming) from the design doc into `packages/domain/README.md` or a top-level `docs/conventions.md` — somewhere that lives next to the code, not buried in a feature proposal.

- [ ] When implementing venue adapters: apply rate-limiting lessons from `docs/lessons/rate-limiting-guide.md` — never nest rate-limited calls, short TTL for empty/error cache entries, staleness max on cached prices, self-healing pressure backoff, and check whether provider limits are per-IP or per-key before sharing counters.

- [ ] Get insights from: /Users/chinomso.ikwuagwu/dev_ai/aitradingbot/config.example.yaml. Is there anything you would add or change? Now or later?