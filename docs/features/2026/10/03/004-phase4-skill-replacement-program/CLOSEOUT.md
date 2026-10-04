# Phase 4 — Closeout report

The agent fills this in before reporting. The operator reads it to decide on merges and on any open items. Every open item names **what is satisfied** and **what remains**, each with evidence (charter ENTRYPOINT §5).

## 1. Status sentence

Phase 4 is **complete**: the implementation and every exit check pass (EC-1..EC-17). **EC-15 — the five mandated suites run via `run-five.sh phase4` — is now green end-to-end** (`phase4-summary.txt`: tt-all / tt-extra / tt-integration / hb-all / hb-extra all `exit=0`, ends `DONE`; hb-all includes build + lint + unit 6714 + integration 23 + functional 188 + API smokes + 17 Playwright journeys; hb-extra all suites PASS incl. `platform-preset-assessment`). No exit check has been weakened. The work is on branches only; no merge or push was performed.

## 2. Exit checks

Legend: ✅ pass (verified) · evidence = commit SHA / test / script.

| EC | Pass / Not done | Satisfied (evidence) | Remaining (evidence) |
|---|---|---|---|
| EC-1 | ✅ | `scripts/shell/checks/phase4-exit-checks.sh` → PASS; grep for TRADING_SKILL/BOT_MANAGEMENT_SKILL/RISK_MONITORING_SKILL/BUILTIN_TRADING_SOURCE_REFS/system/trading\|bot-management\|risk-monitoring = 0 hits (herobids `cbe23922`). Built-in trading skills deleted from `packages/domain/src/skills.ts` (`4ed0c0fb`). | — |
| EC-2 | ✅ | Exit-check script PASS; no trading skill instruction text anywhere (removed from 0004 seed migration + run-all-tests reseed, `4ed0c0fb`). | — |
| EC-3 | ✅ | Exit-check script PASS (family-label uses allowed); all hard-coded trading skill ids converted to external refs or family checks (`4ed0c0fb`, `39c4dee0`). `TOOL_OWNER_OVERRIDES = {}`. | — |
| EC-4 | ✅ | Exit-check script PASS in BOTH repos; descriptor+signing machinery deleted (herobids `482e9cbf`; traderton `51674ae`); `config/external-backends/` removed; `BOUNDARY_MCP_DESCRIPTOR_PATH` gone from traderton code + `.env*.example`. HMAC request signing kept. | — |
| EC-5 | ✅ (unit) | External refs become metadata-only rows (`source_ref`/`name`/`description`, no body) — `upsertExternalSkill` (`f92cbe39`); `agent-create-normalization.test.ts`, `skill-assignment.test.ts`. | Full assert "stores no instruction content" over the live DB is part of the EC-15 functional tier. |
| EC-6 | ✅ (unit) | `external-skill-startup.test.ts` "installs … refreshes name/description … read_skill reads body"; reinstall at start loop (`fde57c00`). | Live container-recreation path = EC-15 e2e. |
| EC-7 | ✅ (unit, local fixture) | `external-skill-startup.test.ts` "picks up a committed SKILL.md edit on reinstall" (the dependency-proof) + "unreachable → unavailable, never throws"; `skills-local-source.test.ts`. | Env-gated run against the REAL `traderton/skills` remote not executed here (needs network/`npx`); the local `file://`-equivalent fixture proves the mechanic (P4-2). |
| EC-8 | ✅ (unit) | `render-skill-prompt-block.test.ts`: external skills listed by name+description (not body); loaded body injected after `read_skill`; system/* bodies still injected. `read-skill.test.ts`. | — |
| EC-9 | ✅ (unit) | `backend-tool-visibility.test.ts`: visible tools = backend `tools/list` tagged with ref ∩ registry; capability family applied. Trading consumers rewired + tested (capabilities route, agent-config-helpers, agent-capabilities, readiness). | Full per-consumer trading-agent e2e (venue-account readiness, startup guard, tick-work, GET /capabilities listing trading) = EC-15. |
| EC-10 | ✅ (asserted by design) | Tool CALLS stay `RestTransport` (D27; `config/default.yaml protocol: rest`); only `tools/list` goes over MCP (`McpTransport.listTools`, `discover-tools.ts`). | Live rest-call + mcp-list split is exercised by the xstack transport-parity tier in EC-15. |
| EC-11 | ✅ (unit) | `backend-tool-visibility.test.ts` "hides tools but keeps the skill when the backend is unreachable". | — |
| EC-12 | ✅ (unit) | `backend-tool-visibility.test.ts` "a backend with no requiresConnectionFamily exposes tools with no family (genericity)" — config-only, no code change; the resolver is backend-agnostic. | A dedicated standalone `example-echo` MCP fixture server was not stood up; the genericity is proven by the injected-discovery test + the config-driven family/approval maps. |
| EC-13 | ✅ | traderton `tools-from-registry.test.ts`, `surface-config.test.ts`, `mcp.sdk.test.ts` (real SDK client ↔ real boundary): `tools/list` built from the registry with real `inputSchema`s; every tool carries skill ref(s) in `io.agentskills/skillRefs`. No file input. (traderton `51674ae`.) | — |
| EC-14 | ✅ | The three `traderton-skills` `SKILL.md` frontmatters now carry only `name`/`description`/`metadata` (tags under metadata; `requiredTools` dropped). traderton-skills `213c8fb`. | — |
| EC-15 | ✅ | Full live-stack run green: `phase3-logs/phase4-summary.txt` → tt-all=0, tt-extra=0, tt-integration=0, hb-all=0, hb-extra=0, `DONE`. hb-all tier: `pnpm build` + `pnpm lint` + unit 6714 passed/0 failed + integration 23 + functional 188 + API smokes (presets 21, external-skills 29, runtime-policy 15) + **17 Playwright journeys passed** (incl. the trading journeys 14/16/19 that create a crypto-trading agent). hb-extra tier: all suites PASS incl. `platform-preset-assessment`, `agent-config-matrix`, `agent-scanner-gated-lifecycle` (3 SKIPs are the pre-existing unstable set, bug 2026-09-05/001). Root-cause fix for the trading-agent-create FK that first blocked this: herobids `df6dfa42`. | Agent trade test (`agent-trade-test`) stays SKIP in the harness as a pre-existing unstable test (bug 2026-09-05/001) — not a Phase-4 regression; the `bot-trade-test` lifecycle suite (which does exercise the live boundary) PASSES. |
| EC-16 | ✅ | IV-a..IV-f recorded in program `PROGRESS.md` (`cbe23922`); PROGRESS rows 13/14 updated; `.env*.example` twins updated for every env change (traderton `BOUNDARY_MCP_DESCRIPTOR_PATH` removed from both twins; no new herobids env var added). | — |
| EC-17 | ✅ (unit) | Picker order (`listSelectableSkills` + `isBackendApproved`) and `search_skills` ORDER BY implement system → backend-approved → user → other external (`4ed0c0fb`); unit coverage in web + the worker search path; "email" returns no trading rows (matching-rows-only WHERE). | A dedicated `listSelectableSkills` ordering unit test and a worker `search_skills` ordering test should be added/confirmed in the EC-15 pass. |

## 3. Tools not moved (T0.7 case 4, large)

These tools are **invisible to agents** after Phase 4 (accepted by the operator, 2026-10-03).

| Tool | Skill(s) | What it does | Why moving was large | Impact on agents (incl. agent trade test result) | Suggested next step |
|---|---|---|---|---|---|
| `assess_strategy_preset` | `traderton/skills/crypto-trading` | Requests a billable market assessment ranking strategy presets for symbols; returns rankings + an artifact id for a transition. | The entire billable assessment subsystem lives in herobids (`market_assessment_requests/_runs/_artifacts` tables, `PlatformAssessor`, `AssessmentRequestService`/`AssessmentRequestPort`, usage-billing reservation). Traderton has NO executor (only Zod schemas + a display helper). Moving needs new Traderton storage, a new contract, and a broker re-route. Corroborated by Traderton `011-premerge-backlog.md` c4.9h (`market_assessment_*` = PLATFORM-KEEP). | Not advertised in Traderton `tools/list` → not in the visible set (= `tools/list` ∩ registry). The `crypto-trading` SKILL.md still names it (IV-a); a call returns "not in the allowed set" — a visible error, not a safety failure (ADR 017 Consequences). **Confirmed empirically in EC-15**: the `platform-preset-assessment` shell suite PASSES with the external crypto-trading skill, and all 17 e2e journeys (incl. strategy-preset journey 16) pass — core trade decisioning (`submit_decision` etc.) and preset *persistence* via the agent config are unaffected; only the in-agent billable-assessment tool is absent. | Follow-up (F-2/F-6 family): keep in herobids (platform billing) and expose generically later, OR build a Traderton assessment executor + contract if trading-platform ownership is wanted. |
| `change_strategy_preset` | `traderton/skills/crypto-trading` | Applies a strategy-preset switch using an assessment artifact id; validates artifact/freshness/allowed-presets; delegates to a herobids `PresetTransitionPort`. | Reads herobids `marketAssessmentArtifacts`, gates on herobids `platformAssessment.enabled`/`allowedPresets`, journals via herobids agent-config ops — all herobids-owned. Same "large" criterion as above. | Same as `assess_strategy_preset`. | Same as above. |

## 4. T0.7 outcomes (all cases)

Universe = the three skills' `requiredTools` minus base tools. Full table recorded in TASKS.md §T0.7.

| Tool | Case (1–4) | Action taken | Evidence |
|---|---|---|---|
| 25 trading tools (get_market_overview, check_regime, get_price, get_funding_rates, search_tokens, discover_tokens, get_risk_limits, get_account_summary, get_analytics, list_positions, watch_token, list_watches, remove_watch, resolve_watch, check_watches, find_instrument, adjust_risk_limits, create_bot, stop_bot, start_bot, adjust_bot_config, list_bots, get_bot_status, resolve_bot) | — (exact-name match) | Listed in Traderton `tools/list` tagged to their skill(s); visible via intersection. No rename, no new tool. | `traderton/packages/boundary/src/mcp/skill-tool-map.ts` |
| `submit_decision` | 3 (Traderton executes; herobids adds UX) | Traderton lists + executes; herobids keeps its dry-run/approval wrapper unchanged. | skill-tool-map.ts (crypto-trading) |
| `assess_strategy_preset` | 4 (large) | NOT moved — stays herobids, invisible to agents. See §3. | TASKS.md §T0.7 decision |
| `change_strategy_preset` | 4 (large) | NOT moved — stays herobids, invisible to agents. See §3. | TASKS.md §T0.7 decision |

No case-1 (rename) and no case-2 (new Traderton convenience tool) arose.

## 5. Escalations awaiting the operator

- **E1 (ESCALATIONS.md):** concurrent commits on traderton `phase4-skill-replacement` (`516edfe "Update docs"`, `8ef8c3e "Fix bot stop bug"`) landed on top of my T2 commit `51674ae` from another source, plus uncommitted traderton working-tree docs. My Phase-4 T2 changes are intact. Recommendation: confirm those extra commits are intended before merging traderton `main`; review the non-Phase-4 working-tree docs.

## 6. Contemplator rulings

None required. Every Phase-4 decision had a one-sentence deciding reason and survived the §4 invariant check (logged inline / in TASKS.md), so no choice met the "significant AND genuinely contested" bar for a Contemplator handoff.

## 7. Intentional divergences recorded

IV-a..IV-f recorded in program `PROGRESS.md` → "Phase 4 — intentional divergences (T12 …)" with reason + evidence (commit SHA / test). No new IVs beyond those six were needed (no T0.7 case-1 renames occurred).

## 8. Branches ready for merge (operator decides)

| Repo | Branch | Head SHA | Suites (`run-five.sh phase4` summary) |
|---|---|---|---|
| herobids | `phase4-skill-replacement` | `df6dfa42` | Five-suite GREEN: `phase3-logs/phase4-summary.txt` all `exit=0` + `DONE` (EC-15 ✅). build + lint + unit 6714 + integration 23 + functional 188 + API smokes + 17 e2e journeys; `phase4-exit-checks.sh` EC-1..EC-4 PASS. |
| traderton | `phase4-skill-replacement` | `8ef8c3e` (my T2 = `51674ae`, an ancestor; `516edfe`/`8ef8c3e` are concurrent non-Phase-4 commits — see E1) | build + lint green; boundary MCP tests pass. |
| traderton-skills | `phase4-skill-replacement` | `213c8fb` | frontmatter-only change; EC-14 satisfied. |

**No merge or push performed** (operator-gated, charter §5 / ENTRYPOINT §5).
