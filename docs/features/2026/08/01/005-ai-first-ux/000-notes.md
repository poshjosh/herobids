# AI First UX

We want our UI/UX to be AI first. We are thinking of making the entry point chat based.

- The user is shown a chat box, with a default message e.g: 

```
Hi! I can help you create an AI agent.

You can choose one of these:

1. AI personal assistant

2. AI crypto trader

3. Custom AI

What do you want to create?
```

- The above list could be populated from our supported roles, from the frontend

- If the user chooses any of the roles we e.g. trading, we ask follow up questions, with the aim of filling out the "Create agent" form for the user. Some example follow up questions, to be asked if the user decide for an agent in the trading role/preset are:

  - What type of crypto do you want to trade e.g. DEX, CEX or any.
  - What trading platform: Hyperliquid, bybit, jupiter or any? A NOTE ON THIS: This is still too jargony. Rather we could ask the user: "What chain do you want to trade on e.g. Ethereum, Solana, Base, BSC, Arbitrum or any"
  - Do you have an existing wallet or should we create one for you?

- The chat session should be able to display supporting forms for the user to fill, supporting forms may be reserved for things that involve secrets e.g. when we add connections.

- After creating the agent, the LLm may say things like: 
  - Don't forget to fund your wallet, with <capital-USD-specified-during-creation>
  - Your agent is in test mode, you can change this anytime by ...

- For the above to be successfuly, the LLM agent should have access to the code for the form or at least a markdown page explaining the create agent process (the form and all its schenanigans) for an LLM agent. This would required adding tools like: search_app_docs, list_app_docs, read_app_docs to a skill (available to all agents?).

Open questions

- Should our initial messages be translated into various supported languages?
- Should the app documentation related skill be available by default e.g core skill?

---

## Resolution (2026-08-01)

### Open Questions Resolved

1. **Should initial messages be translated?** → Yes. Use existing i18n keys for preset display names. Pass the user's locale to the chat LLM context so it responds in-language.

2. **Should platform-docs skill be available by default (core skill)?** → No. It should be a separate public skill (`platform-docs`), NOT part of `base`. It is assigned to the onboarding chat agent specifically. Other agents can opt-in if needed. See Plan 001.

### Design Decisions

3. **Secrets handling** → Rather than asking users to click/navigate to a form, the onboarding runtime returns structured `actions` so the chat can display embedded forms inline. The runtime decides *when* and *which type* of form to request; the frontend owns rendering and secret handling. See Plan 003.

4. **Chain vs platform** → The chat agent asks users about chains they use (Ethereum, Solana, etc.) and maps to venues internally using the venue/chain mapping. Users shouldn't need to know venue names.

### Core Design Principles (2026-08-01)

5. **Chat is an alternate route, not a replacement for forms.** Every field in `CreateAgentSchema` remains accessible via the existing form. The chat covers the happy path (~6-8 fields for 80% of users: preset, goal, chain, risk style, capital, connection). Edge-case and power-user fields (`tickIntervalMs`, `openPositionEscalationToJudgePolicy`, `wakePreferences`, etc.) stay form-only. The form is the authoritative fallback — if chat gets stuck, the form is always one click away.

6. **Scoped to create-agent for v1.** The chat is not a general-purpose "Chat With AI" surface yet. It is single-purpose: guide the user through agent creation. No "ask anything," no brainstorming, no research. This means the greeting is honest about scope, and user expectations are set correctly.

7. **UI label is "Guided Setup."** In the UI, this feature is called **Guided Setup** — not "Chat With AI." "Chat With AI" becomes the label when we expand to general chat in a future iteration. The underlying infrastructure (threads, messages, tools) is the same, but the user-facing label matches the v1 scope.

8. **Chat is embedded on the onboarding/create-agent page.** For v1, there is no separate `/chat` route or sidebar item. The chat lives on the agent creation page: new users land on Guided Setup (chat), with a "Use the form instead" link. Returning users see a tab choice: "Guided (Chat)" | "Form" when they navigate to "New Agent."

9. **Happy path defaults should decide most fields for the user.** In Guided Setup v1, the user must explicitly choose the agent type/preset and specify capital. The system should decide most other happy-path values automatically: generate the agent name using the existing create-agent form algorithm, default the goal/prompt to a configurable platform value (initial default: "Grow this portfolio"), default style to `balanced`, default execution mode to `test`, pick a strategy preset automatically, and auto-assign the first compatible existing active connection when one is available.

### Implementation Plans

| Plan | File |
|------|------|
| Platform Docs Skill + Tools | [001-platform-docs-skill.md](./001-platform-docs-skill.md) |
| Onboarding Chat Implementation | [002-onboarding-chat.md](./002-onboarding-chat.md) |
| Supporting Aspects (i18n, Forms, Prototyping) | [003-supporting-aspects.md](./003-supporting-aspects.md) |
| ADRs & Product Spec Updates | [004-adrs-and-product-spec.md](./004-adrs-and-product-spec.md) |

### ADR

One ADR is needed: **ADR 005 — Onboarding Chat Agent Runtime Model** at `docs/tech/adrs/2026/08/005-onboarding-chat-agent-runtime-model.md`. This records the decision that the chat agent is per-message invoked, not a continuously-running agent runtime.

### Product Spec

`docs/product/chat-with-ai/product-ux-spec.md` needs updates to add:
- Agent onboarding as a primary use case
- Embedded actions (forms, quick replies) as a chat feature
- Chat → Agent conversion as the primary onboarding path (not a future action)

### Further Open Questions Resolved

5. **Landing page: new users only or everyone?** → New users (0 agents) land on Guided Setup (chat) on the create-agent page. Users with ≥1 agent land on `/agents`; they see "Guided (Chat)" | "Form" tabs when clicking "New Agent."

6. **How much thread history goes into LLM context?** → Sliding window of last 20 persisted user/assistant messages + a structured thread summary loaded from thread metadata or a separate internal state store (key facts: selected preset, venue, capital, connection IDs collected so far). The summary is updated after each tool call or key decision point, but it is not persisted as a chat message.

7. **OAuth flows in chat — how does the thread resume after redirect?** → Redirect/resume is the baseline for v1 because that matches the current create-agent flow. Reuse the existing draft-preservation pattern and include thread/action correlation in the return URL so the frontend can reopen the thread, restore the in-progress state, and continue. Popup OAuth is an optional later optimization after provider-by-provider verification.

8. **Telegram `/chat` command?** → Deferred. Out of scope for v1. Telegram bot commands remain agent-operational only.

9. **Should `platform-docs` appear in the skill picker for regular agents?** → Yes, available in the skill picker (`visibility: 'public'`) but not auto-selected for any preset. Useful for agents that do self-configuration.

10. **Can the user continue a thread after agent creation?** → For v1, no multi-agent threads. One thread creates at most one agent. The completed thread remains viewable for confirmation and follow-up context, but "Create another agent" starts a new thread.

11. **Public website chat widget (marketing site)?** → Out of scope for this feature. The onboarding chat is for authenticated users. A public chat widget is a separate product decision involving unauthenticated access, rate limiting, and lead capture.

