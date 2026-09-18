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
  actor_id         text NOT NULL            -- consumer-asserted ALLOCATION/attribution sub-key ONLY
  capital          text (numeric-as-string) NULL   -- decimal string, matches wire + agents.capital today
  risk_posture     jsonb  NULL              -- RiskPostureSchema shape (nullable fields = operator default)
  risk_overrides   jsonb  NULL              -- AgentRiskOverrides shape (agent-mutated fields only)
  execution_defaults jsonb NULL             -- ExecutionDefaultsSchema shape { mode, slippageBps? }
  created_at       timestamptz NOT NULL default now()
  updated_at       timestamptz NOT NULL default now()

  UNIQUE (owner_id, venue_account_id, actor_id)   -- upsert key
  INDEX  (owner_id, venue_account_id)              -- the ENFORCEMENT read key
```

**Keying rules (ADR 010 §2):**
- **Enforcement / actor construction reads by `(owner_id, venue_account_id)`** — the verifiable pair. When the store is later extended to per-actor allocation, the read narrows with `actor_id`; until then a single profile per `(owner, venueAccount)` is the norm and `actor_id` may repeat the agent id.
- `actor_id` is stored for allocation/attribution; **nothing enforces on it** (and nothing enforces on `actorType` — it is not even a column here).
- `maxBots` is **absent by design** — it stays a herobids plan concern (ADR 010 §3).

**Migration:** one new migration; clean-slate (wipe+reseed), no backfill.

**Repository:** `AgentTradingProfileRepository` (one class, `constructor(db)`), methods:
- `getByOwnerVenueAccount(ownerId, venueAccountId): Promise<TradingProfile | null>` — the enforcement read.
- `upsert(input): Promise<void>` — owner-scoped write; serialize per owner if needed via the existing `pg_advisory_xact_lock` idiom (new lock class id).

---

## 2. The boundary tool: `set_agent_trading_profile`

Owner-scoped write tool, modeled on `provision_venue_account` (`traderton/packages/worker/src/tools/provisioning.ts`).

- **Name:** `set_agent_trading_profile` (verb_noun, snake_case — AGENTS.md).
- **`ownerScopedNoVenue: true`**, **`category: 'write-database'`**. Rationale: an owner-scoped write that drives no executor; it configures state and needs no venue *resolution* (the venueAccountId is a parameter it writes, not a coordinate it resolves against a running actor). Add to `tools/owner-scoped-no-venue.test.ts` catalog.
- **Rides the boundary idempotency store automatically** (four-tuple dedup) like other writes.

### Parameters (Zod — declare EVERY field the boundary reads; Zod strips unknowns)

```
SetAgentTradingProfileParams = {
  venueAccountId: string (non-empty),      // the verifiable enforcement anchor
  actorId:        string (non-empty),      // allocation/attribution sub-key
  capital:        string (positive decimal) | null,
  riskPosture:    RiskPostureSchema | null,       // reuse the existing schema verbatim
  riskOverrides:  AgentRiskOverridesSchema | null,
  executionDefaults: ExecutionDefaultsSchema | null,
}
```

### Execute (sketch, faithful to the provisioning template)
1. Guard `ctx.db` and `ctx.ownerId` (typed `fault:true` errorCodes when absent — copy the provisioning guards).
2. Verify `venueAccountId` is owned by `ctx.ownerId` (reuse `isVenueAccountOwnedBy`) → else `authorization.denied`. **This is the integrity gain over the echo:** the write is anchored to a venue account traderton owns and can verify.
3. Re-validate the params server-side (a direct in-process caller cannot bypass the schema).
4. `profileRepo.upsert({ ownerId: ctx.ownerId, venueAccountId, actorId, capital, riskPosture, riskOverrides, executionDefaults })`.
5. Return metadata-only `ToolResult` (`{ ok: true }` — never echo secrets/values back unnecessarily).

### Deprovision
A companion `clear_agent_trading_profile` (or a `null`-payload semantics on the same tool) for connection unbind / agent delete — mirrors `deprovision_venue_account`. Small; specify when C1 is drafted.

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
- **B1/C1 (Track C):** `RiskSource` reimplemented by `profileRepo.getByOwnerVenueAccount(ownerId, venueAccountId)` — a **one-adapter swap**. The copied `riskContractOps` + math, the boundary handlers, the tools, and their tests are unchanged.
- **Actor construction (`bin.ts` `buildAgentDirectActorEnsure`):** today reads `injection.agentRiskSpec` (echo); post-B1 reads the profile via the same source. The reconstruct-on-payload-diff logic is replaced by "read the profile at construction" (and re-read on an explicit profile-changed signal, if needed — a C1 detail).
- **`adjust_risk_limits`:** its durable write home is now `profileRepo.upsert(... riskOverrides ...)`; the tool goes from fail-closed (Track A) to live (Track C).

---

## 4. herobids write-through (Track C)

- On agent create / update-with-trading-setup / connection bind (eager-at-bind, ADR 010 §4), herobids calls `set_agent_trading_profile` over the signed boundary with the values it currently writes to the `agents` row.
- **Prerequisite:** consolidate the four+ write paths (POST/PATCH/PUT/chat/instantiation) to one normalization+write-through helper (B5 item 2 / C1 prereq) so the boundary call is wired once.
- **Then delete:** the `agents`-row trading columns' role as source of truth, the payload echo (builder + both source reads + traderton extraction/consumption), and the `agent-session-manager.ts` container-forwarding of risk fields (reconcile in the same slice).

---

## 5. Open sub-questions for C1 drafting (not blocking the ADR)

1. Per-actor allocation: when (if ever) does the read narrow to include `actor_id`? MVP treats one profile per `(owner, venueAccount)`.
2. Profile-changed propagation to a running actor: explicit signal vs re-read cadence (replaces the reconstruct-on-diff heuristic).
3. `clear_agent_trading_profile` vs null-payload semantics on the setter.
4. Advisory-lock class id for per-owner profile-write serialization (avoid collision with bot-limit class 17).
