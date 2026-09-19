# Bug Report: Custom Skill Trading Account Tool Capability Scope

- **Status:** FIXED (all C4 paths)
- **Severity:** High
- **Date:** 2026-09-19
- **Summary:** Custom skill revisions could expose trading-account tools without declaring the trading capability family.

## Root Cause

C4 moved `get_risk_limits` and `get_account_summary` from the base skill but custom skill write validation only checked whether tool names were known. Runtime inference did not classify either moved tool as trading, allowing an unscoped custom revision to reach an agent's LLM surface. The same malformed legacy revision could also be copied through `POST /skills/:id/fork` after its unknown-tool validation.

## Fix

Custom skill create and edit requests now reject either tool unless the effective revision declares `capabilityFamilies: ["trading"]`. Fork requests apply that same validation to the source revision after unknown-tool validation and before copying. Runtime descriptor resolution also fails closed for legacy malformed revisions, preventing them from exposing those tools while they are corrected.

## Files Changed

- `apps/api/src/routes/skills.ts`
- `apps/api/src/routes/skills.test.ts`
- `packages/db/src/agent-runtime-descriptor.ts`

## Verification

- Focused Vitest coverage passes for custom create/edit/fork validation, assigned custom-skill resolution, and LLM prompt/tool visibility.
- `pnpm lint` passes.