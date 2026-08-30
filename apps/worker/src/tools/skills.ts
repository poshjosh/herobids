import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES, ManageAgentSkillsResultSchema, SYSTEM_SKILL_SLUGS } from '@herobids/domain';
import { resolveSkillIdsBySlugOrId } from '@herobids/db';
import { convertZodToJsonSchema } from './registry.js';
import { parseBrokerDenialReply } from './tool-errors.js';
import { createLogger } from '../logger.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const logger = createLogger('tools:skills');

const SKILLS_REPLY_TIMEOUT_S = 15;
const EXTERNAL_INSTALL_TIMEOUT_MS = 30_000;
const EXTERNAL_LIST_TIMEOUT_MS = 15_000;
const EXTERNAL_REMOVE_TIMEOUT_MS = 15_000;

const FILE_MANAGEMENT_SKILL_ID = 'file-management';
const FILE_MANAGEMENT_SLUG = 'system/file-management';

// ── External skill subprocess helpers ───────────────────────────────────────

type ExternalSubprocessResult = { ok: true; output: string } | { ok: false; error: string };

function runExternalSubprocess(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ExternalSubprocessResult> {
  const maxBytes = 8192;
  return new Promise((resolve) => {
    const child = spawn('npx', ['skills', ...args], {
      cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) {
        stdout += chunk.toString('utf-8').slice(0, maxBytes - stdout.length);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) {
        stderr += chunk.toString('utf-8').slice(0, maxBytes - stderr.length);
      }
    });

    child.on('error', (err) => {
      resolve({ ok: false, error: `skills.sh CLI unavailable: ${err.message}` });
    });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        resolve({ ok: true, output: stdout.trim() });
      } else if (code === 0) {
        resolve({ ok: true, output: '' });
      } else if (stderr.trim().length > 0) {
        resolve({ ok: false, error: `skills.sh exited with code ${code}: ${stderr.trim().slice(0, 500)}` });
      } else if (stdout.trim().length > 0) {
        resolve({ ok: false, error: `skills.sh exited with code ${code}: ${stdout.trim().slice(0, 500)}` });
      } else {
        resolve({ ok: false, error: `skills.sh exited with code ${code} (no output)` });
      }
    });
  });
}

/**
 * Normalize an external skill ref: if the ref has exactly 3 slash-separated
 * segments (owner/repo/skill), rewrite to owner/repo@skill which is the
 * format the skills CLI expects.
 */
function normalizeExternalRef(ref: string): { ref: string; wasNormalized: boolean } {
  const parts = ref.split('/');
  if (parts.length === 3 && !ref.includes('@')) {
    return { ref: `${parts[0]}/${parts[1]}@${parts[2]}`, wasNormalized: true };
  }
  return { ref, wasNormalized: false };
}

async function runExternalSkillInstall(ref: string, cwd: string): Promise<ExternalSubprocessResult> {
  const normalized = normalizeExternalRef(ref);
  return runExternalSubprocess(['add', normalized.ref, '--yes'], cwd, EXTERNAL_INSTALL_TIMEOUT_MS);
}

async function runExternalSkillRemove(name: string, cwd: string): Promise<ExternalSubprocessResult> {
  return runExternalSubprocess(['remove', name, '--yes'], cwd, EXTERNAL_REMOVE_TIMEOUT_MS);
}

async function runExternalSkillList(cwd: string): Promise<ExternalSubprocessResult> {
  return runExternalSubprocess(['list', '--json'], cwd, EXTERNAL_LIST_TIMEOUT_MS);
}

// ── Slug resolution helpers ─────────────────────────────────────────────────

