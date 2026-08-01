import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, or, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  blueprints,
  blueprintRevisions,
  blueprintRevisionSkills,
  blueprintInstantiationRequests,
  blueprintUsageEvents,
  bots,
  agents,
  agentSkills,
  connections,
  venueAccounts,
} from '@herobids/db';
import {
  applyPresetToAgent,
  BlueprintErrorCodes,
  BlueprintInstantiatePreviewRequestSchema,
  BlueprintInstantiatePreviewResponseSchema,
  BlueprintInstantiateRequestSchema,
} from '@herobids/domain';
import type {
  AgentRiskDefaultsConfig,
  BlueprintExecutionCapabilityResolver,
  BlueprintExecutionCapabilityInput,
  AgentBlueprintRevisionPayload,
  BotBlueprintRevisionPayload,
} from '@herobids/domain';
import { listPresets, getPreset } from '@herobids/domain/config/presets-loader';
import { computeInstantiateRequestHash } from '../services/blueprint-idempotency.js';
import { resolveEffectiveRisk } from '../services/blueprint-risk-resolver.js';
import { validateSkillPortability } from '../services/blueprint-skill-validator.js';

// --- Request schemas ---

const StyleQuerySchema = z.object({
  style: z.enum(['economy', 'standard', 'premium']).default('standard'),
});

const ForAgentQuerySchema = z.object({
  strategy: z.string().min(1),
  style: z.enum(['economy', 'standard', 'premium']).default('standard'),
  mode: z.enum(['llm', 'hybrid']).default('llm'),
});

// --- Helper ---

/**
 * TODO (Phase 1 Milestone B): Reimplement when legacy CRUD routes are rewritten
 * for the new schema (authorId, publicationStatus, revision payload).
 *
 * Returns the blueprint if the authenticated user owns it, or if it is public.
 */
// async function resolveBlueprintForRead(
//   db: Database,
//   id: string,
//   userId: string,
// ): Promise<typeof blueprints.$inferSelect | null> {
//   const [bp] = await db.select().from(blueprints)
//     .where(and(
//       eq(blueprints.id, id),
//       or(eq(blueprints.userId, userId), eq(blueprints.visibility, 'public')),
//     ));
//   return bp ?? null;
// }

/**
 * TODO (Phase 1 Milestone B): Reimplement when legacy CRUD routes are rewritten.
 *
 * Returns the blueprint only if the authenticated user owns it (for mutations).
 */
// async function resolveBlueprintForWrite(
//   db: Database,
//   id: string,
//   userId: string,
// ): Promise<typeof blueprints.$inferSelect | null> {
//   const [bp] = await db.select().from(blueprints)
//     .where(and(eq(blueprints.id, id), eq(blueprints.userId, userId)));
//   return bp ?? null;
// }

// --- Helpers for new blueprint system ---

/**
 * Resolve the targeted revision for a blueprint access check.
 * Owners/admins can access any revision; nonowners only get publishedRevisionId.
 */
async function resolveTargetRevision(
  db: Database,
  blueprintId: string,
  requestedRevisionId: string | undefined,
  userId: string,
  isAdmin: boolean,
): Promise<{ blueprint: typeof blueprints.$inferSelect; revision: typeof blueprintRevisions.$inferSelect } | { error: string; code: string }> {
  const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, blueprintId));
  if (!bp) return { error: 'Blueprint not found', code: BlueprintErrorCodes.NOT_FOUND };

  const isOwner = bp.authorId === userId;

  // Delisted/archived → all new operations blocked
  if (bp.publicationStatus === 'delisted' || bp.publicationStatus === 'archived') {
    if (!isOwner && !isAdmin) return { error: 'Blueprint not found', code: BlueprintErrorCodes.NOT_FOUND };
    return { error: 'Blueprint is delisted or archived', code: BlueprintErrorCodes.LIFECYCLE_CONFLICT };
  }

  // Nonowners can only access published blueprints
  if (!isOwner && !isAdmin && bp.publicationStatus !== 'published') {
    return { error: 'Blueprint not found', code: BlueprintErrorCodes.NOT_FOUND };
  }

  // Resolve the revision to use
  let revisionId: string;
  if (requestedRevisionId) {
    // Owner/admin can pick any revision; nonowner gets only publishedRevisionId
    if (!isOwner && !isAdmin) {
      if (requestedRevisionId !== bp.publishedRevisionId) {
        return { error: 'Blueprint not found', code: BlueprintErrorCodes.NOT_FOUND };
      }
    }
    revisionId = requestedRevisionId;
  } else {
    // No revision specified: nonowners get published, owners get current
    if (!isOwner && !isAdmin) {
      if (!bp.publishedRevisionId) {
        return { error: 'Blueprint not published', code: BlueprintErrorCodes.NOT_FOUND };
      }
      revisionId = bp.publishedRevisionId;
    } else {
      if (!bp.currentRevisionId) {
        return { error: 'Blueprint has no revision', code: BlueprintErrorCodes.NOT_FOUND };
      }
      revisionId = bp.currentRevisionId;
    }
  }

  const [revision] = await db.select().from(blueprintRevisions).where(eq(blueprintRevisions.id, revisionId));
  if (!revision) return { error: 'Revision not found', code: BlueprintErrorCodes.NOT_FOUND };
  if (revision.blueprintId !== blueprintId) {
    return { error: 'Revision does not belong to this blueprint', code: BlueprintErrorCodes.VALIDATION };
  }

  return { blueprint: bp, revision };
}

