# Bug Report: Agent Start Fails With 409 Conflict Due To Orphaned Running Containers

- **Status:** OPEN
- **Severity:** High
- **Date:** 2026-06-14
- **Summary:** After redeploying the worker (e.g. via `reset-and-run.sh`), previously-running agent containers are left alive. The worker marks their sessions unhealthy and attempts to re-launch them, but `DockerAgentManager.start()` only removes *stopped* containers before creating a new one — leaving the still-running orphan in place. Docker returns `409 Conflict` on every reconcile attempt, blocking agents indefinitely.

## Symptoms

- Worker logs show repeated `ERROR` lines from `agent-session-manager`:
  ```
  Docker container create failed: 409 {"message":"Conflict. The container name
  \"/herobids-agent-<id>\" is already in use by container \"<hash>\".
  You have to remove (or rename) that container to be able to reuse that name."}
  ```
- `docker ps` shows old agent containers still running ("Up 2 hours") while the worker is recycling.
- New agent start requests also fail with the same 409 if the container name collides.
- The error repeats on every `reconcileStartingSessions` poll cycle (every ~60 s) with no recovery path.

## Root Cause

`DockerAgentManager.removeStoppedContainer()` ([apps/worker/src/agents/docker-agent-manager.ts](../../../../../apps/worker/src/agents/docker-agent-manager.ts) line ~467) fetches the container state and only issues a `DELETE` if `State.Running === false`:

```ts
private async removeStoppedContainer(name: string): Promise<void> {
  const res = await this.dockerRequest('GET', `/containers/${name}/json`);
  if (res.status === 404) return;
  if (!res.ok) return;

  const info = await res.json() as { State?: { Running?: boolean } };
  if (!info.State?.Running) {                          // ← only removes stopped containers
    await this.dockerRequest('DELETE', `/containers/${name}?force=true`);
  }
}
```

When the worker restarts, surviving agent containers are correctly registered as *recovered* handles (`agent-runtime-launcher: Registered recovered runtime handle`). However, ~10 seconds later the health monitor marks those sessions **stale** (heartbeat predates the restart) and the session manager creates new `starting` sessions for those agents. `reconcileStartingSessions` then calls `start()`, which calls `removeStoppedContainer()` — but the old container is **still running**, so the guard passes it by. `POST /containers/create` then returns 409 because the name is already in use.

The `hasRuntime` guard in `reconcileStartingSessions` is intended to skip agents whose containers are already tracked, but by the time the new session is created the old handle has already been cleaned up by the health monitor (`agent-runtime-launcher: Agent runtime handle removed (container already stopped)` fires for sessions it deems stopped), so the guard does not fire.

## Sequence of Events

1. Worker restarts → old agent containers survive (Docker `RestartPolicy: no` keeps them running but unmanaged).
2. Worker registers them as recovered handles.
3. Health monitor detects stale heartbeats → marks sessions unhealthy → session manager creates new `starting` sessions.
4. Health monitor also removes the recovered runtime handles (`container already stopped` — incorrectly, since container is still running).
5. `reconcileStartingSessions` finds new `starting` sessions with no runtime handle → attempts to launch.
6. `removeStoppedContainer` skips the still-running container.
7. Docker returns 409 → launch fails → cycle repeats.

## Affected Code

- `apps/worker/src/agents/docker-agent-manager.ts` — `removeStoppedContainer()` (line ~467)

## Proposed Fix

Remove the `if (!info.State?.Running)` guard so that `removeStoppedContainer` (or a renamed `removeExistingContainer`) force-removes **any** pre-existing container with that name before creating a new one:

```ts
private async removeStoppedContainer(name: string): Promise<void> {
  const res = await this.dockerRequest('GET', `/containers/${name}/json`);
  if (res.status === 404) return;
  if (!res.ok) return;

  // Force-remove regardless of running state — any pre-existing container with
  // this name is an orphan from a previous session.
  await this.dockerRequest('DELETE', `/containers/${name}?force=true`);
}
```

The `hasRuntime` check in `reconcileStartingSessions` already ensures we never call `start()` for an agent whose container is actively managed by this worker instance, so force-removing here is safe.

## Immediate Workaround

Manually remove the orphaned containers before the next reconcile cycle:

```bash
docker rm -f herobids-agent-<agentId-1>
docker rm -f herobids-agent-<agentId-2>
# etc. — use `docker ps` to identify herobids-agent-* containers
```

## Verification Steps (Post-Fix)

1. Start agents, confirm they are running.
2. Run `reset-and-run.sh` to redeploy the worker.
3. Observe worker logs — sessions should transition `starting → running` without 409 errors.
4. Confirm old containers are removed and new containers are created with the same names.
