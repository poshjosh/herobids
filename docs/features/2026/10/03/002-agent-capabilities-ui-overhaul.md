# Agent Capabilities UI Overhaul — Inline Setup, Family-Generic Display, and Readiness Simplification

**Date:** 2026-10-03
**Area:** `apps/web` — `AgentDetailPage` capabilities section, `AgentCapabilityPage`, `agent-display.ts`, i18n locales
**Type:** Frontend UX overhaul (no backend changes)

## Implementation Status

- [DONE] **Item 0 — i18n keys**: add/remove keys across `en.ts`, `ar.ts`, `hi.ts`.
- [DONE] **Item A1 — Family-generic display** (`agent-display.ts`): add `email` label.
- [DONE] **Item A2 — Extract shared connection-setup unit** (`AgentConnectionField.tsx`) + refactor `EditAgentModal`.
- [PENDING] **Item A3 — Rework capabilities section** in `AgentDetailPage.tsx` (empty state + inline setup).
- [PENDING] **Item B1 — Readiness view-model helper** (`capability-readiness-view.ts`) implementing the B2 mapping.
- [PENDING] **Item B3 — Rework** `AgentCapabilityPage.tsx` (single Status card + Details toggle).
- [PENDING] **Item Tests — Unit + E2E/i18n/UAT updates** (consolidated test edits).

## Why one plan

This combines two closely-coupled frontend changes that touch the same shared
files (`agent-display.ts`, the three i18n catalogs) and the same E2E/UAT surface
(the capability journeys and the no-capability empty state). Keeping them in one
plan removes cross-plan coordination risk and lets the E2E/UAT edits be placed
once, correctly. The plan has two parts:

- **Part A — Agent detail capabilities section:** fix the dead-end "No capability
  setup required" empty state and embed inline skills + connection setup;
  make the capability display family-generic; add the `email` family label.
- **Part B — Per-family capability page (`AgentCapabilityPage`):** replace the
  three technical cards (Readiness / Why this state / Next steps) with a single
  plain-language Status card; keep Available connections. 

Parts A and B share: the `email` label in `agent-display.ts`, the i18n catalog
edits, and the capability-related E2E/UAT updates (consolidated in the Tests
section).

## Problem

### Part A — the detail capabilities section

Create an agent with no skill and no connection, open the agent detail page, and
expand Capabilities. It shows **"No capability setup required"** — a dead end:

1. **Wrong framing.** Setup is not "not required"; the agent has no capabilities
   *yet*, and there's no way to add one from here.
2. **No inline setup.** Adding a skill or binding a connection forces the user to
   leave the section (open the Edit modal), even though the create/edit form
   already has the exact controls.

The display is also trading-skewed: `agent-display.ts` defines a label only for
`trading` (`CAPABILITY_FAMILY_LABELS = { trading: 'Trading' }`), and the only
family label key in i18n is `agents.capabilityFamily.trading`. An `email`-family
agent renders the raw string `email`.

### Part B — the per-family capability page

`/agents/:agentId/capabilities/:family` shows four cards. Three of them
(**Readiness** KV table, **Why this state** raw reasons, **Next steps** static
button) expose the backend's internal two-axis readiness model
(`connectionReadiness` + `agentEligibility` → `effectiveReady`) plus a raw UUID
and a state-insensitive button. A user wants one answer: **can my agent use this
capability now, and if not, what do I do?**

## Goal

### Part A

In `AgentDetailPage.tsx` capabilities section:

1. Replace "No capability setup required" with "No capabilities yet" + a short
   explainer, and embed inline setup (skills + connections) so the user never
   leaves the page.
2. Reuse the create/edit form's **`SkillPicker`** and the **connection
   picker + "Add connection" button** unit (not `ProviderSetupForm` directly;
   `ProviderSetupForm` stays reachable via the Add-connection button).
3. Make the display **family-generic** (no `if (family === 'trading')` branching)
   so `trading`, `email`, and future `messaging/*` / `automation/*` families all
   render a proper label + card.
