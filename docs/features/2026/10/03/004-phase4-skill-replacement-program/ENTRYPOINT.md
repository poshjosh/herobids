# Phase 4 — ENTRYPOINT (read first, every session)

**Status:** living. **Created:** 2026-10-03. **Not started.**
**Read in order:** ENTRYPOINT → [INVARIANTS](./INVARIANTS.md) (frozen exit checks) → [TASKS](./TASKS.md).

**Governing records (read them; don't duplicate them):**
- Program charter `../../../09/24/000-program/ENTRYPOINT.md` §1, objective and invariants.
- Program decisions D21–D29 in `../../../09/24/000-program/DECISIONS.md`.
- [ADR 017](../../../../../tech/architecture/adrs/2026/10/017-uniform-skills-sh-skills-and-mcp-tool-discovery.md), the design.
- [Lesson: definition of done](../../../../../lessons/definition-of-done-and-goalpost-drift.md).
- Repo rules: `herobids/AGENTS.md`, `traderton/AGENTS.md`, `docs/best-practices/README.md`.

## 1. Objective (operator's words, verbatim)

> fully replacing `system/trading` and related like `system/bot-management`, `system/risk-monitoring` with their traderton `SKILL.md` counterpart

The counterparts are `traderton/skills/crypto-trading`, `traderton/skills/crypto-bot-management` and `traderton/skills/crypto-risk-monitoring`, from `github.com/traderton/skills` (public).

The program's strategic objective still governs: herobids is a generic agent host, and "herobids must not be a trading application". The genericity test still applies: a second, unrelated backend must work with zero platform code change.

## 2. Definition of done

**Every check in [INVARIANTS.md](./INVARIANTS.md) passes.** There is no partial credit.
- The checks are **frozen**. Only the operator may change them.
- **Stop rule:** if any check cannot pass, stop and report to the operator: the check, why it fails, and the options. Do **not**:
  - keep code to work around the check
  - weaken the check
  - add a deferral note
  - mark the phase done

## 3. Design in one screen (from ADR 017)

1. **Every skills.sh skill follows one lifecycle.**
   - On install, fetch the latest `SKILL.md` from the default branch and store its body and commit in the DB.
   - Re-fetch at agent start. If the fetch fails, keep the stored copy.
   - Show the commit in use.
   - No signing, digest or pinning.
2. **External skills use progressive disclosure.**
   - The prompt lists each skill's `name` and `description`.
   - `read_skill` loads the body, and a loaded skill stays in the prompt for the session.
   - `system/*` skills stay injected in full.
3. **Backend-approved skills unlock two extra things.** Approval comes from operator config (`approvedSourceSkillRefs`), not from code that knows the backend.
   - **Tools:** taken from the backend's MCP `tools/list`, where each tool carries its skill ref(s) in a neutral-namespace `_meta` key.
   - **A required connection family:** declared per ref in config. For Traderton it is `trading`, an opaque label (D28).
4. **Tool calls stay REST** in staging and production (D27).
5. **Delete** the built-in trading skills and the whole descriptor and signing machinery in the same change set (D26).

## 4. Starting state (verified 2026-10-03; re-check line numbers before editing)

| Fact | Where |
|---|---|
| Built-in trading skills are TS constants carrying `sourceRef` | `packages/domain/src/skills.ts` (`BUILTIN_TRADING_SOURCE_REFS`, `TRADING_SKILL`, `BOT_MANAGEMENT_SKILL`, `RISK_MONITORING_SKILL`, `SKILL_PRESET_MAP`, `TOOL_OWNER_OVERRIDES`) |
| Seeded on every API start | `apps/api/src/index.ts` → `apps/api/src/sync-system-skills.ts` |
| In-code definition overrides the DB revision for system ids | `packages/db/src/agent-runtime-descriptor.ts` (`SYSTEM_SKILLS_BY_ID`, `inferSkillFromRevisionRow`) |
| External install = `npx skills add` into the ephemeral workspace. Nothing goes to the DB, and the text is never injected | `apps/worker/src/tools/skills.ts`; `apps/worker/src/agents/docker-agent-manager.ts` (container recreated, no `/workspace` volume found) |
| Prompt injects `resolvedSkills[].instructions` | `apps/worker/src/runtime-composition.ts` (`buildSystemPrompt`) |
| Descriptor pipeline and visibility rewrite | `packages/domain/src/external-backend/descriptor.ts`; `apps/worker/src/external-backend/{apply-tool-visibility,skill-tool-resolver,descriptor-tool-visibility,file-descriptor-source}.ts`; `config/external-backends/*`; `scripts/ts/generate-dev-descriptor.ts` |
| The model sees local tool descriptions and Zod schemas (a follow-up, F-1) | `apps/worker/src/tools/registry.ts` `getDefinitions` |
| `capabilityFamilies: ['trading']` consumers (must keep working) | `apps/worker/src/agent-capabilities.ts`; `apps/worker/src/runtime-composition.ts` (~:691-701); `packages/db/src/agent-runtime-descriptor.ts` (readiness, venue-account check); `apps/api/src/routes/capabilities/index.ts` (families from `SYSTEM_SKILLS`); `apps/api/src/routes/agent-config-helpers.ts`; web `hasCapabilityFamily` |
| Trading-agent startup guard | `apps/worker/src/agent.ts` (~:900-909) |
| Hard-coded skill ids | `apps/api/src/routes/chat.ts` (preset map ~:648-665); `apps/web/src/features/agents/{AgentsPage,EditAgentModal,AgentFormBody}.tsx`; api `agent-create-normalization.ts`, `agent-interactivity.ts`, `agents.ts` |
| Docs index hard-codes skill text | `scripts/ts/build-docs-index.ts` → `apps/worker/src/tools/platform-docs-data.ts` |
| Traderton MCP route: off by default; projects tools from a herobids-generated descriptor file | `traderton/packages/boundary/src/mcp/{descriptor-tools,surface-config}.ts`, `bin.ts` |
| Traderton owns Zod tool schemas | `traderton/packages/domain/src/trading/tool-contract.ts`; `traderton/packages/worker/src/tools/registry.ts` |
| Herobids MCP client exists and never calls `tools/list` | `packages/domain/src/external-backend/transports/mcp-transport.ts` |
| `SKILL.md` frontmatter has non-spec `tags` and `requiredTools` | `traderton-skills/skills/*/SKILL.md` |

## 5. Authority

| Repo | Authority | Notes |
|---|---|---|
| herobids | Author and commit on a branch | Merge to `main` needs operator approval (charter §4.4) |
| traderton | Author and commit on a branch | Merging to `main` triggers the image build (`.github/workflows/build-push.yml`) |
| traderton-skills | Author and commit on a branch | A push to `main` reaches every agent on its next start (D23). Merge only with operator approval |

**Gated (operator only):**
- enabling Traderton's MCP route in staging or production
- any staging change (staging will be torn down and restarted)
- merges and pushes

## 6. Top risks (each mitigated by a task or exit check)

| Risk | Mitigation |
|---|---|
| **Goalpost drift:** done declared with built-ins or copied text still present | Frozen EC-1..EC-4; stop rule |
| **Readiness, guard, tick-work or `GET /capabilities` regress** once `SKILL.md`-driven families replace the TS ones | T8, EC-9 |
| A bad push to a skills repo reaches agents on the next start | Accepted (D23). Rollback = revert in the skill repo. Traderton merges to `traderton-skills` `main` need review |
| Traderton unreachable at agent start → approved skills have no tools | Accepted degradation (D26); EC-8 asserts no crash |
| A `_meta` key leaks consumer semantics into Traderton (its 005 non-goal 2) | T0.4 picks a neutral namespace and records it |
| GitHub rate limits at agent-start fan-out | T5: fetch via raw content with conditional requests; stored copy as fallback |
| Third-party skill text is untrusted model input (true for all skills.sh skills) | Unchanged threat. Progressive disclosure reduces exposure; enforcement stays server-side |
| An agent acts before loading trading guidance (IV-d) | Accepted; Traderton's risk gate enforces limits |

## 7. Named follow-ups (NOT Phase 4; each has this home and no other)

| ID | Item |
|---|---|
| F-1 | The model sees the backend's `tools/list` descriptions and schemas instead of herobids Zod; give `promptGuidance` a home |
| F-2 | Collapse the trading tool forwarders; re-home the broker `DECISION_SUBMIT`, `MANAGE_BOT` and preset paths |
| F-3 | Backend-defined connection families; generic product wording for the `trading` surfaces (setup, readiness, UI); payment-provider review (CF-11) |
| F-4 | The onboarding chat trading prompt (`chat.ts` `buildTradingPrompt`) |
| F-5 | Multi-backend config forwarding (CF-13); remove `tradingBackendId` (P3-17) |
| F-6 | `TOOL_CATALOG` trading entries (tied to F-1/F-2) |
| F-7 | Tool calls over MCP (Step 16 differential, D27) |
| F-8 | Optional: progressive disclosure for `system/*` skills |

**Out of scope:** Step 15 module moves; the Step 16 staging proof; `search_skills` ordering.
