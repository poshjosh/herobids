# MCP vs. Custom External Backend — Comparison & Recommendation

**Date:** 2026-10-02
**Status:** ⚠️ **SUPERSEDED on its transport recommendation** by
[ADR 016](../architecture/adrs/2026/10/016-mcp-as-external-backend-transport.md)
(same day). Its trust-layer analysis is **retained and now recorded as D16.**
Kept for the reasoning, not the conclusion.
**Audience:** reviewers who may have **no prior context** on this platform. This
document is self-contained: it explains the problem, defines both options in
plain terms, compares them against the actual requirement, and makes a
recommendation with reasoning.

> ## What changed, and why (2026-10-02)
>
> **The §6 recommendation — "keep MCP deferred, build the custom contract now" —
> is no longer the decision.** ADR 016 makes MCP the invocation transport for
> platform-managed External Backends, built in Phase 3.
>
> **The analytical error** was structural, not factual: §4 scores the two options
> head-to-head on axes that mix two separable layers. R1, R2 and R4 are
> trust/entitlement requirements; R3 and R5 are transport requirements. §5 then
> correctly observes that the options "solve problems at different layers… they
> are complementary, not competing" — which contradicts the head-to-head framing
> that precedes it. Read correctly, the fair comparison is *our trust layer over
> REST* versus *our trust layer over MCP*, in which R1, R2 and R4 come out level
> and the decision rests on R3, R5, R6 and strategy.
>
> Three further corrections:
> - **R5 overstates the proof.** The staging evidence covers the READ path.
>   The write-path differential and load testing are explicitly deferred to
>   Step 16, so "byte-for-byte identical invocation behavior" is a constraint on
>   the REST path (which ADR 016 preserves), not a proof that forecloses adding
>   a second transport.
> - **R6 was undervalued.** The platform's other core skill is personal
>   assistance, whose connectors are predominantly an MCP ecosystem, so MCP
>   arrives regardless. Two tool-integration paths is the real cost of deferring.
> - **The legal framing is too generous to §6's conclusion.** §1.2 and §6 imply a
>   signed descriptor advances the payment-provider claim. It does not, on its
>   own: a party signing its own claims proves nothing to an outside reviewer, and
>   underwriters weigh entity structure, branding, custody and product
>   positioning. ADR 016 explicitly declines to claim protocol choice helps there.
>   The descriptor is good engineering and the right trust artifact; it is not the
>   legal argument.
>
> **What survives, and matters most.** §4 R2's finding is correct and is now
> recorded as **D16 / Step 10 DT4**: MCP supplies no entitlement model, so the
> verified signed descriptor remains the **sole** authority for tool name,
> description, `inputSchema` and category. A backend's `tools/list` is
> cross-checked or ignored, never a schema source. §4 R2 called that layer
> something you "would have to build on top of MCP anyway" — correct, and that is
> exactly what ADR 016 does.
>
> Read §§1–5 for the layer analysis. Do not act on §6.

---

## 1. Background a reviewer needs before judging anything

### 1.1 The two systems

- **Herobids** (also branded OpenAIdom) is a platform where users create **AI
  agents** that perform tasks. An agent is an LLM loop that can call **tools**
  (functions like "place an order", "read my inbox") and is shaped by **skills**
  (installable instruction packages that tell an agent what it can do).
- **Traderton** is a separate, independently deployable **trading service**. It
  owns everything trading: the trading tools, their input/output schemas, risk
  and execution policy, venue rules, credentials, and trading data.

Today, trading logic is partly baked **inside** herobids. The program this
document serves is separating the two so that **herobids becomes a generic agent
host** and **Traderton becomes an independently owned trading backend**.

### 1.2 Why the separation exists (this is the crux)

This is **not** primarily an engineering tidiness goal. It is a
**legal / payment-provider requirement**: *herobids must not be a trading
application.* A payment provider (the company processing subscription and
usage billing) will not accept herobids if herobids itself is deemed to be
operating a trading product. So the goal is that herobids provably contains **no
first-party trading ownership** — it only hosts agents and relays their tool
calls to whatever external backend owns that domain.

