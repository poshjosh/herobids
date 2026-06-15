# Review: 025 - Trading Binding Native Bot Startup Follow-Through

## Verdict

Partially implemented.

The branch introduces a worker-local startup-context resolver in [apps/worker/src/startup-context.ts](../../../apps/worker/src/startup-context.ts), changes the queue callback contract to be `tradingBindingId`-first in [apps/worker/src/agents/agent-message-broker.ts](../../../apps/worker/src/agents/agent-message-broker.ts), and routes runtime startup through the resolver in [apps/worker/src/index.ts](../../../apps/worker/src/index.ts). But the compatibility and failure-handling edges are still not fully binding-native.

## Findings

1. High: the transitional fallback still mis-treats `venueAccountId` as though it were a `tradingBindingId`.
   In [apps/worker/src/startup-context.ts](../../../apps/worker/src/startup-context.ts), `resolveTradingBindingId()` falls back to `rawConfig.venueAccountId` and `rawConfig.venue_account_id`. In [apps/worker/src/agents/agent-message-broker.ts](../../../apps/worker/src/agents/agent-message-broker.ts), explicit start and restart still pass `bot.tradingBindingId ?? bot.venueAccountId`. That is not a real compatibility path; it can turn a legacy venue-account identifier into a bogus binding lookup and fail with misleading errors.

2. Medium: provider-specific source-account requirements are still duplicated instead of fully centralized.
   The resolver already computes whether a source venue account is required, but [apps/worker/src/index.ts](../../../apps/worker/src/index.ts) still unconditionally throws when `startupContext.sourceVenueAccountId` is absent. That undermines the plan's goal of keeping startup requirement logic in one worker-owned resolver surface.

3. Medium: startup failures are still surfaced as generic `Error` strings rather than binding-native failure codes.
   The branch improves message wording, but the failure contract is still stringly and inconsistent with the plan's aim to make binding-resolution failures explicit and machine-distinguishable.

## Suggested Change List

1. High: modify [apps/worker/src/startup-context.ts](../../apps/worker/src/startup-context.ts) and [apps/worker/src/agents/agent-message-broker.ts](../../apps/worker/src/agents/agent-message-broker.ts) so legacy payload support never reuses `venueAccountId` as a surrogate binding ID.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: if there are still persisted bots without `tradingBindingId`, define one explicit compatibility path for them instead of letting the resolver guess.
   Test expectation: unit-test `resolveBotStartupContext()` legacy payloads; integration-test explicit start/restart jobs.

2. Medium: modify [apps/worker/src/index.ts](../../../apps/worker/src/index.ts) to consume the resolver's requirement decision instead of imposing a second unconditional `sourceVenueAccountId` precondition.
   Change: modify.
   Dependencies: step 1.
   Risks/Open questions: confirm whether all currently supported venues truly require a source venue account today; if they do, encode that once in the resolver and remove the duplicate runtime guard.
   Test expectation: unit-test provider-specific startup requirements; integration-test startup for both orderbook and swap venues.

3. Medium: add typed binding-native startup errors or error codes in [apps/worker/src/startup-context.ts](../../../apps/worker/src/startup-context.ts) and the worker startup path.
   Change: add or modify.
   Dependencies: step 1.
   Risks/Open questions: keep the error surface stable enough that API and worker operators can distinguish binding-not-found, binding-revoked, and missing-source-account cases.
   Test expectation: unit tests for error-code coverage; no visual verification needed.