# PHASE 5 OUTLINE

Based on docs/features/2026/05/initial/003-design-decisions.md, **Phase 5: Product Surface** consists of:

1. Broad auth (multi-user, OAuth, plans)
2. Agents and autonomous tool use
3. Frontend / dashboard
4. Billing
5. Additional venues and chains
6. Telegram / alerting integrations

Here's my suggested implementation order, based on dependency analysis:

---

## Suggested Order

| Step | Item | Status | Rationale |
|------|------|--------|-----------|
| **1** | **Additional venues and chains** | ✅ Done | Purely additive — extends the existing `OrderbookVenuePort`/`SwapVenuePort` adapter pattern without touching auth, frontend, or billing. Grows revenue surface immediately. No new infrastructure needed. |
| **2** | **Telegram / alerting integrations** | ✅ Done | Low-lift (consumes existing journal events), useful for the operator *right now*, and doesn't depend on multi-user auth. Provides operational value during the rest of Phase 5 development. |
| **3** | **Broad auth (multi-user, OAuth, plans)** | ✅ Done | Foundation for everything user-facing. The frontend, billing, and agents all need multi-user identity. Currently the API uses a single operator token (§11.2). This must land before the frontend is useful to anyone beyond the operator. |
| **4** | **Frontend / dashboard** | ✅ Done | The authenticated web app now ships the core product surface: Mission Control, Activity Feed, Outcome Board, Exposure, Instances, Portfolios, Credentials, Venue Accounts, Billing, and Agents. The UI is no longer a future dependency for the rest of Phase 5. |
| **5** | **Billing** | ✅ Done | Multi-provider billing is now implemented end to end with API routes, provider abstractions, webhook handling, entitlement sync, plan-aware config, and a billing UI. This is no longer just future Stripe middleware. |
| **6** | **Agents and autonomous tool use** | 🟨 In progress | The repo now contains the first real Step 6 slice: agent CRUD and linking, protocol schemas, agent runtime/session/message/artifact persistence, worker-side broker/session/health/reconnect components, simple agent UI, and engine intake reuse. The lifecycle and context-integrity hardening work is largely landed. The current implementation path is now split cleanly between the MVP rollout plan in `docs/features/2026/06/005-agent-mvp-rollout-plan/001-mvp-delivery-plan.md` and the remaining canonical Step 6 completion track in `docs/features/2026/06/005-agent-mvp-rollout-plan/002-canonical-step-6-completion-track.md`. |

---

## Caveats

- **Venues (step 1) can run in parallel** with steps 2–3. They're orthogonal.
- **Agents (step 6) are no longer design-only** — the first implementation slice exists, and the narrow lifecycle and context-integrity patch is largely accounted for. The remaining work is now concentrated in the real runtime boundary and the autonomous-tooling path: container-backed launch, actual tool execution, hot-path enforcement, artifact-body handling, and rollout-grade operator surfaces.
- **Canonical technical references now exist** under `docs/tech/agents/` for the boundary, message catalog, recovery model, and sandbox policy. Phase 5 implementation work should treat those docs as the stable source of technical truth.
- **Use the new June rollout folder for planning work** — `docs/features/2026/06/005-agent-mvp-rollout-plan/001-mvp-delivery-plan.md` is the canonical MVP implementation order, and `docs/features/2026/06/005-agent-mvp-rollout-plan/002-canonical-step-6-completion-track.md` is the canonical tracker for what still blocks Step 6 from being called fully done.
- **Billing is implemented, but GTM decisions still matter**: whether it is enforced broadly on day one is now a rollout choice, not an implementation dependency.
- **Auth scope creep** is the main risk — "broad auth" can balloon. Scope it to: OAuth provider (Google/GitHub), JWT sessions, user→portfolio ownership, role-based route guards. Don't build a permission system until the second user type materializes.
