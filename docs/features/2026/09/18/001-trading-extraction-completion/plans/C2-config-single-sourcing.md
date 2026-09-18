# Plan C2 (CONTINGENT on B1=(ii) + B2): Config & catalog single-sourcing

- **Task:** C2 — the B2 follow-through enabled by B1=(ii): make traderton the single authority for operator risk defaults; add drift-parity scripts for the copies that legitimately remain.
- **Repo:** both (mostly herobids consumption changes + scripts)
- **Status:** **CONTINGENT PLAN** — activates only if B1=(ii) and B2's "parity scripts + follow-B1" recommendation are accepted. If B1=(i), only the parity-script half (C2.3) activates, as a standalone Track-A item.
- **Prereq:** B1 ADR, B2 decision; C1 (profile store) for the authority swap.

## Parts

### C2.1 — Operator risk defaults authority (B1=(ii) only)

- traderton: expose `get_operator_defaults` as a boundary read (owner-scoped, read-only) returning the `agentRiskDefaults` block (17 fields) — the same values its gate/clamp math uses.
- herobids: `GET /agents/risk-defaults` (web auto-fill source) re-points to the boundary read with a cache (TTL hours; defaults rarely change). API create/update validation drops its local `agentRiskDefaults` enforcement in favour of the boundary's typed errors from `set_agent_trading_profile` (C1) — one authority, errors at the point of enforcement.
- herobids: `config/default.yaml` `agentRiskDefaults:` block marked display-fallback with a comment pointing at the boundary source; removed from enforcement paths.

### C2.2 — Risk-contract math retirement (B1=(ii) only)

- With A6-4 (fallback deletion) executed via C1's echo retirement, herobids' `agent-risk-limits.ts` + `agent-risk-limits-contracts.ts` lose their last runtime consumer → delete both + their parity tests (traderton keeps the live copies). This lands as the tail of C1's herobids list; C2 records it rather than re-plans it.

### C2.3 — Parity-drift scripts (activate regardless of B1)

- A small script per repo (or one shared under `scripts/`) that compares, across repos, the **verbatim-duplicated** files/blocks and fails loudly on drift:
  - `agentRiskDefaults` YAML block (herobids vs traderton `config/default.yaml`)
  - `config/strategy-presets/*.yaml` (3 files)
  - mirrored type/parse layers: `watch-types.ts`, `scan-types.ts`, `tick-gates.ts` session-hours table, `trading/*` domain modules
- Wire into each repo's test gate as a slow-tier check (needs both repos checked out side-by-side — the xstack harness already assumes sibling layout; skip gracefully when the sibling is absent).
- Purpose: converts today's *silent* divergence risk into CI-red. This is B2's recommendation (b) independent of ownership outcomes.

## Steps

1. C2.3 first (decision-free): script + gate wiring both repos.
2. C2.1 on B1=(ii): boundary read tool → herobids endpoint re-point → local enforcement removal.
3. C2.2 as C1's tail: delete retired math + parity tests; audit §2/§3.1 rows annotated.

## Verification

- C2.3: deliberately drift one field in a scratch branch → script fails; restore.
- C2.1: web auto-fill still populates (boundary-sourced); create-agent with out-of-ceiling risk value gets the boundary's typed error (not a local pre-check).
- Full suites + A8 gate (echo-off leg).

## Risks

- Parity script sibling-repo assumption in CI environments that check out one repo alone — must skip-not-fail there.
- Endpoint re-point adds a boundary dependency to a read previously local — acceptable (trading UI already boundary-gated), but note for the availability matrix.

## References

- `decisions/B2-duplicated-authority.md`; `plans/C1-trading-profile-slice.md`; audit §3.3, §5.3
