# Epic Index — "Remove the parity-drift check entirely"

**Objective (single):** delete `scripts/parity-drift-manifest.json`,
`scripts/check-parity-drift.mjs` (+ its test), and the `parity-drift` CI job from
**both** herobids and traderton — by resolving the duplication behind every manifest
entry, not by weakening the check.

**Stakeholders:** just us (the human + the agent). No external team. "Human go" gates in
the older 2026-10-04 docs are ours to lift.

## Ordered execution table

| Order | Item | Repo | Doc | Status |
|---|---|---|---|---|
| 1 | **A** — Parity Track A (drop dead herobids copies) | herobids | `docs/features/2026/10/10/001-eliminate-parity-check/000-roadmap.md` | ✅ done |
| 2 | **B** — Parity Track B (risk defaults, health, capability) | herobids | same | ✅ done |
| 3 | **C** — Parity Track C (`@poshjosh/contracts` carve-out) | both | same | ✅ done |
| 4 | **E1-H, E3-H** — Wave E herobids halves | herobids | `traderton/docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/000-overview.md` | ⏳ next |
| 5 | **S1–S9** — Preset assessment → Traderton (data-only) | traderton | `traderton/docs/features/2026/10/04/004-preset-assessment-data-only/001-plan.md` | planned |
| 6 | **H1–H6** — Preset assessment → Traderton (herobids side) | herobids | `herobids/docs/features/2026/10/04/002-preset-assessment-on-traderton/001-plan.md` | planned |
| 7 | **D** — Parity Track D (drop the last 9 entries) | herobids | `docs/features/2026/10/10/001-eliminate-parity-check/000-roadmap.md` | blocked on 4–6 |
| 8 | **C6** — Delete checker + manifest + test + CI job | both | same | blocked on 7 |

## Independent / parallel (not on the critical path)

| Item | Repo | Doc | Status |
|---|---|---|---|
| **E4** — Agent-actor lease + routing | traderton | `docs/features/2026/10/04/002-agent-actor-lease-and-routing/001-plan.md` | after E1 |
| **E5** — Journal retention | traderton | `docs/features/2026/10/04/003-journal-retention/001-plan.md` | independent |

## The unblocking chain

```
[now]  Tracks A/B/C done — manifest 28 → 9 entries
   ↓
E1-H + E3-H   (Wave E herobids halves)
   ↓
S1–S9         (traderton preset-assessment)
   ↓
H1–H6         (herobids preset-assessment — deletes the preset YAMLs,
               market-assessment.ts, scanner-types.ts, config/*)
   ↓
D2            (drop the last 9 manifest entries + finish PriceCandle residue)
   ↓
C6            (delete checker + manifest + test + CI job in both repos)
```

## The 9 remaining manifest entries (all blocked on the chain above)

`strategy-preset-economy`, `strategy-preset-premium`, `strategy-preset-standard`,
`domain-config-presets-loader`, `domain-config-presets`,
`domain-config-strategy-parameters`, `domain-market-assessment`, `domain-scanner-types`,
`domain-ports-candle-fetcher`.

## Detailed ledger

Per-sub-step evidence (commits, validation, residual risks) lives in
`docs/features/2026/10/10/001-eliminate-parity-check/EXECUTION_LEDGER.md`.