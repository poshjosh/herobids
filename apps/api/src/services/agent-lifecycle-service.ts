import crypto from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, agentRuntimeSessions, users } from '@herobids/db';
import { normalizePersistedAiModelConfig } from '@herobids/domain';
import { ok, err, type Result } from '@herobids/domain';
import { ensurePublishedBlueprintForAgent } from './agent-blueprint-sync-service.js';

// ── Error types ───────────────────────────────────────────────────────────

export type AgentLifecycleError =
  | { code: 'agent.not_found'; message: string }
  | { code: 'agent.not_owned'; message: string }
  | { code: 'agent.invalid_status'; message: string; currentStatus: string }
  | { code: 'agent.model_selection_incomplete'; message: string }
  | { code: 'agent.skill_portability'; message: string }
  | { code: 'agent.internal_error'; message: string };

// ── Start ─────────────────────────────────────────────────────────────────

export async function startAgent(
  db: Database,
  agentId: string,
  userId: string,
): Promise<Result<{ status: string; sessionId?: string }, AgentLifecycleError>> {
  const sessionId = crypto.randomUUID();
  const now = new Date();

  try {
    const result = await db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ status: agents.status, modelPolicy: agents.modelPolicy })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));

      if (!agent) {
        return { kind: 'not_found' as const };
      }

      if (agent.status !== 'stopped') {
        return { kind: 'not_stopped' as const, status: agent.status };
      }

      // Validate effective model selection before accepting the start request.
      const agentModelPolicy = (agent.modelPolicy as Record<string, unknown> | null | undefined) ?? null;
      const agentProvider = typeof agentModelPolicy?.['provider'] === 'string' ? agentModelPolicy['provider'] : undefined;
      const agentLightModel = typeof agentModelPolicy?.['lightModel'] === 'string' ? agentModelPolicy['lightModel'] : undefined;
      const agentHeavyModel = typeof agentModelPolicy?.['heavyModel'] === 'string' ? agentModelPolicy['heavyModel'] : undefined;

      const [userRow] = await tx
        .select({ aiModelConfig: users.aiModelConfig })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const userAiConfig = normalizePersistedAiModelConfig(userRow?.aiModelConfig);
      const effectiveProvider = agentProvider ?? userAiConfig?.provider ?? null;
      const effectiveLightModel = agentLightModel ?? userAiConfig?.lightModel ?? null;
      const effectiveHeavyModel = agentHeavyModel ?? userAiConfig?.heavyModel ?? null;

      if (!effectiveProvider || !effectiveLightModel || !effectiveHeavyModel) {
        return { kind: 'model_selection_incomplete' as const };
      }

      // Claim the agent atomically (stopped → starting)
      const [claimedAgent] = await tx
        .update(agents)
        .set({
          status: 'starting',
          pauseState: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, agentId),
            eq(agents.userId, userId),
            eq(agents.status, 'stopped'),
          ),
        )
        .returning({ id: agents.id });

      if (!claimedAgent) {
        return { kind: 'not_stopped' as const, status: 'starting' };
      }

      // Stop any active runtime sessions before inserting the new one
      await tx
        .update(agentRuntimeSessions)
        .set({ status: 'stopped', stoppedAt: now })
        .where(
          and(
            eq(agentRuntimeSessions.agentId, agentId),
            inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
          ),
        );

      await tx.insert(agentRuntimeSessions).values({
        id: sessionId,
        agentId,
        status: 'starting',
      });

      return { kind: 'started' as const };
    });

    if (result.kind === 'not_found') {
      return err({ code: 'agent.not_found', message: 'Agent not found' });
    }

    if (result.kind === 'not_stopped') {
      return err({
        code: 'agent.invalid_status',
        message: 'Agent is not stopped',
        currentStatus: result.status,
      });
    }

    if (result.kind === 'model_selection_incomplete') {
      return err({
        code: 'agent.model_selection_incomplete',
        message: 'Agent cannot start — set provider, lightModel, and heavyModel in agent config or user AI settings',
      });
    }

    // Ensure the agent has a published blueprint matching its current config.
    // Loud failure: if sync fails, revert the agent claim and fail the start request.
    const blueprintSyncResult = await ensurePublishedBlueprintForAgent(db, agentId, userId);
    if (!blueprintSyncResult.ok) {
      // Revert the agent claim and runtime session so we don't leave stale state.
      // Use a transaction with status guards: if the worker already claimed the
      // session (starting → launching), we must NOT overwrite that state.
      try {
        await db.transaction(async (tx) => {
          await tx.update(agents)
            .set({ status: 'stopped', updatedAt: new Date() })
            .where(and(eq(agents.id, agentId), eq(agents.status, 'starting')));
          await tx.update(agentRuntimeSessions)
            .set({ status: 'stopped', stoppedAt: new Date() })
            .where(and(eq(agentRuntimeSessions.id, sessionId), eq(agentRuntimeSessions.status, 'starting')));
        });
      } catch (revertErr) {
        // Best-effort logging — don't mask the original blueprint sync failure.
        // Use console.error as a fallback since startAgent() receives db but not a logger.
        console.error(
          'Failed to revert agent claim after blueprint sync failure',
          { err: revertErr, agentId, sessionId },
        );
      }

      const syncErr = blueprintSyncResult.error;
      if (syncErr.code === 'agent.not_found') {
        return err({ code: 'agent.not_found', message: syncErr.message });
      }
      if (syncErr.code === 'agent.not_owned') {
        return err({ code: 'agent.not_owned', message: syncErr.message });
      }
      if (syncErr.code === 'blueprint.skill_portability') {
        return err({ code: 'agent.skill_portability', message: syncErr.message });
      }
      return err({
        code: 'agent.internal_error',
        message: syncErr.message,
      });
    }

    return ok({ status: 'starting', sessionId });
  } catch (cause) {
    return err({
      code: 'agent.internal_error',
      message: cause instanceof Error ? cause.message : 'Unexpected error starting agent',
    });
  }
}