Two consequences follow, and they drive the entire comparison:

1. **Herobids must carry zero trading-specific knowledge.** No code that says
   "if this is the trading skill, do trading things." Trading must be reachable
   only through a *generic* mechanism that herobids applies identically to any
   external backend.
2. **Trust must be explicit and verifiable.** Herobids must be able to prove
   that when an agent uses trading tools, those tools came from Traderton (an
   external owner), not from herobids. "Herobids is just a relay" has to be a
   demonstrable architectural fact, not a claim.

### 1.3 Where the project stands right now (observed state)

- Herobids already talks to Traderton over a **private, authenticated REST
  boundary** today (used to prove the two can run independently on staging).
  Every tool call is an HTTPS JSON request signed with an HMAC (a shared-secret
  signature), with request IDs, deadlines, idempotency keys, and health checks.
  This is defined in an internal boundary contract and is already running.
- The trading-specific client code in herobids is small and **mechanical to
  genericize** (the coupling is mostly type names, not deep logic).
- The genuinely hard part is removing scattered **hard-coded "if trading"
  branches** throughout herobids and replacing them with a generic,
  trust-based rule. *This hard part exists regardless of which option below is
  chosen.*

---

## 2. The two options, in plain terms

### Option A — Custom External Backend (the current plan)

Herobids defines its **own** generic contract for talking to any external
backend:

- An **operator registration record** (`ExternalBackendDefinition`): the
  operator tells herobids "a backend called `traderton` exists at this address,
  authenticate to it with this credential, trust descriptors signed by these
  keys, and it is allowed to deep-integrate with these specific skills."
- A **signed descriptor**: the backend publishes a cryptographically signed,
  versioned document that says "these skills map to these tools, with these
  schemas and these instructions." Herobids **verifies the signature** against
  the keys in the registration record before trusting any of it.
- A **generic client** (`ExternalBackendClient`): herobids signs each tool call
  and sends it to the backend over the private REST boundary already in place.

The key property: herobids grants an agent a backend's tools **only when** the
agent's installed skill matches a registered backend **and** that backend's
signed descriptor verifies. Herobids never contains a line of code that
recognizes "trading" specifically.

### Option B — MCP (Model Context Protocol)

**MCP** is an open industry standard (widely adopted across agent tools in
2025–2026) for connecting an agent to an **external tool server**. In MCP:

- A backend runs an **MCP server** that advertises a list of tools.
- The agent platform runs an **MCP client** that connects to the server,
  discovers its tools, and calls them.
- Authentication to the server is typically OAuth 2.1 or an API key. Operators
  usually control which servers are allowed via an **allowlist**.

MCP is excellent at the "let an agent use tools from an external server"
problem, and it has a large ecosystem of ready-made servers (GitHub, Slack,
etc.). In this project it would mean: Traderton runs an MCP server exposing
trading tools; herobids runs an MCP client and connects to it.

---

## 3. What the requirement actually demands (the comparison axes)

The decision cannot be made on "which is more standard" or "which is less code."
It must be made against **what the legal/isolation requirement demands.** Those
demands become the comparison axes below.

| # | Requirement | What it means |
|---|---|---|
| R1 | **No first-party trading in herobids** | Herobids must apply one generic rule to all backends; no trading-specific code paths. |
| R2 | **Verifiable trust / entitlement binding** | Herobids must cryptographically verify that a specific skill is entitled to a specific backend's tools, so "we only relay" is provable. |
| R3 | **Authenticated private invocation** | Tool calls must cross a private, authenticated channel with deadline, idempotency, and health semantics (already contracted + proven on staging). |
| R4 | **Operator-controlled registration** | The operator — not the agent, not the user — decides which backend is trusted and for which skills. |
| R5 | **Reuse the proven boundary** | A full staging operational proof already validated the current REST invocation path; redoing transport invites risk and cost. |
| R6 | **Third-party extensibility (future)** | Eventually users may want to connect arbitrary external tool servers (GitHub, Slack). |

