# Phase 4 — Tasks

**Current cursor:** T0 (not started). **Branches:** create `phase4-skill-replacement` in herobids, traderton and traderton-skills.

Each task lists its exit checks from [INVARIANTS.md](./INVARIANTS.md). A task is done only when its checks pass. Work found that fits no task: stop and ask the operator for a home (ENTRYPOINT §2). Never defer an item without a named home.

## T0 — Pre-reads and small rulings (before any code)

| # | Item | Output |
|---|---|---|
| T0.1 | Read the broker `MANAGE_AGENT_SKILLS` handler (where `add_skills` writes `agent_skills`) | Notes in this file |
| T0.2 | Read the preset expansion at agent creation: `apps/api/src/services/agent-instantiation-service.ts`, `routes/agents.ts`, `agent-create-normalization.ts`, blueprints | Notes in this file |
| T0.3 | Check Traderton tool schemas for anything `tools/list` serialisation or MCP clients would choke on | Notes in this file |
| T0.4 | **Ruling:** the neutral `_meta` key for a tool's skill ref(s). It must not be herobids-specific (Traderton 005 non-goal 2). Proposal: a key in the skills.sh / Agent Skills ref vocabulary, e.g. `"skills/refs": ["traderton/skills/crypto-trading"]` | Record as a Phase 4 decision below; operator confirms |
| T0.5 | **Ruling:** handling of a skill's **bundled files** (`scripts/`, `references/`). The Traderton skills have none; ordinary skills.sh skills may. Recommendation: store `SKILL.md` in the DB as decided. At agent start, also materialise the full skill directory at the stored commit into the workspace, so bundled files and Bash usage keep working as today | Operator confirms |
| T0.6 | **Ruling:** the fetch mechanism. Recommendation: resolve the default-branch HEAD commit, then read files at that commit over HTTPS (raw content), with conditional requests and the stored copy as fallback. `npx skills` is no longer used for install, so there's no CLI telemetry and no workspace coupling. Search stays on the existing `ExternalSkillProvider` | Operator confirms |

## T1 — Records ✅ (2026-10-03)

D21–D29 and ADR 017 written. Charter §2 and PROGRESS updated, Step 13 re-recorded as partial. Supersession notes added to ADR 015, ADR 016, the Step 10 plan §3 and the signing runbook. Stale references fixed (PROGRESS header, Phase 3 G9 reference, ADR 015 → ADR 008 links). Lesson recorded.

## T2 — traderton: MCP `tools/list` from its own registry (EC-13, part of EC-4)

1. Build `tools/list` from Traderton's tool registry: real `name`, `description` and `inputSchema`.
2. Add a Traderton-authored map from skill ref to tool names, and emit it in each tool's `_meta` (T0.4 key).
3. Remove `descriptor-tools.ts`, the descriptor path config (`BOUNDARY_MCP_DESCRIPTOR_PATH`, plus its `.env*.example` entries) and the descriptor conformance fixtures and tests.
4. Keep the MCP route off by default. Enabling it in staging or production is an operator step.

## T3 — traderton-skills: frontmatter to spec (EC-14)

Keep `name` and `description`. Move `tags` into `metadata` if they're still wanted. Drop `requiredTools`. Leave the bodies unchanged (IV-a stands).

## T4 — herobids DB (EC-5)

- Migration: add `skills.source_ref` (unique when set) and `skills.source_commit`. External skills become rows.
- Derive `sourceKind: 'external'` from `source_ref`, keeping `authorId` null semantics for `system`.
- Allow ref-shaped (three-segment) slugs for `source_ref` rows.
- Greenfield, so no data migration (D6, D29).

## T5 — Skill content source (EC-5, EC-7)

- A `SkillContentSource` port with two adapters:
  - **`github`:** public repos only (D23), no token.
  - **`localGit` / `directory`:** tests and dev.
- Operator YAML selects the adapter and base URL. Add an `.env.example` twin only if an env var is introduced.
- Fetch: resolve the default-branch commit, then read `SKILL.md` and (per T0.5) the skill directory.
- Errors return `Result`; never throw into agent start.

## T6 — One lifecycle for all external skills (EC-5, EC-6, EC-7)

- `add_skills` for any external ref: fetch, upsert the row and revision (content-hash dedup), and assign via the broker.
- `remove_skills`: unassign.
- `list_skills`: show the commit.
- Presets and the API can assign refs at agent creation.
- **Refresh at agent start:** re-fetch each assigned external skill. On success, store a new revision and advance the agent to it (Q10: always latest). On failure, keep the stored copy and log a warning.
- Remove the `npx skills add/remove/list` paths and the auto-add of `system/file-management` for external skills.
  - Keep the bash-dependency detection, but fix it to match `allowed-tools: Bash` without `(`.

## T7 — Progressive disclosure (EC-8)