4. Add the missing `email` family label.
5. Show the inline setup controls in **both** the empty and non-empty states
   (product decision), so an agent that already has capabilities can still add
   more in place.

### Part B

Replace the three technical cards with one **Status** card that leads with the
answer (ready / not ready), shows a human reason + a single clear action when not
ready, and hides the technical diagnostics behind a `<details>` toggle. Keep the
**Available connections** card as-is.

No backend changes in either part. The readiness endpoint
(`apps/api/src/routes/capabilities/index.ts`) is already family-generic (unions
skill-declared families with connection-provider-derived families), and
`deriveReadiness` (`packages/db/src/agent-runtime-descriptor.ts`) already emits
everything Part B's Status card needs.

## Scope boundaries (deliberately deferred)

Confirmed with the product owner — out of scope, do not start:

- **No `email → messaging/email` rename.** Current top-level family is `email`
  (`RuntimeBindingFamily = 'trading' | 'email'`,
  `packages/domain/src/provider-catalog.ts`). The harmonized taxonomy promotes
  `messaging` to a capability with `email`/`chat`/`inbox` families, but that
  rename is sequenced **last** — see
  [007-capability-naming-cleanup.md](../../pending/000-capability-foundations/007-capability-naming-cleanup.md)
  ("This phase is intentionally last … a later wire rename … should be planned
  separately"). Keep `email`; only add its user-facing label.
- **No "built-in messaging capability" display tier.** Every agent carries
  `send_message` via the auto-injected `base` skill, but `base` declares
  `capabilityFamilies: []` (`packages/domain/src/skills.ts`), so messaging is not
  a capability family today. Surfacing "Messaging — built-in" everywhere is
  deferred to the harmonized model where `messaging` becomes a native capability —
  see
  [013-native-capabilities-and-external-backends.md](../../pending/000-capability-foundations/013-native-capabilities-and-external-backends.md)
  (fixed decision 5) and
  [012-shared-capability-taxonomy-revision.md](../../pending/000-capability-foundations/012-shared-capability-taxonomy-revision.md)
  (target `capability → family → provider`). Under this plan a base-skill-only
  agent still shows "No capabilities yet" until that model lands.

Building display generically (Part A, goal 3) is the forward-compatible step:
when `messaging` is promoted, the UI already renders whatever families it's given.

## Why reuse the create/edit controls (not `ProviderSetupForm`)

- `ProviderSetupForm` is a *create-a-new-connection* flow (provider pick, secret
  entry, wallet generation). The common need here is "add a skill" and "bind an
  existing connection" — exactly what the create/edit form does.
- Reusing those controls keeps one mental model: edit what you set at creation,
  in place.
- `ProviderSetupForm` stays reachable as the **"Add connection"** affordance that
  sits *below* the picker (same unit the Edit modal uses) — it is not removed,
  just demoted to its correct role.

## Orientation — key files

Read before implementing.

**Shared (both parts):**
- `apps/web/src/features/agents/agent-display.ts` — `CAPABILITY_FAMILY_LABELS`
  (only `trading`), `formatCapabilityFamily` (de-kebab fallback for unknown
  families — already generic), `formatCapabilityState`, `resolveCapabilityFamilies`.
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts` — three catalogs; parity enforced
  by `catalog-consistency.test.ts` and `i18n-regressions.test.ts`.

**Part A:**
- `apps/web/src/features/agents/AgentDetailPage.tsx` — the capabilities `<section>`
  (summary `agents.detail.capabilities`). Empty state renders
  `agents.summary.noCapabilitySetup`; readiness cards render from
  `familyCapabilities`; `capabilityFamilies`/`hasAnyCapability` derive from
  `resolveCapabilityFamilies(selectedSkills)`.
- `apps/web/src/features/agents/SkillPicker.tsx` — reusable skills multiselect.
  Props: `initialSkills`, `selectedSkillIds`, `onChange(skillIds)`, `loading`,
  `errorMessage`.
- `apps/web/src/features/agents/EditAgentModal.tsx` — reference for the connection
  unit: the `allPickerConnections` memo (merges trading + generic/Gmail, deduped),
  the `<select>` with "trading"/"other" optgroups, the selected-connection chips
  with remove, **and the "Add connection" button that opens `ProviderSetupForm`**
  (present in both the empty-list and populated branches; see lines ~705–825).
  Binding = `agentsApi.update(agentId, { connectionIds })`.
- `apps/web/src/features/setup/ProviderSetupForm.tsx` — the add-new-connection form
  the Add-connection button opens.
- `apps/web/src/lib/api-client.js` — `agentsApi.update`, `agentsApi.getConnections`,
  `capabilitiesApi.tradingConnections`, `skillsApi.list`.

**Part B:**
- `apps/web/src/features/agents/AgentCapabilityPage.tsx` — the page being
  reworked; the four cards live in a CSS-grid `<div>`; the trading-only Available
  connections card + `showAddConnection`/`ProviderSetupForm` wiring stay.
- `apps/web/src/features/agents/AgentCapabilityPage.test.tsx`.
- `packages/db/src/agent-runtime-descriptor.ts` — `deriveReadiness`; the five
  branches below come from here. Reason strings must be copied verbatim.
- `packages/domain/src/platform.ts` — `CapabilityReadiness` + `ReadinessState`.
- `apps/web/src/lib/ui.tsx` — shared primitives in play: `Card`, `KV`, `Button`,
  `StatusBadge`, `PageShell`. `Card`/`Button` do **not** forward refs; `Card` does
  accept a `className`. See the scroll note in Part B.

**Supporting (both parts):**
- `packages/domain/src/provider-catalog.ts` — `getRuntimeFamiliesForProvider`
  (`gmail → email`), `RuntimeBindingFamily`.
- `packages/domain/src/skills.ts` — `BASE_SKILL` (`capabilityFamilies: []`),
  `EMAIL_SKILL` (`['email']`), `SKILL_PRESET_MAP`.

## Implementation

### 0. i18n keys (add to all three locales: `en.ts`, `ar.ts`, `hi.ts`)

Parity is test-enforced across exactly three catalogs — add/remove in all three.
Mirror English into `ar`/`hi` following the existing untranslated-entry
convention.

**Part A — new:**
- `agents.capabilityFamily.email` = "Email"
- `agents.detail.capabilities.emptyTitle` = "No capabilities yet"
- `agents.detail.capabilities.emptyBody` = "Give this agent a capability by adding a skill (like Trading or Email) or connecting an account."
- `agents.detail.capabilities.addSkills` = "Add skills"
- `agents.detail.capabilities.connections` = "Connections"
- `agents.detail.capabilities.saving` = "Saving…"
- `agents.detail.capabilities.saveError` = "Couldn't update capabilities: {error}"

Reuse: `agents.create.skills`, `agents.create.connections`,
`agents.create.chooseConnection`, `agents.create.connections.trading`,
`agents.create.connections.other`, `agents.create.loadingConnections`,
`agents.create.noConnections`, `agents.create.addConnection`,
`agents.summary.none`.

**Keep** `agents.summary.noCapabilitySetup` — `formatCapabilitySummary` in
`agent-display.ts` still references it (product decision: leave the summary
fallback alone). Do not remove it.

**Part B — new (plain-language Status copy):**
- `agents.capabilityPage.status.readyHeadline` = "Ready to trade"
- `agents.capabilityPage.status.noConnectionHeadline` = "Not ready — no trading connection yet"
- `agents.capabilityPage.status.noConnectionReason` = "This agent needs a trading connection before it can trade."
- `agents.capabilityPage.status.setupIncompleteHeadline` = "Not ready — trading setup incomplete"
- `agents.capabilityPage.status.setupIncompleteReason` = "The connection is linked but its trading account isn't set up yet."
- `agents.capabilityPage.status.revokedHeadline` = "Not ready — connection revoked"
- `agents.capabilityPage.status.revokedReason` = "The connection this agent used was revoked and can no longer trade."
- `agents.capabilityPage.status.accessRemovedHeadline` = "Not ready — access was removed"
- `agents.capabilityPage.status.accessRemovedReason` = "This agent's access to the connection was removed."
- `agents.capabilityPage.status.genericNotReadyHeadline` = "Not ready"
- `agents.capabilityPage.status.genericNotReadyReason` = "This capability isn't ready yet."
- `agents.capabilityPage.status.action.assignConnection` = "Assign a connection"
- `agents.capabilityPage.status.action.finishSetup` = "Finish trading setup"
- `agents.capabilityPage.status.action.assignHelper` = "Pick a connection below to let this agent trade."
- `agents.capabilityPage.status.detailsToggle` = "Details"

**Part B — remove (verify no other references first; remove from all three):**
`agents.capabilityPage.whyThisState`, `agents.capabilityPage.readyForUse`,
`agents.capabilityPage.nextSteps`, `agents.capabilityPage.noGuidedSetup`,
`agents.capabilityPage.setupOnAgents`. Keep `agents.capabilityPage.manageConnections`
only if the non-trading fallback still uses it; otherwise remove.

Reuse for the demoted Details fields: `agents.detail.connectionReadiness`,
`agents.detail.agentEligibility`, `agents.detail.effectiveReady`,
`common.connection`, `common.state`, `common.yes`, `common.no`,
`agents.detail.notAssigned`, `agents.eligibility.*`.

### Part A

#### A1. Family-generic display (`agent-display.ts`)

- Add `email: 'Email'` to `CAPABILITY_FAMILY_LABELS`.
- Confirm `formatCapabilityFamily` resolves `email` via the new key and still
  de-kebabs unknown families. No per-family branching added.

#### A2. Extract a shared connection-setup unit

Decision (left to implementer per product owner): extract the connection unit
from `EditAgentModal` into a reusable component — **recommended** given it will
now live in two places. Suggested: `apps/web/src/features/agents/AgentConnectionField.tsx`,
encapsulating:
- the `allPickerConnections` merge (trading + generic/Gmail, deduped),
- the `<select>` with trading/other optgroups + the empty-list message,
- the selected-connection chips with remove,
- the **"Add connection" button** that opens `ProviderSetupForm`, including the
  on-success wiring that appends the new connection id and invalidates the
  connection queries.

Props: current `connectionIds`, `onChange(connectionIds)`, and the query data /
`venueTypeMap` it needs (or let it own its own queries). Refactor `EditAgentModal`
to consume it so there is a single source of truth. If clean extraction proves
risky mid-implementation, fall back to a local replica in the detail section with
a `// TODO: dedupe with EditAgentModal` note — but prefer extraction (the
Add-connection button + ProviderSetupForm wiring is non-trivial to duplicate
correctly).

