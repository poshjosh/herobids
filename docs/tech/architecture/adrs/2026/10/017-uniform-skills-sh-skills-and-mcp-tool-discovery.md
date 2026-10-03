# ADR 017: Uniform skills.sh skills, with backend tools discovered over MCP

**Date:** 2026-10-03
**Status:** Accepted (operator, 2026-10-03)
**Supersedes:**
- [ADR 015](../09/015-external-backend-skill-registration.md) §4 (signed descriptor) and the descriptor half of §5
- [ADR 016](./016-mcp-as-external-backend-transport.md) Decision 4 (descriptor as sole tool authority)
- Program decisions D16, DT1, DT3 and DT4 (as they relate to the descriptor)
- Step 10 plan §3–§4 (descriptor, signing, rotation)

**Amends:**
- D19: MCP is allowed for discovery; calls stay REST.
- ADR 015 §5: deep integration now keys on operator approval plus MCP discovery.

**Program records:** decisions D21–D29 in [`000-program/DECISIONS.md`](../../../../../features/2026/09/24/000-program/DECISIONS.md). Implementation package: [`004-phase4-skill-replacement-program/`](../../../../../features/2026/10/03/004-phase4-skill-replacement-program/ENTRYPOINT.md).

## Context

The charter objective is that herobids is a generic agent host and Traderton owns trading. Herobids "must not be a trading application" (program `ENTRYPOINT.md` §1).

Phase 3 Step 13 published three Traderton skills to `github.com/traderton/skills`:
- `crypto-trading`
- `crypto-bot-management`
- `crypto-risk-monitoring`

Nothing in herobids depended on them. A review on 2026-10-03 found the following. Evidence is in the pre-decision analysis, whose working directory has been removed; the facts that drive the decision are listed here.

1. **Herobids still authored the trading skills.** `TRADING_SKILL`, `BOT_MANAGEMENT_SKILL` and `RISK_MONITORING_SKILL` in `packages/domain/src/skills.ts` were the runtime source. `inferSkillFromRevisionRow` (`packages/db/src/agent-runtime-descriptor.ts`) returned the in-code definition for system ids and ignored the DB revision.
2. **Herobids generated the "Traderton" descriptor from its own code.** `scripts/ts/generate-dev-descriptor.ts` copied herobids instructions and `TOOL_CATALOG` text, used placeholder input schemas, and signed with a dev key. The descriptor's `instructions` were never used at runtime (`apply-tool-visibility.ts`: "deferred to T4.1", never done).
3. **Three copies of the instruction text existed** (TS, descriptor, `SKILL.md`), and they had already drifted. `crypto-trading` line 56 existed only in `SKILL.md`.
4. **External skills.sh skills were second-class.**
   - They were installed by `npx skills add` into an ephemeral workspace that is wiped on container recreation.
   - Nothing was persisted to the DB, so they never appeared in `resolvedSkills`.
   - Their text reached the model only if the agent read the files itself.
   - Presets could not assign them.
5. **The model saw herobids' own Zod schemas and descriptions,** not the descriptor's (`apps/worker/src/tools/registry.ts` `getDefinitions`). So the descriptor governed only *which* tools were visible.
6. **MCP has no signing** (spec 2026-07-28). Ecosystem hosts don't sign or pin skills: Claude Code, Kiro and `npx skills` users install the latest content, and installed copies stay until updated. The signing machinery was protecting an artifact herobids itself authored and vendored.

## Decision

### 1. Every skills.sh skill works the same way

This covers Traderton's skills and every other skills.sh skill.
- **Install:** `add_skills`, or a preset at agent creation. Fetch the latest `SKILL.md` from the repository's default branch, then store its body and the commit it came from in the DB, attached to the agent.
- **Refresh:** re-fetch the latest when the agent starts. If the fetch fails, use the stored copy and log a warning. Never crash.
- **Visibility:** the commit in use is shown to the user and operator. What a user sees on GitHub or skills.sh is what the agent runs, as of the last refresh.
- **Remove:** delete the assignment.
- **No signing, no digest, no commit pinning.**

### 2. External skills are loaded on demand (progressive disclosure)

This follows the Agent Skills spec and the way Kiro and Claude Code work.
- The system prompt lists each assigned external skill's `name` and `description`, plus how to load it.
- A `read_skill` tool returns the stored body.
- A loaded skill stays in the prompt for the rest of the session. The prompt is rebuilt every tick, so loaded state must be kept by the runtime.
- Built-in `system/*` skills remain injected in full. Changing that is a separate decision.

