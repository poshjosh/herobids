# Plan: Remove trading-centric wording from herobids public-facing surfaces

Status: done — all three phases implemented, reviewed, committed, and verified: `pnpm lint` and `pnpm build` both pass clean; `scripts/shell/tests/run-all-tests.sh --e2e` passes (unit, integration, functional, API smoke, 17/17 non-skipped E2E journeys); `scripts/shell/tests/run-extra-tests.sh --all` passes (all executed tiers, 2 pre-existing documented skips unrelated to this change); manual browser UAT pass recorded as section 18 of `docs/tech/user-acceptance-tests.md` (7/9 fully pass, 2 blocked/pending for reasons unrelated to code correctness — see Outstanding Issues).
Owner: (unassigned)
Source audit: `docs/product/trading-wording-audit.md`

## Dependency

The audit's legal section (rows #47–#60) requires that traderton publish its
own Privacy Policy / User Agreement carrying the trading-specific clauses
(data categories, venue disclosures, trading-risk/liability, test/live order
definitions) *before* those clauses are removed from herobids' legal pages.
Do not start Phase 3 (legal pages) of this plan until the traderton plan's
exit criteria are met and its clause-mapping record confirms 1:1 coverage of
rows #47–#60. Phases 1 and 2 (docs/UI reword) have no such dependency and can
proceed immediately.

## Scope

Everything in `docs/product/trading-wording-audit.md` sections A (content
pages), B (app UI i18n strings), and C (SEO/metadata), split into three
phases by risk and dependency.

## Phase 1 — Reword content pages (no legal dependency)

Files: `apps/web/src/features/public-pages/content/en/**/*.md` (+ mirrored
`ar/` and `hi/` where the same string exists — confirmed present in
`ar/help/faqs.md`, `ar/help/get-started.md`, `ar/company/about-us.md`,
`hi/help/faqs.md`, `hi/help/get-started.md`, `hi/company/about-us.md`).

1. [DONE] `company/about-us.md` — reword row #2 ("trading bots" → generic); fix
   "assistantance" typo (row #1 note).
2. [DONE] `docs/agents/agent-style.md` — reword rows #3–#7 (trading hours → active
   hours, "permitted to trade" → "permitted to act", weekend-pause wording,
   "Balanced" preset description).
3. [DONE] `docs/agents/billing-limits.md` — reword rows #8–#10.
4. [DONE] `docs/agents/how-agent-costs-are-kept-low.md` — reword row #11; remove
   row #12 (the two trading-only example lines).
5. [DONE] `docs/agents/index.md` — reword row #13 (index blurb); **remove** the
   Agent Presets table (#14–#17); reword "Trade Authorization" heading and
   body to "Authorization" (#18–#21); reword/replace row #22 (presets-gone
   default statement).

   > Note: the heading slug change (`#trade-authorization` → `#authorization`)
   > required updating the cross-reference link in `help/faqs.md` (all three
   > locales) and regenerating the auto-generated
   > `apps/worker/src/tools/platform-docs-data.ts` (`pnpm --filter
   > @herobids/scripts run build-docs-index`) to kill a stale anchor —
   > caught by code review, fixed before commit.
   >
   > Correction to the audit's own stated rationale, flagged by final code
   > review: the audit justified this removal with "presets are no longer
   > used" — that's imprecise. `skillPresetId` (`trading`, `direct-trading`,
   > `trading-assistant`, `personal-assistant`, `custom`) is still a live
   > backend/API field (`apps/api/src/routes/agents.ts`,
   > `apps/api/src/routes/chat.ts`) driving the guided-setup chat flow today.
   > What's actually true, and what makes this removal defensible anyway: the
   > *UI* no longer shows preset names to users — `GuidedSetupPanel.tsx` is a
   > pure conversational flow with no preset-picker buttons, and `chat.ts`
   > itself says "Do not expose internal preset names to the user." The
   > preset system became an internal implementation detail, not a
   > user-facing concept, which is why the public docs page describing named
   > presets (Direct Trading, Trading Assistant, etc.) is correctly stale —
   > but it's stale because presets became invisible, not because they
   > stopped existing. This drift (`skillPresetId`/`SKILL_PRESET_MAP`
   > demotion) is independently tracked as deliberately deferred, pre-existing
   > backend cleanup in `docs/features/2026/10/01/006-phase2-completion-note.md`
   > line 66 — out of scope for this plan to resolve, but recorded here so a
   > future reader doesn't take the audit's "no longer used" at face value.
