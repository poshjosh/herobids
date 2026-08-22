# Security Architecture

Canonical reference for the platform's threat model, trust boundaries, defense principles, and mitigation catalogue.

This is a living document — update it as new surfaces, actors, or mitigations are introduced.

## Threat Model

### Adversaries

| Actor | Motivation | Example |
|-------|-----------|---------|
| Malicious user | Escalate privileges, steal funds, abuse free-tier resources | Prompt injection to bypass tool restrictions, capital manipulation |
| Compromised LLM output | Hallucinated tool calls, instruction drift, tool-call smuggling | Model calls `submit_decision` when only `create_agent` is allowed |
| Compromised venue response | Inject malicious data into platform state | Venue returns crafted JSON that exploits downstream parsing |
| Replay / MITM attacker | Intercept or replay API calls | Stolen auth token used to create agents on another user's behalf |
| Internal misconfiguration | Accidental privilege expansion | Developer adds a powerful tool to a low-trust surface without review |

### What we protect

1. **User funds.** No unauthorized trade execution. No capital manipulation.
2. **User data.** Tenant isolation. No cross-user data leakage.
3. **Platform integrity.** No privilege escalation. No unauthorized resource consumption.
4. **LLM-mediated surfaces.** No prompt injection leading to unintended actions.

## Trust Boundaries

The system has four primary trust boundaries. Each boundary has a defined set of controls that prevent trust from flowing unchecked across it.

```
┌────────────────────────────────────────────────────────────────────┐
│  EXTERNAL WORLD                                                     │
│  (users, venues, LLM providers, public internet)                    │
└────────────────────────┬───────────────────────────────────────────┘
                         │
          ┌──────────────▼──────────────┐
          │  Boundary 1: User → API      │
          │  Controls: Auth, Zod input   │
          │  validation, rate limiting,  │
          │  tenant isolation            │
          └──────────────┬──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │  Boundary 2: API → LLM       │
          │  Controls: Prompt hardening, │
          │  structural separation,      │
          │  tool allowlists, input      │
          │  sanitization, schema        │
          │  validation on tool calls    │
          └──────────────┬──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │  Boundary 3: Agent → Worker  │
          │  Controls: Sandboxed runtime,│
          │  brokered execution, no      │
          │  direct venue access, intent │
          │  validation, allowedTools()  │
          └──────────────┬──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │  Boundary 4: Worker → Venues │
          │  Controls: Secret-backed     │
          │  credentials, rate limiting, │
          │  reconciliation, position    │
          │  tracking                    │
          └─────────────────────────────┘
```

### Boundary 1: User → API

| Control | Mechanism | Enforcement point |
|---------|-----------|-------------------|
| Authentication | JWT / session tokens | Fastify auth hooks |
| Input validation | Zod schemas on every route | Route handlers (fail-fast) |
| Rate limiting | Fastify rate-limit plugin | HTTP layer |
| Tenant isolation | User ID scoping on all DB queries | Repository layer |
| Authorization | Role checks (admin, user) | Route middleware |

### Boundary 2: API → LLM (prompt injection surface)

This is the highest-risk boundary for LLM-mediated surfaces (Guided Setup, future Chat With AI).

| Control | Mechanism | Where |
|---------|-----------|-------|
| Tool allowlists | Only declared tools are callable; undeclared calls rejected | Skill system + runtime validation |
| Input sanitization | Injection pattern detection at input boundary | Message handler (hard gate for unambiguous patterns, monitoring for borderline) |
| Structural separation | User content wrapped in randomized delimiters | Message array construction |
| System prompt hardening | Explicit security section with resist-override instructions | `buildBasePrompt()` |
| Recency-bias guard | Synthetic post-user message reinforcing security instructions | Ephemeral messages array |
| Tool-result sanitization | User-controlled strings (labels, etc.) stripped of injection syntax before entering LLM context | Tool result serialization |
| Tool-call schema validation | Zod schemas on all tool inputs; invalid calls return error to LLM | Tool execution layer |
| Server-side hard gates | Plan limits, billing gates, connection ownership — enforced regardless of LLM behavior | Business logic layer |

Defense-in-depth principle: no single layer is sufficient. Even if the LLM is fully compromised by injection, server-side validation prevents unauthorized actions. See [ADR 007](./adrs/2026/08/007-defense-in-depth-for-llm-surfaces.md).

### Boundary 3: Agent Runtime → Worker

| Control | Mechanism | Where |
|---------|-----------|-------|
| Sandboxed execution | Agent runs in isolated container; no direct DB or venue access | Container runtime |
| Brokered intent | Agent submits decisions via structured messages; worker validates and executes | `DecisionIntakeResolver` |
| `allowedTools()` hard check | Worker rejects tool calls for undeclared capabilities | `apps/worker/src/agent.ts` |
| No secret access | Agent never receives decrypted venue credentials | Runtime policy |
| Capability tiers | Brokered-required vs. open-read vs. never-direct classification | [Tool Access And Sandboxing](../agents/tool-access-and-sandboxing.md) |

### Boundary 4: Worker → Venues

| Control | Mechanism | Where |
|---------|-----------|-------|
| Secret-backed credentials | Venue API keys stored encrypted; decrypted only at call time | Venue adapter layer |
| Rate limiting | Per-venue, per-account rate limits | [Rate Limiting Guide](../../lessons/rate-limiting-guide.md) |
| Reconciliation | Position state reconciled on restart; no assumed state | Engine reconciliation |
| Response validation | Venue responses validated before state mutation | Venue adapter Zod schemas |

## Defense Principles

These principles apply to all security-relevant design decisions in the platform.

