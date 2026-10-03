# Block 3 — Step 12 Plan (T3.2 + T3.3): generic, trust-gated tool visibility

**Status:** plan (ready to implement). **Date:** 2026-10-DD.
**Repo:** herobids `~/dev_ai/herobids` · **Branch:** `phase3-external-backend` · **HEAD at planning:** `e57fbbee`.
**Program:** [ENTRYPOINT](../ENTRYPOINT.md) · [TASKS](../TASKS.md) · [DECISIONS](../DECISIONS.md) · [INVARIANTS](../INVARIANTS.md) · [SEAM](../SEAM.md)
**Normative contract:** [Step 10 plan](../../../../09/24/006-step10-external-backend-contract-and-trust-plan.md) — §1, §3, §4, §7 "Step 12".
**Builds on:** T3.1 (`747f6fdb`) — `packages/domain/src/external-backend/descriptor.ts`.

> This plan covers **T3.2** (replace the hard-coded trading branches with a
> generic descriptor-driven visibility path; drive I1 to 0) and **T3.3**
> (register the Traderton definition + a dev-signed **stub** descriptor so the
> generic path resolves locally). It is **planning only** — no code, no edits to
> TASKS/DECISIONS/PROGRESS. The DECISIONS rows this plan proposes (P3-47..P3-51)
> are recorded by the implementing task, not here.

---

## 0. Why T3.2 and T3.3 are ONE sequenced block

T3.1 landed the pure trust pipeline (`resolveDescriptorTools`) but **nothing
feeds it a descriptor**: `EXTERNAL_BACKEND_CONFIG_JSON` forwards a
`ResolvedExternalBackend` (`{ definition, hmacSecret }`) and carries NO descriptor
(confirmed: `apps/worker/src/external-backend/agent-ports.ts`). Trading tool
visibility today comes entirely from a hard-coded family inference, not from a
descriptor.

So T3.2 "replace the hard-coded branches with the generic path" **cannot stand
alone**: the moment the inference is removed, a trading agent's trading skills
produce `capabilityFamilies = []`, the generic path has no descriptor to resolve,
and every trading agent degrades to instruction-only — a parity break (I5 of
ENTRYPOINT §4: parity, not liveness). T3.3 is what supplies the descriptor (via a
stubbed descriptor-source port) so the generic path actually resolves tools.

**Therefore the exit criterion "trading tools resolve for an agent whose skills
include the D11 refs" is asserted ONLY after T3.3 lands.** The commit sequence
below is ordered so that **no committed commit leaves the tree broken-for-trading**:
the stub descriptor source is wired *in the same commit that removes the
hard-coded family inference* (Commit C3), never before.

Behaviour parity for trading agents is the explicit success bar: after T3.3, a
trading agent must see exactly the trading tools it sees today, by the generic
path, with zero backend-identity branch in the visibility code.

---

## 1. Grounded inventory (verified at planning, HEAD `e57fbbee`)

### 1.1 The visibility path (how a tool becomes visible to the LLM) — confirmed

1. `resolveRuntimeCapabilityDescriptor` (`packages/db/src/agent-runtime-descriptor.ts`)
   builds `resolvedSkills: SkillDefinition[]` from the agent's assigned skill
   rows. For a non-system skill it calls `inferSkillFromRevisionRow`, which
   **infers `capabilityFamilies = ['trading']` from a hard-coded tool-name
   allow-list** (`:143-152`) and derives `bindingRequirements`,
   `requiredContextBlocks`, `promptRendererHints` from `hasTrading` (`:154-166`).
2. The worker fallback (`apps/worker/src/agent.ts:470` `isTradingSkill`, used in
   `buildFallbackRuntimeDescriptor`) does the **same inference** from skill `id`
   (`bot-management | risk-monitoring | trading`) when no runtime descriptor was
   supplied.
3. `getVisibleToolNames(state)` (`apps/worker/src/runtime-composition.ts:2329`)
   = the **union of `resolvedSkills[].requiredTools`** (capped by
   `budgets.maxVisibleToolSchemas`). This is the ONLY input to visibility.
4. `allowedTools()` (`agent.ts:715`) wraps `getVisibleToolNames` →
   `toolRegistry.getDefinitions([...allowedTools()])` → `LlmToolDefinition[]`
   (the LLM tool defs; `agent.ts:3659/3722`, scout at `:3420`).
