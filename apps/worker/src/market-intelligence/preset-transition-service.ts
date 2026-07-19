import type { Database } from '@herobids/db';
import {
  agents,
  agentPresetBindings,
  agentPresetTransitions,
  marketAssessmentArtifacts,
} from '@herobids/db';
import { eq, and } from 'drizzle-orm';
import {
  ok,
  err,
  isArtifactFresh,
  computePresetBehaviorVersion,
  isStyleKey,
  type Result,
  type StyleKey,
  type PresetTransitionPort,
  type RecommendTransitionParams,
  type ApplyTransitionParams,
  type PresetTransitionRecommendation,
  type PresetTransitionApplicationResult,
  type PreparedPresetTransition,
  type ActivePresetBinding,
  type TransitionMode,
} from '@herobids/domain';
import { getPreset } from '@herobids/domain/config/presets-loader';
import { createLogger } from '../logger.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('preset-transition-service');

/**
 * Dependencies for the {@link PresetTransitionService}.
 *
 * `notifyActor` is optional — when absent (e.g. tests, agent not running),
 * the service assumes the actor acknowledged the reload.
 *
 * The callback materializes the effective config from the resolved binding
 * and applies it to the running actor via the existing config-application
 * path. It returns ok(undefined) on success or err on failure.
 */
export interface PresetTransitionServiceDeps {
  db: Database;
  /**
   * Notify the running actor to reload its binding/config.
   *
   * @param agentId   — the agent whose actor should be reloaded
   * @param activePresetKey — the new preset key (e.g. "momentum")
   * @param styleTier — the style tier of the new preset
   * @param behaviorVersion — computed behavior version of the new preset
   * @returns ok(undefined) when the actor acknowledged the reload,
   *          err with code + message on failure.
   */
  notifyActor?: (
    agentId: string,
    activePresetKey: string,
    styleTier: StyleKey,
    behaviorVersion: string,
  ) => Promise<Result<void>>;
}

/**
 * Worker-owned service that implements {@link PresetTransitionPort}.
 *
 * Two public operations:
 * - {@link recommendTransition}: read-only analysis of an assessment artifact
 *   against the agent's current binding and policy.
 * - {@link applyTransition}: durable mutation following the state machine
 *   `prepared → applying → applied | deferred | rejected | failed | partially_applied`.
 *
 * The 7-step internal process (load artifact → resolve binding → verify policy →
 * prepare → persist intent → apply config → acknowledge) is encapsulated here.
 *
 * Phase 1 only produces 'applied' and 'failed' terminal states.
 * 'deferred', 'rejected', and 'partially_applied' are reserved for
 * future modes (entries_and_tighten_existing with position actions, etc.).
 *
 * TODO(M3): Restart reconciliation of `applying`-state transitions is not yet
 * implemented. If the worker crashes or restarts while a transition is in the
 * `applying` state, that row may be left stranded. A follow-on slice should
 * add a startup recovery pass that reaps or retries `applying` transitions
 * that exceed a timeout threshold.
 */
export class PresetTransitionService implements PresetTransitionPort {
  constructor(private readonly deps: PresetTransitionServiceDeps) {}

  // ── recommendTransition (read-only) ───────────────────────────────────

