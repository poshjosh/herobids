# Agent Capability Surge

**Goal:** Make non-trading (personal assistant, custom, research) agents fully capable by closing five capability gaps that prevent them from using the external skill ecosystem (skills.sh), calling APIs, automating browsers, and maintaining state across ticks.

## Context

The platform's core strengths are crypto trading and strategy execution. But agents assigned non-trading goals (flight search, shopping comparison, research, scheduling) consistently stall because they lack the tools that the external skill ecosystem assumes. The most common failure pattern: agent installs an external skill, reads its instructions, then can't execute them because the instructions reference tools the agent doesn't have (`agent-browser`, `curl`, `Bash(*)`).

The skills.sh ecosystem (1M+ installs, 10,000+ skills, 70+ compatible agents) and MCP protocol (10,000+ tool servers, 97M+ monthly SDK downloads) have converged on a standard set of agent capabilities. This feature closes the gap in two phases.

## Capabilities

| # | Capability | What it unlocks | Phase |
|---|---|---|---|
| 1 | Browser automation (cloud pool) | Interactive web tasks, skills.sh travel/shopping/monitoring skills | 1 |
| 2 | HTTP client tool | Structured API calls (flight APIs, weather, translation, payments) | 1 |
| 3 | MCP client | Thousands of integrations (GitHub, Slack, Google Drive, databases, calendars) | 2 |
| 4 | Script execution convention | Running scripts shipped in external skill `scripts/` directories | 2 |
| 5 | Session persistence | Browser state, auth tokens, and working context surviving across ticks | 2 |

## Plans

- **[001-plan-browser-and-http.md](001-plan-browser-and-http.md)** — Phase 1: Browser pool service + HTTP client tool. Resolved, ready to implement.
- **[002-plan-mcp-scripts-sessions.md](002-plan-mcp-scripts-sessions.md)** — Phase 2: MCP client + script execution + session persistence. Open questions noted, to be resolved before implementation.

## Design Decisions (cross-cutting)

1. **Agent containers stay under 1GB.** No local Chrome. Browser automation uses a shared cloud pool service.
2. **New tools follow existing patterns.** Each capability is exposed as agent tools registered in the domain tool catalog, gated by skills (e.g., `system/web-access` gains `browse_interactive`, `system/http` provides `http_request`).
3. **Operator config controls resource limits.** Browser session quotas, MCP server allowlists, and API rate limits are operator-configured, not hard-coded.
4. **Per-agent metering.** Browser minutes and API calls are tracked against the agent's cost profile, same as LLM tokens.
