## AGENT USAGE BILLING - Q AND A
## Prompt 1

We are foremost an agentic platform. We offer agents as a service. We use skills to give agents expertise to work for users. Our first and core skill is crypto trading.

Read docs/vision.md

What have we implemented so far in the way of payments? Keep the response to this very brief.

We are considering a usage billing model. The kind offered by cloud providers. This is because we are moving in the direction of offering llm tokens and server resources as our primary service for users to use agents.

What do you think?

## Response 1

The vision doc is clearly pointing at agents-as-a-service with skills as the delivery mechanism, and the billing work we have today is still subscription-first, not usage-first. In practice, we already have checkout, customer portal, cancel/upgrade, webhook handling, a local mock provider, a persisted subscription projection, and a billing UI in apps/api/src/routes/billing.ts, apps/api/src/billing/provider-manager.ts, packages/db/src/schema/billing-subscriptions.ts, and apps/web/src/features/billing/BillingPage.tsx.

I think usage billing is the right direction for your stated product, because your primary costs are tokens and server resources and that maps much better to metering than flat plans. I would not make it “open-ended postpaid” without controls, though: do it like a cloud provider with clear usage meters, spend caps, alerts, and maybe a small base commitment or credit top-up layer so users still have predictable guardrails.

## Prompt 2

How do we go from where we are to where we want to be?

## Response 2

You should treat this as an additive migration, not a rewrite. The current system already has the right outer shape: payment-driven plan entitlements are handled in the control plane via billing routes, entitlement sync, auth plan lookup, and plan guards. The worker already tracks session token and server-cost signals in agent runtime and runtime composition, but that data is in-memory operational telemetry, not a durable financial ledger. That is the main gap.

The right path is:

1. Keep `plans` as packaging and coarse access control, not as the usage ledger. Existing plan enforcement is still useful for feature access, agent count, live trading, and enterprise gating. Do not overload `users.planId` or `user_plans` with consumption accounting.

2. Introduce an internal metering layer before touching external billing semantics. Create immutable usage events keyed by `userId`, `agentId`, `sessionId`, `skillId`, `provider`, `model`, `usageType`, `quantity`, `occurredAt`, and an idempotency key. Make the schema skill-agnostic so trading is just the first skill, not a special case.

3. Start with only two billable resources. Bill for LLM usage and active agent runtime. LLM usage is already close to available via the runtime hooks; runtime cost should be derived from agent-active seconds or minutes, not from trying to reconstruct exact cloud invoices.

4. Separate metering from pricing. Raw events should say “this user consumed 18,000 input tokens on model X” or “this agent ran for 240 active seconds.” A versioned rate card should translate that into money later. If you mix provider prices directly into the raw events, you will make repricing, promotions, enterprise contracts, and corrections painful.

5. Add a credit/spend ledger, not just a monthly invoice number. For an agent platform, enforcement matters as much as invoicing. You need balances, adjustments, grants, top-ups, overage records, and spend caps. This is what lets you stop or degrade agent activity safely when a user runs out of allowance.

6. Make enforcement happen at the control boundary, not in trading logic. Before an LLM call or when starting/continuing an agent session, check whether the account can spend more. The existing worker guardrails like `dailySpendBudgetUsd` and `dailyTokenBudget` currently influence cadence and prompt context, but they are not a hard platform billing control. That needs to change.

7. Launch with a hybrid commercial model, not pure open-ended postpaid. Keep subscriptions or plans, but redefine them as “base access + included monthly credits + caps + enterprise features.” That gives you predictable onboarding and guardrails while moving the economics toward usage. Later, if you want, you can reduce the subscription component.

8. Build user-visible usage surfaces early. Add “usage this period,” “estimated current charges,” “remaining included credits,” “hard cap,” and “which agents/skills are spending” to the billing UI. If users cannot see spend building up in real time, usage billing will feel hostile.

9. Let HeroBids be the source of truth for metering, and use Stripe/Creem to collect money. Your current billing abstraction is already good for checkout, subscriptions, and portal flows. For usage billing, the external provider should charge based on totals HeroBids computed, not become the authoritative place where usage is reconstructed.

10. Roll it out in this order: internal meter, rating engine, account balance model, enforcement, UI, then invoicing/top-ups. If you reverse that and start with invoices or provider-specific metered billing, you will end up with weak enforcement and poor explainability.

My recommended product shape is: free/pro/enterprise still exist, but mainly as access and commercial packaging tiers; each tier includes credits, spend caps, feature gates, and maybe better model access. That fits both the current architecture and the “agents as a service” direction much better than forcing everything into flat subscriptions.

Open questions that should be answered before implementation starts:

1. Do you want prepaid credits, capped postpaid, or a hybrid? My recommendation is hybrid first: included credits plus hard caps and optional top-ups.

2. What are the first billable units? My recommendation is only `llm tokens` and `active agent runtime` at launch. Do not start with storage, network egress, or every tool call.

3. Is billing per user, or do you expect team/workspace billing soon? If workspace billing is likely, design the ledger around a generic `accountId` now instead of hard-coding everything to `userId`.