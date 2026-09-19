# Plan C1: Traderton-owned trading profile slice

- **Task:** C1 — the traderton-side half of the B1=(ii) outcome: profile store + config boundary tool + actor-ensure consumption + risk-read source swap
- **Repo:** traderton (with a herobids companion list in C1b)
- **Status:** **IMPLEMENTED (2026-09-19); DATABASE AND CROSS-STACK VERIFICATION PENDING** — B1 is ratified as ADR 010. C1a is verified and the execution ledger records both repository SHAs; the Traderton half and the Herobids companion are coordinated in the stated order.
- **Prereq:** ADR 010; A3 implemented (source-agnostic assembly — this plan swaps its source); C1a completed or first in the same coordinated run; independent review complete.

## Design sketch (one page, per the B1 open-question offer)

**Store:** `agent_trading_profiles` table in traderton (`@traderton/db`):
- `id`, `owner_id`, `actor_id`, `venue_account_id` (unique on the triple), `capital` (numeric), `risk_posture` (jsonb `RiskPosture`), `risk_overrides` (jsonb `AgentRiskOverrides`), `execution_defaults` (jsonb `ExecutionDefaults`), `revision` (monotonic bigint), `created_at`, `updated_at`.
- A configuration write is a complete `TradingProfileConfiguration`: `{ actorId, venueAccountId, capital, riskPosture, executionDefaults }`. `executionDefaults.mode` is the sole stored mode and is projected to `AgentActorSpec.executionMode` at actor construction; there is no `executionMode` or `execution_mode` parallel representation. The stored profile also retains `riskOverrides`, but only `adjust_risk_limits` may mutate them; a configuration write atomically preserves current overrides.
- The repository reads by `(owner_id, actor_id, venue_account_id)`. Fills, positions, and risk rehydration already support this actor-and-account scope, so agents sharing an account retain independent risk configuration.
- An agent may retain profiles for multiple bound trading connections, but exactly one is its **selected execution binding** while it is running. The platform preserves the existing default-ready-connection, then first-ready-connection selection rule. A selection change serially stops and deregisters the old actor before constructing the new one; it never starts two direct-trading actors under one `agentId`.

**Boundary tools:** `set_agent_trading_profile`, `clear_agent_trading_profile`, `get_agent_trading_profile`, `finalize_agent_trading_profile_change`, and `rollback_agent_trading_profile_change`:
- `set_` is full replacement, not PATCH: it requires the complete `TradingProfileConfiguration`, a caller-generated `operationId`, validates every field with existing domain schemas, atomically preserves `riskOverrides`, increments `revision`, and returns only `{ operationId, revision }`. `clear_` addresses the exact triple and accepts the same operation id. `get_` accepts the exact triple and returns the current typed profile, including overrides, plus revision for the capability/read surface.
- `set_` and `clear_` persist the prior profile state in a Traderton-owned change record keyed by `operationId` before applying the new state. `finalize_` drops the preimage; `rollback_` restores it. A retry uses the same operation id/idempotency key and replays safely.
- **Recovery clarification (authorized 2026-09-19):** Traderton's operation record also retains the validated forward action manifest keyed by `operationId`, so a Herobids metadata-only outbox can resume an interrupted remote-before-local operation without persisting a second profile snapshot. Finalize or rollback removes the manifest with its preimage.
- All profile tools are `ownerScopedNoVenue` writes or reads as appropriate. Herobids verifies local user ownership, then signs profile calls with `subject.actor.id = actorId`. Each handler requires `params.actorId === ctx.agentId`; it does not use `actorType` as a gate. `venueAccountId` must be owned by `ctx.ownerId`.
- `maxBots` stays a herobids plan/entitlement concern under ADR 010.

