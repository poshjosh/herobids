import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES, checkModeEscalation } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult } from './traderton-read.js';
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
    // coerce: LLMs may send numbers as strings
    slippageBps: z.coerce.number().optional(),
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
  // coerce: LLMs may send numbers as strings
  days: z.coerce.number().int().positive().optional().describe('Only return bots created within this many days'),
});

const listBotsTool: AgentTool = {
  name: 'list_bots',
  description: 'List bots created by this agent. Optionally filter by creation date (days). Returns bot ID, status, strategy preset, and symbol.',
  parametersSchema: ListBotsParamsSchema,
  parameters: convertZodToJsonSchema(ListBotsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { days } = params as z.infer<typeof ListBotsParamsSchema>;

    // c4.9i: the Traderton boundary is the sole source. `days` is optional and
    // forwarded as-is (undefined when not supplied). Fail-closed when the
    // boundary is absent (the dead in-process botRepo read was removed).
    if (!ctx.tradertonBoundary) {
      return { success: false, error: 'trading boundary not configured', errorCode: 'precondition.not_ready', fault: false };
    }

    const result = await ctx.tradertonBoundary.invoke({ toolName: 'list_bots', payload: { days } });
    return mapReadResultToToolResult(result);
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

    // c4.9i: the Traderton boundary is the sole source. Ownership + not-found
    // are enforced boundary-side and surface as typed failures. Fail-closed when
    // the boundary is absent (the dead in-process botRepo read was removed).
    if (!ctx.tradertonBoundary) {
      return { success: false, error: 'trading boundary not configured', errorCode: 'precondition.not_ready', fault: false };
    }

    const result = await ctx.tradertonBoundary.invoke({ toolName: 'get_bot_status', payload: { botId } });
    return mapReadResultToToolResult(result);
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

    // L3c: route the side effect through the broker's rewired MANAGE_BOT path
    // (consistent with create_bot/start_bot), which invokes the Traderton
    // boundary. The direct botRepo write + `bot:stop` redis signal are removed —
    // herobids owns no bot state. Ownership is enforced boundary-side via the
    // injected subject. See 004-l3d-plan.md §C.
    try {
      await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'stop',
        botId,
      });
    } catch (err) {
      logger.error({ err, botId }, 'Failed to submit bot stop');
      return { success: false, data: { ok: false, botId, note: 'failed to submit bot stop' }, fault: false };
    }

    return { success: true, data: { ok: true, botId, note: 'bot stop submitted' } };
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

    // L3c: publish MANAGE_BOT to the broker's rewired path, which invokes the
    // boundary. The local botRepo ownership/status pre-check is removed —
    // herobids owns no bot state; the boundary validates ownership + status from
    // the injected subject. See 004-l3d-plan.md §C.
    try {
      await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'start',
        botId,
        rationale,
      });
    } catch (err) {
      logger.error({ err, botId }, 'Failed to submit bot start');
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
      // coerce: LLMs may send numbers as strings
      slippageBps: z.coerce.number().optional(),
    }).optional(),
    risk: z.record(z.unknown()).optional(),
    symbol: z.string().optional(),
  }).describe('Partial config object to merge with existing bot config'),
});

// L3c: deepMergeConfig removed — the bot-config merge moved behind the boundary
// (Traderton owns the config). See 004-l3d-plan.md §C.

const adjustBotConfigTool: AgentTool = {
  name: 'adjust_bot_config',
  description: 'Update configuration for a specific bot. Changes are merged with existing config and take effect on the next bot tick. Only works for bots owned by this agent.',
  parametersSchema: AdjustBotConfigParamsSchema,
  parameters: convertZodToJsonSchema(AdjustBotConfigParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { botId, config } = params as z.infer<typeof AdjustBotConfigParamsSchema>;

    // Enforce mode-rank: agent must not escalate a bot's execution mode beyond
    // its own. This is a platform gate on a platform-owned value (ctx.executionMode)
    // — kept. The broker re-checks it too (defence-in-depth).
    const requestedMode = config.execution?.mode;
    if (requestedMode) {
      const check = checkModeEscalation(requestedMode, ctx.executionMode);
      if (!check.allowed) {
        return { success: false, error: check.error, fault: false };
      }
    }

    // L3c: route the config change through the broker's rewired MANAGE_BOT path,
    // which invokes the boundary. The base-config read + deep-merge + botRepo
    // write are removed — Traderton owns the bot config and performs the merge.
    // Ownership is enforced boundary-side. See 004-l3d-plan.md §C.
    try {
      await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'adjust_config',
        botId,
        config,
      });
    } catch (err) {
      logger.error({ err, botId }, 'Failed to submit bot config adjustment');
      return { success: false, data: { ok: false, botId, note: 'failed to submit config adjustment' }, fault: false };
    }

    return { success: true, data: { ok: true, botId, note: 'config adjustment submitted — takes effect on next bot tick' } };
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
