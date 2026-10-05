# Bug 005 — Staging Traderton has no MCP route, so agents get no trading tools

- **Status:** FIXED (code; needs a Traderton deploy) — decision: remove the flag. Traderton now always mounts `/internal/v1/mcp`; `BOUNDARY_MCP_ENABLED` is removed from code, both `.env` example twins and herobids' `docker/traderton-xstack.override.yml`. A leftover value only triggers a startup warning. Verify after deploy: `GET https://api.staging.traderton.com/internal/v1/mcp` → 405.
- **Severity:** High
- **Date:** 2026-10-05
- **Summary:** Phase 4 made MCP `tools/list` the only source of backend-skill tool visibility, but staging Traderton runs with `BOUNDARY_MCP_ENABLED` unset (off), so every agent with a `traderton/skills/*` skill starts with those skills' tools hidden for the whole session.

## Evidence (staging, agent `tintel` b5b955f8…, session 3116fff5…)

- Agent log at start: `Backend tool visibility: backend unreachable — approved skill tools hidden this session`.
- From the herobids host: `GET` and `POST https://api.staging.traderton.com/internal/v1/mcp` → `404 Route … not found` (a mounted route returns 405 for GET).
- The LLM only called `read_skill`, `get_schema`, `list_memory_keys`, `send_message`; no `get_account_summary` call or rejection was logged. Its "capital/P&L unavailable" message came from the portfolio context block (see 006).
- Ruled out: agent job env has `DATABASE_URL`; tintel has an active grant with `resolved_venue_account_id = 621f8139…`.

## Root Cause

- Phase 3 added MCP as an optional, off-by-default extra transport (`BOUNDARY_MCP_ENABLED=false`, D19: REST only in staging/prod). Tool visibility then came from a signed descriptor (D16).
- Phase 4 / ADR 017 removed the descriptor (D26) and amended D19 to allow MCP for discovery, but the flag default, the staging env, and docs (`docs/tech/architecture/external-backend.md`, `docs/best-practices/configuration.md`, the `docker/traderton-xstack.override.yml` "DEV/TEST ONLY" comment) were not updated.
- Local works only because the xstack override sets `BOUNDARY_MCP_ENABLED: "true"`. The code path is identical in both environments.

## Options (decide once, applies to local and staging)

1. Remove the flag or default it on in Traderton, and align the docs with ADR 017.
2. Keep the flag but give herobids a non-MCP discovery source (e.g. REST tool listing, or `required_tools` at cataloguing).

Also: discovery currently runs once at start (and on skills hot-reload) with no retry, so a transient failure blinds a session.

## Partial mitigation already in place

The unreachable reason is now logged (`Backend tool visibility: MCP tools/list discovery failed`, with `backendId`, `baseUrl`, `mcpPath`, `reason`); previously it was discarded.
