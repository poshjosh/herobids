# Wire-DTO contract package — mechanics decision

Settles the open mechanics for Brief B's ratified decision 5 (traderton-published
client package for the wire-DTO contract set). Not a new architecture decision — the
mechanism itself (shared package, traderton as publisher) was already ratified in
`B-parity-ownership.md`. This resolves the three open questions it left:
registry choice, version-pin strategy, and whether CI's cross-repo dual-checkout is
still needed for anything else.

## Scope

The package covers the wire-DTO set identified in `investigation-findings.md`:
`WatchEntry`/`WatchEntrySchema`, `RegimeResult`/`VolatilityEvidence`/`EvidenceValue`,
`EconomicEvent` (type only — herobids keeps its own tolerant 7-field view per the
ratified disposition-6 treatment, so this is traderton's authoritative type, not a
shared import), `AgentRiskOverridesSchema`, `TechnicalScanState` field types
(`scan-types`, `HybridPricingIdentity`), and the `AgentWakePayload` envelope +
`ScannerWakeContext`. All are producer=traderton, consumer=herobids.

## 1. Registry choice

**Decision: GitHub Packages, under the existing `poshjosh` org.**

Reasoning:
- Both repos are already `poshjosh/herobids` and `poshjosh/traderton` on GitHub, and
  CI already does authenticated cross-repo checkouts between them (see
  `.github/workflows/slow-tests.yml`, `actions/checkout@v4` with `repository:
  poshjosh/traderton`). GitHub Packages reuses that exact same auth boundary
  (`GITHUB_TOKEN` / a PAT with `read:packages`) — no new credential, no new vendor,
  no new account to provision.
- Traderton's `packages/domain/package.json` is `"private": true` today. GitHub
  Packages supports private scoped packages natively; publishing there does not
  require making the package public or picking a different npm scope.
- A self-hosted registry (Verdaccio etc.) would add an operational dependency (a
  server to run, back up, and secure) for no benefit over what GitHub already
  provides for this org.
- Rejected: public npm. The contract types describe proprietary trading-protocol
  internals (wake payloads, risk overrides); there's no reason to publish them
  publicly, and a private npm org is a paid product with no advantage here over
  GitHub Packages, which the org already has access to.

Mechanically: traderton publishes `@traderton/contracts` (new package, scoped,
carved out from `packages/domain` — see Scope above for what moves) to GitHub
Packages on each traderton release. Herobids adds a `.npmrc` pointing the
`@traderton` scope at `npm.pkg.github.com`, authenticated the same way CI already
authenticates for repo checkouts.

## 2. Version-pin strategy

**Decision: exact pin (`"@traderton/contracts": "0.1.2"`, no `^` or `~`), bumped
automatically by the existing release tooling, not by hand.**

Reasoning:
- A range (`^0.1.0`) would let herobids silently pick up a new contract version on a
  routine `pnpm install`, with no review step — this reintroduces exactly the silent-
  drift risk the parity check existed to catch, just moved from "two files differ" to
  "a dependency bump happened unreviewed." Exact pin keeps every contract change
  visible as an explicit, reviewable diff in herobids' `package.json`.
- The manual-bump cost that makes exact-pin unattractive in general is addressed by
  automating the bump as part of the existing cross-repo release flow
  (`scripts/shell/ops/release-xstack.sh`), the same way that script already bumps the
  parity-pin `ref:` in `slow-tests.yml` today. Add one more step there:
  "publish `@traderton/contracts`, then bump herobids'
  `package.json` dependency to the published version," right after the existing
  parity-pin bump steps and before the final commit/push.
- This mirrors the parity-pin mechanism's intent (an explicit, auditable version
  reference) while actually publishing a resolvable, installable artifact instead of
  a hand-copied file.

## 3. Does CI still need the cross-repo dual-checkout?

**Decision: no, once the wire-DTO package work is complete and the remaining
manifest entries are resolved per Brief B.**

The dual-checkout in `slow-tests.yml` exists for exactly one purpose today: running
`check-parity-drift.mjs`, which needs both working trees on disk to diff files. Once:
- the wire-DTO set moves to the published package (no files to diff — herobids holds
  a `node_modules` copy of a versioned release, not a hand-mirrored source file), and
- every other manifest entry is resolved per Brief B (deleted, moved to a boundary
  read, or retired per disposition 6),

...there is nothing left for `check-parity-drift.mjs` to check, and the `parity-drift`
CI job, the dual-checkout step, and `scripts/parity-drift-manifest.json` /
`scripts/check-parity-drift.mjs` / `check-parity-drift.test.mjs` can all be deleted
from both repos. This is the actual end state the whole effort has been aiming at.
No other herobids or traderton CI job currently depends on the sibling checkout
(confirmed: `slow-tests.yml`'s `parity-drift` job is the only one referencing
`TRADERTON_ROOT`/`repository: poshjosh/traderton`), so removing it does not strand
any other check.

Until then — while some manifest entries are still mirrored files — keep the
dual-checkout and the manifest-based check running for whatever remains, shrinking it
entry-by-entry as each is resolved, consistent with Brief B's existing sequencing
guidance.

## What this does not decide

- The exact contents/boundaries of `@traderton/contracts` as a new package (which
  files move out of `packages/domain` into it) — that's an implementation detail for
  whoever executes the migration, guided by the Scope list above.
- Whether `AgentWakePayload`/`ScannerWakeContext` also need a thin runtime
  validator shipped in the package (likely yes, since herobids currently runs Zod
  parsing against these) versus just TypeScript types — implementation detail, not a
  mechanics blocker.
- Nothing here authorizes starting the implementation; it only removes the "we don't
  know the mechanism" blocker so a future plan can be written against a decided
  registry/versioning approach.
