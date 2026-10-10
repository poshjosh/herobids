# Session transcript — parity-drift-check elimination discussion

Captured conversation, starting from "Why do we need the parity drift check?" through
the decision to write brief B. Lightly trimmed for formatting only; content unchanged.

---

[project manager]
Why do we need the parity drift check? keep response simple

[LLM agent]
Herobids and traderton both contain a copy of the same trading core logic (herobids embeds it, traderton is the standalone extraction). The check makes sure those two copies don't silently drift apart — if one gets a bug fix or behavior change the other doesn't, you'd have two systems claiming to do the same trading logic but actually behaving differently, with nothing catching it until a real trading bug shows up.

---

[project manager]
I am surprised that herobids contains what we moved to traderton. Why?

[LLM agent]
Herobids keeps copies for two different reasons, per ADR 011:

1. **Authority is split, not fully extracted.** Traderton owns enforcement (risk math, defaults) — herobids reads from it, doesn't duplicate logic. That part really did move.
2. **Some files are deliberately mirrored verbatim**, not moved: wire-contract types, gate/session-hours logic shared by both sides of a boundary call. Herobids needs its own local copy to type-check and operate even though traderton is the runtime authority. These are "intentional mirrors," and the parity-drift check exists specifically to keep those mirror pairs byte-identical since they can't just reference one source across repo/deploy boundaries.

So it's not accidental duplication left over from the extraction — ADR 011 explicitly chose "split single-sourcing" over full extraction, because some types/contracts have to physically exist in both repos to work.

---

[project manager]
I challenge this: "some types/contracts have to physically exist in both repos to work.". I mean that is not an a hard truth. we can design it so that those not have to be the case

[LLM agent]
You're right to challenge that — it's not a law of physics, it's a design choice with a cost tradeoff. Alternatives that would eliminate the physical duplication:

1. **Shared published package.** Pull the mirrored contract/type files into a separate package (npm registry, private or public) that both herobids and traderton depend on as a versioned dependency. Single source, both repos import it. Cost: release/version-bump ceremony for every contract change, and you need a registry (private npm, GitHub Packages, etc.).

2. **Git submodule / subtree.** Both repos pull the shared files from a third "contracts" repo. Cost: submodule workflow pain (notoriously easy to get out of sync, worse DX than what you have now).

3. **Codegen from a single schema.** Define the wire contract once (e.g. a JSON Schema, protobuf, or a Zod schema in one canonical location) and generate the TypeScript types into both repos at build time. This is probably the cleanest option for *contract types* specifically — it removes hand-maintained duplication and replaces "stay in sync manually, verified by drift-check" with "always in sync, generated." Traderton already uses Zod; this fits.

4. **Runtime-only contract, no compile-time duplication.** Herobids doesn't import traderton's types at all — it only knows the wire shape (JSON over HTTP/the boundary), validated with its own Zod schema at the boundary. The two schemas can still drift in behavior, but you've converted "two TypeScript files must be byte-identical" into "two independent boundary validators must agree on the wire format," which is arguably what you actually care about, not source-identity.

Given this platform's actual constraint — herobids and traderton are **separately deployed, independently releasable repos**, and the whole justification for extracting traderton was decoupling — option 1 (shared package) or 3 (single schema, codegen) are the real fixes if you want to stop maintaining physical copies. Option 4 is arguably more aligned with the extraction's own goal of decoupling, since it stops pretending the two repos share a compile-time type at all.

The current "verbatim mirror + drift check" approach was chosen likely because it was the fastest path to ship the extraction without taking on a new package/registry or a codegen pipeline. That's a reasonable tactical call, but it is a workaround, not a hard constraint — worth revisiting if the drift-check failures become frequent friction (which the one you just hit suggests they might).

---

[project manager]
how does MCP work? how does RMI work? I know you don't have to know the types of say, the server

[LLM agent]
Both are relevant to the shared-contract question you just raised, so let me ground this in how each actually avoids compile-time type duplication.

**MCP (Model Context Protocol)**

MCP is a JSON-RPC based protocol between a client (an AI agent/host) and a server that exposes tools, resources, and prompts. The mechanics:

