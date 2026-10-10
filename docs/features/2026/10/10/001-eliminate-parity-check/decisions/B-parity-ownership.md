# Decision Brief B: End the parity-drift check — per-entry ownership

- **Question:** `scripts/parity-drift-manifest.json` pins ~32 file/region pairs as
  byte-identical mirrors between herobids and traderton, enforced by
  `scripts/check-parity-drift.mjs` in both repos' slow-test CI. The high-level goal is to
  **eliminate the need for this check and remove it entirely**. For each manifest entry,
  who should own the content, and what mechanism (if any) replaces the mirror?
- **Status:** RATIFIED for all items below except those explicitly still marked
  "Blocked on other in-flight work." All five previously-open decision points have
  been resolved (see "Ratified decisions" below). Execution is organized in
  [`../000-roadmap.md`](../000-roadmap.md); the ratified positions are restated as
  rules an agent can follow mechanically in "Mechanical rules for executing agents"
  below, and ambiguities and premise gaps found while setting up execution are
  recorded, without changing any ratified position, in "Clarifications and open
  items" at the end of this document. **Correction (2026-10-10):** the
  `strategy-preset-economy/-premium/-standard` row was acted on and then reverted the
  same day — see that row for the full correction. It is the one entry in the
  "Resolved" table that is **not** actually resolved; treat it as still `mirror-only`.
- **Evidence:** `scripts/parity-drift-manifest.json` (current entries); ADR 011 / B2
  (`docs/features/2026/09/18/001-trading-extraction-completion/decisions/B2-duplicated-authority.md`);
  the two in-flight, not-yet-implemented plans:
  `traderton/docs/features/2026/10/04/004-preset-assessment-data-only/001-plan.md` and
  `herobids/docs/features/2026/10/04/002-preset-assessment-on-traderton/001-plan.md`;
  a grep of traderton's `config/strategy-presets/*.yaml` that found no references (this
  **turned out to be wrong**: the files are live, see the correction in the
  resolved-entries table); live grep confirming herobids' live, in-process
  consumers of the preset catalog (API routes, worker `PlatformAssessor`);
  `investigation-findings.md` (same folder) — symbol-level call-site audit across both
  repos for the remaining ~28 manifest entries, per `investigation-prompt.md`.

## Why the check exists today

Herobids and traderton both run copies of the same trading-core logic. ADR 011 (B2)
chose "split single-sourcing" over full extraction: some authority genuinely moved to
traderton (risk defaults, risk math), but other files were copied byte-identical during
the extraction specifically so behavior could be verified equal, with parity tests
pinning them as the enforcement mechanism. That was a deliberate, reasonable tactical
choice to ship the extraction without inventing a new shared-package or codegen
pipeline. It is a workaround, not a hard constraint, and it is now the thing we want to
remove.

## Options considered for removing a mirror pair (general)

1. **Shared published package.** The owning repo publishes the file(s) as a versioned
   package; the other repo takes a normal dependency. Removes hand-copying; keeps
   compile-time types; costs a registry + release/version-bump step per contract change.
2. **Codegen from a single schema at release time.** One canonical schema (e.g. Zod in
   the owning repo); the other repo's copy is generated, not hand-edited. Smaller effort
   than (1) for Zod-shaped entries only; still coupling, just automated instead of manual.
3. **Runtime discovery / boundary call (MCP-style).** Consumer calls the owner at
   runtime (tool call or HTTP) instead of holding a local copy. Removes compile-time
   coupling entirely; costs a round-trip and loses offline/sync validation. Only applies
   where there is an actual cross-process boundary call to make — most of this manifest
   is in-process logic both sides execute locally, so this option does not apply to most
   entries.
4. **Delete the copy.** If the consumer side never actually uses its copy (dead mirror
   left over from "copy everything first" extraction tactic), delete it. Zero coupling,
   zero cost. Requires proof, not a grep alone: a trial deletion must pass the owning
   repo's own build, type checks and full test suite (invariant I6). The traderton
   preset-catalog YAML was first thought to qualify and does **not** (see the correction
   in the resolved-entries table).
