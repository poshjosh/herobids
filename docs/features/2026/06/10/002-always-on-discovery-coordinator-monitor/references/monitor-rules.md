# Monitor Rules

Define what the `MarketMonitor` evaluates, what counts as a trigger, and how monitor state resets.

This document covers:
- rule families in v1
- trigger conditions
- edge-trigger semantics
- cooldowns and reset behavior
- which rule families belong later rather than in v1

The monitor observes state and emits facts. It does not decide whether to trade.

---

## Background

The coordinator gives the system shared market state.
The monitor turns that state into meaningful events.

Without explicit rule definitions, implementation will drift in three bad ways:

1. different sessions will emit different events for the same condition
2. the same condition will retrigger too often
3. monitor scope will grow into implicit strategy logic

This document prevents that drift by making the monitor rule layer explicit.

---

## Scope

### In scope

- v1 rule families
- trigger criteria
- reset criteria
- edge-trigger semantics
- cooldown recommendations
- rule-family expansion order

### Out of scope

- transport details for events and wakes
- shared-state Redis key layout
- strategy-specific trade policy

---

## Design Principles

1. A monitor rule detects state change, not “good trade.”
2. Triggers should be edge-based where possible.
3. Every rule must define both trigger and reset behavior.
4. Cooldowns prevent repeated noise from creating duplicate work.
5. v1 should start narrow and obvious, not ambitious and fuzzy.

---

## Rule Taxonomy

### v1 rule families

1. Price watch thresholds
2. Discovery delta events
3. Regime change events

### Later rule families

4. Venue intelligence deltas
5. Portfolio or position guardrail monitor events
6. Cross-signal composite opportunities
7. News or social-sentiment driven events

v1 should not include composite “trade setup” rules. Those are too close to strategy.

---

## Rule Family 1 — Price Watch Thresholds

### Purpose

Detect when a user- or agent-defined watch crosses a price boundary.

Current source of truth:
- watch definitions created through `watch_token` in `apps/worker/src/tools/watch.ts`

### Inputs

- `watchId`
- `symbol`
- `chain`
- `thresholdPrice`
- `condition`: `above | below`
- `lastConditionMet`
- latest price data

### Trigger

A watch triggers only when:

- previous condition state was `false`
- current condition state is `true`

Initial creation with condition already true does not count as a trigger.

### Reset

The watch becomes eligible to trigger again only after:

- current condition state returns to `false`

### Cooldown

No extra time-based cooldown is required beyond edge-trigger semantics for plain threshold watches.
The edge state itself is the primary suppression mechanism.

### Notes

- if price is unavailable, do not trigger
- record evaluation failure separately from rule trigger state
- if stale price is allowed, the emitted event must mark `stale: true`

---

## Rule Family 2 — Discovery Delta Events

### Purpose

Detect newly meaningful discovery outcomes from shared market snapshots.

This lets the platform surface changes such as:
- token entered the top N set
- token is newly surfaced after an anti-staleness cooldown
- token now appears in multiple discovery vectors

### Inputs

- previous shared discovery snapshot
- current shared discovery snapshot
- anti-staleness state

### v1 trigger types

Recommended v1 reasons:

1. `entered_top_set`
   Token was not in the previous top set and is now in the current top set.

2. `reappeared_after_cooldown`
   Token was previously seen, but its anti-staleness cooldown expired and it is newly important again.

3. `multi_vector_confirmation`
   Token moved from one discovery vector to two or more meaningful vectors.

### Trigger

A discovery delta triggers when one of the above reasons becomes true between snapshots.

### Reset

Reset depends on the reason:

- `entered_top_set`
  Reset when the token leaves the top set.

- `reappeared_after_cooldown`
  Reset automatically after the new cooldown window begins.

- `multi_vector_confirmation`
  Reset when the vector count drops below the threshold.

### Cooldown

Discovery events need explicit time-window suppression even with delta logic.

Recommended v1 cooldowns:
- `entered_top_set`: 10 minutes
- `reappeared_after_cooldown`: same as discovery anti-staleness cooldown window start
- `multi_vector_confirmation`: 10 minutes