- Transport is JSON-RPC 2.0 over stdio, HTTP, or SSE/streamable-HTTP.
- The server doesn't ship the client any compiled types. Instead it exposes a `tools/list` method that returns tool definitions as **JSON Schema** — name, description, and an `inputSchema` describing parameters.
- The client calls `tools/list` at connection time, discovers what's available, and validates/constructs calls against that schema at runtime. There's no shared TypeScript interface between client and server at all — the schema itself is the contract, transmitted at runtime, not maintained as parallel source in two codebases.
- Tool invocation is `tools/call` with a name and arguments object; the server validates and executes, returning a result (text, images, or structured content) or an error.

This is basically your "option 4" (runtime-only contract) taken further: not even hand-maintained duplicate Zod schemas on both sides — one side (the server) is the sole source of the schema, and the other side (the client) discovers it dynamically instead of needing it checked into its own repo.

**RMI (Java Remote Method Invocation)**

RMI takes the opposite approach — it leans into shared compiled types rather than avoiding them:

- You define a Java `interface` extending `Remote`, with methods declared to throw `RemoteException`. This interface is compiled and must be available as a class on **both** the client and server classpath — this is the one piece that is literally shared, by design.
- The server implements that interface (extending `UnicastRemoteObject` or similar) and binds an instance to an `RMIRegistry` under a name.
- The client looks up that name via the registry (`Naming.lookup("rmi://host/service")`), which hands back a **stub** — a dynamically generated proxy implementing the same `Remote` interface.
- Calling a method on the stub serializes the method name and arguments (via Java serialization), sends them over a socket to the server, which deserializes, invokes the real method on the actual object, serializes the return value, and sends it back. The stub deserializes the result and returns it to the caller as if it were a local call.

So RMI's contract-sharing mechanism is literally "both sides compile against the identical `.class` file for the interface" — closer to your current herobids/traderton mirror situation (physically identical artifact on both sides), except RMI formalizes it as a single compiled interface shared at the classpath level, generated stubs handle the plumbing, and Java serialization (not hand-written JSON parsing) handles the wire format.

The contrast is useful for your actual question: MCP solves cross-codebase type duplication by **not sharing types at all** — schema is runtime-discovered. RMI solves it by **leaning fully into sharing** — one canonical compiled artifact, with tooling (rmic/dynamic proxies) generating the remote-call plumbing around it so you don't hand-write it. Herobids/traderton's current "verbatim mirror + drift check" is neither — it's hand-maintained duplication with no code generation and no runtime discovery, which is why it's the most fragile of the three.

---

[project manager]
So what do you recommend for our case and why? keep it simple

[LLM agent]
Zod schema as the single source + codegen types, not a shared package.

Why: herobids already validates boundary calls with Zod, and traderton is the authority for the trading logic. Put the wire-contract Zod schemas in traderton only (it already owns authority), export the inferred TS types from them, and have herobids import/generate from that at build/release time instead of hand-copying files. That gets you:

- One place to edit when the contract changes (traderton).
- Compile-time types still work (no runtime-only guessing).
- No npm registry/package-publishing ceremony — just a copy/codegen step in your existing release pipeline, replacing "hand-edit two files, hope they match" with "generate herobids's copy from traderton's schema automatically."
- The drift check becomes unnecessary or trivial (it's generated, so it can't drift) instead of a manual gate that fails releases.

Skip RMI-style shared compiled artifacts (too heavy, wrong language model) and skip full MCP-style runtime discovery (your two repos aren't a dynamic plugin ecosystem, they're a fixed pair that release together — compile-time types are more valuable here than runtime flexibility).

---

[project manager]
can herobids import traderton's zod schema from a URL not local disk? yes or no only

would you advise this? yes or no only

[LLM agent]
No

No

---

[project manager]
it seems that we are still coupling

[LLM agent]
Correct — codegen-at-release-time is still coupling, just moved from "manual copy-paste" to "automated copy-paste." It doesn't remove the dependency, it only removes the human error in keeping it in sync. The two repos still can't release independently of each other's contract changes.

The only option that actually removes the coupling is runtime discovery — MCP-style. Herobids doesn't know traderton's types at compile time at all; it only knows the wire format at the HTTP boundary, validated by its own schema, and the two sides agree on behavior through versioned API contracts (e.g. semver on the endpoint, or a schema fetched and validated at request time, not import time). That's a real decoupling, at the cost of losing compile-time guarantees on the shared shape.