#### A3. Rework the capabilities section in `AgentDetailPage.tsx`

- **Empty state (`!hasAnyCapability`)**: render `emptyTitle` + `emptyBody` instead
  of `noCapabilitySetup`, then the inline setup block.
- **Inline setup block (rendered in BOTH empty and non-empty states):**
  - **Skills**: `SkillPicker` with `initialSkills={listSelectableSkills(skillsQuery.data?.skills ?? [])}`,
    `selectedSkillIds={agent.skillIds}`. On `onChange(skillIds)` →
    `agentsApi.update(agent.id, { skillIds })` mutation; on success invalidate
    `['agents', id]`, `['agents', id, 'capability-readiness']`, `['skills']`.
  - **Connections**: the `AgentConnectionField` from A2 (picker + chips +
    Add-connection button). On change →
    `agentsApi.update(agent.id, { connectionIds })`; invalidate the agent,
    capability-readiness, and connection queries.
  - Transient `saveError` + `saving` indicator.
- **Existing per-family readiness cards**: unchanged. They still link to
  `/agents/:id/capabilities/:family` (the Part B page).
- Keep everything inside the existing collapsible `<details>`.

### Part B — rework `AgentCapabilityPage.tsx`

#### B1. New pure view-model helper

New file `apps/web/src/features/agents/capability-readiness-view.ts`:

