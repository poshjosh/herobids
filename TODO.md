# TODO

Some of these may no longer be valid (they may have been done/implemented). 

- [ ] agent permission updates are still stale after first use because the broker caches the capability engine by agent ID and never invalidates it. The cache is established in agent-message-broker.ts, while the API now updates and re-derives toolPolicy in agents.ts. After an agent has made one tool call, later PATCH changes to skillIds or toolPolicy can be stored successfully but remain unenforced until the worker restarts.

- [ ] Sandbox enforcement on code execution has only been partially implemented. SandboxEnforcer and sandbox-exec.sh exist, and code_execute is in the capability grants, but no broker handler routes code_execute calls — the capability is defined but not wired on the production path

- [x] Make appropriate Foreign Keys `ON DELETE CASCADE` rather than manually deleting them e.g.
```
// Delete FK-referencing child rows before removing the parent so PG doesn't reject.
// Order matters: outbound messages → artifacts → sessions → links → agent
await db.delete(agentOutboundMessages).where(eq(agentOutboundMessages.agentId, id));
await db.delete(agentArtifacts).where(eq(agentArtifacts.agentId, id));
await db.delete(agentRuntimeSessions).where(eq(agentRuntimeSessions.agentId, id));
await db.delete(agentInstanceLinks).where(eq(agentInstanceLinks.agentId, id));

await db.delete(agents).where(eq(agents.id, id));
```

- [ ] Plan quota TOCTOU - Plan quotas are still bypassable under concurrency because every new limit check is a read-then-write sequence with no atomicity. The new guards in plan-guards.ts, plan-guards.ts, plan-guards.ts, plan-guards.ts, and plan-guards.ts run before inserts in endpoints like accounts.ts, credentials.ts, instances.ts, and backtests.ts. Two parallel requests can both observe “under limit” and both insert, so users can exceed every new plan cap. This needs a transactional counter/locking strategy or DB-enforced quota model; the current application-side checks are advisory only. WE SKIPPED EARLIER BECAUSE: the read-then-insert pattern in each create route is advisory-only under concurrency. Fixing it correctly requires wrapping every `checkXxxLimit` + `db.insert(...)` in a shared transaction with per-user serialization (advisory lock or `FOR UPDATE`), which is a cross-cutting change across 6 routes and all guard function signatures. This is a known limitation; for a soft billing limit the business impact of one extra row under a rare race is low.

- [ ] Checkout failover still has one unscoped cross-provider lookup. In billing.ts, the route derives the selected interval with resolveIntervalFromPriceId before handing off to the provider manager, but the helper in billing.ts searches Stripe first and then Creem without taking the owning provider. If two providers ever reuse the same ID string for the same plan but different intervals, the fallback path can preserve the wrong interval and create the wrong subscription variant. This should be scoped the same way as the other provider-aware helpers.

- [ ] There is still no regression test for the selected-price failover path, which is why the issue above is currently unprotected. The fallback coverage in provider-manager.test.ts exercises only the no-price case; it does not assert that a caller-selected month or year variant survives a primary-provider outage. Adding one test there would make this class of bug much harder to reintroduce.

- [ ] Consider getting HYPERLIQUID_TESTNET_API_KEY and setting it, to enable the related integration tests. 

- [ ] After monorepo scaffold: add `eslint-plugin-boundaries` if deep-path imports across packages become a recurring review issue. Until then, pnpm workspace resolution + clean barrel exports (`src/index.ts`) enforce dependency direction at build time.

- [ ] After monorepo scaffold: move §21 Conventions (Result type, error code naming) from the design doc into `packages/domain/README.md` or a top-level `docs/conventions.md` — somewhere that lives next to the code, not buried in a feature proposal.

- [ ] When implementing venue adapters: apply rate-limiting lessons from `docs/lessons/rate-limiting-guide.md` — never nest rate-limited calls, short TTL for empty/error cache entries, staleness max on cached prices, self-healing pressure backoff, and check whether provider limits are per-IP or per-key before sharing counters.

- [ ] Get insights from: /Users/chinomso.ikwuagwu/dev_ai/aitradingbot/config.example.yaml. Is there anything you would add or change? Now or later?