### 1. Defense-in-depth

No single layer is the only defense. Every LLM-facing surface must have at least:
- Input validation (structural)
- Prompt-level hardening (behavioral)
- Server-side enforcement (authoritative)

If any one layer fails, the others prevent escalation.

### 2. Least privilege

Every actor (user, agent, bot, system) receives only the capabilities required for its defined purpose. Tool access is explicit (allowlist), not implicit (denylist).

### 3. Fail-closed on ambiguity

When a security-relevant decision is ambiguous (unknown tool, unrecognized actor type, missing permission), the system denies rather than allows. Exceptions require explicit configuration.

### 4. Server-side authority

LLM instructions and agent requests are advisory. The server-side validation layer (Zod schemas, ownership checks, plan limits, billing gates) is authoritative. Even a fully compromised LLM or agent cannot bypass these gates.

### 5. Separation of concerns

- Reasoning (LLM/agent) is separate from execution (worker/engine)
- Configuration (what the agent wants) is separate from authorization (what the agent may do)
- Prompt-level controls (soft) complement but do not replace server-side controls (hard)

### 6. Transparency and auditability

- All security-relevant actions are logged
- Agents can read their own effective limits
- Tool calls and their results are recorded for audit
- Billing enforcement decisions are attributable to specific checks

## Mitigation Catalogue

Quick reference for what mitigations are available at each layer. Feature plans should reference this catalogue and identify which mitigations apply to their surface.

### Input layer

| Mitigation | Description | When to use |
|------------|-------------|-------------|
| Zod schema validation | Structural type + constraint checking on all inputs | Every API endpoint, every tool-call schema |
| Injection pattern detection | Regex-based detection of known injection patterns | LLM-facing message inputs (see note on false-positive handling below) |
| Length limits | Max message/field length constraints | All user-facing text inputs |
| Rate limiting | Request frequency caps per user/IP | All API endpoints |

**Note on injection pattern detection:** Hard rejection (400) is appropriate only for unambiguous, high-confidence patterns (e.g., explicit "ignore previous instructions" phrases). Ambiguous patterns (triple delimiters, markdown headers) should be logged and monitored rather than rejected, to avoid false positives. The structural and prompt-level layers provide the primary defense; input detection is an early-warning supplement.

### Prompt layer (LLM-facing surfaces)

| Mitigation | Description | When to use |
|------------|-------------|-------------|
| Security section in system prompt | Explicit instructions to resist override attempts | Every LLM-facing system prompt |
| Structural separation (delimiters) | User content wrapped in randomized per-invocation delimiters | Every user message in LLM context |
| Recency-bias synthetic guard | Post-user ephemeral message reinforcing security instructions | After all user messages, before LLM generation |
| Tool-result sanitization | Strip injection syntax from user-controlled strings in tool results | Any tool result containing user-provided data |
| Role restriction | System prompt explicitly limits the LLM's scope of action | All LLM-facing surfaces |

### Server-side enforcement layer

| Mitigation | Description | When to use |
|------------|-------------|-------------|
| Tool allowlists | Only explicitly declared tools can be called | Every LLM-mediated surface |
| `allowedTools()` hard check | Worker rejects undeclared tool calls at runtime | Agent runtime |
| Plan limits / billing gates | `checkAgentLimit`, `canSpendNow` — non-LLM-dependent | Agent creation, runtime ticks, chat invocations |
| Connection ownership validation | DB-level check that connections belong to the requesting user | Agent creation, connection operations |
| Capability tier enforcement | Brokered vs. open vs. never-direct classification | All agent tool access |
| Risk gate | Engine-level hard safety invariants (malformed payloads, unauthorized access, unreconciled state) | Trading execution |

### Data layer

| Mitigation | Description | When to use |
|------------|-------------|-------------|
| Tenant isolation | All queries scoped to authenticated user ID | Every repository query |
| Encrypted secrets | Venue credentials encrypted at rest, decrypted only at call time | Secret storage |
| No LLM persistence of secrets | Secrets never appear in conversation history or LLM context | All LLM-facing surfaces |
| Audit logging | Security-relevant actions logged with actor, action, and outcome | All security boundaries |

## Applying This Document

### For new features

When writing a feature plan that touches an LLM-facing surface or security boundary:

1. Identify which trust boundaries the feature crosses
2. Reference the relevant mitigations from the catalogue above
3. State which mitigations are inherited (already implemented by the platform) vs. which must be added
4. If adding a new mitigation pattern, update this document

### For ADRs

Security-related ADRs should reference this document's principles and explain which ones informed the decision.

### For code review

Reviewers should verify that:
- New LLM-facing surfaces implement defense-in-depth (not just prompt instructions)
- New tools are added to allowlists explicitly, not by default
- User-controlled data entering LLM context is sanitized
- Server-side validation exists independent of LLM behavior

## Related Documents

- [Tool Access And Sandboxing](../agents/tool-access-and-sandboxing.md) — capability tiers for agent runtimes
- [Runtime Boundary And Message Contract](../agents/runtime-boundary-and-message-contract.md) — agent ↔ worker trust boundary
- [ADR 005: Onboarding Chat Agent Runtime Model](./adrs/2026/08/005-onboarding-chat-agent-runtime-model.md) — security boundary for Guided Setup
- [ADR 007: Defense-in-Depth for LLM Surfaces](./adrs/2026/08/007-defense-in-depth-for-llm-surfaces.md) — decision to adopt layered defense as the standard pattern
- [Guided Setup Hardening Plan](../../features/pending/000-guided-setup-input-validation-and-injection-mitigation/001-plan.md) — first implementation of defense-in-depth on the Guided Setup surface