```ts
export type ReadinessAction =
  | { kind: 'assignConnection' }   // focus Available connections card
  | { kind: 'finishSetup' };       // open ProviderSetupForm

export interface ReadinessView {
  tone: 'ready' | 'warn' | 'blocked';
  headlineId: string;
  reasonId?: string;
  rawReason?: string;              // fallback: backend reason, verbatim
  action?: { labelId: string; helperId?: string; variant: 'primary' | 'secondary'; action: ReadinessAction };
}

export function toReadinessView(readiness: CapabilityReadiness): ReadinessView { /* table below */ }
```

Pure, unit-testable, no React/intl (returns keys). Reason-string constants live
here as named consts so the brittle match is isolated and documented.

#### B2. Backend branches → UI (from `deriveReadiness(row, 'trading')`)

| # | Backend output | Headline (icon) | Reason | Action |
|---|---|---|---|---|
| 1 | `ready`, `effectiveReady: true`, `reasons: []` | ✅ "Ready to trade" | none | none |
| 2 | `unconfigured`, reason `"no connections have been assigned for this capability family"` | ⚠️ "Not ready — no trading connection yet" | "This agent needs a trading connection before it can trade." | Primary → scroll to Available connections |
| 3 | `unconfigured`, reason `"connection has no resolved venue account — complete trading setup first"` | ⚠️ "Not ready — trading setup incomplete" | "The connection is linked but its trading account isn't set up yet." | Primary → "Finish setup" opens `ProviderSetupForm` (reuse the existing `showAddConnection` / "+ Add connection" wiring; do not build a new flow) |
| 4 | `revoked`, reason `"connection has been revoked"` | ⛔ "Not ready — connection revoked" | "The connection this agent used was revoked and can no longer trade." | Primary → scroll to Available connections |
| 5 | `revoked`, reason `"connection assignment has been revoked"` | ⛔ "Not ready — access was removed" | "This agent's access to the connection was removed." | Primary → scroll to Available connections |
| fallback | any other `state` (`provisioning`/`degraded`) or unknown reason | ⚠️ "Not ready" | raw backend `reason`, or neutral "This capability isn't ready yet." if empty | Secondary → scroll to Available connections |

