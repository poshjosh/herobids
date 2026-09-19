# ADR 011: Split Trading Authority by Responsibility

**Date:** 2026-09-19
**Status:** Accepted

## Context

The extraction left deliberate byte-for-byte copies in herobids and traderton:
operator risk defaults, risk-contract math, strategy-preset catalogs, and
watch/scan/gate type layers. Treating every copy as shared authority would let
the repositories drift. Removing every copy would discard useful boundary
contracts and platform product data.

ADR 010 places enforcement inputs in a traderton-owned trading profile. This
settles the authority of the enforcement-related duplicates but not every
identical file.

## Decision

Authority is split by responsibility:

1. Traderton is the sole authority for operator risk defaults and risk-contract
   math. Herobids consumes typed boundary reads and boundary validation errors;
   it does not enforce local copies.
2. Wire DTO mirrors remain in both repositories as boundary contracts. They are
   protected by file-level parity-drift checks rather than treated as competing
   business authorities.
3. Strategy-preset catalogs remain mirrored and parity-checked until B4 settles
   their product-data authority.
4. A combined monorepo or generated shared package is rejected as disproportionate
   to the independent deployment model.

## Consequences

- C2.1 moves the risk-default read source to traderton after C1 establishes the
  profile boundary.
- C2.2 retires herobids risk-contract math once C1 removes its final consumer.
- C2.3 adds parity-drift checks for deliberate mirrors.
- B4 remains the only open authority decision for the preset catalogs.

## References

- Decision brief: `docs/features/2026/09/18/001-trading-extraction-completion/decisions/B2-duplicated-authority.md`
- ADR 010: `010-traderton-owned-trading-profile.md`
- C2 plan: `docs/features/2026/09/18/001-trading-extraction-completion/plans/C2-config-single-sourcing.md`