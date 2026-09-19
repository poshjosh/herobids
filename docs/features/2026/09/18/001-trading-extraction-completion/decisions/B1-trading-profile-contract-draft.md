# B1 De-risk Draft: Trading Profile — Store Schema + Boundary-Tool Contract

- **Date:** 2026-09-18
- **Status:** DESIGN DRAFT (B1 question 5). One-page contract to de-risk ADR 010 before Track-C implementation. **Not implementation authorization.** Authored herobids-side per epic convention; the traderton pieces are authored IN traderton when built (copy-never-author).
- **Parent:** ADR 010 (traderton-owned trading profile); brief `B1-stored-trading-state.md`.
- **Faithful to existing types (verified against HEAD):** `RiskPosture` / `ExecutionDefaults` (`traderton/packages/domain/src/config/schema.ts`), `AgentRiskOverrides` (`.../agent-risk-contract.ts`). This draft reuses them verbatim — it does NOT invent new risk field shapes.

---

## 1. The store (traderton-owned)

New Drizzle table, one file `traderton/packages/db/src/schema/agent-trading-profiles.ts`, following the `venue-accounts.ts` pattern (soft `ownerId`, no FK to users — traderton owns no identity).

```
agent_trading_profiles
  id               text PK (UUIDv7)
  owner_id         text NOT NULL            -- soft ref, boundary-validated (verifiable)
  venue_account_id text NOT NULL            -- FK-soft to venue_accounts.id (verifiable, traderton-provisioned)
  actor_id         text NOT NULL            -- actor-scoped execution/risk-state key component
  capital          text (numeric-as-string) NULL   -- decimal string, matches wire + agents.capital today
  risk_posture     jsonb  NULL              -- RiskPostureSchema shape (nullable fields = operator default)
  risk_overrides   jsonb  NULL              -- AgentRiskOverrides shape (agent-mutated fields only)
  execution_defaults jsonb NULL             -- ExecutionDefaultsSchema shape { mode, slippageBps? }
  revision         bigint NOT NULL           -- monotonic, increments on each applied change
  created_at       timestamptz NOT NULL default now()
  updated_at       timestamptz NOT NULL default now()

  UNIQUE (owner_id, venue_account_id, actor_id)   -- enforcement and upsert key
  INDEX  (owner_id, venue_account_id)              -- ownership/venue support lookup
```

**Keying rules (ADR 010 §2):**
- **Enforcement / actor construction reads by `(owner_id, actor_id, venue_account_id)`.** This matches the current actor cache and durable fills/positions/risk state, letting agents share an account without sharing risk configuration.
- `owner_id` and `venue_account_id` are boundary-verified. `actor_id` partitions the signed agent subject's state and never grants authorization. `actorType` is not a profile column or enforcement key.
- `maxBots` is **absent by design** — it stays a herobids plan concern (ADR 010 §3).

**Migration:** one new migration; clean-slate (wipe+reseed), no backfill.

**Repository:** `AgentTradingProfileRepository` (one class, `constructor(db)`), methods:
- `getByOwnerActorVenueAccount(ownerId, actorId, venueAccountId): Promise<TradingProfile | null>` — the enforcement read.
- `applyChange(input): Promise<{ changeId: string; revision: bigint }>` — full-snapshot replacement; persist the preimage in Traderton before applying the change.
- `finalizeChange(changeId): Promise<void>` and `rollbackChange(changeId): Promise<void>` — delete or restore the stored preimage.

---

## 2. The boundary tool: `set_agent_trading_profile`

Owner-scoped write tool, modeled on `provision_venue_account` (`traderton/packages/worker/src/tools/provisioning.ts`).

- **Name:** `set_agent_trading_profile` (verb_noun, snake_case — AGENTS.md).
- **`ownerScopedNoVenue: true`**, **`category: 'write-database'`**. Rationale: an owner-scoped write that drives no executor; it configures state and needs no venue *resolution* (the venueAccountId is a parameter it writes, not a coordinate it resolves against a running actor). Add to `tools/owner-scoped-no-venue.test.ts` catalog.
- **Rides the boundary idempotency store automatically** (four-tuple dedup) like other writes.

### Parameters (Zod — declare EVERY field the boundary reads; Zod strips unknowns)

```
TradingProfileConfiguration = {
  venueAccountId: string (non-empty),      // the verifiable enforcement anchor
  actorId:        string (non-empty),      // allocation/attribution sub-key
  capital:        string (positive decimal) | null,
  riskPosture:    RiskPostureSchema | null,       // reuse the existing schema verbatim
  executionDefaults: ExecutionDefaultsSchema | null,
}
```