- The prompt lists each assigned external skill's `name` and `description`, plus "use `read_skill` to load".
- A new `read_skill` tool, in snake_case, returns the stored body. Register it in `TOOL_CATALOG`, the known names and `BASE_SKILL`.
- Track loaded skills per session in runtime state; loaded bodies are included on later ticks.
- Update the `BASE_SKILL` instructions (they currently describe the workspace and file-management flow).
- `system/*` skills stay injected.

## T8 — Backend-approved skills (EC-9, EC-10, EC-11, EC-12)

- Config schema: `approvedSourceSkillRefs` changes from `string[]` to `[{ ref, requiresConnectionFamilies: string[] }]`, as operator YAML only.
- Worker, at agent start, for each assigned approved ref:
  - Call the backend's MCP `tools/list` via the existing MCP client, and cache it for the session.
  - Visible tools = tools tagged with the ref, intersected with the registry.
  - If the backend is unreachable: hide the tools, keep the skill text, and don't crash.
- Calls stay on `RestTransport` (D27).
- Approved rows get `capabilityFamilies` from config. Then verify every consumer (ENTRYPOINT §4 table), with one test each:
  - trading readiness
  - the startup guard
  - tick-work
  - `GET /capabilities`, which must stop deriving families from `SYSTEM_SKILLS`
  - `agent-config-helpers`
  - web `hasCapabilityFamily`
- Remove the descriptor visibility path (`apply-tool-visibility`, `skill-tool-resolver`, `descriptor-tool-visibility`, `file-descriptor-source`) and the domain descriptor module.

## T9 — Presets, UI, docs index (EC-3)

- `chat.ts` preset maps list the three refs.
- Delete the trading entries in `SKILL_PRESET_MAP`.
- Replace web and API id checks with `hasCapabilityFamily` (or the equivalent family check).
- Generate the docs index from catalog rows instead of hard-coded skill text.

## T9b — Skill ordering: picker and `search_skills` (EC-17)

**Order:** `system/*` → backend-approved (any ref in an External Backend's `approvedSourceSkillRefs`; config-driven, no backend names in code) → user → other external. Within a group, keep each surface's existing secondary order.

- **Agent skill picker:** `listSelectableSkills` in `apps/web/src/features/agents/agent-display.ts` gains the backend-approved group. The API must expose an `isBackendApproved` (or equivalent) flag on the skill view so the web app doesn't need config.
- **Agent `search_skills` tool:** `skillOps.search` in `apps/worker/src/agent.ts` currently has **no ORDER BY**. Add one that implements the order above.
  - Only re-order rows that already match the query. Never add non-matching skills, so "email" never surfaces trading skills.
  - External-provider results (skills.sh catalog) stay in their separate section, after local results.
- **Out of scope (operator, 2026-10-03):** the Skills page "All" tab ordering.

## T10 — Deletions (EC-1, EC-2, EC-4)

Delete:
- `TRADING_SKILL`, `BOT_MANAGEMENT_SKILL`, `RISK_MONITORING_SKILL` and `BUILTIN_TRADING_SOURCE_REFS`
- the trading entries in `TOOL_OWNER_OVERRIDES` (or the mechanism, if unused)
- `SkillDefinition.sourceRef`, if now unused
- `scripts/ts/generate-dev-descriptor.ts`, and `scripts/ts/upsert-system-skills.ts` if confirmed stale
- `config/external-backends/`
- the signing keys and pinning in `config/default.yaml`
- `docs/runbooks/external-backend-descriptor-signing.md`
- herobids test fixtures containing trading skill text

## T11 — Tests and exit-check script (EC-1..EC-13)

- Rewrite tests against a synthetic backend (`example-echo`, its own MCP fixture server) plus a local git fixture skill repo.
- Add an env-gated test against a real `traderton-skills` checkout.
- No copies of Traderton text in herobids tests (D29).
- Write `scripts/shell/checks/phase4-exit-checks.sh` for EC-1..EC-4.

## T12 — Intentional divergences (EC-16)

Record each in the program PROGRESS evidence section:

| IV | Change |
|---|---|
| IV-a | `crypto-trading` gains the `assess_strategy_preset`/`change_strategy_preset` line |
| IV-b | Skill names and descriptions come from `SKILL.md` (longer) |
| IV-c | Adding bot-management or risk-monitoring no longer auto-adds trading |
| IV-d | Trading guidance is loaded on demand, not always injected |
| IV-e | Traderton's MCP `tools/list` serves real schemas (previously placeholders) |
| IV-f | Ordinary external skills now persist across restarts, refresh to the latest at agent start, and are loaded on demand, instead of living in the workspace |

## T13 — Verification and closeout (EC-15, EC-16)

- Run every EC. Run all suites, the agent trade test and the browser UAT.
- Update PROGRESS rows 13 and 14, and this cursor.
- Report to the operator, who decides on the merge.

## Phase 4 decisions log (append here)

| # | Decision | Date |
|---|---|---|
| | | |
