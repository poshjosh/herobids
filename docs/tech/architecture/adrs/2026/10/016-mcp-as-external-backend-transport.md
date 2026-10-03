# ADR 016: MCP As External Backend Invocation Transport

**Date:** 2026-10-02
**Status:** Accepted. Decision 4 (descriptor as sole tool authority) superseded by [ADR 017](./017-uniform-skills-sh-skills-and-mcp-tool-discovery.md) (2026-10-03): tools are discovered via MCP `tools/list`; calls stay REST.
**Supersedes:** [ADR 015](../09/015-external-backend-skill-registration.md) §8 ("MCP is deferred")
**Extends:** [ADR 015](../09/015-external-backend-skill-registration.md)
**Reconciles:** [MCP Registration And Transport Layer](../../../../../features/pending/000-capability-foundations/016-mcp-registration-layer.md) (draft)

## Context

ADR 015 §8 deferred MCP: "It may later package or expose an External Backend,
but it does not replace the authenticated private invocation, health,
idempotency, descriptor trust, and authorization path required for the first
backend." DECISIONS D4 recorded the same. ADR 015 §Discovery Exit Criteria item
5 required "an MCP comparison showing why it remains deferred **or a revised
decision supported by evidence**". Step 9 produced the former; this ADR is the
latter.

Three findings moved the decision.

1. **Both halves of the product need MCP regardless.** The platform's second
   core skill is personal assistance, whose connectors (mail, calendar,
   documents, messaging) are predominantly an MCP ecosystem. Building a custom
   transport for platform-managed backends and MCP for third-party servers means
   two tool-integration paths, two auth models and two visibility rules.

2. **An independently consumable Traderton is stronger isolation evidence than a
   self-signed artifact.** The program's objective is that herobids is provably
   not a trading application. A custom contract with exactly one producer and one
   consumer, built by one team, reads as a monolith split into two services.
   Traderton serving agents generally, over a standard protocol, does not.

3. **The transport was never the hard part.** Step 9 found the `traderton/`
   coupling to be type-level only; the real surface is the hard-coded trading
   branches and the trust/entitlement model. Those are unchanged by the choice of
   transport, so adopting MCP neither adds nor removes that work.

MCP supplies no entitlement model. The finding of
`docs/tech/mcp-vs-custom/001-mcp-vs-custom-external-backend.md` §4 R2 stands:
MCP authenticates a connection and relies on an operator allowlist; it has no
artifact binding a skill to a backend's tool set. That layer remains ours. The
error in that document was treating transport and trust as competing options
rather than separable layers; its trust-layer analysis is retained and is
reflected in D4 below.

## Decision

1. **MCP is the target invocation transport for platform-managed External
   Backends.** ADR 015 §8 is superseded on direction. The authenticated private
   invocation, health, idempotency, descriptor trust and authorization
   requirements §8 names are retained in full — they move above the transport
   seam (§2) rather than being satisfied by the transport.

2. **`ExternalBackendClient` carries an internal transport seam.** Orchestration
   — envelope construction, idempotency, deadlines, health gating, retry, audit
   and correlation, result mapping — sits above the seam and is implemented once.
   Below it sit `RestTransport` and `McpTransport`. The seam is internal to
   `packages/domain/src/external-backend/` and is not exported; redirecting it
   later must not be a breaking change for its importers.

3. **Both transports are built in Phase 3.** `RestTransport` is the genericized
   existing client. `McpTransport` is built alongside it, so the seam is validated
   by a second implementation rather than assumed. (Operator decision, 2026-10-02;
   recorded as D14.)

4. **The verified External Backend Descriptor is the SOLE authority for tool
   `name`, `description`, `inputSchema` and `category`.** A backend's `tools/list`
   response is cross-checked against the descriptor or ignored; it is never a
   schema source. Disagreement between the two is a trust failure and degrades the
   skill to instruction-only per ADR 015 §4 and Step 10 DT3.

   Rationale: MCP tool descriptions enter the model's context directly. For a
   backend that can place orders, an unverified `tools/list` is a tool-poisoning
   surface. The signed descriptor closes it, and keeps tool visibility independent
   of transport.

5. **The MCP wire mapping is native tools, not an envelope tunnel.** A single
   opaque tool carrying our private envelope would be unusable by any third-party
   MCP client, forfeiting the interoperability that motivates this ADR, and would
   leave the transport seam unvalidated. Concretely:

   - `tools/call` carries `{ name: <toolName>, arguments: <payload> }`.
   - The platform-owned envelope fields travel in `params._meta`:
     `contractVersion`, `requestId`, `idempotencyKey`, `correlationId`,
     `issuedAt`, `deadlineAt`, `caller`, `subject`.
   - The signature binds `POST\n<mcp path>\n<timestamp>\nSHA256(body)` where body
     is the entire JSON-RPC frame including `params._meta`. Method and path become
     constants; the body hash already covers the JSON-RPC method, tool name,
     arguments and metadata. `buildCanonicalString`, the header set and the
     lowercase-hex HMAC are unchanged in shape.
   - The backend's header-to-body assertions (`caller.consumerId`,
     `caller.keyId`, `deadlineAt`) are retained, reading from `params._meta`.
   - `tools/list` is served verbatim from the signed descriptor on the backend
     side. It exists for third-party clients and as a cross-check surface (§4).
   - A tool failure RETURNS `isError: true` carrying the invocation-contract
     failure envelope in `structuredContent`. Handlers must not throw: on a
     low-level MCP server a thrown error surfaces as a JSON-RPC protocol error
     and the closed failure-code union is lost. Protocol errors are reserved for
     pre-dispatch framing failures.
   - `in_progress` needs no status endpoint on the MCP path. Re-issuing
     `tools/call` with the same `idempotencyKey` resolves both cases: the
     backend's idempotency store returns the stored terminal result for a
     completed invocation and an in-progress indication for a running one. This
     depends on the caller supplying a STABLE idempotency key (see D18).
   - The Tasks extension is not adopted. It is experimental; revisit when stable.

