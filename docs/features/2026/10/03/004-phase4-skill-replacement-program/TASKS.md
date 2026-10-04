# Phase 4 — Tasks

**Current cursor:** T0.1 (T0.4–T0.6 ruled; not started otherwise). **Branches:** create `phase4-skill-replacement` in herobids, traderton and traderton-skills.

Each task lists its exit checks from [INVARIANTS.md](./INVARIANTS.md). A task is done only when its checks pass. Work found that fits no task: decide or route it per ENTRYPOINT §8, give it a home (an existing task, a new task appended here, or a CLOSEOUT row), and continue. Never defer an item without a named home.

## T0 — Pre-reads and small rulings (before any code)

| # | Item | Output |
|---|---|---|
| T0.1 | Read the broker `MANAGE_AGENT_SKILLS` handler (where `add_skills` writes `agent_skills`) | Notes in this file |
| T0.2 | Read the preset expansion at agent creation: `apps/api/src/services/agent-instantiation-service.ts`, `routes/agents.ts`, `agent-create-normalization.ts`, blueprints | Notes in this file |
| T0.3 | Check Traderton tool schemas for anything `tools/list` serialisation or MCP clients would choke on | Notes in this file |
| T0.4 | **Ruling:** the neutral `_meta` key for a tool's skill ref(s). It must not be herobids-specific (Traderton 005 non-goal 2). Proposal: a key in the skills.sh / Agent Skills ref vocabulary, e.g. `"skills/refs": ["traderton/skills/crypto-trading"]` | ✅ Ruled: see P4-1 |
| T0.5 | ✅ **Ruled (operator, 2026-10-03):** the DB stores the assignment only. The full skill folder, including bundled files, is installed into the workspace at every agent start | — |
| T0.6 | ✅ **Ruled (operator, 2026-10-03):** keep `npx skills add`, run in the worker at agent start. Telemetry and audit calls are acceptable | — |
| T0.7 | **Tool-name parity check.** List every tool the three current trading skills expose: the `requiredTools` of `TRADING_SKILL`, `BOT_MANAGEMENT_SKILL` and `RISK_MONITORING_SKILL` in `packages/domain/src/skills.ts`, minus base-skill tools such as `send_message` and `publish_artifact`. For each, check whether Traderton's tool registry (`traderton/packages/worker/src/tools/`) has a tool with the **same name**. Check the broker-routed ones especially: `submit_decision` (`DECISION_SUBMIT`), `create_bot`/`stop_bot`/`start_bot`/`adjust_bot_config` (`MANAGE_BOT`), and the strategy-preset tools. Visible tools = Traderton `tools/list` ∩ herobids registry, so a missing name disappears. **Rule: the agent-facing name must be a Traderton tool name (Traderton owns the tool contract).** Apply these pre-ruled cases (operator, 2026-10-03), with no stop:<br>**1. Same operation, different name:** Traderton's name wins. Rename the herobids tool, update the `SKILL.md` text in traderton-skills, and record an IV.<br>**2. Convenience tool composed only of other Traderton tools** (e.g. `resolve_bot`, `resolve_watch`): implement it in Traderton and list it there.<br>**3. Traderton executes it and herobids adds platform UX** (e.g. `submit_decision` dry run and approval mode): Traderton lists it under that name; herobids keeps its wrapper unchanged.<br>**4. Logic lives only in herobids and isn't platform UX** (e.g. possibly the strategy-preset tools): if moving it to Traderton is **small**, move it. If it is **large** (needs new Traderton storage, a new contract, or a broker re-route), **do not move it and do not stop.** It will be invisible to agents after Phase 4 (accepted by the operator, 2026-10-03). Record it in CLOSEOUT "Tools not moved" with its impact.<br>"Small" vs "large" is decided inline (one-sentence reason), or by a Contemplator if contested | Table in this file, plus CLOSEOUT rows for case 4-large |

## T1 — Records ✅ (2026-10-03)

D21–D29 and ADR 017 written. Charter §2 and PROGRESS updated, Step 13 re-recorded as partial. Supersession notes added to ADR 015, ADR 016, the Step 10 plan §3 and the signing runbook. Stale references fixed (PROGRESS header, Phase 3 G9 reference, ADR 015 → ADR 008 links). Lesson recorded.

## T2 — traderton: MCP `tools/list` from its own registry (EC-13, part of EC-4)

