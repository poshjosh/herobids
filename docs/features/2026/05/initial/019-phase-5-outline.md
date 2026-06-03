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
| **4** | **Frontend / dashboard** | ⬜ Next | Depends on auth (now complete). The backend already exposes the necessary data via API. UI should be designed **agent-first** (see `docs/features/2026/06/002-phase-5e-frontend-dashboard/000-frontend-q-and-a.md`): Agent Overview → Activity Feed → Outcome Board → Portfolio/Exposure View. Do not lead with charts or exchange jargon. Bake agent management surfaces in from day one so the UI doesn't need a rewrite when agents ship. |
| **5** | **Billing** | ⬜ Not started | Depends on auth + plans (both done). Only needed once there are multiple users to charge. Implementation is mostly third-party integration (Stripe) plus plan enforcement middleware. Can slide further if early users are free-tier beta. |
| **6** | **Agents and autonomous tool use** | ⬜ Not started | Highest complexity and risk. Requires container isolation (§10.4), a message contract between agent and trading instance, egress control, resource caps, and a new trust boundary. Benefits from having auth, billing (token budgets), and alerting already in place. **Design the agent→instance contract before the frontend ships** — even if implementation is last — so the frontend's agent management surfaces don't need a structural rewrite. |

---

## Caveats

- **Venues (step 1) can run in parallel** with steps 2–3. They're orthogonal.
- **Agents (step 6) may need early design work** even if implemented last — the §10.4 container boundary and agent→instance message contract should be specified before the frontend ships, so the UI can accommodate agent management without a rewrite.
- **Canonical technical references now exist** under `docs/tech/agents/` for the boundary, message catalog, recovery model, and sandbox policy. Phase 5 implementation work should treat those docs as the stable source of technical truth.
- **Billing positioning depends on GTM**: if early users are free-tier beta, billing can slide even later. If you need revenue gates before opening up, it moves ahead of the frontend.
- **Auth scope creep** is the main risk — "broad auth" can balloon. Scope it to: OAuth provider (Google/GitHub), JWT sessions, user→portfolio ownership, role-based route guards. Don't build a permission system until the second user type materializes.