5. **Feature relocation.** Move the whole capability (not just the data/types) to the
   owning repo, exposed as a tool/API. This is what the two existing 2026-10-04 plans
   already do for preset assessment — it resolves the mirror as a side effect of a
   larger, already-decided move, not a parity-specific fix.
6. **Retire the obligation (ratified below).** For generic, no-wire-exposure utility
   code that both repos use independently and that each repo is already free to evolve
   without breaking the other: no package, no codegen, no check. Each repo simply keeps
   its own copy and the manifest entry is dropped. This is not "duplication we're
   choosing to tolerate" — it's recognizing the code was never a cross-repo contract in
   the first place, just a coincidentally-identical utility.

## Resolved entries — ready to ratify

Each row below has a concrete recommendation backed by evidence checked in this
session (not a guess). These can be ratified now, independent of the investigation.

| Manifest entry (id) | Real owner | Recommendation | Mechanism | Evidence |
|---|---|---|---|---|
| `strategy-preset-economy` / `-premium` / `-standard` (**both copies**) | both — this entry is a real wire/behavior contract, not a dead mirror | **CORRECTION (2026-10-10): this row was wrong and has been retracted.** The files were deleted from traderton on this evidence and then restored the same day after traderton's own test suite failed (14 failures: `presets.test.ts`, `agent-strategy.parity.test.ts`, `trading-profiles.test.ts`). Traderton's `packages/domain/src/config/presets-loader.ts` (`loadPresets`/`getPreset`/`listPresets`) is real, tested, and called from production code at `packages/worker/src/tools/trading-profiles.ts` (`resolveActiveStrategy` → `getPreset`, on the `set_agent_trading_profile` tool's live path). The grep that found "zero references" checked for callers of the loader by name across a narrower surface and missed this call site. **Root cause of the mistake:** confirming "dead" from grep across non-test code only, without running the consuming repo's own test suite before deleting — the investigation method stated in `investigation-prompt.md` ("verify actual call sites... do not infer... from AGENTS.md statements alone") was followed for the grep step but the verification was not closed out by actually running `pnpm test` in traderton before acting. All three files, the three manifest entries, and the two `check-parity-drift.mjs` allowlist entries have been restored. This entry is **not** resolved; treat it as it was before this investigation — a live `mirror-only` contract, until the entries below's actual plan (H5) retires it. | n/a — stays `mirror-only` | `packages/worker/src/tools/trading-profiles.ts:178` (`validateScanConfiguration` → `resolveActiveStrategy` → `getPreset`); `packages/domain/src/config/agent-strategy.parity.test.ts` (explicit parity-oracle test, its own comment: "Traderton must resolve each (preset, styleTier) to the IDENTICAL split... guards against future drift in either copy"); traderton `pnpm vitest run` showing 14 failures after deletion, 0 after restoration. |
| `strategy-preset-*` (**herobids copies**), `domain-config-presets`, `domain-config-presets-loader`, `domain-config-strategy-parameters` | herobids today; moving to traderton | Superseded, not fixed directly. Execute the existing plan pair (traderton `docs/features/2026/10/04/004-preset-assessment-data-only/001-plan.md`, herobids `docs/features/2026/10/04/002-preset-assessment-on-traderton/001-plan.md`). Herobids plan step H5 explicitly removes herobids' copy once `list_strategy_presets` (a traderton tool) replaces every local consumer. Delete these manifest entries only when H5 completes, not before. **Note:** given the correction above, traderton's own copy is also live and consumed in traderton — H5's execution needs to additionally confirm what replaces traderton's own `loadPresets()`/`getPreset()`/`listPresets()` call sites, not just herobids'. | (5) feature relocation, already planned | Read both plan docs in full. Herobids plan confirms live in-process consumers today (API blueprint routes, worker `PlatformAssessor` hot-path ranking), which is why "just fetch at runtime" was rejected in favor of relocating the whole feature instead of leaving herobids as a network-dependent consumer of its own former data. |
| `agent-risk-defaults` (YAML block) | traderton | Already fetch-at-runtime via boundary read for display (`get_operator_defaults`). Finish the job: drop the committed/cached YAML block in herobids, cache the boundary read in memory at process start instead of a file checked into git. | (3) runtime, partially done — just needs the leftover file removed | ADR 011 / B2 doc states this directly: traderton is the authority, herobids consumes typed boundary reads and does not enforce local copies. |
| `tick-gates-session-hours` (**traderton copy only**) | herobids (sole executor; see `tick-gates-session-hours` row below for herobids' side) | Delete traderton's `tick-gates.ts`, `tick-gate-state.ts`, and their 3 test files (one already quarantined). Not imported outside tests; already stale relative to herobids' copy (missing `hasUserMessage`, `hasReminderWake`, `msUntilNextAllowedHour`). | (4) delete | `apps/worker/src/agent.ts:2848,2967` call herobids' gate in production; traderton's copy has zero non-test importers; last touched at commit `578180f` vs. herobids' later `014fe735`/`e77473c6`. |
| `domain-ports-candle-fetcher` (**herobids copy, `CandleFetcher` only**) | traderton | Delete herobids' `CandleFetcher` type/port — zero herobids references. The `PriceCandle` type in the same file stays for now (see Blocked section). | (4) delete (partial file) | Zero herobids importers of `CandleFetcher`; traderton uses it in `strategy/mechanical-strategy.ts`, `venues/candle-fetcher.ts`, `worker/trading-actor.ts`. |
| `domain-ports-mark-source` | traderton | Delete herobids' copy. | (4) delete | Zero herobids references; traderton uses it in `engine/trading-cycle.ts`, `engine/instrument-executor.ts`, `venues/*-mark-source.ts`. |
| `domain-ports-sentiment` | traderton | Delete herobids' copy. | (4) delete | Zero herobids references; traderton uses it in `strategy/mechanical-strategy.ts`. |
| `domain-ports-strategy` | traderton | Delete herobids' copy. | (4) delete | Zero herobids references; traderton uses it in `strategy/*`, `engine/trading-cycle.ts`, `backtesting/*`. |
| `domain-ports-subscription` | traderton | Delete herobids' copy. | (4) delete | Zero herobids references; traderton uses it in `venues/*-stream.ts`, `engine/stream-market-data-feed.ts`. |
| `domain-ports-swap-venue` | traderton | Delete herobids' copy. | (4) delete | Zero herobids references; traderton uses it in `engine/swap-live-executor.ts`, `venues/jupiter-swap.ts`, `oneinch-swap.ts`. |
| `domain-ports-token-safety` | traderton | Delete herobids' copy. | (4) delete | Zero herobids references; traderton uses it in `engine/decision-intake.ts`, `worker/token-safety-adapter.ts`. |
| `domain-ports-venue` | traderton | Delete herobids' copy. | (4) delete | Zero herobids references; traderton uses it in `engine/live-executor.ts`, `engine/reconciliation/*`, `venues/hyperliquid.ts`, `bybit.ts`. |
| `domain-values-ids` (**herobids copy**) | traderton | Delete herobids' copy once the cluster it's used in (`ports/venue`, `models/decision`, `values/instrument`) is deleted — all three are themselves slated for deletion below. `AgentId`/`SkillId` have no consumer in either repo. | (4) delete | Traderton uses branded ids across 19 files; herobids' only consumers are the files being deleted in this same batch. |
| `domain-values-instrument` | n/a — dead in both | Delete from both repos. | (4) delete both | Zero importers of `Instrument` in either repo. |
| `domain-pagination` | n/a — dead in both | Delete from both repos. | (4) delete both | `PaginatedResponse` has no production importer in either repo; herobids' only reference is a test file. |
| `domain-trading-venue-capability` (**herobids copy**) | traderton | Delete herobids' copy and the orphaned `tests/fixtures/venue-capabilities.ts` (no importer). | (4) delete | Traderton uses it in `engine/live-executor.ts`, `planner.ts`, `order-state.ts`, `venues/bybit.ts`, `hyperliquid.ts`; herobids' only reference is the orphaned fixture. |
| `domain-models-decision` (**herobids copy**) | traderton | Delete herobids' copy; retarget the one `ActorType` import in `services/approval-service.ts` to one of herobids' two existing equivalent unions (`ActorTypeSchema` in `agent-protocol.ts`, or `ExternalBackendActorType` in `external-backend/contract.ts`) rather than keep a third. | (4) delete | `Decision` is imported in herobids only by the dead `ports/strategy.ts` (also being deleted); traderton uses `Decision` across `engine/planner`, `strategy/*`, `boundary/contract.ts`, `worker/*` (12 files). |
| `domain-cost-profile` (**traderton copy**) | herobids | Delete traderton's copy. Herobids is the sole owner. | (4) delete | Zero traderton references; herobids uses it for LLM tick-thinking and cost presets (`agent.ts`, `tick-thinking.ts`, `cost-profile.ts`, `agent-config-helpers.ts`, `agent-evaluation-narrative-llm.ts`). |

## Dependencies / sequencing for the resolved entries

- ~~The traderton-side preset YAML deletion has no dependency — do it any time.~~
  **Retracted — see the correction in the resolved-entries table.** Traderton's copy
  is live, not dead; do not delete it outside of executing the full H5 plan.
- The herobids-side preset/catalog retirement depends on the full 2026-10-04 plan pair,
  which itself depends on Wave E's herobids halves (E1-H, E3-H; the traderton halves are done, the herobids halves wait for the human's go) and traderton's preset plan S1-S9. Do not remove those
  manifest entries until H5 (herobids plan) actually lands.
- `agent-risk-defaults` file removal has no dependency beyond confirming no other code
  path still reads the committed YAML directly (quick grep before removing).
- All of the no-dependency deletes above (tick-gates, the 8 domain-ports entries,
  `domain-values-ids`/`instrument`, `domain-pagination`, `venue-capability`,
  `domain-models-decision`, `domain-cost-profile`) can be done any time, in any order,
  independent of the preset-plan or Wave E. After each deletion, also prune the relevant
  barrel file (`ports/index.ts`, domain `index.ts`) and remove the manifest entry.
  `domain-values-ids` should be deleted together with (or after) `ports/venue`,
  `models/decision`, and `values/instrument`, since those are its only herobids
  consumers. Deletion PRs should run `pnpm lint` and
  `pnpm exec tsc --noEmit -p apps/worker/tsconfig.json` (root lint does not cover the
  worker).

## Ratified decisions (previously "needs a decision")

1. **New disposition (6) "retire the obligation" — ACCEPTED**, scoped narrowly: applies
   only when the code has no wire exposure and each repo's copy is already free to
   evolve independently without breaking the other. Confirmed to apply to
   `domain-result` and `domain-values-money`. Added to the options list as the sixth
   disposition (see below). Do not apply to a new candidate without re-checking it
   against that bar.
2. **`domain-trading-execution-capability` / `domain-trading-mode-rank` — ACCEPTED:
   delete herobids' local pre-check.** Herobids drops its local
   `validateExecutionCapability` / `checkModeEscalation` calls (`routes/bots.ts`,
   `routes/agents.ts`, `routes/capabilities/trading.ts`, `tools/bots.ts`) and maps
   traderton's typed boundary error codes instead, the same pattern as plan H2's
   preset-policy/risk-ceiling error mapping. Accepted tradeoff: rejection of a bad
   mode-escalation or capability request now costs one network round-trip instead of
   being caught synchronously client-side; no enforcement behavior changes, since
   traderton was already the authoritative check.
3. **`domain-trading-actor-health` — ACCEPTED: remove.** Confirmed via direct read of
   `apps/api/src/routes/actor-health.ts` and a grep of `apps/web` that `GET
   /agents/:id/health` and `GET /bots/:id/health` have zero frontend consumers — the
   agent detail page's visible "runtime status" comes from the plain `agents.get(id)`
   response and SSE `agent.status` events, an unrelated mechanism that is not affected
   by this removal. Delete the route, `ActorHealthSnapshot`, `actorHealthKey`, the
   worker's `actor-health-publisher.ts`, and traderton's dead copy of
   `trading/actor-health.ts`. The bot-health variant's call to traderton's
   `get_owner_bot_status` boundary read goes away with the route; nothing else depends
   on it. Flag to the original author before deleting, in case an external
   integration (outside this codebase) depends on the route.
4. **`domain-agent-risk-contract` — ACCEPTED: boundary read**, same mechanism as
   `agent-risk-defaults`. Full behavioral analysis, expected-vs-failing-state matrix,
   and the required test plan (write first, including tests expected to fail today)
   are documented separately in
   `docs/features/2026/10/10/001-eliminate-parity-check/decisions/agent-risk-contract-retirement.md`.
   Do not implement until that document's open items are checked and its test plan has
   been run once to record current behavior.
5. **Wire-DTO contract set mechanism — RESOLVED: shared client package published by
   traderton.** Checked the real `DescriptorToolSchema` (not a stale copy) directly:
   it carries only `inputSchema`, no `outputSchema` — so pure runtime discovery
   (option 3) cannot cover tool **result** shapes, only inputs. Rather than split the
   mechanism (inputs discovered, outputs packaged), traderton publishes a versioned
   client package (types, and optionally a thin SDK) that herobids depends on for the
   whole wire-DTO set — one mechanism, covering both directions uniformly. This is
   option (1) applied specifically at the client/contract layer, with traderton as
   sole publisher since it is the server/producer in every one of these entries. This
   is herobids' first `@traderton/*` dependency; the registry/versioning mechanics
   below still need to be settled before implementation.

## Resolved by ratified decision 1 (disposition 6)

- `domain-result`: each repo keeps its own copy; drop the manifest entry.
- `domain-values-money`: herobids drops its mirrored wrapper and takes a direct
  `decimal.js` dependency (already present transitively via
  `packages/domain/package.json`); drop the manifest entry.
- `domain-values-index`: follows its members — once `money` is retired per (6) and
  `instrument`/`ids` are deleted per the resolved-entries table above, this barrel
  file's content changes accordingly in each repo; no separate mechanism needed.
- `domain-ports-economic-calendar`: herobids keeps a local 7-field tolerant view type
  next to the renderer (`runtime-composition.ts`) instead of the mirrored port —
  this is disposition (6)-shaped (no wire validation happens today; the boundary
  response is read loosely). Delete herobids' mirrored `economic-calendar.ts` port;
  keep the local view type. Traderton keeps its copy as the real provider-facing port.

## Wire-DTO package mechanics — RESOLVED

Registry choice, version-pin strategy, and the CI dual-checkout question are now
settled: GitHub Packages (reuses the existing `poshjosh` org auth boundary), exact
version pins bumped by the existing `release-xstack.sh` tooling, and the dual-checkout
`parity-drift` CI job is removed entirely once this package and the rest of Brief B's
items are resolved. Full reasoning in
`docs/features/2026/10/10/001-eliminate-parity-check/decisions/wire-dto-package-mechanics.md`.
This still only settles mechanics — implementing the package (carving
`@traderton/contracts` out of `packages/domain`, publishing it, switching herobids
over) is unauthorized future work, not done by this brief.

## Blocked on other in-flight work

- `domain-market-assessment`, part of `domain-scanner-types` (`ScannerCandleTarget`,
  `SwapExecutionIdentity`), and the `PriceCandle` residue in `domain-ports-candle-fetcher`
  — wait on the 2026-10-04 plan pair's step H5. **The two gaps found in H5 are now
  fixed** (herobids plan doc updated in place): H5 now explicitly names
  `packages/domain/src/market-assessment.ts`, `review-pre-check.ts`, and the
  assessment ports for deletion/pruning, and explicitly carves out
  `market-intelligence/monitor.ts` / `coordinator.ts` as **not** part of H5's delete
  list (they produce herobids' own wake capability, a distinct feature from the LLM
  preset-assessment this plan retires). These manifest entries remain blocked on H5's
  *execution*, not on further planning — the plan itself is now complete.
- `domain-trading-trading-protocol` (wake region), `watch-types`, `scan-types`,
  `RegimeResult`/`VolatilityEvidence`, `AgentRiskOverridesSchema` — the wire-DTO
  contract set. Mechanism and mechanics are both resolved (see above); blocked only on
  someone authorizing and executing the package-carve-out implementation. The unused
  schema portion of `trading-protocol` in traderton's copy can be deleted
  independently of the package work.

See `investigation-findings.md` (same folder) for full evidence on every entry listed
in this brief, `agent-risk-contract-retirement.md` for the detailed test-first plan
for ratified decision 4, and `wire-dto-package-mechanics.md` for the registry/version/
CI decisions above.

## Mechanical rules for executing agents

This section restates, as rules, what the tables and decisions above ratify. It adds no
new position. Where a rule says "verify", run the call-site grep in both repos at
execution time (see `../invariants-and-quality-gates.md`, invariant I6); the findings
document is evidence, not a substitute.

- **R1 — Dead copy.** If a file has no non-test, non-`dist`, non-`_deferred*` reference
  in one repo **and** a trial deletion passes that repo's own build, type checks and full
  test suite (a grep alone is not enough: it retracted the preset-YAML row), delete that
  repo's copy, remove its manifest entry (and its id from
  `REQUIRED_ENTRY_IDS` / `REQUIRED_ENTRY_AUTHORITIES`), and prune every barrel that
  exports it. Do not create a package for it.
