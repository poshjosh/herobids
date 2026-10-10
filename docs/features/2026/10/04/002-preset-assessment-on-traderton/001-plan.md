# 001 — Preset assessment moves to Traderton (herobids side)

**Status:** planned. **Date:** 2026-10-04. **Do not start** until (a) the human gives the
go (another agent is working in herobids) and (b) the Traderton counterpart is ready to
release.
**Traderton counterpart (authoritative design):**
`traderton/docs/features/2026/10/04/004-preset-assessment-data-only/001-plan.md`.
**Decisions:** traderton `docs/features/initial/004-decision-log.md`:
- "Preset assessment is a trading charge"
- "Preset assessment becomes data-only and free"
- "Agent strategy ownership in the trading profile"

**Prerequisites:** Traderton Wave E E1 + E3 (both halves), plus Traderton plan S1–S9.
**Referenced by:** this plan's completion (step H5) is a Track-D dependency of the
"Eliminate the Parity-Drift Check" epic
(`docs/features/2026/10/10/001-eliminate-parity-check/000-roadmap.md`), which does not
own or modify this plan's scope beyond the H5 gap-fix noted below.

## What changes for herobids

- Herobids stops **executing** the preset assessment and transition, and stops **billing**
  for it.
- The two tools become Traderton tools, reached through the existing external-backend
  path (visible tools = Traderton `tools/list` ∩ herobids registry).
- Herobids keeps the creator's settings (pushed to Traderton), the review screen (now
  showing the data plus the agent's decision and reason), wake delivery, and the agent
  runtime.

## Steps

### H1. Remove the local tools (same release as Traderton lists them)
- Delete `apps/worker/src/tools/assess-strategy-preset.ts` and `change-strategy-preset.ts`
  (+ tests).
- Delete their broker routes (`agents/agent-message-broker.ts` `TOOL_ASSESS_STRATEGY_PRESET`
  / `TOOL_CHANGE_STRATEGY_PRESET`) and the message types / result publishers
  (`instance-event-publisher.ts`, `packages/domain` `agent-protocol.ts`).
- Re-check these references: `tools/tool-errors.ts`, `tools/platform-docs-data.ts`,
  `agent.ts`, `agents/capability-policy.ts`, `hybrid-agent-evaluator.ts`, and
  `packages/domain/src/{tools,tool-schemas}.ts`.
- `config/external-backends/traderton.descriptor.json`: the tool schemas now come from
  Traderton's signed descriptor (re-sign per the descriptor-signing runbook).
- Test: "an agent with the crypto-trading skill sees assess_strategy_preset and
  change_strategy_preset from Traderton and has no local executor for them".

### H2. Push creator preset policy to the profile
- `apps/api/src/agents/trading-profile-reconciliation-saga.ts` + the agents route: send
  `presetPolicy` = `{ changesAllowed: unifiedConfig.platformAssessment.enabled,
  allowedPresets: unifiedConfig.allowedPresets.allowed, styleTier,
  minRequestIntervalMs?: platformAssessment.reviewIntervalMs, changeCooldownMs? }`.
  These are creator inputs only, consistent with the Wave E E1 H1 ownership rule. Never
  send `active_strategy`.
- Agent edit UI: unchanged fields. Validation of interval floors is delegated to Traderton
  (fail-closed error mapping, like the existing risk-posture ceiling errors).
- Tests: "sends the creator's preset policy with the trading profile"; "maps a Traderton
  policy rejection to a user-facing error".

### H3. Review screen (data + agent's decision)
- API `apps/api/src/routes/agent-platform-assessment-reviews.ts`:
  - The manual review `POST /agents/:id/platform-assessment/reviews` stops running a
    billed assessment. It calls Traderton `assess_strategy_preset` on the agent's behalf
    (owner-scoped) and wakes the agent with the artifact id.
  - `GET …/results` reads `get_assessment_artifact` + `list_agent_strategy_changes`
    from Traderton.
  - Remove the billing and eligibility-by-credit paths.
- Web `apps/web/src/features/agents/AgentEvaluations.tsx` + `lib/api-client.ts`:
  - Replace the LLM columns (score, pros/cons, recommended) with the per-preset data
    table: flags, signals, evidence freshness.
  - Show **the agent's decision and its reason** once the agent acts. Keep "no change
    made" as a valid outcome.
  - i18n keys in `app/i18n/locales/{en,ar,hi}.ts`.
- Tests: route tests for the new data flow; web tests for "shows the agent's chosen preset
  and reason" and "shows that the agent kept its current preset".

### H4. Scheduled review → wake delivery only
- Traderton now runs the pre-check and writes `agent_wake` notifications (Traderton plan
  S7). The E3 relay delivers them.
- Delete `market-intelligence/review-scheduler.ts`, `assessment-review-runner.ts` and their
  wiring in `apps/worker/src/index.ts`.
- `apps/worker/src/assessment-review-message.ts`: rewrite the wake text for the data-only
  flow: "call assess_strategy_preset, read the flags per the skill, change only if clearly
  better, give a reason". Keep it short; the skill holds the detailed guidance.
- Test: "builds the review wake text from Traderton review advice".

