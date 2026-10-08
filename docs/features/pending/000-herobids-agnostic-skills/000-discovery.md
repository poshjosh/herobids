## Prompt 1

ead this https://github.com/traderton/skills/blob/main/skills/crypto-trading/SKILL.md

The skill expects the agent to be in herobids. We want to skill to be platform agnostic as much as possible. We want it to work for any LLM agent.

What does herobids to to make the skill work as it is now?

For example if herobids connects to traderton, loads the tool list etc, we should be able to add linux/mac (and if need windows compatible) bash scripts for an agent to connect, load etc

What do you think?

Don't start any implementation, only analyse the docs, code and advise

## Response 1

The skill text is already close to portable. The blocker is everything around it. Herobids does all the connecting, identity, account selection and safety work, and Traderton only accepts one platform-level HMAC credential. Handing that credential to an agent would let it act as any user. Bash scripts are a reasonable transport, but Traderton needs per-principal credentials first.

## What herobids does today

**1. Installs and loads the skill**
- It runs `npx skills add traderton/skills@crypto-trading` in the agent's workspace (`apps/worker/src/tools/skills.ts`). This always pulls the latest unpinned version from GitHub.
- The prompt shows only the skill's name and description at first. The agent loads the full body by calling `read_skill` (`runtime-composition.ts` `renderSkillPromptBlock`).

**2. Decides which tools the agent sees**
- It sends an HMAC-signed MCP `tools/list` to Traderton's `/internal/v1/mcp`.
- It keeps the tools tagged `_meta['io.agentskills/skillRefs']` for that skill, then intersects them with herobids' own tool registry (`backend-tool-visibility.ts`).
- The schemas the model actually sees are herobids' local Zod copies, not Traderton's.
- The signed-descriptor design is gone (ADR 017). `.github/skills/external-backend-genericization` §6 still describes it, so that section is out of date.

**3. Signs every call**
- Calls go to REST `POST /internal/v1/tools:invoke`.
- Each call carries the envelope (`requestId`, `idempotencyKey`, `correlationId`, `deadlineAt`, `caller`, `subject`, `toolName`, `payload`) and the six `x-traderton-*` headers.
- The signature is HMAC-SHA256 over `METHOD\nPATH\nTS\nsha256(body)`.
- Writes retry once on transport errors and poll while a call is `in_progress`.

**4. Asserts who the agent is**
- `subject = {ownerId: agent.userId, actor: {type:'agent', id: agentId}}`.
- After the LLM call, herobids adds `venueAccountId` to the payload, resolved via `agent_connections → connections.resolvedVenueAccountId`.
- Traderton trusts all of this as sent. It checks only that the fields are non-empty.

**5. Adds behaviour on top of some tools**

| Tool | What herobids adds |
|---|---|
| `submit_decision` | `dryRun` answered locally, approval mode (Telegram `/yes`), paused/stale-session checks, a circuit breaker, `decisionId` as the idempotency key |
| `resolve_watch` | Runs locally on top of `list_watches`. Traderton also has its own |
| `get_price` | Validates the symbol for the chain before calling |
| `assess_strategy_preset`, `change_strategy_preset` | Herobids-only. Traderton doesn't implement or list them (`skill-tool-map.ts:24-27`) |
| The other 14 tools | Pass-through |

**6. Runs the agent**
- A tick loop with gates.
- Watch wakes: the worker polls `check_watches` and wakes the agent when a watch triggers.
- A trading context block in the prompt (venues, readiness).
- Market-intel pre-fetches.

**7. Onboarding**
- Herobids owns connections and grants, plan entitlement and live-trading gating.
- On the Traderton side, onboarding is just tools: `provision_venue_account`, then `set_agent_trading_profile`. `get_risk_limits` fails until a profile exists.

## What blocks a standalone agent

- **One consumer, trusted subject.** `bin.ts:81-93` builds exactly one consumer from `BOUNDARY_CONSUMER_ID/KEY_ID/SIGNING_SECRET`. Anyone holding that secret can set any `ownerId`. A bash script holding it is a key to every account.
- **Scoping holes that matter once callers aren't herobids:**
  - Watches are stored in Redis as `agent:watches:{actorId}`, with no owner in the key. Two users whose agents are both called "claude" would collide.
  - `GET /invocations/:requestId` isn't scoped to the caller.
  - `scan_consumer_notifications` and `scan_trade_events` read across owners and are only kept out of `tools/list`. They can still be called.
- **The skill names tools that don't exist outside herobids** (the two preset tools).
- **The skill is silent on what to do first.** It doesn't say to provision an account, set a profile, start in paper mode (`defaultOwnerMode: paper`), or call `check_watches` yourself because there's no push.

## What I'd recommend

**1. Traderton: add per-principal API keys.** This is the prerequisite. A key is bound to an `ownerId`, and optionally to a venue account and a mode ceiling like paper-only. The server derives `subject` from the key and fills in the envelope fields itself: request IDs, deadlines, and an idempotency key only when one isn't supplied. Put this on a new public surface (e.g. `/v1/mcp` and `/v1/tools/{name}`) and leave the frozen HMAC path for herobids untouched. Fix the three scoping holes in the same change.

**2. Make remote MCP the main integration.** It's the closest thing to "works for any LLM agent". Claude Code, Cursor, Codex, VS Code, Gemini CLI and the ChatGPT/Claude.ai connectors all accept a remote Streamable HTTP MCP server with a bearer header or OAuth. Traderton already has `tools/list`, `tools/call` and the skill-ref `_meta`; it mainly needs the new auth. The SKILL.md can then stay a pure instruction file, which is the right shape.

**3. Add scripts as the fallback for shell-only agents.**
- With API keys, the scripts are just `curl` plus a bearer header. A `.sh` for Linux/macOS and a `.ps1` for Windows are trivial; Windows 10+ ships `curl.exe`.
- If the scripts had to keep HMAC, I'd ship a small Node CLI (`npx @traderton/cli call <tool> '<json>'`) built on the existing `packages/boundary/src/dev/sign.ts` instead of bash. Bash would need openssl, jq, careful JSON quoting and clock handling on three operating systems.
- Suggested commands: `setup` (provision an account and set a profile), `list-tools`, `call <tool> <json> [--idempotency-key]`, and an optional `watch-loop`. The loop polls `check_watches` and runs a command when a watch triggers, e.g. `claude -p` or `codex exec`. That gives session-based agents a wake mechanism.

**4. Restructure the skills repo.**
- Keep `crypto-trading` as tool-level instructions.
- Put connection material in a separate skill (e.g. `traderton-connect`) holding `scripts/` and a `references/setup.md`. A `scripts/` folder inside `crypto-trading` would also work.
- Don't add `allowed-tools: Bash` to `crypto-trading`. Herobids automatically grants `system/programming` when that field mentions Bash (`skills.ts`), which would quietly widen agent permissions.
- Drop the preset tools or mark them as host-dependent, and add short "First run" and "No push, poll watches" sections.

**5. Decide where the herobids-only safety features live.** A standalone agent gets no approval gate, circuit breaker, entitlement check or live-trading gate. You can move the ones that matter into Traderton (at least a server-side live gate and a paper ceiling per key), or state plainly that the host is responsible for them.

One operational caution: herobids installs the skill live and unpinned, so any push to `traderton/skills` changes the instructions running herobids agents see straight away. Draft the restructure on a branch, and consider pinning a ref in herobids first.

I didn't confirm three things: whether paper mode works without real venue credentials (generate mode looks like it would), what the herobids preset handlers do internally, and whether herobids' `promptGuidance` text reaches the model.