**Consumption:**
- Actor ensure (`bin.ts`): resolves the selected execution binding, then reads that profile as the sole source of enforcement inputs; there is no per-decision payload-echo fallback. The profile supplies `executionDefaults.mode` (retiring A4's static-default dependency for configured agents).
- Each ensure invocation compares the monotonic profile `revision` before the cache fast path. A changed selected-profile revision follows the existing single-flight stop/deregister/reconstruct path, so an active actor cannot retain stale capital, posture, overrides, or mode. An update to an unselected profile does not disturb the running actor.
- A3's `riskContractOps`/`agentRepo`/`executionConfig` assembly: source becomes the profile store (pluggable seam — no rewrite).
- `adjust_risk_limits` (currently typed-fail per A3-1b): gets its durable store — profile `risk_overrides` — and goes live boundary-side.

## Steps (activation order)

1. traderton: db schema + migration + repository (thin, venue-account-pattern), including profile revision and persisted reversible change records.
2. traderton: domain snapshot schemas; full-replacement `set_`, exact `get_`/`clear_`, and `finalize_`/`rollback_` tools; registry + `ownerScopedNoVenue` pin (extend `owner-scoped-no-venue.test.ts`).
3. traderton: bin.ts context factory — resolve one selected execution binding, then use the profile-store risk source lookup by `(ownerId, actorId, venueAccountId)`; reject a missing selected profile rather than accepting payload enforcement inputs. Compare revision before the cache fast path; a selected-profile revision change reconstructs through the existing A1/A2 single-flight path.
4. traderton: `adjust_risk_limits` wired to profile `risk_overrides` (via `buildAgentRiskLimits`-family math traderton already owns).
5. traderton: tests — tool schema/strip lesson (declare every consumed field), signed-actor isolation for `set_`/`get_`/`clear_`, idempotent retry, two agents on one venue account retain distinct profiles, selected-binding switch teardown/start ordering, profile-only ensure source, missing-profile rejection, revision-triggered reconstruction, rollback restoration, `adjust_risk_limits` round-trip, and preservation of adjusted overrides across a later configuration write.
6. herobids (C1b list): C1a produces one reconciliation plan containing full snapshot upserts, clears, and inverse operations for create, update, bind, unbind, and delete. Generate and durably persist `{ operationId, localMutationId, state }` in a Herobids outbox before the first boundary call; pass that operation id to every remote change so a crash can resume it. Traderton retains the preimage and validated forward action manifest. Apply boundary changes before the local transaction, finalize after commit, and retry finalize or rollback from the outbox after transport failure. A failed local transaction rolls back every applied remote change. Deploy Traderton's profile migration and profile-only boundary/actor code first, then deploy this Herobids application cut and run additive Herobids migration `0071`. The retired `agents` columns remain physically inert after C1: the TypeScript schema and production code must not treat them as a source of truth, and their destructive drop is a separately staged cleanup migration after all old application instances are gone. Then delete `agents`-row enforcement writes and the signed decision-payload echo in the same cut. Reconcile setup-context echoes and retire the in-process parity tests. C3, not C1, owns UI rendering changes.
7. Certification: rerun the A8 gate against the profile-only path and verify no decision payload carries risk fields anymore.

## Verification

- Per-package tsc + full suites both repos; live cross-stack: profiles exist for each bound account, the selected binding alone executes, a binding switch stops the old actor before starting the new one, and a decision executes with capital from the selected profile. Verify a mid-session selected-profile edit reconstructs exactly once, an unselected-profile edit does not, `adjust_risk_limits` round-trips through the profile, and injected remote/local/finalize failures converge through the durable compensation protocol.

## Risks

- Cut-over completeness — the helper must cover every create, update, bind, unbind, delete, and instantiation path before the echo is deleted.
- Enforcement identity — owner and venue account are verified; actorId partitions the signed subject's existing actor-scoped state and never grants authorization.
- Cross-service failure — this is a durable saga, not a distributed transaction; the Herobids outbox retains only operation metadata and Traderton owns the profile preimages.
- Scope creep guard: C3 owns UI rendering; B4 still governs assessments and blueprints.

## References

- `decisions/B1-stored-trading-state.md` (this plan implements its recommendation)
- `decisions/B1-trading-profile-contract-draft.md` (schema and tool contract)
- `plans/C1a-profile-write-path-consolidation.md` (herobids prerequisite)
- `plans/A3-boundary-risk-account-context.md` (source-agnostic seam this plugs into)
- traderton `packages/db/src/schema/venue-accounts.ts` (the store pattern to mirror)
- `packages/worker/src/tools/owner-scoped-no-venue.test.ts` (registry pin)