---

## 4. Head-to-head comparison

### R1 — No first-party trading in herobids
- **Custom:** Directly designed for this. The descriptor + registration model
  means herobids has one generic rule ("match skill → verified backend →
  expose its tools"). ✅ **Fully met.**
- **MCP:** MCP governs transport, not entitlement. It does **not** by itself
  remove the hard-coded "if trading" branches — those still have to be replaced
  with a generic rule. MCP neither helps nor hurts here; the hard work is
  identical. ⚠️ **Neutral — does not solve the hard part.**

### R2 — Verifiable trust / entitlement binding (the decisive axis)
- **Custom:** The signed descriptor is exactly this. A backend proves, with a
  signature herobids verifies against operator-registered keys, that it owns a
  given skill's tools. Herobids can demonstrably show it only relays to a
  verified external owner. ✅ **Fully met — this is the core design goal.**
- **MCP:** MCP's trust model authenticates the **connection to a server**
  (OAuth/API key) and relies on an operator **allowlist** of endpoints. It has
  **no concept** of "a skill reference is cryptographically bound to a backend's
  tool set via a signed descriptor the platform verifies." There is no
  entitlement artifact proving *which skill may use which backend's tools*. To
  satisfy R2 on MCP you would have to **build the descriptor/entitlement layer
  on top of MCP anyway** — i.e. most of the custom work, plus MCP. ❌ **Not met
  by MCP alone.**

### R3 — Authenticated private invocation (deadline/idempotency/health)
- **Custom:** Already implemented and proven: HMAC-signed HTTPS, request IDs,
  deadlines, idempotency keys, health gating, defined failure codes. ✅ **Met,
  and already running.**
- **MCP:** MCP is a tool-discovery/transport protocol; it does not prescribe
  idempotency keys, deadline semantics, or the specific health/authorization
  contract this platform already defined and proved. These would need to be
  layered or reconciled. ⚠️ **Partial — would require additional work to match
  the existing contract's guarantees.**

### R4 — Operator-controlled registration
- **Custom:** The `ExternalBackendDefinition` is operator-owned config:
  endpoint, credentials, trusted keys, and *which skills* a backend may serve.
  ✅ **Fully met.**
- **MCP:** Operator allowlists exist (which servers may be connected). But
  allowlisting an endpoint is coarser than "this backend may deep-integrate with
  exactly these skills." ⚠️ **Partial.**

### R5 — Reuse the proven boundary
- **Custom:** The custom client *is* the proven boundary (genericized). The
  staging operational proof and the planned final differential test both depend
  on byte-for-byte identical invocation behavior. ✅ **Met.**
- **MCP:** Adopting MCP as the transport now would **replace** the proven path,
  discarding the staging proof and re-opening transport risk right before the
  final verification step. ❌ **Works against this requirement.**

### R6 — Third-party extensibility (future)
- **Custom:** The custom contract is for **platform-managed** backends. It does
  not, by itself, let a user connect an arbitrary third-party server. ⚠️
  **Not its job.**
- **MCP:** This is MCP's genuine strength. For arbitrary third-party tool
  servers (GitHub, Slack, Notion), MCP is the right long-term answer. ✅ **MCP
  wins this axis.**

### Summary table

| Axis | Custom External Backend | MCP |
|---|---|---|
| R1 No first-party trading | ✅ designed for it | ⚠️ doesn't solve the hard part |
| R2 Verifiable entitlement trust | ✅ core feature (signed descriptor) | ❌ not provided; must be built on top |
| R3 Authenticated private invocation | ✅ proven + running | ⚠️ partial; needs added guarantees |
| R4 Operator registration (skill-scoped) | ✅ fine-grained | ⚠️ coarse (endpoint allowlist) |
| R5 Reuse proven boundary | ✅ it is the proven boundary | ❌ discards it |
| R6 Third-party server extensibility | ⚠️ not its purpose | ✅ MCP's strength |

---

## 5. The most important insight

**MCP and the custom External Backend solve problems at different layers. They
are complementary, not competing.**

- MCP answers: *"How does an agent connect to and call tools on an external tool
  server?"* (a transport/packaging question).
- The custom External Backend answers: *"How does herobids prove it owns no
  trading logic, and that a specific skill is entitled to a specific external
  owner's tools, over an already-proven private channel?"* (a trust/ownership
  question — the legal requirement).

