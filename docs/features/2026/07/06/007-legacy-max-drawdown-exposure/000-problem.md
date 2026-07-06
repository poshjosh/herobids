Priority high — delete or quarantine the legacy agent-facing maxDrawdown surface across agents.ts:103, agents.ts:503, api-client.ts:842, AgentControlsSection.tsx:208, and en.ts:456.
Location: the public API schema, risk-defaults payload, client model, and create/edit UI all still expose maxDrawdown alongside maxDrawdownPct.
Change type: delete or modify.
Description: this leaves a third, legacy absolute-drawdown control on the agent surface even though the plan and updated docs define the canonical agent contract as dailyLossLimit plus maxDrawdownPct. That is not just cosmetic: the worker still enforces absolute maxDrawdown for agent flows when set, while the runtime contract/tooling and prompt surface only describe maxDrawdownPct as the agent drawdown control; see runtime-composition.ts:758. So a user can configure a hidden extra limit that the agent cannot see or reason about. The result is a mismatched public contract and a hidden enforcement path.
Dependencies: this needs coordinated cleanup across route schemas, API client types, form state/payload builders, and locale copy so the public agent model matches the engine/runtime model.
Risks / open questions: if maxDrawdown must remain temporarily for migration, it should be removed from agent-facing UI/API and handled as an internal compatibility field only, or explicitly surfaced everywhere as a separate non-mutable legacy constraint. The current half-state is inconsistent.

Assumption: there is no requirement to preserve the legacy public maxDrawdown agent contract. If that assumption is wrong, the implementation still needs a clearer compatibility story than the current mixed model.

---

The legacy absolute maxDrawdown field is still on the agent-facing API schemas (CreateAgentSchema, UpdateAgentSchema), risk-defaults response, client types, form state, and UI. This creates a hidden enforcement path: users can set an absolute drawdown cap the agent can't see or reason about via the runtime contract, while maxDrawdownPct is the canonical agent control. The UI help text already labels it "Legacy for non-agent flows."

This needs a coordinated cleanup across ~8 files but is a design decision (remove entirely vs. quarantine behind an internal compatibility path). The plan's non-goals say "redesigning the entire generic RiskConfigSchema used by non-agent trading instances" — so removal from the agent surface is the right direction, but should be done in a follow-up with explicit acceptance criteria.

