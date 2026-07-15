# Capability API Redesign Q&A

This document records the sequential design interview from the point where the discussion began with:

> I’m identifying the root decision first so the interview doesn’t drift into naming before the API boundary is settled.

It continues through the immediate last response in that thread. The format below preserves the order of questions, recommendations, answers, and clarifications.

## 1. Unified Public API Or Separate APIs?

**Assistant question**

Do you want OpenAIdom to expose one unified public API with domain namespaces, or multiple separately presented APIs such as "agent API", "trading API", and later "automation API"?

**Recommended answer**

One unified public API, organized by bounded domains.

**User answer**

Yes.

## 2. Should Trading Remain A First-Class Domain?

**Assistant question**

Should trading remain a first-class API domain, or should all capability-specific behavior be expressed only indirectly through generic agents, skills, and integrations?

**Recommended answer**

Trading should remain a first-class domain.

**User answer**

Challenged this recommendation. The user argued that:

- the primary market is people intimidated by trading jargon
- the product is not ready for the legal requirements of a trading platform
- the frontend should avoid exposing trading jargon by default
- trading should come in when a user creates an agent and gives it trading-related skills
- the platform still needs help deciding how context-specific information should be represented
- the previous discussion in `docs/features/2026/06/06/008-agent-platform-roadmap/000b-q-and-a.md` should inform the direction

**Assistant follow-up**

Accepted the pushback and reframed the recommendation: public product language should be platform-first, with trading treated as a capability package behind agents rather than the primary public frame.

## 3. Two-Layer Design With Public Platform Language First?

**Assistant question**

Do you want a strict two-layer design where public platform surfaces use only platform language, while trading terminology is confined to internal services, advanced views, and skill-specific tooling?

**Recommended answer**

Yes.

**User answer**

Agreed to two layers, but clarified that the second layer should not be exclusive to trading. Trading should be one of many possible integrations, connections, contexts, or sub-domains. The user also said the public API should expose many sub-domains and suggested examples such as:

- `api/trading/venues`
- `api/zapier`
- `api/integrations/trading`
- `api/integrations/zapier`

The user explicitly asked to be challenged rather than quietly planned around if that position was weak.

**Assistant follow-up**

Agreed with the two-layer direction, but challenged the taxonomy: capability family, provider integration, attachment model, and runtime context are different axes and should not be conflated.

## 4. Capability Family First Or Provider Family First?

**Assistant question**

Should the second layer be organized primarily by capability family, with providers nested underneath, or primarily by provider family, with capabilities inferred from them?

**Recommended answer**

Organize it by capability family first.

**User answer**

Agreed.

## 5. Are Skills The Primary Gateway To Capability Families?

**Assistant question**

Should skills be the only way an agent gains access to second-layer capability families like trading, automation, research, and communications, or should agents also be able to access those families through direct configuration outside the skill system?

**Recommended answer**

Skills should be the primary and explicit gateway to second-layer capability families.

**User answer**

Yes.

## 6. Should Credentials And Connections Be First-Class Platform Resources?

**Assistant question**

Should credentials and connections be first-class platform resources, reused across skills and agents, or should each capability family own its own separate setup model?

**Recommended answer**

Make credentials and connections first-class platform resources, then let each capability family define typed bindings to them.

**User answer**

I agree.

## 7. Separate Credential And Connection Concepts?

**Assistant question**

Should a connection represent only an external provider link, while credentials represent secrets, or do you want one unified resource that covers both OAuth-style connections and raw secret-based access?

**Recommended answer**

Use two distinct concepts:

- credential for secret material
- connection for the usable external linkage

**User answer**

I agreen.

## 8. Who Owns Connections?

**Assistant question**

Should connections be user-owned platform assets that agents are granted access to, or should agents own their own connections directly?

**Recommended answer**

Connections should be user-owned platform assets, and agents should receive explicit grants to use them.

**User answer**

I agree.

## 9. Explicit Grants Or Auto-Selection?

**Assistant question**

When an agent needs external access, should the user grant the agent access to a specific connection explicitly, or should the platform auto-select any compatible user connection behind the scenes?

**Recommended answer**

Default to explicit grants of specific connections.

**User answer**

Explicit grant.

## 10. Generic Blob Or Core Plus Typed Blocks?

