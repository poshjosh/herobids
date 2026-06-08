# Phase 5d: Agents + Autonomous Tool Use

## Canonical Technical References

The technical source of truth for this workstream now lives in:

- [Runtime Boundary And Message Contract](../../../../tech/agents/runtime-boundary-and-message-contract.md)
- [Message Catalog](../../../../tech/agents/message-catalog.md)
- [Recovery And Replay](../../../../tech/agents/recovery-and-replay.md)
- [Tool Access And Sandboxing](../../../../tech/agents/tool-access-and-sandboxing.md)

This file is now the workstream plan rather than a second copy of the full contract.

## Objective

Freeze the agent runtime boundary before implementation so frontend, backend, and infrastructure work can all target one stable contract.

## Finalized Decisions

- The message envelope uses `initiatorType` and `initiatorId` for current message authorship, plus optional `originType` and `originId` for original flow provenance.
- User is the owner principal. Agent is the isolated reasoning runtime. Bot is a non-isolated platform actor unless a later design introduces a new runtime class.
- `agent.decision.submit` remains single-decision-only in v1.
- Lifecycle messages use `agent.lifecycle.*`.
- Replay after reconnect uses the hybrid model.
- `instance.context.snapshot` stays summary-first with bounded references or slices, not full raw windows.
- Artifact metadata is synchronous; large artifact bodies are asynchronous or out-of-band.
- The agent runtime uses a tool-mediated interface over a sandbox with open internet egress, but no raw secrets, no operator config, and no direct trading APIs.
- Code execution is intended to ship in the first agent release behind the strongest sandbox boundary we can support.

## Why This Still Matters Before Implementation

- Frontend work needs stable activity, decision-detail, and health-strip fields.
- Engine work needs a clear boundary between strategic intent and execution authority.
- Infrastructure work needs a clear statement of what isolation protects and what the runtime may reach directly.

## Remaining Workstream Tasks

1. Keep the canonical docs current as implementation details are chosen.
2. Resolve the smaller remaining open questions in [003-open-questions.md](./003-open-questions.md).
3. Use the canonical docs as the basis for frontend agent surfaces and backend protocol implementation.

## Deferred Implementation Areas

- exact runtime guardrails for open internet egress
- exact architecture boundary for first-release code execution
- detailed API and storage modeling for user, agent, and bot relationships
- artifact retention, storage backend, and retrieval UX
