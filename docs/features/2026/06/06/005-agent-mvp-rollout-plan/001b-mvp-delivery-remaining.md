# Still missing from docs/features/2026/06/06/005-agent-mvp-rollout-plan/001-mvp-delivery-plan.md

**Step 6 — UI (3 items)**

1. **Recent decisions and outcomes** — The `AgentDetailPage` has "Protocol Activity" (raw message types from `agent_messages`) but no view of actual decisions submitted to the engine. Needs a call to the journal (e.g. reuse live-status.ts's `journal.queryByTypes`) filtered to the agent's linked instance, surfaced as a "Recent Decisions" card.

2. **Simple progress summary toward the goal** — Nothing in the UI relates the agent's current status back to its stated `goal`. A minimal "Objective" card showing `goal` text + elapsed active time would satisfy this deliverable.

3. **Artifact drill-down** — The plan says artifacts stay detail-page scoped. The `agentsApi.artifacts` method exists, but the `AgentDetailPage` doesn't render artifacts at all.

---

**Step 7 — Runtime/tooling (2 items)**

4. **`send_message` missing from `DEFAULT_CAPABILITY_GRANTS`** — capability-policy.ts defines the canonical grants for `decision_submit`, `web_fetch`, `code_execute`, etc., but `send_message` is not registered there. The plan (Step 5 deliverable 1) requires "explicit brokered tool semantics for `send_message`". The preset `toolPolicy` in the agents route references `send_message` but the policy engine doesn't know about it.

5. **Broker doesn't route through `CapabilityPolicyEngine`** — The broker enforces `send_message` inline. Step 7 deliverable 2 ("enforce capability and sandbox policy on the production path for enabled capabilities") means the broker should consult `CapabilityPolicyEngine` so agent-level `toolPolicy` overrides (e.g. custom `maxPerMinute` per preset) are actually honoured, rather than ignoring the persisted policy and using a hardcoded constant.

---

**Step 7 — Runtime boundary (noted separately in the completion track)**

6. **Real container launch** — agent-runtime-launcher.ts still has placeholder semantics (`containerId = agent-runtime-${sessionId}`, no actual Docker/ECS call). The plan acknowledges this is the start of the canonical Step 6 completion track, not a blocker if you're shipping MVP against a controlled environment — but it's the first item in 002-canonical-step-6-completion-track.md Slice 1.

---

**Summary by urgency for MVP ship:**

| # | Gap | Blocks MVP acceptance criteria? |
|---|-----|----------------------------------|
| 1 | Decisions card in UI | Yes — criterion 6 |
| 2 | Objective/progress card in UI | Yes — criterion 6 |
| 3 | Artifacts card in UI | Marginal (activity drill-down) |
| 4 | `send_message` in capability grants | Yes — Step 5/7 |
| 5 | Broker uses `CapabilityPolicyEngine` | Yes — Step 7 |
| 6 | Real container launch | Post-MVP / completion track |