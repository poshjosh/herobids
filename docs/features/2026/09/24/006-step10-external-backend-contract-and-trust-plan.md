# Step 10 — External Backend Contract & Trust Plan

**Status:** plan (ready to implement). **Date:** 2026-10-02.
**Program:** [ENTRYPOINT](./000-program/ENTRYPOINT.md) · [PROGRESS](./000-program/PROGRESS.md) · [roadmap](./001-staging-first-external-backend-roadmap.md) · [DECISIONS](./000-program/DECISIONS.md)
**Governing:** [ADR 015](../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md) · **Builds on:** [Step 9 Discovery](./005-step9-external-backend-genericization-discovery.md)
**Scope (D12):** Phase 3 narrowed to Steps 10–13; Steps 14–16 deferred.

## Objective

Define the concrete design the Steps 11–13 code implements: the generic
`ExternalBackendDefinition` (operator registration record), the generic
`ExternalBackendClient` (renamed transport), the signed **External Backend
Descriptor** (trust artifact binding approved source-skill refs → backend-owned
tool schemas/instructions), and the trust lifecycle (verification, pinning,
rotation, revocation, failure). This is a design doc; it changes no code.

## Non-goals

- Removing herobids first-party trading (Step 14 — deferred).
- Moving/splitting the `trading/` domain modules (Step 15 — deferred).
- Any staging/infra mutation or the differential proof (Step 16 — deferred, infra-gated).
- Changing the on-the-wire **invocation** HMAC contract (must be preserved byte-for-byte; see §5).

## Design decisions taken here (engineering-decidable; low-stakes routed inline per operator)

- **DT1 — Descriptor signature = asymmetric (ed25519).** The backend holds a
  private signing key; herobids stores only public keys in the definition's
  `trustedDescriptorSigningKeys[]`. Rationale: herobids must be able to verify a
  backend's descriptor without holding a secret that could forge it — asymmetric
  keeps herobids a pure verifier. (Per-request *invocation* HMAC is unchanged; it
  is a separate, symmetric transport concern — see §5.)
- **DT2 — Invocation contract version + paths stay herobids-owned, fixed.** The
  `/internal/v1/tools:invoke` + status paths and envelope `contractVersion:'1.0'`
  remain a fixed private-invocation contract that every backend speaks. The
  descriptor does NOT redefine transport paths; it only supplies domain content
  (tools/instructions). Rationale: ADR-015 §6 keeps generic dispatch/transport in
  herobids; a backend owning transport paths would invert that. (Flagged in Step 9
  Crit 6 Q2 as borderline-product; recorded here as the engineering default — if
  legal/boundary review later wants per-backend endpoints, it is an additive
  change to `endpoint` on the definition, not a rework.)
- **DT3 — Descriptor-trust failure = graceful degradation to instruction-only.**
  An expired/untrusted/mismatched/revoked descriptor never crashes a session; the
  skill falls back to an ordinary skills.sh instruction package (no tools). This
  reuses the existing fail-closed philosophy (Step 9 Crit 4e).

## 1. `ExternalBackendDefinition` (operator registration record)

Generic transport + trust metadata ONLY (ADR-015 §3 — no domain
instructions/tool semantics/pricing/venue/risk). Proposed shape (new domain
type, Zod-validated at config load):

```ts
interface ExternalBackendDefinition {
  backendId: string;                     // stable identity, e.g. "traderton"
  endpoint: {
    baseUrl: string;                     // was boundary.baseUrl
    contractVersion: '1.0';              // fixed invocation contract (DT2)
  };
  caller: {                              // was boundary.consumerId/keyId
    consumerId: string;
    keyId: string;
    hmacSecretRef: string;               // reference/name, resolved from secret storage (NOT the secret)
  };
  health: {
    readyPath: string;                   // default "/health/ready"
    // gating thresholds reuse existing health policy
  };
  trustedDescriptorSigningKeys: Array<{  // ed25519 public keys (DT1)
    keyId: string;
    publicKey: string;                   // PEM/base64
    status: 'active' | 'retiring';       // overlap-window rotation (§4)
  }>;
  approvedSourceSkillRefs: string[];     // skills.sh refs this backend may deep-integrate (D11)
  descriptorPinning:
    | { mode: 'pinned'; sha256: string } // pin an exact descriptor digest
    | { mode: 'maxAge'; seconds: number }; // or cache with a max age
  enabled: boolean;
}
```

For Traderton (D11), `approvedSourceSkillRefs` =
`["traderton/skills/crypto-trading", "traderton/skills/crypto-bot-management",
"traderton/skills/crypto-risk-monitoring"]`.

