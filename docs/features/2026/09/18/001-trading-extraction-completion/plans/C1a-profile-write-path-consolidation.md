# Plan C1a: Trading-profile write-path consolidation

- **Task:** C1a — implement ADR 013's single normalization and snapshot-builder choke point before C1 adds profile write-through.
- **Repo:** herobids
- **Status:** **REVIEW-CORRECTED; PENDING IMPLEMENTATION AUTHORIZATION** — this is C1's required Herobids preparation; it does not authorize implementation.
- **Prereq:** ADR 013; independent review complete.

## Goal

Every workflow that creates, updates, binds, unbinds, deletes, or instantiates
a trading-capable agent must derive the same per-connection profile snapshots
and one selected execution binding. C1 supplies the boundary writer; C1a
deliberately supplies no temporary trading store or fallback.

## Source paths to consolidate

Inventory and route all of these through the shared helper. Re-run the static
sweep during implementation because their callers may change:

1. `POST /agents` and `PATCH /agents/:id` in `apps/api/src/routes/agents.ts`.
2. Agent interactivity updates in `apps/api/src/routes/agent-interactivity.ts`.
3. Chat `create_agent` in `apps/api/src/routes/chat.ts`.
4. Blueprint and go-live creation through
   `apps/api/src/services/agent-instantiation-service.ts`.
5. Declarative `connectionIds` changes and imperative grant/revoke operations
   in `apps/api/src/routes/agents.ts` and
   `apps/api/src/services/agent-config-service.ts`.

## Design

1. Add a pure `buildTradingProfileSnapshots` helper in the API agent-config
   layer. Given effective agent configuration and resolved trading connections,
   it returns a complete `TradingProfileConfiguration` for each venue account:
   `{ actorId, venueAccountId, capital, riskPosture, executionDefaults }`.
   `riskOverrides` are Traderton-owned runtime state and are intentionally not
   included in a Herobids configuration replacement.
2. Add a pure `selectExecutionBinding` helper. It preserves the existing
   default-ready-connection, then first-ready-connection rule. An agent may have
   multiple active trading bindings and profiles, but only this selected binding
   is supplied to one running direct-trading actor.
3. Add a pure `planTradingProfileReconciliation` helper. Given prior and
   proposed agent configuration plus bindings, it returns ordered full-snapshot
   upserts, exact clears, the selected-binding transition, and inverse actions.
   It must distinguish a removed connection from an absent active snapshot.
4. The helpers reuse existing canonical schemas and execution/connection
   validation. They preserve current nullable-field semantics and do not add
   capital or risk policy.
5. Require every source path above to use the planner. Until C1 lands, its
   result is test-only; C1 injects the writer at this one choke point. C1a makes
   no boundary call and creates no second trading store.
6. Keep public route shapes unchanged. The goal is one internal calculation,
   not one endpoint or a broad route refactor.

## Verification

- Unit tests: each source path yields identical snapshots, selected binding, and
   inverse plan for equivalent agent, skill, risk, execution, and connection
   inputs. Cover a default binding, first-ready fallback, binding removal, and
   agent deletion.
- Route tests: create, PATCH, interactivity, chat, blueprint/go-live, delete,
   and both connection grant/revoke routes all call the planner.
- Static sweep: no remaining direct construction of a profile-shaped snapshot
   or selected-execution calculation outside the helpers and tests.
- Existing creation/update validation and connection lifecycle tests still pass.

## Handoff to C1

C1 builds the boundary tools first, injects its durable change writer into this
planner, and persists only operation metadata in the Herobids outbox. C1a and
C1 may be one coordinated implementation run, but C1a's helpers and tests land
before any Herobids profile write-through is enabled.

## References

- ADR 013: `docs/tech/architecture/adrs/2026/09/013-consolidate-trading-profile-write-paths.md`
- C1: `C1-trading-profile-slice.md`
- Existing create normalization: `apps/api/src/agents/agent-create-normalization.ts`