# ADR 004: Blueprint Marketplace Ranking And Attribution

**Date:** 2026-08-01
**Status:** Accepted

## Context

Skills already have publication lifecycle, likes, forks, usage events, and popularity or trending scores. Blueprints do not yet have equivalent marketplace mechanics.

The marketplace needs a practical v1 model for lineage, ranking, and attribution, but the current agent evaluation system is too sparse and session-oriented to serve as the primary public ranking signal.

## Decision

**Blueprint ranking and attribution reuse the proven skills-marketplace pattern for v1.**

Specifically:

1. Blueprint marketplace mechanics reuse the broad skills pattern for lifecycle, likes, forks, usage events, and ranking.
2. Blueprint lineage is explicit through source or fork relationships.
3. Runtime instances created from a blueprint retain blueprint attribution.
4. Evaluation-derived quality signals are deferred as secondary enrichment and are not a prerequisite for v1 ranking.
5. Paid entitlements are deferred out of the v1 ranking and attribution model.
6. V1 ranking must be implementable from usage, likes, forks, and lineage without depending on sparse manual evaluation data.

## Rationale

1. The skills subsystem already proves the minimum viable marketplace mechanics needed here.
2. Lineage and attribution are foundational for later analytics, reputation, and monetization.
3. The current evaluation dataset is too sparse and irregular to serve as the base public score.
4. Deferring monetization avoids coupling the blueprint asset model to billing before the core behavior is stable.

## Consequences

### Positive

1. The marketplace can ship using already proven patterns from the skills subsystem.
2. Lineage, popularity, and usage can exist before more advanced reputation systems are built.
3. Runtime attribution creates a stable path for later analytics and quality enrichment.

### Negative

1. Blueprint ranking will initially be weaker than a mature review or reputation system.
2. Some duplication between skills and blueprints may remain until Phase 1 proves what should be extracted.

## Follow-Up Rules

1. Blueprint ranking in v1 must not depend on sparse one-off evaluation runs.
2. Agent and bot instantiation flows must persist blueprint attribution.
3. Any later public quality model must enrich, not replace, the base usage and lineage signals.
