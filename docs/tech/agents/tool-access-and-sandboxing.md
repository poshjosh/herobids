# Tool Access And Sandboxing

This document is the canonical reference for tool policy, egress policy, and sandbox requirements for agent runtimes.

It complements [Agent Runtime Boundary And Message Contract](./runtime-boundary-and-message-contract.md).

## Goals

Tooling must let the agent gather information and produce explainable intent without collapsing the trust boundary.

Herobids should empower agents in a developer-like way for safe read and research tasks, while still applying tighter isolation, audit, and revocation than a human developer would require because agent actions are autonomous and high-frequency.

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