1. Build `tools/list` from Traderton's tool registry: real `name`, `description` and `inputSchema`.
2. Add a Traderton-authored map from skill ref to tool names. Keep it in **one** Traderton module next to the MCP surface (for example `packages/boundary/src/mcp/skill-tool-map.ts`), and emit it in each tool's `_meta` under the P4-1 key. The three refs and their tool sets start as the T0.7 table.
3. Remove `descriptor-tools.ts`, the descriptor path config (`BOUNDARY_MCP_DESCRIPTOR_PATH`, plus its `.env*.example` entries) and the descriptor conformance fixtures and tests.
4. Keep the MCP route off by default (`BOUNDARY_MCP_ENABLED=false` in `.env.example` and `infra/hetzner/.env.environment.example`). Enabling it in staging or production is an operator step.
5. **Local stack:** the herobids local stack scripts that start Traderton (`herobids/scripts/shell/run/reset-and-run-xstack.sh`, `boundary.sh`, and the boundary that `run-all-tests.sh` brings up) must start it with `BOUNDARY_MCP_ENABLED=true`. Otherwise EC-9 cannot pass locally. Herobids config: uncomment `endpoint.mcpPath: /internal/v1/mcp` in `config/default.yaml` for discovery, and keep `protocol: rest` for calls (D27).

## T3 — traderton-skills: frontmatter to spec (EC-14)

Keep `name` and `description`. Move `tags` into `metadata` if they're still wanted. Drop `requiredTools`. Leave the bodies unchanged (IV-a stands).

## T4 — herobids DB: assignment rows (EC-5)

- External skills become `skills` rows holding **metadata only**: `source_ref` (unique when set), `name`, `description` and `last_installed_at`, plus the commit if `npx` or a lookup can report it. **No instructions or body.**
- Assignment is the existing `agent_skills` link.
- Derive `sourceKind: 'external'` from `source_ref`, keeping `authorId` null semantics for `system`.
- Allow ref-shaped (three-segment) slugs for `source_ref` rows. Normalise `owner/repo/skill` ↔ `owner/repo@skill` (the existing `normalizeExternalRef`).
- Greenfield, so no data migration (D6, D29).

## T5 — Install at agent start (EC-6, EC-7)

- At every agent start, for each assigned external skill, run `npx skills add <ref> --yes` in the workspace through the existing `externalSkillInstaller` port (P3-4).
- Then read the installed `SKILL.md` frontmatter to refresh `name` and `description`.
- Sequential installs, as today; each failure is a `Result`. On failure, mark the skill unavailable for this session and log a warning. Never throw into agent start.
- Tests use a local git fixture repo through the **real** CLI where it accepts a local or `file://` source. This is confirmed to work (P4-2).

## T6 — One lifecycle for all external skills (EC-5, EC-6, EC-7)

- `add_skills` for any external ref: install now (so the agent can use the skill this session), upsert the metadata row, and assign via the broker.
- `remove_skills`: unassign (and `npx skills remove` in the live workspace).
- `list_skills`: show the install time (and the commit where known).
- Presets and the API assign refs at agent creation. The API records the assignment only; the name and description come from the skills.sh catalog provider, and installation happens at the agent's first start (T5). **If the catalog is unreachable or doesn't know the ref:** record the assignment with `name` = the last ref segment and an empty description. The first successful install (T5) fills them in from the frontmatter. Never block agent creation.
- Stop auto-adding `system/file-management` for external skills, because `read_skill` replaces it for `SKILL.md`. Keep it available for agents that need bundled `references/`.
  - Keep the bash-dependency detection, but fix it to match `allowed-tools: Bash` without `(`.

## T7 — Progressive disclosure (EC-8)

- The prompt lists each assigned external skill's `name` and `description`, plus "use `read_skill` to load".
- A new `read_skill` tool, in snake_case, returns the installed `SKILL.md` body from the workspace (no network), or "temporarily unavailable" if this session's install failed. Register it in `TOOL_CATALOG`, the known names and `BASE_SKILL`.
- Track loaded skills per **session**, which means one agent runtime from start to stop (one container lifetime). Loaded bodies are included on later ticks. A restart forgets them, and the agent reloads with `read_skill` as needed. Do not persist loaded state to the DB.
- Update the `BASE_SKILL` instructions (they currently describe the workspace and file-management flow).
- `system/*` skills stay injected.

## T8 — Backend-approved skills (EC-9, EC-10, EC-11, EC-12)