### 3. Backend-approved skills differ only in what they unlock

What makes a skill "backend-approved" is generic operator config, not code that knows about Traderton. An External Backend Definition lists its approved skill refs, and each ref can declare a required connection family.

For an approved skill, herobids additionally:
- **Exposes tools.** The backend's tools for that skill, as listed by the backend's MCP `tools/list`. Each tool marks the skill ref or refs it belongs to in its `_meta`. The visible set is those names, intersected with what the herobids tool registry can invoke.
- **Requires a connection.** The declared family drives the readiness checks, setup screens, the trading-capability startup guard and tick-work. For Traderton the family is `trading`, kept as an opaque label (§6).

Unapproved skills get no tools, exactly as before.

### 4. Tool discovery over MCP; calls stay REST

- Herobids calls the backend's MCP `tools/list` at agent start and caches the result for the session.
- Trust comes from the operator registration and the existing authenticated (HMAC) channel. That is the same basis an unsigned file would have had.
- If the backend is unreachable at start, the approved skill's tools are hidden and the skill stays loadable as text. No crash.
- Tool *calls* stay on REST in staging and production until the Step 16 differential (D19, amended).
- Traderton builds `tools/list` from its own tool registry, with real schemas. It does not build it from a herobids-generated file.

### 5. Remove the descriptor and signing machinery

The following are deleted in the same change set as the built-in trading skills:
- the descriptor schema and trust pipeline
- `config/external-backends/*`
- `trustedDescriptorSigningKeys` and `descriptorPinning` in config
- `generate-dev-descriptor.ts`
- the descriptor conformance fixtures in both repos
- the signing runbook

CF-9 (real signing key) is closed as not applicable. Keeping any of it would be an unused second system (charter invariant 3).

### 6. `trading` stays an opaque connection-family label for now

It is declared by operator config for the backend's approved refs, not by herobids code. Making connection families backend-defined, and making the product wording generic, are named follow-ups.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Keep built-ins plus a parity test | Herobids remains the author; formalises three copies |
| B: Traderton projects `SKILL.md` text into a signed descriptor | Herobids depends on a copy, not the published file; signing adds little for a vendored artifact |
| C: signed descriptor carries `{commit, path, sha256}` and herobids fetches and verifies | The most rigorous option, but it pins agents to a commit users can't see, and MCP and the ecosystem have no signing. Judged over-engineering for the current threat model (operator, 2026-10-03) |
| D′: operator pins `ref@commit` in config | Hidden version skew between what users see and what agents run; a deploy for every text change |
| Fetch at API startup for approved refs only | Treats backend skills differently from other skills.sh skills for no reason |
| Inject every external skill's full text | Diverges from the spec; more tokens and more third-party text always in context |
| Tool list as a file copied from Traderton into herobids config | Herobids holds a stale-able copy; MCP `tools/list` is the standard mechanism and already half-built |

## Consequences

- **The goal becomes achievable and checkable:** herobids holds no trading skill text and no trading tool list. Exit checks are in the Phase 4 package `INVARIANTS.md`.
- **A push to a skills repo reaches agents on their next start.** That is the skill owner's responsibility, as in the wider ecosystem. Rollback is a revert in the skill's repo.
- **Instruction text can name a tool the backend no longer lists.** The call is then refused (not in the allowed set). That is a visible error, not a safety failure: enforcement lives in Traderton's risk gate.
- **Trading guidance is loaded on demand.** An agent could act before loading a skill. This is accepted, and recorded as an intentional divergence; enforcement is server-side.
- **A Traderton tool `_meta` key carries skill refs.** It must use a neutral namespace, not a herobids-specific one, to respect Traderton's consumer-contract non-goal ("no consumer-specific skill semantics").
- **Traderton's MCP route must be enabled in staging and production** for discovery. It is currently off by default.
- **Still herobids-side after Phase 4** (named follow-ups, not done):
  - the model sees herobids' local tool descriptions and Zod schemas
  - the trading tool forwarders and broker paths
  - `TOOL_CATALOG` trading entries
  - the `trading` product surface and wording
  - the onboarding chat trading prompt
  - single-backend config forwarding (CF-13)
- **Legal:** herobids storing and showing Traderton-authored skill text is accepted (operator, 2026-10-03). Payment-provider review of the remaining `trading` surfaces is still open (CF-11).
