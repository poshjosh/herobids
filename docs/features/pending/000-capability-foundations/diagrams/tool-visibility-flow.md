# Tool Visibility Flow

How a tool becomes visible to the LLM — current state vs. target state.

## Current State: Skill-Only Visibility

```mermaid
flowchart LR
  subgraph Inputs
    skills[Resolved Skills]
    budget[maxVisibleToolSchemas budget]
    degradation[Dependency Degradation<br/>database / market-data]
    circuit[Circuit Breaker<br/>per-tool blocks]
    permanent[Permanent Exclusions<br/>hardcoded set]
  end

  subgraph Visibility Controller
    snapshot[Snapshot baseline<br/>requiredTools per skill]
    filter[Apply exclusions:<br/>permanent + degraded + circuit]
    collect[Collect visible set<br/>union of all skill.requiredTools<br/>capped by budget]
  end

  subgraph Output
    visible_set[Visible Tool Set]
    llm[LLM sees tools]
  end

  skills --> snapshot
  snapshot --> filter
  degradation --> filter
  circuit --> filter
  permanent --> filter
  filter --> collect
  budget --> collect
  collect --> visible_set
  visible_set --> llm

  style skills fill:#e3f2fd
  style visible_set fill:#c8e6c9
  style llm fill:#c8e6c9
```

### What's missing

- No ownership check — any skill can expose any tool
- No capability activation check — a trading skill exposes trading tools
  even if the trading external backend is not registered or dispatchable
- No backend health check — tools appear visible even if the backing
  external backend is unreachable
- No readiness check at visibility time — readiness is checked at call
  time only, so the LLM may attempt tools it cannot use

---

## Target State: Ownership + Activation + Backend Dispatchability Visibility Predicate

```mermaid
flowchart LR
  subgraph Inputs
    skills[Resolved Skills]
    budget[maxVisibleToolSchemas budget]
    ownership[Tool Ownership Manifest<br/>core / general / native-capability / external-backend]
    activation[Native Activation Rows<br/>agent_capability_activations table]
    backend_state[External Backend State<br/>registration + entitlement + health + readiness]
    readiness[Runtime Binding Readiness<br/>connection + provider state]
    session[Session Mode + Platform Rules<br/>implicit messaging rule]
    degradation[Dependency Degradation]
    circuit[Circuit Breaker]
  end

  subgraph Visibility Predicate
    known{Known tool?}
    requested{Requested by<br/>baseline or skill?}
    owner_check{Owner type?}
    core_general[Core / General:<br/>pass]
    native_active{Native capability<br/>activated?}
    backend_dispatch{External backend<br/>dispatchable?}
    readiness_check{Tool-specific<br/>readiness OK?}
    health_check{Backend or<br/>platform healthy?}
    policy{Runtime policy<br/>or degradation<br/>excludes?}
    visible_yes[VISIBLE]
    visible_no[HIDDEN]
  end

  subgraph Output
    visible_set[Visible Tool Set]
    llm[LLM sees tools]
  end

  skills --> requested
  ownership --> owner_check
  activation --> native_active
  backend_state --> backend_dispatch
  readiness --> readiness_check
  session --> native_active
  degradation --> policy
  circuit --> policy

  known -->|no| visible_no
  known -->|yes| requested
  requested -->|no| visible_no
  requested -->|yes| owner_check
  owner_check -->|core/general| readiness_check
  owner_check -->|native capability| native_active
  owner_check -->|external backend| backend_dispatch
  native_active -->|inactive| visible_no
  native_active -->|active| readiness_check
  backend_dispatch -->|not dispatchable| visible_no
  backend_dispatch -->|dispatchable| readiness_check
  readiness_check -->|not ready| visible_no
  readiness_check -->|ready| health_check
  health_check -->|unhealthy| visible_no
  health_check -->|healthy| policy
  policy -->|excluded| visible_no
  policy -->|allowed| visible_yes

  visible_yes --> visible_set
  budget --> visible_set
  visible_set --> llm

  style skills fill:#e3f2fd
  style ownership fill:#fff3e0
  style activation fill:#fff3e0
  style backend_state fill:#fff3e0
  style visible_set fill:#c8e6c9
  style llm fill:#c8e6c9
  style visible_no fill:#ffcdd2
```

### The two-key model

Neither key alone is sufficient. Native capabilities and external backends use
different owner-state checks:

| Condition | Visible? |
|-----------|----------|
| Skill requests tool + native capability active + ready + healthy | Yes |
| Skill requests tool + native capability NOT active | No |
| Skill requests tool + external backend dispatchable + ready + healthy | Yes |
| Skill requests tool + external backend NOT dispatchable | No |
| Owner state satisfied + tool NOT requested by any skill | No |
| Owner state satisfied + skill requests + backend unhealthy | No |

### Special cases

- **`send_message`** — native messaging-owned but implicitly active through the
  platform-inbox rule. Does not require an explicit activation row.
- **`send_email`** — requires explicit native messaging activation AND a ready
  email binding (connection + provider).
- **External trading tools** — do not use native activation rows. They require
  external-backend registration, entitlement, health, and readiness.
- **Core/general tools** — skip the native activation, external-backend
  dispatchability, and service health checks. They execute in-process in Agent
  Core.

---

## Comparison Summary

| Aspect | Current | Target |
|--------|---------|--------|
| Inputs to visibility | Skills + degradation + circuit | Skills + ownership + native activation + external-backend dispatchability + readiness + health + policy |
| Ownership awareness | None | Exhaustive manifest, CI-enforced |
| Native activation gating | None | Durable DB row per agent per native capability |
| External backend gating | None | Registration + entitlement + health + readiness |
| Service health gating | None | Per-external-backend /health/ready; native capabilities use platform health |
| Implicit rules | None | Platform-inbox rule for send_message |
| Failure mode | Tool visible but call fails at runtime | Tool hidden if it cannot succeed |
| Where logic lives | `runtime-tool-visibility.ts` | Shared visibility predicate consuming domain types |
