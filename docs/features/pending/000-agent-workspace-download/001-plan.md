# Implementation Plan: Download Workspace on Stop, Restore on Start

**Status:** Draft implementation plan; no feature code or deployment performed.
**Scope:** Download the entire agent workspace before stopping, edit the stopped agent, then upload and restore the workspace before it starts working again.

## 1. Product contract

The user journey is:

1. Click **Stop** and choose to download the workspace first.
2. Save the backup on their computer, then confirm Stop.
3. Edit the stopped agent using the existing editor.
4. Choose **Restore workspace and start**, upload the backup, and continue with the saved files and edited settings.

**The backup includes all of `/workspace`:** `sandbox/`, `web-cache/`, `docs/`, `.agents/skills/`, other hidden files, empty directories, and agent-created files. There are no automatic folder exclusions. "Scratch" is not a separate product category or a reason to omit files.

This is a workspace backup, not a backup of the entire container root (`/`). Programs, operating-system files, home directories and files outside `/workspace` are outside the contract. Files under `sandbox/` are included, but the existing `execute_code` behavior can clear that folder on a later invocation; restoration does not change this behavior.

**Non-goals:**
- Persistent shared workspace storage, automatic backups, or incremental sync.
- Automatic recovery after crashes, account suspension, or non-UI stops.
- Restoring running processes, remote browser sessions, in-memory state, or an exact execution point.
- Exporting/restoring agent settings, credentials, conversation records, memory, tasks, reminders or trading state. Those remain owned by their existing systems; any copies already present as workspace files are included as files.
- Changing existing API/agent/Telegram stop semantics or trading policy. This feature adds an owner-facing web workflow, not confirmation gates for autonomous agent tools.

## 2. Current state and constraints

| Area | Verified observation and consequence |
|---|---|
| Workspace | [workspace.ts](../../../../apps/worker/src/tools/workspace.ts) resolves `/workspace` in containers. There is no persistent workspace volume in the current runtime launch specifications. |
| Docker lifecycle | [docker-agent-manager.ts](../../../../apps/worker/src/agents/docker-agent-manager.ts) stops containers without immediately removing them, but Start removes the old container before creating a replacement. Back up before Stop for a consistent cross-runtime workflow. |
| Nomad lifecycle | [nomad-runtime-adapter.ts](../../../../apps/worker/src/agents/nomad-runtime-adapter.ts) stops and purges the job. A Docker-only implementation is insufficient. |
| Pause | [runtime-pause.ts](../../../../apps/worker/src/runtime-pause.ts) gates new ticks, but changing the database status alone does not prove that current work or child processes have finished writing. |
| Startup settings | [runtime-lifecycle.ts](../../../../apps/worker/src/agents/runtime-lifecycle.ts) supplies fresh configuration/session information on launch. Restore files without replacing those settings. |
| Documents | [docker-document-materializer.ts](../../../../apps/worker/src/agents/docker-document-materializer.ts) demonstrates archive upload into a container. Existing document upload is not arbitrary workspace restore. |
| Quotas | [default.yaml](../../../../config/default.yaml) defines soft workspace quotas, currently 100 MiB free/starter and 500 MiB pro. Shell writes can exceed these; they are not reliable measurements of actual archive size. |
| Web entry points | Both [AgentDetailPage.tsx](../../../../apps/web/src/features/agents/AgentDetailPage.tsx) and [AgentQuickActions.tsx](../../../../apps/web/src/features/agents/AgentQuickActions.tsx) currently issue lifecycle calls. Cover detail, list/card and chat uses through shared UI. |

## 3. Backup and restore rules

### Archive contents and validation