**Config migration (Step 11 detail):** today a single `appConfig.boundary`
block (`config/schema.ts:1572`, env `TRADERTON_BOUNDARY_*`
`apps/api/src/config.ts:71-75`) feeds the one client. Target: an
`appConfig.externalBackends: ExternalBackendDefinition[]` **registry**. The
existing `boundary` block becomes the single `traderton` entry (back-compat not
required — greenfield D6 — but a one-entry registry keeps Step 11 mechanical).
The 5 client-construction sites become registry lookups by `backendId`.

## 2. `ExternalBackendClient` (generic runtime client)

Rename of `TradertonClient` (Step 9 Crit 1 — the dir is transport-only). No
behavior change: `build envelope → signInvoke (HMAC) → POST invoke → map/poll →
map terminal result`. Renames (mechanical, Step 11):

| From | To |
|---|---|
| `TradertonClient` | `ExternalBackendClient` |
| `createTradertonClient()` | `createExternalBackendClient()` |
| `TradertonClientConfig` | `ExternalBackendClientConfig` (built from a `ExternalBackendDefinition` + resolved secret) |
| `TradertonClientResult` | `ExternalBackendClientResult` |
| `@herobids/domain/traderton` subpath | `@herobids/domain/external-backend` |
| `contract.ts` `Traderton*` types + `TRADERTON_*` paths | `ExternalBackend*` / `EXTERNAL_BACKEND_*` |

The `TradingToolContext` boundary ports (`tradertonBoundary`,
`tradertonWriteBoundary`) rename to `externalBackend`/`externalBackendWrite`
(Step 11; the trading-specific ctx fields are untouched here — that is Step 14/15).

## 3. External Backend Descriptor (published by backend, verified by herobids)

Signed, versioned (ADR-015 §4). Proposed shape:

```ts
interface ExternalBackendDescriptor {
  descriptorVersion: string;             // monotonic, e.g. "2026-10-02.1"
  backendId: string;                     // must match the definition
  issuedAt: string;
  expiresAt: string;
  sourceSkills: Array<{
    ref: string;                         // must be in definition.approvedSourceSkillRefs
    instructions: string;                // backend-owned skill instructions
    tools: Array<{
      name: string;
      description: string;
      inputSchema: JsonSchema;           // backend-owned per-tool schema
      category: string;                  // generic capability tag (ADR-015 §7)
    }>;
  }>;
}
// Transport: { descriptor: <above, canonical JSON>, signature: <ed25519 over canonical bytes>, keyId }
```

**Verification pipeline (herobids side, Step 12):**
1. Resolve the `ExternalBackendDefinition` for the installed skill's source ref
   (ref ∈ `approvedSourceSkillRefs` AND `enabled`). No match → instruction-only.
2. Fetch/load the descriptor (per `descriptorPinning`).
3. Verify `signature` against a `trustedDescriptorSigningKeys[]` entry
   (`status` active or retiring) by `keyId`. Fail → reject (DT3).
4. Check `backendId` matches, `expiresAt` not past, pin digest matches (if pinned).
5. For each `sourceSkills[].ref` that matches the installed skill, expose its
   `tools` + `instructions` to the agent (feeds tool visibility, Step 12).

## 4. Key rotation & revocation

- **Descriptor signing key rotation (asymmetric, DT1):** operator adds the new
  public key as `status:'active'` and marks the old `status:'retiring'`; the
  backend republishes the descriptor signed by the new key; after cutover the
  operator removes the retiring key. Overlap window = both keys verify, so no
  outage. (A `set` of trusted keys makes this a config edit, not code.)
- **Invocation HMAC key rotation (symmetric, existing):** uses the existing
  `keyId` indirection on `caller`/`SigningIdentity` — add a new `keyId`+secret,
  flip `caller.keyId`, retire the old. Unchanged mechanism.
- **Revocation:** operator removes a signing key, removes a `approvedSourceSkillRefs`
  entry, or sets `enabled:false`. Effect (fail-closed): the descriptor becomes
  untrusted/unmatched → herobids strips that backend's tools from visibility on
  the next resolution; the skill degrades to instruction-only (DT3). No agent crash.

## 5. Invocation transport — UNCHANGED (hard constraint)

The per-request HMAC-SHA256 signing (`sign.ts`:
`buildCanonicalString` = `METHOD\nPATH\nX-Timestamp\nSHA256(body)`) and the 005
envelope/paths are the proven wire contract with the live Traderton boundary.
Step 11 **renames** these symbols but must preserve the exact bytes
(canonicalization, header names, body serialization). The descriptor trust layer
(§3/§4) is **additive and orthogonal** — it governs *which tools a skill may use*,
not *how an invocation is signed/sent*. Rationale: Phase-1 operational proof and
the Step-16 differential depend on byte-identical invocation behavior.