6. **Namespacing applies to third-party servers, not platform-managed backends.**
   The draft `016-mcp-registration-layer.md` Fixed Decision 4 requires MCP tool
   names be namespaced with platform tools taking precedence. That rule governs
   arbitrary third-party servers. A platform-managed backend's tool names come
   from a verified descriptor and are the agent-facing names already; they remain
   unprefixed, with collision detection at registration time. Every other Fixed
   Decision in that document — visibility and skill gating, operator
   authorization, credential reuse, no server processes inside agent containers —
   continues to apply.

7. **REST remains the default and the only transport exercised in staging and
   production** until D10's differential is satisfied or explicitly re-scoped. A
   development or test default of MCP would make the differential-critical path
   the least-exercised one.

8. **MCP protocol code uses the official SDK's scoped v2 packages, pinned
   exact.** herobids adds `@modelcontextprotocol/client`; a backend adds
   `@modelcontextprotocol/server` plus the adapter for its HTTP framework. The
   monolithic `@modelcontextprotocol/sdk` is not adopted: it carries 17 direct
   dependencies including two HTTP frameworks and a second validator. Hand-rolling
   the protocol is rejected — it would produce a private dialect that resembles
   MCP without guaranteeing interoperability, forfeiting the reason for this ADR.

   A backend's server surface builds on the **low-level** `Server`, not
   `McpServer`: `registerTool` requires a Standard Schema that can emit JSON
   Schema and does not accept raw JSON Schema, whereas the descriptor's
   `inputSchema` is already JSON Schema. `setRequestHandler('tools/list', …)`
   serves it verbatim, preserving §4.

   > **Note (2026-10-DD, Phase 3 T2.1/T2.2; traderton 008 ruling n20 → P3-27).**
   > The descriptive phrase "plus the adapter for its HTTP framework" above is
   > narrowed in practice: the Traderton backend adds `@modelcontextprotocol/server`
   > **only** and mounts the stateless web-standard transport on its existing
   > Fastify listener via the app's own raw-body parser. `@modelcontextprotocol/fastify`
   > is NOT adopted — it only creates a *new* `Fastify()` app plus Host/Origin
   > hooks and carries no protocol code, so it cannot mount on the existing app
   > and nothing is hand-rolled by omitting it. The operative half of this
   > decision (official SDK, pinned exact, low-level `Server`) is unchanged;
   > herobids adds `@modelcontextprotocol/client` only.

## Constraints that do not change

- **The REST invocation bytes stay frozen.** Step 10 §5 remains a hard
  constraint: canonicalization, header names and body serialization on the REST
  path are byte-identical, because D10's Step-16 differential depends on it.
  `McpTransport` is strictly additive. If a change to the signing module appears
  necessary for MCP's benefit, that is a signal to stop and re-open this ADR.
- **ADR 015 §5 and §6 are untouched.** A skill receives deep integration only
  when its installed source reference matches both an enabled definition and its
  verified descriptor. No `if` branch may recognize a specific backend identity
  in generic registration, dispatch or visibility code. Herobids retains generic
  dispatch, signed transport, deadline/idempotency orchestration, health gating,
  audit/correlation and tool-visibility composition.
- **Legal and payment-provider review remains required.** This ADR does not
  advance that claim. Protocol choice is weak evidence for it; entity structure,
  branding, custody and product positioning are where it is decided. Adopting a
  standard protocol is not a substitute for that work, and must not be presented
  as one.

## Consequences

- A backend's MCP server surface enters Phase 3 scope. For Traderton that is a
  route on the existing boundary app over the existing dispatcher, decided and
  planned through the traderton repo's own process.
- A backend verifies two auth paths that share one canonical-string function: the
  frozen REST path and the MCP path. They coexist; neither is a rewrite of the
  other.
- Two spike gates must pass before implementation. **First: `params._meta` must
  be inside the request bytes the client signs.** If the SDK serializes it where
  a signing middleware cannot see it, or omits it from the body, the signature
  does not cover the envelope and §5's mapping fails — stop and re-open this ADR.
  **Second: coexistence** — the MCP route mounted on the existing app with the
  existing invocation-contract tests passing unmodified and the raw-body
  retention untouched.
- If an MCP transport is reachable at the time Step 16 is planned, Step 16's
  differential gains a third leg (pinned oracle / REST / MCP) and D10 is amended
  in the Step-16 verification plan, which carries its own approval gate. D10 is
  not amended by this ADR.
- The `in_progress` resolution in §5 requires a stable idempotency key. The
  existing caller generates a fresh one per call, so the backend's replay branch
  is currently unreachable. That defect is fixed before the transport work (D18).

## References

- [ADR 015](../09/015-external-backend-skill-registration.md) — External Backend
  skill registration (this ADR supersedes §8 only)
- [Step 10 — External Backend Contract & Trust Plan](../../../../../features/2026/09/24/006-step10-external-backend-contract-and-trust-plan.md)
- [Staging-First External Backend Roadmap](../../../../../features/2026/09/24/001-staging-first-external-backend-roadmap.md)
- [Program DECISIONS](../../../../../features/2026/09/24/000-program/DECISIONS.md) — D13–D20
- [MCP Registration And Transport Layer](../../../../../features/pending/000-capability-foundations/016-mcp-registration-layer.md) — draft; reconciled in §6
- [MCP vs. Custom External Backend](../../../../mcp-vs-custom/001-mcp-vs-custom-external-backend.md) — superseded on its transport recommendation; its trust-layer analysis is retained