- Use `.tar.gz` with workspace-relative entries, preserving file bytes, relative paths, hidden entries, empty directories, and supported permission bits (including executable files).
- Do not omit `sandbox/`, `web-cache/` or `docs/`, or follow links to content outside the workspace.
- Handle safe internal symlinks/hard links only if the extraction implementation can validate their complete resolution safely. Reject unsafe links, traversal, special device entries, sockets or other unsupported entries explicitly. Report the offending relative path; never silently produce a partial "complete" backup.
- Add a versioned manifest outside the restored workspace payload, recording archive format, source agent ID, creation time, entry count, uncompressed size and integrity checks. Do not mix platform metadata into user files or overwrite a user's similarly named file.
- Treat every upload as untrusted, even one containing a platform manifest. Reject absolute paths, `..` traversal, duplicate/ambiguous entries and link-based escapes. Do not restore arbitrary host ownership, setuid/setgid bits or privileges.
- Validate compressed upload size, expanded bytes, entry count, individual-file size and decompression bounds. Check integrity and compatibility before allowing the agent to execute.
- If limits prevent a complete backup, say so and keep the agent paused. Do not trim folders or files to make the backup fit.

### Storage and scale

- The user's downloaded file is the retained backup. No permanent server-side archive copy or per-agent persistent volume is introduced.
- Stream exports with backpressure; do not buffer whole workspaces in API/worker/browser memory.
- Restore may use bounded, short-lived staging. Staging must be reachable by the actual allocation/node that restores it; do not assume API-local disk is shared with Nomad nodes.
- Configure transfer size/expanded-size limits, timeouts, staging expiry and per-user/global concurrency through existing operator configuration conventions. Record defaults and rationale before implementation.
- Clean staging and abandoned operations after success, cancellation, failure and expiry. Retries must not attach an old upload to a newer session.
- Measure concurrent-transfer memory, disk and network usage. Ten thousand agents must not imply ten thousand retained archives or background backup jobs.

## 4. Web UX

### Stop dialog: every user-facing web Stop entry point

Opening the dialog alone must not pause or stop the agent.

Suggested text:

> **Stop this agent?**
> Workspace files are not retained across stop/start. Download the entire workspace now if you want to restore it later.
> Backups may contain sensitive information. Keep yours safe.

Actions:
- **Download workspace first** (recommended path).
- **Stop without downloading** (explicit destructive choice; never the default focused action).
- **Cancel**.

Download path:
1. Display **Preparing workspace...**. Request a runtime-confirmed pause/quiescence, then prepare the archive.
2. Display transfer progress (bytes; percentage only when total is known), cancellation and errors.
3. Start the browser download using a streaming/native download mechanism.
4. Show **Check that your backup has saved successfully**, with **I've saved it - stop agent**, **Download again**, and **Keep paused**.
5. Only explicit confirmation calls Stop. A download request, completed server response or browser download prompt is not proof the user saved the file.
6. If Stop fails, retain the successful-download state and offer **Retry stop** without forcing another download.

If preparation/download fails or is cancelled after pausing, leave the agent paused and say so. Offer retry, Resume, or Stop without downloading. Do not silently resume an agent or stop one whose backup failed.

For starting/crashed/unreachable agents, show actual backup availability. An unavailable workspace must not appear downloadable; explain the reason and retain Cancel and an explicit Stop without downloading option. Support a readable non-running container where feasible, without promising recovery of a purged runtime.

### Start dialog

Every stopped agent must offer:
- **Start without restoring** (existing start behavior).
- **Restore workspace and start**.
- **Cancel**.

Do not condition restore availability on whether this browser remembers a download; the user may have a backup from another device.

Restore path:
1. Select the workspace backup; show filename, size, source/date if validated, and that settings are not restored from the file.
2. Show upload progress, validation status, **Restoring workspace...**, then **Starting agent...**.
3. Keep the agent unable to perform work until restore and startup preparation finish successfully.
4. On invalid/oversized/corrupt upload, show an actionable error and allow another selection.
5. On restore failure, do not silently start with an empty/partial workspace. Keep it non-working, clean partial restore safely, and offer Retry, Cancel or an explicit fresh-start choice.
6. Prevent duplicate submissions and conflicting lifecycle actions. Refresh authoritative status after reconnect/navigation; do not report running merely because upload completed.

