# Tool Access And Sandboxing

This document is the canonical reference for tool policy, egress policy, and sandbox requirements for agent runtimes.

It complements [Agent Runtime Boundary And Message Contract](./runtime-boundary-and-message-contract.md).

## Goals

Tooling must let the agent gather information and produce explainable intent without collapsing the trust boundary.

OpenAIdom should empower agents in a developer-like way for safe read and research tasks, while still applying tighter isolation, audit, and revocation than a human developer would require because agent actions are autonomous and high-frequency.

The platform therefore optimizes for:

1. least privilege
2. centrally auditable policy
3. fail-closed execution when the model requests disallowed actions
4. separation between reasoning capability and market execution authority

## Default Policy

V1 uses a tool-mediated interface over a sandboxed runtime with open internet egress.

That means:

- the agent runtime does not receive general operator credentials
- the agent runtime does not call venue trading APIs directly
- the agent may reach the public internet from inside the sandbox without predefined destination allowlists
- privileged, secret-backed, internal, and market-affecting operations stay brokered or otherwise platform-controlled

This keeps the runtime flexible enough for genuine agent behavior while still preserving the real safety boundary around secrets, internal systems, and execution authority.

## Capability Tiers

### Brokered required

These capabilities must stay behind platform mediation:

- decision submission and any other market-affecting action
- secret-backed operations
- internal app data reads governed by tenancy or auth rules
- artifact persistence and retention-controlled storage operations
- writes to any durable internal system

### Direct (sandbox-wrapped)

These capabilities execute directly inside the agent container, wrapped by `sandbox-exec.sh` for network isolation:

- `execute_code` — structured JS/Python execution (all permission levels)
- `execute_shell` — arbitrary shell commands (`standard` and `full` permission levels only)
- `browse_interactive` — browser automation via the shared Browserless pool
- `make_http_request` — structured HTTP client with SSRF protection

### Open internet read and research access

These capabilities may execute directly from the sandbox runtime:

- public web research
- public market or documentation reads
- code-driven fetches and analysis that do not require platform secrets

This access is governed by runtime controls rather than destination allowlists:

- auditable
- rate-limited
- bounded by time, size, concurrency, and compute budgets
- revocable through runtime disablement or policy changes

### Never direct

These capabilities must never be direct from the agent runtime:

- venue trading APIs
- mutable database access
- raw operator config access
- decrypted venue secret access
- worker or host process control

## Artifact Storage And Retention

Large agent artifacts should be stored out of band with DB metadata kept in path.

Recommended v1 shape:

- store artifact metadata in Postgres
- store large artifact bodies in object storage
- keep retention class and expiry policy on the metadata record
- fetch metadata first, then fetch the body on demand from the UI or API

This keeps audit, retention, and cost controls explicit without putting large blobs into the operational database.

## Enforcement Model

Policy must be enforced server-side, not only in prompts.

Required properties:

- the runtime receives an explicit capability grant for brokered tools and risky local capabilities such as code execution
- the platform rejects calls outside that grant
- disallowed or unknown calls fail closed and are audit-visible
- incomplete or malformed model responses do not execute speculatively
- outputs are bounded in size and lifetime so context cannot grow without bound
- audit records cover both brokered calls and direct sandbox egress activity

## Network Policy

The baseline network stance is open internet egress from the sandbox, but no direct access to privileged internal systems or secret-bearing services.

The runtime may reach:

- the message transport or broker endpoints it needs to function
- the public internet from inside the sandbox runtime

Open egress still requires hard runtime controls:

- request budget or rate limits
- concurrency limits
- timeout limits
- response size limits
- download and storage limits
- audit logging expectations

These controls must be configuration-driven, with conservative defaults and a runtime kill switch.

Internal systems, mutable stores, and secret-bearing services remain blocked unless the access path is explicitly brokered.

Targeted exceptions for operator-configured infrastructure (e.g. the Browserless browser pool) are managed via `SANDBOX_ALLOWED_HOSTS`. This inserts specific `iptables ACCEPT` rules before the RFC 1918 reject block, allowing the agent to reach only the listed IPs while keeping all other internal addresses blocked. See the `SANDBOX_ALLOWED_HOSTS` section above.

## Filesystem And Process Policy

Agent runtimes must run with:

