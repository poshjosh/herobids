# IMPLEMENTATION — Agent Onboarding Through Conversation

**This is the single entry point for the implementing agent.** Read this file first, in full, then follow it end to end. It consolidates the objective, the rules, the decisions already made, the decision framework, the execution order, and the audit loop. The detailed plans live in the sibling folders listed below — read each plan before starting its work items.

**Epic roadmap:** [000-roadmap.md](./000-roadmap.md) — the vision, dependency graph, waves, gates, and the cross-document review (findings F1–F21). Read it after this file.

---

## 1. Strategic objective

A user creates an agent with a name and a way to talk to it. After that the agent does the rest: it adds its own skills, discovers what it can connect to, sends the user a link when it needs a connection, is woken when the connection exists, and sets its own goal. The create flows (form and guided chat) shrink accordingly, and trading disappears from creation because it is one capability the agent can acquire like any other.

**Success = Gate G1 passes** (the self-serve loop UAT, §6) **and the cut-over ships** (form and guided chat contain no trading references, both call one shared create core).

---

## 2. Work packages (where the plans live)

All under `docs/features/2026/10/10/`:

| WP | Folder | Plan | Role |
|---|---|---|---|
| WP-A | `003-dynamic-connections/` | `001-plan.md` (+ `000-discovery.md`) | Agents discover providers, request connections by link, are woken on completion |
| WP-H | `004-shared-profile-derivation/` | `001-plan.md` (+ `000-analysis.md`) | One shared trading-profile derivation for all write paths |
| WP-B | `005-post-creation-trading-provisioning/` | `001-plan.md` | Trading provisioning for an agent that becomes trading-capable after creation |
| WP-C | `006-simplified-agent-creation/` | `001-plan.md` | Simplified form + guided chat, in-app conversation, `update_my_prompt` |
| WP-M | `007-multi-provider-chat-messaging/` | `900-implementation-plan.md` (+ `000`–`060` design docs) | Provider-neutral chat, WhatsApp, SMS, channel address model |
| WP-E | *(none yet)* | — | Email as a conversational channel (inbound). **Design it during Wave 4** (see §6). |

---

## 3. Rules & invariants

### 3.1 Standing repo rules (read `AGENTS.md` — these are non-negotiable)

- **Agent Mode Purity.** The agent's goal text and explicit creator constraints are the source of policy. Never inject hidden constraints. Data and operational mechanics are always applied; *constraints* only when explicitly configured.
- **Risk gate.** User-configured limits are **immutable at runtime** (the agent cannot weaken them). Operator defaults are **agent-mutable downward** within operator ceilings. No hard-coded magic numbers — every default comes from operator config.
- **Config layers.** Operator config (`config/default.yaml` + env) vs instance config (Postgres JSONB) — never mix them. New config keys go in the schema + `default.yaml`; any env override gets a committed `.example` twin in the same change.
- **Error handling.** Public APIs return `Result<T, E>` (`ok()`/`err()`); error codes are namespaced dot-strings (`venue.timeout`, `risk.exceeded`, `connection.missing`). Distinguish fatal (crash) from warn-and-continue.
- **Type safety.** Strict TS, branded types for domain values, Zod at boundaries, interior code trusts validated types. No `any`, `@ts-ignore`, or `as unknown as X`.
- **Architecture.** Ports & adapters; depend on abstractions; constructor injection; business logic pure (no I/O).
- **Parity-drift.** `scripts/parity-drift-manifest.json` declares files that must stay byte-identical to the traderton sibling. If you intentionally diverge, narrow/reclassify the manifest entry, bump the sibling pin via `scripts/shell/ops/release.sh --bump-parity-pin <tag>`, and record the pair in the parity-check ledger. Never revert a feature to hide drift.
- **Investigate before fixing.** Read related docs, search `docs/bug-reports/`, read `git log` before changing code.
- **Never mutate shared infrastructure state** (no Terraform `apply`/`workspace new`/S3/DNS/server changes) without explicit approval.
- **Tests describe behaviour**, not implementation. Commits are atomic. `pnpm lint` must pass before work is complete.

### 3.2 Epic-specific invariants

1. **Live mode only via go-live.** No path in this epic enables live trading. `set_trading_setup` provisions **paper** only. Live stays behind `POST /agents/:id/go-live` + explicit UI confirmation.
2. **User-configured limits are immutable.** The provisioning path may only set values at or below operator ceilings; anything the user wants looser or locked goes through the edit form.
3. **The agent never grants itself a user's connection.** `use_existing` exists precisely because an agent must not self-grant. Connection grants always flow through the user-facing link/approval.
4. **Bearer tokens never enter LLM context.** The connection-request link carries a login token; it is short-lived and single-use, and instructions tell the agent to forward it promptly and not persist it.
5. **One worker-to-API mechanism.** WP-A A3 and WP-B B4 both need the worker to trigger API-side actions (mint a link, create a generated connection, grant). Decide the mechanism **once** (in WP-A A3) and reuse it in WP-B — do not invent two patterns.
6. **New tools must be registered in `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG`** (`packages/domain/src/tools.ts`), or `assertToolCatalogMatchesRegistry` fails at worker startup. `BASE_SKILL.requiredTools` alone is not enough.
7. **The wake publisher is a domain port.** `InstanceEventPublisher` lives in `apps/worker`; connection writes happen in `apps/api`; `packages/db` may not depend on apps. Use a domain port with an API-side Redis implementation (same XADD).

