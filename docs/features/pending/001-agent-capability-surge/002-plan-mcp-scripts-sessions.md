# Phase 2: MCP Client + Script Execution + Session Persistence

**Status:** Pending (open questions must be resolved before implementation)
**Estimated effort:** ~2-3 weeks
**Dependencies:** Phase 1 (browser pool must be operational for session persistence to be meaningful)

## Summary

Add three capabilities that complete the agent capability surface:

1. **MCP client** — connect agents to Model Context Protocol servers, unlocking thousands of external integrations (GitHub, Slack, Google Drive, Notion, databases, calendars, email providers, payment APIs).
2. **Script execution convention** — allow agents to run scripts shipped in external skill `scripts/` directories, closing the gap with Claude Code / Codex agents that assume `Bash(*)` access.
3. **Session persistence** — browser state (cookies, localStorage) and working context that survives across agent ticks, enabling multi-session workflows (daily price monitoring, authenticated recurring tasks).

## Goals

- Agents can connect to MCP servers and use their tools.
- Agents can execute scripts bundled with installed external skills.
- Agents can save and restore browser session state across ticks.
- All capabilities are operator-configurable and metered per-agent.

## Non-Goals

- Building custom MCP servers (this plan adds the client; servers are external).
- Full shell access / unrestricted `Bash(*)` (scripts run sandboxed, scoped to skill directories).
- Automatic session persistence (agents explicitly save/restore; no magic).

---

## Open Questions

The following must be resolved before implementation begins.

### MCP Client

1. **MCP server lifecycle: who manages the MCP server process?**
   - Option A: The agent container runs MCP servers as child processes (like Claude Code does). Higher memory per container.
   - Option B: MCP servers run as shared Nomad services (like the browser pool). Lower per-agent cost, but adds routing complexity.
   - Option C: Agents connect to remote MCP servers over HTTP (Streamable HTTP transport). No local process, but requires the MCP server to be hosted externally.
   - **Recommendation direction:** Option C for cloud-hosted MCP servers (GitHub, Slack, etc.), Option B for self-hosted MCP servers that multiple agents share (e.g., a database MCP server). Option A only if the server is lightweight and agent-specific.

