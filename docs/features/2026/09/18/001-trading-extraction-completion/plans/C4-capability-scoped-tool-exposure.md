# Plan C4: Capability-scoped tool exposure

- **Task:** C4 — apply ADR 012's base-skill decision so non-trading agents do not advertise trading-account tools.
- **Repo:** herobids
- **Status:** **REVIEW-CORRECTED; PENDING IMPLEMENTATION AUTHORIZATION** — ADR 012 is accepted; this plan does not authorize implementation.
- **Prereq:** ADR 012; A3's boundary read path; independent review complete.

## Steps

1. Remove `get_risk_limits` and `get_account_summary` from the base skill's
	required-tools list, description, instructions, examples, and any generated
	base prompt/context derived from them.
2. Add them to the applicable trading and risk-monitoring skills only, with
	instructions that match the tools actually assigned.
3. Verify skill dependency resolution, agent creation/edit flows, and tool
	discovery for both a trading and non-trading agent.

## Verification

- A personal-assistant fixture has neither tool nor either tool name in its
	resolved LLM tool list, skill instructions, or rendered context.
- A trading-capable fixture retains both tools and invokes the boundary successfully.
- Existing skill-assignment tests cover the moved requirements.

## References

- ADR 012 / B3
- `packages/domain/src/skills.ts`