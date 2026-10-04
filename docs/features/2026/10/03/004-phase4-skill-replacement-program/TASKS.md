# Phase 4 — Tasks

**Current cursor:** DONE — T0..T13 complete. All exit checks pass (EC-1..EC-17); EC-15 five-suite GREEN (`phase3-logs/phase4-summary.txt`). CLOSEOUT.md filled; awaiting operator merge decision (no merge/push performed). **Branches:** herobids `phase4-skill-replacement` @ `df6dfa42`, traderton @ `8ef8c3e` (T2 = `51674ae`), traderton-skills @ `213c8fb` (2026-10-04).

### T2 notes (done 2026-10-04)
- New `traderton/packages/boundary/src/mcp/skill-tool-map.ts`: `SKILL_REFS_META_KEY = 'io.agentskills/skillRefs'`, `SKILL_TOOL_MAP` (the three skills → T0.7 tool sets; crypto-trading omits assess/change_strategy_preset), `buildToolSkillRefs()`.
- New `traderton/packages/boundary/src/mcp/tools-from-registry.ts`: `buildToolsFromRegistry(registry, skillToolMap=SKILL_TOOL_MAP)` → `{name,description,inputSchema(=tool.parameters),_meta:{[key]:refs}}`; fails fast on a mapped-but-missing tool or non-object schema. Serves only tools belonging to ≥1 published skill (inline decision: skill surface is the only consumer contract Phase 4 defines; satisfies EC-13 "every tool carries skill ref(s)").
- `surface-config.ts` rewritten: `resolveMcpSurfaceConfig(env, registry)` (no descriptor file); `bin.ts` passes the registry, dropped `BOUNDARY_MCP_DESCRIPTOR_PATH` + `readFileSync`.
- Deleted: `descriptor-tools.ts`(+test), `descriptor-conformance.test.ts`, `__fixtures__/descriptor-conformance/`. Kept `invocation-signing-vectors.json` (HMAC request signing).
- `mcp.sdk.test.ts` rewritten to build the surface from a ToolRegistry + fixture skill-map (descriptor parts removed); new `tools-from-registry.test.ts`; `surface-config.test.ts` rewritten. All boundary MCP tests pass (27 + 7). traderton `pnpm lint` exit 0.
- `.env.example` + `infra/hetzner/.env.environment.example`: removed `BOUNDARY_MCP_DESCRIPTOR_PATH`, kept `BOUNDARY_MCP_ENABLED=false`.
- herobids `config/default.yaml`: `mcpPath: /internal/v1/mcp` uncommented, `protocol: rest` kept (D27), removed `trustedDescriptorSigningKeys`+`descriptorPinning`, added `requiresConnectionFamily: trading`. (herobids config SCHEMA update + consumers = T8/T10; herobids lint will fail until then — expected.)
- Local stack: `herobids/docker/traderton-xstack.override.yml` already sets `BOUNDARY_MCP_ENABLED: "true"` on the boundary (Phase 3), so EC-9 harness has MCP on.

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
### T0 notes (recorded 2026-10-04)

**T0.1 — broker MANAGE_AGENT_SKILLS / `add_skills` write path.** No `skillOps` write path exists in `apps/worker/src/agent.ts` (skillOps is read-only). Writes go: tool `add_skills`/`remove_skills` (`apps/worker/src/tools/skills.ts`) → Redis `agent.manage_skills` (`AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS`, payload `{action:'add'|'remove', skillIds[1..10]}`, reply on `agent:skills:reply:<id>`) → broker `handleManageAgentSkills` → `handleSkillAdd`/`handleSkillRemove` (`apps/worker/src/agents/agent-message-broker.ts` ~891-1130) → `resolveSkillAssignmentsForUser` + `syncAgentSkillAssignments(db, agentId, userId, assignments, source)` (`packages/db/src/skill-assignment.ts` 68-213; full reconcile-to-target-set, upsert on `[agentId,skillId]`). `add_skills.execute`: resolves refs via `resolveSkillIdsBySlugOrId`; partitions platform vs external (`contains '/'` → external); external install runs `npx skills add <ref> --yes` via `runExternalSubprocess` (installer injectable as `ctx.externalSkillInstaller`); `normalizeExternalRef` rewrites `owner/repo/skill` → `owner/repo@skill`. Auto-adds `system/file-management` for ANY external ref (when includeDependencies); then `detectExternalSkillBashDependency` reads each installed SKILL.md frontmatter and, if `allowed-tools` contains the substring `'Bash('`, issues a second broker add for `system/programming`. NOTE the Bash detection matches `Bash(` not bare `Bash` — T6 asks to fix it to match `allowed-tools: Bash` without `(`.