### Notes

- do not emit repeated discovery events every poll while the token remains present
- discovery rules should stay descriptive, not predictive
- the monitor should not infer “buy now” from discovery presence alone

---

## Rule Family 3 — Regime Change Events

### Purpose

Detect meaningful flips in shared regime state so agents can react earlier than their next normal tick.

### Inputs

- previous regime snapshot for a benchmark symbol
- current regime snapshot for the same benchmark symbol

### v1 trigger types

Recommended v1 reasons:

1. `favorable_to_unfavorable`
2. `unfavorable_to_favorable`
3. `trend_strength_lost`
4. `trend_strength_recovered`

### Trigger

Emit when the regime classification materially changes.

Examples:
- `pass: true -> false`
- EMA alignment flips bullish to bearish
- ADX crosses below configured threshold after being above it

### Reset

Reset when the regime returns to the opposite meaningful state.

This is naturally edge-triggered because the previous and current states differ.

### Cooldown

Recommended v1 cooldown:
- 5 minutes per benchmark symbol per change direction

Rationale:
- regime can flap in choppy conditions
- agents should hear about the flip quickly, but not every few seconds

### Notes

- v1 should restrict regime monitoring to a small set of benchmark symbols
- regime rules should use shared snapshots, not recompute from scratch per subscriber

---

## Edge-Trigger Semantics

All v1 rule families should behave as edge-trigger rules.

Edge-trigger means:
- emit on transition into the monitored state
- do not emit repeatedly while the state remains true
- only become eligible again after a reset condition occurs

This matters because “level-trigger” behavior is what causes repeated event spam in continuous polling systems.

---

## Cooldowns And Reset Behavior

Rules need both.

### Why reset alone is not enough

For watches, reset alone is often enough.
For discovery and regime, reset alone is too weak because those states can flap or remain relevant across many polls.

### Why cooldown alone is not enough

Cooldown without reset can suppress a legitimate second crossing or meaningful state flip.

### v1 policy

- threshold watches: edge reset required, no extra cooldown by default
- discovery deltas: edge reset plus cooldown
- regime changes: edge reset plus cooldown

---

## Evaluation Order

Within each monitor cycle:

1. load latest shared state
2. evaluate threshold watches
3. evaluate discovery deltas
4. evaluate regime changes
5. collect triggered monitor events
6. apply dedupe and cooldown suppression
7. publish durable events
8. request coalesced wakeup if needed

This order is recommended because threshold watches are user-explicit and should win priority over broader market-intelligence rules.

---

## Failure Semantics

If rule evaluation cannot complete because source state is unavailable:
- do not emit a trigger
- record a monitor evaluation failure
- keep prior rule state intact unless the source was explicitly invalidated

If only one rule family fails:
- continue evaluating the others

The monitor should fail soft where possible.

---

## v1 Versus Later Monitor Classes

### v1

Must include:
- price threshold watches
- discovery delta events
- regime change events

Should not include:
- funding-rate anomaly triggers
- liquidation cluster triggers
- composite “momentum plus liquidity plus regime” trade opportunities
- social or news triggers

### Later

Suitable later rule families:

1. Venue intelligence deltas
   Examples: funding spike, open-interest jump, liquidation surge.

2. Portfolio/position monitors
   Examples: unrealized P&L drawdown crossing, holding duration anomaly.

3. Composite opportunity detectors
   Examples: token entered top set and regime is favorable and liquidity exceeds threshold.

4. External signal monitors
   Examples: sentiment, news, or social signal changes.

These later rule families should only land after the base eventing path has proven stable.

---

## Acceptance For Rule Layer

The monitor rule layer is correct when:

1. a watch crossing emits once per crossing, not once per poll
2. a token entering the top set emits once per relevant discovery window
3. regime flips emit once per meaningful change direction with cooldown protection
4. repeated steady-state conditions do not create repeated events
5. reset conditions make future triggers possible again
6. rules remain descriptive and do not collapse into hidden strategy policy

That gives a monitor system that is useful, stable, and still agent-led.