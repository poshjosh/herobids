# Step 10 — External Backend Contract & Trust Plan

**Status:** plan (ready to implement). **Date:** 2026-10-02. **Revised:** 2026-10-02 (ADR 016), 2026-10-03 (P3-3 descriptor encoding).
**Program:** [ENTRYPOINT](./000-program/ENTRYPOINT.md) · [PROGRESS](./000-program/PROGRESS.md) · [roadmap](./001-staging-first-external-backend-roadmap.md) · [DECISIONS](./000-program/DECISIONS.md)
**Governing:** [ADR 015](../../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md) + [ADR 016](../../../../tech/architecture/adrs/2026/10/016-mcp-as-external-backend-transport.md) · **Builds on:** [Step 9 Discovery](./005-step9-external-backend-genericization-discovery.md)
**Scope (D12 as amended by D14):** Phase 3 = Steps 10–13 **plus** the transport
seam, `McpTransport`, and a Traderton MCP server surface. Steps 14–16 deferred.
**Execution:** driven by the Phase-3 program package
[`docs/features/2026/10/010-phase3-program/`](../../10/010-phase3-program/ENTRYPOINT.md).

> **Revision note (2026-10-02, ADR 016).** This plan was written while D4 ("MCP
> deferred") stood. ADR 016 supersedes ADR 015 §8 and makes MCP the target
> invocation transport, built in Phase 3 (D13/D14). The changes to this document
> are: **DT2 reframed** (herobids owns the protocol SET, a backend picks one);
> **DT4 added** (descriptor is the sole schema authority); **DT5 added** (the MCP
> wire mapping); **§2 extended** with the transport seam; **§5 narrowed** (the
> REST bytes stay frozen; MCP is additive); **§7 extended** with the seam,
> `McpTransport`, the CF-1 fix and the Step-13 fixture correction. The
> construction-site count is corrected from 5 to **6 across 3 files**.

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
- **DT2 — herobids owns the protocol SET; a backend picks one from it.**
  *(Reframed 2026-10-02 per ADR 016 §Decision 1–2. Originally: "paths stay
  herobids-owned, fixed".)* herobids defines the available transports and their
  contracts; a backend selects one via its definition. A backend may NOT invent
  its own transport, and the descriptor still does NOT redefine transport — it
  only supplies domain content (tools/instructions). Rationale: ADR-015 §6 keeps
  generic dispatch/transport in herobids, and a protocol set preserves that while
  admitting MCP. Envelope `contractVersion:'1.0'` is unchanged. The REST contract
  keeps its `/internal/v1/tools:invoke` + status paths, frozen per §5.
- **DT3 — Descriptor-trust failure = graceful degradation to instruction-only.**
  An expired/untrusted/mismatched/revoked descriptor never crashes a session; the
  skill falls back to an ordinary skills.sh instruction package (no tools). This
  reuses the existing fail-closed philosophy (Step 9 Crit 4e).
- **DT4 — The verified descriptor is the SOLE authority for tool schemas.**
  *(Added 2026-10-02; ADR 016 §Decision 4, D16.)* `name`, `description`,
  `inputSchema` and `category` come from the verified descriptor and nowhere
  else. A backend's MCP `tools/list` is cross-checked against the descriptor or
  ignored; it is NEVER a schema source. Disagreement is a trust failure → DT3.
  Rationale: MCP tool descriptions enter the model context directly, so an
  unverified `tools/list` from an order-placing backend is a tool-poisoning
  surface. This is also what makes §3's visibility path transport-independent —
  a later transport change touches only the invocation path, never Step 12.
  Structurally cheap: the descriptor's `tools[]` already maps 1:1 onto
  `ToolDefinition { name, description, inputSchema, promptGuidance? }`
  (`packages/domain/src/trading/tool-contract.ts:335`), which
  `packages/llm/src/llm-provider.ts:51` consumes.
- **DT5 — MCP wire mapping = native tools.** *(Added 2026-10-02; ADR 016
  §Decision 5, D15.)* See §2.5. Rejected alternative: an envelope tunnel (one
  opaque MCP tool carrying the 005 envelope) — unusable by any third-party MCP
  client, so it forfeits the interoperability that motivates ADR 016, and it
  leaves the transport seam unvalidated.

## 1. `ExternalBackendDefinition` (operator registration record)

Generic transport + trust metadata ONLY (ADR-015 §3 — no domain
instructions/tool semantics/pricing/venue/risk). Proposed shape (new domain
type, Zod-validated at config load):

```ts
interface ExternalBackendDefinition {
  backendId: string;                     // stable identity, e.g. "traderton"
  endpoint: {
    baseUrl: string;                     // was boundary.baseUrl
    contractVersion: '1.0';              // invocation envelope version (DT2)
    // The transport this backend speaks, chosen from the herobids-owned
    // protocol set (DT2). Default 'rest'. REST stays the staging/production
    // default until D10's differential is satisfied (D19).
    protocol: 'rest' | 'mcp';
    // Optional per-tool override, so a cutover is config rather than code.
    // Absent = every tool uses `protocol`.
    toolProtocolOverrides?: Record<string, 'rest' | 'mcp'>;
    // Path of the MCP endpoint when `protocol`/an override is 'mcp'.
    mcpPath?: string;                    // e.g. "/mcp"
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
    publicKey: string;                   // PEM SPKI (§3 "Canonicalization and encoding", P3-3)
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

**The client-construction sites become registry lookups by `backendId`. There are
6, across 3 files** (corrected 2026-10-02; §1 and §7 previously said 5, and Step 9
Crit 2A listed `apps/api/src/routes/exports.ts` — line 348 there is a COMMENT,
not a construction):

| File | Lines |
|---|---|
| `apps/worker/src/index.ts` | 440, 468, 502, 794 |
| `apps/worker/src/agent.ts` | 938 |
| `apps/api/src/index.ts` | 198 |

## 2. `ExternalBackendClient` (generic runtime client)

Rename of `TradertonClient` (Step 9 Crit 1 — the dir is transport-only). No
behavior change on the REST path: `build envelope → signInvoke (HMAC) → POST
invoke → map/poll → map terminal result`. Renames (mechanical, Step 11):

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

### 2.4 The transport seam (added 2026-10-02; ADR 016 §Decision 2, D14)

```
ExternalBackendClient   ← orchestration, implemented ONCE:
                          envelope construction, idempotency, deadlines,
                          health gating, retry, audit/correlation, result mapping
        │
        ├── RestTransport   POST /internal/v1/tools:invoke  + HMAC   (frozen, §5)
        └── McpTransport    POST <mcpPath>  tools/call  + HMAC       (additive)
```

Rules:
- The seam interface is **internal to `packages/domain/src/external-backend/`
  and is NOT exported** from the package subpath. Redirecting it later must not
  be a breaking change for its ~32 type-level importers.
- A transport only translates the request format and returns a result or a typed
  failure. It owns no idempotency, no retry policy, no deadline arithmetic and no
  result mapping — those stay above the seam, so a transport swap cannot change
  them.
- Both `requestId` and `idempotencyKey` are **first-class seam inputs on every
  transport**. A seam that drops them bakes the CF-1 defect into the abstraction
  (see §7 Step 0) and makes DT5's `in_progress` resolution impossible.
- Both transports are built in Phase 3 (D14). `protocol` defaults to `rest` and
  stays `rest` in staging/production until D10 is satisfied (D19).

### 2.5 MCP wire mapping (DT5 / D15 / ADR 016 §Decision 5)

| 005 envelope field | Where it travels under MCP |
|---|---|
| `toolName` | `tools/call` → `params.name` |
| `payload` | `tools/call` → `params.arguments` |
| `contractVersion`, `requestId`, `idempotencyKey`, `correlationId`, `issuedAt`, `deadlineAt`, `caller`, `subject` | `params._meta` |

- **Signature:** `POST\n<mcpPath>\n<X-…-Timestamp>\nSHA256(body)` where `body`
  is the ENTIRE JSON-RPC frame including `params._meta`. Method and path become
  constants; the body hash already covers the JSON-RPC method, tool name,
  arguments and metadata. `buildCanonicalString`, the header set and the
  lowercase-hex HMAC are unchanged in shape — the REST module is REUSED, not
  refactored (§5).
- **Header↔body assertions retained.** The backend still asserts
  `caller.consumerId`, `caller.keyId` and `deadlineAt` match the headers, reading
  them from `params._meta` instead of the body root.
- **`tools/list`** is served verbatim from the signed descriptor on the backend
  side, via the low-level MCP `Server` (D17). It exists for third-party clients
  and as a cross-check surface. It is never a schema source (DT4).
- **Failures RETURN, never throw.** `tools/call` returns `isError: true`
  carrying the 005 failure envelope in `structuredContent`, so the closed
  `TradertonBoundaryFailureCode` union survives. On a low-level MCP server a
  thrown handler error surfaces as a JSON-RPC protocol error and the union is
  lost. Protocol errors are reserved for pre-dispatch framing failures.
- **`in_progress` needs no status endpoint on the MCP path.** Re-issuing
  `tools/call` with the same `idempotencyKey` resolves both cases: the backend's
  idempotency store returns the stored terminal result for a completed
  invocation and an in-progress indication for a running one. **This depends on
  a STABLE idempotency key** — hence §7 Step 0 runs first.
- **The Tasks extension is NOT adopted** (experimental). Revisit when stable.
- **Client timeout** must be driven from the envelope's `deadlineAt` per call.
  The MCP TS SDK client defaults to a 60s per-request timeout; leaving it at the
  default would silently override the contract's deadline semantics.

**Two spike gates before any MCP implementation:**
1. **`params._meta` must be inside the request bytes the client signs.** If the
   SDK serializes it where a signing middleware cannot see it, or omits it from
   the body, the signature does not cover the envelope and DT5 fails — STOP and
   re-open ADR 016. Prove by signing and verifying `initialize`, any
   SDK-originated notification, AND `tools/call`.
2. **Coexistence.** The MCP route mounted on the backend's existing app with the
   existing invocation-contract tests passing UNMODIFIED and the raw-body
   retention untouched.

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

**Canonicalization and encoding (clarified 2026-10-03, P3-3).** Resolves
"canonical JSON" above, §1's `publicKey` encoding (formerly "PEM/base64") and
§1's `maxAge`, which were undefined:
- **Canonical JSON = RFC 8785 (JCS):** object keys sorted recursively by UTF-16
  code units (JS default `sort()`), no insignificant whitespace, arrays in order,
  primitives serialized exactly as ECMAScript `JSON.stringify`, encoded UTF-8.
  Value domain: objects, arrays, strings, booleans, `null`, integers within
  ±(2^53−1); no non-integer numbers in descriptors. For this domain a recursive
  sorted-key `JSON.stringify` **is** JCS.
- **Transport wrapper** = `{ descriptor: <object>, signature, keyId }`.
  `signature` = base64 (RFC 4648 §4, padded) of the 64-byte ed25519 signature over
  `UTF-8(JCS(descriptor))`. Wrapper formatting and key order are not signed and
  are irrelevant. (Rejected: carrying the descriptor as a pre-canonicalized
  string — robust, but diverges from the text above, is worse to review/diff in
  traderton-skills, and the verifier must canonicalize for the pin digest anyway.)
- **`keyId` selects exactly one** `trustedDescriptorSigningKeys[]` entry with
  `status` `active` or `retiring`; there is no try-every-key fallback. keyIds are
  unique within `trustedDescriptorSigningKeys` (rejected at config load);
  rotation always introduces a new keyId.
- **`publicKey` = PEM SPKI** (`-----BEGIN PUBLIC KEY-----`).
- **Pin digest** (`descriptorPinning.sha256`) = lowercase hex sha256 of
  `UTF-8(JCS(descriptor))`.
- **`descriptorPinning.maxAge.seconds`** bounds how long a fetched, verified
  descriptor may be served from cache (age measured from fetch/verification
  time); it is NOT a check against `issuedAt` — validity is
  `issuedAt ≤ now < expiresAt`.
- **`tools/list` cross-check (DT4/D16) — proposed; normative when T2.2/T3.2
  implement:** a backend's `tools/list` agrees with the descriptor ⇔ its tool-name
  set equals the union of the descriptor's `sourceSkills[].tools` names, and per
  tool `description` is string-equal and `inputSchema` is JCS-equal. Duplicate
  listed names disagree; compare after exhausting `nextCursor` pagination; other
  Tool fields (`title`, `annotations`, `outputSchema`, `_meta`) are not compared.
  `category` is not compared (MCP `tools/list` has no such field). Any
  disagreement → instruction-only (DT3).

The Phase-3 descriptor conformance fixtures (Phase 3 `SEAM.md §3.2`) pin these
rules as data in both repos. Each variant's `expected.outcome` and
`expected.reason` are normative: T3.1 adopts these reason codes as-is.

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

## 5. REST invocation bytes — FROZEN (hard constraint)

*(Narrowed 2026-10-02 per ADR 016. Originally "Invocation transport — UNCHANGED";
MCP is now an additional transport, but the REST path's bytes are unchanged.)*

The per-request HMAC-SHA256 signing (`sign.ts`:
`buildCanonicalString` = `METHOD\nPATH\nX-Timestamp\nSHA256(body)`) and the 005
envelope/paths are the proven wire contract with the live Traderton boundary.
Step 11 **renames** these symbols but must preserve the exact bytes
(canonicalization, header names, body serialization). Rationale: Phase-1
operational proof and the Step-16 differential (D10) depend on byte-identical
REST invocation behavior.

Two things are **additive and orthogonal** to this:
- **The descriptor trust layer (§3/§4)** governs *which tools a skill may use*,
  not *how an invocation is signed/sent*.
- **`McpTransport` (§2.4/§2.5)** is a second transport behind the seam. It
  **REUSES** `buildCanonicalString` and the header set unmodified; it does not
  refactor them. **If a change to `sign.ts` appears necessary for MCP's benefit,
  that is a signal to STOP and re-open ADR 016** — not to edit the module.

**Acceptance test for §5:** the step-0 shared signing vectors (§7) plus the
existing `sign.test.ts` must pass UNMODIFIED after the rename. Note that
`sign.test.ts:28-36` currently hand-replicates the backend verifier inline and
claims "if it verifies against this replica, it verifies against the real
`authenticateRequest`" — that claim is **unfalsifiable from inside herobids**: if
the backend's `auth.ts` changes, the herobids test still passes. The shared
fixture vectors in §7 Step 0 replace it as the real guard.

## 6. Failure behavior (reuse + extend)

- **Invocation failures (existing, unchanged):** content-level
  (validation/not_found/precondition) non-faulting; transport/in_progress/
  deadline retryable + circuit-break; writes fail-closed. (Step 9 Crit 4e.)
- **Descriptor-trust failures (new, DT3):** expired/untrusted/mismatched/revoked
  → skill degrades to instruction-only (no tools), logged, non-fatal. A backend
  being unreachable for descriptor refresh falls back to the last valid pinned/
  cached descriptor until `expiresAt`, then degrades.

## 7. Ordered implementation tasks (feed Steps 11–13)

> **Ordering note (2026-10-02).** Two task groups were inserted BEFORE Step 11.
> Step 0 (fixtures) must precede the rename because fixtures created afterwards
> pin post-rename bytes and prove nothing about the rename. Step 0b (the CF-1
> fix) must precede it because it lands on the current names and gets renamed
> with everything else, and because folding a behaviour change INTO Step 11
> destroys the "no behaviour change expected" verification that makes the rename
> safe.

**Step 0 (baseline + shared fixtures) — before any code edit:**
0a. Capture the baseline: HEAD SHA + `git status --short` + `pnpm lint` exit code
   + the five mandated test-script exit codes, in all three repos. A gate already
   failing at baseline is a pre-existing condition — record it, do not adopt it.
0b. Create `invocation-signing-vectors.json` in BOTH repos, **against current
   code**: frozen cases (POST invoke; GET status with empty body; query-stripped
   path; non-ASCII body) with the expected canonical string and `sha256=<hex>`.
   herobids asserts its signer emits those bytes; the backend asserts its verifier
   accepts them and rejects a mutation. Both assert a SHA256 digest of the fixture
   file itself (recorded in the Phase-3 package) so a one-sided edit also fails.
   This replaces the unfalsifiable replica at `sign.test.ts:28-36` (§5).
0c. Create descriptor-conformance fixtures in both repos: one signed descriptor
   plus tampered variants (bad signature, wrong `backendId`, expired, unapproved
   `ref`, unknown `keyId`, pin mismatch), each required to degrade to
   instruction-only (DT3).
0d. Create a **local fixture external-skill source** — Step 13 cannot use the
   live skills CLI (D20; see Step 13 below).

**Step 0b (CF-1 / CF-2 — write-path idempotency) — before the rename (D18):**
0e. Thread a STABLE `idempotencyKey` + `requestId` from every write call site.
   Today `client.ts:169-171` defaults both to `randomUUID()` and **no non-test
   call site supplies either**, so the backend's `replay` branch is unreachable and
   a caller-level retry of a write can duplicate a side effect. A stable key
   already exists in `payload.decisionId`; `write-adapter.ts:71-72,84-85` already
   plumbs both fields through. DT5's `in_progress` resolution depends on this.
0f. Persist `requestId` long enough that an unknown outcome (response lost after
   execution) is reconcilable via the signed status endpoint / a same-key re-issue.
0g. Verify with characterisation tests: same key twice → exactly ONE durable side
   effect; same key + changed payload → `validation.invalid_payload`, no second
   effect; timeout-after-execution → reconcilable. The backend legs of the first
   two are already covered by its existing `app.test.ts` and boundary verification
   suite — confirm still green rather than duplicating.

**Step 11 (generic client migration + transport seam):**
1. Rename the `traderton/` dir + subpath export → `external-backend` (`@herobids/domain/external-backend`); rename the symbols per §2 table. Preserve `sign.ts` bytes (§5) — proven by the Step-0b vectors and `sign.test.ts` passing unmodified.
2. Add `ExternalBackendDefinition` + Zod schema in domain; add `appConfig.externalBackends[]` registry (keep the one `traderton` entry derived from today's `boundary` block + env). Include `endpoint.protocol` (default `'rest'`), `toolProtocolOverrides` and `mcpPath` per §1, and update the matching `.env.example` twin for any new env key.
3. Extract the transport seam per §2.4 with `RestTransport` as the first implementation. Seam interface internal to the package — NOT exported. `requestId` + `idempotencyKey` are first-class seam inputs.
4. Rewire the **6** construction sites (3 files; §1 table) + ~32 type-level importers to the generic names / registry lookup. Rename ctx ports `tradertonBoundary`→`externalBackend`.
5. Verify: `pnpm lint` + `pnpm --filter @herobids/api exec vitest run` + worker tests + full build. No behavior change expected (rename + config reshape + an internal seam with one implementation). The Step-0e change is already in and already verified, so this step's "no behaviour change" assertion remains meaningful.

**Step 11b (`McpTransport` + the backend MCP surface) — D14:**
6. **Run the two spike gates in §2.5 first.** Gate 1 (`params._meta` inside the signed bytes) is a genuine stop: if it fails, re-open ADR 016 rather than working around it.
7. Backend side (traderton repo, its own conventions + branch): mount an MCP route on the existing boundary app over the existing `ToolInvocationDispatcher`; low-level `Server` + raw-JSON-Schema `tools/list` from the signed descriptor (D17, DT4); `isError`-returning `tools/call`; `_meta` header↔body assertions; reuse the shared `buildCanonicalString`. The frozen REST route and its raw-body parser are untouched (§5).
8. herobids side: `McpTransport` behind the seam, HMAC via the client transport's `fetch` middleware, per-call timeout driven from `deadlineAt`.
9. Verify: contract tests parameterised over `['rest','mcp']` pass on both; the Step-0g characterisation tests pass on both; `tools/list` cross-check against the descriptor degrades to instruction-only on mismatch (DT4). `protocol` stays `'rest'` everywhere outside dev/test (D19).

**Step 12 (trust-gated deep integration):**
5. Implement the descriptor type (§3) + verification pipeline (ed25519, pinning, expiry, revocation) in domain + the resolution path that today hard-codes trading (`skills.ts`, `provider-catalog.ts`, `agent-runtime-descriptor.ts`, worker `agent.ts:473`/`runtime-composition.ts:700`/`agent-capabilities.ts:18`).
6. Replace the trading `if`-branches with: "skill ref matches an enabled definition + verified descriptor → expose descriptor tools; else instruction-only." (ADR-015 §5 — no `if (trading)`.)
7. Provide the gating target: register the Traderton definition (§1) + load its descriptor. For local/dev, a herobids-side **stub descriptor** carrying the current trading tool schemas keeps trading working through the generic path; Step 13 replaces the stub with the real Traderton-published, signed descriptor.
8. Verify: trading tools still resolve for an agent whose skills include the Traderton refs; a non-matching external skill gets no tools; revocation strips tools. Lint/build/tests green.

**Step 13 (Traderton skill publication):**
13. In `/Users/chinomso.ikwuagwu/dev_ai/traderton-skills/` (remote `github.com/traderton/skills`), author `SKILL.md` for `crypto-trading`, `crypto-bot-management`, `crypto-risk-monitoring` (frontmatter `name`+`description`; body = the backend-owned instructions, derived from the herobids seeds `TRADING_SKILL`/`BOT_MANAGEMENT_SKILL`/`RISK_MONITORING_SKILL` as source of truth).
14. Produce the signed descriptor (ed25519) binding the three refs → their tool schemas/instructions; wire the Traderton definition's `trustedDescriptorSigningKeys` + `approvedSourceSkillRefs` (D11). **Replace and DELETE the Step-12 stub** — prove by grep that zero stub references remain. A run that leaves the stub in place is not done.
15. **Signing key:** generate a **dev** ed25519 keypair locally, gitignore the private key, and mark the committed descriptor clearly as dev-signed. No key material exists in any repo today (verified). The real staging/production key is **operator-held**, and registering a real public key into an operator-managed definition is an infrastructure mutation — prepare it, document it, do not execute. Step 13 completes with the dev key plus the recorded gate.
16. **Push gate:** commit on a branch; do NOT push `traderton-skills` or `traderton` (D20).
17. **Verify against the LOCAL FIXTURE source (Step 0d) — NOT the live skills CLI.** herobids resolves external skills live and unpinned at runtime (`apps/worker/src/tools/skills.ts:37` spawns `npx skills add <ref> --yes`; `normalizeExternalRef` maps the D11 ref to `traderton/skills@crypto-trading`). The Step-13 work stays local, so the real CLI **cannot see it**. Task 12 of the original plan ("verify end-to-end against the generic path") was therefore unsatisfiable as literally written: left unaddressed, an agent either reports a false green or pushes to make the test pass. Satisfy it against the fixture source + the descriptor-trust path, and record real-remote resolution as deferred to the post-push operator step.

## 8. Approval gates / open items (carried)

- **No infra mutation** in Steps 10–13 (all local code/docs + branch commits).
- **Push gate:** `github.com/traderton/*` remotes — branch commits only, zero
  pushes (D20). A push to `traderton-skills` is an INFRASTRUCTURE mutation, not a
  docs commit — see D20 for the mechanism.
- **Descriptor signing key:** dev keypair autonomous; real key operator-held and
  gated (task 15).
- **MCP spike gate 1** (`params._meta` inside the signed bytes) is a stop-and-
  re-open-ADR-016 gate, not a workaround point.
- **Legal/product (deferred with Steps 14–15):** the `exports-traderton` route,
  `trading-profile-reconciliation-saga`, `traderton-operator-defaults` dispositions
  remain OPEN (Step 9 Crit 6 Q1) — not touched in this scope; they keep working.
- DT2 (fixed contract paths) is the engineering default; revisit only if
  legal/boundary review requires per-backend endpoints.

## 9. Exit criteria for Step 10

- [x] `ExternalBackendDefinition` shape defined (§1) — incl. `protocol` + overrides.
- [x] `ExternalBackendClient` rename map defined (§2).
- [x] Transport seam defined (§2.4) — orchestration above, transports below.
- [x] MCP wire mapping defined (§2.5) + two spike gates stated.
- [x] Descriptor shape + verification pipeline defined (§3).
- [x] Descriptor-as-sole-schema-authority stated (DT4).
- [x] Rotation + revocation defined (§4).
- [x] REST byte-preservation constraint stated, with its acceptance test (§5).
- [x] Failure behavior defined (§6).
- [x] Ordered tasks for Steps 0/0b/11/11b/12/13 (§7) + approval gates (§8).
- [x] Construction-site count corrected to 6 across 3 files (§1).

Step 10 is complete on acceptance of this plan. Execution runs from the Phase-3
program package, [`docs/features/2026/10/010-phase3-program/`](../../10/010-phase3-program/ENTRYPOINT.md),
starting at its `TASKS.md` Block 0.