5. **All tools are always registered** (`apps/worker/src/tools/index.ts` —
   `tradingTools` et al are unconditionally in `allTools`). Trading tools reach
   the backend via the injected `ctx` ports built by
   `buildAgentExternalBackendPorts` (`agent-ports.ts`), NOT conditional
   registration. Visibility is purely "is the tool name in a resolved skill's
   `requiredTools`".

**Key consequence:** visibility does not depend on `capabilityFamilies` at all —
it depends on `requiredTools`. The `capabilityFamilies='trading'` inference drives
**binding requirements, context blocks, prompt hints, readiness, and tick-work
gating** — NOT the visible tool set. The descriptor's job in the generic path is
to be the authority for *which tool schemas a skill may expose* (DT4), feeding the
same `requiredTools`-shaped surface.

### 1.2 Backend-identity branches — classified (strict I1 grep + broad `.includes('trading')`)

Strict I1 regex (`'traderton'|"traderton"|=== 'trading'|!== 'trading'`) over the
six I1 files returns **exactly 2 hits** at HEAD `e57fbbee`:

| File:line | Hit | Class | Disposition |
|---|---|---|---|
| `apps/worker/src/agent.ts:470` | `isTradingSkill` fallback map (`=== 'trading'` etc.) | **(a) remove** | T3.2 — replace with generic resolution |
| `packages/db/src/agent-runtime-descriptor.ts:82` | `family === 'trading'` in `deriveReadiness` (venue-account check) | **(c) stays** | readiness/binding presentation — NOT visibility |

Broad `.includes('trading')` coupling (the real T3.2 work, not caught by the
strict regex except via the above):

| File:line | Role | Class | Disposition |
|---|---|---|---|
| `packages/db/src/agent-runtime-descriptor.ts:143-152` | infers `capabilityFamilies=['trading']` from a tool-name allow-list — **the core visibility/identity coupling** | **(a) remove** | T3.2 |
| `packages/db/src/agent-runtime-descriptor.ts:154-166` | `hasTrading`-derived bindingRequirements / requiredContextBlocks / promptRendererHints | **(a) remove the hard-coding** | T3.2 — derive from the descriptor/registry match, not a literal |
| `packages/db/src/agent-runtime-descriptor.ts:23,155-159` | `TRADING_ACCOUNT_TOOLS` guard (throws if `get_risk_limits`/`get_account_summary` without `trading`) | **(a) remove** | T3.2 — the generic matcher replaces the guard |
| `apps/api/src/routes/skills.ts:65,87-104` (`buildTradingCapabilityValidationError`) + call sites `:845,1037,1312` | API write-time validation that forces the `trading` family on scoped tools | **(a) remove** | T3.2 |
| `apps/worker/src/runtime-composition.ts:700` (`hasTradingCapability`) | TICK-WORK / venue-presentation gate | **(b) OUT (Step 14/15)** | see §6 scope fence |
| `apps/worker/src/agent-capabilities.ts:18` (`deriveHasTradingCapability`), `:23` (`tradertonBoundaryAvailable`), `deriveTradingTickWorkPlan` | market-data tick orchestration gate | **(b) OUT (Step 14/15)** | see §6 scope fence |
| `apps/worker/src/agent.ts:~912` startup guard (`deriveHasTradingCapability && !externalBackendRead → throw`) | market-data readiness guard | **(b) OUT (Step 14/15)** | see §6 scope fence |

Stays (class c), confirmed not in the visibility path:
- `tradingBackendId` first-party binding (P3-17) in `config/default.yaml` +
  `apps/worker/src/index.ts` — survives ONLY as the first-party runtime binding,
  **removed from the visibility path** (nothing in the generic matcher reads it).
- `runtime-composition.ts` venue presentation; `deriveReadiness(family='trading')`.

Out (class b, Step 14/15): everything under `packages/domain/src/trading/**`;
consumer-local trading names.

### 1.3 `DescriptorTool` ↔ `ToolDefinition` ↔ `category` — confirmed

- `DescriptorTool` = `{ name, description, inputSchema, category }`
  (`descriptor.ts`).
- `ToolDefinition` (LLM-facing, `packages/domain/src/trading/tool-contract.ts:335`)
  = `{ name, description, inputSchema, promptGuidance? }` — **no `category`
  slot**. This is what `getDefinitions` returns and the LLM consumes.
- `category` lives on `AgentTool` (`tool-contract.ts:321`) and on `TOOL_CATALOG`
  (`apps/worker/src/tools/*`), and is used by the **capability/security (rwx)
  model** and by `assertToolCatalogMatchesRegistry`
  (`apps/worker/src/tools/index.ts`) — a startup consistency check that every
  registered tool's `category` equals its `TOOL_CATALOG` entry.