**T0.2 — preset expansion at agent creation.** Canonical map `SKILL_PRESET_MAP` in `packages/domain/src/skills.ts` (trading→['trading','bot-management'], direct-trading→['trading'], trading-assistant→['trading'], personal-assistant→[...], custom→[]). Two API create paths: (a) **form `POST /agents`** (`apps/api/src/routes/agents.ts`) does NOT expand the preset server-side — the web client sends already-expanded `skillIds`; `skillPresetId` is only stamped into `unifiedConfig.metadata`; skills written via `syncAgentSkillAssignments(..., 'user_select')`. (b) **guided-setup/chat `create_agent`** (`apps/api/src/routes/chat.ts` ~1198) DOES expand via a LOCAL duplicate `PRESET_SKILL_MAP` (`resolveSkillPresetSkillIds`, ~647-658) identical to the domain map; writes via `syncAgentSkillAssignments(..., 'guided_setup')`. (c) **blueprint/go-live** `createAgentFromPayload` (`apps/api/src/services/agent-instantiation-service.ts`) inserts `agentSkills` directly from pre-resolved refs. Real file is `apps/api/src/agents/agent-create-normalization.ts` (not `routes/`). → T9 must point chat.ts's duplicate map at the three refs (or import the domain map).

**T0.3 — Traderton Zod schemas vs `tools/list` serialisation.** Zod `^3.25.76` (v3, no native toJSONSchema); conversion via `zod-to-json-schema@3.25.2` already a dep of `@traderton/worker`, used by `convertZodToJsonSchema` in `packages/worker/src/tools/registry.ts` (target:'openAi', $refStrategy:'none', plus `normalizeRequiredFields` and `normalizeDraft4ExclusiveBounds`). No un-serialisable constructs in any tool schema (no z.function/date/bigint/map/set/symbol/custom/instanceof/lazy/pipe/branded, no non-string-key records). Present-but-benign: discriminated unions (→anyOf/oneOf, nested only: create_bot `StrategyInputSchema`, trading-profile `ForwardActionSchema`), `.transform()`/`.preprocess()`/`.refine()` (silently dropped by converter — schema under-describes but does not fail; provision already derives `.parameters` from the un-refined base), and the Draft-4 exclusive-bound boolean quirk (already patched). Conclusion: building `tools/list` from the worker registry's already-computed `.parameters` JSON Schema is safe. The boundary package currently has NO `zod-to-json-schema` dep and never converts Zod — it serves a herobids-generated descriptor file (to be removed in T2/T10). MCP SDK: `@modelcontextprotocol/server`/`client` `2.3.0`.

 List every tool the three current trading skills expose: the `requiredTools` of `TRADING_SKILL`, `BOT_MANAGEMENT_SKILL` and `RISK_MONITORING_SKILL` in `packages/domain/src/skills.ts`, minus base-skill tools such as `send_message` and `publish_artifact`. For each, check whether Traderton's tool registry (`traderton/packages/worker/src/tools/`) has a tool with the **same name**. Check the broker-routed ones especially: `submit_decision` (`DECISION_SUBMIT`), `create_bot`/`stop_bot`/`start_bot`/`adjust_bot_config` (`MANAGE_BOT`), and the strategy-preset tools. Visible tools = Traderton `tools/list` ∩ herobids registry, so a missing name disappears. **Rule: the agent-facing name must be a Traderton tool name (Traderton owns the tool contract).** Apply these pre-ruled cases (operator, 2026-10-03), with no stop:<br>**1. Same operation, different name:** Traderton's name wins. Rename the herobids tool, update the `SKILL.md` text in traderton-skills, and record an IV.<br>**2. Convenience tool composed only of other Traderton tools** (e.g. `resolve_bot`, `resolve_watch`): implement it in Traderton and list it there.<br>**3. Traderton executes it and herobids adds platform UX** (e.g. `submit_decision` dry run and approval mode): Traderton lists it under that name; herobids keeps its wrapper unchanged.<br>**4. Logic lives only in herobids and isn't platform UX** (e.g. possibly the strategy-preset tools): if moving it to Traderton is **small**, move it. If it is **large** (needs new Traderton storage, a new contract, or a broker re-route), **do not move it and do not stop.** It will be invisible to agents after Phase 4 (accepted by the operator, 2026-10-03). Record it in CLOSEOUT "Tools not moved" with its impact.<br>"Small" vs "large" is decided inline (one-sentence reason), or by a Contemplator if contested | Table in this file, plus CLOSEOUT rows for case 4-large |

