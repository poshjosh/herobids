import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES, checkModeEscalation, deriveStrategyPreset, extractStrategyFromConfig } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('tools:bots');

// --- Agent-facing strategy input — discriminated union on strategy type ---

const StrategyInputSchema = z.discriminatedUnion('type', [
  // DCA: timer-driven, no decision mode
  z.object({
    type: z.literal('dca'),
    params: z.record(z.unknown()).optional(),
  }).describe('Dollar-cost averaging — buys on a fixed schedule, no signal required'),

  // Signal-based: decisionMode selects the engine
  z.object({
    type: z.enum(['momentum', 'range', 'contrarian', 'swing', 'scalper']),
    decisionMode: z.enum(['mechanical', 'llm', 'hybrid'])
      .describe('mechanical = indicator rules; llm = LLM decides; hybrid = indicators pre-filter then LLM'),
    params: z.record(z.unknown()).optional(),
  }),
]);

const BotConfigInputSchema = z.object({
  symbol: z.string().describe('Trading symbol, e.g. "HYPE-USDT"'),
  strategy: StrategyInputSchema,
  execution: z.object({
    mode: z.enum(['paper', 'shadow', 'live']).optional(),
    slippageBps: z.number().optional(),
  }).optional(),
  risk: z.record(z.unknown()).optional(),
  // venue and venueType are omitted — injected from the trading connection by the broker
});

// --- create_bot ---

const CreateBotParamsSchema = z.object({
  connectionId: z.string().optional().transform(v => v === '' ? undefined : v).describe('Connection ID to use. You can find this in the Capability Readiness section as "connection=<id>". Omit to use your default trading connection.'),
  config: BotConfigInputSchema.optional().describe('Bot configuration (strategy, symbol, risk params). venue is resolved from your trading connection automatically.'),
  rationale: z.string().max(500).optional().describe('Brief rationale for creating this bot. Used for audit.'),
  dryRun: z.boolean().optional().describe('If true, validates the bot config without creating it. Returns a preview of what would be sent.'),
});

const createBotTool: AgentTool = {
  name: 'create_bot',
  description: 'Create and start a new trading bot. The bot will run independently with its own strategy and risk parameters. Use when you want to delegate a trading opportunity to an automated bot.',
  parametersSchema: CreateBotParamsSchema,
  parameters: convertZodToJsonSchema(CreateBotParamsSchema),
  category: 'execute-trade',
  promptGuidance: 'dryRun=true previews the bot config without creating it. Use find_instrument to look up the correct config.symbol (use the symbol field from the result). get_schema("create_bot.config.strategy") and get_schema("create_bot.config.execution") show available strategy and execution options.',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { connectionId, config, rationale, dryRun } = params as z.infer<typeof CreateBotParamsSchema>;

    // Dry-run: validate and preview without creating.
    // Schema-level validation (shape, types, required fields) has already run
    // via Zod in executeTool(). Full business-logic validation (strategy params
    // validity, venue availability, risk limits) runs at engine publish time.
    if (dryRun) {
      return {
        success: true,
        data: {
          ok: true,
          dryRun: true,
          preview: {
            connectionId: connectionId ?? '(default trading connection)',
            config: config ?? null,
            rationale: rationale ?? null,
          },
          note: 'Dry run — schema-level validation passed. NOT created. Additional engine validation (strategy params, venue, risk) runs at creation time. Remove dryRun=true to execute.',
        },
      };
    }

    await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
      action: 'create_and_start',
      connectionId,
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
      return { success: false, error: 'direct db access not available', fault: false };
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
          strategyPreset: deriveStrategyPreset(extractStrategyFromConfig(b.config)?.type),
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
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const bot = await ctx.botRepo.getBotById(botId);
    if (!bot || bot.creatorType !== 'agent' || bot.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent`, fault: false };
    }

    return {
      success: true,
      data: {
        ok: true,
        id: bot.id,
        status: bot.status,
        strategyPreset: deriveStrategyPreset(extractStrategyFromConfig(bot.config)?.type),
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
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const stopTarget = await ctx.botRepo.getBotById(botId);
    if (!stopTarget || stopTarget.creatorType !== 'agent' || stopTarget.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent`, fault: false };
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
      return { success: false, data: { ok: false, botId, previousStatus, note: 'failed to signal bot stop' }, fault: false };
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
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const startTarget = await ctx.botRepo.getBotById(botId);
    if (!startTarget || startTarget.creatorType !== 'agent' || startTarget.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent`, fault: false };
    }

    if (startTarget.status === 'running') {
      return { success: false, error: `bot ${botId} is already running`, fault: false };
    }

    // Do NOT mark the bot running here — the broker handles the status transition
    // atomically via tryMarkBotRunningWithLimit when it processes the start action.
    // Pre-marking bypasses the limit check (two concurrent starts could both pass).
    try {
      await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'start',
        botId,
        rationale,
      });
    } catch (err) {
      logger.error({ err, botId }, 'Failed to enqueue direct bot start');
      return { success: false, data: { ok: false, botId, note: 'failed to submit bot start' }, fault: false };
    }

    return { success: true, data: { ok: true, botId, note: 'bot start submitted' } };
  },
};

// --- adjust_bot_config ---

/**
 * Partial strategy input for adjust_config — allows partial updates without requiring
 * the full strategy object (type, decisionMode etc.). Full validation happens at merge time.
 */
const StrategyPartialInputSchema = z.object({
  type: z.enum(['momentum', 'range', 'contrarian', 'swing', 'scalper', 'dca']).optional(),
  decisionMode: z.enum(['mechanical', 'llm', 'hybrid']).optional(),
  params: z.record(z.unknown()).optional(),
});

const AdjustBotConfigParamsSchema = z.object({
  botId: z.string().min(1).describe('ID of the bot to reconfigure'),
  config: z.object({
    strategy: StrategyPartialInputSchema.optional().describe('Updated strategy fields (partial merge)'),
    execution: z.object({
      mode: z.enum(['paper', 'shadow', 'live']).optional(),
      slippageBps: z.number().optional(),
    }).optional(),
    risk: z.record(z.unknown()).optional(),
    symbol: z.string().optional(),
  }).describe('Partial config object to merge with existing bot config'),
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
      return { success: false, error: 'direct db access not available', fault: false };
    }

    const configTarget = await ctx.botRepo.getBotById(botId);
    if (!configTarget || configTarget.creatorType !== 'agent' || configTarget.creatorId !== ctx.agentId) {
      return { success: false, error: `bot ${botId} not found or not owned by this agent`, fault: false };
    }

    // Enforce mode-rank: agent must not escalate a bot's execution mode beyond its own.
    const requestedMode = config.execution?.mode;
    if (requestedMode) {
      const check = checkModeEscalation(requestedMode, ctx.executionMode);
      if (!check.allowed) {
        return { success: false, error: check.error, fault: false };
      }
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
