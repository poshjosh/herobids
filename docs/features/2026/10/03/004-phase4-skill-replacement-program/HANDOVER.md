# Phase 4 — Session handover

Update at the end of every session (ENTRYPOINT §8). Newest entry first.

## Template

```
### <date> — <agent/session>
- Done: <tasks> (herobids <sha>, traderton <sha>, traderton-skills <sha>)
- In progress: <task + state>
- Next action: <exact next step>
- Failing checks / suites: <list, or none>; baseline failures: <list>
- Session ended because: <session end | end of run (awaiting merge decision)>
```

## Entries

### 2026-10-04 — Phase 4 completion (T9–T13 landed, EC-15 green, CLOSEOUT filled)
- Done:
  - **T9/T9b/T10(remainder)/T11/T12** (herobids `4ed0c0fb`, `39c4dee0`, `cbe23922`): deleted the three built-in trading `SkillDefinition`s + `BUILTIN_TRADING_SOURCE_REFS` + trading `TOOL_OWNER_OVERRIDES` (now `{}`); rewired preset refs + web/API id checks to external refs / capability-family labels; added `scripts/shell/checks/phase4-exit-checks.sh` (EC-1..EC-4 PASS); recorded IV-a..IV-f + PROGRESS rows 13/14.
  - **T13 create-path hardening** (herobids `dd56c8e6`, `14a30b94`): `ensureExternalSkillIds` creates placeholder catalog rows for unknown skills.sh refs so agent creation is never blocked; API startup catalogues the approved refs; e2e trading journeys updated to the external slugs (`traderton/skills/crypto-{trading,bot-management}`).
  - **T13 EC-15 root-cause fix** (herobids `df6dfa42`): the e2e-tier skill reseed in `run-all-tests.sh` was resetting *every* `author_id IS NULL` skill's revision to `:system:1`, including external skills.sh skills — deleting their `:external:1` revision while leaving `skills.current_revision_id` pointing at it (dangling FK). That made trading-agent creation 500 (agent_skills FK violation) and cascaded into `plan.limit_exceeded` 403s. Scoped the reseed DELETE/INSERT to `source_ref IS NULL`. Fixes e2e journeys 16 & 19 and the agent-create shell suites.
- **EC-15 GREEN** (`phase3-logs/phase4-summary.txt`): tt-all / tt-extra / tt-integration / hb-all / hb-extra all `exit=0`, ends `DONE`. hb-all = build+lint+unit 6714+integration 23+functional 188+API smokes+**17 Playwright journeys**; hb-extra = all suites PASS incl. `platform-preset-assessment` (3 SKIPs are the pre-existing unstable set, bug 2026-09-05/001).
- Operability note for the next operator: the five-suite assumes a CLEAN docker slate. When a `run-five.sh` run is interrupted, the detached `docker compose up` containers survive the killed shell and re-bind 5432/6379 — force-remove them (`docker ps -aq --filter name=herobids|traderton | xargs docker rm -f`) before relaunching, or tt-all fails fast with "port is already allocated".
- In progress: none — Phase 4 implementation complete.
- Next action: operator review + merge decision (see CLOSEOUT §5 E1 re: concurrent traderton commits). No merge/push performed.
- Failing checks / suites: none. Baseline failures: the 3 harness SKIPs (agent-trade-test / preset-review-gap-closure / scanner-provider-smoke) are pre-existing unstable tests, not Phase-4 regressions.
- Branches/commits: herobids `phase4-skill-replacement` @ `df6dfa42`; traderton @ `8ef8c3e` (my T2 = `51674ae`, ancestor); traderton-skills @ `213c8fb`.
- Session ended because: end of run (CLOSEOUT filled; awaiting operator merge decision).

### 2026-10-04 — Phase 4 kickoff session
- Done: Setup — created branch `phase4-skill-replacement` in herobids, traderton and traderton-skills (all off clean `main`).
- Baseline (untouched branches, 2026-10-04):
  - herobids `pnpm lint` (tsc --noEmit): **exit 0**
  - herobids `pnpm build`: **exit 0**
  - traderton `pnpm lint`: **exit 0**
  - traderton `pnpm build`: **exit 0**
  - Full five-suite baseline (`run-five.sh`) NOT yet captured — it needs Docker (postgres/redis/boundary/full stack + Playwright) and is expensive. Known pre-existing suite state is in `phase3-logs/*-summary.txt` (all `exit=0` on the last Phase 3 `g2`/`g0` runs). Will capture a fresh baseline-vs-after comparison at T13 verification.
  - Docker available (server 29.5.2); no containers currently running.
- In progress: T0 pre-reads (next).
- Next action: T0.1/T0.2/T0.3/T0.7 investigation.
- Failing checks / suites: none observed yet; baseline failures: none in lint/build.
- Session ended because: (ongoing)

