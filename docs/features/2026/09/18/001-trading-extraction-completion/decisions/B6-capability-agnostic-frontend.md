# Decision Brief B6: Capability-agnostic frontend presentation

- **Question:** How can generic agent and connection surfaces present capability state without embedding trading-specific fields, formatters, or visual rules?
- **Status:** ✅ **RATIFIED (2026-09-19) as [ADR 014](../../../../tech/architecture/adrs/2026/09/014-capability-agnostic-frontend-presentation.md)** — capability and connection presentation is generic; C3 executes it in two phases.
- **Evidence:** agent list/detail/capability-page inspection; ADR 010; capability readiness contract.

## Decision

1. Generic agent list, card, and header surfaces display only agent lifecycle data and capability readiness. They do not display capability-specific metrics, configuration, or domain labels.
2. Capability data is reached through **capability → connection**. Static values are generic attributes; histories and decisions are capability-scoped feeds, not key/value rows.
3. Capability services supply display values and an optional semantic emphasis (`neutral`, `positive`, `negative`, or `warning`). The frontend maps emphasis to its own theme tokens; capability services never supply CSS or colors, and the frontend never infers domain meaning such as P&L sign.
4. Approvals remain a generic herobids lifecycle workflow. A capability-specific proposal or result is rendered inside the capability context.
5. C3a changes presentation while preserving the existing source temporarily. C3b switches to the profile-backed, typed capability contract after C1 and retires trading-specific frontend formatting.

## Consequences

- `executionMode`, `authorizationMode`, strategy, P&L, and trade history leave generic agent surfaces.
- The frontend can add another capability without a domain-specific card or formatter.
- C1 remains the data-source gate for C3b; it is not a prerequisite for C3a.

## References

- ADR 014: `docs/tech/architecture/adrs/2026/09/014-capability-agnostic-frontend-presentation.md`
- C3 plan: `../plans/C3-capability-agnostic-frontend.md`
- B1 / ADR 010: `B1-stored-trading-state.md`