- Config schema: `approvedSourceSkillRefs` stays `string[]`. The backend definition gains **one** field, `requiresConnectionFamily` (e.g. `trading`), inherited by all its approved skills. Operator YAML only. No follow-up is planned (operator, 2026-10-03).
- Worker, at agent start, for each assigned approved ref:
  - Call the backend's MCP `tools/list` via the existing MCP client, and cache it for the session.
  - Visible tools = tools tagged with the ref, intersected with the registry.
  - If the backend is unreachable: hide the tools, keep the skill loadable, and don't crash.
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

**Known descriptor machinery to delete or rewrite** (from a 2026-10-03 grep; confirm with EC-4):
- herobids domain: `packages/domain/src/external-backend/descriptor.ts`, `descriptor-conformance.test.ts`, `__fixtures__/descriptor-conformance/`, and descriptor exports in that folder's `index.ts`. **Keep** `invocation-signing-vectors.json`, `sign.ts` and the client/transport code: those are HMAC request signing, not descriptor signing.
- herobids worker: `apps/worker/src/external-backend/{apply-tool-visibility,skill-tool-resolver,descriptor-tool-visibility,file-descriptor-source}.ts` and their tests, `skill-publication-e2e.test.ts`, `__fixtures__/traderton-skill-source/`.
- herobids scripts and config: `scripts/ts/generate-dev-descriptor.ts`, `scripts/ts/generate-descriptor-conformance-fixtures.ts`, `config/external-backends/`, and `trustedDescriptorSigningKeys` / `descriptorPinning` in `config/default.yaml` and the config schema.
- traderton: `packages/boundary/src/mcp/descriptor-tools.ts` and its test, `descriptor-conformance.test.ts` and its fixtures, descriptor parts of `surface-config.ts` (+ test), `mcp.sdk.test.ts` and `bin.ts`, and `BOUNDARY_MCP_DESCRIPTOR_PATH` in both `.env*.example` files.
- The herobids `--e2e` "Cross-stack transport parity (rest + mcp)" tier (`apps/worker/src/__tests__/xstack/transport-parity.xstack.test.ts`) does not reference the descriptor by grep. Keep it, and re-run it; if it breaks, fix it so it keeps passing.
- Many other files mention "descriptor" because of `runtimeDescriptor` / `agent-runtime-descriptor`. That is unrelated and stays.

**Also delete:**

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

Record each as a row in the program `PROGRESS.md` under `## Steps completed with evidence`, using this format (one per IV, after the work lands): `**IV-x (Phase 4):** <change>. Reason: <why>. Evidence: <commit SHA / test name>. Accepted: operator, 2026-10-03 (D29).`

| IV | Change |
|---|---|
| IV-a | `crypto-trading` gains the `assess_strategy_preset`/`change_strategy_preset` line |
| IV-b | Skill names and descriptions come from `SKILL.md` (longer) |
| IV-c | Adding bot-management or risk-monitoring no longer auto-adds trading |
| IV-d | Trading guidance is loaded on demand, not always injected |
| IV-e | Traderton's MCP `tools/list` serves real schemas (previously placeholders) |
| IV-f | Ordinary external skills are now recorded as assignments, reinstalled at every agent start (latest from the default branch, so they survive restarts), and loaded via `read_skill`. Previously they were installed once and lost on restart |

## T13 — Verification and closeout (EC-15, EC-16)

- Run every EC. Run all suites, the agent trade test and the browser UAT.
- Update PROGRESS rows 13 and 14, and this cursor.
- Fill in CLOSEOUT.md: exit-check table, tools not moved, T0.7 outcomes, escalations, Contemplator rulings, IVs, branches. Then report to the operator, who decides on the merges.

## Phase 4 decisions log (append here)

| # | Decision | Date |
|---|---|---|
| P4-1 | **Tool → skill `_meta` key (T0.4).** First check whether the MCP Skills extension (SEP-2640) defines a field linking tools to skills; if it does, use it. Otherwise use `io.agentskills/skillRefs`, whose value is an array of refs in `owner/repo/skill` form (e.g. `["traderton/skills/crypto-trading"]`). Neutral: names neither herobids nor Traderton | 2026-10-03 (operator) |
| P4-2 | **`npx skills add` accepts a local path and a `file://` git URL**, and picks up committed edits on reinstall (verified 2026-10-03 against a clone of `traderton/skills`). EC-7 uses the real CLI with a `file://` fixture repo | 2026-10-03 |
| P4-3 | **Skill names must match their directory** (Agent Skills spec). `npx` resolves `@<skill>` against the frontmatter `name`. openaidom-skills was fixed and pushed on 2026-10-03; the traderton skills already comply. Herobids assumes ref segment == `name` | 2026-10-03 (operator) |
