# Plan: One-Field Provider Taxonomy Unification

**Status:** Proposed — not yet implemented  
**Date:** 2026-07-17  
**Related work:** [006-remove-unused-provider-table-and-gmail-readonly-scope](../../2026/07/17/006-remove-unused-provider-table-and-gmail-readonly-scope/001-plan.md)

---

## Summary

Unify provider classification around a single stored taxonomy field, using
hierarchical taxonomy paths such as:

- `trading/crypto/orderbook`
- `trading/crypto/swap`
- `messaging/email`

This plan removes the conceptual split between:

- API/catalog `categories`
- DB-only `capabilities`
- runtime `families`

The end state is:

1. providers store only one classification field
2. the field uses hierarchical taxonomy paths
3. runtime connection matching derives broader matches from those paths instead
   of storing a second concept

This is a medium refactor. It is larger than the immediate Gmail/provider-table
cleanup because it changes the runtime connection-matching contract, not just
the provider metadata source.

---

## Motivation

### Current problems

Today, three overlapping concepts exist:

- `categories` in the provider catalog, mainly for product/UI classification
- `capabilities` in the DB provider table, mainly for connection-family lookup
- runtime `families` in skills and binding resolution, such as `trading` and
  `email`

This has several costs:

- multiple vocabularies for nearly the same concern
- drift between code and database metadata
- special-case mapping like `messaging` -> `email`
- no clean path to future provider classes such as non-crypto trading

If we expect future support for things like gold, equities, or other
non-crypto trading providers, the taxonomy should encode asset class and
execution shape explicitly now rather than rely on implied assumptions.

### Why a hierarchical taxonomy

The taxonomy should capture three kinds of meaning in one path:

- domain: `trading`, `messaging`
- asset or modality class: `crypto`, `email`, `commodities`
- execution or provider shape: `orderbook`, `swap`, and later others if needed

Examples:

- `trading/crypto/orderbook`
- `trading/crypto/swap`
- `messaging/email`

This gives one vocabulary that can serve both catalog display and runtime
matching.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Stored classification field | Reuse `categories` as the single stored field | Minimizes rename churn while still allowing semantic unification. |
| Value shape | Store hierarchical taxonomy paths in `categories` | One field, one vocabulary, future-proof for non-crypto trading types. |
| Value granularity | Store the most specific taxonomy values | Avoid redundant parent+child storage. Ancestors are derived in code. |
| Runtime matching | Derive broader runtime matches from taxonomy ancestry | Eliminates separate stored `capabilities` metadata. |
| Runtime contract | Move away from separate family concepts over time | Skills and connection resolution should speak the same taxonomy language. |
| Migration style | Stage the refactor behind compatibility helpers first | Reduces blast radius and keeps runtime behavior stable while migrating callers. |

---

## Proposed taxonomy model

### Stored values

Providers store only their most specific taxonomy paths.

Initial examples:

- Hyperliquid: `['trading/crypto/orderbook']`
- Bybit: `['trading/crypto/orderbook']`
- 1inch: `['trading/crypto/swap']`
- Jupiter: `['trading/crypto/swap']`
- Gmail: `['messaging/email']`

### Derived ancestors

Ancestor paths are not stored. They are derived when matching.

Examples:

- `trading/crypto/orderbook` implies:
  - `trading`
  - `trading/crypto`
  - `trading/crypto/orderbook`
- `messaging/email` implies:
  - `messaging`
  - `messaging/email`

### Runtime meaning

Runtime connection requirements should match by exact taxonomy path or ancestor.

Examples:

- A requirement for `trading` matches `trading/crypto/orderbook`
- A requirement for `trading/crypto` matches `trading/crypto/swap`
- A requirement for `messaging` matches `messaging/email`
- A requirement for `messaging/email` matches only email-capable messaging
  providers

This is how runtime families disappear without losing expressive power.

---

## Architecture impact

This feature touches four areas:

| Layer | Component | Change |
|---|---|---|
| Domain | Provider catalog types | Clarify `categories` as hierarchical taxonomy paths |
| Domain | Shared taxonomy helper | Add ancestry expansion and matching helpers |
| API | Provider registry | Replace flat labels with hierarchical taxonomy values |
| DB/runtime | Agent runtime descriptor | Stop depending on DB `capabilities`; match connections via taxonomy helpers |
| Domain/runtime | Skills metadata | Migrate from `capabilityFamilies` toward taxonomy-based requirements |
| Tests/docs | Provider, runtime, and skills docs/tests | Update fixtures, assertions, and terminology |

---

## Implementation strategy

### Phase 1 — Introduce taxonomy helpers without breaking callers

Add a shared helper in `packages/domain` that can:

- normalize taxonomy paths
- expand ancestors from a path
- test whether provider taxonomy paths satisfy a required taxonomy path

Example API shape:

```typescript
expandTaxonomyAncestors('trading/crypto/orderbook');
// => ['trading', 'trading/crypto', 'trading/crypto/orderbook']

matchesRequiredTaxonomy(
  ['trading/crypto/orderbook'],
  'trading/crypto',
);
// => true
```

Do not remove old runtime family code yet. First add the helper and cover it
with focused unit tests.

### Phase 2 — Convert provider metadata to hierarchical taxonomy values

Update provider metadata to store hierarchical taxonomy paths in `categories`.

Likely initial mapping:

- `['trading']` -> `['trading/crypto/orderbook']`
- `['trading', 'swap']` -> `['trading/crypto/swap']`
- `['messaging']` -> `['messaging/email']`

Update any UI logic that currently interprets flat category values directly.

For example, current venue-type derivation that checks `swap` or `trading`
needs to derive from taxonomy ancestry instead of direct array membership.

### Phase 3 — Replace runtime family resolution with taxonomy matching

Update runtime binding resolution so connections are matched by taxonomy, not by
separate DB `capabilities` or hard-coded family names.

This includes:

- removing `providers.capabilities` as a dependency
- resolving each connection's effective taxonomy from shared provider metadata
- deriving readiness buckets and default bindings from taxonomy matches

Compatibility bridge during migration:

- existing `capabilityFamilies: ['trading']` can temporarily be interpreted as
  required taxonomy `trading`
- existing `capabilityFamilies: ['email']` can temporarily map to required
  taxonomy `messaging/email` or `messaging`, depending on the exact contract

This bridge keeps the rollout incremental instead of requiring a flag day.

### Phase 4 — Migrate skills from family names to taxonomy requirements

Introduce a taxonomy-based skill requirement field, likely replacing or
superseding `capabilityFamilies`.

Possible target shape:

```typescript
bindingRequirements: {
  'trading': { minBindings: 1, requireReady: true },
  'messaging/email': { minBindings: 1, requireReady: true },
}
```

or, if a clearer field name is preferred:

```typescript
requiredConnectionTaxonomies: {
  'trading': { minBindings: 1, requireReady: true },
  'messaging/email': { minBindings: 1, requireReady: true },
}
```

Decision point for implementation:

- keep the old field name for lower churn, or
- rename it for semantic clarity once compatibility code exists

This plan does not force that naming decision up front, but the end state
should not preserve a conceptually separate runtime family system.

### Phase 5 — Delete transitional concepts

Once taxonomy-based matching is in place everywhere:

- remove DB `capabilities`
- remove compatibility mapping from `email`/`trading` family labels if still
  present
- remove any helpers that only exist to translate between the old and new
  models
- update docs to describe only taxonomy-based provider and binding semantics

---

## Migration and rollout notes

This should be implemented as a staged refactor, not a one-shot rewrite.

Recommended order:

1. land shared taxonomy helpers with tests
2. convert provider catalog data to hierarchical taxonomy values
3. migrate runtime descriptor logic to taxonomy matching with compatibility
   aliases
4. migrate skill metadata and runtime consumers off the old vocabulary
5. remove transitional aliases and dead concepts

This staging keeps behavior stable while reducing the chance of breaking agent
binding resolution.

---

## Risks

### 1. Runtime behavior drift

If taxonomy matching is wrong, agents may lose required bindings or gain
incorrect ones. This is the highest-risk part of the refactor.

### 2. UI/filter regressions

Existing code that checks direct category membership like `swap` or `trading`
will break if it assumes flat values.

### 3. Half-migrated terminology

If some code still speaks in `families` while other code speaks in taxonomy
paths, the refactor will add confusion instead of removing it.

### 4. Over-designing the hierarchy

Too many levels too early can make matching and reasoning harder. The hierarchy
should reflect dimensions we reasonably expect to use: domain, asset/modality,
and execution shape.

---

## Validation

1. Add focused unit tests for taxonomy ancestor expansion and matching.
2. Update provider catalog tests to assert hierarchical `categories` values.
3. Update runtime descriptor tests to assert that:
   - `trading/crypto/orderbook` satisfies `trading`
   - `trading/crypto/swap` satisfies `trading`
   - `messaging/email` satisfies the Gmail binding requirement
4. Run affected package tests for domain, db, api, and worker runtime slices.
5. Run `pnpm lint` before merging.

---

## Out of scope

1. Adding new providers solely to justify the taxonomy.
2. Reworking unrelated connection or credential flows.
3. Changing product UX beyond what is required to display the new taxonomy
   values correctly.

---

## Recommended sequencing with current work

The Gmail/provider-table cleanup should proceed independently first. That change
removes dead metadata and scope surface now.

This taxonomy plan should follow as a separate refactor once the immediate
cleanup lands, because it changes core provider classification and runtime
binding semantics rather than just removing unused implementation.