6. [DONE] `docs/agents/what-are-ai-agents.md` — replace rows #23–#25 with the new
   capability list from the audit (web-browser capability bullets +
   Gmail/Telegram), fixing "Connecto" typo.
7. [DONE] `docs/messaging/index.md` — reword row #26.
8. [DONE] `docs/messaging/telegram/slash-commands.md` — reword rows #27–#31
   ("Trade Approvals" → "Approvals", `/yes`/`/no` descriptions, "Trade
   Approval Workflow" heading, authorization-mode sentence).
9. [DONE] `docs/reference/glossary.md` — **keep** (#32), no change confirmed.
10. [DONE] `help/faqs.md` — reword rows #33–#36, #38–#40; **keep** row #37 (literal
    `/to "DCA Bot" pause trading` command example) and row #41 (per-trade
    stop-loss/take-profit — genuinely trading-specific risk mechanics).
11. [DONE] `help/get-started.md` — reword rows #42–#43; **remove** rows #44–#46
    (Agent Presets mirror).

    > Same correction as item 5 above applies here: removal is justified by
    > the preset system having become UI-invisible, not by presets having
    > stopped existing.
12. [DONE] Mirror every reworded/removed line into the matching `ar/` and `hi/`
    files found above. Rows that don't exist in `ar`/`hi` today (e.g. the
    full agents/docs tree) need no action there — only the pages that
    currently carry the term in those locales.