---

## 4. Decisions already made (do not re-litigate)

These are settled. Implement them as specified; do not reopen them.

| # | Topic | Decision |
|---|---|---|
| D-A1 | Connection-request link | **The agent receives the link.** `request_connection` returns `{ requestId, link, expiresAt }`; the agent forwards it via `send_message`. Token is short-lived/single-use; instructions say forward promptly, don't persist. |
| D-A2 | Expiry sweeper placement | **Implementing agent decides**, preferring to host it in the existing `reminder-coordinator` (already emits wakes + holds the single-worker lease). Do not add a second loop without documenting why the reminder coordinator couldn't host it. |
| D-B1 | Provisioning approach | **Ask once.** If the user hasn't said, the agent asks: pick safe defaults (test mode, simulated money) or set specifics. Both paths use **one tool** (`set_trading_setup`); defaults path is the same call with no values. |
| D-B2 | Provisioned mode | **Paper only.** Never live. Generated wallet, never funded for test. |
| D-B3 | Running-agent grant | Add a **dedicated** running-agent grant path (used by `set_trading_setup` and WP-A link completion). All other callers keep the stopped-agent requirement. |
| D-C1 | Channel vs connection | A channel (Telegram/WhatsApp/email) is a **chat-address binding**, not a `connections` row. A Gmail-type `connection` (agent sends as the user) is separate and optional. |
| D-C2 | Channel scope | Channels bound **per user**; agents inherit. |
| D-C3 | In-app chat | **Accepted.** Minimal in-app conversation on the agent detail page (not the `chat_sessions` model). External channel optional but strongly recommended. |
| D-C4 | Start step | **No auto-start.** Create (stopped) → press Start → land in conversation. Revisit only if the extra click proves to be friction. |
| D-C5 | Name | Optional; auto-generated if blank; unique per user (collision retry). |
| D-C6 | Goal at creation | Not asked. If the user volunteers one, forward it as the agent's **first message** (not stored as prompt). Durable goal is the agent's job via `update_my_prompt`. |
| D-C7 | API compatibility | `POST /agents` keeps accepting the full payload. Only the two UIs are simplified. |
| D-C8 | Telegram binding | One-time deep link `t.me/<bot>?start=<token>`; **lookup-first** (token lookup before `handleStart`), `/link <code>` as fallback. |
| D-C9 | Guided chat | **Keep it.** More evolvable than a form; not obviously similar to the user. Can grow non-trading steps later (ask objective → agent adds skills/connections). |
| D-C10 | Guided chat scope | Chat asks for **name + channel**, not "what do you want your agent to do" (that's the agent's job post-creation). |
| D-H1 | WP-H scope | Extract **one shared derivation seam** (`deriveTradingProfileFields`), consumed by the surviving paths + WP-B. Do **not** migrate `POST /agents` and `chat.ts create_agent` (WP-C deletes them). |
| D-E1 | Email semantics | Email behaves like Telegram/WhatsApp (messages to the user's address). Inbound replies are WP-E. |
| D-R1 | `chat_sessions` idea | **Rejected** (F10). Minimal in-app conversation instead. |
| D-R2 | SMS | Off the critical path (A2P compliance is long-lead). Not in the creation channel list. |

---

## 5. Decision framework (when to decide vs escalate)

The implementing agent **decides autonomously** by default. For every decision it makes, it must **record the decision in the relevant plan** (add a dated note) and move on.

**Escalate (pause and ask the owner) ONLY when a choice would change one of these five things:**

1. A **user-configured limit** (making it weaker or removing it).
2. A **security boundary** (e.g. putting a bearer token into LLM context, weakening HMAC/auth, exposing secrets).
3. A **public API contract** (changing `POST /agents` semantics, removing a field a programmatic caller relies on, breaking a documented route).
4. A **parity-drift authority** (changing which repo owns a mirrored file, or reclassifying a manifest entry's authority).
5. Something the **owner explicitly reserved** (anything marked "owner decision" in the plans that is *not* already in §4).

Everything else — implementation detail, naming, file placement, test strategy, sequencing within a wave, minor UX copy — is **decide, record, move on**. If a plan says "the implementing agent decides" (e.g. D-A2), that is an explicit grant of autonomy: decide it, document the choice, proceed.

**If genuinely blocked** (a HIGH finding that contradicts a settled decision, or a missing prerequisite that blocks a whole wave), stop and report — do not silently change a settled decision.

---

## 6. Execution order

Work **wave by wave**. Within a wave, work items are parallel and independent. Do not start a later wave before its gate passes.

### Wave 1 (parallel, no cross-dependencies)

- **WP-A A1** — split `precondition.not_ready` into `connection.missing` / `connection.provisioning` (error split in resolver + tools).
- **WP-A A2** — `list_providers` tool (move provider catalog to a shared package; register in tool catalog).
- **WP-A A3 design** — decide the worker-to-API token-mint mechanism (brokered capability, per F21). This is the "decide once" seam WP-B reuses.
- **WP-H H1–H2** — `deriveTradingProfileFields` + migrate the surviving paths (grant/revoke, delete fan-out, go-live, blueprint, PATCH, PUT).
- **WP-M Phase 0–1** — registry amendment + `ChatChannel` port (behaviour-preserving refactor; Telegram re-wired behind it).
- **WP-C S0** — prerequisite checks (name uniqueness, blank-agent idle cost, billing gates; fix the free-plan config comment per F20).

**Wave 1 gate:** `pnpm lint` + `pnpm test` green; no behaviour change (pure refactors + additive tools).

### Wave 2 (parallel)

- **WP-A A3–A6** — `request_connection` (catalog validation), A4 `?provider=` form handling, A5 wake on resolved/expired (domain port + API Redis impl + expiry sweeper per D-A2), A6 base-prompt guidance.
- **WP-B B1–B8** — operator defaults (traderton authority), running-agent grant, provisioning via `changes`, `set_trading_setup` tool, reuse-or-create generated connection, trading-skill instructions, remove paper/shadow flip, `get_funding_info`.
- **WP-C S1–S2** — optional name, first-turn greeting, `update_my_prompt`, in-app conversation (composer + thread + post-create landing).

**Wave 2 gate:** each WP's own work-item gates pass (see the plans' "Work items" tables).

### Gate G1 — agent self-serve loop UAT (blocks the cut-over)

With the **old** create flows still in place, create a blank agent through the API and verify end to end:

> converse → `add_skills` → `connection.missing` → `list_providers` → `request_connection` → link completed **or** expired → agent woken → trade in test mode → agent persists its own goal.

Record the result in `002-agent-onboarding-epic/`. **This is the epic's definition of done for the core loop.** If it fails, fix and re-run before Wave 3.

### Wave 3 — cut-over

- **WP-C S3** (simplified form) + **S4** (simplified guided chat), shipping together, with landing/help copy updates. Both call one shared `createAgent` core.

**Cut-over gate:** form and guided chat contain no trading references; `pnpm lint`, `pnpm test`, `run-all-tests.sh --e2e` pass; public content + docs index regenerated.

### Wave 4 — channels (independent increments)

- **WP-M Phase 2–3** — `chat_addresses` data model, neutral inbound ingress, `messaging.chat.*` config.
- **WP-C S5.1** — Telegram deep-link binding.
- **WP-M Phase 4** — WhatsApp adapter (Meta prerequisites are long-lead; start them early).
- **WP-E** — **design then implement** the email channel (inbound ingestion, reply threading, sender verification). This is the one WP with no plan yet: **generate the plan first** (use PlanCreator), then implement.

**Channels gate:** each channel passes its own round-trip test, has `.example` twins, i18n keys, and appears in the create form only when `available` and healthy.

### Wave 5 — cleanup

- **WP-M Phase 6** — contract migration (drop legacy columns/config aliases; prefer keeping the `/telegram/webhook` route alias).
- Remove dead create-flow code; archive superseded docs.

---

## 7. Sub-agent orchestration

Use the available sub-agents at the right moments. Do not do everything inline.

| When | Use |
|---|---|
| A design question is genuinely open (not covered by §4 or the plans) | **Contemplator** — contemplate the direction, then record the decision |
| A plan is needed (WP-E, or a work item grew beyond its plan) | **PlanCreator** — write/update the plan before coding |
| Implementing a settled plan/work item | **Implementer** |
| Writing tests | **Tester** / **UnitTester** |
| A test fails or a bug surfaces | **BugFixer** — investigate + fix (read `docs/bug-reports/` first) |
| Reviewing a wave's output | **Reviewer** / **Reworker** — review, then rework until only LOW/MEDIUM remain |

**Rule:** never start coding a work item whose plan is missing or ambiguous. Generate/update the plan first, then implement.

---

## 8. Audit loop (part of the process, not optional)

After **each wave** (and after Gate G1 and the cut-over):

1. **Review** the wave's changes against its plan (use Reviewer/Reworker).
2. **Fix** until only LOW-severity observations remain (MEDIUM/HIGH must be resolved).
3. **Verify** the wave's gate (§6) passes.
4. **Record** the outcome in the relevant plan (status, what shipped, what's deferred).

**Definition of done for the whole epic:**
- Gate G1 UAT passes and is recorded.
- Cut-over ships: no trading references in form/guided chat; one shared create core.
- `pnpm lint`, `pnpm test`, `scripts/shell/tests/run-all-tests.sh --e2e` all pass.
- Every new env var has a committed `.example` twin; every new config key is in the schema + `default.yaml`.
- Every decision made during implementation is recorded in the relevant plan.

---

## 9. Quick reference — the five escalation triggers

Pause and ask the owner **only** if a change would touch: **(1)** a user-configured limit, **(2)** a security boundary, **(3)** a public API contract, **(4)** a parity-drift authority, or **(5)** something the owner explicitly reserved. Otherwise: decide, record, move on.