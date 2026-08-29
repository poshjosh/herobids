# Phase Transitions

The six implementation phases as a gated progression. Each gate has explicit
acceptance criteria that must be verified before the next phase begins.

## Gate Progression

```mermaid
stateDiagram-v2
  direction LR

  state "Current State" as current
  state "Phase 2\nFoundations" as p2
  state "Phase 3\nResolution &\nRoute Migration" as p3
  state "Phase 4\nWorker Visibility\nEnforcement" as p4
  state "Phase 5\nTrading\nExtraction" as p5
  state "Phase 6\nMessaging\nExtraction" as p6
  state "Phase 7\nNaming\nCleanup" as p7
  state "Target State" as target

  [*] --> current
  current --> p2 : Start
  p2 --> p3 : Gate 1
  p3 --> p4 : Gate 2
  p4 --> p5 : Gate 3
  p5 --> p6 : Gate 4
  p6 --> p7 : Gate 5
  p7 --> target : Complete

  note right of current
    All tools in-process
    Skill-only visibility
    No registry or ownership
    No activation model
  end note

  note right of p2
    Registry + ownership + contract
    exist in packages/domain
    Zero runtime changes
  end note

  note right of p3
    Shared resolver exists
    Canonical routes live
    Legacy aliases declared
  end note

  note right of p4
    Visibility uses ownership
    + activation (two-key)
    CI enforces exhaustiveness
  end note

  note right of p5
    trading service
    deployed separately
    HMAC-signed invocations
  end note

  note right of p6
    messaging service
    deployed separately
    Provider lifecycle surfaced
  end note

  note right of p7
    Terminology aligned
    Legacy terms documented
    No behavior changes
  end note
```

## Gate Criteria Detail

```mermaid
flowchart TB
  subgraph "Gate 1: Foundations Complete"
    g1_registry[Shared registry exists<br/>and exports trading + messaging]
    g1_ownership[Exhaustive ownership manifest<br/>key set === KNOWN_AGENT_TOOL_NAMES]
    g1_contract[Cross-service contract types<br/>compile and are importable]
    g1_presets[Preset/role metadata<br/>conceptually separated from capabilities]
    g1_match[Registry + ownership match<br/>normative doc 009]
  end

  subgraph "Gate 2: Resolution Complete"
    g2_resolver[Shared capability resolver<br/>consumed by API surfaces]
    g2_routes[Canonical route IDs exist<br/>/capabilities/trading<br/>/capabilities/messaging]
    g2_aliases[Route alias policy explicit<br/>/capabilities/trading is declared alias]
    g2_lifecycle[Provider lifecycle enrichment<br/>distinct from service health and readiness]
    g2_activation[Activation follows doc 010<br/>routes follow doc 011]
  end

  subgraph "Gate 3: Worker Gating Complete"
    g3_ownership_vis[Visibility uses ownership<br/>+ activation — not skill alone]
    g3_send_message[send_message available<br/>through implicit messaging rule]
    g3_ci[CI validates ownership<br/>exhaustiveness on every push]
    g3_activation_src[Activation resolved from<br/>durable DB source only]
  end

  subgraph "Gate 4: Trading Extracted"
    g4_invocation[All trading tools<br/>invoke through stable abstraction]
    g4_security[Auth, idempotency, deadlines,<br/>typed failures are real]
    g4_authority[Trading-instance authority<br/>preserved behind service]
    g4_complete[Every trading-owned tool in doc 009<br/>executes through service —<br/>no partial slice]
  end

  subgraph "Gate 5: Messaging Extracted"
    g5_service[send_message + send_email<br/>run through messaging service]
    g5_lifecycle[Provider lifecycle + health<br/>visible in capability APIs and UI]
    g5_presets[Preset handling aligned —<br/>personal-assistant is not a capability]
    g5_contract[Service boundary follows<br/>doc 008 with no in-process fallback]
  end

  g1_registry --> g2_resolver
  g1_ownership --> g2_resolver
  g1_contract --> g2_resolver
  g2_resolver --> g3_ownership_vis
  g2_routes --> g3_ownership_vis
  g3_ownership_vis --> g4_invocation
  g3_ci --> g4_invocation
  g4_invocation --> g5_service
  g4_security --> g5_service
```

## What Exists At Each Phase

| Phase | packages/domain | apps/worker | apps/api | apps/trading | apps/messaging | DB |
|-------|----------------|-------------|----------|--------------------|-----------------|----|
| Current | tools.ts, skills.ts | All tools in-process, skill visibility | /capabilities/trading (hardcoded) | - | - | No activation table |
| After Phase 2 | + registry, ownership, contract | Unchanged | Unchanged | - | - | Unchanged |
| After Phase 3 | Unchanged | Unchanged | + canonical routes, resolver, aliases | - | - | + agent_capability_activations |
| After Phase 4 | Unchanged | Visibility predicate uses ownership + activation | Unchanged | - | - | Unchanged |
| After Phase 5 | Unchanged | Invocation client for trading tools | Unchanged | Deployed, handling all trading tools | - | + capability_tool_invocations |
| After Phase 6 | Unchanged | Invocation client for messaging tools | Unchanged | Unchanged | Deployed, handling messaging tools | Unchanged |
| After Phase 7 | Terminology cleanup | Comment/name cleanup | Unchanged | Unchanged | Unchanged | Unchanged |

## Risk At Each Transition

| Transition | Risk level | Primary risk | Mitigation |
|------------|-----------|--------------|------------|
| Current → Phase 2 | Low | Manifest drift from actual tool names | CI test: ownership keys === KNOWN_AGENT_TOOL_NAMES |
| Phase 2 → Phase 3 | Low-Medium | Route migration breaks web client | Strangler-fig: canonical + alias, move callers, then remove |
| Phase 3 → Phase 4 | Medium | Visibility change hides tools from live agents | Data migration enables activation for existing trading agents |
| Phase 4 → Phase 5 | High | Network boundary introduces latency, failure modes | Shadow period: run both paths, compare results, switch after match |
| Phase 5 → Phase 6 | Medium | Messaging implicit rules are subtle | Explicit test for send_message without activation row |
| Phase 6 → Phase 7 | Low | Rename breaks internal references | Grep-verified terminology inventory, no behavior changes |

## Timeline Shape

```mermaid
gantt
  title Phase Duration Estimate (Relative)
  dateFormat X
  axisFormat %s

  section Metadata
    Phase 2 — Foundations         :p2, 0, 1
    Phase 3 — Resolution & Routes :p3, 1, 3

  section Behavior
    Phase 4 — Worker Gating       :p4, 3, 5

  section Extraction
    Phase 5 — Trading             :crit, p5, 5, 9
    Phase 6 — Messaging           :p6, 9, 12

  section Cleanup
    Phase 7 — Naming              :p7, 12, 13
```

Phase 5 is the critical path. It introduces the first real network boundary,
requires idempotency verification under load, and touches every trading tool.
Plan accordingly.
