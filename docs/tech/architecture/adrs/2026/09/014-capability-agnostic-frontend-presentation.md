# ADR 014: Capability-Agnostic Frontend Presentation

**Date:** 2026-09-19
**Status:** Accepted

## Context

The agent UI currently renders trading-specific state on generic surfaces:
execution mode, authorization mode, strategy, P&L, and trade history. It also
formats P&L and infers positive or negative visual treatment in the frontend.
That prevents the platform from presenting trading as one capability among many.

## Decision

1. Generic agent surfaces show only lifecycle data and generic capability
   readiness. Capability-specific configuration, metrics, and history are
   reached through capability then connection.
2. Static capability state uses generic attributes. Capability histories,
   decisions, and trade-like records use capability-scoped feeds.
3. Capability services provide display values and optional semantic emphasis
   (`neutral`, `positive`, `negative`, or `warning`). The frontend maps that
   emphasis to its own theme tokens. It neither receives CSS/colors nor derives
   domain semantics from raw values.
4. Approvals remain a generic platform workflow. Capability-specific proposal
   details appear in their capability context.
5. C3a may change only presentation before C1. C3b moves to the profile-backed
   generic capability contract after C1 and removes trading-specific formatters.

## Consequences

- The UI can host additional capability families without specialized overview
  cards or number formatters.
- `formatPnl`, `pnlColor`, and direct trading-specific rendering are retired in
  C3b, not hidden behind a new generic component.
- C1 remains responsible for the trading-profile source of truth; this ADR does
  not change storage ownership.

## References

- Decision brief: `docs/features/2026/09/18/001-trading-extraction-completion/decisions/B6-capability-agnostic-frontend.md`
- C3 plan: `docs/features/2026/09/18/001-trading-extraction-completion/plans/C3-capability-agnostic-frontend.md`
- ADR 010: `010-traderton-owned-trading-profile.md`