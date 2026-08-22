# ADR 003: Single-Container Agent Code Execution

Status: Accepted
Date: 2026-06-02

## Context

Step 6 ships code execution in the first agent release.

The platform already decided that each agent runtime should run in its own isolated container and that agent crashes must not affect other agents or core services.

The remaining implementation question was whether v1 should add a second dedicated code-execution container or service boundary.

The preferred shape is the simplest one that preserves isolation, keeps limits configurable, and matches the proven aitradingbot pattern without copying its looser privilege model.

## Decision

Use one separate container per agent runtime, and run code execution inside that same container as a restricted local subprocess or sandbox.

Specifically:

- do not add a second code-execution container or separate code-execution service in v1
- code execution runs only behind an explicit capability grant
- code execution uses bounded temporary storage, process count, wall-clock limits, output limits, and cleanup behavior
- limits remain configuration-driven with conservative defaults
- the runtime still receives no raw venue credentials, no direct database writes, and no host-level control

## Consequences

- v1 stays operationally simple and matches the already chosen one-agent-one-container model
- crashes and kill events remain isolated to the affected agent container
- this is weaker isolation than a separate execution service, so hard sandbox limits and fail-closed policy enforcement remain mandatory
- the message and execution boundary stay unchanged because the trading instance still owns all market-affecting actions
- if future pressure justifies stronger isolation, the platform can move code execution to a stricter sidecar or separate service without changing the agent protocol