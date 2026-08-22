# ADR — Soft Cap Must Warn, Not Mutate Agent Behavior

**Date:** 2026-06-27
**Status:** Accepted

## Context

OpenAIdom usage billing supports two spending thresholds: a soft cap and a hard cap. The original implementation degraded agent behavior at the soft cap (suppressing judge escalation, and in some paths skipping the scout entirely). This created two problems:

1. It violated [Agent Mode Purity](../agents/runtime-boundary-and-message-contract.md#agent-mode-purity) — the platform was silently changing how a user's agent trades without the user's explicit permission.
2. The behavior was inconsistent across code paths: forced pre-scout cases turned into a hold, while the normal scout path still ran. Logs and comments described "scout only" mode, but the actual behavior varied.

## Decision

**Soft cap must not change agent behavior.** It is a notification-only boundary.

**Hard cap may stop the agent's reasoning loop.** It is an operational stop, not a trading decision.

Specifically:

- When the soft cap is reached, the platform sends a user notification (Telegram, email, or both) and emits an activity event. The agent continues reasoning and trading exactly as before.
- When the hard cap is reached, the platform halts the tick before any LLM call, emits a stop event, and sends a user notification that includes open-position context. The agent does not close or modify positions.
- The platform never silently degrades, pauses, or alters agent behavior due to a spending threshold.

## Rationale

1. **User intent is supreme.** The user created their agent with specific trading logic. Changing that logic because of a spending threshold is a policy override the user did not ask for.

2. **Transparency.** If spending is approaching a limit, the right thing to do is tell the user clearly, not silently change what their agent does. The user can then decide: top up, raise the cap, or stop.

3. **Consistency.** A single clear rule (soft cap = warn, hard cap = stop) is easier to implement, test, document, and explain than per-path degradation logic.

4. **Safety.** If the hard cap stops an agent with open positions, the user must know. Silent degradation could mask the fact that positions are unmonitored.

## Consequences

- Removes soft-limit behavior changes from the scout/judge dispatch path in `apps/worker/src/agent.ts`
- Removes `resolveForcedPreScoutBillingOutcome` soft-limit hold logic from `apps/worker/src/scout-gating.ts`
- Adds user-facing notification dispatch for both soft-cap and hard-cap events
- Updates public documentation, FAQs, and agent style docs to reflect the new policy
- Requires a dedicated billing-enforcement semantics doc in `docs/tech/agents/`
