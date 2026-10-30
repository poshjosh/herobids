# Durable agent continuation - implementation plan

**Date:** 2026-10-30  
**Status:** Future implementation plan; no code or deployment performed.  
**Dependencies:** [001 safe expansion](001-safe-capacity-expansion-plan.md)
provides persistent waiting/startup semantics; read the
[roadmap](000-roadmap.md), [objectives](010-objectives.md) and
[options](011-scale-out-options.md).

## 1. Goal, boundaries and safety contract

Recover the same logical agent's committed work on a replacement runtime after
planned or unexpected loss. A brief automatic pause is acceptable. Acknowledged
work must remain recoverable, and supported external actions must not be
duplicated. This is a persistence/ownership contract, not live process migration.

Distinguish logical agent, logical session, unique runtime attempt and monotonic
ownership epoch. An allocation can be replaced without ending the logical work.
One active database session row is insufficient when two allocations use the
same session ID after a partition. Fence the old attempt **before the new attempt
can perform external side effects**, including direct HTTP tool calls and the
Traderton boundary, not just Redis broker messages.

"Acknowledged" means durably accepted at a documented boundary, not merely read
from Redis or written to a container file. Inventory every existing success/ack
surface; never redefine an existing acknowledgment to conceal a loss window.
Recover committed progress after sudden loss. Uncommitted computation may be
recomputed, but uncertain external effects must be reconciled, not blindly
re-executed. Graceful checkpointing is only one recovery path.

**Non-goals:** a general workflow engine; full process/heap migration; snapshots
as a substitute for application commits; restoring browser processes; arbitrary
provider exactly-once guarantees; new trading policy; mirrored trading state;
active-node destruction; a measured hard RTO/RPO. Traderton continues to own
positions, orders and execution, including already-accepted safety execution.

Operational freeze applies even if this plan is implemented: staging autoscale
was stopped by the owner and stays stopped until the unknown agent `user_data`
drift is diagnosed, replacement guard is tested and milestone 1 gates plus
explicit owner approval are satisfied. Production exposure is unknown. This plan
does not authorize live reads, Terraform preparation, deployment or timer changes.

Milestone 1's section 0 exposure/drift gate and disposable acceptance precede
shared mutation. Its mutation guard applies unconditionally to legacy,
feature-gate-off and rollback paths; an old unguarded binary requires leaving
timers stopped, not bypassing the guard.

## 2. Verified local source evidence and mandatory discovery

These are code observations, not deployed behavior:

| Source | Observation and implementation consequence |
|---|---|
| [agent.ts](../../../../../../apps/worker/src/agent.ts), conversation state and `shutdown` | Histories/wake buffer are process-local; shutdown drains at most 8,000 ms then continues even if a tick remains active. Add regular durable commits and distinct resumable termination semantics; do not rely solely on exit. |
| [outbound-message-reader.ts](../../../../../../apps/worker/src/agents/outbound-message-reader.ts), `readOutboundMessages` | `xreadgroup` is followed by `xack` before returning messages. Return delivery identity and transfer durable ownership before ack; support pending-entry reclaim. |
| [agent-message-broker.ts](../../../../../../apps/worker/src/agents/agent-message-broker.ts), `processInbound` | Message-ID deduplication and active-session gate exist. Reuse/strengthen transaction and replay semantics; they are not yet proof of attempt fencing across every effect path. |
| [agent-runtime-sessions.ts](../../../../../../packages/db/src/schema/agent-runtime-sessions.ts) | Partial unique active-agent index and session API-key hash exist; comment currently equates session to container. Explicit attempt/epoch semantics need compatible migration. |
| [nomad-runtime-adapter.ts](../../../../../../apps/worker/src/agents/nomad-runtime-adapter.ts), `buildNomadJobSpec` | Stable `agent-<id>` job, `herobids.sessionId` metadata, restart attempts zero and no persistent workspace volume. Allocation replacement is not state restoration or attempt identity. |
| [memory.ts](../../../../../../apps/worker/src/tools/memory.ts) | Product memory is in `agent:memory:<id>` Redis hashes; durability is unproven here. |
| [agent-ephemeral-redis-cleanup.ts](../../../../../../apps/worker/src/agents/agent-ephemeral-redis-cleanup.ts) | Terminal cleanup deletes inbound/outbound streams, not memory/tasks/reminders/watches. Recovery must distinguish terminal deletion from resumable loss and preserve unfinished accepted work. |
| [workspace.ts](../../../../../../apps/worker/src/tools/workspace.ts), `getWorkspacePaths`; [Dockerfile.agent](../../../../../../docker/Dockerfile.agent) | Workspace lasts the container lifetime. Classify durable artifacts versus scratch files before promising file recovery. |
| [docker-document-materializer.ts](../../../../../../apps/worker/src/agents/docker-document-materializer.ts); [agent-runtime-launcher.ts](../../../../../../apps/worker/src/agents/agent-runtime-launcher.ts), `materializeStagedDocuments` | Documents can be rematerialized; this does not preserve arbitrary workspace writes. |
| [index.ts](../../../../../../apps/worker/src/index.ts) | Existing launcher/session-manager dependency injection and `LocalDocumentStore` wiring are integration seams. Local storage is not automatically cross-node durable. |
| [usage-billing-service.ts](../../../../../../apps/worker/src/usage-billing-service.ts), `doRecordRuntimeWindow` | Runtime windows carry session/time idempotency keys; separate attempt overlap needs explicit interval accounting. |