- no host bind mounts except explicit scratch storage
- writable storage limited to temporary working space
- bounded process count
- bounded wall-clock execution per task or tool run
- deterministic cleanup on timeout or policy violation

Any code-execution feature must run without inheriting worker memory, host privileges, or secret-bearing mounts.

Code execution should ship in the first agent release. In v1 it runs inside the agent container as a restricted local subprocess or sandbox, not as unconstrained execution inside the main agent process and not in a second dedicated code-execution container.

## Secret Handling

- raw venue credentials stay outside the agent runtime
- operator config remains outside the agent runtime
- if a capability requires secret-backed access, the broker performs the secret-bearing operation and returns only the bounded result
- logs and artifacts must avoid leaking secret values or large raw payloads by default

## Audit Requirements

The platform should be able to answer:

- which capability the agent used
- whether the access path was brokered or direct allowlisted
- what high-level input was sent
- what bounded summary came back
- whether the capability influenced a later decision

This does not require storing every raw response forever. It does require enough provenance to support the activity feed, decision detail, and operator diagnostics.

## Deferred Questions

These remain implementation choices under the policy above:

- how any readonly internal credential surfaces, if they ever exist, are rotated and revoked

Those decisions must not weaken the baseline guarantees in this document.


## Permission Levels

Agent containers support three permission levels that control tool visibility and execution privileges. All three levels run inside the same isolated Docker container — the container is the security boundary. Permission levels control agent behavior complexity, not host safety.

| Level | Default | Tool access | Execution user |
|---|---|---|---|
| `restricted` | No | `execute_code` only (JS/Python via sandbox) | Container default |
| `standard` | **Yes** | `execute_code` + `execute_shell` | Non-root `agent` user |
| `full` | No | `execute_code` + `execute_shell` | Root (via passwordless `sudo`) |

All three levels use `sandbox-exec.sh` for network isolation during tool execution. The sandbox blocks RFC 1918 addresses and cloud metadata endpoints regardless of permission level. This protects platform services (Postgres, Redis, docker-proxy) that share the Docker network.

The user selects a permission level when creating or editing an agent. The platform gates tool visibility at startup via `permanentlyExcludedTools` in the `RuntimeToolVisibilityController` — `restricted` agents never see `execute_shell`.

See [Permission Levels Reference](./tools/permission-levels.md) for the full capability matrix and implementation details.

## `execute_shell` Tool

`execute_shell` is a direct-tier tool that runs arbitrary shell commands inside the agent container. It is available at `standard` and `full` permission levels; `restricted` agents cannot see or call it.

Execution flow:
1. Capability policy check (rate limit, concurrency).
2. Working directory resolution — `standard` validates paths stay inside the workspace; `full` allows the entire container filesystem.
3. Command wrapping with `sandbox-exec.sh` for network isolation (all levels).
4. User privilege selection: `standard` runs as the non-root `agent` user via `sudo -u agent`; `full` runs as root.
5. Output capture with configurable timeout and size limits.
6. Audit logging via `capabilityEngine.recordEnd()`.

The tool returns `{ stdout, stderr, exitCode, durationMs }`. It uses the same runtime policy and capability grants as `execute_code`.

## `SANDBOX_ALLOWED_HOSTS`

The sandbox (`sandbox-exec.sh`) blocks all RFC 1918 addresses by default. Some operator-configured internal services — notably the Browserless browser pool — need to be reachable from inside the sandbox. The `SANDBOX_ALLOWED_HOSTS` environment variable provides a targeted allowlist.

Format: comma-separated list of IPs or CIDRs (e.g. `172.18.0.5` or `172.18.0.5,10.0.1.100`).

The sandbox script inserts `iptables -A OUTPUT -d <host> -j ACCEPT` rules **before** the RFC 1918 reject rules. This means:
- Listed hosts are reachable even though they fall in RFC 1918 ranges.
- All other RFC 1918 and link-local addresses remain blocked.
- Input validation skips entries containing shell metacharacters.

The worker resolves the `browserPool.url` hostname to an IP at container startup and passes it via `SANDBOX_ALLOWED_HOSTS`. If `browserPool.enabled` is false, no allowlist is injected and the sandbox behaves identically to previous versions.

This mechanism is intentionally narrow: it allows specific infrastructure endpoints, not broad network access. The agent still cannot reach Postgres, Redis, or other platform services unless explicitly allowlisted by the operator.
