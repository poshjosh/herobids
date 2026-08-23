Now let me examine the current codebase to understand the starting point:Now I have enough context to provide a comprehensive answer. Let me also quickly check the ToolRegistry class to understand `getDefinitions` and `getReadOnlyToolNames`:Now I have a comprehensive picture. Let me also check the ADRs referenced in the roadmap and the best-practices docs:Good — the ADRs exist. Let me quickly check one to understand how formally decided they are:I now have a complete picture. Let me deliver the analysis.

---

## Critical Analysis

### The Documents: What's Good

The 12-document suite in `000-capability-foundations/` is a genuinely strong piece of technical planning. Its strengths:

1. **Strict phase sequencing with gates.** Each phase has explicit acceptance criteria that must be met before the next phase starts. This is the single most important mechanism to prevent shallow features.

2. **Normative design inputs separated from implementation phases.** Documents 008–011 are reference specs (the cross-service contract, registry manifest, activation model, route migration matrix). Documents 002–007 are ordered implementation phases. This separation means the design is stable while the implementation proceeds iteratively.

3. **Anti-scope-creep rules** are explicit (don't promote new capabilities, don't rename persisted fields mid-extraction, don't redesign trading semantics during boundary work).

4. **Extraction patterns are named** — branch-by-abstraction for service extraction, strangler-fig for route migration. These are battle-tested patterns that work.

5. **The ownership manifest is exhaustive.** Every tool has exactly one owner. No ambiguity, no "we'll figure it out later."

### The Documents: What's Weak

1. **The ADRs are "Proposed," not "Accepted."** The roadmap says it "implements the ADR set" — but those ADRs are still status `Proposed`. There's no formal acceptance trail. This means the direction could still be questioned mid-flight.

2. **The referenced ADR path is wrong in the roadmap.** The roadmap links to `../../../../tech/adrs/2026/07/...` but the actual files live at `docs/tech/architecture/adrs/2026/07/...`. Broken internal references are a documentation smell — they suggest the docs were written speculatively and never validated by execution.

3. **No estimation or effort sizing.** The documents are silent on duration, team capacity, or complexity. Phase 2 (foundations) is pure metadata — maybe a week of work. Phase 5 (crypto-trading extraction) is a major service boundary introduction — potentially weeks of integration testing. Treating them as equal "phases" flattens the actual work.

4. **No testing strategy beyond acceptance criteria.** Each phase says "add tests" but doesn't specify where in the test pyramid, what test infrastructure is needed, or how to prevent test rot. For a system that already runs live trading, this matters.

5. **No incremental value delivery.** Phase 2 (foundations) and Phase 3 (resolution/routes) deliver zero behavior change. Phase 4 (worker gating) changes behavior but delivers no user-visible improvement. The first user-visible architectural payoff is Phase 5, which depends on three prior phases. That's a long runway before stakeholders see results.

6. **The `KNOWN_AGENT_TOOL_NAMES` list is already out of sync with the ownership manifest.** The codebase has tools like `change_strategy_preset`, `assess_strategy_preset`, `list_app_docs`, `read_app_docs`, `search_app_docs` that don't appear in document 009. This means the "normative" manifest is stale before implementation starts.

### The Codebase: Current State vs. Target

| Concern | Current state | Target (doc 002) | Gap |
|---------|---------------|-------------------|-----|
| Capability registry | Doesn't exist | `packages/domain/src/capability-registry.ts` | Full implementation needed |
| Tool ownership | Doesn't exist | `packages/domain/src/tool-ownership.ts` | Full implementation needed |
| Capability-tool contract | Doesn't exist | `packages/domain/src/capability-tool-contract.ts` | Full implementation needed |
| Activation model | Implicit (connections) | Explicit `agent_capability_activations` table | Migration + new table |
| Tool visibility | Skill-based only | Ownership + activation + readiness + service health | Major refactor of `runtime-tool-visibility.ts` |
| API routes | `/capabilities/trading` hardcoded | Canonical `/capabilities/crypto-trading` + aliases | Strangler-fig migration |
| Service boundary | Everything in-process | Separate `crypto-trading` and `messaging` services | The big lift |
| ADRs | Proposed | Should be Accepted | Formal sign-off |

The gap is real but manageable because:
- Phase 2 (foundations) is purely additive — new files in `packages/domain/`, no runtime changes
- The tool registry infrastructure (`KNOWN_AGENT_TOOL_NAMES`, `TOOL_CATALOG`, `assertToolCatalogMatchesRegistry`) is solid scaffolding to build on
- The ports-and-adapters pattern in `packages/domain/src/ports/` already exists as a pattern for dependency inversion

---

## Best Path Forward

Your goal is to prevent shallow features. The capability foundations roadmap is the right architectural direction, but its execution model needs one adjustment: **each phase must prove itself through automated verification, not just acceptance criteria on paper.**

### Recommended approach

**1. Accept the ADRs formally (today)**

Move 002, 003, 004 from `Proposed` to `Accepted`. Add a one-line rationale and date. Until these are accepted, the roadmap floats. This is a 10-minute task that eliminates ambiguity.

**2. Fix the manifest drift before starting implementation**

Update document 009 to include the tools that already exist in `KNOWN_AGENT_TOOL_NAMES` but aren't in the manifest (`change_strategy_preset`, `assess_strategy_preset`, `list_app_docs`, `read_app_docs`, `search_app_docs`). The manifest must match reality before it becomes code.

**3. Execute Phase 2 (Foundations) as a single focused sprint**

This is the safest starting point. It's additive, zero-risk (no runtime behavior changes), and creates the compile-time guarantees that make subsequent phases safe:
- `capability-registry.ts` — static metadata
- `tool-ownership.ts` — exhaustive `Record<AgentToolName, ToolOwnershipEntry>` with a test asserting key-set equality to `KNOWN_AGENT_TOOL_NAMES`
- `capability-tool-contract.ts` — Zod schemas for the invocation envelope

The ownership exhaustiveness test becomes a CI gate: if someone adds a tool and forgets to classify it, CI breaks.

**4. Use Kiro's Spec workflow for each subsequent phase**

Each phase (003 → 004 → 005 → 006 → 007) should become a Kiro Spec with its own requirements, design, and tasks. The gated spec workflow directly maps to your requirement of "deliberately, iteratively arrived at." You review acceptance criteria before tasks generate, you review design before implementation starts.

**5. Add an integration test harness before Phase 4 (worker gating)**

Phase 4 is the first behavior change. Before implementing it, you need a test that proves today's behavior (skill-only visibility) and then proves the new behavior (ownership + activation). This means:
- A test fixture with a mock agent that has trading skills but no activation row → currently sees tools, after Phase 4 should not
- A test fixture with activation + skill → should see tools

This is the anti-shallow-feature mechanism. Without it, Phase 4 could "pass acceptance criteria" while breaking live agents.

**6. Phase 5 (crypto-trading extraction) requires a shadow period**

When you stand up the `crypto-trading` service, run it alongside the in-process implementation for a period. Both execute, results are compared, service-backed results are discarded until they match. This is the branch-by-abstraction pattern done right, and it's the only way to prevent a shallow extraction that breaks under real load.

### What NOT to do

- Don't start Phase 3 (routes) before Phase 2 is merged and tested. The roadmap says this, but it bears repeating because route work feels more visible/productive.
- Don't try to implement multiple phases in one PR. Each phase is a logical commit boundary.
- Don't skip the ownership-manifest sync. Stale normative documents become lies that waste implementation time.
- Don't start the extraction (Phase 5) until the gating (Phase 4) has been running in production for at least one release cycle. You need confidence that the visibility model is correct before you move execution across a network boundary.

### Immediate next actions

1. Fix the ADR path references in `001-roadmap.md` (they point to `tech/adrs/` but should point to `tech/architecture/adrs/`)
2. Accept the ADRs (change status from Proposed to Accepted)
3. Sync the ownership manifest with current `KNOWN_AGENT_TOOL_NAMES`
4. Implement Phase 2 as a Kiro Spec (or Quick Spec since the design is already complete in the documents)
5. Add CI check: `KNOWN_AGENT_TOOL_NAMES` key set === ownership manifest key set

Would you like me to start on any of these?