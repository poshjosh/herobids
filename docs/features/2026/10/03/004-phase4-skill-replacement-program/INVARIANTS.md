# Phase 4 — Frozen exit checks

**Frozen on 2026-10-03.** Only the operator may change a check. Phase 4 is done only when **every** check passes. (EC-17 was added by the operator on 2026-10-03.) See ENTRYPOINT §2 for the stop rule.

**Grep scope** (unless stated otherwise): herobids `apps packages scripts config`, excluding `node_modules`, `dist` and `**/*.d.ts`. `docs/` is history and is excluded.

T11 should turn checks EC-1..EC-4 into a script at `scripts/shell/checks/phase4-exit-checks.sh`.

## A. Herobids no longer owns trading skills

| ID | Check | Pass |
|---|---|---|
| EC-1 | `rg -n "TRADING_SKILL\|BOT_MANAGEMENT_SKILL\|RISK_MONITORING_SKILL\|BUILTIN_TRADING_SOURCE_REFS\|system/trading\|system/bot-management\|system/risk-monitoring"` | 0 hits, tests included |
| EC-2 | No trading skill text in herobids: `rg -n "grouped by workflow phase\|You have access to bot-management tools\|You have access to risk-monitoring and alerting tools"` | 0 hits, including tests, fixtures and `config/` |
| EC-3 | No hard-coded trading skill **ids**: `rg -n "[sS]killIds?\b.*'(trading\|bot-management\|risk-monitoring)'\|\bid === '(trading\|bot-management\|risk-monitoring)'"`. `TOOL_OWNER_OVERRIDES` has no trading tools, or no longer exists. No preset maps to those ids | 0 hits. Family-label checks (`capabilityFamilies.includes('trading')`, `family === 'trading'`) are allowed (D28, F-3); any remaining hit must be shown to be a family label |
| EC-4 | Descriptor and signing machinery gone: `rg -n "trustedDescriptorSigningKeys\|descriptorPinning\|resolveDescriptorTools\|DescriptorWrapper\|generate-dev-descriptor\|descriptor-conformance\|\.descriptor\.json"`; `config/external-backends/` does not exist. Same grep in traderton (`packages scripts`): 0 hits, and `BOUNDARY_MCP_DESCRIPTOR_PATH` is gone from code and `.env*.example` | 0 hits, both repos |

## B. One lifecycle for every skills.sh skill

| ID | Check | Pass |
|---|---|---|
| EC-5 | **Assignment:** `add_skills <ref>` for an *unapproved* skills.sh ref (a fixture repo) creates one DB row with `source_ref`, `name` and `description` assigned to the agent, and stores **no** skill body (assert the row has no instruction content). The same holds for an *approved* ref and for a preset at agent creation | Pass for all three |
| EC-6 | **Persistence:** after the agent container is recreated, the skill is still assigned, is reinstalled at start (full folder, including a bundled `scripts/` file in the fixture), and `read_skill` returns its body | Pass |
| EC-7 | **Dependency proof** (the goalpost-defeater). Using the real `npx skills` CLI against a local git fixture repo: commit an edited `SKILL.md` line, restart the agent, and `read_skill` returns the new line. Plus an env-gated run against the real `traderton/skills` remote. With the source made unreachable: the agent starts, the skill is listed as unavailable, `read_skill` says so, and a warning is logged | All pass |
| EC-8 | **Progressive disclosure:** the system prompt contains each external skill's `name` and `description` but **not** its body. After `read_skill`, the body appears in the prompt on later ticks of the same session. `system/*` skill bodies are still injected | Pass |

## C. Backend-approved skills

| ID | Check | Pass |
|---|---|---|
| EC-9 | An agent created with the `trading` preset has the three `traderton/skills/*` refs assigned. Its visible tools equal the union of Traderton `tools/list` tools tagged with those refs, intersected with the registry (set equality, asserted in a test). Each of these behaves as before for a trading agent, and as before (absent) for a non-trading agent, each with its own test: trading readiness (venue-account requirement), the startup guard, trading tick-work, `GET /capabilities` listing `trading`, and connection gating | Pass |
| EC-10 | **Calls stay REST:** for those tools, invocation goes through `RestTransport`, while `tools/list` goes through MCP | Pass (asserted) |
| EC-11 | **Backend unreachable at agent start:** the approved skills' tools are hidden, `read_skill` still works, and the agent does not crash | Pass |
| EC-12 | **Genericity:** a synthetic `example-echo` backend (its own MCP fixture server, one approved ref, its own connection family or none) exposes its tools with zero code change, config only | Pass |
| EC-13 | **Traderton:** `tools/list` is built from Traderton's own tool registry with real `inputSchema`s. Every tool carries skill ref(s) in the agreed `_meta` key. No file input is involved | Pass (traderton test) |

## D. Content, suites, records

| ID | Check | Pass |
|---|---|---|
| EC-14 | The `traderton-skills` frontmatter has only spec fields: `name`, `description`, optional `license`, `compatibility`, `metadata` | Pass |
| EC-15 | Both repos pass `pnpm build` and `pnpm lint`. **The five mandated suites run via `~/dev_ai/herobids-traderton/phase3-logs/run-five.sh phase4`** (operator, 2026-10-03): traderton `run-all-tests.sh --e2e`, `run-extra-tests.sh --all` and `run-integration.sh`, and herobids `run-all-tests.sh --e2e` and `run-extra-tests.sh --all`, with its local-boundary (G3) guard. The script always exits 0, so pass = every line in `phase4-summary.txt` reads `exit=0` and it ends with `DONE`. The agent trade test passes. Browser UAT passes for: create a trading-preset agent, trading setup, readiness, and the skill list showing commits | All pass |
| EC-17 | **Ordering**, set by the operator on 2026-10-03. (a) The agent skill picker lists system skills, then backend-approved skills, then user skills, then other external skills (unit test on `listSelectableSkills`). (b) `search_skills` local results follow the same group order, with matching rows only. A query with no match in a group returns nothing from that group: "email" must return no `traderton/skills/*` rows (worker test). The Skills page "All" tab is not checked | Pass |
| EC-16 | Records: IV-a..IV-f recorded (TASKS T12); PROGRESS rows 13/14 updated to done; `.env.example` twins match every env change | Present |
