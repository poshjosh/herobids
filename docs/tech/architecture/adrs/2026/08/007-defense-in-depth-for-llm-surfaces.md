# ADR 007: Defense-in-Depth for LLM-Facing Surfaces

**Date:** 2026-08-22
**Status:** Accepted

## Context

The platform exposes multiple LLM-mediated surfaces where user input flows into an LLM context and the LLM's output drives tool calls with real side effects (agent creation, connection management, and — in the agent runtime — trade execution). The primary surfaces today are:

1. **Guided Setup** — onboarding chat where users create agents conversationally
2. **Agent runtime** — continuously-running agents that call tools autonomously
3. **Future: Chat With AI** — general-purpose chat surface (not yet implemented)

Prompt injection is the defining security challenge for these surfaces. An attacker who controls user input (messages, connection labels, or other user-sourced strings that re-enter LLM context) can attempt to:

- Override the LLM's instructions to call unauthorized tools
- Manipulate tool-call parameters (e.g., inflated capital values)
- Exfiltrate data through crafted tool calls
- Escalate privileges by impersonating system-level directives

No single mitigation layer is sufficient against prompt injection:

- **Prompt instructions alone** (system prompt hardening) are soft — models can be coerced into ignoring them under adversarial pressure.
- **Input filtering alone** (regex pattern detection) is brittle — attackers trivially bypass with encoding tricks, rephrasing, and Unicode substitution.
- **Schema validation alone** (Zod on tool calls) catches structural errors but doesn't prevent the LLM from being tricked into calling allowed tools with harmful parameters.
- **Server-side enforcement alone** (plan limits, ownership checks) prevents unauthorized actions but doesn't address the LLM being confused into unintended-but-authorized actions.

The question is: what is the standard security pattern that all LLM-facing surfaces must implement?

## Decision

**All LLM-facing surfaces must implement defense-in-depth: multiple independent mitigation layers where no single layer is the sole defense.**

The minimum required layers for any surface where user input reaches an LLM that can trigger side effects:

### Layer 1: Input validation (structural, hard gate)

Validate all user inputs with Zod schemas at the API boundary. For LLM-facing message inputs, apply injection pattern detection as a supplement:

- **Hard rejection** only for unambiguous, high-confidence patterns (explicit instruction-override phrases, role impersonation at line start)
- **Log and monitor** for ambiguous patterns (triple delimiters, markdown-like syntax) — do not hard-reject, as these have legitimate uses
- Length and type constraints on all fields

### Layer 2: Structural separation (delimiter-based)

Wrap user content in per-invocation randomized delimiters before placing it in the LLM messages array. The system prompt references the delimiter convention so the model can structurally distinguish user input from injected directives.

Key implementation detail: **use randomized delimiters** (e.g., `<user_msg_7f3a>`) rather than fixed tags (e.g., `<user_message>`), so attackers cannot predict and inject the closing tag.

### Layer 3: Prompt hardening (system prompt security section)

Every LLM-facing system prompt must include a short security section that:

- Explicitly instructs the model to resist instruction-override attempts
- References the delimiter convention from Layer 2
- Scopes the model's role (no general-purpose behavior)
- States what the model must not do (call undeclared tools, bypass validation, etc.)

### Layer 4: Recency-bias synthetic guard

After all user messages in the messages array, inject an ephemeral synthetic message that:

- Reminds the model of its security instructions
- References the security section in the system prompt
- Is never persisted to the database
- Uses minimal tokens (~30)

### Layer 5: Tool-result sanitization

Any user-controlled string that re-enters LLM context via tool results must be sanitized:

- Collapse newlines to spaces
- Truncate to a reasonable display length
- Strip or escape characters outside a safe set (alphanumeric, spaces, basic punctuation)
- The database retains the original unsanitized value; only the LLM-facing representation is cleaned

### Layer 6: Server-side enforcement (authoritative, hard gate)

Regardless of what the LLM requests, server-side validation is the final authority:

- Tool allowlists (undeclared tools rejected)
- Zod schema validation on all tool-call parameters
- Ownership and authorization checks on all referenced resources
- Plan limits and billing gates
- Risk gate invariants for trading execution

