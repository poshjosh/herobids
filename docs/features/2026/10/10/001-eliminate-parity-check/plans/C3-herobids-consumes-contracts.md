# C3 — Herobids consumes `@poshjosh/contracts`

Install authentication (local `pnpm install`, CI, Docker), `.npmrc` without committed
secrets, where the dependency lives, the exact herobids files to change per shape group,
which tests move into package contract tests, and how the checker stays green per shape.
Written 2026-10-10 (C3.0).

## 1. Install authentication (open item O6)

The package is `@poshjosh/contracts@0.1.0` on GitHub Packages (`npm.pkg.github.com`),
published from `poshjosh/traderton`. Herobids is `poshjosh/herobids` — **same owner**, so
the CI `GITHUB_TOKEN` already has `packages: read`/`write` for it (the repo's
`build-push-agent.yml` already grants `packages: write`).

| Surface | Auth | New credential? |
|---|---|---|
| **CI** (`build-push-agent.yml`, `slow-tests.yml`) | `GITHUB_TOKEN` (same-owner `packages: read`) | **No** — already granted |
| **Local `pnpm install`** | a PAT with `read:packages`, supplied via env var | **Yes** — the local git credential token has scopes `read:user, repo, user:email, workflow` (no `read:packages`); verified `npm view @poshjosh/contracts` → `403 permission_denied: The token provided does not match expected scopes` |
| **Docker build** | same PAT, passed as a build secret | **Yes** — same token |

**`.npmrc` (committed, no secret):**

```
@poshjosh:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

The `${NPM_TOKEN}` placeholder is expanded by pnpm from the environment; the real token is
never committed. A `.env.example` twin documents `NPM_TOKEN` (I9).

**O6 verdict:** local + Docker install auth needs a **new** `read:packages` PAT. That is a
heavyweight decision (a new credential) — **C3.1 stops here and flags it**; the human
supplies the token (or confirms the CI-only path is acceptable for now).

## 2. Where the dependency lives

`@poshjosh/contracts` is a **runtime dependency of `@herobids/domain`** (the shapes are
re-exported through the domain barrel so existing `@herobids/domain` importers keep
working). Add to `packages/domain/package.json`:

```json
"dependencies": {
  "@poshjosh/contracts": "0.1.0"
}
```

Exact pin, no `^`/`~` (mechanics doc §2). The worker/api already depend on
`@herobids/domain` via `workspace:*`, so they inherit the package transitively.

## 3. Per-shape-group herobids file changes

| Row | Shape group | Herobids files to change | Delete | Manifest entry dropped |
|---|---|---|---|---|
| C3.2 | Watch | `apps/worker/src/watch-types.ts` (import `WatchEntry`/`WatchEntrySchema`/`WatchPurposeEnum` from the package; keep `parseWatch`/`toRuntimeActiveWatch` local in `agent-watch-view.ts`) | `apps/worker/src/watch-types.ts` | `watch-types` |
| C3.3 | Scan state | `apps/worker/src/scan-types.ts` (import `CandleFetchStatus`/`SymbolFetchOutcome`/`PositionIndicatorUpdate` from the package) | `apps/worker/src/scan-types.ts` | `scan-types` |
| C3.4 | Wake envelope | `packages/domain/src/trading/trading-protocol.ts` (import `ScannerWakeContextSchema`/`WakePrioritySchema`/base fields from the package; keep the 4 herobids-owned wake contexts + `ContextSnapshotPayloadSchema` local; re-compose `AgentWakePayloadSchema`) | none (file stays, region narrowed) | `domain-trading-trading-protocol` |
| C3.5 | Regime & volatility | `venue-intelligence.ts`, `tick-gates.ts`, `runtime-composition.ts`, `platform-assessor.ts`, `assessment-ports.ts`, `evidence-adapters.ts` (import `RegimeResult`/`VolatilityEvidence`/`EvidenceValue` from the package) | none (`market-assessment.ts` stays, I5/I10) | none (waits D2) |
| C3.6 | Risk overrides | `apps/api/src/agents/trading-profile-reconciliation-saga.ts` (import `AgentRiskOverridesSchema` from the package) | `packages/domain/src/agent-risk-contract.ts` | `domain-agent-risk-contract` |

## 4. Which herobids tests move into package contract tests

The package already carries round-trip fixtures for every schema (C1.x). Herobids tests
that only asserted the mirrored shape (not herobids behaviour) are deleted with the
mirrored file; behaviour tests (e.g. `agent-watch-view`'s `parseWatch` drop-malformed
behaviour, `runtime-composition`'s wake-union parse) stay and are re-pointed to the
package import.

## 5. Keeping the checker green per shape (I1, I2)

Each C3.x row drops its manifest entry **in the same change** as the swap, and removes the
id from `REQUIRED_ENTRY_IDS`/`REQUIRED_ENTRY_AUTHORITIES`. The checker test (I2) names
`domain-agent-risk-contract` (a `traderton`-authority id) — retarget it when C3.6 drops
that entry (to a surviving `mirror-only` id). `domain-trading-trading-protocol` is
`mirror-only` with an asymmetric region (`WatchThresholdWakeContextSchema` → EOF on both
sides); C3.4 narrows the herobids side to the still-shared region or drops the entry once
the scanner variant is sourced from the package.

## 6. Revised row list (writes back into 000-roadmap.md)

- C3.0: this plan (GP-D).
- C3.1: wire `.npmrc` + exact pin + CI/Docker auth; **stop if O6 needs a new credential**.
- C3.2–C3.6: per §3, each dropping its entry (I1/I2), GP-H + GP-C.
- G3: tag herobids with the C3 entry removals.
- C4: traderton consumes the package (workspace dep), deletes originals, bumps pin.
- C5: automate the package version-pin bump in `release-xstack.sh`.