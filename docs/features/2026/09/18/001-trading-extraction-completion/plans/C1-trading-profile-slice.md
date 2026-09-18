# Plan C1 (CONTINGENT on B1=(ii)): Traderton-owned trading profile slice

- **Task:** C1 — the traderton-side half of the B1=(ii) outcome: profile store + config boundary tool + actor-ensure consumption + risk-read source swap
- **Repo:** traderton (with a herobids companion list in C1b)
- **Status:** **CONTINGENT PLAN** — drafted against the recommended B1 outcome (ii). Do not implement unless B1 is decided (ii) and recorded as an ADR. Numbers/details may be refined at activation.
- **Prereq:** B1 ADR; A3 implemented (source-agnostic assembly — this plan swaps its source); B5-item-2 (create/update consolidation) done or in-hand.

## Design sketch (one page, per the B1 open-question offer)

**Store:** `agent_trading_profiles` table in traderton (`@traderton/db`):
- `id`, `owner_id`, `actor_id`, `venue_account_id` (unique on the triple), `execution_mode` (paper/shadow/live), `capital` (numeric), `risk_posture` (jsonb RiskPosture), `risk_overrides` (jsonb), `max_bots` (int), `created_at`, `updated_at`.
- Row lifecycle mirrors the venue-account pattern: created via config tool, soft-deletable on deprovision/unbind cascade.

**Boundary tool:** `set_agent_trading_profile` (write, `ownerScopedNoVenue: true` — it configures, never executes) + `get_agent_trading_profile` (read):
- Payload: `{ actorId, venueAccountId?, executionMode?, capital?, riskPosture?, riskOverrides?, maxBots? }` — absent fields = no change (PATCH semantics); full-shape validation via the domain `RiskPostureSchema`.
- Idempotency: rides the standard side-effecting wrap (four-tuple key) — a retry of the same write replays.
- Authorization: subject owner must match; actor must be the subject actor (no cross-agent writes).

**Consumption:**
- Actor ensure (`bin.ts`): source order becomes **profile → payload echo (transient) → operator defaults**; profile hit also supplies `ownerMode` (retiring A4's static-default dependency for profiled agents).
- A3's `riskContractOps`/`agentRepo`/`executionConfig` assembly: source becomes the profile store (pluggable seam — no rewrite).
- `adjust_risk_limits` (currently typed-fail per A3-1b): gets its durable store — profile `risk_overrides` — and goes live boundary-side.

## Steps (activation order)

1. traderton: db schema + migration + repository (thin, venue-account-pattern).
2. traderton: domain payload schemas; tool definitions (`set_`/`get_agent_trading_profile`); registry + `ownerScopedNoVenue` pin (extend `owner-scoped-no-venue.test.ts`).
3. traderton: bin.ts context factory — risk-source seam: profile store lookup (by subject owner/actor) with payload-echo fallback; ensure consumes profile ownerMode.
4. traderton: `adjust_risk_limits` wired to profile `risk_overrides` (via `buildAgentRiskLimits`-family math traderton already owns).
5. traderton: tests — tool schema/strip lesson (declare every consumed field), ownership authz, ensure-source precedence (profile > echo > defaults), adjust round-trip.
6. herobids (C1b list): write-through at bind/create/update via the consolidated payload path (B5-2); backfill script (seed profiles from existing `agents.*` rows per bound connection); UI copy shift (allocation framing); payload-echo retirement behind a flag, then removal (A6-4 closes); parity-test retirement on herobids side.
7. Certification: A8 gate re-run with echo-off (proves profile-only enforcement), plus a drift check that no decision payload carries risk fields anymore.

## Verification

- Per-package tsc + full suites both repos; live cross-stack: profile created at bind; decision executes with capital from profile; mid-session capital edit → profile update → ensure reconstruct (replacing the payload-diff heuristic with a real event source); adjust_risk_limits round-trips through the profile.

## Risks

- Backfill correctness (existing agents) — idempotent seed script + dry-run mode.
- Echo-removal flag window — keep both sources read-compatible until the gate passes.
- Scope creep guard: this slice does NOT move UI fields (B1-3 keeps them in-place) and does not touch assessments/blueprints (B4 keeps them).

## References

- `decisions/B1-stored-trading-state.md` (this plan implements its recommendation)
- `plans/A3-boundary-risk-account-context.md` (source-agnostic seam this plugs into)
- traderton `packages/db/src/schema/venue-accounts.ts` (the store pattern to mirror)
- `packages/worker/src/tools/owner-scoped-no-venue.test.ts` (registry pin)