### H5. Retire herobids assessment machinery + data
- Delete `apps/worker/src/market-intelligence/`:
  - `platform-assessor.ts`, `llm-ranker.ts`, `assessor-factory.ts`
  - `assessment-request-service.ts`, `assessment-settlement-policy.ts`
  - `evidence-adapters.ts`, `preset-scorecard-runner.ts`, `preset-scan-contracts.ts`
  - `preset-transition-service.ts`, `binding-resolver.ts`, `resolve-active-preset.ts`,
    `assessment-identity-resolver.ts`
  - the matching tests, and the wiring in `index.ts` (~L1030–1130)
  - **Gap found and fixed in place (2026-10-10) by the "Eliminate the Parity-Drift
    Check" epic** — see its roadmap
    (`docs/features/2026/10/10/001-eliminate-parity-check/000-roadmap.md`, Track D)
    and evidence
    (`docs/features/2026/10/10/001-eliminate-parity-check/investigation-findings.md`,
    Group 5). That epic is blocked on this plan's completion (via H5) but does not
    own or manage this plan — this list never named the following, which must be
    deleted (or
    explicitly re-scoped and kept, with a reason recorded here) in the same batch,
    otherwise the corresponding `scripts/parity-drift-manifest.json` entries survive
    this plan with no consumer left to justify them:**
    - `packages/domain/src/market-assessment.ts` — of its ~60 exports, only
      `RegimeResult`, `EvidenceValue`, `VolatilityEvidence` have non-assessment
      consumers (`apps/worker/src/venue-intelligence.ts`, `tick-gates.ts`,
      `runtime-composition.ts`; re-verified 2026-10-10). The
      implementing agent must either (a) delete the file and move those three
      specific exports to the wire-DTO contract package
      (`docs/features/2026/10/10/001-eliminate-parity-check/decisions/wire-dto-package-mechanics.md`),
      or (b) keep the file but prune every export this plan's H1-H5 steps make
      unused. Do not leave the file as-is "because it's domain code" — most of it is
      assessment-only and this plan already deletes the assessment feature.
    - `packages/domain/src/review-pre-check.ts` (and its test and its export in
      `packages/domain/src/index.ts`) — the scheduled-review pre-check this plan's H4
      deletes from the worker (`review-scheduler.ts`, `assessment-review-runner.ts`)
      depends on it; confirm it has no other caller before deleting, since the
      traderton counterpart plan (S7) re-implements this logic independently rather
      than importing herobids'.
    - `packages/domain/src/ports/assessment-identity-resolver.ts`, `assessment-request.ts`
      and `preset-transition.ts` — not enumerated anywhere in H5's file list
      despite being assessment-specific ports with no other named consumer.
  - **Also found and not in H5's delete list, but still wired at runtime as of this
    investigation:** `apps/worker/src/market-intelligence/monitor.ts` and
    `coordinator.ts` are instantiated in `apps/worker/src/index.ts:1066`
    (`createMarketMonitor`) and are the producer of herobids' own watch-threshold,
    discovery-delta, and regime-change wakes (see
    `domain-trading-trading-protocol` in the investigation findings) — a capability
    distinct from the LLM-driven preset assessment this plan retires. **Do not delete
    these as part of H5** unless a separate decision is made to also retire herobids'
    own wake-producing market monitor (out of scope for this plan). Keep them wired,
    and keep `RegimeResult`/`VolatilityEvidence` available to them per the resolution
    above.
- Drop these tables (greenfield; verify empty first):
  - `market_assessment_requests` / `_runs` / `_artifacts`
  - `agent_preset_bindings`, `agent_preset_transitions`
  - `agent_assessment_review_checks` / `_runs`, `review_advice`
  - `agent_scan_candidates` / `agent_scan_metrics` (now Traderton-owned per E1)
  - This is a destructive migration: get explicit human confirmation at implementation
    time.
- Config: remove the `platformAssessor` block and the `assessment.request` rate-card item
  (`config/default.yaml` ~L668–750, ~L1018) + schema entries. Update `.env.example` if any
  env override referenced them.
- `agent-evaluation/` preset-assessment collectors/appendix: re-point to Traderton
  `list_agent_strategy_changes`, or remove (the implementing agent decides from current
  report usage).
- Preset catalog consumers (`agents/strategy-preset-resolver.ts`, `routes/blueprints.ts`,
  pickers): read from Traderton `list_strategy_presets`. Herobids' copy of
  `config/strategy-presets` and the presets-loader is removed only when no consumer is left.

### H6. Docs
- `CHANGELOG.md`: entries for the tool move, the free assessment, the review screen
  change, and the removed billing meter.
- `docs/features/2026/10/03/004-phase4-skill-replacement-program/CLOSEOUT.md` "Tools not
  moved": mark both tools as moved, with a link.
- Optional pointer in `docs/features/2026/10/03/001-phase3-completion-note.md` "Next".

## Verification
- `pnpm build && pnpm lint`
- `pnpm exec tsc --noEmit -p apps/worker/tsconfig.json` (root lint does not check the
  worker)
- `pnpm test`
- `scripts/shell/tests/run-all-tests.sh --e2e`
- The cross-stack check in the Traderton plan.

## Risks
- **Release coupling:** remove H1 in the same release Traderton starts listing the tools.
  Otherwise names collide or the tools disappear.
- **Destructive drops (H5):** confirm the tables are empty and get an explicit go.
- **User-visible change:** users stop being charged, and the review screen shows the
  agent's reasoning instead of platform pros/cons. Mention both in release notes.
