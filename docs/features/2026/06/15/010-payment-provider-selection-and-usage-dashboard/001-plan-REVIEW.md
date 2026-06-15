# Review: Payment Provider Selection and Usage Dashboard

## Verdict

Partially implemented.

The branch cleanly adds explicit billing-provider selection in config, supports `mock` as the default provider, keeps the billing page visible with empty states, and removes `USAGE_BILLING_ENABLED`. But the worker-side usage-billing lifecycle still references the old activation semantics.

## Findings

1. High: worker metering still depends on a removed `usageBilling.enabled` toggle.
   [apps/worker/src/index.ts](../../../../apps/worker/src/index.ts) and [apps/worker/src/agents/agent-session-manager.ts](../../../../apps/worker/src/agents/agent-session-manager.ts) still gate usage-billing setup on `appConfig.usageBilling?.enabled` / `this.config.usageBillingConfig?.enabled`, but the new config model in [config/default.yaml](../../../../config/default.yaml) and [packages/domain/src/config/schema.ts](../../../../packages/domain/src/config/schema.ts) no longer defines that flag. That means the runtime still carries the old activation concept the plan was meant to remove.

## Suggested Change List

1. High: modify [apps/worker/src/index.ts](../../../../apps/worker/src/index.ts) and [apps/worker/src/agents/agent-session-manager.ts](../../../../apps/worker/src/agents/agent-session-manager.ts) to remove the stale `usageBilling.enabled` checks and use the new always-on accounting model consistently.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: decide what the real product-level gating condition is now that provider selection and dashboard visibility are separate concerns; do not reintroduce a shadow runtime toggle under a different name.
   Test expectation: integration-test billing-period creation and runtime metering under the new config shape.

2. Medium: add a focused regression test proving usage-account setup and billing-period opening still happen when the dashboard is visible but no historical usage records exist.
   Files/functions: [apps/worker/src/agents/agent-session-manager.ts](../../../../apps/worker/src/agents/agent-session-manager.ts), [apps/web/src/features/billing/BillingPage.render.test.tsx](../../../../apps/web/src/features/billing/BillingPage.render.test.tsx).
   Change: add.
   Dependencies: step 1.
   Risks/Open questions: this should verify the runtime and UI stayed decoupled without accidentally disabling accounting.
   Test expectation: integration and render tests; no visual verification needed.