## Rationale

1. **No silver bullet exists for prompt injection.** Academic literature and industry practice confirm that no single technique reliably prevents all injection attacks. Layered defense accepts this reality and ensures that compromising one layer does not compromise the system.

2. **Soft and hard controls complement each other.** Prompt hardening (soft) reduces the frequency of successful attacks. Server-side enforcement (hard) limits the blast radius of attacks that do succeed. Neither alone is sufficient.

3. **The cost is low.** The additional layers (delimiter wrapping, ~30-token guard, label sanitization) add negligible latency and token cost per invocation. The implementation complexity is bounded — the same helpers are reused across surfaces.

4. **The pattern is reusable.** Defining this as a standard means future LLM-facing surfaces (Chat With AI, support agent, research agent) implement the same layers from day one rather than discovering the need after a security incident.

5. **Randomized delimiters defeat tag-closing attacks.** Fixed delimiters (like `<user_message>`) are vulnerable: a user who includes `</user_message>` in their input breaks out of the tagged region. Per-invocation random suffixes make this attack computationally impractical.

6. **Input detection as supplement, not primary defense.** Regex-based detection catches obvious attacks but is fundamentally bypassable. Positioning it as a monitoring/early-warning layer rather than the primary defense avoids false-positive frustration while still catching low-effort attacks.

## Consequences

### Positive

1. Every LLM-facing surface has a clear, auditable security posture from day one.
2. Security review of new features reduces to: "Which layers does this surface implement? Are any missing?"
3. The layered approach degrades gracefully — any individual layer can be bypassed without full compromise.
4. The randomized delimiter approach is forward-compatible with future model improvements in instruction following.
5. Server-side enforcement provides a guaranteed safety floor regardless of LLM behavior.

### Negative

1. **Implementation overhead per surface.** Each new LLM-facing surface must implement all six layers. This is a deliberate tradeoff — security overhead is preferable to security gaps.
2. **Token cost per invocation.** The security section (~80 tokens) + synthetic guard (~30 tokens) + delimiter wrapping (~10 tokens) add ~120 tokens per invocation. At current pricing this is sub-$0.001 per message.
3. **Regex maintenance.** The injection pattern list requires periodic updates as new attack techniques emerge. This is inherent to any detection-based approach; the layered model ensures it's a supplement, not a critical dependency.
4. **Delimiter complexity.** Randomized delimiters add implementation complexity compared to fixed tags. The security benefit (defeating tag-closing attacks) justifies this.

## Applicability

This ADR applies to:

- **Guided Setup chat** (`apps/api/src/routes/chat.ts`) — first implementation
- **Agent runtime** (`apps/worker/src/agent.ts`) — already has Layer 6 (`allowedTools()`); other layers should be verified and added where missing
- **Future Chat With AI surfaces** — must implement all layers from the start

It does NOT apply to:

- Internal system-to-system communication (worker ↔ venue, worker ↔ DB) where no user input enters LLM context
- API endpoints that don't involve LLM invocation (standard CRUD)

## Follow-Up Rules

1. **New LLM surface review.** Any PR that introduces a new LLM-facing surface must demonstrate all six layers in the implementation or document why a layer is intentionally omitted.

2. **Injection pattern updates.** The injection pattern list should be reviewed quarterly or after any reported bypass. Updates are additive and low-risk.

3. **Monitoring.** Surfaces should log injection detection hits (even non-rejected ones) for security monitoring. Alert thresholds should be set for unusual volumes from a single user.

4. **Security architecture reference.** This ADR is a companion to [Security Architecture](../../../architecture/security.md), which provides the broader threat model and mitigation catalogue.

## References

- [Security Architecture](../../../architecture/security.md) — threat model and mitigation catalogue
- [ADR 005: Onboarding Chat Agent Runtime Model](./005-onboarding-chat-agent-runtime-model.md) — security boundary for Guided Setup
- [Tool Access And Sandboxing](../../agents/tool-access-and-sandboxing.md) — capability tiers for agent runtimes
- [Guided Setup Hardening Plan](../../../../features/pending/000-guided-setup-input-validation-and-injection-mitigation/001-plan.md) — first implementation of this pattern
