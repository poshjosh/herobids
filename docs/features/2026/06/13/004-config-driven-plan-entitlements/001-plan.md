# Config-Driven Plan Entitlements

## Objective

Add a config-only hybrid entitlement system with no admin UI.

Plan definitions stay in operator config, user plan assignment stays in the existing DB-backed billing/auth flow, and the API/frontend use one normalized entitlement resolver for all plan checks. The first slice should cover skill publication, marketplace visibility, agent prompt visibility, and the existing resource quotas.

## Scope

### In scope

- Plan-level feature flags and quotas in config
- Skill publication and marketplace visibility rules
- Agent prompt visibility rules
- Existing quota enforcement for agents, bots, connections, credentials, bindings, venue accounts, backtests, and live trading
- Frontend gating that matches the API
- Focused tests and documentation

### Out of scope

- Admin UI for editing plans or entitlements
- Separate plan-entitlements table in v1
- Usage metering or billing ledger work
- Per-user entitlement override UI

## Required Plan Capabilities

The first version should support at least these permissions and limits:

- `skills.canCreatePrivateSkills`
- `skills.canViewMarketplaceSkills`
- `skills.canPublishToMarketplace`
- `skills.autoPublishNonDraftSkills`
- `skills.canPriceSkills`
- `skills.canLikeMarketplaceSkills`
- `agents.canViewOwnPrompts`
- existing resource limits for agents, bots, connections, credentials, bindings, venue accounts, backtests, and live trading

Additional implicit permissions worth capturing:

- users can create draft skills
- users can create non-marketplace skills only if the plan allows private skills
- built-in/system skills remain a separate surface from marketplace skills
- admins bypass all plan restrictions

## Current-State Assumptions

- `users.planId` remains the source of the user’s active plan
- `user_plans` remains the historical record of plan transitions
- plan quotas are already read from config and enforced in the API
- agent prompts are already ownership-gated, but not plan-gated
- skills currently use an overloaded `visibility` field and need a canonical publication model for this feature

## Implementation Steps

### 1. Extend config with a typed entitlement model

Update `packages/domain/src/config/schema.ts` and `config/default.yaml` so each plan has a single `entitlements` block that separates feature flags from limits.

Suggested shape:

- `skills.canCreatePrivateSkills`
- `skills.canViewMarketplaceSkills`
- `skills.canPublishToMarketplace`
- `skills.autoPublishNonDraftSkills`
- `skills.canPriceSkills`
- `skills.canLikeMarketplaceSkills`
- `agents.canViewOwnPrompts`
- resource limits for the existing route checks

Keep the default-plan fallback and admin bypass behavior.

### 2. Normalize skill publication semantics

Update `packages/db/src/schema/skills.ts` and `apps/api/src/routes/skills.ts` so plan rules can distinguish draft, private/personal, and public/marketplace behavior.

Rules for the first slice:

- drafts are always allowed
- free users may create drafts
- if a plan does not allow private skills, non-draft skill creation should force the skill public/marketplace-visible
- marketplace visibility should be plan-gated on read and write paths

### 3. Add a single entitlement resolver

Create one API helper that:

- reads `users.planId`
- resolves the active plan from config
- applies the default fallback
- applies the admin bypass
- returns a normalized entitlement object

All plan checks should consume that resolver instead of reading plan config ad hoc.

### 4. Wire the resolver through API enforcement

Update:

- `apps/api/src/plan-guards.ts`
- `apps/api/src/routes/agent-interactivity.ts`
- `apps/api/src/routes/skills.ts`
- `apps/api/src/routes/agents.ts`
- `apps/api/src/routes/bots.ts`
- `apps/api/src/routes/accounts.ts`
- `apps/api/src/routes/credentials.ts`
- `apps/api/src/routes/connections.ts`
- `apps/api/src/routes/setup.ts`
- `apps/api/src/routes/backtests.ts`

Behavior to enforce:

- skills list/get/create/update/fork should respect marketplace access and private-skill rules
- `GET /agents/:id/prompt` should be blocked when the plan does not allow prompt visibility
- live trading and quota limits should continue to fail closed at the API boundary

### 5. Mirror the same behavior in the frontend

Update the skills and agent UI surfaces so disallowed actions are hidden or disabled before submit.

Show plan-aware copy for:

- marketplace access
- private/public skill choices
- prompt visibility

No admin management UI should be added in this slice.

### 6. Add focused tests and a short feature note

Add tests for:

- plan fallback
- admin bypass
- free-plan auto-public skill creation
- marketplace skills hidden when the plan disallows them
- own-agent prompt access blocked when the plan disallows it
- quota failures for agents, bots, connections, credentials, and bindings

Document the final entitlement matrix in the feature notes so future plan additions stay consistent.

## Relevant Files

- `packages/domain/src/config/schema.ts`
- `config/default.yaml`
- `apps/api/src/plan-guards.ts`
- `apps/api/src/routes/skills.ts`
- `packages/db/src/schema/skills.ts`
- `apps/api/src/routes/agent-interactivity.ts`
- `apps/api/src/routes/agents.ts`
- `apps/api/src/routes/bots.ts`
- `apps/api/src/routes/accounts.ts`
- `apps/api/src/routes/credentials.ts`
- `apps/api/src/routes/connections.ts`
- `apps/api/src/routes/setup.ts`
- `apps/api/src/routes/backtests.ts`
- `apps/web/src/features/skills/SkillsPage.tsx`
- `apps/web/src/lib/api-client.ts`

## Decisions

- No admin UI in this slice
- No separate plan-entitlements table in v1
- User plan assignment remains DB-backed through the existing auth/billing flow
- Admin users bypass plan restrictions entirely
- Built-in/system skills remain separate from marketplace skills in v1
- Free-plan rule: drafts are allowed, but any non-draft skill created by a free user should be forced public/marketplace-visible

## Verification

1. Add resolver tests for plan fallback, admin bypass, and per-plan feature matrices.
2. Add route tests for skills publication, marketplace filtering, prompt access, and plan-limit failures.
3. Run the narrow test suite for the touched API and domain files first.
4. Run repo lint/typecheck before considering the slice complete.

## Open Questions

1. Should marketplace pricing and likes be implemented in the same slice, or later? 

Answer: Later

2. If paid plans support private skills, should the canonical state model be `draft/private/public` or `draft/personal/public/published`?

Answer: Ask yourself, what is the difference between public and published? You decide what to use. Keep it simple, make it flexible, extensible, evolvable