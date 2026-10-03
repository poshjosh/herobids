# External Backend — architecture overview

**Status:** living. Implemented in Phase 3 (Steps 11–13); see the
[completion note](../../features/2026/10/021-phase3-completion-note.md).
**Design records:** [ADR 015 — external-backend skill registration](./adrs/2026/09/015-external-backend-skill-registration.md),
[ADR 016 — MCP as an external-backend transport](./adrs/2026/10/016-mcp-as-external-backend-transport.md),
[ADR 008 — native capabilities and external backends](./adrs/2026/08/008-native-capabilities-and-external-backends.md).
**Normative contract:** the Step 10 plan
(`docs/features/2026/09/24/006-step10-external-backend-contract-and-trust-plan.md`).

## What this is (and why)

herobids is a **generic agent host**. It does not own trading. Trading (and any
future product like it) lives in a separate service — an **External Backend** —
that herobids reaches tools on through **one generic, trust-gated path**. Today
there is exactly one External Backend: **Traderton** (the trading boundary).

The design test is: *a second, unrelated backend can be added with config + a
signed descriptor and no change to generic platform code.* Tool **visibility** is
fully generic today; the one remaining code change for a second backend's tool
**invocation** is tracked as CF-13 (see DECISIONS §5 in the Phase-3 package).

## The three parts

```
operator config            trust                      invocation
───────────────            ─────                      ──────────
externalBackends[]   →   signed descriptor      →   ExternalBackendClient
(the registry)           (sole schema authority)     └─ transport seam ─┐
                                                        RestTransport  (default)
                                                        McpTransport   (dev/test)
```

### 1. The registry (operator config)

`config/default.yaml → externalBackends` is a map keyed by `backendId`, parsed to
`ExternalBackendDefinition[]`. Each entry carries transport + trust metadata ONLY
(endpoint, caller identity, `hmacSecretRef`, trusted descriptor signing keys,
approved skill refs, pinning). No secret lives in config — `hmacSecretRef` names
an env var. See [configuration best practices](../../best-practices/configuration.md#the-external-backend-registry-operator-config)
for the full field reference. There is **no backend-identity branch anywhere in
generic registration/dispatch/visibility code** (ADR 015 §5): the generic code
iterates the registry and names no backend. `tradingBackendId` is a first-party
binding used only by the trading call sites, removed from the generic path.

### 2. The descriptor (sole schema authority — D16/DT4)

A backend publishes an **ed25519-signed descriptor** binding its skill refs →
tool schemas (name/description/inputSchema/category) + instructions. herobids runs
a verification pipeline (`packages/domain/src/external-backend/descriptor.ts`):
RFC 8785 (JCS) canonicalization → signature verify under a trusted key → backendId
match → expiry (`issuedAt ≤ now < expiresAt`) → pin → source-ref approval →
optional `tools/list` cross-check. **Any failure degrades the skill to
instruction-only (DT3) — never a crash.** The verified descriptor is the ONLY
source of a backend's tool schemas; a backend's `tools/list` is cross-checked
against it, never trusted as a schema source (this is what keeps the mechanism
transport-independent and resistant to tool-poisoning).

**Tool visibility rule (replaces the old `if (trading)` branches):** a resolved
skill whose source ref matches an enabled definition's `approvedSourceSkillRefs`
AND has a verified descriptor exposes the descriptor's tools; otherwise it is
instruction-only. (`apps/worker/src/external-backend/skill-tool-resolver.ts`.)

### 3. The transport seam (REST + MCP)

`ExternalBackendClient` does all orchestration ABOVE an internal seam — build the
005 invocation envelope, identifiers, deadline, idempotent same-key re-issue,
result mapping. BELOW the seam a `select-transport` factory picks a transport by
the entry's `protocol`:

- **`RestTransport`** (default, the only transport used in staging/production, D19)
  — signed `POST /internal/v1/tools:invoke` + a `GET` status endpoint.
- **`McpTransport`** (dev/test only) — JSON-RPC `tools/call` over the MCP SDK; the
  envelope rides in `params._meta`; the whole exchange is HMAC-signed via a
  `fetch` middleware. No status endpoint — a running invocation is reconciled by
  a same-key re-issue.

The seam is **internal to the domain package** (not exported), so the two
transports share everything except the wire edges. Nothing above the seam knows a
transport exists. `requestId` + `idempotencyKey` are first-class seam inputs, so
idempotency holds identically on both wires.

## The backend side (Traderton)

The same "one core, two seams" shape mirrors on the server: Traderton's boundary
has one execution entry point — the `ToolInvocationDispatcher` — and two thin wire
seams onto it (the REST route and an **off-by-default** MCP route). The MCP route
authors zero execution semantics; it de-frames `tools/call` into the identical 005
envelope and calls the same dispatcher. This is why most boundary/API tests run
over either transport. (Traderton's own contract: `005-consumer-boundary-contract.md`,
Fixed Decisions 1–3.)

## Trust & safety invariants (what must stay true)

- **No backend-identity branch** in generic registration/dispatch/visibility
  (ADR 015 §5). Verified by invariant I1.
- **The verified descriptor is the sole schema authority** (D16/DT4). A backend's
  `tools/list` is cross-checked or ignored, never a schema source.
- **The REST invocation bytes are frozen** — `McpTransport` reuses the signer, it
  does not refactor it. A change to the canonical string re-opens ADR 016.
- **Trust failures degrade, never crash** (DT3): untrusted key, bad signature,
  wrong backendId, expiry, pin mismatch, unapproved ref → instruction-only.
- **`protocol: mcp` is dev/test only** (D19); REST is the sole staging/production
  transport until a staging differential is run (Step 16).

## Where the code lives

| Concern | Location |
|---|---|
| Definition schema + registry helpers | `packages/domain/src/config/external-backends.ts` |
| Client + envelope + result mapping | `packages/domain/src/external-backend/client.ts` |
| Transport seam + transports | `packages/domain/src/external-backend/transports/` |
| Signer (frozen bytes) | `packages/domain/src/external-backend/sign.ts` |
| Descriptor verification pipeline | `packages/domain/src/external-backend/descriptor.ts` |
| Generic skill-tool resolver (visibility) | `apps/worker/src/external-backend/skill-tool-resolver.ts` |
| Worker→agent port composition | `apps/worker/src/external-backend/agent-ports.ts` |
| Backend MCP route (Traderton) | `traderton/packages/boundary/src/mcp/` |

## Known carried-forward items

- **CF-13** — the worker forwards one backend's `{ definition, hmacSecret }` +
  descriptor to the agent. Tool *visibility* is N-backend-ready; a second
  backend's tool *invocation* over HMAC needs this forwarding widened 1→N.
- **CF-9** — the committed descriptor is **dev-signed**; a real operator-held
  signing key is a gated post-deploy step.
- Staging differential / load / resilience for the write path are Step 16
  (deferred). This mechanism is **locally verified, not cutover-proven** — see the
  completion note's G9 statement.