So the descriptor's `category` has **no `ToolDefinition` destination** and no
LLM-facing role. See §4 for the decision.

### 1.4 The descriptor-source seam today — confirmed

`EXTERNAL_BACKEND_CONFIG_JSON` carries `ResolvedExternalBackend` only. There is
**no port** that returns a descriptor per backend. T3.1's `resolveDescriptorTools`
is pure — it takes a `DescriptorWrapper` as input and fetches nothing. T3.3 is
where a descriptor first enters the worker (as a stub).

### 1.5 The built-in-skill → source-ref gap — confirmed (load-bearing; see §3 decision 2)

A `skills` row has a `slug` (`system/trading`, `alice/my-skill`) but **no skills.sh
`owner/repo/skill` source ref column** (`packages/db/src/schema/skills.ts`). The
built-in trading skills (`id: 'trading' | 'bot-management' | 'risk-monitoring'`,
slugs `system/*`) are **platform-internal `SkillDefinition`s**, not installed via
`npx skills add`. The generic matcher keys on an *installed skills.sh ref* matched
against `approvedSourceSkillRefs` (= the D11 refs `traderton/skills/crypto-*`).
Nothing today maps a built-in trading skill to a D11 ref — this must be decided.

---

## 2. Design (refined from the investigation verdict — not relitigated)

**Generic rule (replaces every class-(a) branch):**

> For each resolved skill, obtain its **source skills.sh ref**. Match that ref
> against **any** `externalBackends[]` entry's `approvedSourceSkillRefs`. On a
> match, obtain that backend's descriptor via the **descriptor-source port**,
> call `resolveDescriptorTools({ definition, wrapper, installedSkillRef, now })`,
> and:
> - `tools_exposed` → expose the descriptor's tools (feed `requiredTools` +
>   per-tool registration) and the descriptor's `instructions`;
> - `instruction_only` (any trust failure) → expose the skill's instructions
>   only, no tools (DT3).
> No match → the skill is an ordinary platform skill, resolved as today (no
> change for non-external skills).

- **No `if (trading)` / backend-identity branch anywhere in the matcher.** The
  matcher names no backend; it iterates the registry. I1 → 0 in the visibility
  path (modulo the readiness stay at `agent-runtime-descriptor.ts:82`; see §5).
- `tradingBackendId` is NOT read by the matcher — it survives only as the
  first-party runtime binding (P3-17), out of the visibility path.
- **The resolver module lives worker-side** (new module
  `apps/worker/src/external-backend/skill-tool-resolver.ts`); the **trust logic
  stays in domain** (T3.1 `descriptor.ts`, untouched). The worker module is the
  composition that: looks up the registry, calls the descriptor-source port,
  calls the pure `resolveDescriptorTools`, and maps the result into the
  `SkillDefinition` surface.

**Descriptor-source port (new, domain):**

```ts
// packages/domain/src/ports/external-backend-descriptor-source.ts
import type { DescriptorWrapper } from '../external-backend/descriptor.js';
/** Returns the signed descriptor wrapper for a backend, or undefined if none is
 *  available (→ the matched skill degrades to instruction-only). Never throws. */
export interface ExternalBackendDescriptorSource {
  getDescriptor(backendId: string): Promise<DescriptorWrapper | undefined>
    | DescriptorWrapper | undefined;
}
```

- Injected at the **worker composition root** that already resolves the registry
  (the same place `EXTERNAL_BACKEND_CONFIG_JSON` / registry lookups live;
  `apps/worker/src/index.ts` + threaded into the agent runtime alongside the
  existing external-backend ports in `agent-ports.ts`).
- Modelled after the existing optional-port pattern
  (`ToolContext.externalSkillInstaller` from T0.5), so an absent source =
  `undefined` = instruction-only degrade, no crash.
- **T3.2 wires the port stubbed to return `undefined`** (so the generic path is
  live but degrades); **T3.3 replaces the stub implementation** to return the
  dev-signed stub descriptor for the matching backend. This is the single lever
  that flips trading from "instruction-only" to "tools resolve", and is why the
  removal commit (C3) and the stub-source commit (C4) are adjacent.

---

## 3. The four settled decisions (grounded, not relitigated)

### Decision 1 — Sequencing / parity (settled)

