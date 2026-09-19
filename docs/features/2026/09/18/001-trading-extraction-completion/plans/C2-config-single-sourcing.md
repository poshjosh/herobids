# Plan C2: Config & catalog single-sourcing

- **Task:** C2 — the B2 follow-through enabled by B1=(ii): make traderton the single authority for operator risk defaults; add drift-parity scripts for the copies that legitimately remain.
- **Repo:** both (mostly herobids consumption changes + scripts)
- **Status:** **REVIEW-CORRECTED; PENDING IMPLEMENTATION AUTHORIZATION** — ADRs 010 and 011 ratify the authority split. C2.3 may start after authorization; C2.1 and C2.2 follow verified C1.
- **Prereq:** ADRs 010 and 011; C1 (profile store) for the authority swap; independent review complete.

## Parts

### C2.1 — Operator risk defaults authority (B1=(ii) only)

- traderton: expose `get_operator_defaults` as a boundary read (owner-scoped, read-only) returning the `agentRiskDefaults` block (17 fields) — the same values its gate/clamp math uses.
- herobids: `GET /agents/risk-defaults` (web auto-fill source) re-points to the boundary read with a cache (TTL hours; defaults rarely change). API create/update validation drops its local `agentRiskDefaults` enforcement in favour of the boundary's typed errors from `set_agent_trading_profile` (C1) — one authority, errors at the point of enforcement.
- herobids: `config/default.yaml` `agentRiskDefaults:` block marked display-fallback with a comment pointing at the boundary source; removed from enforcement paths.

### C2.2 — Risk-contract math retirement (B1=(ii) only)

- With A6-4 (fallback deletion) executed via C1's echo retirement, herobids' `agent-risk-limits.ts` + `agent-risk-limits-contracts.ts` lose their last runtime consumer → delete both + their parity tests (traderton keeps the live copies). This lands as the tail of C1's herobids list; C2 records it rather than re-plans it.

### C2.3 — Parity-drift scripts (activate regardless of B1)

- Add one versioned mirror manifest that enumerates every exact source path or
  YAML region, its normalization rule, and its authority classification. Globs
  and a catch-all `trading/*` entry are forbidden. The initial manifest covers
  the `agentRiskDefaults` block, all three strategy presets, `watch-types.ts`,
  `scan-types.ts`, the `tick-gates.ts` session-hours table, and each identified
  mirrored trading domain module.
- Add an assertion-only checker and thin wrappers in both repositories. It
  compares the manifest entries byte-for-byte after their declared normalization;
  it never imports, copies, generates, or supplies runtime configuration.
  `agentRiskDefaults` names traderton as its canonical authority; strategy
  preset entries remain `mirror-only` until B4 decides their product authority.
- Local runs may report `SKIPPED` when the sibling checkout is absent. The
  protected CI job must check out both named repository revisions and fails if a
  sibling or a manifest entry is missing; it may not skip. Wire that job into
  both repositories' slow test tier.
- The protected workflow pairs are source `${{ github.sha }}` plus an explicitly
  pinned sibling revision: the Herobids workflow checks Traderton
  `485c31c16180d30cf77fe330bf84e4a1c26b06da`; the Traderton workflow checks
  Herobids `250dd60b37603105b2028b93972ec54fa5c06d33`. Thus the committed
  bidirectional comparison pair is Herobids
  `250dd60b37603105b2028b93972ec54fa5c06d33` with Traderton
  `485c31c16180d30cf77fe330bf84e4a1c26b06da`. Never use a moving branch
  reference. When an intentional parity change needs a new comparison pair,
  update both workflow pins together and record the new pair in the C2.3
  execution ledger entry.
- Purpose: converts today's *silent* divergence risk into CI-red without
  creating a second runtime authority. This is B2's recommendation (b)
  independent of ownership outcomes.

## Steps

1. C2.3 first (decision-free): script + gate wiring both repos.
2. C2.1 on B1=(ii): boundary read tool → herobids endpoint re-point → local enforcement removal.
3. C2.2 as C1's tail: delete retired math + parity tests; audit §2/§3.1 rows annotated.

## Verification

- C2.3: deliberately drift one manifest field in a scratch branch → local and
  protected-CI mode both fail; restore. Confirm that a missing sibling skips
  locally but fails in CI mode, and that no checker output is consumed at runtime.
- C2.1: web auto-fill still populates (boundary-sourced); create-agent with out-of-ceiling risk value gets the boundary's typed error (not a local pre-check).
- Full suites + A8 gate (echo-off leg).

## Risks

- The local sibling-repo assumption is intentional; protected CI must instead
  provision both repositories and fail closed when it cannot.
- Endpoint re-point adds a boundary dependency to a read previously local — acceptable (trading UI already boundary-gated), but note for the availability matrix.

## References

- `decisions/B2-duplicated-authority.md`; `plans/C1-trading-profile-slice.md`; audit §3.3, §5.3
