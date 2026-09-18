# Decision Brief B2: Duplicated authority — single-source vs continued parity duplication

- **Question:** `agentRiskDefaults` (17 operator fields incl. maxBots), the strategy-preset catalogs (3 YAML files), the risk-contract math (`agent-risk-limits.ts` ↔ traderton), and the watch/scan/gate type layers exist **verbatim in both repos**. Single-source them, or keep the parity-duplication architecture?
- **Status:** OPEN — pre-loaded for chat. Partially gated on B1 (risk math + `agentRiskDefaults` follow the B1 outcome; preset catalogs and type layers are independent).
- **Evidence:** audit §3.1, §3.3, §5.3; both repos' parity tests (`agent-risk-limits.parity.test.ts` exists on both sides).

## Why the duplication exists (and its virtue)

This is **deliberate parity architecture**, not accident: the extraction copied modules byte-identical so behaviour could be verified equal, and parity tests pin them. It gives herobids offline form-validation (API can reject a bad risk value without a boundary call) and keeps the wire contract drift-checked. Deleting it blindly would trade a working verification mechanism for a coupling we'd immediately need to reinvent.

## The duplication map

| Duplicated item | Consumers herobids-side | If single-sourced to traderton, herobids loses | Notes |
|---|---|---|---|
| `agentRiskDefaults` (config + schema) | API create/update validation, web auto-fill (risk-defaults endpoint), worker ceilings | offline validation + one round-trip per form | B1-linked: with profile-at-bind, validation moves to the boundary call's typed errors |
| Strategy-preset catalogs (economy/standard/premium YAML) | API preset resolver, worker assessor, form selector | offline preset listing | traderton reads its own copy for execution; herobids' assessor *generates* assessments — see B3/B4 for whether assessment even stays |
| Risk-contract math (`agent-risk-limits.ts`) | in-process `get_risk_limits` fallback (A3/A6-gated) + parity tests | the fallback itself | B1-linked: with profile (ii), this whole module + its herobids parity tests retire |
| Watch/scan/gate type layers (`watch-types`, `scan-types`, `tick-gates` state) | runtime loop, watch parsing, session gate | type compatibility with boundary payloads | wire-DTO layer — duplication here is the *contract*, similar to the boundary envelope types; single-sourcing means generating one from the other (codegen) — heavy |

## Options

**(i) Keep parity duplication everywhere.** Zero work; drift risk caught by parity tests (they exist and run in both suites). Cost: two operator surfaces forever — editing a risk ceiling means editing two YAMLs (or the values silently diverge; nothing today *enforces* the two `default.yaml` copies match).

**(ii) Single-source per item (RECOMMENDED, split):**
- `agentRiskDefaults`: **follow B1.** If B1=(ii) profile: traderton becomes the authority; herobids keeps a read-only display copy fetched once for form auto-fill (or the boundary exposes a `get_operator_defaults` read tool and herobids caches it). If B1=(i): add a **cross-repo parity test** (a small script-level check comparing the two YAML blocks) instead of structural single-sourcing — cheap drift alarm.
- Risk-contract math: retire with the A3/A6 outcome (B1-linked).
- Preset catalogs: **pending B3/B4** (if assessment stays platform-side, catalogs are platform data and the duplication is herobids-as-source-of-truth with traderton holding execution copies — acceptable, pinned by a parity script; if assessment moves, catalogs move).
- Watch/scan/gate type layers: **keep as wire contract** (like the boundary envelope). Duplication here is interface, not authority. Optionally a parity script asserting the mirrored files match.

**(iii) Single monorepo/codegen:** rejected as out of proportion — both repos are independent deployments by design.

## Recommendation

(ii), executed incrementally: (a) if B1=(ii) → `agentRiskDefaults` + risk math resolve naturally; (b) regardless of B1 → add **file-level parity scripts** for the remaining verbatim copies (`agentRiskDefaults` YAML block, preset catalogs, mirrored type files) that fail CI on drift — converts silent divergence into a loud error for near-zero cost; (c) preset catalog fate deferred to B3/B4.

## Open questions for the chat session

1. B1-linked items: accept "resolve with B1" or decide independently now?
2. Parity scripts (b): agree to add? (Small Track-A-eligible work, no decision dependency.)
3. Preset catalogs: keep pending-B3, or decide now?