**Assistant question**

Should agent runtime context be a single generic blob that every capability family must flatten into, or a shared core envelope with typed capability-specific context blocks?

**Recommended answer**

Use a shared core envelope plus typed capability-specific context blocks.

**User answer**

Core plus typed blocks is better.

## 11. Where Should Typed Context Building Live?

**Assistant question**

Where should the logic for building those typed context blocks live: inside the generic agent runtime, inside each skill definition, or in domain-specific context providers that skills request?

**Recommended answer**

Put context-building in domain-specific context providers that skills request.

**User answer**

Yes.

## 12. Normalize Typed Context By Default?

**Assistant question**

Should typed context providers be allowed to expose raw provider-specific details directly to the agent, or should they first normalize into platform or domain language and only expose provider-specific detail when a skill explicitly needs it?

**Recommended answer**

Normalize first, expose provider-specific detail only when explicitly needed.

**User answer**

Agreed with the normalization default, but challenged the idea that provider-specific information in prompts is a problem. The user argued that:

- each agent should be treated like a human
- if an agent is posting to Facebook, it is fine to say "Facebook access token" rather than "social-platform access token"
- normalization helps prevent structural coupling, but that logic does not necessarily apply to prompts
- prompts should not be over-engineered

**Assistant follow-up**

Refined the recommendation:

- normalize the data model, not necessarily the wording of the prompt
- prompts may reintroduce provider-specific language when it improves clarity
- raw provider payloads still should not be dumped into prompts accidentally

## 13. Prompt Layer As Presentation Layer?

**Assistant question**

Should the prompt layer be treated as an explicit presentation layer over typed context, with each skill deciding how much provider-specific terminology to surface?

**Recommended answer**

Yes.

**User answer**

Yes.

## 14. Provider-Agnostic Skills By Default?

**Assistant question**

Should a skill be allowed to directly name and depend on a specific provider, or should skills remain provider-agnostic and rely on connections plus prompt rendering to specialize per provider?

**Recommended answer**

Default to provider-agnostic skills, with provider-specific skills allowed when they are genuinely distinct capabilities.

**User answer**

I agree.

## 15. Capability Namespaces Or A Single Integrations Tree?

**Assistant question**

Should capability families have their own public API namespaces, such as `/trading` and `/automation`, with shared platform resources like connections living separately, or should everything second-layer live under one `/integrations` tree?

**Recommended answer**

Use separate capability namespaces, with shared platform resources outside them.

**User answer**

Agreed, but suggested considering nested capabilities such as `/capabilities/trading`, especially if there may be around 30 capabilities.

**Assistant follow-up**

Revised the recommendation in favor of `/capabilities/:family` for second-layer capability families, while still rejecting `/integrations/trading` as the primary taxonomy.

## 16. Inside A Capability Family, What Should Be Primary?

**Assistant question**

Inside `/capabilities/trading`, should the public API expose trading infrastructure nouns like venues, accounts, instruments, and positions directly, or should it expose more agent-oriented nouns first and keep infrastructure nouns in advanced subroutes?

**Recommended answer**

Agent-oriented nouns first, infrastructure nouns in advanced subroutes.

**User answer**

I agree. Next.

## 17. Should Bots Be Optional Advanced Constructs?

**Assistant question**

Within a capability family like trading, should the platform support both direct agent execution and optional managed runtime artifacts like bots, or should every trading action be forced through a bot-like resource?

**Recommended answer**

Support both, with managed artifacts like bots as optional advanced execution constructs.

**User answer**

I agree. We also already decided this - i think.

## 18. Global And Agent-Scoped Capability APIs?

**Assistant question**

For capability APIs, should the primary execution surface be agent-scoped, for example `/agents/:id/capabilities/trading/...`, with shared family resources also available under `/capabilities/trading/...`, or should capability APIs live only at the global family level?

**Recommended answer**

Use both, but make agent-scoped surfaces the primary execution path.

**User answer**

Yes.

## 19. Global Connection Grants Or Capability-Scoped Grants?

**Assistant question**

When a user grants an agent access to a connection, should that grant apply to the whole agent globally, or should it be scoped to one or more capability families such as trading, automation, or research?

**Recommended answer**

Scope grants to capability families, with a simple default UX.

**User answer**

I agree.

