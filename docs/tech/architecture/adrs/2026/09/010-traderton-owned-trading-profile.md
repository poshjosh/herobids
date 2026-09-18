# ADR 010: Trading State Is a Traderton-Owned Trading Profile

**Date:** 2026-09-18
**Status:** Accepted

## Context

An agent's trading state — `capital`, `riskPosture`, `riskOverrides`, and
`executionDefaults` — currently lives on the herobids `agents` row. Because the
traderton boundary process cannot read that row (it owns no `agents`-table
dependency), herobids injects these values into every signed `submit_decision`
payload (the "payload echo", shipped as bug-report 2026/09/17 #001 phase 3).
Traderton's actor ensure consumes them at construct/start time: capital anchors
the `EquityTracker` (daily-loss / drawdown math); `riskPosture`/`riskOverrides`
feed `buildAgentRiskLimits`.

This works — enforcement is live-verified — but it is a holding pattern, not an
end-state:

- **Risk integrity is weak.** Traderton enforces limits from numbers the
  counterparty asserts per request. A buggy or compromised consumer echoing
  `capital: 999999` inflates its own loss limits, and nothing boundary-side can
  detect it. A system cannot credibly govern risk it does not own.
- **Downstream costs.** Risk reads are broken over the boundary (ADR-adjacent
  plan A3 exists only because of this); `adjust_risk_limits` has no durable home;
  mid-session changes rely on a fragile reconstruct-on-payload-diff heuristic; the
  "generic agent brain consuming external trading capability" story stays
  punctured.

The governing principle across the herobids→traderton extraction is **traderton
owns what traderton enforces**. Capital and risk are enforcement inputs;
therefore traderton should own them. (Contrast `decision_approvals`, which
traderton enforces nothing from and which is correctly consumer-owned.)

This decision is taken clean-slate: there is no active staging or production
deployment and no backward-compatibility obligation. The DB can be wiped and
reseeded; the payload echo is deleted outright rather than dual-run.

## Decision

**Trading state becomes a traderton-owned "trading profile," configured by
herobids through the boundary and enforced traderton-side.** herobids stops
storing enforcement inputs as agent properties.

The decision is fixed on these points:

1. **Profile store.** A new traderton-owned store holds `capital`,
   `riskPosture`, `riskOverrides`, and `executionDefaults`. herobids writes it
   via a signed, owner-scoped boundary tool; traderton reads it at actor
   construction. The per-decision payload echo is retired.

2. **Enforcement key = the verifiable `(ownerId, venueAccountId)`.** The profile
   is addressed by `(ownerId, actorId, venueAccountId)`, but **enforcement
   anchors only on `(ownerId, venueAccountId)`** — the part traderton provisions
   and can verify. `actorId` (and `actorType`) are **consumer-asserted labels**:
   traderton verifies the HMAC signature (the call genuinely came from herobids)
   but cannot verify the actor claim. `actorId` therefore serves as an
   allocation/attribution sub-key only; it never grants or gates enforcement.
   Corollary: **traderton must not enforce on `actorType`** — recording it for
   attribution is fine, gating on it is not (existing `execution-capability.ts`
   takes `actorType` but branches only on mode/venue, which is consistent with
   this rule; any future branch on `actorType` violates it).

3. **`maxBots` is excluded from the profile.** It stays a herobids
   plan/entitlement concern. `maxBots` caps **bot population / standing herobids
   resource cost** (each bot is a long-lived herobids object costing compute
   whether or not it ever trades); it is not an enforcement input, and traderton
   enforces nothing on it. A future traderton per-owner boundary **API rate
   limit** (velocity cap) is worthwhile *additive* infrastructure but is not a
   `maxBots` replacement — population, velocity, and capital are distinct
   resources, none subsuming the others.

4. **Lifecycle: eager-at-bind.** The profile is written via the boundary at agent
   create / update-with-trading-setup / connection bind — before any decision —
   so enforcement always reads a real owned profile with no "not set up yet" gap.
   Trading-agent creation already requires a boundary call for provisioning, so
   this adds no new dependency. Lazy seed-on-first-decision is rejected (it keeps
   the echo alive longer and leaves a profile-absent window).

5. **UI framing is deferred.** No copy/label changes are part of this decision;
   the input fields keep their current wording. Only the storage/flow change
   (the typed value flows through the boundary to the profile instead of writing
   the `agents` row) is in scope. UI framing is handled later as part of a wider
   UI direction.

## Consequences

- **Execution.** This is the largest single change in the trading-extraction
  epic. It lands in Track C (`plans/C1-trading-profile-slice.md`), gated behind
  Track A stabilization + the A8 certification gate. This ADR ratifies the
  *direction and shape*; it does not authorize implementation.

- **A3 is built source-agnostic (already decided — see the A3 plan).** The
  boundary-side `riskContractOps` assembly reads through a single `RiskSource`
  seam. Track A binds that seam to the payload echo (restoring risk reads now,
  keeping `adjust_risk_limits` fail-closed); Track C reimplements the same seam
  against the profile store (a one-adapter swap) and activates the write. The
  copied ops, math, handlers, tools, and tests survive the swap unchanged.

- **Consolidation is effectively a prerequisite.** Trading fields are written on
  four+ herobids paths today (`POST`/`PATCH` in `agents.ts`, `PUT` in
  `agent-interactivity.ts`, chat `create_agent`, plus `agent-instantiation-service`),
  each duplicating validation/normalization. There is no single write choke point.
  These must be consolidated (or cleanly redirected) before the profile
  write-through can be wired once rather than four times (tracked as B5 item 2 /
  a C1 prerequisite).

- **Echo deletion is a straight cut, not a two-phase retirement** (clean-slate).
  The submit-decision echo, its two source reads
  (`agent-decision-handler.ts`, `approval-service.ts` + `index.ts` wiring), the
  traderton `agentRiskSpec` extraction (`subject-resolver.ts`), and the
  reconstruct-on-change logic in `bin.ts` are all removed in Track C. A related
  path — `agent-session-manager.ts` forwarding risk fields into the agent
  container — must be reconciled in the same slice so it is not left dangling.

- **Enforcement re-keying touches durable reads.** Fills/positions are persisted
  and queried by `(actorType, actorId)`, and daily-loss rehydration is
  venue-account-scoped. Re-keying enforcement onto `(ownerId, venueAccountId)`
  must reconcile with these existing read paths; this is design work, not a
  free rename.

- **Parity tests retire.** herobids' in-process risk math and its parity tests go
  away with the fallback — expected, no migration ceremony (clean-slate).

- **Copy-never-author preserved.** The traderton-side ops and risk math are
  copied from herobids source (`buildRiskContractOps`); only the source binding
  (payload → profile store) is authored as a thin seam. Traderton never depends
  on herobids code.

## References

- Decision brief: `docs/features/2026/09/18/001-trading-extraction-completion/decisions/B1-stored-trading-state.md`
- Epic roadmap: `docs/features/2026/09/18/001-trading-extraction-completion/000-roadmap.md`
- A3 plan (source-agnostic `RiskSource` seam): `.../plans/A3-boundary-risk-account-context.md`
- Contingent Track-C plan: `.../plans/C1-trading-profile-slice.md`
- Schema + boundary-tool contract draft: `.../decisions/B1-trading-profile-contract-draft.md`
- Audit: `docs/tech/trading/audits/2026/09/001-herobids-trading-logic-ownership-audit.md` §3.2, §7-S2, §7-S13, §8-Q1
- Ownership fixes precedent: `docs/bug-reports/2026/09/17/001-...` phases 2–3