Use shared dialogs/hooks and existing API/query/error patterns rather than duplicating flows across detail and quick actions. Include localized labels/tooltips/help, accessible dialog focus/keyboard behavior, screen-reader progress, and mobile layouts.

## 5. Backend and runtime implementation

### Step 1 - Resolve runtime transfer and startup seams

- Read repository runtime, Docker, configuration and rollout guidance before coding.
- Trace allocation discovery, authenticated API-to-worker/node communication, runtime launch and terminal cleanup for both Docker and Nomad.
- Define a small typed runtime transfer contract and backend operation state. Never expose Docker/Nomad credentials, unrestricted container exec or internal node addresses to the browser.
- Do not assume a ready-made worker HTTP streaming endpoint exists. Select and document the authenticated bounded transfer transport before implementing API endpoints.
- Bind operations to owner, agent, session/allocation identity and operation ID. Serialize backup/restore with conflicting start/stop/resume/delete operations; reject stale requests and release abandoned leases.

### Step 2 - Implement complete export

- Ask the runtime to stop accepting new work and acknowledge quiescence after in-flight writes/processes have settled. A `paused` database row alone is insufficient.
- Define a bounded wait; if writers cannot be made quiescent, fail visibly instead of claiming a consistent backup. Do not kill work silently or alter trading behavior.
- Export all workspace entries through the transfer contract, generate the manifest, enforce limits and return namespaced errors.
- Keep the prepared runtime quiescent through download/retry until the user chooses Stop or Resume, subject to existing expiry policy. A lost runtime must invalidate the operation visibly.
- Implement Docker and Nomad allocation-aware access. Never allow a stale backup operation to read a replacement session's files.

### Step 3 - Implement upload and restore-before-work

- Accept a bounded upload for the owned stopped agent, validate it and create an expiring restore operation/token.
- Extend the existing Start request with an optional restore-operation reference; preserve existing JSON-only Start behavior for all other callers.
- Consume the reference atomically for that start attempt; retries must be idempotent and fenced from later sessions.
- Docker: split container creation from process start so validated extraction can complete before agent execution.
- Nomad: provide an equivalent startup restore gate (for example an allocation-local preparation phase) before the main runtime can tick, consume messages or call tools. Docker-specific create/putArchive ordering cannot be assumed here.
- Restore into a clean workspace, normalize ownership safely, verify completion, then release the startup gate.
- Reconcile existing document materialization with restored `docs/`: preserve the backed-up bytes without silently overwriting them during this startup. Reuse identical copies; surface conflicts with currently stored documents and block work until resolved. Never silently omit `docs/`.
- Reconcile restored skill files with the agent's current selected skills/tool policy; restored files must not regrant removed capabilities. Runtime-generated session credentials/configuration remain fresh.
- Persist operation status/errors for polling across API/worker restarts; expire tokens and remove staged bytes after the defined retry window.

### Step 4 - Public API and client

Proposed shapes (final route naming follows existing conventions):
- `POST /agents/:id/workspace/backups`: request preparation/quiescence, returning an operation ID and status.
- `GET /agents/:id/workspace/backups/:operationId`: read status and transfer availability.
- `GET /agents/:id/workspace/backups/:operationId/download`: authenticated streamed archive attachment.
- `POST /agents/:id/workspace/restores`: multipart upload, returning validation status and an expiring restore reference.
- Extend `POST /agents/:id/start` with an optional validated restore reference.
- Provide cancellation/status operations needed by the UI and recovery workflow; cancellation must release resources, not just close the dialog.

Authorize every status, transfer and start reference against ownership. Prevent cross-user/cross-agent reference reuse; validate source-agent compatibility before restore. Use same-agent backups for v1, not agent cloning.

Keep the existing Stop endpoint's non-download behavior unchanged. User-confirmed Stop reuses it after transfer, with session fencing to avoid stopping a newer runtime.