Before editing, read [AGENTS.md](../../../../../../AGENTS.md),
[lessons](../../../../../../docs/lessons/lessons-from-previous-project.md),
[best practices](../../../../../../docs/best-practices/README.md),
[runtime rules](../../../../../../docs/best-practices/agent-runtime.md),
[configuration](../../../../../../docs/best-practices/configuration.md),
[Docker conventions](../../../../../../docs/best-practices/docker.md),
[runtime boundary](../../../../../../docs/tech/agents/runtime-boundary-and-message-contract.md)
and [recovery/replay](../../../../../../docs/tech/agents/recovery-and-replay.md).
The last two are starting contracts; reconcile historical trading-engine language
with current code and Traderton ownership. Inspect relevant git history, bug
reports, migration journal and other agents' changes.

Mandatory discovery deliverable, before schema/API choices:

- Enumerate accepted user messages, wake sources, memory/tasks/reminders/watches,
  visible conversation, summaries, tool results, prompts, documents and arbitrary
  file writes. For each: owner/source, acceptance point, commit point, retention,
  recovery projection and irrecoverable/unsupported category.
- Trace both stream directions, pending entries, consumer names, dedup commit
  status, timeout/retry behavior, cleanup callers and stream trimming. A processed
  dedup marker without the corresponding committed result is not completion.
- Enumerate all side-effect paths: broker tools, direct tool HTTP, browser
  submissions, shell/network access and external-backend transports. Find actual
  credential/authorization enforcement, not just intended topology.
- Prove database and Redis persistence/failover/backup semantics using disposable
  tests and approved configuration evidence. Do not assume Redis is all cache or
  all durable. Identify the fault domain of `LocalDocumentStore` and existing
  repository/object-storage adapters; reuse architecture where appropriate.
- Inventory connector idempotency scope/expiry, outcome lookup and stable action
  identifiers. Publish an owner-approved supported/unsupported matrix. Confirm
  Traderton request/reconciliation contracts rather than inventing Herobids
  trading authority.

### Required side-effect support matrix

The initial classification below is conservative, not a claim that any path is
already proven. Discovery must enumerate actual tools/connectors and replace
conditional entries with evidence-backed scope before activation.

| Effect path | Continuation support and required proof |
|---|---|
| Pure reads/reconstructible computation | Replayable only after verifying no hidden external mutation; protect credentials and stale-state interpretation. |
| Broker-mediated product mutations | Conditional: atomic intent/result/dedup and accepting-boundary ownership enforcement must be demonstrated; session gating alone is insufficient. |
| Traderton/external-backend writes | Conditional per connector/action: enforce current ownership, stable provider idempotency/reconciliation and already-accepted execution semantics. No Herobids mirror of trading authority. |
| Durable document/artifact commit | Conditional on blob availability, manifest commit, versioning and ownership checks; scratch writes are outside this contract. |
| Arbitrary `execute_shell` effects | **Unsupported for the no-duplicate guarantee** unless each permitted effect has enforceable ownership plus idempotency/reconciliation. General shell/network access cannot be made safe by a database lease alone. |
| Arbitrary browser interactions/submissions | **Unsupported for the no-duplicate guarantee** unless the accepting service enforces ownership and a stable idempotency/outcome contract. Restarting a browser or replaying clicks is not reconciliation. |
| Arbitrary web/direct HTTP writes | **Unsupported for the no-duplicate guarantee** unless the specific path has enforceable ownership and idempotency/reconciliation, including delayed/in-flight requests and direct-credential revocation. |

