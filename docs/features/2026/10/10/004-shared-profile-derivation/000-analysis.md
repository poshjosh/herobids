Let me verify the specifics before drafting so the problem statement is grounded in the actual code (the write sites, which fields they each build, and the shared seam they already share).Here is a statement of problem, grounded in the current code and self-contained for a reader with no prior context.

---

## Statement of Problem: Duplicated trading-field semantics across three agent create/update code paths

### Context

An agent's trading configuration — capital, risk posture, execution defaults, and the 004 scan config (`scanMode` / `creatorStrategy`) — is derived from the agent's unified config and written to its traderton trading profile through the reconciliation saga (`proposeTradingProfiles` → `executeStaged`). This derivation-and-write step is not centralized. It is reimplemented inline at three independent HTTP entry points, each of which assembles the profile fields in its own local shape:

- **`apps/api/src/routes/agents.ts`** — `POST /agents` (`prepareCreateProfilePlan`) and `PATCH /agents/:id` (`preparePatchProfilePlan`, two `proposeTradingProfiles` call sites).
- **`apps/api/src/routes/agent-interactivity.ts`** — `PUT /agents/:id` (an inline profile overlay rather than a `proposeTradingProfiles` call).
- **`apps/api/src/routes/chat.ts`** — the `create_agent` guided-setup tool.

Two related service paths (`agent-config-service.ts` grant/revoke, `agent-go-live-service.ts` clone, `connections.ts` delete fan-out, `blueprints.ts` instantiate) share the same seam and the same hazard.

### Problem

Because each path builds the profile object inline, the **mapping from an agent's post-mutation config to its trading-profile fields is duplicated, not shared**. Each path independently decides:

- which post-mutation unified config and style to read (the PATCH path must use the *merged* config after preset re-application; the create paths use the normalized insert config; the go-live and blueprint paths reconstruct it from a payload),
- how to populate every profile field, and
- how to handle edge cases (e.g. an unbound agent whose technical config has no resolved venue yet).

This creates three (really more) places that must stay in lockstep for any trading field. The consequences:

1. **Drift risk on every new or changed trading field.** Adding or changing a profile field requires locating and updating each path by hand. The recent scan-config work ([plan E1H‑E3H, Part A](docs/features/2026/09/18/001-trading-extraction-completion/plans/E1H-E3H-agent-wake-and-lifecycle-restore.md)) had to thread `scanMode`/`creatorStrategy` into all of these sites individually; a missed site would silently send a stale or null scan config for agents created or edited through that path, leaving a scanner-gated agent without a scan loop while others work. The type system catches a *missing field* on a struct, but it does not catch a path that computes the *wrong value* (e.g. reading the stored config instead of the merged one).

2. **Inconsistent edge-case handling.** Each path has evolved its own guards (unbound-create skip, patch-merge semantics, go-live reconstruction, blueprint-has-no-preset-metadata). Divergence here produces subtle per-entry-point behavior differences for the same logical operation.

3. **High cost to verify.** Confidence that "every write path sends the correct trading config" currently depends on per-path tests rather than one tested derivation function, so each change multiplies the review and test surface.

### Why it matters now

Trading config is the input that decides whether an agent trades at all (profile presence, execution venue binding) and how (risk caps, scan mode). A single divergent path is not a cosmetic inconsistency — it is an agent that silently behaves differently from an identically-configured agent created through another entry point. As the trading-profile contract keeps acquiring fields, the number of places that can drift grows with it.

### Desired end state

A single shared function owns the derivation of trading-profile fields (including scan config) from an agent's post-mutation config + style, consumed by all create/update/clone/instantiate paths. Each entry point supplies only its post-mutation config and connection set; the shared seam produces the proposed profiles. Field additions then happen in one place, edge-case handling is uniform, and verification concentrates on one tested unit rather than N parallel call sites.

### Scope / non-goals

- In scope: the API-side profile-field derivation and the `proposeTradingProfiles` call shape across the listed routes/services.
- Out of scope: the reconciliation saga's write/outbox mechanics, the traderton-side profile store, and the runtime wake/relay path — these are already centralized and are not the source of the duplication.