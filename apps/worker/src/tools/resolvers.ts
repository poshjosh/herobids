import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- resolve_bot ---

const ResolveBotParamsSchema = z.object({
  name: z.string().min(1).describe('Bot name or symbol to resolve (e.g. "SOL momentum", "SOL/USDC"). Performs a case-insensitive substring match against bot config symbols and IDs.'),
});

const resolveBotTool: AgentTool<TradingToolContext> = {
  name: 'resolve_bot',
  description: 'Resolve a bot name or symbol to its bot ID. Use this before calling stop_bot, start_bot, get_bot_status, or adjust_bot_config when you only know the bot\'s trading symbol or label, not its UUID.',
  parametersSchema: ResolveBotParamsSchema,
  parameters: convertZodToJsonSchema(ResolveBotParamsSchema),
  category: 'read-database',
  promptGuidance: 'resolve_bot looks up a bot ID by name or symbol — stop_bot, start_bot, and adjust_bot_config require a bot ID. Matches case-insensitively against bot config symbols.',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { name } = params as z.infer<typeof ResolveBotParamsSchema>;

    if (!ctx.botRepo) {
      return {
        success: false,
        fault: false,
        error: 'Bot lookup not available in this context',
        errorCode: 'resolve.bot_repo_unavailable',
      };
    }

    try {
      const allBots = await ctx.botRepo.getBotsByCreator('agent', ctx.agentId);
      const searchTerm = name.toLowerCase();

      const matches = allBots.filter((bot) => {
        const symbol = typeof bot.config['symbol'] === 'string' ? bot.config['symbol'].toLowerCase() : '';
        const botId = bot.id.toLowerCase();
        return symbol.includes(searchTerm) || botId.includes(searchTerm);
      });

      if (matches.length === 0) {
        return {
          success: true,
          data: {
            ok: true,
            resolved: false,
            bots: [],
            hint: `No bots found matching "${name}". Use list_bots to see all your bots.`,
          },
        };
      }

      if (matches.length === 1) {
        const bot = matches[0]!;
        return {
          success: true,
          data: {
            ok: true,
            resolved: true,
            botId: bot.id,
            symbol: bot.config['symbol'] ?? null,
            status: bot.status,
          },
        };
      }

      // Multiple matches — return all candidates
      return {
        success: true,
        data: {
          ok: true,
          resolved: false,
          ambiguous: true,
          candidates: matches.map((b) => ({
            botId: b.id,
            symbol: b.config['symbol'] ?? null,
            status: b.status,
          })),
          hint: 'Multiple bots matched. Use the exact botId from the candidates list for your next call.',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        success: false,
        fault: false,
        error: `Bot resolution failed: ${message}`,
        errorCode: 'resolve.bot_failed',
      };
    }
  },
};

// --- resolve_watch ---

const ResolveWatchParamsSchema = z.object({
  note: z.string().optional().describe('Search watches by note text (case-insensitive substring match)'),
  symbol: z.string().optional().describe('Search watches by symbol (case-insensitive substring match)'),
}).refine((d) => d.note || d.symbol, { message: 'At least one of note or symbol is required' });

const resolveWatchTool: AgentTool<TradingToolContext> = {
  name: 'resolve_watch',
  description: 'Resolve a price watch to its watch ID by searching note text or symbol. Use this before calling remove_watch when you don\'t have the exact watch UUID.',
  parametersSchema: ResolveWatchParamsSchema,
  parameters: convertZodToJsonSchema(ResolveWatchParamsSchema),
  category: 'read-memory',
  promptGuidance: 'resolve_watch looks up a watch ID by note keyword or symbol — remove_watch requires a watch ID.',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { note, symbol } = params as z.infer<typeof ResolveWatchParamsSchema>;

    try {
      const raw = await ctx.redis.hgetall(`agent:watches:${ctx.agentId}`);
      if (!raw) {
        return {
          success: true,
          data: { ok: true, watches: [], hint: 'No watches found. Use watch_token to create one.' },
        };
      }

      const watches = Object.entries(raw).map(([watchId, rawVal]) => {
        try {
          const parsed = JSON.parse(rawVal);
          return { watchId, ...parsed };
        } catch {
          return { watchId, raw: rawVal };
        }
      });

      const noteLower = note?.toLowerCase();
      const symbolLower = symbol?.toLowerCase();

      const matches = watches.filter((w) => {
        const matchesNote = noteLower ? (typeof w.note === 'string' && w.note.toLowerCase().includes(noteLower)) : true;
        const matchesSymbol = symbolLower ? (typeof w.symbol === 'string' && w.symbol.toLowerCase().includes(symbolLower)) : true;
        return matchesNote && matchesSymbol;
      });

      if (matches.length === 0) {
        return {
          success: true,
          data: {
            ok: true,
            watches: [],
            hint: 'No watches matched your search. Use list_watches to see all active watches.',
          },
        };
      }

      return {
        success: true,
        data: {
          ok: true,
          count: matches.length,
          watches: matches.map((w) => ({
            watchId: w.watchId,
            symbol: w.symbol,
            chain: w.chain,
            condition: w.condition,
            thresholdPrice: w.thresholdPrice,
            note: w.note,
            createdAt: w.createdAt,
          })),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        success: false,
        fault: false,
        error: `Watch resolution failed: ${message}`,
        errorCode: 'resolve.watch_failed',
      };
    }
  },
};

// --- resolve_task ---

const ResolveTaskParamsSchema = z.object({
  title: z.string().min(1).describe('Search tasks by title (case-insensitive substring match)'),
});

const resolveTaskTool: AgentTool<TradingToolContext> = {
  name: 'resolve_task',
  description: 'Resolve a task title to its task ID. Use this before calling complete_task when you don\'t have the exact task UUID.',
  parametersSchema: ResolveTaskParamsSchema,
  parameters: convertZodToJsonSchema(ResolveTaskParamsSchema),
  category: 'read-memory',
  promptGuidance: 'resolve_task looks up a task ID by title — complete_task requires a task ID. Matches case-insensitively.',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const { title } = params as z.infer<typeof ResolveTaskParamsSchema>;

    try {
      const all = await ctx.redis.hgetall(`agent:tasks:${ctx.agentId}`);
      if (!all) {
        return {
          success: true,
          data: { ok: true, tasks: [], hint: 'No tasks found. Use create_task to create one.' },
        };
      }

      const searchTerm = title.toLowerCase();
      const tasks = Object.entries(all)
        .map(([taskId, rawVal]) => {
          try {
            const parsed = JSON.parse(rawVal);
            return { taskId, ...parsed };
          } catch {
            return { taskId, raw: rawVal };
          }
        })
        .filter((t) => typeof t.title === 'string' && t.title.toLowerCase().includes(searchTerm));

      if (tasks.length === 0) {
        return {
          success: true,
          data: {
            ok: true,
            tasks: [],
            hint: 'No tasks matched your search. Use list_tasks to see all tasks.',
          },
        };
      }

      return {
        success: true,
        data: {
          ok: true,
          count: tasks.length,
          tasks: tasks.map((t) => ({
            taskId: t.taskId,
            title: t.title,
            status: t.status,
            dueAt: t.dueAt ?? null,
            createdAt: t.createdAt,
          })),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        success: false,
        fault: false,
        error: `Task resolution failed: ${message}`,
        errorCode: 'resolve.task_failed',
      };
    }
  },
};

export const resolverTools: AgentTool<TradingToolContext>[] = [resolveBotTool, resolveWatchTool, resolveTaskTool];