/**
 * Determine if a blueprint revision represents a trading-capable agent.
 * Trading-capable means: the agent has a strategy set (non-null) and
 * executionDefaults set (non-null).
 */
function isTradingCapable(payload: Record<string, unknown>): boolean {
  return payload.strategy != null && payload.executionDefaults != null;
}

/**
 * Extract skill refs from the blueprint revision's associated skills.
 */
async function getRevisionSkillRefs(
  db: Database,
  revisionId: string,
): Promise<Array<{ skillId: string; skillRevisionId: string }>> {
  const rows = await db
    .select({
      skillId: blueprintRevisionSkills.skillId,
      skillRevisionId: blueprintRevisionSkills.skillRevisionId,
    })
    .from(blueprintRevisionSkills)
    .where(eq(blueprintRevisionSkills.blueprintRevisionId, revisionId))
    .orderBy(blueprintRevisionSkills.orderIndex);
  return rows;
}

/**
 * Fields whose values are nested objects and should be deep-merged
 * when applying installer edits, rather than shallow-replaced.
 */
const DEEP_MERGE_FIELDS = new Set([
  'risk',
  'executionPolicy',
  'executionDefaults',
  'runtimePolicyOverrides',
  'tokenSafety',
  'toolPolicy',
  'modelPolicy',
  'allowedPresets',
  'presetTransition',
  'platformAssessment',
  'wakePreferences',
]);

/**
 * Deep-merge installer edits into a base payload.
 * For fields in DEEP_MERGE_FIELDS, merges the edit object into the base object
 * (installer fields override, other base fields preserved).
 * For all other fields, shallow-replaces with the edit value.
 */
function deepMergeEdits(
  basePayload: Record<string, unknown>,
  edits: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...basePayload };
  for (const key of Object.keys(edits)) {
    if (key === 'kind') continue; // kind is immutable
    const editVal = edits[key];
    if (editVal === undefined) continue;

    if (
      DEEP_MERGE_FIELDS.has(key) &&
      typeof editVal === 'object' &&
      editVal !== null &&
      !Array.isArray(editVal) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      // Deep merge: installer fields override, other base fields preserved
      result[key] = {
        ...(result[key] as Record<string, unknown>),
        ...(editVal as Record<string, unknown>),
      };
    } else {
      result[key] = editVal;
    }
  }
  return result;
}

// --- Route module ---