// ── Pause ─────────────────────────────────────────────────────────────────

export async function pauseAgent(
  db: Database,
  agentId: string,
  userId: string,
  reason?: string,
): Promise<Result<{ status: string }, AgentLifecycleError>> {
  try {
    const result = await db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));

      if (!agent) {
        return { kind: 'not_found' as const };
      }

      // Idempotent — already paused
      if (agent.status === 'paused') {
        return { kind: 'already_paused' as const };
      }

      await tx
        .update(agents)
        .set({
          status: 'paused',
          pauseState: {
            reason: reason || 'user_requested',
            requestedBy: 'user',
            pausedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId));

      return { kind: 'paused' as const };
    });

    if (result.kind === 'not_found') {
      return err({ code: 'agent.not_found', message: 'Agent not found' });
    }

    return ok({ status: result.kind === 'already_paused' ? 'paused' : 'paused' });
  } catch (cause) {
    return err({
      code: 'agent.internal_error',
      message: cause instanceof Error ? cause.message : 'Unexpected error pausing agent',
    });
  }
}

// ── Resume ────────────────────────────────────────────────────────────────

export async function resumeAgent(
  db: Database,
  agentId: string,
  userId: string,
): Promise<Result<{ status: string }, AgentLifecycleError>> {
  try {
    const result = await db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));

      if (!agent) {
        return { kind: 'not_found' as const };
      }

      if (agent.status !== 'paused') {
        return { kind: 'not_paused' as const, currentStatus: agent.status };
      }

      await tx
        .update(agents)
        .set({
          status: 'active',
          pauseState: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId));

      return { kind: 'resumed' as const };
    });

    if (result.kind === 'not_found') {
      return err({ code: 'agent.not_found', message: 'Agent not found' });
    }

    if (result.kind === 'not_paused') {
      return err({
        code: 'agent.invalid_status',
        message: 'Agent is not paused',
        currentStatus: result.currentStatus,
      });
    }

    return ok({ status: 'active' });
  } catch (cause) {
    return err({
      code: 'agent.internal_error',
      message: cause instanceof Error ? cause.message : 'Unexpected error resuming agent',
    });
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────

export async function stopAgent(
  db: Database,
  agentId: string,
  userId: string,
): Promise<Result<{ status: string }, AgentLifecycleError>> {
  const now = new Date();

  try {
    const result = await db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));

      if (!agent) return { kind: 'not_found' as const };
      if (agent.status === 'stopped') return { kind: 'already_stopped' as const };

      await tx
        .update(agents)
        .set({ status: 'stopped', pauseState: null, updatedAt: now })
        .where(eq(agents.id, agentId));

      await tx
        .update(agentRuntimeSessions)
        .set({ status: 'stopped', stoppedAt: now })
        .where(
          and(
            eq(agentRuntimeSessions.agentId, agentId),
            inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
          ),
        );

      return { kind: 'stopped' as const };
    });

    if (result.kind === 'not_found') {
      return err({ code: 'agent.not_found', message: 'Agent not found' });
    }

    return ok({ status: 'stopped' });
  } catch (cause) {
    return err({
      code: 'agent.internal_error',
      message: cause instanceof Error ? cause.message : 'Unexpected error stopping agent',
    });
  }
}