### T0.7 — Tool-name parity table (recorded 2026-10-04)

Universe = `requiredTools` of the three skills minus base tools (`send_message`, `publish_artifact`). Traderton registry names from `grep "name: '...'" traderton/packages/worker/src/tools/*.ts` (authoritative, 2026-10-04). **Rule applied (operator, this session): a tool is only moved/listed in Traderton if a trading skill needs it.**

| Tool | In skill(s) | Traderton has same name? | Case | Action |
|---|---|---|---|---|
| get_market_overview | crypto-trading | ✅ | — | visible via `tools/list` ∩ registry |
| check_regime | crypto-trading | ✅ | — | visible |
| get_price | crypto-trading, crypto-risk-monitoring | ✅ | — | visible |
| get_funding_rates | crypto-trading | ✅ | — | visible |
| search_tokens | crypto-trading | ✅ | — | visible |
| discover_tokens | crypto-trading | ✅ | — | visible |
| get_risk_limits | crypto-trading, crypto-risk-monitoring | ✅ | — | visible |
| get_account_summary | crypto-trading, crypto-risk-monitoring | ✅ | — | visible |
| get_analytics | all three | ✅ | — | visible |
| list_positions | all three | ✅ | — | visible |
| watch_token | crypto-trading, crypto-risk-monitoring | ✅ | — | visible |
| list_watches | crypto-trading, crypto-risk-monitoring | ✅ | — | visible |
| remove_watch | crypto-trading, crypto-risk-monitoring | ✅ | — | visible |
| resolve_watch | crypto-trading, crypto-risk-monitoring | ✅ | — | visible |
| check_watches | crypto-trading, crypto-risk-monitoring | ✅ | — | visible |
| find_instrument | crypto-trading | ✅ | — | visible |
| submit_decision | crypto-trading | ✅ | 3 | Traderton lists it; herobids keeps its dry-run/approval wrapper unchanged |
| adjust_risk_limits | crypto-trading, crypto-risk-monitoring | ✅ | — | visible |
| create_bot | crypto-bot-management | ✅ | — | visible |
| stop_bot | crypto-bot-management | ✅ | — | visible |
| start_bot | crypto-bot-management | ✅ | — | visible |
| adjust_bot_config | crypto-bot-management | ✅ | — | visible |
| list_bots | crypto-bot-management | ✅ | — | visible |
| get_bot_status | crypto-bot-management | ✅ | — | visible |
| resolve_bot | crypto-bot-management | ✅ | — | visible |
| **assess_strategy_preset** | crypto-trading | ❌ | **4 (large)** | **Not moved.** See decision below. CLOSEOUT "Tools not moved". |
| **change_strategy_preset** | crypto-trading | ❌ | **4 (large)** | **Not moved.** See decision below. CLOSEOUT "Tools not moved". |

**Only two parity gaps:** `assess_strategy_preset` and `change_strategy_preset` (both in crypto-trading only). Every other tool matches a Traderton tool by exact name → no renames (no case-1), no new Traderton convenience tools (no case-2). `submit_decision` is case-3 (Traderton executes; herobids keeps the dry-run/approval UX wrapper).