2. **MCP server allowlist: which MCP servers can an agent connect to?**
   - Operator-configured allowlist in `config/default.yaml`?
   - Per-agent configuration via the API?
   - Skill-declared dependencies (a skill's SKILL.md declares which MCP servers it needs)?
   - Security implications of letting agents connect to arbitrary MCP endpoints.

3. **Authentication: how do agents authenticate to MCP servers?**
   - MCP spec supports OAuth 2.1 + PKCE. Who performs the OAuth flow — the user, the operator, or the agent?
   - Credential storage: reuse the existing `connections` table, or a new `mcp_credentials` table?
   - Per-agent vs. per-user credentials.

4. **Tool namespace conflicts: what happens when an MCP server exposes a tool with the same name as a platform tool?**
   - Namespace MCP tools (e.g., `mcp.github.create_issue` vs. platform `create_task`)?
   - Priority rules (platform tools always win)?

5. **Cost model: how are MCP tool calls billed?**
   - Per-call? Per-server-connection-minute? Flat per-agent?

### Script Execution

6. **Sandbox scope: what can skill scripts access?**
   - Read-only access to the skill directory + read-write to the agent workspace?
   - Network access (some scripts need to call APIs)?
   - Should scripts reuse the existing `sandbox-exec.sh` network namespace?

7. **Language support: which script runtimes are guaranteed available?**
   - Python 3 and Node.js are already in the agent container.
   - Bash is available.
   - Should we guarantee any others (Ruby, Go binaries)?

8. **Timeout and resource limits: per-script or per-tick?**
   - If a skill ships 5 scripts and the agent runs all 5, is the timeout per-script or cumulative?

### Session Persistence

9. **Storage location: where does browser state live between ticks?**
   - Agent workspace (`/workspace/browser-state.json`) — simple, already persists.
   - Redis (faster, but adds key management) — more complex.
   - Agent memory via `set_memory` / `get_memory` — reuses existing infrastructure but cookies can be large.

10. **State size limits: how much browser state is too much?**
    - Cookies + localStorage for a typical authenticated session: 10-50KB.
    - If an agent accumulates state from many sites: could grow to hundreds of KB.
    - Should there be a per-agent cap?

11. **State expiry: when does saved browser state become stale?**
    - Session tokens expire. Saved cookies may be invalid by the next tick.
    - Should the tool validate state on restore and report staleness?

---

## Preliminary Design (subject to change after open questions are resolved)

### MCP Client

A new `McpClientPort` in `packages/domain/src/ports/` that can:
- Connect to an MCP server (stdio subprocess or HTTP transport).
- Discover available tools from the server.
- Call tools and return results.
- Manage the connection lifecycle.

Agent-side: a meta-tool `use_mcp` or dynamic tool registration where MCP server tools appear in the agent's tool set when the server is connected.

Skill integration: a new `system/mcp` skill that provides `connect_mcp`, `list_mcp_tools`, `call_mcp_tool`, `disconnect_mcp`. Or: skills declare MCP dependencies and the runtime auto-connects on skill activation.

### Script Execution

Extend the existing `execute_code` tool (or add a new `run_skill_script` tool) that:
- Accepts a skill name + script path (relative to the skill directory).
- Validates the script exists in the installed skill's `scripts/` directory.
- Runs it through `sandbox-exec.sh` with the skill directory mounted read-only and the workspace mounted read-write.
- Returns stdout/stderr with truncation.

The tool is gated behind the `system/programming` skill (already includes `execute_code`).

### Session Persistence

Two new tool actions added to `browse_interactive` (from Phase 1):
- `save_state`: Extracts cookies + localStorage from the current browser session and returns them as a JSON string. The agent stores this via `set_memory` or writes it to the workspace.
- `restore_state`: Accepts a previously saved state JSON and injects cookies + localStorage into a new browser session before navigation.

This keeps session persistence explicit and agent-controlled — no magic persistence layer, no hidden state. The agent decides what to save, when to save it, and when to restore it.

### Browser Security Hardening (carried from Phase 1)

**Redirect SSRF in `browse_interactive`:** CDP's `Page.navigate` follows server-side redirects internally in Chrome without agent-side re-validation. A malicious page could redirect to `http://169.254.169.254/latest/meta-data/` or other internal endpoints. Phase 1's `make_http_request` tool already handles this (manual redirect following with per-hop SSRF re-validation), but the browser tool cannot use the same approach — it requires intercepting network requests via the CDP `Fetch.requestPaused` event.

**Fix approach:**
1. Enable CDP `Fetch` domain after `Page.enable`.
2. Subscribe to `Fetch.requestPaused` events.
3. For each paused request, extract the URL, validate protocol + hostname against the SSRF guard (`isHostPrivate` + deny-list).
4. Call `Fetch.continueRequest` for safe URLs, `Fetch.failRequest` for blocked ones.
5. Return a clear error to the agent when a navigation is blocked by SSRF.

**Estimated effort:** ~1 day (CDP event handling + tests).

---

## Risks (preliminary)

| Risk | Notes |
|---|---|
| MCP server security | Arbitrary MCP servers could exfiltrate agent context. Operator allowlist is essential. |
| Script execution escape | Even with sandbox-exec.sh, scripts could consume excessive CPU/memory. Need per-script resource limits. |
| Session state leaking sensitive data | Saved cookies may contain auth tokens. Must not be logged or exposed in tool results beyond the agent's own context. |
| Browser redirect SSRF | `browse_interactive` follows redirects inside Chrome without SSRF re-validation. Fix planned above (CDP `Fetch.requestPaused` interception). |
| Scope creep | Each of these three capabilities could be a standalone feature. Strict scoping needed. |

---

## Acceptance Criteria (preliminary)

- [ ] Agent can connect to at least one MCP server and call its tools.
- [ ] Agent can run a script from an installed external skill's `scripts/` directory.
- [ ] Agent can save browser state at tick end and restore it at next tick start.
- [ ] All three capabilities are feature-flagged and off by default.
- [ ] All three capabilities are metered per-agent.
- [ ] MCP server connections respect an operator-configured allowlist.
- [ ] Script execution uses the existing sandbox with appropriate resource limits.
- [ ] `pnpm lint` and `pnpm test` pass.