  async recommendTransition(
    params: RecommendTransitionParams,
  ): Promise<Result<PresetTransitionRecommendation>> {
    const { agentId, assessmentArtifactId } = params;

    // Step 1: Load and validate the exact artifact
    const [artifact] = await this.deps.db
      .select()
      .from(marketAssessmentArtifacts)
      .where(eq(marketAssessmentArtifacts.id, assessmentArtifactId))
      .limit(1);

    if (!artifact) {
      return err({
        code: 'transition.artifact_not_found',
        message: `Artifact ${assessmentArtifactId} not found`,
      });
    }
    if (!isArtifactFresh({ status: artifact.status, expiresAt: artifact.expiresAt.toISOString() })) {
      return err({
        code: 'transition.artifact_expired',
        message: 'Assessment artifact has expired or been superseded',
      });
    }

    // Step 2: Resolve agent's current binding and policy
    const bindingResult = await this.resolveCurrentBinding(agentId, 'default');
    const currentPresetKey = bindingResult.ok ? bindingResult.data.activePresetKey : 'none';

    const [agentRow] = await this.deps.db
      .select({ unifiedConfig: agents.unifiedConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agentRow) {
      return err({
        code: 'transition.agent_not_found',
        message: `Agent ${agentId} not found`,
      });
    }

    const unifiedConfig = agentRow.unifiedConfig;
    const allowedPresets = unifiedConfig?.allowedPresets;
    const presetTransition = unifiedConfig?.presetTransition;

    // Step 3: Verify artifact candidate set compatibility
    const presetRankings = artifact.presetRankings;
    const topRanked = presetRankings[0];

    if (!topRanked) {
      return ok({
        recommendedPreset: null,
        confidence: 0,
        reasoningSummary: 'No presets ranked in this assessment artifact.',
        transitionMode: 'entries_only',
        preparedTransition: null,
      });
    }

    // Check against allowedPresets policy (NOT LLM score cutoff — deterministic policy only)
    const isAllowed =
      !allowedPresets?.allowed ||
      allowedPresets.allowed.length === 0 ||
      allowedPresets.allowed.includes(topRanked.presetKey);

    if (!isAllowed) {
      return ok({
        recommendedPreset: null,
        confidence: 0,
        reasoningSummary: `Top-ranked preset "${topRanked.presetKey}" is not in the agent's allowed presets policy.`,
        transitionMode: 'entries_only',
        preparedTransition: null,
      });
    }

    // Determine transition mode from agent policy
    const transitionMode: TransitionMode =
      (presetTransition?.allowedTransitionModes?.[0] as TransitionMode | undefined) ?? 'entries_only';

    // Already on the recommended preset — no transition needed
    if (topRanked.presetKey === currentPresetKey) {
      return ok({
        recommendedPreset: null,
        confidence: 0,
        reasoningSummary: `Agent is already on the recommended preset "${topRanked.presetKey}".`,
        transitionMode,
        preparedTransition: null,
      });
    }

    // Step 4: Build PreparedPresetTransition
    const oldBinding = bindingResult.ok ? bindingResult.data : null;

    // Validate and normalize the style tier from the artifact.
    const styleTier: StyleKey = isStyleKey(artifact.styleTier) ? artifact.styleTier : 'standard';
    const newBehaviorVersion = this.computeTargetBehaviorVersion(topRanked.presetKey, styleTier) ?? 'unknown';

    const prepared: PreparedPresetTransition = {
      agentId,
      assessmentArtifactId: artifact.id,
      targetPreset: topRanked.presetKey,
      transitionMode,
      reason: null,
      oldBinding,
      oldPresetKey: oldBinding?.activePresetKey ?? 'none',
      oldBehaviorVersion: oldBinding?.behaviorVersion ?? 'unknown',
      newPresetKey: topRanked.presetKey,
      newBehaviorVersion,
      identityScope: buildIdentityScope(artifact),
      transitionScope: 'default', // Per-identity scope not yet implemented
      idempotencyKey: randomUUID(),
      positionActions: [],
    };

    return ok({
      recommendedPreset: topRanked.presetKey,
      confidence: topRanked.score / 100,
      reasoningSummary: `Preset "${topRanked.presetKey}" scored ${topRanked.score}/100 (band ${topRanked.scoreBand}). Current preset is "${currentPresetKey}".`,
      transitionMode,
      preparedTransition: prepared,
    });
  }

  // ── applyTransition (durable mutation) ────────────────────────────────

  async applyTransition(
    params: ApplyTransitionParams,
  ): Promise<Result<PresetTransitionApplicationResult>> {
    const { agentId, assessmentArtifactId, targetPreset, mode, reason, idempotencyKey } = params;
    // TODO: store idempotencyKey in agent_preset_transitions for dedup — needs schema migration
    const now = new Date();
    const transitionId = randomUUID();

    try {
      // ── State: prepared ──────────────────────────────────────────────

      // Step 1: Load and validate artifact
      const [artifact] = await this.deps.db
        .select()
        .from(marketAssessmentArtifacts)
        .where(eq(marketAssessmentArtifacts.id, assessmentArtifactId))
        .limit(1);

      if (!artifact) {
        return err({
          code: 'transition.artifact_not_found',
          message: `Artifact ${assessmentArtifactId} not found`,
        });
      }
      if (!isArtifactFresh({ status: artifact.status, expiresAt: artifact.expiresAt.toISOString() })) {
        return err({
          code: 'transition.artifact_expired',
          message: 'Assessment artifact has expired or been superseded',
        });
      }

      // Step 2: Resolve current binding
      const bindingResult = await this.resolveCurrentBinding(agentId, 'default');
      const oldPresetKey = bindingResult.ok ? bindingResult.data.activePresetKey : 'none';
      const oldBehaviorVersion = bindingResult.ok ? bindingResult.data.behaviorVersion : 'unknown';

      // Validate style tier and compute target behavior version.
      const styleTier: StyleKey = isStyleKey(artifact.styleTier) ? artifact.styleTier : 'standard';
      const newBehaviorVersion = this.computeTargetBehaviorVersion(targetPreset, styleTier) ?? 'unknown';

      // Step 3: Verify policy compatibility
      const [agentRow] = await this.deps.db
        .select({ unifiedConfig: agents.unifiedConfig })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);

      if (!agentRow) {
        return err({
          code: 'transition.agent_not_found',
          message: `Agent ${agentId} not found`,
        });
      }

      const unifiedConfig = agentRow.unifiedConfig;

      // Defense-in-depth: also checked at the tool level (change_strategy_preset),
      // but this service-level guard ensures no code path can bypass it.
      const platformAssessment = unifiedConfig?.platformAssessment;
      if (!platformAssessment?.enabled) {
        return err({
          code: 'transition.not_enabled',
          message: 'Platform assessment is not enabled for this agent — transitions are blocked.',
        });
      }

      // Check agent's allowedPresets policy
      const allowedPresets = unifiedConfig?.allowedPresets;
      if (
        allowedPresets?.allowed &&
        allowedPresets.allowed.length > 0 &&
        !allowedPresets.allowed.includes(targetPreset)
      ) {
        return err({
          code: 'transition.preset_not_allowed',
          message: `Preset "${targetPreset}" is not in agent's allowed presets policy.`,
        });
      }

      // Check artifact's allowed presets
      const artifactAllowedPresets = artifact.allowedPresets; // string[]
      if (artifactAllowedPresets.length > 0 && !artifactAllowedPresets.includes(targetPreset)) {
        return err({
          code: 'transition.preset_not_in_artifact',
          message: `Preset "${targetPreset}" is not in the assessment artifact's allowed set.`,
        });
      }

      // Step 5: Persist transition intent (state: prepared)
      const identitySnapshot: Record<string, unknown> = {
        instrumentKind: artifact.instrumentKind,
        venueFamily: artifact.venueFamily,
        styleTier: artifact.styleTier,
      };
      if (artifact.symbol) identitySnapshot['symbol'] = artifact.symbol;

      await this.deps.db.insert(agentPresetTransitions).values({
        id: transitionId,
        agentId,
        oldPresetKey,
        oldPresetBehaviorVersion: oldBehaviorVersion,
        newPresetKey: targetPreset,
        newPresetBehaviorVersion: newBehaviorVersion,
        assessmentArtifactId: artifact.id,
        identitySnapshot,
        instrumentKind: artifact.instrumentKind,
        symbol: artifact.symbol ?? null,
        network: artifact.network ?? null,
        address: artifact.address ?? null,
        mode: 'live',
        transitionMode: mode,
        openPositionCount: 0,
        outcome: 'accepted',
        state: 'prepared',
        positionActionResults: null,
        transitionScope: 'default',
        reason: reason ?? null,
        appliedAt: null,
        regimeSnapshot: null,
        createdAt: now,
      });

      // ── State: applying ──────────────────────────────────────────────
      await this.deps.db
        .update(agentPresetTransitions)
        .set({ state: 'applying' })
        .where(eq(agentPresetTransitions.id, transitionId));

      // Step 6: Notify actor to reload — failed reload = failed transition.
      // Binding upsert happens AFTER successful notification to avoid state
      // inconsistency (binding says "new preset" but transition says "failed").
      let actorAcknowledged = false;
      let actorError: { code: string; message: string } | undefined;
      try {
        if (this.deps.notifyActor) {
          const notifyResult = await this.deps.notifyActor(
            agentId,
            targetPreset,
            styleTier,
            newBehaviorVersion,
          );
          if (!notifyResult.ok) {
            actorError = { code: notifyResult.error.code, message: notifyResult.error.message };
            throw new Error(notifyResult.error.message);
          }
        }
        // Only persist the binding once the actor has acknowledged the reload
        await this.deps.db
          .insert(agentPresetBindings)
          .values({
            id: randomUUID(),
            agentId,
            scope: 'default',
            activePresetKey: targetPreset,
            styleTier,
            behaviorVersion: newBehaviorVersion,
            appliedPresetVersion: newBehaviorVersion,
            sourceArtifactId: artifact.id,
            sourceTransitionId: transitionId,
            status: 'active',
            appliedAt: now,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [agentPresetBindings.agentId, agentPresetBindings.scope],
            set: {
              activePresetKey: targetPreset,
              styleTier,
              behaviorVersion: newBehaviorVersion,
              appliedPresetVersion: newBehaviorVersion,
              sourceArtifactId: artifact.id,
              sourceTransitionId: transitionId,
              status: 'active',
              appliedAt: now,
            },
          });
        actorAcknowledged = true;
      } catch (notifyErr) {
        const detail =
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
        logger.error({ err: detail, agentId, transitionId, actorError }, 'Actor notification failed');
      }

      // ── State: applied or failed ─────────────────────────────────────
      const finalState = actorAcknowledged ? 'applied' : 'failed' as const;
      const applicationTime = actorAcknowledged ? new Date() : null;

      await this.deps.db
        .update(agentPresetTransitions)
        .set({
          state: finalState,
          ...(applicationTime ? { appliedAt: applicationTime } : {}),
          outcome: actorAcknowledged ? 'accepted' : 'rejected',
        })
        .where(eq(agentPresetTransitions.id, transitionId));

      if (!actorAcknowledged) {
        logger.warn({ agentId, transitionId, targetPreset, mode }, 'Preset transition failed — actor did not acknowledge');
        return ok({
          transitionId,
          state: 'failed',
          positionActionResults: null,
          appliedAt: now.toISOString(),
        });
      }

      logger.info({ agentId, transitionId, targetPreset, mode }, 'Preset transition applied successfully');

      return ok({
        transitionId,
        state: 'applied',
        positionActionResults: null,
        appliedAt: applicationTime!.toISOString(),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.error({ err: message, agentId, targetPreset }, 'Preset transition failed with internal error');
      return err({
        code: 'transition.internal_error',
        message: 'Transition failed due to internal error',
      });
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Compute the behavior version for a target preset from the preset catalog.
   * Returns the 12-char hex version string, or null if the preset is not found
   * or is a DCA (bot-only) preset.
   */
  private computeTargetBehaviorVersion(
    presetKey: string,
    styleTier: StyleKey,
  ): string | null {
    const preset = getPreset(presetKey, styleTier);
    if (!preset) return null;
    try {
      return computePresetBehaviorVersion(preset);
    } catch {
      return null;
    }
  }

  /**
   * Resolve the agent's current active preset binding for a given scope.
   * Returns an error if no active binding exists.
   */
  private async resolveCurrentBinding(
    agentId: string,
    scope: string,
  ): Promise<Result<ActivePresetBinding>> {
    const [binding] = await this.deps.db
      .select()
      .from(agentPresetBindings)
      .where(
        and(
          eq(agentPresetBindings.agentId, agentId),
          eq(agentPresetBindings.scope, scope),
          eq(agentPresetBindings.status, 'active'),
        ),
      )
      .limit(1);

    if (!binding) {
      return err({
        code: 'transition.no_active_binding',
        message: `Agent ${agentId} has no active preset binding for scope "${scope}"`,
      });
    }

    return ok({
      id: binding.id,
      agentId: binding.agentId,
      scope: binding.scope,
      activePresetKey: binding.activePresetKey,
      styleTier: binding.styleTier as 'economy' | 'standard' | 'premium',
      behaviorVersion: binding.behaviorVersion,
      appliedPresetVersion: binding.appliedPresetVersion,
      sourceArtifactId: binding.sourceArtifactId,
      sourceTransitionId: binding.sourceTransitionId,
      status: binding.status as 'active' | 'superseded' | 'revoked',
      appliedAt: binding.appliedAt.toISOString(),
      createdAt: binding.createdAt.toISOString(),
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a canonical identity scope string from an artifact row.
 * Example: "orderbook|hyperliquid|standard|BTC"
 */
function buildIdentityScope(artifact: {
  instrumentKind: string;
  venueFamily: string;
  styleTier: string;
  symbol?: string | null;
}): string {
  const parts = [artifact.instrumentKind, artifact.venueFamily, artifact.styleTier];
  if (artifact.symbol) parts.push(artifact.symbol);
  return parts.join('|');
}
