# Phase 5d: Open Questions

## Canonical Technical References

Resolved answers should be folded into the canonical technical docs under `docs/tech/agents/`:

- [Runtime Boundary And Message Contract](../../../../tech/agents/runtime-boundary-and-message-contract.md)
- [Message Catalog](../../../../tech/agents/message-catalog.md)
- [Recovery And Replay](../../../../tech/agents/recovery-and-replay.md)
- [Tool Access And Sandboxing](../../../../tech/agents/tool-access-and-sandboxing.md)

This file now tracks only the smaller unresolved items that remain after the major Phase 5d design choices were made.

It is intentionally short. Once a question is resolved and folded into the design doc or message catalog, remove it from this list.

## Open Questions

### 1. Open Internet Egress Guardrails

Question:
- If sandbox runtimes have open internet egress, what exact guardrails do we enforce on rate, concurrency, timeout, response size, storage, audit, and kill-switch behavior?

Why it matters:
- Open internet egress preserves flexibility, but only if the runtime limits are strong enough to cap cost, abuse, and blast radius.

Current options:
- Conservative budgets and aggressive kill-switches
- More permissive budgets with stronger post-hoc monitoring
- Channel-specific budgets for web, code execution, and artifact activity

Recommended bias:
- Prefer conservative initial budgets with clear audit, runtime disablement, and fast revocation.

### 2. Code Execution Boundary For The First Agent Release

Question:
- If code execution ships in the first agent release, does it run in a nested sandbox, sidecar, or separate service boundary?

Why it matters:
- Code execution is shipping early, so the main remaining design question is how much extra isolation it gets relative to the base agent runtime.

Current options:
- Nested sandbox inside the agent runtime boundary
- Sidecar runtime with a stricter policy surface
- Separate service or microVM boundary for execution tasks

Recommended bias:
- Prefer a stricter nested sandbox or separate execution boundary rather than unconstrained execution inside the main agent process.

### 3. User, Agent, And Bot Surface Modeling

Question:
- How should user, agent, and bot relationships appear in API, UI, and storage models without collapsing them into one identity field?

Why it matters:
- The runtime boundary is now clearer, but frontend navigation, authorization, and persistence still need a concrete relationship model.

Current options:
- User owns agents and bots directly, with optional agent-to-bot links
- User owns agents, and bots always belong to an agent
- Mixed model where some bots are standalone and some are agent-attached

Recommended bias:
- Prefer user-owned agents and user-owned bots with optional agent-to-bot links, because it avoids forcing every bot through an agent abstraction.

### 4. Artifact Retention And Retrieval

Question:
- Where should large agent artifacts live, how long should they be retained, and how should the UI retrieve them?

Why it matters:
- The canonical docs now define metadata in-path and large bodies out-of-band, but storage and lifecycle still affect cost, audit, and product UX.

Current options:
- Store in Postgres only
- Store large bodies in object storage with DB references
- Tier by size and retention class

Recommended bias:
- Prefer DB metadata plus object-storage bodies with retention classes.

## Exit Rule

Remove an item from this file when:

1. the decision is made,
2. the canonical answer is written into the relevant document under `docs/tech/agents/`, and
3. the old open question is no longer needed as a separate tracker.