/** Build a reverse map from skill ID → slug, using skillOps assigned list. */
async function buildIdToSlugMap(
  ctx: ToolContext,
  prefetchedAssigned?: Array<{ id: string; slug: string }>,
  prefetchedAvailable?: Array<{ id: string; slug: string }>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  // Seed with system skill slugs
  for (const [slug, id] of SYSTEM_SKILL_SLUGS) {
    map.set(id, slug);
  }
  // Augment with assigned skills (may include user-authored skills)
  const assigned = prefetchedAssigned ?? (ctx.skillOps ? await ctx.skillOps.listAssigned().catch(() => []) : []);
  for (const s of assigned) {
    if (s.slug) map.set(s.id, s.slug);
  }
  // Augment with available skills (covers user-authored deps not yet assigned)
  if (prefetchedAvailable) {
    for (const s of prefetchedAvailable) {
      if (s.slug && !map.has(s.id)) map.set(s.id, s.slug);
    }
  }
  return map;
}

// ── list_skills ─────────────────────────────────────────────────────────────

const ListSkillsParamsSchema = z.object({});

const listSkillsTool: AgentTool = {
  name: 'list_skills',
  description:
    'List skills currently assigned to this agent. Use search_skills to discover new skills to add.',
  parametersSchema: ListSkillsParamsSchema,
  parameters: convertZodToJsonSchema(ListSkillsParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.skillOps) {
      return {
        success: false,
        error: 'Skill operations not available in this context',
        errorCode: 'skill.ops_unavailable',
      };
    }

    try {
      const assigned = await ctx.skillOps.listAssigned();

      // Map to response format with `skill` (slug) as primary identifier
      const assignedResponse = assigned.map(s => ({
        id: s.id,
        skill: s.slug,
        name: s.name,
        description: s.description,
        dependsOn: s.dependsOn,
      }));

      // External installed skills (best-effort)
      let installedExternal: { results: string } | { note: string };
      try {
        const { getWorkspacePaths } = await import('./workspace.js');
        const cwd = getWorkspacePaths(ctx.agentId).root;
        const extResult = await runExternalSkillList(cwd);
        if (extResult.ok) {
          installedExternal = extResult.output.length > 0
            ? { results: extResult.output }
            : { note: 'No external skills installed.' };
        } else {
          installedExternal = { note: extResult.error };
        }
      } catch (err) {
        installedExternal = { note: `External skill listing unavailable: ${err instanceof Error ? err.message : 'unknown error'}` };
      }

      const hint = assignedResponse.length === 0
        ? 'You have no skills. Use search_skills with keywords from your goal to find and add relevant skills.'
        : 'Use search_skills to discover and add more skills.';

      return {
        success: true,
        data: {
          assigned: assignedResponse,
          installedExternal,
          hint,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.error({ err, agentId: ctx.agentId }, 'list_skills failed');
      return {
        success: false,
        error: `Failed to list skills: ${message}`,
        errorCode: 'skill.list_failed',
      };
    }
  },
};

// ── Shared broker-mediated skill mutation logic ─────────────────────────────

const AddSkillsParamsSchema = z.object({
  skillIds: z.array(z.string().min(1)).min(1).max(10),
  includeDependencies: z.boolean().optional().default(true),
});

/** Send a skill mutation (add/remove) to the broker and await the reply. */
async function sendBrokerSkillMutation(
  action: 'add' | 'remove',
  skillIds: string[],
  ctx: ToolContext,
): Promise<ToolResult & { _brokerResult?: { skillIds: string[]; warnings: string[] } }> {
  const requestMessageId = randomUUID();

  await ctx.publishToInbound!(
    AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS,
    { action, skillIds, requestMessageId } as Record<string, unknown>,
  );

  const reply = await ctx.redis.blpop(
    `agent:skills:reply:${requestMessageId}`,
    SKILLS_REPLY_TIMEOUT_S,
  );

  if (!reply) {
    return {
      success: false,
      retryable: true,
      error: 'Timed out waiting for broker reply',
      errorCode: 'broker.timeout',
    };
  }

  const replyData = JSON.parse(reply[1]) as Record<string, unknown>;
  const denialResult = parseBrokerDenialReply(replyData);
  if (denialResult) return denialResult;

  const parsed = ManageAgentSkillsResultSchema.safeParse(replyData);
  if (!parsed.success) {
    logger.error({ agentId: ctx.agentId, action, parseErrors: parsed.error.issues }, 'Malformed broker reply for skill mutation');
    return {
      success: false,
      error: 'Received malformed reply from broker',
      errorCode: 'broker.malformed_reply',
    };
  }

  const result = parsed.data;

  if (result.status === 'error') {
    return {
      success: false,
      error: result.error ?? 'Skill mutation failed',
      errorCode: result.errorCode ?? 'skill.mutation_failed',
    };
  }

  return {
    success: true,
    _brokerResult: { skillIds: result.skillIds, warnings: result.warnings },
  };
}

// ── add_skills ──────────────────────────────────────────────────────────────

const addSkillsTool: AgentTool = {
  name: 'add_skills',
  description:
    'Add skills to this agent by slug (e.g. system/trading) or ID. Dependencies are added automatically by default. External skills use owner/repo@skill format (e.g. tychohq/agent-skills@flights). The @ separates the repo from the skill name.',
  parametersSchema: AddSkillsParamsSchema,
  parameters: convertZodToJsonSchema(AddSkillsParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = AddSkillsParamsSchema.safeParse(params);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Invalid parameters: skillIds must be an array of 1–10 non-empty strings',
        errorCode: 'validation.invalid_params',
      };
    }
    const { skillIds: inputRefs, includeDependencies } = parsed.data;

    if (!ctx.publishToInbound || typeof ctx.redis.blpop !== 'function') {
      return {
        success: false,
        error: 'Broker communication not available in this context',
        errorCode: 'skill.broker_unavailable',
      };
    }

    try {
      // 1. Resolve refs: partition into platform (slug/id) and external
      const db = ctx.db as Parameters<typeof resolveSkillIdsBySlugOrId>[0] | undefined;
      let resolved: Map<string, string>;
      if (db) {
        resolved = await resolveSkillIdsBySlugOrId(db, inputRefs);
      } else {
        // Fallback: use SYSTEM_SKILL_SLUGS for slug resolution without DB
        resolved = new Map<string, string>();
        for (const ref of inputRefs) {
          const systemId = SYSTEM_SKILL_SLUGS.get(ref);
          if (systemId) {
            resolved.set(ref, systemId);
          } else if (!ref.includes('/')) {
            // Legacy ID — pass through as-is
            resolved.set(ref, ref);
          }
        }
      }

      const platformIds: string[] = [];
      const externalRefs: string[] = [];
      const rejectedRefs: Array<{ ref: string; reason: string }> = [];

      for (const ref of inputRefs) {
        const id = resolved.get(ref);
        if (id) {
          platformIds.push(id);
        } else if (ref.startsWith('system/')) {
          // Unresolved system/ slug — don't route to external CLI
          rejectedRefs.push({ ref, reason: `${ref} is not a recognized platform skill. Use search_skills to find available skills.` });
        } else if (ref.includes('/')) {
          externalRefs.push(ref);
        } else {
          // No-slash ref with no DB match — still send to broker (it validates)
          platformIds.push(ref);
        }
      }

      // Pre-fetch skill lists once for reuse (slug map, dependency resolution, file-management check)
      let cachedAssigned: Array<{ id: string; slug: string; name: string; description: string; dependsOn: string[] }> = [];
      let cachedAvailable: Array<{ id: string; slug: string; name: string; description: string; dependsOn: string[] }> = [];
      if (ctx.skillOps) {
        try {
          [cachedAssigned, cachedAvailable] = await Promise.all([
            ctx.skillOps.listAssigned(),
            ctx.skillOps.listAvailable(),
          ]);
        } catch (err) {
          logger.warn({ err, agentId: ctx.agentId }, 'Failed to fetch skill lists for add_skills');
        }
      }

      // Build slug lookup for response formatting
      const idToSlug = await buildIdToSlugMap(ctx, cachedAssigned, cachedAvailable);

      // 2. Dependency auto-resolution for platform skills
      const autoResolved: Array<{ skill: string; requiredBy: string }> = [];
      const missingDependencies: Array<{ skill: string; requiredBy: string }> = [];
      let allPlatformIds = [...new Set(platformIds)];

      if (includeDependencies && allPlatformIds.length > 0 && cachedAssigned.length + cachedAvailable.length > 0) {
        const assignedSet = new Set(cachedAssigned.map(s => s.id));

        // Compute deps for each platform skill being added
        const depIdsToAdd = new Set<string>();
        for (const id of allPlatformIds) {
          const skill = [...cachedAssigned, ...cachedAvailable].find(s => s.id === id);
          if (skill) {
            for (const depId of skill.dependsOn) {
              if (!assignedSet.has(depId) && !allPlatformIds.includes(depId)) {
                depIdsToAdd.add(depId);
                const depSlug = idToSlug.get(depId) ?? depId;
                const reqSlug = idToSlug.get(id) ?? id;
                autoResolved.push({ skill: depSlug, requiredBy: reqSlug });
              }
            }
          }
        }

        if (depIdsToAdd.size > 0) {
          allPlatformIds = [...new Set([...allPlatformIds, ...depIdsToAdd])];
        }
      } else if (!includeDependencies && allPlatformIds.length > 0 && cachedAssigned.length + cachedAvailable.length > 0) {
        // Report which dependencies are missing without auto-adding them
        const assignedSet = new Set(cachedAssigned.map(s => s.id));
        for (const id of allPlatformIds) {
          const skill = [...cachedAssigned, ...cachedAvailable].find(s => s.id === id);
          if (skill) {
            for (const depId of skill.dependsOn) {
              if (!assignedSet.has(depId) && !allPlatformIds.includes(depId)) {
                const depSlug = idToSlug.get(depId) ?? depId;
                const reqSlug = idToSlug.get(id) ?? id;
                missingDependencies.push({ skill: depSlug, requiredBy: reqSlug });
              }
            }
          }
        }
      }

      // 3. Auto-resolve file-management for external skills
      if (includeDependencies && externalRefs.length > 0) {
        const assignedSet = new Set(cachedAssigned.map(s => s.id));
        if (!assignedSet.has(FILE_MANAGEMENT_SKILL_ID) && !allPlatformIds.includes(FILE_MANAGEMENT_SKILL_ID)) {
          allPlatformIds.push(FILE_MANAGEMENT_SKILL_ID);
          autoResolved.push({ skill: FILE_MANAGEMENT_SLUG, requiredBy: externalRefs[0]! });
        }
      }

      // 4. Execute platform add + external installs in parallel
      const brokerPromise = allPlatformIds.length > 0
        ? sendBrokerSkillMutation('add', allPlatformIds, ctx)
        : Promise.resolve(undefined);

      const externalPromise = (async (): Promise<Array<{ ref: string; ok: boolean; output?: string; error?: string }>> => {
        if (externalRefs.length === 0) return [];
        try {
          const { getWorkspacePaths } = await import('./workspace.js');
          const cwd = getWorkspacePaths(ctx.agentId).root;
          // Run external installs sequentially — the skills CLI is not
          // safe to run in parallel within the same workspace directory.
          const results: Array<{ ref: string; ok: boolean; output?: string; error?: string }> = [];
          for (const ref of externalRefs) {
            const result = await runExternalSkillInstall(ref, cwd);
            if (result.ok) {
              results.push({ ref, ok: true as const, output: result.output });
            } else {
              results.push({ ref, ok: false as const, error: result.error });
            }
          }
          return results;
        } catch (err) {
          return externalRefs.map(ref => ({
            ref,
            ok: false as const,
            error: `External install unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
          }));
        }
      })();

      const [brokerSettled, externalSettled] = await Promise.allSettled([brokerPromise, externalPromise]);

      let platformResult: { added: string[]; warnings: string[] } | undefined;
      if (brokerSettled.status === 'fulfilled' && brokerSettled.value !== undefined) {
        const brokerResult = brokerSettled.value;
        if (!brokerResult.success) {
          if (externalRefs.length === 0) return brokerResult;
          platformResult = { added: [], warnings: [`Platform skill add failed: ${brokerResult.error}`] };
        } else if (brokerResult._brokerResult) {
          platformResult = { added: brokerResult._brokerResult.skillIds, warnings: brokerResult._brokerResult.warnings };
        }
      } else if (brokerSettled.status === 'rejected') {
        const errMsg = brokerSettled.reason instanceof Error ? brokerSettled.reason.message : 'unknown error';
        if (externalRefs.length === 0) {
          return { success: false, error: `Broker communication failed: ${errMsg}`, errorCode: 'broker.communication_error' };
        }
        platformResult = { added: [], warnings: [`Platform skill add failed: ${errMsg}`] };
      }

      const externalResults: Array<{ ref: string; ok: boolean; output?: string; error?: string }> =
        externalSettled.status === 'fulfilled' ? externalSettled.value : externalRefs.map(ref => ({
          ref, ok: false, error: `External install failed: ${externalSettled.reason instanceof Error ? externalSettled.reason.message : 'unknown error'}`,
        }));

      // 6. Hot-reload after platform changes
      let activeSkills: string[] | undefined;
      if (platformResult && platformResult.added.length > 0 && ctx.onSkillsChanged) {
        try {
          activeSkills = await ctx.onSkillsChanged();
          logger.debug({ agentId: ctx.agentId, activeSkills }, 'Skill hot-reload succeeded after add_skills');
        } catch (reloadErr) {
          logger.warn({ err: reloadErr, agentId: ctx.agentId }, 'onSkillsChanged failed after add_skills');
        }
      }

      // 7. Build response using slugs
      const addedSlugs = (platformResult?.added ?? []).map(id => idToSlug.get(id) ?? id);
      const allWarnings = [
        ...(platformResult?.warnings ?? []),
        ...rejectedRefs.map(r => r.reason),
        ...externalResults.filter(r => !r.ok).map(r => {
          const formatHint = !r.ref.includes('@') && r.ref.split('/').length >= 3
            ? ` (hint: external skills use owner/repo@skill format, e.g. tychohq/agent-skills@flights)`
            : '';
          return `External add ${r.ref}: ${r.error}${formatHint}`;
        }),
      ];
      const externalAdded = externalResults.filter(r => r.ok).map(r => r.ref);

      const responseData: Record<string, unknown> = {
        added: [...addedSlugs, ...externalAdded],
        ...(autoResolved.length > 0 ? { autoResolved } : {}),
        ...(missingDependencies.length > 0 ? { missingDependencies } : {}),
        ...(activeSkills ? { activeSkills } : {}),
        ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        ...(!activeSkills && platformResult && platformResult.added.length > 0 ? { note: 'Skill change saved. Hot-reload failed — changes take effect next tick.' } : {}),
        ...(externalResults.length > 0 ? { external: externalResults.map(r => ({ ref: r.ref, ok: r.ok, ...(r.output ? { output: r.output } : {}), ...(r.error ? { error: r.error } : {}) })) } : {}),
      };

      return { success: true, data: responseData };
    } catch (err) {
      logger.error({ err, agentId: ctx.agentId }, 'add_skills failed');
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Broker communication failed',
        errorCode: 'broker.communication_error',
      };
    }
  },
};

// ── remove_skills ───────────────────────────────────────────────────────────

const RemoveSkillsParamsSchema = z.object({
  skillIds: z.array(z.string().min(1)).min(1).max(10),
});

const removeSkillsTool: AgentTool = {
  name: 'remove_skills',
  description:
    'Remove skills from this agent by slug (e.g. system/trading) or ID. External skills are removed via skills.sh.',
  parametersSchema: RemoveSkillsParamsSchema,
  parameters: convertZodToJsonSchema(RemoveSkillsParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = RemoveSkillsParamsSchema.safeParse(params);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Invalid parameters: skillIds must be an array of 1–10 non-empty strings',
        errorCode: 'validation.invalid_params',
      };
    }
    const { skillIds: inputRefs } = parsed.data;

    if (!ctx.publishToInbound || typeof ctx.redis.blpop !== 'function') {
      return {
        success: false,
        error: 'Broker communication not available in this context',
        errorCode: 'skill.broker_unavailable',
      };
    }

    try {
      // Resolve refs: partition into platform and external
      const db = ctx.db as Parameters<typeof resolveSkillIdsBySlugOrId>[0] | undefined;
      let resolved: Map<string, string>;
      if (db) {
        resolved = await resolveSkillIdsBySlugOrId(db, inputRefs);
      } else {
        resolved = new Map<string, string>();
        for (const ref of inputRefs) {
          const systemId = SYSTEM_SKILL_SLUGS.get(ref);
          if (systemId) {
            resolved.set(ref, systemId);
          } else if (!ref.includes('/')) {
            resolved.set(ref, ref);
          }
        }
      }

      const platformIds: string[] = [];
      const externalRefs: string[] = [];

      for (const ref of inputRefs) {
        const id = resolved.get(ref);
        if (id) {
          platformIds.push(id);
        } else if (ref.includes('/')) {
          externalRefs.push(ref);
        } else {
          platformIds.push(ref);
        }
      }

      // Build slug lookup for response formatting
      const idToSlug = await buildIdToSlugMap(ctx);

      // Platform remove + external removes in parallel
      const brokerPromise = platformIds.length > 0
        ? sendBrokerSkillMutation('remove', platformIds, ctx)
        : Promise.resolve(undefined);

      const externalPromise = (async (): Promise<Array<{ ref: string; ok: boolean; output?: string; error?: string }>> => {
        if (externalRefs.length === 0) return [];
        try {
          const { getWorkspacePaths } = await import('./workspace.js');
          const cwd = getWorkspacePaths(ctx.agentId).root;
          // Run external removes sequentially — the skills CLI is not
          // safe to run in parallel within the same workspace directory.
          const results: Array<{ ref: string; ok: boolean; output?: string; error?: string }> = [];
          for (const ref of externalRefs) {
            const name = ref.split('/').pop()!;
            const result = await runExternalSkillRemove(name, cwd);
            if (result.ok) {
              results.push({ ref, ok: true as const, output: result.output });
            } else {
              results.push({ ref, ok: false as const, error: result.error });
            }
          }
          return results;
        } catch (err) {
          return externalRefs.map(ref => ({
            ref,
            ok: false as const,
            error: `External remove unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
          }));
        }
      })();

      const [brokerSettled, externalSettled] = await Promise.allSettled([brokerPromise, externalPromise]);

      let platformResult: { removed: string[]; warnings: string[] } | undefined;
      if (brokerSettled.status === 'fulfilled' && brokerSettled.value !== undefined) {
        const brokerResult = brokerSettled.value;
        if (!brokerResult.success) {
          if (externalRefs.length === 0) return brokerResult;
          platformResult = { removed: [], warnings: [`Platform skill remove failed: ${brokerResult.error}`] };
        } else if (brokerResult._brokerResult) {
          platformResult = { removed: brokerResult._brokerResult.skillIds, warnings: brokerResult._brokerResult.warnings };
        }
      } else if (brokerSettled.status === 'rejected') {
        const errMsg = brokerSettled.reason instanceof Error ? brokerSettled.reason.message : 'unknown error';
        if (externalRefs.length === 0) {
          return { success: false, error: `Broker communication failed: ${errMsg}`, errorCode: 'broker.communication_error' };
        }
        platformResult = { removed: [], warnings: [`Platform skill remove failed: ${errMsg}`] };
      }

      const externalResults: Array<{ ref: string; ok: boolean; output?: string; error?: string }> =
        externalSettled.status === 'fulfilled' ? externalSettled.value : externalRefs.map(ref => ({
          ref, ok: false, error: `External remove failed: ${externalSettled.reason instanceof Error ? externalSettled.reason.message : 'unknown error'}`,
        }));

      // Hot-reload after platform changes
      let activeSkills: string[] | undefined;
      if (platformResult && platformResult.removed.length > 0 && ctx.onSkillsChanged) {
        try {
          activeSkills = await ctx.onSkillsChanged();
          logger.debug({ agentId: ctx.agentId, activeSkills }, 'Skill hot-reload succeeded after remove_skills');
        } catch (reloadErr) {
          logger.warn({ err: reloadErr, agentId: ctx.agentId }, 'onSkillsChanged failed after remove_skills');
        }
      }

      // Build response using slugs
      const removedSlugs = (platformResult?.removed ?? []).map(id => idToSlug.get(id) ?? id);
      const allWarnings = [
        ...(platformResult?.warnings ?? []),
        ...externalResults.filter(r => !r.ok).map(r => `External remove ${r.ref}: ${r.error}`),
      ];
      const externalRemoved = externalResults.filter(r => r.ok).map(r => r.ref);

      const responseData: Record<string, unknown> = {
        removed: [...removedSlugs, ...externalRemoved],
        ...(activeSkills ? { activeSkills } : {}),
        ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
        ...(!activeSkills && platformResult && platformResult.removed.length > 0 ? { note: 'Skill change saved. Hot-reload failed — changes take effect next tick.' } : {}),
        ...(externalResults.length > 0 ? { external: externalResults.map(r => ({ ref: r.ref, ok: r.ok, ...(r.output ? { output: r.output } : {}), ...(r.error ? { error: r.error } : {}) })) } : {}),
      };

      return { success: true, data: responseData };
    } catch (err) {
      logger.error({ err, agentId: ctx.agentId }, 'remove_skills failed');
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Broker communication failed',
        errorCode: 'broker.communication_error',
      };
    }
  },
};

