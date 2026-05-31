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

| Step | Item | Rationale |
|------|------|-----------|
| **1** | **Additional venues and chains** | Purely additive — extends the existing `OrderbookVenuePort`/`SwapVenuePort` adapter pattern without touching auth, frontend, or billing. Grows revenue surface immediately. No new infrastructure needed. |
| **2** | **Telegram / alerting integrations** | Low-lift (consumes existing journal events), useful for the operator *right now*, and doesn't depend on multi-user auth. Provides operational value during the rest of Phase 5 development. |
| **3** | **Broad auth (multi-user, OAuth, plans)** | Foundation for everything user-facing. The frontend, billing, and agents all need multi-user identity. Currently the API uses a single operator token (§11.2). This must land before the frontend is useful to anyone beyond the operator. |
| **4** | **Frontend / dashboard** | Depends on auth. Once multi-user is in place, a read-heavy dashboard (positions, journal, P&L) can ship incrementally. The backend already exposes the necessary data via API. |
| **5** | **Billing** | Depends on auth + plans. Only needed once there are multiple users to charge. Implementation is mostly third-party integration (Stripe) plus plan enforcement middleware. |
| **6** | **Agents and autonomous tool use** | Highest complexity and risk. Requires container isolation (§10.4), a message contract between agent and trading instance, egress control, resource caps, and a new trust boundary. Benefits from having auth, billing (token budgets), and alerting already in place. |

---

## Caveats

- **Venues (step 1) can run in parallel** with steps 2–3. They're orthogonal.
- **Agents (step 6) may need early design work** even if implemented last — the §10.4 container boundary and agent→instance message contract should be specified before the frontend ships, so the UI can accommodate agent management without a rewrite.
- **Billing positioning depends on GTM**: if early users are free-tier beta, billing can slide even later. If you need revenue gates before opening up, it moves ahead of the frontend.
- **Auth scope creep** is the main risk — "broad auth" can balloon. Scope it to: OAuth provider (Google/GitHub), JWT sessions, user→portfolio ownership, role-based route guards. Don't build a permission system until the second user type materializes.