export async function blueprintRoutes(
  app: FastifyInstance,
  db: Database,
  agentRiskDefaults: AgentRiskDefaultsConfig,
  executionCapabilityResolver: BlueprintExecutionCapabilityResolver,
): Promise<void> {
  // GET /blueprints/presets — list available strategy presets for a style
  // Registered before /:id so Fastify doesn't swallow it as a param.
  app.get('/blueprints/presets', async (req, reply) => {
    const parsed = StyleQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }
    const presets = listPresets(parsed.data.style);
    return reply.send({ presets });
  });

  // GET /blueprints/defaults — default strategy/risk/execution from the standard momentum preset
  app.get('/blueprints/defaults', async (_request, reply) => {
    const defaultPreset = getPreset('momentum', 'standard');
    if (!defaultPreset) {
      return reply.status(500).send({ error: 'internal_error', message: 'Default preset not found' });
    }
    const defaults = {
      strategy: defaultPreset.strategy,
      risk: defaultPreset.risk ?? {},
      execution: defaultPreset.execution ?? { mode: 'paper' },
    };
    return reply.send({ defaults });
  });

  // TODO (Phase 1 Milestone B): POST /blueprints/from-preset — create a blueprint pre-populated from a YAML preset.
  // Stubbed — old schema columns (userId, configData, configVersion, visibility) no longer exist.
  app.post<{ Body: unknown }>('/blueprints/from-preset', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B using the new blueprint schema (authorId, revisions, publicationStatus).',
    });
  });

  // GET /presets/for-agent — return preset split into agent-consumable sections
  // Registered before /:id so Fastify doesn't swallow it as a param.
  app.get('/presets/for-agent', async (req, reply) => {
    const parsed = ForAgentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }
    // Reject DCA at the API boundary — DCA is bot-only.
    if (parsed.data.strategy === 'dca') {
      return reply.status(400).send({
        error: 'preset_not_supported_for_agent',
        message: 'DCA is a bot-only strategy and cannot be applied to agents.',
      });
    }

    const preset = getPreset(parsed.data.strategy, parsed.data.style);
    if (!preset) {
      return reply.status(404).send({
        error: 'preset_not_found',
        message: `Preset "${parsed.data.strategy}" not found for style "${parsed.data.style}"`,
      });
    }
    const split = applyPresetToAgent(parsed.data.strategy, preset, parsed.data.style, parsed.data.mode);
    return reply.send(split);
  });

  // TODO (Phase 1 Milestone B): GET /blueprints — list user's own blueprints.
  // Stubbed — old schema column `userId` no longer exists; replaced by `authorId`.
  app.get('/blueprints', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B using the new blueprint schema with browse/sort/pagination.',
    });
  });

  // TODO (Phase 1 Milestone B): POST /blueprints — create a new blueprint.
  // Stubbed — old schema columns (userId, configData, configVersion, visibility) no longer exist.
  // Replacement in Milestone B will use POST /blueprints with BlueprintRevisionPayloadSchema.
  app.post<{ Body: unknown }>('/blueprints', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B using the new revision-based schema.',
    });
  });

  // TODO (Phase 1 Milestone B): GET /blueprints/:id — get a single blueprint (owned or public).
  // Stubbed — uses removed helper resolveBlueprintForRead (old userId/visibility columns).
  app.get<{ Params: { id: string } }>('/blueprints/:id', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B using the new schema (authorId, publicationStatus, revision payload).',
    });
  });

  // TODO (Phase 1 Milestone B): PUT /blueprints/:id — update blueprint.
  // Stubbed — old schema columns (configVersion, configData, userId) no longer exist.
  // Replacement will use blueprint revisions instead of in-place config mutation.
  app.put<{ Params: { id: string }; Body: unknown }>('/blueprints/:id', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B using revision-based editing.',
    });
  });

  // TODO (Phase 1 Milestone B): DELETE /blueprints/:id — delete blueprint.
  // Stubbed — uses removed helper resolveBlueprintForWrite (old userId column).
  app.delete<{ Params: { id: string } }>('/blueprints/:id', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B with lifecycle-based deletion.',
    });
  });

  // TODO (Phase 1 Milestone B): POST /blueprints/:id/clone — create an independent copy.
  // Stubbed — old schema columns (userId, configData, configVersion, visibility) no longer exist.
  // Replacement in Milestone B will use POST /blueprints/:id/fork with Idempotency-Key.
  app.post<{ Params: { id: string } }>('/blueprints/:id/clone', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B as POST /blueprints/:id/fork.',
    });
  });

  // TODO (Phase 1 Milestone B): POST /blueprints/:id/publish — set visibility to public.
  // Stubbed — old schema column `visibility` replaced by `publicationStatus`.
  app.post<{ Params: { id: string } }>('/blueprints/:id/publish', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B using publicationStatus lifecycle transitions.',
    });
  });

  // TODO (Phase 1 Milestone B): POST /blueprints/:id/unpublish — set visibility to private.
  // Stubbed — old schema column `visibility` replaced by `publicationStatus`.
  app.post<{ Params: { id: string } }>('/blueprints/:id/unpublish', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B using publicationStatus lifecycle transitions.',
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1 Marketplace: Preview & Confirmation
  // ─────────────────────────────────────────────────────────────────────────

  // POST /blueprints/:blueprintId/instantiate/preview
  // Read-only preview — writes NOTHING to DB.
  app.post<{ Params: { blueprintId: string }; Body: unknown }>(
    '/blueprints/:blueprintId/instantiate/preview',
    async (request, reply) => {
      const parsed = BlueprintInstantiatePreviewRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: BlueprintErrorCodes.VALIDATION,
          details: parsed.error.issues,
        });
      }

      const resolved = await resolveTargetRevision(
        db,
        request.params.blueprintId,
        parsed.data.revisionId,
        request.userId,
        request.isAdmin,
      );
      if ('error' in resolved) {
        const status = resolved.code === BlueprintErrorCodes.NOT_FOUND ? 404
          : resolved.code === BlueprintErrorCodes.LIFECYCLE_CONFLICT ? 409
          : 400;
        return reply.status(status).send({ error: resolved.code, message: resolved.error });
      }

      const { blueprint: bp, revision } = resolved;
      const rawPayload = revision.payload as Record<string, unknown>;
      const isTrading = isTradingCapable(rawPayload);

      // Build the preview payload — deep-merge installer edits into the raw payload
      let editablePayload: Record<string, unknown>;
      if (parsed.data.edits) {
        editablePayload = deepMergeEdits(rawPayload, parsed.data.edits as Record<string, unknown>);
      } else {
        editablePayload = { ...rawPayload };
      }

      // Extract raw risk
      const rawRisk = (rawPayload.risk as Record<string, unknown> | null | undefined) ?? null;

      // Resolve effective risk
      const installerRiskEdits = parsed.data.edits?.risk as Record<string, unknown> | undefined;
      const effectiveRisk = resolveEffectiveRisk(
        rawRisk as import('@herobids/domain').RiskPosture | null,
        (installerRiskEdits ?? null) as Partial<import('@herobids/domain').RiskPosture> | null,
        agentRiskDefaults,
      );

      // Resolve execution mode
      const agentPayload = rawPayload as AgentBlueprintRevisionPayload;
      const botPayload = rawPayload as BotBlueprintRevisionPayload;

      const capabilityInput: BlueprintExecutionCapabilityInput = {
        kind: bp.kind as 'agent' | 'bot',
        tradingCapable: isTrading,
        executionDefaults: agentPayload.executionDefaults ?? botPayload.executionDefaults ?? null,
        venue: botPayload.venue ?? (rawPayload.venue as string | null) ?? null,
        venueType: bp.venueType as 'orderbook' | 'swap' | null,
        swapAssets: botPayload.swapAssets ?? null,
        requestedMode: (parsed.data.requestedMode ?? null) as 'paper' | 'shadow' | 'live' | null,
        liveOptIn: parsed.data.liveOptIn ?? false,
        binding: parsed.data.bindings
          ? (parsed.data.bindings as { kind: 'agent'; connectionIds: string[] } | { kind: 'bot'; connectionId: string; venueAccountId: string })
          : null,
      };

      const capResult = await executionCapabilityResolver.resolve(capabilityInput);

      // Collect warnings
      const warnings: string[] = [...capResult.warnings];

      // Required private inputs
      const requiredPrivateInputs: string[] = [];
      if (isTrading && bp.kind === 'agent') {
        // Check if binding connections need validation
        if (capResult.resolvedMode === 'live' || capResult.resolvedMode === 'shadow') {
          const bindingIds = parsed.data.bindings &&
            'connectionIds' in parsed.data.bindings
            ? (parsed.data.bindings as { connectionIds: string[] }).connectionIds
            : [];
          if (bindingIds.length === 0) {
            requiredPrivateInputs.push('connectionIds: at least one active trading connection required for shadow/live');
          }
        }
      } else if (isTrading && bp.kind === 'bot') {
        if (!parsed.data.bindings || !('connectionId' in parsed.data.bindings)) {
          requiredPrivateInputs.push('connectionId: exactly one active connection required for bot');
          requiredPrivateInputs.push('venueAccountId: exactly one venue account required for bot');
        }
      }

      const compatibleExecutionModes: string[] = [];
      if (!isTrading) {
        // No execution modes for non-trading
      } else if (bp.venueType === 'swap') {
        compatibleExecutionModes.push('shadow', 'live');
      } else {
        compatibleExecutionModes.push('paper', 'shadow', 'live');
      }

      const response = {
        blueprintId: bp.id,
        revisionId: revision.id,
        kind: bp.kind,
        rawPayload: editablePayload,
        rawRisk,
        effectiveRisk,
        requiredPrivateInputs,
        compatibleExecutionModes,
        selectedResolvedMode: capResult.resolvedMode,
        validationWarnings: [...warnings, ...capResult.errors],
      };

      // Validate response shape
      const responseParsed = BlueprintInstantiatePreviewResponseSchema.safeParse(response);
      if (!responseParsed.success) {
        return reply.status(500).send({
          error: 'internal_error',
          message: 'Preview response validation failed',
          details: responseParsed.error.issues,
        });
      }

      return reply.send(responseParsed.data);
    },
  );

  // POST /blueprints/:blueprintId/instantiate
  // Idempotent confirmation — creates a STOPPED actor with attribution.
  app.post<{ Params: { blueprintId: string }; Body: unknown }>(
    '/blueprints/:blueprintId/instantiate',
    async (request, reply) => {
      // 1. Validate Idempotency-Key header
      const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? '';
      const trimmedKey = idempotencyKey.trim();
      if (trimmedKey.length < 1 || trimmedKey.length > 200) {
        return reply.status(400).send({
          error: BlueprintErrorCodes.VALIDATION,
          message: 'Idempotency-Key header must be 1-200 printable ASCII characters',
        });
      }
      // Validate printable ASCII only
      if (!/^[\x20-\x7E]+$/.test(trimmedKey)) {
        return reply.status(400).send({
          error: BlueprintErrorCodes.VALIDATION,
          message: 'Idempotency-Key must contain only printable ASCII characters',
        });
      }

      // 2. Parse request body
      const parsed = BlueprintInstantiateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: BlueprintErrorCodes.VALIDATION,
          details: parsed.error.issues,
        });
      }

      // 3. Resolve the blueprint + revision
      const resolved = await resolveTargetRevision(
        db,
        request.params.blueprintId,
        parsed.data.revisionId,
        request.userId,
        request.isAdmin,
      );
      if ('error' in resolved) {
        const status = resolved.code === BlueprintErrorCodes.NOT_FOUND ? 404
          : resolved.code === BlueprintErrorCodes.LIFECYCLE_CONFLICT ? 409
          : 400;
        return reply.status(status).send({ error: resolved.code, message: resolved.error });
      }

      const { blueprint: bp, revision } = resolved;
      const rawPayload = revision.payload as Record<string, unknown>;
      const isTrading = isTradingCapable(rawPayload);

      // 4. Compute request hash
      const binding = parsed.data.bindings;
      const bindingIds = binding
        ? binding.kind === 'bot'
          ? [binding.connectionId, binding.venueAccountId].sort()
          : [...new Set(binding.connectionIds)].sort()
        : null;
      const requestHash = computeInstantiateRequestHash({
        operation: 'instantiate',
        blueprintId: bp.id,
        revisionId: revision.id,
        kind: bp.kind,
        edits: (parsed.data.edits ?? null) as Record<string, unknown> | null,
        bindingIds,
        requestedMode: parsed.data.requestedMode ?? null,
        liveOptIn: parsed.data.liveOptIn ?? null,
      });

      // 5. Take advisory lock and check idempotency
      const lockKey = `instantiate:${request.userId}:${trimmedKey}`;
      const actorId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      const instantiationReqId = crypto.randomUUID();
      const now = new Date();

      const result = await db.transaction(async (tx) => {
        // Advisory lock serializes per (userId, idempotencyKey)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
        );

        // Check for existing completed request
        const [existing] = await tx
          .select()
          .from(blueprintInstantiationRequests)
          .where(
            and(
              eq(blueprintInstantiationRequests.userId, request.userId),
              eq(blueprintInstantiationRequests.idempotencyKey, trimmedKey),
            ),
          );

        if (existing) {
          if (existing.requestHash === requestHash) {
            // Same hash → return stored response immediately
            return {
              kind: 'idempotent_replay' as const,
              actorId: existing.actorId,
              actorKind: existing.actorKind,
              responsePayload: existing.responsePayload,
            };
          }
          // Different hash → conflict
          return { kind: 'idempotency_conflict' as const };
        }

        // 6. Re-lock blueprint row and recheck access
        const [lockedBp] = await tx
          .select()
          .from(blueprints)
          .where(eq(blueprints.id, bp.id))
          .for('update');

        if (!lockedBp) {
          return { kind: 'error' as const, code: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' };
        }

        // Recheck lifecycle (delisted/archived)
        if (lockedBp.publicationStatus === 'delisted' || lockedBp.publicationStatus === 'archived') {
          return {
            kind: 'error' as const,
            code: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
            message: 'Blueprint is delisted or archived',
          };
        }

        // 7. Revalidate skill portability (for agents with skill deps)
        if (bp.kind === 'agent') {
          const skillRefs = await getRevisionSkillRefs(tx as unknown as Database, revision.id);
          if (skillRefs.length > 0) {
            const portability = await validateSkillPortability(skillRefs, tx as unknown as Database);
            if (!portability.valid) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.DEPENDENCY_UNAVAILABLE,
                message: portability.errors.join('; '),
              };
            }
          }
        }

        // 8. Validate bindings
        if (parsed.data.bindings) {
          if (parsed.data.bindings.kind === 'agent' && 'connectionIds' in parsed.data.bindings) {
            const connIds = [...new Set(parsed.data.bindings.connectionIds)];
            if (connIds.length > 0) {
              // Query each connection individually to validate ownership and status
              for (const cid of connIds) {
                const [conn] = await tx
                  .select({ id: connections.id, userId: connections.userId, status: connections.status })
                  .from(connections)
                  .where(eq(connections.id, cid));
                if (!conn) {
                  return {
                    kind: 'error' as const,
                    code: BlueprintErrorCodes.VALIDATION,
                    message: `Connection ${cid} not found`,
                  };
                }
                if (conn.status !== 'active') {
                  return {
                    kind: 'error' as const,
                    code: BlueprintErrorCodes.VALIDATION,
                    message: `Connection ${cid} is not active`,
                  };
                }
                if (conn.userId !== request.userId) {
                  return {
                    kind: 'error' as const,
                    code: BlueprintErrorCodes.FORBIDDEN,
                    message: `Connection ${cid} does not belong to you`,
                  };
                }
              }
            }
          } else if (parsed.data.bindings.kind === 'bot') {
            const { connectionId, venueAccountId } = parsed.data.bindings as {
              kind: 'bot'; connectionId: string; venueAccountId: string;
            };
            const [conn] = await tx
              .select({ id: connections.id, userId: connections.userId, status: connections.status })
              .from(connections)
              .where(eq(connections.id, connectionId));
            if (!conn) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.VALIDATION,
                message: `Connection ${connectionId} not found`,
              };
            }
            if (conn.status !== 'active') {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.VALIDATION,
                message: `Connection ${connectionId} is not active`,
              };
            }
            if (conn.userId !== request.userId) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.FORBIDDEN,
                message: `Connection ${connectionId} does not belong to you`,
              };
            }
            const [va] = await tx
              .select({ id: venueAccounts.id, userId: venueAccounts.userId })
              .from(venueAccounts)
              .where(eq(venueAccounts.id, venueAccountId));
            if (!va) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.VALIDATION,
                message: `Venue account ${venueAccountId} not found`,
              };
            }
            if (va.userId !== request.userId) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.FORBIDDEN,
                message: `Venue account ${venueAccountId} does not belong to you`,
              };
            }
          }
        }

        // 9. Resolve execution capability
        const agentPayload = rawPayload as AgentBlueprintRevisionPayload;
        const botPayload = rawPayload as BotBlueprintRevisionPayload;
        const capabilityInput: BlueprintExecutionCapabilityInput = {
          kind: bp.kind as 'agent' | 'bot',
          tradingCapable: isTrading,
          executionDefaults: agentPayload.executionDefaults ?? botPayload.executionDefaults ?? null,
          venue: botPayload.venue ?? (rawPayload.venue as string | null) ?? null,
          venueType: bp.venueType as 'orderbook' | 'swap' | null,
          swapAssets: botPayload.swapAssets ?? null,
          requestedMode: (parsed.data.requestedMode ?? null) as 'paper' | 'shadow' | 'live' | null,
          liveOptIn: parsed.data.liveOptIn ?? false,
          binding: parsed.data.bindings
            ? (parsed.data.bindings as { kind: 'agent'; connectionIds: string[] } | { kind: 'bot'; connectionId: string; venueAccountId: string })
            : null,
        };
        const capResult = await executionCapabilityResolver.resolve(capabilityInput);
        if (capResult.errors.length > 0) {
          return {
            kind: 'error' as const,
            code: BlueprintErrorCodes.VALIDATION,
            message: capResult.errors.join('; '),
          };
        }

        // H2: If the caller pinned an expected mode from preview, reject if re-resolution differs
        if (parsed.data.expectedMode && parsed.data.expectedMode !== capResult.resolvedMode) {
          return {
            kind: 'error' as const,
            code: BlueprintErrorCodes.MODE_CHANGED,
            message: `Resolved mode changed from ${parsed.data.expectedMode} to ${capResult.resolvedMode}. Re-run preview.`,
          };
        }

        // 10. Apply installer edits to produce final payload (deep-merge for object fields)
        let finalPayload: Record<string, unknown>;
        if (parsed.data.edits) {
          finalPayload = deepMergeEdits(rawPayload, parsed.data.edits as Record<string, unknown>);
        } else {
          finalPayload = { ...rawPayload };
        }

        // 11. Resolve effective risk and validate against operator ceilings
        const rawRisk = (rawPayload.risk as Record<string, unknown> | null | undefined) ?? null;
        const installerRiskEdits = parsed.data.edits?.risk as Record<string, unknown> | undefined;
        const effectiveRisk = resolveEffectiveRisk(
          rawRisk as import('@herobids/domain').RiskPosture | null,
          (installerRiskEdits ?? null) as Partial<import('@herobids/domain').RiskPosture> | null,
          agentRiskDefaults,
        );
        // Reject if any user-provided risk value exceeds the operator ceiling
        for (const [fieldKey, fieldVal] of Object.entries(effectiveRisk)) {
          const f = fieldVal as import('@herobids/domain').EffectiveRiskField;
          if (f.enforced && f.rawValue != null && f.effectiveValue != null && f.rawValue > f.effectiveValue) {
            return {
              kind: 'error' as const,
              code: BlueprintErrorCodes.VALIDATION,
              message: `Risk field "${fieldKey}" (${f.rawValue}) exceeds operator ceiling (${f.operatorCeiling}). Clamped to ${f.effectiveValue}.`,
            };
          }
        }

        // 12. Create STOPPED agent or bot with blueprint attribution
        if (bp.kind === 'agent') {
          const agentPayloadFinal = finalPayload as AgentBlueprintRevisionPayload;

          // Build unifiedConfig from blueprint agent fields that map to UnifiedAgentConfig
          const unifiedConfig: Record<string, unknown> = {};
          if (agentPayloadFinal.technical) unifiedConfig.technical = agentPayloadFinal.technical;
          if (agentPayloadFinal.intelligence) unifiedConfig.intelligence = agentPayloadFinal.intelligence;
          unifiedConfig.capabilityMode = agentPayloadFinal.capabilityMode;
          if (agentPayloadFinal.hybridMode) unifiedConfig.hybridMode = agentPayloadFinal.hybridMode;
          if (agentPayloadFinal.executionPolicy) {
            unifiedConfig.execution = {
              positionSizeMode: agentPayloadFinal.executionPolicy.positionSizeMode,
              fixedPositionSize: agentPayloadFinal.executionPolicy.fixedPositionSize,
            };
          }
          if (agentPayloadFinal.executionDefaults) {
            unifiedConfig.execution = {
              ...(unifiedConfig.execution as Record<string, unknown> ?? {}),
              mode: agentPayloadFinal.executionDefaults.mode,
            };
          }
          // Risk goes into unifiedConfig.risk (separate from direct risk column)
          if (finalPayload.risk) {
            unifiedConfig.risk = finalPayload.risk;
          }
          if (agentPayloadFinal.allowedPresets) unifiedConfig.allowedPresets = agentPayloadFinal.allowedPresets;
          if (agentPayloadFinal.presetTransition) unifiedConfig.presetTransition = agentPayloadFinal.presetTransition;
          if (agentPayloadFinal.platformAssessment) unifiedConfig.platformAssessment = agentPayloadFinal.platformAssessment;
          unifiedConfig.authorizationMode = agentPayloadFinal.authorizationMode ?? 'direct';

          await tx.insert(agents).values({
            id: actorId,
            userId: request.userId,
            name: agentPayloadFinal.name ?? bp.name,
            prompt: agentPayloadFinal.prompt ?? '',
            style: agentPayloadFinal.style,
            status: 'stopped',
            risk: (finalPayload.risk as import('@herobids/domain').RiskPosture) ?? null,
            strategy: agentPayloadFinal.strategy ?? null,
            executionDefaults: agentPayloadFinal.executionDefaults ?? null,
            capital: agentPayloadFinal.capital ?? null,
            maxBots: agentPayloadFinal.maxBots ?? null,
            tickIntervalMs: agentPayloadFinal.tickIntervalMs ?? null,
            toolPolicy: (agentPayloadFinal.toolPolicy as Record<string, unknown>) ?? null,
            modelPolicy: (agentPayloadFinal.modelPolicy as Record<string, unknown>) ?? null,
            openPositionEscalationToJudgePolicy: agentPayloadFinal.openPositionEscalationToJudgePolicy ?? 'uncovered_or_triggered',
            blueprintId: bp.id,
            blueprintRevisionId: revision.id,
            runtimePolicyOverrides: agentPayloadFinal.runtimePolicyOverrides ?? null,
            wakePreferences: agentPayloadFinal.wakePreferences ?? null,
            unifiedConfig: Object.keys(unifiedConfig).length > 0 ? unifiedConfig : null,
          } as typeof agents.$inferInsert);

          // Insert agent_skills rows
          const skillRefs = await getRevisionSkillRefs(tx as unknown as Database, revision.id);
          if (skillRefs.length > 0) {
            await tx.insert(agentSkills).values(
              skillRefs.map((s, i) => ({
                agentId: actorId,
                skillId: s.skillId,
                skillRevisionId: s.skillRevisionId,
                orderIndex: i,
                assignedByUserId: request.userId,
                assignmentSource: 'blueprint_instantiate',
              })),
            );
          }
        } else {
          // Bot creation
          const botPayloadFinal = finalPayload as BotBlueprintRevisionPayload;
          const binding = parsed.data.bindings as { kind: 'bot'; connectionId: string; venueAccountId: string };

          // Build bot config from payload
          const botConfig: Record<string, unknown> = {
            strategy: botPayloadFinal.strategy,
            risk: botPayloadFinal.risk,
            execution: {
              mode: capResult.resolvedMode ?? 'paper',
              slippageBps: botPayloadFinal.executionDefaults?.slippageBps,
            },
            tokenSafety: botPayloadFinal.tokenSafety,
            venue: botPayloadFinal.venue,
            venueType: botPayloadFinal.venueType,
            symbol: botPayloadFinal.symbol,
            swapAssets: botPayloadFinal.swapAssets,
            shadowPollIntervalMs: botPayloadFinal.shadowPollIntervalMs,
          };

          await tx.insert(bots).values({
            id: actorId,
            userId: request.userId,
            venueAccountId: binding.venueAccountId,
            connectionId: binding.connectionId,
            config: botConfig,
            blueprintId: bp.id,
            blueprintRevisionId: revision.id,
            configSnapshot: finalPayload,
            status: 'stopped',
            creatorType: 'user',
            creatorId: request.userId,
          } as typeof bots.$inferInsert);
        }

        // 13. Insert idempotency result
        const responsePayload: Record<string, unknown> = {
          actorId,
          actorKind: bp.kind,
          blueprintId: bp.id,
          blueprintRevisionId: revision.id,
          status: 'stopped',
          createdAt: now.toISOString(),
        };
        await tx.insert(blueprintInstantiationRequests).values({
          id: instantiationReqId,
          userId: request.userId,
          idempotencyKey: trimmedKey,
          requestHash,
          blueprintId: bp.id,
          blueprintRevisionId: revision.id,
          actorKind: bp.kind,
          actorId,
          responsePayload,
        });

        // 14. Emit usage event
        await tx.insert(blueprintUsageEvents).values({
          id: eventId,
          blueprintId: bp.id,
          blueprintRevisionId: revision.id,
          userId: request.userId,
          subjectKind: bp.kind,
          subjectId: actorId,
          eventType: 'instance_created',
          isSelfUsage: bp.authorId === request.userId,
          occurredAt: now,
          metadata: {
            idempotencyKey: trimmedKey,
            resolvedMode: capResult.resolvedMode,
          },
        });

        return {
          kind: 'created' as const,
          actorId,
          actorKind: bp.kind,
          responsePayload,
        };
      });

      // Handle transaction result
      if (result.kind === 'idempotent_replay') {
        return reply.status(200).send(result.responsePayload);
      }
      if (result.kind === 'idempotency_conflict') {
        return reply.status(409).send({
          error: BlueprintErrorCodes.IDEMPOTENCY_CONFLICT,
          message: 'Different request body for the same idempotency key',
        });
      }
      if (result.kind === 'error') {
        const status = result.code === BlueprintErrorCodes.NOT_FOUND ? 404
          : result.code === BlueprintErrorCodes.FORBIDDEN ? 403
          : result.code === BlueprintErrorCodes.DEPENDENCY_UNAVAILABLE ? 400
          : result.code === BlueprintErrorCodes.LIFECYCLE_CONFLICT ? 409
          : result.code === BlueprintErrorCodes.MODE_CHANGED ? 409
          : 400;
        return reply.status(status).send({ error: result.code, message: result.message });
      }

      return reply.status(201).send(result.responsePayload);
    },
  );
}