## 6. Failure behavior (reuse + extend)

- **Invocation failures (existing, unchanged):** content-level
  (validation/not_found/precondition) non-faulting; transport/in_progress/
  deadline retryable + circuit-break; writes fail-closed. (Step 9 Crit 4e.)
- **Descriptor-trust failures (new, DT3):** expired/untrusted/mismatched/revoked
  → skill degrades to instruction-only (no tools), logged, non-fatal. A backend
  being unreachable for descriptor refresh falls back to the last valid pinned/
  cached descriptor until `expiresAt`, then degrades.

## 7. Ordered implementation tasks (feed Steps 11–13)

**Step 11 (generic client migration) — mechanical, type-level (Step 9 Crit 2):**
1. Rename the `traderton/` dir + subpath export → `external-backend` (`@herobids/domain/external-backend`); rename the symbols per §2 table. Preserve `sign.ts` bytes (§5).
2. Add `ExternalBackendDefinition` + Zod schema in domain; add `appConfig.externalBackends[]` registry (keep the one `traderton` entry derived from today's `boundary` block + env).
3. Rewire the 5 construction sites + ~32 type-level importers to the generic names / registry lookup. Rename ctx ports `tradertonBoundary`→`externalBackend`.
4. Verify: `pnpm lint` + `pnpm --filter @herobids/api exec vitest run` + worker tests + full build. No behavior change expected (pure rename + config reshape).

**Step 12 (trust-gated deep integration):**
5. Implement the descriptor type (§3) + verification pipeline (ed25519, pinning, expiry, revocation) in domain + the resolution path that today hard-codes trading (`skills.ts`, `provider-catalog.ts`, `agent-runtime-descriptor.ts`, worker `agent.ts:473`/`runtime-composition.ts:700`/`agent-capabilities.ts:18`).
6. Replace the trading `if`-branches with: "skill ref matches an enabled definition + verified descriptor → expose descriptor tools; else instruction-only." (ADR-015 §5 — no `if (trading)`.)
7. Provide the gating target: register the Traderton definition (§1) + load its descriptor. For local/dev, a herobids-side **stub descriptor** carrying the current trading tool schemas keeps trading working through the generic path; Step 13 replaces the stub with the real Traderton-published, signed descriptor.
8. Verify: trading tools still resolve for an agent whose skills include the Traderton refs; a non-matching external skill gets no tools; revocation strips tools. Lint/build/tests green.

**Step 13 (Traderton skill publication):**
9. In `/Users/chinomso.ikwuagwu/dev_ai/traderton-skills/` (remote `github.com/traderton/skills`), author `SKILL.md` for `crypto-trading`, `crypto-bot-management`, `crypto-risk-monitoring` (frontmatter `name`+`description`; body = the backend-owned instructions, derived from the herobids seeds `TRADING_SKILL`/`BOT_MANAGEMENT_SKILL`/`RISK_MONITORING_SKILL` as source of truth).
10. Produce the signed descriptor (ed25519) binding the three refs → their tool schemas/instructions; wire the Traderton definition's `trustedDescriptorSigningKeys` + `approvedSourceSkillRefs` (D11). Replace the Step-12 stub.
11. **Push gate:** commit locally; do NOT push `traderton-skills` or `traderton` without operator approval (DECISIONS open item).
12. Verify end-to-end against the generic path.

## 8. Approval gates / open items (carried)

- **No infra mutation** in Steps 10–13 (all local code/docs + local commits).
- **Push gate:** `github.com/traderton/*` remotes — local commits only until approved.
- **Legal/product (deferred with Steps 14–15):** the `exports-traderton` route,
  `trading-profile-reconciliation-saga`, `traderton-operator-defaults` dispositions
  remain OPEN (Step 9 Crit 6 Q1) — not touched in this scope; they keep working.
- DT2 (fixed contract paths) is the engineering default; revisit only if
  legal/boundary review requires per-backend endpoints.

## 9. Exit criteria for Step 10

- [x] `ExternalBackendDefinition` shape defined (§1).
- [x] `ExternalBackendClient` rename map defined (§2).
- [x] Descriptor shape + verification pipeline defined (§3).
- [x] Rotation + revocation defined (§4).
- [x] Invocation transport preservation constraint stated (§5).
- [x] Failure behavior defined (§6).
- [x] Ordered tasks for Steps 11–13 (§7) + approval gates (§8).

Step 10 is complete on acceptance of this plan; Step 11 may begin.