Every field is required: the setter is full replacement, never PATCH. The
stored `executionDefaults.mode` is projected to the actor's scalar execution
mode; no parallel `executionMode` field exists. `riskOverrides` remain on the
stored profile but are initialized empty and mutated only by
`adjust_risk_limits`; a configuration update preserves them atomically.
`operationId` is also required, generated and durably recorded by Herobids
before its first boundary call; Traderton keys the reversible change record by it.

### Execute (sketch, faithful to the provisioning template)
1. Guard `ctx.db` and `ctx.ownerId` (typed `fault:true` errorCodes when absent — copy the provisioning guards).
2. Verify `venueAccountId` is owned by `ctx.ownerId` (reuse `isVenueAccountOwnedBy`) → else `authorization.denied`. **This is the integrity gain over the echo:** the write is anchored to a venue account traderton owns and can verify.
3. Require `actorId === ctx.agentId`. Herobids first verifies the user's local
  ownership and signs profile calls with the target agent id as the subject;
  Traderton does not use `actorType` as a gate.
4. Re-validate the full configuration server-side (a direct in-process caller cannot bypass the schema), preserve the current `riskOverrides` atomically, then call `profileRepo.applyChange(...)`.
5. Return metadata only: `{ operationId, revision }`. `get_agent_trading_profile`
  returns the typed snapshot and revision for the capability/read surface;
  `clear_agent_trading_profile` is exact-triple and reversible until finalized.

### Deprovision
`clear_agent_trading_profile` is the companion for connection unbind / agent
delete. `finalize_agent_trading_profile_change` and
`rollback_agent_trading_profile_change` complete the durable cross-service
saga; Herobids persists only the opaque change id and local mutation id.

---

## 3. The read seam (how the profile feeds enforcement + A3 reads)

The single `RiskSource` seam A3 introduces (see the A3 plan) is where the profile plugs in:

```
interface RiskSource {
  getRiskContext(ownerId, venueAccountId, actorId?):
    Promise<{ capital, riskPosture, riskOverrides } | null>
}
```

- **A3 (Track A):** `RiskSource` implemented by reading the per-call payload echo.
- **B1/C1 (Track C):** `RiskSource` is reimplemented by `profileRepo.getByOwnerActorVenueAccount(ownerId, actorId, venueAccountId)` — a **one-adapter swap**. The copied `riskContractOps` + math, the boundary handlers, the tools, and their tests are unchanged.
- **Actor construction (`bin.ts` `buildAgentDirectActorEnsure`):** today reads `injection.agentRiskSpec` (echo); post-B1 resolves the existing default-ready, then first-ready execution binding and reads its profile via the same source. The reconstruct-on-payload-diff logic is replaced by a monotonic revision comparison for the selected profile.
- **`adjust_risk_limits`:** its durable write home is now `profileRepo.upsert(... riskOverrides ...)`; the tool goes from fail-closed (Track A) to live (Track C).

---

## 4. herobids write-through (Track C)

- On agent create / update-with-trading-setup / connection bind (eager-at-bind, ADR 010 §4), Herobids plans full snapshots for every bound trading connection and calls `set_agent_trading_profile` over the signed boundary with each target agent as subject.
- It applies remote changes before the local transaction, finalizes them after commit, and rolls them back after local failure. A durable local outbox retries unknown finalize/rollback outcomes while Traderton retains the preimage.
- **Prerequisite:** consolidate the four+ write paths (POST/PATCH/PUT/chat/instantiation) to one normalization+write-through helper (B5 item 2 / C1 prereq) so the boundary call is wired once.
- **Then delete:** the `agents`-row trading columns' role as source of truth, the payload echo (builder + both source reads + traderton extraction/consumption), and the `agent-session-manager.ts` container-forwarding of risk fields (reconcile in the same slice).

---

## 5. Open sub-questions for C1 drafting (not blocking the ADR)

1. ~~Per-actor allocation~~ — resolved: profile scope is the triple; durable fills/positions/risk reads already support actor-and-account scope.
2. ~~Profile-change propagation~~ — resolved: compare monotonic revision before the selected actor's cache fast path.
3. ~~Clear semantics~~ — resolved: exact-triple clear with finalize/rollback.
4. Advisory-lock class id for per-owner profile-write serialization (avoid collision with bot-limit class 17).