Audit preparation/download delivery, restore and failures using IDs, counts, byte sizes and error codes, not contents, credentials or sensitive filenames. Do not label server-delivered bytes as a confirmed local save.

### Step 5 - Web and documentation integration

- Add client methods and the shared Stop/Start flows described in section 4.
- Integrate [AgentDetailPage.tsx](../../../../apps/web/src/features/agents/AgentDetailPage.tsx) and [AgentQuickActions.tsx](../../../../apps/web/src/features/agents/AgentQuickActions.tsx); inventory any other web lifecycle controls.
- Update supported locale files, Stop/Pause tooltips and lifecycle help. Do not claim that Pause guarantees backup consistency or that Stop removes files immediately on every backend.
- Document entire-workspace contents, local backup responsibility, restore steps, sensitive-data warning, limits and failure recovery. Explain that files are not process/browser state, and external API/agent/Telegram stops do not open web dialogs.
- Update [user acceptance tests](../../../tech/user-acceptance-tests.md) and [CHANGELOG.md](../../../../CHANGELOG.md).

## 6. Dependencies and delivery

1. Finalize transfer routing, quiescence acknowledgement, restore gating and limits (Step 1).
2. Implement export and restore against that contract (Steps 2 and 3).
3. Wire authenticated API operations and client methods (Step 4).
4. Integrate shared web flows and docs (Step 5).
5. Verify the complete round-trip on both supported backends before advertising availability. Use disposable environments and existing rollout gates; this plan authorizes no shared infrastructure mutation or deployment.

## 7. Verification and acceptance criteria

- **Archive round-trip:** compare relative paths and file hashes before backup and after restore, including `sandbox/`, `web-cache/`, `docs/`, `.agents/skills/`, other hidden files, binary/empty files, empty directories and executable files. Prove no automatic exclusions.
- **Validation:** corrupt/truncated uploads, unsafe paths/links, duplicate entries, unsupported special entries, wrong source agent, compressed/expanded limits, quota changes and decompression bombs produce explicit errors without partial startup or silent data loss.
- **Lifecycle:** acknowledge quiescence only after a deliberately delayed writer finishes; test timeout, runtime loss, expiry, concurrent Resume/Start/Stop/Delete, retries and stale session IDs.
- **Restore ordering:** assert no tick, message handling or tool execution occurs before restore completes on Docker and Nomad. Edited settings take effect, fresh credentials are retained, and restored skill files do not change current authorization.
- **Document conflicts:** identical restored documents are not duplicated; conflicting uploaded/restored documents are reported before work starts, not silently overwritten.
- **Authorization:** test cross-owner access, wrong agent/operation references, replayed/expired tokens and cancelled operations.
- **UI:** test all three initial Stop choices, save confirmation, transfer cancel/failure, Resume after failed backup, failed Stop retry, file selection, upload/restore/start progress, invalid archive, fresh start and reconnect. Verify detail/card/chat parity, accessibility, localization and mobile layout.
- **Resources:** prove streaming/backpressure and enforced concurrency; measure peak memory, staging usage and cleanup after aborted transfers/process restarts. No whole-archive browser Blob buffering for large backups.
- **End-to-end UAT:** create files in every included folder, download and confirm Stop, edit settings, upload and restore, then verify exact file contents and edited behavior. Starting without restore continues to work.
- Use targeted existing tests/type-checks first, then the repository-required lint/build checks for changed runtime/API/web code. Documentation-only edits to this plan need no build.

## 8. Caveats and implementation gates

- Users retain their own downloaded backups; lost downloads cannot be recovered from a permanent server copy.
- Workspace download does not protect against a crash or automatic stop before a backup can be taken.
- Including all workspace folders can produce large archives; show actual sizes/limit errors rather than calling a partial export complete.
- Restore preserves supported filesystem contents, not running browser/process state or already-executed external actions.
- Before coding, resolve the concrete Nomad transfer transport, pre-work restore gate, safe link handling and document-conflict interaction. These are engineering gates, not reasons to narrow the agreed whole-workspace/UI scope.