Agents with unsupported effect paths cannot be advertised as satisfying the
no-duplicate continuation contract. Restrict/mediate those paths or keep them
outside automatic effect replay with visible operator resolution. Do not silently
change user policy or represent a pending unknown outcome as a completed action.
No database-only fencing scheme establishes universal no-duplicate external
actions.

## 3. Proposed contracts, storage and wiring

Prefer a small Postgres-backed continuation model using existing repositories
and ports, unless discovery proves an equivalent durable source already exists.
The following are proposed additions, not existing APIs:

- A continuation record with logical session, schema version, monotonically
  committed sequence, visible context/structured state references, input cursor
  and durable artifact manifest. Persist only visible assistant text and safe
  structured state, **never provider hidden reasoning**. Bound context size and
  define retention, user deletion, access control and encryption requirements.
- Runtime-attempt ownership: unique attempt ID, epoch, lease expiry/renewal,
  allocation identity and state. Use compare-and-swap transactions for claim,
  renewal, checkpoint and terminal transitions; a stale epoch cannot commit.
  Do not blindly change the existing active-session unique index.
- A durable accepted-input/inbox handoff and external-action intent/outcome
  ledger with stable IDs, connector, request hash, logical session/sequence,
  owner epoch, provider idempotency key and reconciliation state. Reuse existing
  records where their atomicity is sufficient; do not create a parallel dedup
  universe. A crash between database commit and Redis ack must be safely replayable.
- Files: authoritative documents/artifacts use durable blob/repository storage
  plus versioned checksum manifest committed with continuation references.
  Success for durable file tools follows blob availability plus manifest commit.
  An orphan blob is garbage-collectable; a committed missing blob blocks recovery.
  Scratch downloads, caches and browser sessions may be reconstructed/discarded.
  Arbitrary shell writes without commit semantics are not guaranteed durable;
  either introduce an explicit commit boundary or constrain the advertised
  support. File snapshots alone cannot guarantee zero lost acknowledged writes.
- Suggested port additions under
  [domain ports](../../../../../../packages/domain/src/ports):
  `AgentContinuationStore` and an ownership/fencing interface, names finalized
  after discovery. Implement in
  [packages/db/src](../../../../../../packages/db/src), not in pure domain code.
  Extend [RuntimePort](../../../../../../packages/domain/src/ports/runtime.ts),
  launch configuration and termination events only as necessary to carry
  attempt/epoch and resume information.

Wire dependencies through [worker index](../../../../../../apps/worker/src/index.ts),
`AgentSessionManager`, `AgentRuntimeLauncher`, runtime adapters and tool
authorization. Resume/checkpoint communication must be authenticated and
attempt-scoped using existing private API/transport where adequate. **No new
public listener/port is required by default.** Map actual DB/Redis/API/Nomad/blob
connectivity and credentials; approve any new service, egress proxy or port
before adding it. Nomad API address/ACL configuration is not an agent credential.

Lease checks only at tool entry are insufficient for an already-in-flight
request. Before successor activation, each supported effect path must either
enforce epoch/credential revocation at the accepting boundary, be definitively
terminated, or reconcile/serialize outstanding intents so stale requests cannot
produce new duplicated actions. If direct credentials/network bypass this,
support is blocked until mediation/revocation is proved. A local "lease expired"
flag in the old process is not fencing.

## 4. Ordered implementation tasks

1. **Define acceptance and fault contracts.** Complete section 2 inventory,
   supported connectors, durable-file semantics, failure matrix and pause versus
   terminal-state mapping. Document an approved downtime accounting policy:
   capacity waiting is not runtime billing; attempt overlap is not double billed;
   downtime/recovery intervals are explicitly audited. Decide lease timing from
   measured fault bounds, not arbitrary production defaults.
   **Depends on:** milestone 1 contract review. **Gate:** unresolved effect
   fencing or critical storage durability blocks activation.