Matching: headline/icon by `state` + `effectiveReady`; sub-copy by `reason`
string. Unknown reason → render raw backend reason verbatim.

#### B3. Rework the page

- Remove the three cards: **Readiness** (KV table), **Why this state**, **Next
  steps**.
- Add one **Status** card at the top rendering `toReadinessView(readiness)`:
  icon + tone-coloured headline; one reason line; optional action button
  (`assignConnection` → scroll + transient highlight on the Available-connections
  wrapper; `finishSetup` → `setShowAddConnection(true)`); a `<details>` labelled
  **Details** containing the old technical fields (`connectionReadiness`,
  `agentEligibility`, `effectiveReady`, `connectionId`) via `KV`.
- Keep the **Available connections** card unchanged otherwise.
- Delete `getCapabilityNextSteps` and its usages.
- Non-trading families fall through to the generic fallback row (headline + raw
  reason + a secondary "Manage connections" link to `/connections`).

**Scroll mechanism (primitives don't forward refs):** wrap the Available
connections `Card` in a `<section id="available-connections">` (or pass a
`className`); the `assignConnection` handler does
`document.getElementById('available-connections')?.scrollIntoView({ behavior: 'smooth', block: 'start' })`
and toggles a transient highlight via local `useState` + timeout (~1.5s). Do not
modify `ui.tsx`.

## Tests

### Part A
- **`agent-display.test.ts`**: `formatCapabilityFamily('email', intl)` → "Email";
  unknown family still de-kebabs.
- **`AgentDetailPage.test.tsx`**: no-skills agent shows "No capabilities yet"
  (old "No capability setup required" gone) + `SkillPicker` + connection field
  present; email-skill agent shows an "Email" family card; mocked `agentsApi.update`
  is called with expected `skillIds` / `connectionIds` on interaction.
- **`AgentConnectionField`** (if extracted): a focused render/interaction test
  (picker lists options, chip remove updates selection, Add-connection opens the
  form).

### Part B
- **New `capability-readiness-view.test.ts`**: `toReadinessView` returns the right
  tone/headlineId/reason/action for all five branches + the
  provisioning/degraded/unknown fallbacks. Behaviour-named tests.
- **Update `AgentCapabilityPage.test.tsx`**: keep the assertion that the trading
  presentation is not mounted for an unready capability; add that the new Status
  headline renders and the three old card titles are gone / demoted into
  `<details>`.

### Shared E2E / i18n / UAT (consolidated here)
- **`i18n-regressions.test.ts`**:
  - The case banning `'No capability setup required'` in `AgentSummaryCard.tsx`
    stays (that file is unchanged) — leave it.
  - **Delete** the case `"AgentCapabilityPage trading next steps no longer route to
    /connections"` — it parses the body of `getCapabilityNextSteps`, which this
    plan deletes; its premise no longer exists. Do not relax it.
  - Confirm catalog-parity / "all en keys present in every locale" still pass
    after the key add/removes.
- **`tests/e2e/journeys/01-signup-create-agent.spec.ts`**: currently asserts
  `getByText(/No capability setup required/i)` after creating a no-skills agent.
  **Update** to assert `/No capabilities yet/i` and (optional) that "Add skills"
  is visible.
- **`tests/e2e/journeys/07-agents-page-renders.spec.ts`** and
  **`08-agents-capability-reflects.spec.ts`**: both locate the readiness card via
  `getByRole('region', { name: /Capability readiness/i })`. On the capability
  page this matched the Readiness card's `<section aria-label={... 'agents.summary.capabilityReadiness'}>`.
  **Keep the new Status card wrapped in a `<section>` reusing the same
  `agents.summary.capabilityReadiness` aria-label** so the region selector still
  resolves. The specs then assert KV rows (`State: Ready`, etc.) now inside
  `<details>` — update to (1) assert the new Status headline, and (2) expand the
  `<details>` before asserting the technical KV rows (preferred in `08`, the ready
  path), or headline-only in `07` (unconfigured path). Keep the `KV` DOM shape
  (label text node + `following-sibling::span`) if row assertions are retained.
  Note: the *agent detail* page uses the parameterised key
  `agents.summary.capabilityReadinessAria` — journey 08's navigation relies on it;
  don't change that key.
- **`docs/tech/user-acceptance-tests.md`**:
  - **GC-08** ("No-skills agent shows 'No capability setup required'") — rewrite to
    the new "No capabilities yet" empty state + inline Add-skills/connection
    controls.
  - **AG-14** ("Capability section") — update Notes: plain-language Status headline
    + reason + action, technical fields behind **Details**.
  - **AG-22** ("Capability page — trading next steps") — rewrite to the new
    state-aware action (assign-connection scroll / finish-setup) or retire it.

## Verification

- `pnpm lint` (tsc --noEmit) must pass; `noUnusedLocals`/`noUnusedParameters` are
  on — remove now-unused imports. Likely state in `AgentCapabilityPage` after the
  rework: `KV` and `StatusBadge` are **still used** (KV inside `<details>`,
  StatusBadge for `agent.status`) — do not delete them; `formatCapabilityState`
  may become unused if Details renders raw values — remove if so; `useNavigate`
  may become unused once `getCapabilityNextSteps`/next-steps navigation is deleted
  (the Available-connections flow doesn't navigate) — check and remove if unused.
- `pnpm test` for `apps/web` unit + i18n.
- Run E2E journeys `01`, `07`, `08`.
- Manual Part A: no-skills agent → "No capabilities yet" + working Add-skills and
  connection field; add Email skill → Email card appears; bind/unbind updates
  readiness; trading agent still shows a Trading card linking to the per-family
  page.
- Manual Part B: trading capability page for (a) ready, (b) no connection,
  (c) connection without venue account, (d) revoked — confirm headline, reason,
  action, and that Details reveals the old fields.

## Out of scope

- Any `deriveReadiness` / backend readiness contract change; no new readiness
  states (`provisioning`/`degraded` handled only via generic fallback).
- Any change to the **Available connections** card behaviour on the per-family
  page (Part B keeps it exactly as-is).
- Renaming `email` → `messaging/email` (deferred to naming-cleanup phase).
- A "built-in messaging" display tier (deferred to the harmonized model).
- Changing `agents.summary.noCapabilitySetup` / `formatCapabilitySummary`
  (product decision: leave as-is).

## Risk / rollback

- Pure frontend, mostly additive/presentational. Rollback = revert
  `AgentDetailPage.tsx`, `AgentCapabilityPage.tsx`, the new
  `capability-readiness-view.ts` and (if created) `AgentConnectionField.tsx`,
  `agent-display.ts`, i18n, and test edits.
- Brittleness points: (1) matching backend reason strings — isolated to
  `capability-readiness-view.ts` with a verbatim fallback; (2) extracting the
  connection unit from `EditAgentModal` — a local replica is the fallback.

## References (where the design was learned)

- Target taxonomy `capability → family → provider`, `messaging → email`:
  [012-shared-capability-taxonomy-revision.md](../../pending/000-capability-foundations/012-shared-capability-taxonomy-revision.md).
  Content was rephrased for compliance with licensing restrictions.
- Messaging stays native; trading becomes an external backend (the "not a trading
  platform" legal driver):
  [013-native-capabilities-and-external-backends.md](../../pending/000-capability-foundations/013-native-capabilities-and-external-backends.md)
  and [001-roadmap.md](../../pending/000-capability-foundations/001-roadmap.md)
  (Gate 4 — native capability cleanup; messaging remains native).
- Naming cleanup sequenced last; no premature wire renames:
  [007-capability-naming-cleanup.md](../../pending/000-capability-foundations/007-capability-naming-cleanup.md).

## Outstanding Issues

Non-critical observations recorded during implementation code review (no CRITICAL/HIGH issues remain for completed items).

### Item 0 — i18n keys
- [MEDIUM] The five removed Part B keys (`whyThisState`, `readyForUse`, `nextSteps`, `noGuidedSetup`, `setupOnAgents`) are still read by `AgentCapabilityPage.tsx` via `intl.formatMessage` until Item B3 lands. Between Item 0 and B3 the capability page renders missing-key fallbacks. Expected per plan sequencing — resolved by Item B3. Item 0 should not ship independently of B3.

### Item A1 — Family-generic display
- [LOW] No direct unit test yet for `formatCapabilityFamily('email', intl)` → "Email" nor for the unknown-family de-kebab path. Covered under Item Tests (consolidated).

### Item A2 — AgentConnectionField extraction
- [LOW] `<select>` add-handler uses prop-captured `connectionIds` + `onChange` instead of the original functional `setForm` updater. Behaviorally equivalent for discrete clicks (standard controlled pattern); no drift.
- [LOW] `PickerConnection.profile` is carried in the merged shape but never read by the component (matches the original inline behavior). Harmless; kept for parity/A3 reuse.
- [LOW] `EditAgentModal` and `AgentConnectionField` independently recompute the `allPickerConnections` merge from the same (React-Query-deduped) data. Intentional — EditAgentModal still needs it for its auto-select/init effects. Potential future consolidation.
- [LOW] Visual verification of EditAgentModal picker + A3 detail-page reuse deferred to end-of-plan Verification (Part A manual testing).