So: if full independence is the goal, drop compile-time shared types entirely and treat the boundary as an API contract (versioned, tested with contract tests on both sides) rather than a shared source artifact. If compile-time safety matters more than independence, the coupling is inherent and the only question is whether it's manual (current) or automated (codegen) — not whether it exists.

---

[project manager]
how much effort for:

a - code gen from zod schema at compile time/release time

b - run-time discovery MCP style

keep response simple

[LLM agent]
**a. Codegen from Zod schema — small/medium**
- Pick which files are "contract" (you already have this list in the parity manifest).
- Add a script: at traderton release time, copy/transform those schema files into herobids (or export them and have herobids's build pull them in).
- Replace the parity-drift check with "did the generated file get regenerated" check.
- Rough effort: a few days. Mostly plumbing you already half-have (the manifest, the release scripts).

**b. Runtime discovery, MCP-style — large**
- Design/version an actual API contract for every mirrored concept (session hours, trading protocol, etc.) instead of a shared type.
- Herobids drops static imports of those types; writes its own Zod validators at the boundary call site, independent of traderton's internal types.
- Need contract tests on both sides to catch behavioral drift (since there's no shared source to diff anymore).
- Likely touches call sites across both repos, not just the shared files — anywhere code currently assumes the shared type's shape.
- Rough effort: weeks, and ongoing discipline (contract tests become mandatory, not optional).

Simple takeaway: (a) is a tooling fix on top of what exists. (b) is an architecture change.

---

[project manager]
will either really stop the need for parity check? is parity check only for types?

[LLM agent]
No, parity check is not only for types — and no, neither option fully eliminates it.

**Not just types.** The manifest covers: YAML config (`agentRiskDefaults`, strategy presets), and TypeScript **logic**, not just type declarations — e.g. `tick-gates.ts` (session-hour gating logic), `presets-loader.ts`, `mode-rank.ts`, `trading-protocol.ts` (Zod schemas, which are runtime validators, not just types). So this is behavior and config parity, not a types-only problem.

**(a) Codegen from Zod** only helps the Zod-schema entries (e.g. `trading-protocol.ts`, maybe `agent-risk-contract.ts`). It does nothing for YAML presets, `tick-gates.ts` logic, `mode-rank.ts`, loaders, etc. Parity check still needed for everything else — maybe 25+ of these 32 entries remain.

**(b) Runtime discovery (MCP-style)** only applies to things exposed across the actual network boundary (API calls). Most of this manifest is **shared internal logic/config both processes run locally** (worker-side gating, config loaders, domain value objects) — there's no "call" to discover at runtime, because both sides execute the code themselves rather than calling each other. MCP-style discovery doesn't apply here at all for most entries.

So: both proposals shrink the problem for a subset, neither removes the need for a parity mechanism overall. The real fix for the bulk of this list (pure domain code with `mirror-only` authority) is the shared-package approach (option 1 from earlier) — a published `@herobids/trading-domain` package both repos depend on — since this is genuinely shared logic, not a client/server contract.

---

[project manager]
why does herobids need the same yaml config as traderton? or vise versa. can't the consumer request it from the owner/server at runtime?

[LLM agent]
Good question — and per ADR 011/B2, that's actually already partly true. [Checked B2-duplicated-authority.md.]

Good catch, and the doc actually confirms your instinct is already half-implemented: `agentRiskDefaults` **does** fetch from traderton at runtime now (via `get_operator_defaults`/boundary read), it just also keeps a local YAML copy pinned by the drift check — specifically for **offline validation**, so the API can reject a bad risk value synchronously without a network round-trip to traderton.

So the real answer to "why not just fetch it live" is this tradeoff, stated plainly in the doc: fetching live removes the duplication but costs you a boundary round-trip for every validation. The team decided that cost wasn't worth it for a frequently-hit code path (API create/update validation, form auto-fill), so they kept a cached/local copy and pinned it with a drift check instead.

Whether that tradeoff is still right depends on how hot that path is and how tolerant it is of a network call:

- If validation can afford one HTTP call to traderton (and traderton is always up when herobids is), fetch-at-runtime removes the YAML duplication entirely — no parity check needed for that entry.
- If it must work with zero round-trip (offline-tolerant, or on a hot path), the cached copy is the right call, and the drift check is the price of caching instead of calling.

For the **strategy-preset catalogs** specifically, the doc says their fate is still undecided (deferred to B4) — that's the one where "just fetch it live" is a live, unresolved option, not something already rejected.

So: your proposal isn't wrong, it's literally option (ii) in this doc for the parts where it made sense, and the team explicitly chose caching-with-drift-check over always-fetch for the rest because of round-trip cost, not because duplication was free. If you want to revisit that cost assumption (e.g. "is one extra API call per form load actually a problem?") that's a legitimate thing to push on.

---

[project manager]
You noted: "For the strategy-preset catalogs specifically, the doc says their fate is still undecided"

We want to draft a plan to end the need for parity check. We should decide the above now

[LLM agent]
[Checked how preset catalogs are actually consumed in herobids — found many in-process call sites: API routes (blueprint creation, risk-defaults display, review descriptions), the worker's platform assessor (LLM-driven preset ranking live against market data), the agent-config resolver — hot paths including every tick/review cycle.]

This confirms the facts needed: herobids reads the preset catalogs **in-process, synchronously, from many call sites** — these are hot paths: creating a blueprint, resolving an agent's active preset on every tick, scoring strategies during live assessment review cycles.

Given that, here's the decision:

**Decision: keep preset catalogs as herobids-owned product/platform data, not fetched from traderton at runtime.**

Reasoning:
- Herobids is the actual *consumer and generator* here — the `PlatformAssessor` does LLM-driven ranking over these presets live, inside the worker's hot tick/review loop. A network round-trip to traderton for every preset lookup inside that loop is a real latency/availability risk, not a theoretical one.
- Traderton isn't the semantic owner of this data — it just needs its own copy to execute trades against whatever preset got selected. Herobids is upstream of traderton here, the reverse of the `agentRiskDefaults` case.
- This reframes B2's open question: it's not "who's the authority, fetch from them" — it's "herobids is the authority, traderton holds an execution-time copy." Same shape as `agentRiskDefaults` but with the owner/consumer roles flipped.

So the parity-check elimination path for presets is the **shared-package** option, not fetch-at-runtime: extract `strategy-presets/*.yaml` + the loader into a package herobids publishes (or a shared `packages/domain` config asset) that traderton depends on and pulls at its own build time. Herobids keeps editing one source; traderton consumes a versioned release instead of a hand-mirrored copy.

[Drafted a table mapping each manifest group to owner/fix/whether parity check is removed, concluding: one new internal shared package, both repos depend on it, manifest + checker deleted.]

---

[project manager]
For each we should decide who owns and let that repo host it. What do you think?

[LLM agent]
That's better than one shared package for everything. A single `@herobids/trading-domain` package owned by neither repo in particular becomes its own third codebase to maintain, version, and release — a new thing to coordinate releases around. If each piece is hosted by whichever repo already is its substantive owner, the other repo just takes a normal dependency on that repo's published package — no new neutral repo, no extra release pipeline to invent.

Applying "who actually owns the logic" to each group:

| Manifest group | Real owner | Hosts package | Other repo does |
|---|---|---|---|
| `agent-risk-defaults`, `domain-agent-risk-contract` | traderton (enforcement authority, ADR 010/011) | traderton publishes | herobids depends on it (or fetches live for display, as it partly already does) |
| `strategy-preset-*` YAML, loader | herobids (product/platform data, generates assessments) | herobids publishes | traderton depends on it |
| `watch-types`, `scan-types`, `tick-gates-session-hours` | traderton (worker/execution-loop gating types traderton's engine runs on) | traderton publishes | herobids depends on it |
| `domain-ports-*`, `domain-values-*`, `domain-result`, `domain-pagination`, `domain-trading-*`, `domain-market-assessment`, `domain-models-decision`, `domain-cost-profile` | traderton — AGENTS.md says `packages/domain` is "zero deps," and traderton's package structure roots there | traderton publishes | herobids depends on it |

So in practice this mostly resolves to: traderton hosts almost everything under `packages/domain/*` plus the worker-loop type layer, because that's structurally traderton's own dependency root per its package architecture. Herobids hosts only the strategy-preset catalog, since that's genuinely herobids-generated product data that traderton merely executes against.

One thing to flag before finalizing: publishing means picking a registry (private npm org, GitHub Packages under your org, or similar) and a release cadence for the domain package independent of each app's own release — that's the real new process cost, not the ownership split itself.

---

[project manager]
I am curious why traderton needs to know herobids. I refer to strategy-preset-* YAML loader?

[LLM agent]
Fair challenge. [Grepped traderton for presets-loader / strategy-presets / getPreset / listPresets usage — no matches. Listed traderton/config/strategy-presets — the three YAML files physically exist there. Grepped again for any dynamic/glob-based read — still nothing.]

Confirmed: traderton has the three YAML files sitting in `config/strategy-presets/` but **nothing in traderton's code reads them**. No loader, no reference, nothing. They were copied over during the extraction (verbatim-mirror strategy) and pinned by the drift check purely so they wouldn't silently diverge — but traderton has no actual runtime need for them.

So the honest answer to "why does traderton need to know herobids' presets" is: **it doesn't.** This was B2's "copy everything byte-identical first, sort out real ownership later" tactic, and the preset catalogs are a case where that default was never revisited. They're dead weight in traderton.

That changes the plan. Instead of herobids publishing a package for traderton to depend on, the fix is simpler:

**Delete `config/strategy-presets/*.yaml` from traderton entirely.** No package, no dependency, no parity check needed for this entry — because there's no real coupling to represent. Herobids keeps the files as pure platform/product data, used only by its own API and worker.

Confirmed clean via a second grep pass (no dynamic path scanning) — zero references anywhere in traderton. The YAML files are dead copies from the extraction.

Revised recommendation for that manifest entry: delete the three files from traderton, remove the `strategy-preset-*` entries from `parity-drift-manifest.json`, and treat preset catalogs as herobids-only going forward (no shared package needed at all). That's less work than proposed last turn, and it's the better outcome — fewer things to publish/version, not more.

---

[project manager]
I think we were trying to decide who owns strategy presets.

Then we adopted a direction, captured in these 2:

- traderton - docs/features/2026/10/04/004-preset-assessment-data-only/001-plan.md
- herobids - docs/features/2026/10/04/002-preset-assessment-on-traderton/001-plan.md

Read the above to get more context and help me decide how best to address the strategy-assessment/preset thing

[LLM agent]
[Read both plan documents in full.]

This settles it cleanly. The direction already adopted is: **traderton owns the preset catalog** (`list_strategy_presets` becomes a traderton tool, S2), and herobids explicitly plans to delete its own copy once consumers are repointed (H5, last line: "Herobids' copy of `config/strategy-presets` and the presets-loader is removed only when no consumer is left").

So the ownership direction is the opposite of what was guessed in the "who hosts" table — herobids is giving up ownership, not keeping it. This isn't just a type/config mirror problem, it's part of a bigger move (04-004/002 plans) where the whole preset-assessment feature — catalog, scoring, transitions — is relocating to traderton as a `crypto-trading` skill tool, callable by agents directly.

What this means for the parity-check question specifically:

- **No shared package needed.** Once H5 lands, herobids has zero local copy of the YAML or loader — it calls traderton's `list_strategy_presets` tool at runtime (boundary call), same pattern as `agentRiskDefaults`.
- **The `strategy-preset-*` parity manifest entries become dead** the moment H5's last line executes — delete the files from herobids (not traderton, reversing the earlier guess), delete the manifest entries, done.
- This resolves ADR 011 §3 "market-assessment ownership," per the traderton plan's own header — it's explicitly the mechanism that was supposed to settle this.

Practical answer to "how best to address it": don't design a new package or ownership split — **execute the existing plans**. That retires the parity-check need for this entry as a side effect, for free, because the real fix (move the feature, not just the data) already removes the duplication at its root.

Two things worth flagging before treating this as closed:
1. Status of both plans — they say "planned," not "implemented." Is this still queued, or did a later session already execute some of H1-H6 / S1-S9?
2. The traderton plan's S9 explicitly calls out "coordinated release with herobids" — same release-ordering risk hit earlier in this session with the parity-pin bump.

---

[project manager]
They have not been implemented. I know this for sure.

Remember our high level goal is to "Eliminate the need for the parity check and remove it entirely"

We could write a new plan or series of plans also referencing the 2 I mentioned. Or some other way you deep appropriate.

We have discussed and understand some of the caveats.

What other open questions or caveats exist

[LLM agent]
[Grepped for any existing plan touching watch-types/scan-types/tick-gates/mode-rank/execution-capability/venue-capability/actor-health, and any decision touching domain-ports/domain-values/"zero deps"/packages/domain — no matches found for either.]

No existing plan addresses the type-layer or domain-ports entries — those are genuinely open. Open questions/caveats beyond what's already covered:

**Package/publishing mechanics (not yet decided)**
- Which registry — private npm org, GitHub Packages, or a self-hosted registry? Real setup cost and access-control implications.
- Version strategy — exact pin vs. range. Exact pin is safer but reintroduces a manual "bump the dependency" step, moving the coordination problem rather than removing it, unless automated per release.
- CI implications — does traderton's CI still need a dual-checkout of herobids for anything else (e.g. contract/integration tests) once the parity-specific checkout is no longer needed for drift-checking?

**The domain-ports/domain-values entries (~20 files) have no plan at all**
- No decision brief addresses who owns `packages/domain/src/ports/*`, `values/*`, `result.ts`, `pagination.ts`, etc. The earlier guess ("traderton, because AGENTS.md calls domain zero-deps") was never actually ratified like B1/B2/011 were. Needs its own decision brief before any package extraction happens.
- Some of these (`ports/swap-venue.ts`, `ports/venue.ts`, `ports/mark-source.ts`) could be display-only type references in herobids rather than real logic — worth a usage-depth check the same way the preset YAML turned out to be dead weight in traderton. Some of these 20 files may be dead weight in one direction too.

**watch-types / scan-types / tick-gates-session-hours — no plan, and these are logic, not just types**
- `tick-gates.ts` region is actual session-hour gating *logic*. If both sides execute this independently, a shared package fixes the duplication but doesn't remove the "two processes must agree on gating logic" coupling — just makes it versioned instead of hand-copied. Need to confirm whether herobids' worker still gates anything itself, or just needs the types to parse traderton's output.

**Sequencing/dependency risk across all of this**
- Several items may be blocked on other in-flight work (e.g. Wave E E1/E3 that the preset-assessment plans depend on). A new plan needs explicit prerequisites stated, the same way the 004/002 plans did.
- Release-order coupling (the S9/H1 "ship both together" risk) applies to every entry that moves ownership, not just presets. A multi-entry plan needs one unified release checklist, or the tag/pin ordering bug from earlier this session repeats.

**What happens to `check-parity-drift.mjs` and the manifest file itself during the transition**
- Partial migration state: if some entries move/get deleted while others remain mirrored, the parity check needs to keep running for the remainder. The plan should specify shrinking the manifest incrementally per entry, not an all-or-nothing cutover — unless all decisions are batched first and executed in one coordinated release.

---

[project manager]
What would we use the decision brief for? Just curious. keep response simple

[LLM agent]
Same purpose as B1/B2 in this same project: a short doc that lays out the question, the options, and a recommendation — then you (or whoever reviews) picks one and it becomes "ratified," usually promoted to an ADR.

It's the record of *why* we chose an answer, not just what the answer is. Useful here because this touches ~30 files across two repos with real tradeoffs (registry setup, versioning, release coupling) — worth having one reviewable artifact before writing the actual implementation plan, same as the project already does for every other cross-repo ownership call.

---

[project manager]
where would you save it? one line response

[LLM agent]
`docs/features/2026/10/10/001-eliminate-parity-check/decisions/B-parity-ownership.md` (new dated feature folder, matching the existing convention).

---

[project manager]
Write the brief.

In the same folder, save everything we have said in this session, conversation style.

[LLM agent]
(First attempt interrupted by user.)

---

[project manager]
Not everything in the session, rather starting at: Why do we need the parity drift check? keep response simple

[LLM agent]
Good, that scopes it correctly. Wrote `B-parity-ownership.md` and this transcript file.
