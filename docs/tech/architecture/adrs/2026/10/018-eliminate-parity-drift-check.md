# ADR 018: Eliminate the Parity-Drift Check

**Date:** 2026-10-12
**Status:** Accepted

## Context

The trading extraction (ADR 011) left deliberate byte-for-byte copies in herobids
and traderton — operator risk defaults, risk-contract math, strategy-preset
catalogs, and watch/scan/gate type layers — protected by a file-level
parity-drift check (`scripts/parity-drift-manifest.json` +
`scripts/check-parity-drift.mjs` + a `parity-drift` CI job in both repos). That
check was a deliberate tactical workaround to ship the extraction without a
shared-package or codegen pipeline, not a hard constraint.

The "Eliminate the Parity-Drift Check" epic
(`docs/features/2026/10/10/001-eliminate-parity-check/000-roadmap.md`) resolved
the duplication behind every manifest entry — deleting dead copies, re-pointing
logic to the traderton boundary, moving wire shapes into a traderton-published
`@poshjosh/contracts` package, and retiring obligations that were never
cross-repo contracts — until the manifest had zero entries. This ADR records the
dispositions and the end state.

## Decision

### Per-entry dispositions

Each manifest entry was resolved by one of six dispositions, ratified in
[Brief B](`docs/features/2026/10/10/001-eliminate-parity-check/decisions/B-parity-ownership.md`):

1. **Delete the dead copy** — a file with no non-test consumer in one repo, proven
   by a trial deletion judged by the owning repo's own build, type checks and full
   test suite (invariant I6).
2. **Re-point to the traderton boundary** — the consumer calls the owner at runtime
   (a read tool) instead of holding a local copy (e.g. `get_operator_defaults`,
   `get_strategy_presets`).
3. **Move the wire shape into `@poshjosh/contracts`** — a traderton-published,
   versioned, schemas-and-types-only package that herobids consumes as an
   exact-version dependency.
4. **Feature relocation** — the whole capability moved to the owning repo (the
   preset-assessment plan pair).
5. **Retire the obligation** — generic, no-wire-exposure utility code that both
   repos use independently and are already free to evolve; each repo keeps its own
   copy and the entry is dropped.
6. **Retire the obligation (ratified)** — the same as (5), ratified as a distinct
   disposition for entries that were never a cross-repo contract in the first place.

### Wire-DTO package

The wire-DTO set moved into `@poshjosh/contracts`, published by traderton to
GitHub Packages under the `poshjosh` scope, consumed by herobids as an
exact-version pin (no `^`/`~`), with the version bump automated in
`release-xstack.sh`. Mechanics are in
[`wire-dto-package-mechanics.md`](`docs/features/2026/10/10/001-eliminate-parity-check/decisions/wire-dto-package-mechanics.md`).

### End state

No mirrored files remain; the parity-drift check, manifest, test and CI job are
deleted from both repos. Traderton is the sole authority for trading logic and
preset definitions; herobids consumes typed boundary reads and the contracts
package.

## Consequences

- The `parity-drift` CI job, the dual-checkout step, `scripts/parity-drift-manifest.json`,
  `scripts/check-parity-drift.mjs` and `scripts/check-parity-drift.test.mjs` are
  removed from herobids; traderton's `scripts/check-parity-drift.mjs` wrapper and
  its `parity-drift` job are removed.
- `release.sh` / `release-xstack.sh` no longer carry `--bump-parity-pin` or the
  parity gate.
- The parity-drift rule is removed from herobids `AGENTS.md`.
- ADR 011 Decisions 2 and 3 (wire-DTO mirrors and preset-catalog mirrors protected
  by parity checks) are superseded in part: the mirrors are gone, replaced by the
  contracts package and boundary reads.

## References

- Decision brief: `docs/features/2026/10/10/001-eliminate-parity-check/decisions/B-parity-ownership.md`
- Wire-DTO mechanics: `docs/features/2026/10/10/001-eliminate-parity-check/decisions/wire-dto-package-mechanics.md`
- Preset wire-shape disposition: `docs/features/2026/10/10/001-eliminate-parity-check/decisions/D2-a-presets-wire-shape.md`
- Epic roadmap: `docs/features/2026/10/10/001-eliminate-parity-check/000-roadmap.md`
- ADR 011: `../09/011-split-trading-authority-by-responsibility.md`