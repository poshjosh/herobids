# ADR 012: Capability-Scoped LLM Surface

**Date:** 2026-09-19
**Status:** Accepted

## Context

Some herobids LLM components carry trading concepts: base-skill read tools, the
hybrid evaluator and its sizing preference, and preset assessment. The legal and
architecture boundary is that traderton owns trading execution and enforcement,
while herobids may host generic agent reasoning that consumes a capability.

## Decision

The confirmed legal/compliance interpretation accepts the following boundary:

1. `get_risk_limits` and `get_account_summary` leave the base skill and are
   assigned only through trading-appropriate skills.
2. The hybrid evaluator and its sizing preference remain platform-side. They are
   non-binding intent; traderton remains the sole validator, clamp, and executor.
3. Preset assessment remains a platform product feature. Its data-model and
   blueprint edges are deferred to B4.

## Consequences

- Non-trading agents no longer receive irrelevant trading-account tools.
- No trading enforcement, risk-gate calculations, or execution authority returns
  to herobids.
- B4 may now decide where assessment, wake, and blueprint identity data belongs.

## References

- Decision brief: `docs/features/2026/09/18/001-trading-extraction-completion/decisions/B3-llm-surface-placement.md`
- B4 brief: `docs/features/2026/09/18/001-trading-extraction-completion/decisions/B4-assessment-wake-blueprint-edges.md`