13. [DONE] `index.html` — reword row #97 (JSON-LD `about.description` drops the
    trading anchor).

    > Note: checked `apps/web/index.html` directly — it already contains no
    > "trading" wording in the JSON-LD or meta descriptions (predates this
    > plan; the audit's quoted text no longer matches the file). No change
    > was needed or made.

## Phase 2 — Reword UI i18n strings (no legal dependency)

File: `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`

1. [DONE] `connections.cascadeDeleteBlocked` (row #61) — "trading account" →
   "linked account" in `en.ts`; apply the equivalent wording change in
   `ar.ts` / `hi.ts` for the same key.
2. [DONE] Leave all Section-B capability-UI strings alone (rows #62–#96) — these
   are the trading capability surface itself (capability page, approvals
   panel, funding banner, connection setup) and the audit marks them Keep.
   Do **not** touch `agents.authorizationMode.*`, `agents.approvals.*`, or
   any string scoped to the trading capability family.

   > Confirmed: no other key touched; verified by diffing only the
   > `cascadeDeleteBlocked` line in each locale file.
3. [DONE] Regenerate the derived docs index: `pnpm --filter @herobids/scripts run
   build-docs-index` (rebuilds `apps/worker/src/tools/platform-docs-data.ts`
   from the Phase 1 content changes — this file is auto-generated, do not
   hand-edit it).

   > Verified first: `grep cascadeDeleteBlocked apps/worker/src/tools/platform-docs-data.ts`
   > returned no matches — this generated file sources from Phase 1's
   > markdown content, not i18n locale files, so the Phase 2 key change
   > doesn't affect it. No rebuild needed for this step; Phase 1 already
   > covered the rebuild for its own content changes.

## Phase 3 — Legal pages (gated on traderton plan)

Files: `apps/web/src/features/public-pages/content/en/legal/{privacy-policy,user-agreement}.md`

Before starting: confirm the traderton plan's clause-mapping record covers
every row below. If any row lacks a published traderton clause, stop and
flag it rather than deleting.

> Gate confirmed satisfied: traderton's
> `docs/features/pending/trading-legal-pages-and-wording-receiver/002-clause-mapping.md`
> confirms 1:1 (or better) coverage for every row #47–#60, including its own
> "Gap check" section specifically addressing the two grouping headings
> (#52 `Trading Agents`, #57 `Trading`) that don't have a verbatim structural
> match on the traderton side — see that section for the reasoning. herobids'
> Phase 3 relied on that reasoning being correct.

1. [DONE] `legal/privacy-policy.md`:
   - Row #47 — remove "Trading data" heading.
   - Row #48 — remove "Trading activity (orders, fills, positions, P&L)".
   - Row #49 — reword the Database bullet to "Account data, agent
     configurations" (drop "trading records").
   - Row #50 — remove the "Trading venues" bullet.
   - Row #51 — remove the "Trading records required for regulatory
     compliance..." clause from the deletion-rights bullet.
   - Add a line pointing to traderton's privacy policy for users who have
     linked a trading connection (the actual trading-data processor is
     traderton, not herobids — this is a genuine disclosure improvement,
     not just a deletion).

   > Note: the "Trading data" heading's two sibling bullets (Agent
   > configuration, Agent reasoning logs) were never actually trading data —
   > a pre-existing mislabel. Renamed that heading to "### Agent data" rather
   > than deleting the whole heading, since those two bullets still needed a
   > home. Pointer line added under "## Third-party services", linking to
   > `https://staging.traderton.com/legal/privacy-policy.html` (traderton has
   > no apex domain deployed — only staging is live; confirmed against
   > traderton's own Caddyfiles and `site-isolation.sh` asserted routes).
2. [DONE] `legal/user-agreement.md`:
   - Row #52 — remove "Trading Agents" heading.
   - Row #53 — remove "Trading decisions" heading.
   - Row #54 — remove the no-advice/liability sentence.
   - Row #55 — remove "Trading risk" heading.
   - Row #56 — remove the financial-risk disclaimer sentence.
   - Row #57 — remove the "Trading" section heading.
   - Row #58 — remove the Test execution-mode definition.
   - Row #59 — remove the Live execution-mode definition.
   - Row #60 — reword limitation-of-liability to "...including but not
     limited to data loss." (drop "trading losses").
   - Add a line pointing users with a trading connection to traderton's
     user agreement for the trading-specific terms.

   > Note — deliberate scope addition beyond this task's literal row list,
   > recorded per AGENTS.md: removing the parent "### Trading" heading (row
   > #57) necessarily removed its two un-numbered child clauses too —
   > "No investment advice" and "No guarantees" — since the audit's own text
   > describes row #57 as removing "the whole section". Both clauses have a
   > confirmed home in traderton's User Agreement (see traderton's
   > `002-clause-mapping.md`, which explicitly covers them as part of its
   > row #57 gap-check), so nothing is lost, but it goes beyond what rows
   > #52–60 individually enumerate. The pointer sentence (added under its own
   > "### Trading-specific terms" subheading, not just appended after
   > Platform limitations) explicitly names all six migrated concepts
   > (trading decisions, trading risk, no investment advice, no guarantees,
   > execution modes, liability for trading losses) so nothing migrated is
   > left undisclosed. Links to
   > `https://staging.traderton.com/legal/user-agreement.html` for the same
   > reason as above (no apex domain live). The generic "AI Agent behavior"
   > bullet in Platform limitations was kept — it's agent-behavior language,
   > not trading-specific, consistent with traderton's own gap-check note.
3. [DONE] No `ar`/`hi` legal mirrors exist today (confirmed: only `en/legal/*`
   present) — no translation work needed for this phase.
4. [DONE] Bumped `*Last updated*` to 2026-10-06 on both files. Regenerated
   `apps/worker/src/tools/platform-docs-data.ts` (sources from these
   markdown files) — confirmed no stale "Trading data"/"Trading Agents"/
   "Trading venues"/"trading records" text remains in the generated output.

## Explicitly out of scope

- Section B capability-UI strings (rows #62–#96) — Keep, per audit.
- Row #1, #32, #37, #41 — Keep, per audit.
- Any change to the trading capability backend, schema, or ports.

## Test impact and verification

This change touches public marketing/docs/legal content and one i18n key —
no business logic changes. Test updates are concentrated in the areas that
assert on exact copy, plus the full suite run to catch any missed string
dependency (e.g. the auto-generated docs index, or an E2E spec that happens
to assert render text).

### Unit tests
- `apps/web/src/lib/sitemap-urls.test.ts` — confirm it only asserts route
  paths, not copy; re-run after Phase 1 route/removal changes (the Agent
  Presets table removal doesn't remove a route, so this should be
  unaffected — verify, don't assume).
- Search for any unit test asserting literal strings being changed:
  `grep -rlE "Trade Authorization|Trading Hours|Agent Presets|trading bots"
  apps/web/src apps/worker/src --include=*.test.ts --include=*.test.tsx`
  and update any hit to the new wording.
- `apps/worker` docs-index build output is generated, not tested directly,
  but confirm `pnpm --filter @herobids/scripts run build-docs-index` runs
  clean after Phase 1/2 content edits (it's invoked by `pnpm build`, see
  below).

### Functional / shell-script tests
- None of `scripts/shell/tests/*.sh` assert on public-page or legal-page
  copy (confirmed by inspecting `run-all-tests.sh` / `run-extra-tests.sh`
  tier lists — they exercise agent lifecycle, billing, trading flows, not
  marketing content). No shell test changes expected; still run them to
  confirm no incidental breakage (e.g. a smoke test hitting `/docs/agents`
  and checking for 200, not copy).

### Playwright E2E
- No existing spec targets `/legal/*`, `/docs/*`, `/help/*`, or `/company/*`
  content directly (confirmed: no e2e spec file matched `legal|privacy|
  user-agreement|public-page`). No spec updates expected for Phase 1/3
  content wording.
- If any E2E journey asserts visible text that overlaps changed strings
  (e.g. a journey that opens the FAQ page or checks the agents docs page),
  it would show up as a failure in the `--e2e` run below — fix forward if
  so.
- Phase 2's `connections.cascadeDeleteBlocked` string: check whether any
  E2E journey triggers the cascade-delete-blocked error path and asserts
  its exact text; update if found.

### API / integration tests
- No integration test is expected to assert on this content (it's
  frontend-only + one i18n string). Run the integration tier regardless
  per the verification command list below.

### docs/tech/user-acceptance-tests.md
This file is manually maintained and must be updated for rows that touch
UI-visible behavior with an existing UAT entry. Cross-referencing the audit
against the UAT doc:
- No UAT row currently asserts the specific content-page copy being
  reworded in Phase 1 (UAT coverage is for app *behavior*, not marketing
  docs copy) — no UAT edits expected from Phase 1.
- Phase 2's i18n key is exercised by connection cascade-delete, which is
  not currently a dedicated UAT row either — if a browser pass surfaces this
  flow, add a UAT row documenting the new "linked account" wording.
- Phase 3 legal pages have no dedicated UAT rows today — none expected.
- If, during the browser verification pass below, any existing UAT row's
  "Expected" column quotes wording that was changed, update that row's
  Status/Notes to reflect the new copy and the date.

### Other tests
- i18n completeness: confirm no orphaned i18n keys are left behind after
  Phase 2 (the project has a prior "orphan i18n key sweep" pattern — see
  `docs/features/2026/10/02/003-orphan-i18n-key-sweep.md` — follow the same
  method if any key becomes unused, though this plan doesn't expect any
  since `cascadeDeleteBlocked` is reworded, not removed).

## Verification commands (run at the end, in order)

1. `pnpm lint`
2. `pnpm build` (also regenerates and validates the docs index)
3. `scripts/shell/tests/run-all-tests.sh --e2e`
4. `scripts/shell/tests/run-extra-tests.sh --all`
5. Open a controlled browser and manually re-run the `docs/tech/
   user-acceptance-tests.md` rows that touch changed surfaces:
   - Agents docs index page (`/docs/agents`) — confirm no Agent Presets
     table, confirm "Authorization" heading.
   - FAQs page (`/help/faqs`) — confirm "How do approvals work?" heading
     and reworded body.
   - Get Started page (`/help/get-started`) — confirm reworded onboarding
     copy, no preset list.
   - What are AI agents page (`/docs/agents/what-are-ai-agents`) — confirm
     new capability list.
   - Telegram slash commands page — confirm "Approvals" headings.
   - Connections page — trigger a cascade-delete-blocked error (agent/bot
     linked to a connection) and confirm "linked account" wording.
   - Privacy Policy / User Agreement pages (only after Phase 3) — confirm
     trading clauses are gone and the new pointer-to-traderton line renders
     and links correctly.
   - Any page in both `ar` and `hi` locales for the strings mirrored in
     Phase 1/2.
6. Record results (pass/fail, date, commit) in
   `docs/tech/user-acceptance-tests.md` per its existing convention, and
   note this plan's phase completion.

## Outstanding Issues

**[Phase 1 — audit premise correction]** Final code review caught that the
audit's stated rationale for removing the Agent Presets table ("presets are
no longer used") is factually imprecise — `skillPresetId` is still a live
backend/API field driving the guided-setup chat flow (see the item 5 and 11
notes above for the full explanation and the independent tracking reference).
The removal is still the right call because the preset system is no longer
*user-facing* — no UI shows preset names to a user today — but a future
reader should not take "no longer used" at face value if they go looking for
why this table was deleted.

**[Phase 3 — deploy timing, not a code defect]** Visual UAT found that
`https://staging.traderton.com/legal/privacy-policy.html` and
`/legal/user-agreement.html` currently 404 on the live staging site, even
though `/` and `/status.html` return 200 there. This is expected, not a
regression: traderton's legal-pages commits (`e7f102b`, `18cef4a`, `3a0629a`)
are on an unpushed local branch (`feat/e1h-e3h-agent-wake`), while staging
deploys from `main` via CI on push (confirmed: `origin/main` is at `v0.0.4`,
authored before these commits existed). The herobids pointer links are
correct and will resolve once traderton's branch is merged/pushed to `main`
and the CI site-image deploy runs. Until then, these two links will 404 in
any environment that hits the real `staging.traderton.com` instead of a
local traderton compose stack. Action needed: push/merge the traderton
legal-pages commits before relying on these links in a live demo or review;
re-verify both URLs return 200 once that deploy lands.

**[Phase 3]** From code review (HIGH, fixed before commit): the pointer
sentence in `user-agreement.md` originally omitted "no investment advice"
and "no guarantees" from its parenthetical list of migrated concepts, even
though removing the parent "### Trading" heading (row #57) necessarily took
those two clauses with it. Fixed by naming all six migrated concepts
explicitly and giving the pointer its own "### Trading-specific terms"
subheading instead of leaving it as a trailing sentence under "Platform
limitations". See the row #52/#57 notes above for the full reasoning this
relies on (traderton's own gap-check section).

**[Phase 2]** From code review (LOW): `en.ts`'s
`agents.capabilityPage.status.setupIncompleteReason` still reads "...its
trading account isn't set up yet." This is thematically identical to the
reworded `cascadeDeleteBlocked` key, but it belongs to the capability-page
family that the audit explicitly marks **Keep** (rows #62/#63 and
surrounding capability-UI strings — the trading capability surface itself).
Left unchanged intentionally; noted here only because a future pass might
otherwise mistake it for a missed instance of row #61.

**[Phase 1]** From code review: `apps/api/src/routes/telegram-slash-commands.ts`
hardcodes `'Trade Approvals'` (the `/help` category label) and
`'You have no pending trade approvals.'` / `'You have ${pendingCount} pending
trade approvals...'` — live bot output a user actually sees, inconsistent
with the now-reworded `docs/messaging/telegram/slash-commands.md` ("Approvals").
This file is app code, not content pages, so it's outside this plan's
declared scope (Phase 1 is content-pages-only) and the audit itself only
covers user-facing *page* text, not bot message strings. Logged here as a
follow-up candidate for a future pass — not fixed in this plan. Covered by
`telegram-slash-commands.test.ts`, which asserts the current (now
inconsistent) literal strings, so any future fix must update that test too.

## Exit criteria

- Phases 1 and 2 land, all verification commands pass, UAT doc updated.
- Phase 3 only starts once the traderton receiver plan is confirmed landed
  and its clause mapping checked row-by-row against #47–#60.
- No regression in any of the four test tiers or the manual UAT pass.