T3.2 + T3.3 are **one block, four commits** (§7). The generic matcher + port are
introduced *behind* the existing inference first (C1/C2), then the inference is
**removed in the same commit that wires the stub descriptor source**
(C3 removal + C4 stub, ordered so C3 already routes through the generic path and
C4 immediately supplies the descriptor; alternatively C3 and C4 fold into one
commit — see §7 note). The parity exit criterion ("trading tools resolve for a
D11-ref agent") is asserted **after C4 (T3.3)**, never after C3 alone.
→ **DECISIONS P3-47.**

### Decision 2 — Built-in `TRADING_SKILL` → D11 ref mapping (the one load-bearing choice)

**Problem:** the generic matcher keys on an installed skills.sh ref, but the
built-in trading skills are platform-internal (`id`/`slug` only, no source ref;
§1.5). Until T4.1 publishes the real `traderton/skills/crypto-*` skills and an
agent installs them, the built-in `trading` / `bot-management` / `risk-monitoring`
skills must still map to a D11 ref so the matcher fires and parity holds.

**Decision:** add an **explicit, data-only `sourceRef` field on `SkillDefinition`**
(optional, `sourceRef?: string`) and populate it for the three built-in trading
skills with their D11 refs, via a single platform-internal constant map
(`BUILTIN_TRADING_SOURCE_REFS = { trading: 'traderton/skills/crypto-trading',
'bot-management': 'traderton/skills/crypto-bot-management', 'risk-monitoring':
'traderton/skills/crypto-risk-monitoring' }`). The matcher reads `skill.sourceRef`
(for installed external skills this is the normalized install ref; for the three
built-ins it is the constant map value). Ground: the D11 refs are fixed in
`config/default.yaml → externalBackends.traderton.approvedSourceSkillRefs` and in
Step 10 §1/§3, and the T4.1 seed names (`crypto-trading`,
`crypto-bot-management`, `crypto-risk-monitoring`) are the SKILL.md names T4.1 will
publish — so the mapping is stable and already the operator-approved set.

**Why not infer the ref from `requiredTools`:** that reintroduces a hard-coded
tool-name allow-list — exactly the class-(a) coupling T3.2 removes. A declared
`sourceRef` is data on the skill, not an identity branch in generic code (I1
stays 0). **Why a constant map and not a DB column now:** the three built-ins are
code-defined `SkillDefinition`s, not DB rows; a column would be dead for them and
is T4-territory for installed skills. The constant map is the minimal,
reviewable, deletable bridge — and T4.2's grep for the stub naturally sits beside
it.
→ **DECISIONS P3-48.** (Note for T4: once the real skills are installed via the
fixture/live path, their `sourceRef` is the install ref and the built-in map is
only for the un-published built-ins; revisit if the built-ins are retired.)

### Decision 3 — `category` placement (lower-churn option)

**Decision:** do **NOT** extend `ToolDefinition` with `category`. The LLM-facing
`ToolDefinition` has no category slot and no need of one (§1.3). Map the
descriptor tool's `category` into the **existing `TOOL_CATALOG`/registry
conformance** path only: when a descriptor tool is exposed, its `category` is used
to satisfy `assertToolCatalogMatchesRegistry` (and the rwx capability model) for
the dynamically-exposed tool, exactly as a built-in tool's catalog entry does.

**Why this is lower-churn and correct:** descriptor tools in Step 12/T3.3 map 1:1
onto *already-registered* trading tools (the stub carries the current trading tool
schemas), which already have `TOOL_CATALOG` entries and categories. So for the
stub path the descriptor `category` is a **cross-check** against the existing
catalog entry, not a new registration — zero new catalog machinery, and the DT4
invariant (descriptor is the sole schema authority for `name`/`description`/
`inputSchema`/`category`) is satisfied by asserting the descriptor's `category`
equals the catalog entry rather than diverging. Extending `ToolDefinition` would
touch `tool-contract.ts` (domain), `llm-provider.ts`, every `getDefinitions`
mapper (`agent.ts:3420/3659/3722`) and the provider boundary — large churn for a
field the LLM never consumes. (A fully third-party backend whose tools are NOT
pre-registered is Step 14+ territory; record that as the carried-forward edge in
§8, since the stub maps onto registered tools.)
→ **DECISIONS P3-49.**

### Decision 4 — Open Q: generalise `EXTERNAL_BACKEND_CONFIG_JSON` forwarding 1 → N backends?

**Answer (from Step 10 §1 + §7):** **carried-forward, NOT in T3.2.** Step 10 §1
"Config migration" establishes the registry as `ExternalBackendDefinition[]` (N
entries) at config load, but the worker→agent payload is the single resolved
`{ definition, hmacSecret }` for `tradingBackendId` — Step 10 §7 Step 11 tasks 2/4
forward exactly one backend, and Step 12's task list says nothing about N-backend
forwarding. The descriptor-source port in this plan is **per-backendId** (takes a
`backendId`), so the *matcher* is already N-ready; the gap is purely the
**transport/secret forwarding** still being one backend.

**I12 implication (recorded):** a genuine second backend needs its resolved
`{ definition, hmacSecret }` + descriptor forwarded too. Until the forwarding is
generalised, registering a second backend resolves its *visibility* (tools shown
or instruction-only via the descriptor-source port) with **zero code change**, but
*invoking* its tools over HMAC requires the N-backend forwarding change. This is
the one item on the I12 "remaining code change" list at closeout — recorded as a
carried-forward obligation (T5.2 / Step 16), not fixed here.
→ **DECISIONS P3-50** (records the carried-forward answer + the I12 note).

### Decision 5 — The stub descriptor (T3.3) is temporary (I10)

The T3.3 stub descriptor + stub descriptor-source implementation are **named with
a greppable `STUB_DESCRIPTOR` / `stub-descriptor` token** so I10's grep
(`rg -n -i "stub.?descriptor|STUB_DESCRIPTOR" apps/ packages/ config/`) finds and
proves its deletion at T4.2. The stub is dev-signed by an **ephemeral in-process
ed25519 key** generated at build/test time (no committed private key; the public
key is placed into `externalBackends.traderton.trustedDescriptorSigningKeys` for
the dev/test run only), binding the three D11 refs → the current trading tool
schemas (sourced from the existing trading `AgentTool` definitions / `TOOL_CATALOG`
so the stub matches what is registered → DT4 cross-check passes).
→ **DECISIONS P3-51.**

---

## 4. New / changed files (by concern)

**Domain (no behaviour in the trust pipeline changes — T3.1 `descriptor.ts` untouched):**
- `packages/domain/src/ports/external-backend-descriptor-source.ts` — **new** port interface (§2).
- `packages/domain/src/skills.ts` — add optional `sourceRef?: string` to `SkillDefinition` (Decision 2); populate the three built-in trading skills + the `BUILTIN_TRADING_SOURCE_REFS` map (wherever the built-in `TRADING_SKILL`/`BOT_MANAGEMENT_SKILL`/`RISK_MONITORING_SKILL` are defined).
- barrel export updates for the new port.

**Worker (the generic matcher + wiring):**
- `apps/worker/src/external-backend/skill-tool-resolver.ts` — **new**: `resolveSkillTools(skill, registry, descriptorSource, now)` → `{ tools: DescriptorTool[]; instructions?: string } | { instructionOnly: true; reason }`. Pure composition over the registry + port + `resolveDescriptorTools`.
- `apps/worker/src/agent.ts:466-500` — remove `isTradingSkill` + the inferred family/binding/context/hints in `buildFallbackRuntimeDescriptor`; route resolved skills through the generic resolver.
- `apps/worker/src/external-backend/agent-ports.ts` + the composition root (`apps/worker/src/index.ts`, agent runtime assembly) — construct and inject the `ExternalBackendDescriptorSource` (stub in T3.3).
- `apps/worker/src/external-backend/stub-descriptor-source.ts` — **new (T3.3)**: `STUB_DESCRIPTOR` + the stub source impl (Decision 5). **I10-greppable.**

**DB (the DB resolution path):**
- `packages/db/src/agent-runtime-descriptor.ts` — remove `TRADING_ACCOUNT_TOOLS` (`:23`), the `inferredTradingCapability` allow-list (`:143-152`), the `hasTrading` guard/derivations (`:154-166`). Replace with: set `sourceRef` on the resolved skill (from the installed ref / built-in map) and let the worker generic resolver own family/tool exposure. **`deriveReadiness`'s `family === 'trading'` (`:82`) is NOT touched** (readiness stay — §5).
  - Note: this module imports no worker types; keep the *matcher* worker-side. The DB module's job narrows to "produce `SkillDefinition`s with a `sourceRef`", not "decide trading".

**API (write-time validation):**
- `apps/api/src/routes/skills.ts` — remove `TRADING_ACCOUNT_TOOLS` (`:65`), `buildTradingCapabilityValidationError` (`:87-104`), and its call sites (`:845,1037,1312`). The generic trust path (not an API family check) governs whether scoped tools are exposed. `buildUnknownToolValidationError` stays (it is not backend-identity).

**Config:**
- `config/default.yaml` — the `externalBackends.traderton` entry already carries `approvedSourceSkillRefs` (the D11 refs) and `descriptorPinning`. T3.3 adds the dev public key to `trustedDescriptorSigningKeys` for the dev/test run (clearly commented as stub/dev). No new `process.env` key is anticipated; if one is added, update `.env.example` in the same commit (repo rule + I11).

---

## 5. The I1 nuance (load-bearing — must be stated in the record)

The strict I1 grep as written returns **2 hits** at baseline; after T3.2 it
returns **1 hit**: `packages/db/src/agent-runtime-descriptor.ts:82`
(`family === 'trading' && !row.resolvedVenueAccountId`). This line is **connection
readiness**, not registration/dispatch/visibility — it is a class-(c) stay. The
T0.2 baseline already lists `:82` as one of the two literal hits.

**Decision for the record:** I1's intent ("no backend-identity branch in generic
*registration/dispatch/visibility* code") is satisfied at 0 for the visibility
path; `:82` is a readiness-presentation branch explicitly out of scope (it is the
family-keyed venue-account readiness, Step 14/15 territory). The plan proposes to
**annotate the I1 check** (or its recorded result) to exclude `deriveReadiness`'s
family check as a known readiness stay — NOT to contort `:82` into passing a
grep it was never about. Driving the *literal grep* to 0 would mean rewriting a
readiness check for a grep's benefit, which the invariant's own rubric
("Hits inside `packages/domain/src/trading/**` are Step 14/15 scope") already
anticipates. The implementer records this as the I1 disposition and does not
treat the single `:82` hit as a failure.

(The broad `.includes('trading')` sites at `runtime-composition.ts:700`,
`agent-capabilities.ts:18`, and the `agent.ts` startup guard are **not** matched
by the strict I1 regex and are the §6 fence — out of T3.2.)

---

## 6. Scope fence — explicitly OUT of T3.2 (Step 14/15)

The `'trading'`-family **TICK-WORK** and market-data orchestration gates are
**market-data orchestration, not tool visibility**, and are OUT of this block:
- `apps/worker/src/agent-capabilities.ts:18` `deriveHasTradingCapability`, `:23` `tradertonBoundaryAvailable`, `deriveTradingTickWorkPlan` (regime/volatility/venue/performance tick work).
- `apps/worker/src/runtime-composition.ts:~700` `hasTradingCapability` (venue presentation + readiness lines).
- `apps/worker/src/agent.ts:~912` startup guard (trading agent requires a read boundary — B7 market-data).

I1 passing does **not** require touching these (confirmed: the strict I1 regex
returns 0 hits in these three sites — they use `.includes('trading')` on
`capabilityFamilies`, which the strict regex does not match). They continue to
read `capabilityFamilies`, which the generic resolver still populates for a
descriptor-matched skill (so trading tick work keeps firing for trading agents →
parity). Removing them is Step 14/15. **Stated explicitly so the implementer does
not chase them to make a grep pass.**

---

## 7. Commit sequence (each commit: `pnpm build` + `pnpm lint` + relevant vitest green)

> `pnpm build` is the real type gate (T0.1 note: `pnpm lint` type-checks no inputs
> on the `files: []` solution tsconfig; test files are excluded — type-check new
> tests ad hoc under strict, I7 = 0).

**C1 — Descriptor-source port + `sourceRef` (additive, no behaviour change).**
- Add `ExternalBackendDescriptorSource` port + barrel export.
- Add `SkillDefinition.sourceRef?` + `BUILTIN_TRADING_SOURCE_REFS` + populate the three built-ins (Decision 2). Nothing reads `sourceRef` yet.
- Verify: domain + worker + db build; `pnpm --filter @herobids/domain exec vitest run`; existing skill/runtime tests unchanged.

**C2 — Generic skill-tool resolver + unit tests (behind the existing inference).**
- Add `skill-tool-resolver.ts` (worker) composing registry match → `descriptorSource.getDescriptor` → `resolveDescriptorTools`. Not yet wired into the live path.
- Unit tests for the matcher + the generic resolver (see §9).
- Verify: worker build + the new unit tests green; no live-path change.

**C3 — Remove the hard-coded trading branches AND route through the generic resolver (single commit).**
- Remove: `agent-runtime-descriptor.ts` `TRADING_ACCOUNT_TOOLS` (`:23`), inference (`:143-152`), `hasTrading` derivations/guard (`:154-166`); `agent.ts:470` `isTradingSkill` + fallback inference; `skills.ts` `buildTradingCapabilityValidationError` + call sites.
- Wire the generic resolver into both the DB path and the worker fallback. **Inject the descriptor-source port stubbed to `undefined`** at the composition root (so the path is live). At this commit, trading agents degrade to instruction-only — this commit **does not** assert the trading-parity exit; it asserts "generic path live, non-matching external skill gets no tools, degrade is clean".
- Verify: build + lint; worker/db/api unit + the resolver tests; the degrade tests (§9) green. Parity test is NOT asserted here.

> **C3/C4 ordering note:** C3 and C4 MAY be folded into a **single commit** if the
> implementer prefers that no committed commit degrades trading even transiently.
> The plan's hard requirement (Decision 1): the inference removal and the stub
> descriptor source land **in the same commit or in C3→C4 with C4 immediately
> following**, and the trading-parity assertion runs only once C4's stub is in.
> Prefer folding if the diff stays reviewable; otherwise keep C3→C4 adjacent.

**C4 — T3.3: register the dev-signed stub descriptor + stub source (flip to parity).**
- Add `stub-descriptor-source.ts` (`STUB_DESCRIPTOR`, dev-signed by an ephemeral key; I10-greppable, Decision 5). Add the dev public key to `externalBackends.traderton.trustedDescriptorSigningKeys` for dev/test. Replace the C3 `undefined` stub with this source.
- `category` handled per Decision 3 (descriptor `category` cross-checked against `TOOL_CATALOG`, not injected into `ToolDefinition`).
- Verify: build + lint; the **parity test** (D11-ref agent gets the stub's trading tools), the degrade/revocation/expiry/untrusted-key/backend-mismatch tests, and `INVARIANTS.md` genericity checks (I1 per §5, I6, I10 N/A-until-T4.2) green.

Each commit updates `TASKS.md` (status + cursor + running notes), `DECISIONS.md`
(the P3-47..P3-51 rows), and `PROGRESS.md` where Step 12 changes state —
**done by the implementing task, not this plan.**

---

## 8. Test strategy

**Unit (new, worker + domain):**
- The **generic matcher**: a skill whose `sourceRef` ∈ a registry entry's `approvedSourceSkillRefs` matches that entry; a skill with no `sourceRef` or an unapproved ref matches nothing; matching is registry-iteration with **no backend-identity literal** (assert by construction — the test registry uses a non-trading `example-echo` backend to prove genericity, reusing the T0.4 fixture shapes).
- The **generic resolver**: `tools_exposed` → tools surfaced; each T3.1 trust failure (`definition.disabled`, `descriptor.unknown_key`, `descriptor.signature_invalid`, `descriptor.backend_mismatch`, `descriptor.expired`, `descriptor.pin_mismatch`, `descriptor.ref_not_approved`, `descriptor.tools_list_mismatch`) → instruction-only, **reusing the T0.4 reason codes verbatim** (do not re-derive). The resolver never throws (DT3).
- `category` cross-check (Decision 3): a descriptor tool whose `category` disagrees with its `TOOL_CATALOG` entry is a trust/consistency failure, not a silent catalog mutation.
- `sourceRef` population: the three built-ins carry their D11 refs; a non-trading built-in (`programming`, `web-access`) carries none.

**Integration / parity (worker, after C4):**
- **Parity test (the explicit success bar):** an agent whose resolved skills include the D11 refs (built-ins mapped via `BUILTIN_TRADING_SOURCE_REFS`, or installed via the T0.5 fixture source) gets **exactly the trading tools it gets today**, via the generic path, with the stub descriptor. Compare the visible tool-name set + schemas against the pre-T3.2 trading tool set.
- **Non-matching external skill → NO tools:** an installed external skill whose ref is not in any `approvedSourceSkillRefs` resolves to instruction-only (no tools), no crash.
- **Degrade matrix (no session crash), reusing T0.4 reason codes:** revocation (`enabled:false` / ref removed → `definition.disabled` / `descriptor.ref_not_approved`), expiry (`descriptor.expired`), untrusted key (`descriptor.unknown_key` / `descriptor.signature_invalid`), backend mismatch (`descriptor.backend_mismatch`) each degrade to instruction-only without throwing.

**Invariant checks (at the block boundary):**
- **I1** → per §5: 0 in the visibility path; the single `agent-runtime-descriptor.ts:82` readiness hit recorded as a known stay (not a failure).
- **I6** (descriptor is sole schema authority): the `tools/list`/`toolsList`→schema grep stays 0; the stub's tools flow from the descriptor, and `category` is cross-checked, never sourced from a `tools/list`.
- **I12**: the written answer per Decision 4 — "yes for visibility via config + signed descriptor; the N-backend HMAC forwarding is the one remaining code change" — recorded as a carried-forward obligation.
- **I7** 0 escape hatches; **I10** N/A until T4.2 (stub greppable).

**Heavy / e2e suites owed to the coordinator (NOT run inside this plan's commits; the coordinator runs them at the block/closeout gate G2):**
- `herobids/scripts/shell/tests/run-all-tests.sh --e2e` (full vitest + Playwright tiers).
- `herobids/scripts/shell/tests/run-extra-tests.sh --all` (G2 mandated; Tier 6 contacts staging — see P3-1/E1; the coordinator owns running it, not this block).
- G3 local-boundary assertion (`env | grep TRADERTON_` empty, etc.) **before** any suite, every time.
- Do NOT set `RUN_UNSTABLE_LLM_LATENCY_TESTS=1`.

---

## 9. DECISIONS rows to record (assign at implementation; log is at P3-46 → start P3-47)

| ID | Decision (summary) | Rationale |
|---|---|---|
| P3-47 | T3.2 + T3.3 are one sequenced block; the trading-parity exit asserts only after the stub descriptor source (T3.3/C4) lands; the inference-removal commit (C3) and the stub-source commit (C4) are the same commit or strictly adjacent so no committed commit degrades trading beyond C3→C4. | T3.2 alone has no descriptor to resolve → breaks parity; T3.3 supplies it. |
| P3-48 | Built-in trading skills map to D11 refs via an explicit `SkillDefinition.sourceRef?` + a `BUILTIN_TRADING_SOURCE_REFS` constant map; the generic matcher reads `sourceRef`, never a tool-name allow-list. | A declared source ref is data, not an identity branch (I1 stays 0); the three D11 refs are already the operator-approved set in config + Step 10 §1/§3 and match the T4.1 seed names. |
| P3-49 | Do not extend `ToolDefinition` with `category`; map the descriptor tool's `category` into the existing `TOOL_CATALOG`/registry conformance (cross-check), since the stub's tools map 1:1 onto already-registered trading tools. | Lower churn (no `tool-contract.ts`/`llm-provider.ts`/`getDefinitions` changes); the LLM never consumes `category`; satisfies DT4 by asserting equality rather than diverging. |
| P3-50 | Generalising `EXTERNAL_BACKEND_CONFIG_JSON` forwarding from 1 → N backends is **carried-forward** (not T3.2). The matcher/port are per-`backendId` and N-ready; only the resolved-`{definition,hmacSecret}`+descriptor forwarding stays single-backend. | Step 10 §1/§7 forward one backend (`tradingBackendId`); Step 12's task list does not require N-forwarding. I12 note: a second backend resolves *visibility* with zero code change, but *invoking* its tools needs the N-forwarding change — the one item on the I12 remaining-code-change list. |
| P3-51 | The T3.3 stub descriptor + stub source are dev-signed by an ephemeral ed25519 key, named with an I10-greppable `STUB_DESCRIPTOR` token, bind the three D11 refs → the current trading tool schemas, and are deleted at T4.2. | DT3/DT4 local resolution without a real key (D20 push gate); I10 proves deletion. |

---

## 10. Could not ground (named)

- **Nothing load-bearing is ungrounded.** All file:line claims in §1 were verified
  at HEAD `e57fbbee`.
- **One partial read for context (not load-bearing):** the full
  `apps/api/src/routes/skills.ts` call sites `:845,1037,1312` for
  `buildTradingCapabilityValidationError` were located by grep in the TASKS
  inventory but not each read line-by-line in this plan; the implementer should
  read those three call sites before removal (they are plain invocations of the
  helper, per the TASKS inventory, but confirm no additional branching wraps
  them).
- **Composition-root exact injection point:** `agent-ports.ts` +
  `apps/worker/src/index.ts` are confirmed as where the external-backend ports are
  built/forwarded; the precise line to add the descriptor-source construction was
  not pinned (it belongs beside `buildAgentExternalBackendPorts` wiring). The
  implementer picks the exact site when wiring C3/C4.
```