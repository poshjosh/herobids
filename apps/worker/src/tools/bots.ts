import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import pino from 'pino';

const logger = pino({ name: 'tools:bots' });

// --- create_bot ---

const CreateBotParamsSchema = z.object({
  venueAccountId: z.string().optional().transform(v => v === '' ? undefined : v).describe('Venue account ID to use. Omit to use default trading binding.'),
  config: z.object({}).passthrough().optional().describe('Bot configuration object (strategy preset, symbol, risk params, etc.)'),
  rationale: z.string().max(500).optional().describe('Brief rationale for creating this bot. Used for audit.'),
});

const createBotTool: AgentTool = {
  name: 'create_bot',
  description: 'Create and start a new trading bot. The bot will run independently with its own strategy and risk parameters. Use when you want to delegate a trading opportunity to an automated bot.',
  parametersSchema: CreateBotParamsSchema,
  parameters: convertZodToJsonSchema(CreateBotParamsSchema),
  category: 'execute-trade',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { venueAccountId, config, rationale } = params as z.infer<typeof CreateBotParamsSchema>;

    await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
      action: 'create_and_start',
      venueAccountId,
      config,
      rationale,
    });

    return {
      success: true,
      data: { ok: true, note: 'bot creation submitted — you will see it in the bot list on the next tick' },
    };
  },
};

// --- list_bots ---

const ListBotsParamsSchema = z.object({
  days: z.number().int().positive().optional().describe('Only return bots created within this many days'),
});

const listBotsTool: AgentTool = {
  name: 'list_bots',
  description: 'List bots created by this agent. Optionally filter by creation date (days). Returns bot ID, status, strategy preset, and symbol.',
  parametersSchema: ListBotsParamsSchema,
  parameters: convertZodToJsonSchema(ListBotsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { days } = params as z.infer<typeof ListBotsParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : undefined;
    const botRows = await ctx.botRepo.getBotsByCreator('agent', ctx.agentId, since);

    return {
      success: true,
      data: {
        ok: true,
        bots: botRows.map((b) => ({
          id: b.id,
          status: b.status,
          strategyPreset: b.config['strategyPreset'] ?? null,
          symbol: b.config['symbol'] ?? null,
          createdAt: b.createdAt.toISOString(),
        })),
      },
    };
  },
};

// --- get_bot_status ---

const GetBotStatusParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to query'),
});

const getBotStatusTool: AgentTool = {
  name: 'get_bot_status',
  description: 'Get detailed status for a specific bot. Returns configuration, runtime state, and timestamps. Only works for bots owned by this agent.',
  parametersSchema: GetBotStatusParamsSchema,
  parameters: convertZodToJsonSchema(GetBotStatusParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof GetBotStatusParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const bot = await ctx.botRepo.getBotById(botId);
    if (!bot || bot.creatorType !== 'agent' || bot.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent` };
    }

    return {
      success: true,
      data: {
        ok: true,
        id: bot.id,
        status: bot.status,
        strategyPreset: bot.config['strategyPreset'] ?? null,
        symbol: bot.config['symbol'] ?? null,
        config: bot.config,
        startedAt: bot.startedAt?.toISOString() ?? null,
        stoppedAt: bot.stoppedAt?.toISOString() ?? null,
      },
    };
  },
};

// --- stop_bot ---

const StopBotParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to stop'),
});

const stopBotTool: AgentTool = {
  name: 'stop_bot',
  description: 'Stop a running bot. The bot will cease trading and its positions will remain open unless manually closed. Only works for bots owned by this agent.',
  parametersSchema: StopBotParamsSchema,
  parameters: convertZodToJsonSchema(StopBotParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { botId } = params as z.infer<typeof StopBotParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const stopTarget = await ctx.botRepo.getBotById(botId);
    if (!stopTarget || stopTarget.creatorType !== 'agent' || stopTarget.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent` };
    }

    const previousStatus = stopTarget.status;

    if (previousStatus !== 'running') {
      await ctx.botRepo.markBotStopped(botId);
      return { success: true, data: { ok: true, botId, previousStatus, note: 'bot was not running' } };
    }

    await ctx.botRepo.markBotStopped(botId);
    try {
      await ctx.redis.publish(`bot:stop:${botId}`, '1');
    } catch (err) {
      logger.error({ err, botId }, 'Failed to publish bot:stop signal — restoring previous runtime state');
      try {
        await ctx.botRepo.restoreBotRuntimeState({
          botId,
          status: stopTarget.status,
          startedAt: stopTarget.startedAt,
          stoppedAt: stopTarget.stoppedAt,
        });
      } catch (rollbackErr) {
        logger.error({ rollbackErr, botId }, 'CRITICAL: failed to restore bot state after stop signal failure');
      }
      return { success: false, data: { ok: false, botId, previousStatus, note: 'failed to signal bot stop' } };
    }

    return { success: true, data: { ok: true, botId, previousStatus, note: 'bot stopped' } };
  },
};