2. **Add additive durable model and repository transactions.** Modify
   [session schema](../../../../../../packages/db/src/schema/agent-runtime-sessions.ts)
   and [AgentRepository](../../../../../../packages/db/src/agent-repository.ts)
   only after choosing whether attempts need a separate table. Add continuation,
   accepted-input and action records as justified. Generate migrations under
   [db migrations](../../../../../../packages/db/drizzle) with matching journal;
   add indexes, uniqueness/CAS constraints, payload bounds and repository tests.
   Backfill existing active sessions as legacy/non-resumable until a committed
   checkpoint exists; never fabricate lost history. **Depends on:** task 1.
3. **Implement single-owner attempt lifecycle and enforcement.** Extend
   [runtime port](../../../../../../packages/domain/src/ports/runtime.ts),
   [launcher](../../../../../../apps/worker/src/agents/agent-runtime-launcher.ts)
   `launch`/`reconcile`/`stop`/`kill`,
   [session manager](../../../../../../apps/worker/src/agents/agent-session-manager.ts)
   `registerSurvivedSessions`, `handleHeartbeat`, `handleRuntimeFailure` and
   [Nomad job builder](../../../../../../apps/worker/src/agents/nomad-runtime-adapter.ts).
   Carry attempts through authenticated runtime environment/metadata, broker,
   API keys and every supported effect boundary. Fence stale heartbeats,
   farewells, commits and tool actions. Preserve Docker/stub compatibility.
   **Depends on:** task 2; no successor effect activation before fencing proof.
4. **Commit regular progress and durable message handoff.** Modify
   [agent.ts](../../../../../../apps/worker/src/agent.ts) history/wake/tick
   boundaries and [reader](../../../../../../apps/worker/src/agents/outbound-message-reader.ts)
   return/ack contract. Commit input ownership and continuation atomically where
   possible before `xack`; reclaim pending entries after loss and deduplicate
   across replay. On store failure, stop acknowledging/starting unsafe new work,
   backpressure visibly and retain inputs. Modify
   [broker](../../../../../../apps/worker/src/agents/agent-message-broker.ts)
   dedup/result handling, not a second unrelated mechanism.
   **Depends on:** tasks 2-3.
5. **Persist/reconcile supported tool actions and artifacts.** Write intent
   before dispatch; commit outcome before reporting success. Reuse provider
   idempotency keys across attempts. On "request accepted, response lost", query
   provider using stable IDs; if lookup is unavailable, mark `pending_resolution`
   and pause dependent work with operator guidance. Add durable-file commit/
   rematerialization using `getWorkspacePaths`, document store/materializer and
   `materializeStagedDocuments`; migrate product-critical Redis state if its
   durability is insufficient. Verify shell/browser restrictions honestly.
   **Depends on:** tasks 1-4 and connector-owner agreement.
6. **Restore and resume, without accidental terminal cleanup.** Load the last
   valid committed version, validate manifest and schema, reconstruct bounded
   context, reclaim input and reconcile incomplete intents before enabling
   actions. Modify session-manager terminal paths and
   [ephemeral cleanup](../../../../../../apps/worker/src/agents/agent-ephemeral-redis-cleanup.ts)
   so recoverable loss does not delete accepted unfinished work. Make `shutdown`
   persist a resumable state when appropriate, but also test recovery without it.
   **Depends on:** tasks 3-5.
7. **Expose truthful status and billing.** Add backward-compatible resume state,
   last committed progress and safe failure reason to
   [API session projection](../../../../../../apps/api/src/services/agent-runtime-session-projection.ts)
   and [agents routes](../../../../../../apps/api/src/routes/agents.ts).
   Update [AgentDetailPage](../../../../../../apps/web/src/features/agents/AgentDetailPage.tsx)
   and its API types/localization discovered at implementation time: distinguish
   capacity wait, restoring, reconciling, active, terminal and operator resolution;
   do not expose secret checkpoints or raw provider payloads. Adapt
   [usage billing](../../../../../../apps/worker/src/usage-billing-service.ts) and
   [billing repository](../../../../../../packages/db/src/usage-billing-repository.ts)
   to canonical nonoverlapping logical runtime intervals with attempt audit
   references and retry-safe accounting. **Depends on:** tasks 1, 4-6.