// ── search_skills ───────────────────────────────────────────────────────────

const SearchSkillsParamsSchema = z.object({
  query: z.string().min(1).max(200),
});



const searchSkillsTool: AgentTool = {
  name: 'search_skills',
  description:
    'Search for skills by keyword across the platform catalog and the external skill registry.',
  parametersSchema: SearchSkillsParamsSchema,
  parameters: convertZodToJsonSchema(SearchSkillsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = SearchSkillsParamsSchema.safeParse(params);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Invalid parameters: query must be a non-empty string (max 200 chars)',
        errorCode: 'validation.invalid_params',
      };
    }
    const { query } = parsed.data;

    // Local platform search
    let localResults: Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      isAssigned: boolean;
      dependsOn: string[];
    }> = [];
    if (ctx.skillOps) {
      try {
        localResults = await ctx.skillOps.search(query);
      } catch (err) {
        logger.warn({ err, agentId: ctx.agentId }, 'search_skills local search failed');
      }
    }

    // External search via HTTP provider (best-effort)
    let external: {
      results: Array<{
        ref: string;
        name: string;
        description: string;
        installs: number;
      }>;
      totalCount: number;
    } | { note: string };

    if (ctx.externalSkillProvider) {
      try {
        const page = await ctx.externalSkillProvider.search(query, { page: 1, pageSize: 10 });
        external = {
          results: page.results.map(s => ({
            ref: s.ref,
            name: s.name,
            description: s.description,
            installs: s.installs,
          })),
          totalCount: page.totalCount,
        };
      } catch (err) {
        external = { note: `External search failed: ${err instanceof Error ? err.message : 'unknown error'}` };
      }
    } else {
      external = { note: 'External skill search not configured' };
    }

    return {
      success: true,
      data: {
        local: {
          results: localResults.map(s => ({
            id: s.id,
            skill: s.slug,
            name: s.name,
            description: s.description,
            isAssigned: s.isAssigned,
            dependsOn: s.dependsOn,
          })),
        },
        external,
      },
    };
  },
};

export const skillTools: AgentTool[] = [listSkillsTool, addSkillsTool, removeSkillsTool, searchSkillsTool];
