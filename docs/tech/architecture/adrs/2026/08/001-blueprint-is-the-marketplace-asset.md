# ADR 001: Blueprint Is The Marketplace Asset

**Date:** 2026-08-01
**Status:** Accepted

## Context

The current platform has reusable skills with marketplace mechanics, but blueprints are still narrow bot configuration templates. Agents themselves are mutable runtime rows that mix shareable configuration, private bindings, and runtime state.

The marketplace feature needs one installable asset that can be ranked, forked, published, and attributed without leaking private state or depending on mutable runtime records.

## Decision

**Blueprint is the canonical marketplace asset.**

Specifically:

1. Blueprints, not live agent rows, are the unit that users browse, publish, fork, rank, and install.
2. Live agents and bots are runtime instances created from a blueprint plus private instance inputs.
3. The existing `blueprints` concept is retained and expanded in place.
4. The system must not introduce a parallel `agent_template`, `bot_template`, or equivalent marketplace template entity for this feature.
5. Any later public evidence derived from live agents or bots enriches blueprint discovery and attribution; it does not replace the blueprint as the marketplace unit.

## Rationale

1. A marketplace needs one stable installable artifact rather than mutable runtime rows.
2. Agent rows mix shareable configuration, private bindings, and runtime state, so they are the wrong publication surface.
3. The repo already has blueprint identity and bot attribution surfaces, making blueprint expansion cleaner than introducing a second template model.
4. A single marketplace asset simplifies ranking, lineage, attribution, purchase, and copy semantics.

## Consequences

### Positive

1. The marketplace gets one stable and installable artifact.
2. Attribution, ranking, and lineage can point at a durable template object.
3. Agent and bot creation can share a common template mental model.
4. The product avoids publishing mutable runtime rows as if they were clean templates.

### Negative

1. Blueprint scope expands well beyond its current bot-only shape.
2. Existing blueprint APIs and schemas will need a clean redesign rather than small extensions.
3. Some agent-facing UX will need explicit save-as-blueprint or use-blueprint flows instead of treating the agent row itself as publishable.

## Follow-Up Rules

1. New marketplace docs must describe the blueprint as the installable asset.
2. Implementation work must not introduce a parallel `agent_template` concept unless this ADR is replaced.
3. Live agent reputation or evidence, if added later, must enrich blueprint discovery rather than replace the blueprint as the marketplace unit.
