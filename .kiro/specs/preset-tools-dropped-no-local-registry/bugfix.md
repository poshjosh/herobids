# Bugfix Requirements Document

## Introduction

Traderton tags three tools to the `traderton/skills/crypto-trading` skill: `list_strategy_presets`, `assess_strategy_preset` and `change_strategy_preset`. Herobids shows an agent only the tools that are both tagged by Traderton and present in its own local tool registry. Commit `88e67c98` (2026-10-12) deleted the local `assess_strategy_preset` and `change_strategy_preset` tools and described them as "reached over the external-backend path", but added no local proxies. `list_strategy_presets` never existed locally. All three are therefore dropped on every agent start with reason `not_in_local_registry` (staging agent `bright-parrot`: 19 of 22 tagged tools visible).

Impact: an agent cannot compare or switch its own strategy preset, even when the creator's policy allows it. The assessment-review wake message, the platform docs and the `crypto-trading` skill text all tell the agent to call tools it does not have. The drop is only a `warn` log, so nothing fails loudly.

Scope and constraints:
- Herobids must not contain trading logic (AGENTS.md, INV-L2). The fix is thin proxy tools that forward to Traderton. The visibility intersection is not weakened, and no Traderton logic or preset definitions are mirrored.
- Dependency on Traderton (out-of-repo, not part of this fix): a code read of the Traderton repo at its current HEAD shows that `assess_strategy_preset` can work end to end once Herobids forwards the selected venue account, because its payload schema declares `venueAccountId`. `list_strategy_presets` and `change_strategy_preset` do not declare `venueAccountId`, and the Traderton dispatcher strips undeclared payload keys before building the tool context. For those two tools the preset-assessment context is then absent and they return "preset assessment not available in this context". Traderton therefore needs a change before they work end to end. The Herobids proxies can be built and unit tested independently, but "callable end to end" for those two tools is gated on that Traderton change and must be verified against a Traderton build that includes it. This was established by reading code only; no live call was made.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an agent with the `crypto-trading` skill starts or reloads its skills THEN the system drops `list_strategy_presets`, `assess_strategy_preset` and `change_strategy_preset` from the agent's visible tools with reason `not_in_local_registry`, so the agent sees 19 of the 22 tools Traderton tags to the skill.

1.2 WHEN the agent tries to assess strategy presets or switch its active preset THEN the system offers no tool to do so, so the agent cannot use a capability the platform documents.

1.3 WHEN an `assessment_review` wake is delivered, or the agent reads the platform docs or the `crypto-trading` skill THEN the system tells the agent to call `assess_strategy_preset` and `change_strategy_preset`, which are not available to it.

1.4 WHEN tools tagged to an approved skill are dropped because they have no local registry entry THEN the system reports this only as a `warn` log and continues, so a missing tool looks like a normal result and goes unnoticed.

1.5 WHEN a maintainer reads the code comments for the preset transition tools in the agent runtime THEN the comments state the tools are "implemented and registered", which has been false since `88e67c98`.

1.6 WHEN Traderton adds or renames a tool in the `crypto-trading` skill map THEN no test fails if Herobids has no matching local registry entry, so this class of gap is not caught before release.

### Expected Behavior (Correct)

2.1 WHEN an agent with the `crypto-trading` skill starts or reloads its skills THEN the system SHALL make `list_strategy_presets`, `assess_strategy_preset` and `change_strategy_preset` visible, reporting 22 of 22 tagged tools visible and an empty dropped-tools list, without weakening the "tagged by Traderton AND present in the local registry" rule.

2.2 WHEN the agent calls `list_strategy_presets` or `assess_strategy_preset` THEN the system SHALL forward the call to Traderton as a read, passing the agent's selected venue account where Traderton scopes the call by account, and return Traderton's result or its mapped failure to the agent.

2.3 WHEN the agent calls `change_strategy_preset` THEN the system SHALL forward the call to Traderton as a side-effecting write with a bounded deadline and a fresh idempotency key per call, passing the agent's selected venue account, and return Traderton's result or its mapped failure to the agent. Creator policy, artifact freshness and cooldowns SHALL remain enforced by Traderton only; Herobids SHALL NOT decide any of them.

2.4 WHEN one of these tools is called and no Traderton boundary is configured THEN the system SHALL fail closed with a typed, non-fault error and SHALL NOT fall back to any local behaviour.

2.5 WHEN one of the two account-scoped tools is called and the agent has no ready venue account THEN the system SHALL return the existing typed `connection.missing` or `connection.provisioning` error without calling Traderton.

2.6 WHEN the three tools are added THEN the system SHALL register them consistently across the tool name list, tool catalog and tool registry so worker startup validation passes, and SHALL NOT leave them visible-but-denied by any capability, grant, category or runtime-dependency gating.

2.7 WHEN an approved skill has tagged tools that are missing from the local registry THEN the system SHALL report that at a log level that makes the gap visible in normal monitoring, naming the skill and the dropped tools.

2.8 WHEN the preset transition tools are documented in code comments THEN the comments SHALL describe the actual path (local proxy forwarding to Traderton) accurately.

2.9 WHEN the repository tests run THEN the system SHALL fail if any tool in Traderton's `crypto-trading` skill map that Herobids is expected to expose is missing from the local registry, with an explicit allow-list for any tool intentionally not exposed.

2.10 WHEN the Traderton boundary rejects or cannot complete a call to these tools (validation failure, precondition failure, transport error, in-progress at deadline) THEN the system SHALL map the outcome to a tool result using the same mapping as the existing proxies, preserving the failure code and retryability.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an agent uses any of the other 19 tools tagged to the `crypto-trading` skill THEN the system SHALL CONTINUE TO make them visible and route them exactly as before.

3.2 WHEN a skill is not approved by the backend, or is a system skill THEN the system SHALL CONTINUE TO return it unchanged, with no backend tools added.

3.3 WHEN the Traderton backend is unreachable at agent start THEN the system SHALL CONTINUE TO hide approved skill tools, keep the skill loadable as text, and never throw into agent start.

3.4 WHEN Traderton tags a tool to a skill that Herobids intentionally does not expose (for example consumer-only tools such as `list_agent_strategy_changes` and `get_assessment_artifact`, which are not in any skill map) THEN the system SHALL CONTINUE TO keep it hidden from agents.

3.5 WHEN the web app's review screen triggers `assess_strategy_preset` from the API process, or reads preset catalog data through `get_strategy_presets`, THEN the system SHALL CONTINUE TO call Traderton directly as it does today, unaffected by the agent tool registry.

3.6 WHEN an agent calls `adjust_risk_limits`, `get_risk_limits`, `submit_decision` or any existing market-data proxy THEN the system SHALL CONTINUE TO behave as before, including fail-closed degradation without a boundary.

3.7 WHEN the assessment-review wake message is built THEN the system SHALL CONTINUE TO deliver the same wake content and routing to the scout/judge loop.

3.8 WHEN Herobids source is inspected THEN the system SHALL CONTINUE TO contain no trading logic, order sizing, risk limits, venue calls or preset definitions for these tools, and SHALL NOT import `@traderton/*` into shipped packages.

3.9 WHEN agents read the `crypto-trading` skill text THEN the system SHALL CONTINUE TO serve the skill documentation unchanged, unless the design phase shows it to be wrong.
