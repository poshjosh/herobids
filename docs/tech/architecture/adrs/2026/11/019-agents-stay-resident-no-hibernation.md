# ADR 019: Agents Stay Resident; No Hibernation

**Date:** 2026-11-11
**Status:** Accepted (owner decision, 2026-11-11)
**Reasoning and evidence:** [Decision Record D-2026-001](../../../../../decisions/records/D-2026-001-residency-vs-hibernation.md). This ADR states the outcome only.

## Context

At the target scale about 10,000 agent containers are up at once while only a small share work at any moment. Stopping idle containers and starting them on demand ("hibernation") could save node cost. The runtime bills by resident wall-clock time, several wake paths assume a running agent, and starting is slow in the tail: a staging measurement (2026-11-11) shows a median of 6.4 s, p90 of 20.0 s and a worst case of 333.5 s.

## Decision

1. **Agents stay resident.** A running agent keeps its container. We do not implement hibernation of idle agents.
2. **Main reason: latency.** Waiting tens of seconds for an agent to respond or wake is not acceptable (service expectation SE-1 in `docs/decisions/01-strategy.md`).
3. Cost is controlled by right-sizing and reducing per-agent overhead, not by stopping idle agents.
4. Agents that are stopped for another reason keep that meaning. In particular, agents whose account exceeds its hard billing limit are stopped (register item C-13), and are started again when the user tops up. That start is user-initiated, so SE-1 does not apply to it.

## Consequences

- Node sizing and the control plane are sized for the resident count (OD-04, OD-07, OD-14).
- Wake paths (watches, reminders, messages) keep relying on a running session. No wake-on-demand path is built.
- The `stop_agent_actor` cascade (it stops a trading agent's bots) stays a stop path only; it is not reused for cost saving.
- The runtime meter keeps running in the container, so billing is unchanged.

## Reopen if

- Wake latency can be brought reliably below what SE-1 allows, or the owner relaxes SE-1 or gives it numbers (the median start is about 6 s, so a quantified SE-1 could change the answer).
- Resident cost becomes unaffordable after right-sizing (the review triggers in the record).

## Related

[ADR-2026-06-003](../06/003-single-container-agent-code-execution.md) (one container per agent), [agent runtime rollout guide](../../../../agents/agent-runtime-rollout-guide.md), [decision register](../../../../../decisions/03-decision-register.md) rows C-12 and C-13.