The legal requirement lives almost entirely in the **trust/ownership** layer,
which MCP does not address. Choosing MCP would **not remove** the need to:
- replace the hard-coded trading branches with a generic rule (R1), and
- build a verifiable skill→backend entitlement mechanism (R2).

So "use MCP" does not subtract that work — it would **add** MCP on top of it, and
in the process discard the already-proven REST invocation path (R5).

The industry framing supports this: MCP is widely described as a *registration
and transport layer*. It can later **wrap** a platform-managed backend — the
execution still crosses the ownership/trust boundary underneath. That is exactly
the complementary relationship, not a replacement.

---

## 6. Recommendation

**Build the custom External Backend contract now (Option A). Keep MCP as a
deferred, additive layer for the future — specifically for third-party tool
servers — not as the mechanism for the first (Traderton) backend.**

### Why

1. **The legal requirement is a trust/ownership problem, and only the custom
   design solves it.** The signed descriptor + operator registration is the
   artifact that makes "herobids owns no trading" provable (R2, R1). MCP does
   not provide this and would need it bolted on anyway.
2. **The transport is already built and proven.** The private, authenticated,
   idempotent REST boundary passed a staging operational proof and is the
   reference for the final verification step. Switching transports now adds risk
   for no benefit to the actual goal (R3, R5).
3. **MCP does not reduce the hard work.** The difficult part — removing
   first-party trading branches and gating tools by verified entitlement —
   exists under either option. MCP only changes the pipe, which the discovery
   found to be the easy, mechanical part.
4. **Nothing is lost by deferring MCP.** The chosen design deliberately lets MCP
   layer *over* the same contract later. When the platform wants users to
   connect arbitrary third-party MCP servers (R6), that can be added without
   reworking the trust boundary built now.

### What would change this recommendation

Reviewers should push back if any of these hold:
- If a payment provider / legal review states that an **industry-standard
  protocol (MCP) is itself required** for the isolation claim (unlikely —
  isolation is about ownership and trust, not the wire protocol), then MCP would
  move from "deferred" to "required layer."
- If the primary near-term goal were actually **third-party tool-server
  connectivity** (GitHub/Slack/etc.) rather than isolating Traderton, MCP would
  lead and the custom contract would be secondary.
- If maintaining a custom signed-descriptor trust mechanism proves materially
  more expensive than an MCP-based equivalent **that still satisfies R2** — but
  note no such MCP-native entitlement mechanism exists today, so this would need
  evidence.

### Net

For **this** objective — a legally defensible separation where herobids is
provably not a trading application — the custom External Backend is the correct
choice, and MCP is a complementary future layer, not an alternative. This matches
the direction already recorded in the program's decisions, but the reasoning
above stands on its own and should be judged on its merits.

---

## 7. Glossary (for reviewers)

- **Agent** — an autonomous LLM process that performs tasks by calling tools.
- **Skill** — an installable instruction package that shapes what an agent does;
  by itself it is just text/instructions.
- **Tool** — a concrete function an agent can invoke (e.g. place an order).
- **External backend** — a separate service that owns a domain's tools, schemas,
  policy, and data (Traderton is the first one; it owns trading).
- **Descriptor** — a signed, versioned document a backend publishes that binds
  "these skills → these tools/schemas/instructions"; herobids verifies it.
- **HMAC** — a message signature using a shared secret, used here to authenticate
  each tool call on the private boundary.
- **MCP (Model Context Protocol)** — an open standard for connecting agents to
  external tool servers (transport + tool discovery).
- **Boundary / invocation contract** — the agreed request/response shape, auth,
  deadlines, idempotency, and failure codes for a tool call between herobids and
  a backend.
