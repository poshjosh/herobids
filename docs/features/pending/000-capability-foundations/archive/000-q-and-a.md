# Q and A

THESE ARE NON AUTHORITATIVE NOTES/IDEAS WHICH INFORMED VARIOUS DECISIONS/DIRECTIONS. THE EFFECTIVE DECISIONS/DIRECTIONS HAVE BEEN DOCUMENTED ELSEWHERE IN THIS FOLDER

## Prompt 1

CONTEXT

We have a high level goal with smaller objectives.

High level goal: "To make openaidom primarily an agents as a service platform fostering social interaction between users, agents and possible future actors through communication, grouping,  ranking and social behaviour like following etc"

Objectives

- to have both long running agents and chat sessions
- to use capabilities to expand our services - capabilities must be isolated
- to make trading our first capability
- to make communications/messaging our next capability

Notes

- no longer trading centric
- trading and other capabilities must be isolated

Task: we need to differentiate between capabilities and expertise

we currently give agents expertise using skills. we group skills into what (i think) we currently call capabilities

other possible skill groups/expertise/capabilities = web access, task management

what would we call personal-assistant? is it a role? or a skill group or an expertise or a capability?

those domains which we isolate (e.g trading, messaging) could also be called something else.

Question: What do you think abou the above.

---

GETTING OUR DIRECTION

to achieve our objectives we have run from many angles, and this next section is aimed at harmonizing, syncing and arriving at a coherent direction

1. We want actor (e.g. agents, bots) blueprints and skils to be **discoverable, rankable, copyable, and purchasable** in a marketplace.

Read:

- docs/features/pending/010-agent-blueprint-marketplace/notes/duplicated-config-loading-by-api-and-worker.md
- docs/features/pending/010-agent-blueprint-marketplace/notes/unified-agent-config.md

2. We want agents to be able to accept and send documents while communicating. 

Read: 

- docs/features/pending/003b-agent-message-document-handling/000-notes.md

- docs/features/pending/010-agent-blueprint-marketplace/000-vision-and-current-state.md

3. We want users to be able to have chat sessions with agents. Read 

- docs/features/pending/003-agent-chat-sessions/000-notes.md

---

INSTRUCTIONS

- Contemplate and draw up a Q and A with recommended ansers

- Propose some documents that will guide our next major features to achieve the stated high level goal.

- List the order we should tackle things (a simple list is enough) - the list could change with time, I just want an idea.

## Response 1

You should make the split **hard and explicit**:

- **Capability** = an isolated service/domain boundary
- **Skill** = reusable agent expertise that uses one or more capabilities
- **Role** = a market-facing archetype or preset made from skills
- **Session / Agent / Bot** = actors or runtimes, not capabilities

That means:

- **Trading** is a capability
- **Messaging / communications** is a capability
- **Web access** should become a capability if you want long-term consistency
- **Task management** should also become a capability if it owns state/endpoints
- **Personal assistant** is **not** a capability. It is a **role** or **blueprint archetype**
- **Expertise** is the outcome an agent gets from skills, not the isolated system boundary

The current code/docs are mixing these layers. You can see that in skills.ts, where skills have capabilityFamilies, while presets like personal-assistant are really role presets, not capabilities.

**Q and A**
1. **What is a capability?**  
A capability is an isolated product/service domain with its own API surface, state model, policies, and runtime concerns. Recommended answer: trading, messaging, documents, web-access, and task-management should all be treated this way if they are meant to scale independently.

2. **What is a skill?**  
A skill is reusable expertise for an actor. Recommended answer: a skill bundles instructions, tool access, and guardrails, and may depend on one or more capabilities.

3. **What is expertise?**  
Expertise is the competency an actor gains from skills. Recommended answer: keep “expertise” as a product/UX term, not a core architecture primitive.

4. **What is personal-assistant?**  
It is a **role** or **blueprint archetype**. Recommended answer: personal-assistant is a curated combination of skills and defaults, not a capability.

5. **What is a role?**  
A role is a market-facing packaging of expertise. Recommended answer: examples are personal assistant, trader, researcher, operator, messenger.

6. **What is a blueprint?**  
A blueprint is a reusable, discoverable, copyable, purchasable template for an actor or session. Recommended answer: a blueprint packages role defaults, skills, capability configuration, operational policy, and marketplace metadata.

7. **How do capabilities and skills relate?**  
Skills sit above capabilities. Recommended answer: capabilities expose tools/endpoints; skills decide how the actor should use them.

8. **Can one skill span multiple capabilities?**  
Yes. Recommended answer: that should be normal. A strong personal-assistant skill may use messaging, web-access, documents, and task-management together.

9. **Should trading remain special?**  
No, except that it is the first major capability. Recommended answer: trading should be first, not foundational.

10. **Where do long-running agents and chat sessions fit?**  
They are interaction/runtime modes. Recommended answer: they consume the same skill/capability model, but they are not themselves capabilities.

11. **What should be discoverable and purchasable in the marketplace?**  
Skills, blueprints, and eventually actor archetypes. Recommended answer: capabilities are infrastructure; skills and blueprints are the marketplace assets.

12. **What is the real architectural correction?**  
Move from “agent contains trading” to “agent orchestrates capabilities.” Recommended answer: the agent core should be capability-agnostic.

**Recommended terminology**
- **Capability**: isolated domain/service boundary
- **Tool**: callable operation exposed by a capability
- **Skill**: reusable expertise pack for actors
- **Role**: user-facing archetype made from skills
- **Blueprint**: marketplace template for an actor/session/role
- **Actor**: agent, bot, future user-owned or system-owned actor
- **Runtime mode**: long-running agent, chat session, event-driven worker

**What this means for your current docs**
- 000-vision-and-current-state.md already points at the real issue: skills are marketplace-ready, but blueprints and agent config boundaries are not.
- unified-agent-config.md shows the current config shape is still heavily trading-shaped.
- 000-notes.md strongly suggests messaging/documents should become a first-class capability boundary.
- 000-notes.md is now directionally stale because it still assumes hidden-agent/container orchestration rather than capability-first agent core.

**Documents I recommend next**
1. **ADR: Capability Model and Registry**  
Define capability, tool, registration, transport choices, isolation rules, ownership boundaries.

2. **ADR: Agent Core vs Capability Services**  
Define what lives in agent-core and what must never live there.

3. **Product taxonomy doc: Actors, Roles, Skills, Capabilities, Blueprints**  
This is the naming/ontology source of truth.

4. **Blueprint schema doc**  
Define what a blueprint can package: role defaults, skills, capability config, operational policy, marketplace metadata.

5. **Messaging capability architecture doc**  
Include conversations, attachments, documents, channel adapters, delivery policy, identity/threading.

6. **Trading capability extraction plan**  
Turn trading from the current implicit foundation into an isolated capability.

7. **Chat session architecture doc, revised**  
Rewrite the current chat-session note around agent-core + capability calls.

8. **Marketplace model doc**  
Define what is discoverable, rankable, copyable, and purchasable: skills, blueprints, actors.

**Suggested order**
1. Define the taxonomy: capability vs skill vs role vs blueprint.
2. Write the agent-core vs capability-services ADR.
3. Design the capability registry and tool exposure model.
4. Extract trading conceptually into “first capability.”
5. Redesign blueprints around the new taxonomy.
6. Design messaging as the second capability.
7. Rewrite chat sessions on top of agent-core + capabilities.
8. Add documents/attachments into messaging capability.
9. Build marketplace discovery/ranking around skills and blueprints.
10. Add social features: following, grouping, ranking, reputation.