8. **Configure, prove and stage selectively.** Add disabled-by-default typed
   configuration in [schema](../../../../../../packages/domain/src/config/schema.ts)
   and [defaults](../../../../../../config/default.yaml): checkpoint size/cadence,
   lease/renewal limits, retention, recovery retries/backoff and maximum unresolved
   work. Trace resolved config through worker/runtime wiring; update matching
   `.env*.example` twins if environment keys change. No magic production values.
   Run section 5 tests, then seek operator rollout approval. **Depends on:** all
   prior tasks; no timer or infrastructure activation is implicit.

## 5. Measurable acceptance and failure injection

Use focused Vitest unit tests beside affected modules, repository integration
tests with disposable Postgres/Redis, then a disposable Nomad/Docker environment
with mock effect providers. No real orders or live infrastructure destruction.

| Test | Required observable result |
|---|---|
| Crash before/after durable input handoff and before/after Redis ack | Every accepted input ID remains accounted for and is applied once logically; reclaim handles pending entries; no silent drop or duplicate completion. |
| Kill mid-tick without shutdown; restart worker and runtime separately | Last committed sequence/context/artifacts restore; accepted unfinished inputs remain recoverable; no reliance on a final checkpoint. |
| Partition old allocation; start replacement for the same logical session | Exactly one authorized effect owner; stale attempt requests/heartbeats/commits/farewells are rejected, including direct HTTP and delayed in-flight requests. |
| Provider accepts action then response/worker is lost | Stable key/lookup proves one supported action; unsupported ambiguity is visible pending resolution with zero blind resends. |
| Redis restart/data loss within selected durability contract | Product state/accepted input recovers from proved durable source or activation fails; streams are not declared durable without evidence. |
| DB/blob outage, partial blob upload, bad checksum, corrupt/new checkpoint version | No false success/ack; no dangling committed references; restore fails closed visibly; bounded retries and usable diagnostics. |
| Terminal cleanup races with resumable failure | Accepted unfinished work survives; deliberate final user deletion follows retention/authorization policy. |
| Runtime overlap, repeated recovery, waiting, crash before usage flush | No overlap double charge or capacity-wait runtime charge; approved downtime policy and retry-safe usage audit reconcile to logical intervals. |
| Upgrade with legacy session / rollback with new checkpoint | Unsupported restore is blocked safely; legacy sessions are not represented as fully resumable. |

Unit-test CAS, version bounds, dedup transitions, redaction and interval arithmetic.
Integration-test transactions and API authorization/projections. Visually verify
wait->restore->reconcile->active and pending-resolution states, reconnect, stop and
billing displays. Record input IDs, sequences, attempts/epochs, effect IDs,
monotonic timing and billing totals in sanitized evidence. Acceptance requires
zero lost accepted IDs and zero duplicate supported actions in the enumerated
fault matrix, not an unqualified universal guarantee. Record observed recovery
distributions; no hard RTO/RPO is achieved merely by passing happy-path tests.

## 6. Operator rollout, rollback and final evidence

Gates: owner-approved persistence/ack/file/connector contracts -> migration and
mixed-version tests -> complete disposable fault matrix including partitioned
attempt -> billing/UI acceptance -> explicit staging canary approval -> observed
canary and rollback rehearsal -> separate production approval. A canary resumes
only agents whose tool paths meet the support matrix. Unsupported agents remain
on the documented legacy contract, never a falsely guaranteed mode.

Rollback: disable **new** resumable admissions, quiesce/fence attempts, preserve
committed checkpoints/inbox/action records and unresolved intents. Do not drop
new tables or let old unfenced binaries take over active sessions. Roll back
readers only if version/epoch compatibility was proved; otherwise remain safely
paused and use the forward-compatible recovery path. Never compensate an
uncertain external action with an invented trading action. No cleanup of accepted
work to make rollback appear successful.

Final evidence must include source revision, exact schema/migration journal,
storage fault assumptions/proof, connector support matrix, fence coverage,
test results and measured timings, billing reconciliation, operator/UI examples,
retention/deletion behavior, known limits, rollback rehearsal and signed activation
decision. New listeners/dependencies, durability topology, connector enforcement
changes, exact lease settings and downtime policy remain explicitly gated until
discovery and owner approval. If any critical effect path cannot be fenced,
stop activation and report it; do not dilute the guarantee.
