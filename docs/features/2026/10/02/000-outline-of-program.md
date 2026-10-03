# OUTLINE OF PROGRAM

## Program home (governance — all phases)
- `docs/features/2026/09/24/` — the program root. Roadmap + per-step plans live here.
  - `docs/features/2026/09/24/000-program/` — the governing docs (ENTRYPOINT, PROGRESS, DECISIONS) that drive **all phases**.
  - `001-staging-first-external-backend-roadmap.md` — the 16-step / 3-phase master plan.
  - `002-...` / `003-...` / `004-...` — Phase 1 & 2 infra plans (staging recovery, Traderton staging infra, Traderton production infra).
  - `005-step9-...discovery.md`, `006-step10-...plan.md` — the **Phase 3** step plans I've written so far.

## Governing architecture decision
- `docs/tech/architecture/adrs/2026/09/` — specifically `015-external-backend-skill-registration.md` (the ADR that governs Phase 3).

## Phase 2 (frontend/backend trading separation)
- `docs/features/2026/10/01/004-phase2-program/` — the Phase 2 program folder (its own ENTRYPOINT/DECISIONS/TASKS/RECONCILIATION/ESCALATIONS).
- `docs/features/2026/10/` — the supporting Phase 2 docs around it:
  - `003-frontend-trading-coupling-audit.md`
  - `005-backend-trading-coupling-audit.md`
  - `006-phase2-completion-note.md`
  - `007-frontend-trading-text-inventory.md`
  - `008-orphan-i18n-key-sweep.md`
  - `009-skill-first-agent-creation/` (the create-flow change)

## Phase 3 normative inputs (background the roadmap/ADR reference)
- `docs/features/pending/000-capability-foundations/` — the capability/external-backend design corpus (e.g. `008-cross-service-capability-execution-design.md`, `013-native-capabilities-and-external-backends.md`, `016-mcp-registration-layer.md`).

## Phase 3 (generic External Backend + MCP transport)
- `docs/features/2026/10/02/005-phase3-program/` — the **Phase 3 program folder**
  (ENTRYPOINT / TASKS / DECISIONS / INVARIANTS / SEAM / ESCALATIONS). This is
  where the autonomous Phase-3 run is driven from. Start at its ENTRYPOINT.
- `docs/tech/architecture/adrs/2026/10/016-mcp-as-external-backend-transport.md` —
  **ADR 016**, which supersedes ADR 015 §8: MCP becomes the invocation transport
  for platform-managed External Backends, built in Phase 3 alongside REST.
- `.github/skills/external-backend-genericization/SKILL.md` — the file:line map,
  signing contract, seam, MCP mapping, traps and verification commands.

## Related (created this session, not strictly "the program")
- `docs/tech/mcp-vs-custom/` — the MCP-vs-custom-backend comparison doc.
  **Superseded on its transport recommendation by ADR 016**; its trust-layer
  analysis survives as D16. Read §§1–5; do not act on §6.
- `docs/tech/trading/audits/2026/09/001-herobids-trading-logic-ownership-audit.md` — the ownership audit that fed Phase 3 discovery.

**The one-stop entry point for everything:** `docs/features/2026/09/24/000-program/ENTRYPOINT.md` — it links the roadmap, PROGRESS tracker, DECISIONS, and the ADR.

## Useful context

herobids -> docs/features/2026/10/02/001-context.md