## 20. Grant Raw Connections Or Typed Capability Bindings?

**Assistant question**

When a capability family defines typed bindings on top of platform connections, should the agent’s effective grant point to the raw connection, or to the capability-specific binding such as a trading account, automation workspace, or research datasource?

**Recommended answer**

The effective grant should point to the capability-specific binding, with traceability back to the underlying connection.

**User answer**

I agree.

## 21. Auto-Managed Capability Bindings By Default?

**Assistant question**

Should capability-specific bindings such as trading accounts, automation workspaces, or research datasources be auto-provisioned infrastructure by default, with optional advanced inspection and management, or should they be primary user-managed resources from the start?

**Recommended answer**

Auto-provision by default, with optional advanced visibility and management.

**User answer**

I agree.

## 22. Eager Or Lazy Binding Provisioning?

**Assistant question**

Should capability-specific bindings be provisioned eagerly when a connection is granted to an agent, or lazily on first actual use of that capability?

**Recommended answer**

Provision eagerly when the user grants and enables the capability, with lazy refresh only for provider-derived metadata.

**User answer**

I agree.

## 23. What Happens On Revocation Or Skill Removal?

**Assistant question**

When a capability-scoped grant is revoked, or the relevant skill is removed from an agent, should the derived capability binding be deleted immediately, disabled and retained, or left active until manual cleanup?

**Recommended answer**

Disable it immediately and retain it for audit, with provider cleanup handled by family-specific policy.

**User answer**

I agree.

## 24. Universal Revocation Baseline Or Family-Specific Lifecycles?

**Assistant question**

Should capability families be allowed to define their own revocation cleanup policy independently, or should the platform enforce one universal cleanup lifecycle for all capability bindings?

**Recommended answer**

Use a universal platform revocation baseline, with family-specific cleanup extensions.

**User answer**

I agree.

## 25. Shared Readiness Contract Or Family-Specific Readiness Models?

**Assistant question**

Should capability families be allowed to define their own readiness model, or should the platform require one shared readiness contract for all capabilities such as `unconfigured`, `provisioning`, `ready`, `degraded`, and `revoked`?

**Recommended answer**

Use one shared readiness contract, with optional family-specific detail fields.

**User answer**

I agree.

## 26. Infrastructure Health And Agent Eligibility In Readiness?

**Assistant question**

Should capability readiness be computed purely from infrastructure state, or should it also account for whether the agent currently has the relevant skill and grant enabled?

**Recommended answer**

Readiness should include both infrastructure state and agent eligibility state, represented separately within one shared contract.

**User answer**

I agree.

## 27. Batch Resolution Of Remaining Shortlist

After the main sequential interview, a shortlist of remaining design questions was proposed. The user agreed with all proposed answers except the backward-compatibility proposal.

### Accepted

1. Canonical capability route shape: keep both family-level and agent-scoped surfaces, with `/capabilities/:family/...` for shared resources and `/agents/:id/capabilities/:family/...` for execution and day-to-day use.
2. Capability API style: use resource-oriented reads and explicit action endpoints for execution.
3. Multiple bindings from one connection: allow this when the provider model supports it.
4. Default binding selection: require an explicit default binding per family.
5. Binding attachment timing: attach during agent setup when possible.
6. Skill-to-binding requirements: allow skills to declare minimum binding requirements, not just capability families.
7. Provider-specific setup flows: keep them under shared platform connection flows, not inside skill definitions.
8. Readiness exposure: expose both binding-level readiness and aggregate per-capability readiness per agent.
9. Cross-capability policy constraints: keep a platform-level policy layer with narrower family policy modules underneath.
10. Event model: use one shared event envelope with capability-specific payloads.
11. Migration direction: treat current `credentials` as platform credentials, evolve `venue_accounts` toward trading bindings derived from connections, and keep `bots` as optional trading-specific managed artifacts.
12. Frontend exposure of advanced bindings: keep the main UI agent-first, with advanced binding management behind secondary surfaces.
13. Prompt context status summary: include a small aggregated capability-status block in addition to detailed typed blocks when needed.
14. Grant auditability: grants and binding-state transitions should be versioned and auditable over time.

### Rejected

15. Backward compatibility during migration: rejected. The project is not yet live, so there is no need for backward compatibility at any level.