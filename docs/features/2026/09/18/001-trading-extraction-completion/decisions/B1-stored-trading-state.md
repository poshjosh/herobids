# Decision Brief B1: Where does stored trading state live?

- **Question:** Is `capital` / `riskPosture` / `riskOverrides` / `executionDefaults` / `maxBots` a **property of the agent** (herobids stores, traderton enforces from per-decision payload echoes — status quo) or a **property of the trading grant** (traderton stores and enforces; herobids configures through the boundary)?
- **Status:** ✅ **RATIFIED (2026-09-18) as [ADR 010](../../../../tech/architecture/adrs/2026/09/010-traderton-owned-trading-profile.md)** — Option (ii), traderton-owned trading profile. All five sub-questions resolved (see below). Schema + boundary-tool contract drafted: `B1-trading-profile-contract-draft.md`. Implementation lands in Track C (C1), gated behind Track A + A8.
- **Evidence:** audit §3.2 (`agents.*` rows), §7-S2 (payload echo), §7-S13 (approvals precedent), §8-Q1; bug-reports/2026/09/17 #001 phases 2–3 (the echo channel's origin).
- **Blocks:** A3 (shape), A6-4, A4 (mode value source), B2 (mostly), all of Track C.

## The tension, honestly stated

- **Status quo works today** (phase 3 proved the echo drives real enforcement: capital 1000 → $200 daily-loss limit, live-verified fills). Legal line arguably tolerates it: herobids holds user *preferences*, does no trading math.
- **Precedent cuts both ways:** `decision_approvals` was deliberately made consumer-owned (traderton deleted its copy). But that's decision-*semantics* of a consumer UX flow — traderton enforces nothing from approvals. Capital/risk are *enforcement inputs*. The consistent line is: **traderton owns what traderton enforces** — approvals pass it, capital/risk fail it.
- **The real problem with status quo is risk integrity, not legality:** traderton enforces limits from numbers the counterparty asserts per-request. A buggy consumer echoing `capital: 999999` inflates its own loss limits with nothing boundary-side able to catch it. A system cannot credibly govern risk it doesn't own.
- **Downstream costs of status quo (already catalogued):** risk reads broken at the boundary (A3 exists *because* of this), `adjust_risk_limits` has no durable home, mid-session changes rely on reconstruct-on-payload-diff (fragile heuristic), "generic agent" story stays punctured (the user's original concern).

## Options

| | (i) Status quo + echo | (ii) Traderton-owned trading profile | (iii) Hybrid (split fields) |
|---|---|---|---|
| Storage | `agents.*` columns | new traderton store keyed per grant | split |
| Enforcement | per-decision echoes | traderton state | mixed |
| Risk reads boundary-side | needs payload assembly (A3) | native | partial |
| `adjust_risk_limits` | no durable home | native | partial |
| Generic-agent story | punctured | repaired | half |
| Verification story ("we enforce what we own") | weak | strong | weak |
| Migration cost | none | **highest** — store, config tool, write-through, backfill, echo retirement | medium |

**(iii) is a false middle:** `riskPosture` is exactly an enforcement input; splitting fields buys nothing. The real choice is (i)-as-holding-pattern vs (ii)-as-end-state.

**`maxBots` is EXCLUDED from the profile (decided 2026-09-18).** Although B1's field list originally named `maxBots`, the deep dive + Contemplator resolved it stays a **herobids plan/entitlement concern**, NOT part of the traderton trading profile. The why (record so nobody later "cleans it up" assuming traderton covers it): maxBots exists to cap **bot population / standing herobids resource cost** — each bot is a long-lived herobids object (row, registry actor, subscriptions, scan scheduling) that costs compute whether or not it ever trades. traderton does not own bot population and enforces nothing on maxBots (FACT: no traderton branch keys on it). It is not an *enforcement input* like capital/riskPosture/riskOverrides, so it does not belong in a store keyed on `(ownerId, venueAccountId)`.
- **Distinct-resource note:** a future traderton per-owner **boundary API rate limit** (velocity cap on submit_decision/reads, as real venues do) is worthwhile *additive* infra but is NOT a maxBots replacement — a rate limit caps call velocity, maxBots caps standing population, capital caps money at risk; none subsumes the others (100k idle bots cost zero calls/capital yet exhaust herobids). The rate limiter is authorable infra (not copy-never-author trading behaviour) but genuinely new surface — deferred to post-epic backlog, additive, not part of A/B/C.

## Recommendation: (ii) — traderton-owned trading profile — with four specifics

1. **Profile key: `(ownerId, actorId, venueAccountId)` with one selected execution binding.** Fills, positions, mark sources, and risk rehydration support actor-and-venue-account scope, so the triple preserves independent agent risk state when agents share one venue account. The direct actor registry is intentionally one actor per agent: an agent may retain multiple bound profiles, but executes through the existing default-ready, then first-ready binding. Switching that binding stops the old actor before starting the new one. UI keeps a single capital field initially (applied to all bound accounts); per-account editing later.

   **Verifiability caveat (added 2026-09-18):** `actorId` (and `actorType`) are **consumer-asserted** — traderton verifies the HMAC signature (the call genuinely came from herobids) but cannot verify the *claim* that a given caller is a specific actor. `venueAccountId`, by contrast, maps to a venue account traderton provisioned and holds credentials for — a fact traderton **owns and can verify**. Therefore:
   - Enforcement uses the complete triple. `ownerId` and `venueAccountId` are verifiable boundary constraints; `actorId` selects the actor-scoped risk state already used by execution persistence.
   - **`actorId` is not an authorization grant.** The signed subject selects its actor state only inside the already verified owner and venue account context.
   - This keeps B1's integrity argument intact: traderton owns and verifies the risk-bearing account context, while actor partitioning matches its own actor-scoped execution records.

   **Standing note — traderton must not enforce on `actorType`.** `actorType` is a consumer label traderton cannot verify, so per "traderton owns what traderton enforces" it must not drive enforcement decisions. Recording it for attribution/journaling is fine; **gating** on it is not. Flagged separately because existing code branches on it — e.g. `packages/domain/src/trading/execution-capability.ts` differentiates `agent` vs `bot`. That branch should be reviewed against this rule (does the differing capability check depend on an unverifiable claim?). Tracked as a B2/consistency follow-up, not a B1 blocker.
2. **Lifecycle: eager, at bind time.** Agent create/update with trading setup, or connection bind, write-throughs a `set_agent_trading_profile` boundary call (owner-scoped config tool, `ownerScopedNoVenue`, provision/deprovision precedent). The phase-3 payload echo becomes a **transient fallback**, then is deleted. No new availability coupling: trading-agent creation already requires the boundary (provisioning verification).
3. **UI framing: separated from B1 (2026-09-19).** B1 itself still changes no copy or labels. The capability-agnostic UI architecture is now decided separately in ADR 014 and planned as C3; B1 remains only the storage/flow decision.

   **Separable from wording:** the storage change is *not* a text change. If B1=(ii), the field's destination changes — the typed value flows through the boundary to a traderton-owned profile instead of writing the `agents` row (new boundary tool + write-through, landing in Track C). That write-path change is the live part of B1; labels/help text are untouched and out of scope.
4. **A3 built source-agnostic either way:** the boundary-side `riskContractOps` assembly is identical code whether its source is the payload (now) or the profile store (post-B1). Track A gets working reads now; Track C swaps the source. No thrown-away interim work.

## Cascade if (ii)

A3 → pluggable source · A4 → profile mode becomes primary, static operator default stays fallback · A6-4 → fallback deletion moves to Track C · B2 → operator ceilings single-source to traderton (see B2) · Track C → `plans/C1-trading-profile-slice.md` + `plans/C2-config-single-sourcing.md`.

## Honest costs of (ii)

**Clean-slate constraint (user, 2026-09-18): no backward compatibility required — no active staging/production deployment, effectively starting afresh.** This removes the migration-cost items and simplifies the cut-over:
- **Backfill/seed for existing agents — not needed.** DB can be wiped/reseeded; no data to preserve.
- **Echo retirement is a straight delete, not a two-phase keep-then-retire.** Cut directly to profile-as-source-of-truth and delete the phase-3 payload echo in the same change. (This was the most delicate item; clean-slate removes the dual-run window.)
- **Risk-parity tests retire outright** — expected, no migration ceremony.

Costs that remain (design/correctness, not compat):
- **Two-repo coordination** (traderton profile store + boundary tool + ensure consumption; herobids write-through) — traderton work authored in traderton (copy-never-author).
- **Three parallel create/update codepaths** (agents.ts PATCH, agent-interactivity PUT, chat create_agent — audit S7) all stamp trading fields; consolidate first (B5 item 2) — now purely for cleanliness, not to protect a migration.
- **Zod-strip trap** — every field the boundary reads must be declared in the tool schema.
- **Verifiability caveat** — `ownerId` and `venueAccountId` are verified; `actorId` partitions existing actor-scoped state but never grants authority. `actorType` enforcement review remains (see recommendation #1).
- **A3 source-agnostic seam** — preserve so A3's risk reads swap payload→profile cleanly.

## Open questions for the chat session

1. The core call: (i) holding pattern vs (ii) end-state?
2. Profile granularity: **decided as per `(ownerId, actorId, venueAccountId)`.** This matches the existing actor cache and durable risk/position/fill scope while retaining owner/venue verification.
3. UI framing: **DEFERRED** — no copy/label changes as part of B1; handled later as part of a wider UI direction. Only the storage/flow change (below) is in B1 scope.
4. Migration shape: **DECIDED (2026-09-18) — eager-at-bind.** The trading profile is written via the boundary at agent create/update-with-trading-setup or connection bind, before any decision. Rationale: risk enforcement always reads a real owned profile (no "not set up yet" gap); reuses the boundary call trading-agent creation already makes for provisioning (no new dependency); retires the phase-3 payload echo as bootstrap rather than dragging it along. Lazy seed-on-first-decision rejected (keeps the echo alive longer, leaves a profile-absent window).
5. (Optional de-risk:) want a one-page traderton schema + boundary-tool contract design drafted before committing to (ii)? — **DONE (2026-09-18):** `B1-trading-profile-contract-draft.md` (store schema, `set_agent_trading_profile` tool contract, `RiskSource` read seam, write-through/echo-deletion plan).

## Decision (2026-09-18)

**Option (ii) ratified as ADR 010.** All five sub-questions resolved:
1. Core call — **(ii)** traderton-owned trading profile, configured via the boundary.
2. Granularity — profile and enforcement key `(ownerId, actorId, venueAccountId)`. Owner and venue account are verified; actorId partitions existing actor-scoped state and never grants authority. `maxBots` excluded — stays a herobids plan/resource concern.
3. UI framing — **separated from B1** (ADR 014 / C3; C1 itself changes no copy).
4. Migration — **eager-at-bind**.
5. Schema/contract draft — **done** (`B1-trading-profile-contract-draft.md`).

Sequencing note: gated behind Track A → A8. A3 builds the source-agnostic `RiskSource` seam (payload now); C1 swaps it to the profile store and retires the echo.