// --- start_bot ---

const StartBotParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to start'),
  rationale: z.string().max(500).optional().describe('Brief rationale for restarting this bot'),
});

const startBotTool: AgentTool = {
  name: 'start_bot',
  description: 'Start a stopped bot. The bot will resume trading according to its configuration. Only works for bots owned by this agent.',
  parametersSchema: StartBotParamsSchema,
  parameters: convertZodToJsonSchema(StartBotParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { botId, rationale } = params as z.infer<typeof StartBotParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const startTarget = await ctx.botRepo.getBotById(botId);
    if (!startTarget || startTarget.creatorType !== 'agent' || startTarget.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent` };
    }

    if (startTarget.status === 'running') {
      return { success: false, error: `bot ${botId} is already running` };
    }

    await ctx.botRepo.markBotRunning(botId);
    try {
      await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'start',
        botId,
        rationale,
      });
    } catch (err) {
      logger.error({ err, botId }, 'Failed to enqueue direct bot start — restoring previous runtime state');
      try {
        await ctx.botRepo.restoreBotRuntimeState({
          botId,
          status: startTarget.status,
          startedAt: startTarget.startedAt,
          stoppedAt: startTarget.stoppedAt,
        });
      } catch (rollbackErr) {
        logger.error({ rollbackErr, botId }, 'CRITICAL: failed to restore bot state after start enqueue failure');
      }
      return { success: false, data: { ok: false, botId, note: 'failed to submit bot start' } };
    }

    return { success: true, data: { ok: true, botId, status: 'running', note: 'bot start submitted' } };
  },
};

// --- adjust_bot_config ---

const AdjustBotConfigParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to reconfigure'),
  config: z.object({}).passthrough().describe('Partial config object to merge with existing bot config'),
});

function deepMergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMergeConfig(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const adjustBotConfigTool: AgentTool = {
  name: 'adjust_bot_config',
  description: 'Update configuration for a specific bot. Changes are merged with existing config and take effect on the next bot tick. Only works for bots owned by this agent.',
  parametersSchema: AdjustBotConfigParamsSchema,
  parameters: convertZodToJsonSchema(AdjustBotConfigParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { botId, config } = params as z.infer<typeof AdjustBotConfigParamsSchema>;

    if (!ctx.botRepo) {
      return { success: false, error: 'direct db access not available' };
    }

    const configTarget = await ctx.botRepo.getBotById(botId);
    if (!configTarget || configTarget.creatorType !== 'agent' || configTarget.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent` };
    }

    const merged = deepMergeConfig(configTarget.config, config);
    await ctx.botRepo.updateBotConfig(botId, merged);

    return { success: true, data: { ok: true, botId, note: 'config updated — takes effect on next bot tick' } };
  },
};

export const botManagementTools: AgentTool[] = [
  createBotTool,
  listBotsTool,
  getBotStatusTool,
  stopBotTool,
  startBotTool,
  adjustBotConfigTool,
];
