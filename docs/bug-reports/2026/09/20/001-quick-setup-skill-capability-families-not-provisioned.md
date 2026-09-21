# Bug Report: `quick-setup.sh` cannot provision the AI4Trade skill — frontmatter `capabilityFamilies` is never parsed or forwarded

- **Status:** FIXED (2026-09-21)
- **Severity:** Medium (blocks the local cross-stack setup path; the skill is a seeded demo skill, not a system skill, so production is unaffected)
- **Date:** 2026-09-20
- **Fixed by:** `quick-setup.sh` now parses and forwards `capabilityFamilies`; `docs/agents/skills/ai4trade-trading-signals.md` declares `capabilityFamilies: [trading]`.
- **Discovered by:** C1 live cross-stack certification (`scripts/shell/run/reset-and-run-xstack.sh`) — `quick-setup.sh` aborted at skill provisioning, so no agents were created.
- **Environment:** development, local docker compose cross-stack (herobids api `localhost:3000`; traderton boundary `localhost:8080`).

## Summary

`quick-setup.sh` provisions skills from the frontmatter-annotated markdown files in `docs/agents/skills/`. Its payload builder reads `name`, `description`, `tags`, `requiredTools`, `promptTemplate`, and the body — but **never reads `capabilityFamilies`**. The AI4Trade skill declares `get_risk_limits` and `get_account_summary` in `requiredTools` without a `capabilityFamilies: ["trading"]` declaration, so `POST /skills` rejects it:

```
[ERROR] Skill creation failed (HTTP 400): {"error":"validation_error","details":[{"code":"custom","path":["capabilityFamilies"],"message":"requiredTools get_risk_limits, get_account_summary require the trading capability family","params":{"issueCode":"skills.trading_account_tools_require_trading_capability","requiredTools":["get_risk_limits","get_account_summary"]}}]}
[ERROR] Skill provisioning step failed for: AI4Trade Trading Signals
[2026-09-20 15:33:04] ERROR: quick-setup.sh failed
[2026-09-20 15:33:04] ERROR: reset-and-run.sh failed
```

Because `quick-setup.sh` exits non-zero, `reset-and-run.sh` aborts and the cross-stack bring-up reports failure even though both stacks are healthy.

## Root Cause

Two independent gaps combine:

1. **The skill doc omits the field.** `docs/agents/skills/ai4trade-trading-signals.md` lists `get_risk_limits` and `get_account_summary` under `requiredTools` but has no `capabilityFamilies` key. It was last touched 2026-08-28 (`ba11147f`), before the trading-capability validation existed.

2. **The provisioning script cannot supply the field even if the doc declared it.** `build_skill_payload_from_file()` in `scripts/shell/ops/quick-setup.sh` (~line 417) parses only `name`, `description`, `tags`, `requiredTools`, and `promptTemplate`, then builds the `POST /skills` payload from exactly those. `capabilityFamilies` is never parsed and never sent, so the API applies its schema default (`[]`) and the trading-capability guard fires.

The validation rule itself is correct and intentional — it landed 2026-09-19 in `ad94c9d3` (`feat(skills): scope trading account tools`) and is covered by `apps/api/src/routes/skills.test.ts`. The bug is that the seeding path was not updated alongside it.

## Impact

- `scripts/shell/run/reset-and-run-xstack.sh` and `scripts/shell/ops/quick-setup.sh` fail on a clean checkout, so the documented local cross-stack bring-up does not complete and no agents are seeded.
- Only the AI4Trade skill is affected today (it is the sole skill doc referencing the trading-account tools), but **any** future skill doc that declares those tools will hit the same wall because the script cannot express the required field.
- Not a production defect: the skill is seeded as a `draft` demo skill by the local setup script, not a system skill synced by `syncSystemSkills`.

## Fix (proposed)

1. **`scripts/shell/ops/quick-setup.sh`** — parse `capabilityFamilies` from frontmatter (reuse `parse_frontmatter_list`) and include it in the payload built by `build_skill_payload_from_file()`, defaulting to `[]` when absent.
2. **`docs/agents/skills/ai4trade-trading-signals.md`** — add `capabilityFamilies: [trading]` to the frontmatter, since the skill genuinely requires the trading capability family.

Both changes are needed: (1) makes the field expressible, (2) declares it for this skill.

## Verification

- `bash scripts/shell/ops/quick-setup.sh --dry-run` (or a full `reset-and-run-xstack.sh`) completes skill provisioning without the `skills.trading_account_tools_require_trading_capability` error.
- `POST /skills` for the AI4Trade payload returns 201 and the created revision carries `capabilityFamilies: ["trading"]`.
- `rg -n "capabilityFamilies" scripts/shell/ops/quick-setup.sh docs/agents/skills/ai4trade-trading-signals.md` shows both the parser and the declaration.

## Related

- `docs/bug-reports/2026/09/19/004-custom-skill-trading-account-tool-capability-scope.md` — the same validation rule (C4), but for the **custom** skill create/edit/fork path. That report fixed the API-side enforcement; this report covers the **seeding** path that cannot satisfy it.