### 2026-10-04 — Phase 4 implementation (T2–T4 landed)
- Done:
  - **T2** (traderton `51674ae`): MCP `tools/list` now built from Traderton's own registry; `_meta` key `io.agentskills/skillRefs` (P4-1 confirmed — SEP-2640 defines no tool→skill key); descriptor projection + conformance test + fixtures deleted; `.env*.example` cleaned. traderton lint + all boundary MCP tests pass (incl. real-SDK leg).
  - **T3** (traderton-skills `213c8fb`): three SKILL.md frontmatters reduced to spec fields (name/description/metadata.tags); requiredTools dropped; bodies unchanged.
  - **T4** (herobids, uncommitted): added `skills.source_ref` (unique when set) + `skills.last_installed_at` + `skill_revisions.source_ref`; migration `0072_bouncy_lorna_dane.sql`; `inferSkillFromRevisionRow` now reads `sourceRef`; new `packages/db/src/external-skill-catalog.ts` (`upsertExternalSkill` metadata-only, `normalizeSourceRefToSlug`, `deriveSourceKind`). @herobids/db builds clean.
- **Pre-existing drift absorbed:** `drizzle-kit generate` also emitted drops of `agents.{capital,risk,risk_overrides,execution_defaults}` — those columns were removed from the schema source by commit `91fcd7a7` ("Move agent trading state to Traderton profiles") on `main` with NO migration. My `0072` migration includes those drops (snapshot↔SQL consistency; D6 greenfield = no data-loss risk). Not a Phase-4 change; noted so it is not mistaken for one.
- In progress: T5/T6 (install-at-start loop + add_skills/remove_skills/list_skills lifecycle + presets + stop auto-adding file-management).
- Next action: add per-start external-skill install loop near `apps/worker/src/agent.ts:543` using `getWorkspacePaths` + `ExternalSkillInstaller`; refresh name/description from frontmatter; wire `upsertExternalSkill` into add_skills + API preset path.
- Failing checks / suites: herobids `pnpm lint` currently FAILS by design — `config/default.yaml` was changed (mcpPath/requiresConnectionFamily/removed descriptor keys) but the config SCHEMA + consumers are T8/T10, not yet done. Will be green by end of T10.
- Branches/commits: herobids `phase4-skill-replacement` (T4 uncommitted), traderton `51674ae`, traderton-skills `213c8fb`.

### 2026-10-04 — Phase 4 implementation (T8 + descriptor deletion landed)
- Done:
  - **T8 + T10(descriptor half)** (herobids `482e9cbf`): backend-approved tools now discovered over MCP `tools/list` (McpTransport.listTools + domain discover-tools.ts; worker backend-tool-visibility.ts replaces the descriptor pipeline). config schema: `requiresConnectionFamily` added, `trustedDescriptorSigningKeys`/`descriptorPinning` removed. GET /capabilities families now union config backend families (not SYSTEM_SKILLS). hasSkillCapabilityFamily resolves approved refs via a config-registered map. Deleted all descriptor+signing machinery in both repos (domain descriptor.ts + conformance + fixtures + port; worker apply-tool-visibility/skill-tool-resolver/descriptor-tool-visibility/file-descriptor-source + tests + skill-publication-e2e + fixtures; config/external-backends/; generate-dev-descriptor + conformance-fixtures scripts). Kept HMAC request signing + REST/MCP client/transport.
  - herobids `pnpm build` + `pnpm lint` + full `pnpm test` (**6723 passed, 0 failed, 332 skipped**) all green.
- In progress: remaining T10 (delete the built-in trading skills TRADING_SKILL/BOT_MANAGEMENT_SKILL/RISK_MONITORING_SKILL/BUILTIN_TRADING_SOURCE_REFS, trading TOOL_OWNER_OVERRIDES, SkillDefinition.sourceRef if unused, signing runbook, trading-text test fixtures) + T9 (chat.ts preset refs, SKILL_PRESET_MAP trading entries, web/API id checks → family, docs index) + T9b (ordering) + T11 (synthetic backend tests + exit-check script) + T12 (IV rows) + T13 (five-suite + agent-trade + browser UAT + CLOSEOUT).
- EC-1 grep currently ~219 hits across ~21 files (skills.ts + many tests + migration 0065) — the built-in trading skill definitions + their test coverage still to remove.
- Next action: delete the three built-in trading SkillDefinitions + BUILTIN_TRADING_SOURCE_REFS + trading TOOL_OWNER_OVERRIDES from packages/domain/src/skills.ts, update SYSTEM_SKILLS/SKILL_PRESET_MAP, then fix the cascade of tests. Then T9 wires presets to the three refs.
- Failing checks / suites: none in build/lint/unit. Full five-suite + agent-trade + browser UAT (EC-15) not yet run (needs Docker) — T13.
- Branches/commits: herobids `phase4-skill-replacement` @ 482e9cbf; traderton @ 51674ae; traderton-skills @ 213c8fb.