# External Backend Execution Design

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Applies to:** every external backend; the first expected `backendId` is `trading`

## Purpose

Define the single production boundary through which platform-core code invokes
an external-backend-owned tool. This document is normative for repo-local and
remote external backends. A backend is not considered integrated until it
implements this contract and the operational requirements below.

## Scope

This doc includes:

1. the shared invocation transport, endpoint shape, and contract envelope for
   external-backend-owned tool calls
2. authentication, authorization, deadline, retry, idempotency, and result
   mapping rules for that boundary
3. the operator-config, deployment, and health semantics required for a
   repo-local or remote external backend

This doc does not include:

1. native-capability internal module design
2. public control-plane route migration for native-capability APIs
3. business logic inside any one external backend

## Non-Goals

1. Do not use Redis or in-process imports as the production execution
   transport.
2. Do not define domain-specific business payload semantics beyond the shared
   invocation envelope.
3. Do not treat direct-import fallback as an acceptable integration state.
4. Do not block the first backend on skill or MCP packaging.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) keeps this doc as an
   active supporting reference rather than the first-slice gate.
2. [005-trading-capability-extraction.md](./005-trading-capability-extraction.md)
   uses this doc as a binding normative input for the first external-backend
   extraction.
3. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   fixes the external-boundary model this contract serves.
4. [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
   and [010-capability-activation-model.md](./010-capability-activation-model.md)
   provide complementary ownership and visibility-state inputs for the same
   boundary.

## Fixed Decisions

1. Tool invocation uses synchronous HTTPS JSON over the private service
   network.
2. Platform core is the caller and selects the target backend from the
   external-backend registry.
3. Every external backend exposes the same versioned invocation and status
   endpoints.
4. The invocation endpoint is the only execution entry point.
5. Backend health, entitlement state, and backend-declared readiness remain
   separate concerns.
6. An external backend that is not ready removes its tools from new runtime
   visibility snapshots and does not fall back to direct imports.
7. Direct API integration is acceptable before skill or MCP packaging.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. internal package boundaries for the invocation client and per-backend
   adapters
2. exact storage layout for persisted invocation records
3. backend-local retry helpers that still satisfy the shared deadline and
   idempotency rules
4. test placement across worker, backend, and contract suites

## Acceptance Criteria

This supporting reference is ready for later extraction work only when:

1. the shared invocation contract, versioning, and endpoint rules are explicit
2. authentication, authorization, deadline, and idempotency behavior are
   explicit and mutually consistent
3. configuration, deployment, and readiness rules forbid a direct-import
   fallback after integration
4. the verification list is specific enough to validate repo-local and remote
   external-backend integration against one shared contract

## Validation

1. validate the checks listed under `## Required Verification`
2. confirm [005-trading-capability-extraction.md](./005-trading-capability-extraction.md)
   references this doc without contradicting its transport or readiness rules
3. keep `pnpm lint` as the final repo-wide validation gate for any touched code

## Decisions

1. Tool invocation uses synchronous HTTPS JSON over the private service
   network. It does not use Redis, a worker-local import, or an asynchronous
   command topic as its execution transport.
2. The caller is platform core, currently hosted by `apps/worker` and, when
   needed for control-plane operations, `apps/api`. The caller selects the
   target backend from the external-backend registry and invokes it through its
   configured private base URL.
3. Each external backend exposes the same versioned endpoints:

   ```text
   POST /internal/v1/external-tools:invoke
   GET  /internal/v1/external-tools/invocations/:requestId
   GET  /health/live
   GET  /health/ready
   ```

4. The invocation endpoint is the only execution entry point. The status
   endpoint is for resolving an ambiguous caller timeout with the original
   `requestId`; it must never cause execution.
5. External backends publish completion audit events only after their durable
   invocation record reaches a terminal state:

   ```text
   external_backend.<backendId>.tool_invocation.completed.v1
   ```

   These events are observational. They never initiate or retry a tool call.

## Packages, Applications, And Ownership

| Area | Location | Responsibility |
| --- | --- | --- |
| Shared DTOs and Zod schemas | `packages/domain/src/external-backend-contract.ts` | Versioned envelope, terminal result, error codes, and validation schemas. |
| Platform invocation client | `apps/worker/src/external-backends/` and `apps/api/src/external-backends/` if needed | Target selection, signing, deadline enforcement, retry policy, and mapping to `ToolResult`. |
| Repo-local external backend runtime | `externals/<backendId>/` | Backend-owned tools, backend readiness, invocation store, and downstream side effects. |
| Registry and ownership manifest | `packages/domain/src/capability-registry.ts` and `packages/domain/src/tool-ownership.ts` | Static native-capability and external-backend metadata only. |

Platform-core code may import only the shared contract types and its
invocation-client abstraction. It must not import external-backend
implementation modules.

Backend-owned tool payload schemas remain authoritative inside the external
backend. The platform may consume backend-published schema descriptors as
registration artifacts, but it must not become the owner of external-domain
payload semantics.

## Invocation Contract

`packages/domain/src/external-backend-contract.ts` must export Zod schemas and
inferred types for the following JSON envelope. JSON uses camelCase keys,
RFC 3339 UTC timestamps, and decimal values represented as strings where the
existing tool schema requires exact decimal values.

```ts
type ExternalBackendInvocationV1 = {
  contractVersion: '1.0';
  requestId: string;
  idempotencyKey: string;
  correlationId: string;
  issuedAt: string;
  deadlineAt: string;
  caller: {
    serviceId: 'platform-core';
    keyId: string;
  };
  authorization: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    actor: { type: 'agent' | 'bot' | 'user' | 'system'; id: string };
    backendId: string;
    resolutionVersion: number;
  };
  backendId: string;
  toolName: string;
  payload: unknown;
};
```

The backend must validate the envelope first, then validate `toolName` and the
tool payload against the backend-owned schema for that tool or a schema
descriptor published by the backend for boundary registration. An unknown tool,
a tool not owned by the receiving backend, or a payload that does not parse is
a terminal validation failure. Backends must reject unknown keys in the outer
invocation envelope; backend-owned tool schemas retain their intentional
payload behavior only where explicitly declared by the backend.

The terminal response is:

```ts
type ExternalBackendResultV1 = {
  contractVersion: '1.0';
  requestId: string;
  correlationId: string;
  outcome:
    | { kind: 'success'; payload: unknown }
    | {
        kind: 'failure';
        code: ExternalBackendFailureCode;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
};
```

`ExternalBackendFailureCode` is a closed union:

```text
validation.invalid_payload
authentication.invalid_caller
authorization.denied
not_found.resource
precondition.not_ready
precondition.tool_not_visible
rate_limit.exceeded
deadline.expired
upstream.transient
internal.non_retryable
contract.unsupported_version
```

## Version Compatibility

1. The path major version and `contractVersion` major version must match.
   `/internal/v1/...` accepts only `contractVersion: '1.0'` initially.
2. Minor releases may add optional fields and error-detail properties only.
   They must not change the meaning, requiredness, or type of existing fields.
3. A caller must send the oldest supported minor version. A backend must return
   `contract.unsupported_version` before executing if the version is not
   supported.
4. A breaking change requires `/internal/v2/...`, a new contract literal, and
   a migration plan that runs both majors until all callers migrate.

## Authentication And Authorization

Every request is authenticated with an HMAC-SHA-256 service signature. The
signature covers this exact canonical string:

```text
METHOD + "\n" + PATH + "\n" + X-Herobids-Timestamp + "\n" + SHA256(raw JSON body)
```

Required headers are:

```text
Content-Type: application/json
X-Herobids-Service-Id: platform-core
X-Herobids-Key-Id: <active key identifier>
X-Herobids-Timestamp: <RFC 3339 UTC>
X-Herobids-Signature: sha256=<hex digest>
X-Request-Deadline-At: <same value as body.deadlineAt>
```

Service credentials are operator secrets. They are referenced, never stored,
in configuration. A receiving backend accepts only configured caller IDs and
key IDs, rejects timestamps outside the configured clock-skew window, and uses
constant-time signature comparison. Private-network placement is defense in
depth, not an authentication substitute.

The receiving backend authorizes only after authentication. It must verify:

1. `caller.serviceId` is authorized for the requested backend;
2. URL target, `backendId`, and manifest ownership of `toolName` agree;
3. the request contains non-empty tenant, agent, session, and actor identity;
4. actor provenance is valid for the requested tool; and
5. its backend-local readiness or binding policy allows the action.

Platform core is the authority for user ownership, session ownership, resolved
skills, native-capability activation, and visibility composition at dispatch
time. The signed backend request is its authorization assertion. External
backends must not accept a user-originated HTTP request or trust an unsigned
identity field.

## Deadlines, Retries, And Idempotency

Platform core sets `deadlineAt` from its resolved operator transport timeout
before the request is sent. It must not dispatch a request after the deadline.
The backend rejects a request whose deadline has passed before validation, and
checks it again immediately before every downstream side effect.

Only platform core retries transport failures. It may retry only when all of
these are true:

1. the deadline has not expired;
2. no terminal response was received; and
3. the same `requestId` and `idempotencyKey` are reused.

External backends may retry a downstream provider call internally only when the
operation is idempotent under the same persisted invocation key. They own
provider-specific retry limits and must stop before `deadlineAt`.

Each backend persists `external_tool_invocations` before any side effect. Its
unique key is:

```text
(backend_id, tenant_id, agent_id, tool_name, idempotency_key)
```

The record stores a SHA-256 request fingerprint, request ID, correlation ID,
state, terminal response, timestamps, and expiry. A reused key with a
different fingerprint returns `validation.invalid_payload`; a reused key with
the same fingerprint returns the original terminal result or its in-progress
status.

The default retention is configured as
`externalBackends.idempotencyRetentionHours: 168`. The implementation may not
hard-code a retention period. Expired records are purged asynchronously; the
purge loop must reschedule or fail visibly.

For the first trading backend, the durable invocation and any downstream
trading-instance handoff must share the idempotency key. This preserves intent
before side effects and makes ambiguous timeouts reconcilable.

## Mapping To Agent Tool Results

| Contract outcome | Agent `ToolResult` |
| --- | --- |
| success | `{ success: true, data: payload }` |
| `validation.invalid_payload`, `not_found.resource`, `precondition.*`, `rate_limit.exceeded`, `contract.unsupported_version` | `{ success: false, fault: false, retryable: false, errorCode: code, error: message }` |
| `authentication.invalid_caller`, `authorization.denied` | `{ success: false, fault: true, retryable: false, errorCode: code, error: message }` and a security log |
| `deadline.expired` | `{ success: false, fault: false, retryable: false, errorCode: code, error: message }` |
| `upstream.transient` | `{ success: false, fault: true, retryable: true, errorCode: code, error: message }` |
| `internal.non_retryable` | `{ success: false, fault: true, retryable: false, errorCode: code, error: message }` |

The LLM never receives service credentials, raw downstream provider errors,
stack traces, or internal authorization details.

## Configuration

Generic caller transport configuration belongs in the resolved operator config:

```yaml
externalBackends:
  requestTimeoutMs: 10000
  clockSkewMs: 30000
  idempotencyRetentionHours: 168
  services:
    trading:
      baseUrl: http://trading:3101
      keyId: current
      secretRef: ${EXTERNAL_BACKEND_TRADING_SIGNING_SECRET_REF}
```

`requestTimeoutMs`, skew, and retention require Zod validation and defaults in
the config schema. Backend-domain configuration is private to each backend.
Each backend loads and validates only its own domain config plus the generic
transport credential reference required to verify platform-core callers.
Backend settings must not be added to platform user or instance config.

## Deployment And Health

The root Dockerfile gains backend-specific build targets as repo-local
external services are added. `docker-compose.yaml` adds backend services such
as `trading` on the private default network. They depend on `migrate`,
PostgreSQL, and Redis only where their own implementation requires them. API
and worker use service names and never localhost URLs.

Health semantics are fixed:

1. `/health/live` confirms that the process can serve requests.
2. `/health/ready` confirms that configuration, contract validation, required
   persistence, and mandatory downstream dependencies for that backend are
   ready.
3. The control-plane resolver reports backend health separately from
   entitlement state and backend-declared readiness.
4. When an external backend is not ready, platform core removes its owned tools
   from new runtime visibility snapshots and returns a degraded reason. It does
   not fall back to direct imports.
5. An in-flight invocation returns `upstream.transient` or `deadline.expired`
   according to the observed outcome. The caller resolves ambiguity by retrying
   with the same key or querying the status endpoint. It never emits a second
   new idempotency key for the same LLM tool call.

## Required Verification

The extraction phase is complete only after automated tests prove:

1. valid signed calls succeed and invalid, expired, replayed, or unauthorized
   signatures fail before execution;
2. malformed envelopes and payloads produce typed validation failures;
3. deadline expiry prevents side effects;
4. retrying a side-effecting call with the same key yields one persisted
   invocation and one downstream effect;
5. a different payload with the same key is rejected;
6. unhealthy backend readiness removes tools and prevents direct-import
   fallback; and
7. compose starts the repo-local backend and its readiness endpoint becomes
   healthy.