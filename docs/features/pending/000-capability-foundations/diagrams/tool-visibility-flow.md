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
  even if trading is not activated for the agent
- No service health check — tools appear visible even if the backing
  service is unreachable
- No readiness check at visibility time — readiness is checked at call
  time only, so the LLM may attempt tools it cannot use

---

## Target State: Ownership + Activation Visibility Predicate

```mermaid
flowchart LR
  subgraph Inputs
    skills[Resolved Skills]
    budget[maxVisibleToolSchemas budget]
    ownership[Tool Ownership Manifest<br/>core / general / capability-owned]
    activation[Activation Rows<br/>agent_capability_activations table]
    readiness[Runtime Binding Readiness<br/>connection + provider state]
    health[Capability Service Health<br/>/health/ready per service]
    session[Session Mode + Platform Rules<br/>implicit messaging rule]
    degradation[Dependency Degradation]
    circuit[Circuit Breaker]
  end

  subgraph Visibility Predicate
    known{Known tool?}
    requested{Requested by<br/>baseline or skill?}
    owner_check{Owner type?}
    core_general[Core / General:<br/>pass]
    cap_active{Capability<br/>activated?}
    readiness_check{Tool-specific<br/>readiness OK?}
    health_check{Service<br/>healthy?}
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
  activation --> cap_active
  readiness --> readiness_check
  health --> health_check
  session --> cap_active
  degradation --> policy
  circuit --> policy

  known -->|no| visible_no
  known -->|yes| requested
  requested -->|no| visible_no
  requested -->|yes| owner_check
  owner_check -->|core/general| readiness_check
  owner_check -->|capability| cap_active
  cap_active -->|inactive| visible_no
  cap_active -->|active| readiness_check
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
  style health fill:#fff3e0
  style visible_set fill:#c8e6c9
  style llm fill:#c8e6c9
  style visible_no fill:#ffcdd2
```

### The two-key model

Neither key alone is sufficient:

| Condition | Visible? |
|-----------|----------|
| Skill requests tool + capability active + ready + healthy | Yes |
| Skill requests tool + capability NOT active | No |
| Capability active + tool NOT requested by any skill | No |
| Capability active + skill requests + service unhealthy | No |

### Special cases

- **`send_message`** — messaging-owned but implicitly active through the
  platform-inbox rule. Does not require an explicit activation row.
- **`send_email`** — requires explicit messaging activation AND a ready
  email binding (connection + provider).
- **Core/general tools** — skip the capability activation and service health
  checks. They execute in-process in Agent Core.

---

## Comparison Summary

| Aspect | Current | Target |
|--------|---------|--------|
| Inputs to visibility | Skills + degradation + circuit | Skills + ownership + activation + readiness + health + policy |
| Ownership awareness | None | Exhaustive manifest, CI-enforced |
| Activation gating | None | Durable DB row per agent per capability |
| Service health gating | None | Per-capability /health/ready |
| Implicit rules | None | Platform-inbox rule for send_message |
| Failure mode | Tool visible but call fails at runtime | Tool hidden if it cannot succeed |
| Where logic lives | `runtime-tool-visibility.ts` | Shared visibility predicate consuming domain types |