- **R2 — Herobids-side dead copies to delete:** `ports/{mark-source,sentiment,strategy,
  subscription,swap-venue,token-safety,venue}.ts`; the `CandleFetcher` export only from
  `ports/candle-fetcher.ts` (**keep `PriceCandle`** until step H5 executes);
  `trading/venue-capability.ts` and the orphaned `tests/fixtures/venue-capabilities.ts`;
  `models/decision.ts` (retarget the single `ActorType` import); `values/ids.ts` (only
  after its consumers in this list are gone); `values/instrument.ts` and `pagination.ts`
  (also deleted in traderton).
- **R3 — Traderton-side dead copies to delete:** `packages/worker/src/tick-gates.ts`,
  `tick-gate-state.ts` and their three test files (and the `_deferred-config/README.md`
  mention); `cost-profile.ts`; `values/instrument.ts` and `pagination.ts`; and, with the
  `actor-health` removal, its dead copy. **Not** the `config/strategy-presets/*.yaml`
  files: those are live (see the correction in the resolved-entries table).
- **R4 — Retire the obligation (disposition 6), exactly these entries:** `domain-result`
  (drop the entry; both repos keep their copy); `domain-values-money` (drop the entry;
  herobids keeps its wrapper: human decision 2026-10-10, clarification O2); `domain-values-index` (a barrel that follows its members:
  drop the entry at the first change to either repo's barrel); `domain-ports-economic-
  calendar` (herobids deletes the mirrored port, keeps a local 7-field view type next to
  the renderer, drops the entry; traderton keeps its copy).
- **R5 — Preset entries.** The three `strategy-preset-*` entries stay `mirror-only`, and
  so do `domain-config-presets*` / `domain-config-strategy-parameters`, until step H5 has
  executed and it has been confirmed what replaces traderton's own `loadPresets()` /
  `getPreset()` / `listPresets()` call sites (resolved-entries row 2). Neither repo's
  preset files are touched before then.
- **R6 — execution-capability / mode-rank.** Herobids removes its local
  `validateExecutionCapability` / `checkModeEscalation` calls and relies on traderton's
  typed boundary errors, **site by site, only where a traderton-side equivalent has been
  verified** at execution time. A site with no verified equivalent is not covered by
  this rule; it goes to the heavyweight path (clarification O1).
- **R7 — actor-health.** Remove the herobids routes, `ActorHealthSnapshot`,
  `actorHealthKey`, the worker's `actor-health-publisher.ts`, and traderton's dead copy,
  **after** a human confirmation (no external consumer) is recorded in the ledger.
- **R8 — agent-risk-contract.** Boundary read. Follow
  `agent-risk-contract-retirement.md`'s test-first gate exactly. Do not edit herobids's
  still-mirrored `agent-risk-contract.ts` (invariant I5); the entry is dropped when
  `AgentRiskOverridesSchema` moves to the package.
- **R9 — Wire-DTO set.** One traderton-published package, `@traderton/contracts`, on
  GitHub Packages under the `poshjosh` org, exact-version pin in herobids, bump
  automated in `release-xstack.sh`. Entries are dropped when herobids consumes the
  package, not before.
- **R10 — Blocked set.** Do not drop, narrow, or edit anything in the Track-D set before
  H5 has executed.
- **R11 — Shrink incrementally.** The manifest shrinks entry by entry and the checker
  keeps running for what remains. The checker, manifest, test and CI job are deleted
  only when the manifest has zero entries (milestone C6).

## Clarifications and open items

Added 2026-10-10 while setting up the execution framework. **None of these changes a
ratified position.** Each is either a clarification an agent can follow, or an item
that needs a human.

- **O1 — Premise gap in decision 2 (needs a human for one site).** Decision 2 says
  traderton "was already the authoritative check". Verified 2026-10-10 for the **bot**
  paths (`traderton packages/worker/src/composition/drive-target.ts:300,330,606`,
  `tools/bots.ts:965,1185,1217`). **Not found** for the **agent** path: herobids's
  `routes/agents.ts:1276` rejects an agent execution mode that conflicts with the
  agent's active connection's venue type (paper on swap), and traderton's agent-direct
  actor ensure has no equivalent. `routes/capabilities/trading.ts:1286` is dead code
  (`agentExecMode` is hard-coded `undefined`) and can simply be removed. Consequence:
  dropping `routes/agents.ts:1276` is a behavior change, not a pure de-duplication.
  That one site is milestone B1.2 and requires a decision brief.
- **O2 — Money wording. RESOLVED (human, 2026-10-10): keep herobids's `values/money.ts`
  wrapper; only the manifest entry is dropped (milestone A1). The original clarification
  follows, kept for the record.** Disposition (6)'s general text says each repo "keeps its own
  copy", while the `domain-values-money` bullet says herobids "drops its mirrored
  wrapper and takes a direct `decimal.js` dependency". Both agree that the manifest
  entry is dropped. The execution plan follows the entry-specific text (replace the
  wrapper in the three herobids files that use it, delete `values/money.ts`) because
  it is the more specific ratified statement. A human may veto this and keep the
  wrapper; the manifest entry is dropped either way.
- **O3 — Preset row (superseded by the correction).** An earlier draft of this
  clarification read the preset rows as allowing the `strategy-preset-*` entries to be
  dropped with traderton's copies. That was based on the retracted "dead copy" claim and
  is withdrawn; rule R5 and the correction in the resolved-entries table govern.
- **O4 — Timing of the `trading-protocol` trim.** The ratification says the unused
  schemas in traderton's copy "can be deleted independently". Doing so before the
  package exists would force dropping the pin on the wake envelope and leave a
  producer/consumer wire contract unprotected until the package lands, so the
  roadmap sequences the trim inside the contracts-package milestones (C1.4 / C4). A
  human may pull it forward at the cost of that unprotected window.
- **O5 — Sequencing note "in any order".** The statement that the no-dependency deletes
  can run "any time, in any order" holds for herobids-only changes. Traderton-side
  deletions have a mandatory order against herobids's release and the parity pin; see
  `../invariants-and-quality-gates.md`, section 2 and invariant I3.
- **O6 — Package install authentication.** `wire-dto-package-mechanics.md` settles how
  CI **checkouts** authenticate (same `GITHUB_TOKEN` boundary) but is silent on how
  Docker builds and local `pnpm install` authenticate to GitHub Packages. Milestone
  C3.0 must settle it; if the answer needs a new secret or credential, that is a
  heavyweight decision.
- **O7 — Method gap behind the retracted preset claim.** "Dead" was concluded from a grep
  of non-test code and acted on without running the consuming repo's own suite; traderton's
  `pnpm test` then failed (14 tests) and the deletion was reverted. Execution therefore
  requires a **trial deletion judged by the owning repo's build, type checks and full
  test suite** (invariant I6). On 2026-10-10 every other dead-copy claim in this brief
  was re-verified that way; results are in the roadmap's "Verification of the dead-copy
  claims".
- **O8 — AGENTS.md drift. RESOLVED (2026-10-10).** The parity-drift rule's step 3 told
  agents to record pin pairs in the old extraction ledger (stale since commit
  `1d637397`). With the human's approval it now points at this epic's ledger.