**Decision — assess_strategy_preset / change_strategy_preset = case 4, LARGE, NOT MOVED.** One-sentence reason: the entire billable preset-assessment + transition machinery (DB tables `market_assessment_requests/_runs/_artifacts`, `PlatformAssessor`, `AssessmentRequestService` implementing `AssessmentRequestPort`, `PresetTransitionService`/`PresetTransitionPort`, usage-billing reservation/capture) lives in herobids and Traderton has **no** executor (only the Zod schemas in `traderton/packages/domain/src/tool-schemas.ts` plus a display helper `deriveStrategyPreset`), so moving it would require new Traderton storage, a new contract and a broker re-route — the definition of "large". Independently corroborated by Traderton's own `011-premerge-backlog.md` c4.9h ruling classifying `market_assessment_*` as **PLATFORM-KEEP** (herobids). Evidence: `apps/worker/src/tools/assess-strategy-preset.ts` (delegates to herobids `AssessmentRequestPort`), `apps/worker/src/tools/change-strategy-preset.ts` (reads herobids `marketAssessmentArtifacts`, gates on herobids `platformAssessment.enabled`, delegates to herobids `PresetTransitionPort`), `apps/worker/src/market-intelligence/assessment-request-service.ts`, `preset-transition-service.ts`; traderton grep for assessment/transition executor = 0 hits.

**Consequence (accepted by operator 2026-10-03 per T0.7 case-4):** after Phase 4, since visible tools = Traderton `tools/list` ∩ herobids registry, and Traderton will not list these two names, they become **invisible to agents**. The crypto-trading SKILL.md still mentions them in its last line (IV-a); an agent calling them will get "not in the allowed set" (a visible error, not a safety failure — ADR 017 Consequences). Recorded in CLOSEOUT "Tools not moved" at T13. This is noted for the operator at the §8 stop below.


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

## T13 — Verification and closeout (EC-15, EC-16) — ✅ DONE (2026-10-04)

- Ran every EC. EC-1..EC-4 via `scripts/shell/checks/phase4-exit-checks.sh` = PASS. EC-5..EC-14, EC-16, EC-17 verified (see CLOSEOUT §2).
- **EC-15 GREEN**: `run-five.sh phase4` → `phase3-logs/phase4-summary.txt` all five suites `exit=0`, ends `DONE` (hb-all incl. 17 Playwright journeys; hb-extra all suites PASS). The agent-trade-test stays a harness SKIP (pre-existing unstable, bug 2026-09-05/001); `bot-trade-test` lifecycle PASS exercises the live boundary.
- Root-cause fix that unblocked EC-15: external skills were being swept into the e2e reseed's `:system:1` revision reset, leaving `skills.current_revision_id` dangling → trading-agent-create FK 500 → plan-limit 403 cascade. Scoped reseed to `source_ref IS NULL` (herobids `df6dfa42`).
- Updated PROGRESS rows 13 and 14, this cursor, HANDOVER, and CLOSEOUT.md (exit-check table, tools not moved, T0.7 outcomes, escalations, Contemplator rulings, IVs, branches). Reported to operator; no merge/push performed.

## Phase 4 decisions log (append here)

| # | Decision | Date |
|---|---|---|
| P4-1 | **Tool → skill `_meta` key (T0.4).** First check whether the MCP Skills extension (SEP-2640) defines a field linking tools to skills; if it does, use it. Otherwise use `io.agentskills/skillRefs`, whose value is an array of refs in `owner/repo/skill` form (e.g. `["traderton/skills/crypto-trading"]`). Neutral: names neither herobids nor Traderton. **Resolved 2026-10-04:** SEP-2640 (stable `io.modelcontextprotocol/skills`) defines only skill-RESOURCE `_meta` keys (under `io.modelcontextprotocol.skills/`) for frontmatter; it defines NO tool→skill linking key. So the fallback applies: key = `io.agentskills/skillRefs`. Implemented as `SKILL_REFS_META_KEY` in `traderton/packages/boundary/src/mcp/skill-tool-map.ts`. | 2026-10-03 (operator); confirmed 2026-10-04 |
| P4-2 | **`npx skills add` accepts a local path and a `file://` git URL**, and picks up committed edits on reinstall (verified 2026-10-03 against a clone of `traderton/skills`). EC-7 uses the real CLI with a `file://` fixture repo | 2026-10-03 |
| P4-3 | **Skill names must match their directory** (Agent Skills spec). `npx` resolves `@<skill>` against the frontmatter `name`. openaidom-skills was fixed and pushed on 2026-10-03; the traderton skills already comply. Herobids assumes ref segment == `name` | 2026-10-03 (operator) |
