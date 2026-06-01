import crypto from 'node:crypto';
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import type { Database } from './index.js';
import { decisionContexts, replayCorpora, replayMarketEvents, backtestRuns, llmDecisionArtifacts } from './schema/index.js';

export interface InsertDecisionContext {
  decisionId: string;
  tradingInstanceId: string;
  contextHash: string;
  context: {
    snapshot: { symbol: string; price: string; timestamp: string; data?: Record<string, unknown> };
    position: { side: string; size: string; entryPrice: string; realizedPnl: string } | null;
    referenceMark: { price: string; source: string } | null;
    balanceSnapshot: { balances: Array<{ asset: string; free: string; locked: string; total: string }> } | null;
    strategyParams: Record<string, unknown>;
  };
}

export interface InsertCorpus {
  name: string;
  source: string;
  venue: string;
  symbols: string[];
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface InsertMarketEvent {
  corpusId: string;
  venue: string;
  symbol: string;
  eventType: string;
  price: string;
  eventAt: Date;
  data?: Record<string, unknown>;
}

/**
 * Repository for backtesting data: corpora, market events, and decision contexts.
 */
export class BacktestingRepository {
  constructor(private readonly db: Database) {}

  // --- Decision Contexts ---

  async insertDecisionContext(ctx: InsertDecisionContext): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(decisionContexts).values({
      id,
      decisionId: ctx.decisionId,
      tradingInstanceId: ctx.tradingInstanceId,
      contextHash: ctx.contextHash,
      context: ctx.context,
    });
    return id;
  }

  async getDecisionContextByDecisionId(decisionId: string) {
    const [row] = await this.db
      .select()
      .from(decisionContexts)
      .where(eq(decisionContexts.decisionId, decisionId))
      .limit(1);
    return row ?? null;
  }

  async getDecisionContextByHash(contextHash: string) {
    const [row] = await this.db
      .select()
      .from(decisionContexts)
      .where(eq(decisionContexts.contextHash, contextHash))
      .limit(1);
    return row ?? null;
  }

  // --- Replay Corpora ---

  async insertCorpus(corpus: InsertCorpus): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(replayCorpora).values({
      id,
      userId: corpus.userId ?? null,
      name: corpus.name,
      source: corpus.source,
      venue: corpus.venue,
      symbols: corpus.symbols.join(','),
      metadata: corpus.metadata ?? null,
    });
    return id;
  }

  async getCorpusById(corpusId: string) {
    const [row] = await this.db
      .select()
      .from(replayCorpora)
      .where(eq(replayCorpora.id, corpusId))
      .limit(1);
    return row ?? null;
  }

  async getCorpusForUser(corpusId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(replayCorpora)
      .where(and(eq(replayCorpora.id, corpusId), eq(replayCorpora.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async listCorporaForUser(userId: string, limit = 50, offset = 0) {
    return this.db
      .select()
      .from(replayCorpora)
      .where(eq(replayCorpora.userId, userId))
      .orderBy(desc(replayCorpora.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async updateCorpusWindow(corpusId: string, startAt: Date, endAt: Date): Promise<void> {
    await this.db
      .update(replayCorpora)
      .set({ startAt, endAt })
      .where(eq(replayCorpora.id, corpusId));
  }

  /** Insert a corpus together with all its market events in a single transaction.
   * Prevents partial imports where the corpus row exists but events are missing
   * (or the time-window update never ran), which would cause opaque backtest failures. */
  async importCorpus(opts: InsertCorpus & {
    events: Array<Omit<InsertMarketEvent, 'corpusId'>>;
  }): Promise<{ corpusId: string; eventCount: number }> {
    return this.db.transaction(async (tx) => {
      const corpusId = crypto.randomUUID();
      await tx.insert(replayCorpora).values({
        id: corpusId,
        userId: opts.userId ?? null,
        name: opts.name,
        source: opts.source,
        venue: opts.venue,
        symbols: opts.symbols.join(','),
        metadata: opts.metadata ?? null,
      });

      if (opts.events.length > 0) {
        await tx.insert(replayMarketEvents).values(
          opts.events.map((event) => ({
            id: crypto.randomUUID(),
            corpusId,
            venue: event.venue,
            symbol: event.symbol,
            eventType: event.eventType,
            price: event.price,
            eventAt: event.eventAt,
            data: event.data ?? null,
          })),
        );
        const times = opts.events.map((e) => e.eventAt.getTime());
        const startAt = new Date(Math.min(...times));
        const endAt = new Date(Math.max(...times));
        await tx.update(replayCorpora).set({ startAt, endAt }).where(eq(replayCorpora.id, corpusId));
      }

      return { corpusId, eventCount: opts.events.length };
    });
  }

  // --- Replay Market Events ---

  async insertMarketEvent(event: InsertMarketEvent): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(replayMarketEvents).values({
      id,
      corpusId: event.corpusId,
      venue: event.venue,
      symbol: event.symbol,
      eventType: event.eventType,
      price: event.price,
      eventAt: event.eventAt,
      data: event.data ?? null,
    });
    return id;
  }

  async insertMarketEventsBatch(events: InsertMarketEvent[]): Promise<void> {
    if (events.length === 0) return;
    const rows = events.map((event) => ({
      id: crypto.randomUUID(),
      corpusId: event.corpusId,
      venue: event.venue,
      symbol: event.symbol,
      eventType: event.eventType,
      price: event.price,
      eventAt: event.eventAt,
      data: event.data ?? null,
    }));
    await this.db.insert(replayMarketEvents).values(rows);
  }

  /** Get market events for a corpus+symbol window, ordered by time ascending */
  async getMarketEvents(corpusId: string, symbol: string, opts?: { from?: Date; to?: Date; eventType?: string; venue?: string }) {
    const conditions = [
      eq(replayMarketEvents.corpusId, corpusId),
      eq(replayMarketEvents.symbol, symbol),
    ];
    if (opts?.venue) conditions.push(eq(replayMarketEvents.venue, opts.venue));
    if (opts?.eventType) conditions.push(eq(replayMarketEvents.eventType, opts.eventType));
    if (opts?.from) conditions.push(gte(replayMarketEvents.eventAt, opts.from));
    if (opts?.to) conditions.push(lte(replayMarketEvents.eventAt, opts.to));

    return this.db
      .select()
      .from(replayMarketEvents)
      .where(and(...conditions))
      .orderBy(replayMarketEvents.eventAt);
  }

  /** Detect gaps in the corpus — returns timestamps where the gap exceeds maxGapMs */
  async detectGaps(corpusId: string, symbol: string, maxGapMs: number, venue?: string, eventType?: string): Promise<Array<{ before: Date; after: Date; gapMs: number }>> {
    const conditions = [
      eq(replayMarketEvents.corpusId, corpusId),
      eq(replayMarketEvents.symbol, symbol),
    ];
    if (venue) conditions.push(eq(replayMarketEvents.venue, venue));
    if (eventType) conditions.push(eq(replayMarketEvents.eventType, eventType));

    const events = await this.db
      .select({ eventAt: replayMarketEvents.eventAt })
      .from(replayMarketEvents)
      .where(and(...conditions))
      .orderBy(replayMarketEvents.eventAt);

    const gaps: Array<{ before: Date; after: Date; gapMs: number }> = [];
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]!.eventAt;
      const curr = events[i]!.eventAt;
      const gapMs = curr.getTime() - prev.getTime();
      if (gapMs > maxGapMs) {
        gaps.push({ before: prev, after: curr, gapMs });
      }
    }
    return gaps;
  }

  // --- Backtest Runs ---

  async insertBacktestRun(run: {
    id: string;
    strategyType: string;
    config: Record<string, unknown>;
    corpusId?: string;
    venue: string;
    symbol: string;
    userId?: string;
  }): Promise<void> {
    await this.db.insert(backtestRuns).values({
      id: run.id,
      userId: run.userId ?? null,
      strategyType: run.strategyType,
      config: run.config,
      corpusId: run.corpusId ?? null,
      venue: run.venue,
      symbol: run.symbol,
      status: 'pending',
    });
  }

  async markBacktestRunning(runId: string): Promise<void> {
    await this.db
      .update(backtestRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(backtestRuns.id, runId));
  }

  async markBacktestCompleted(runId: string, metrics: Record<string, unknown>): Promise<void> {
    await this.db
      .update(backtestRuns)
      .set({ status: 'completed', metrics, completedAt: new Date() })
      .where(eq(backtestRuns.id, runId));
  }

  async markBacktestFailed(runId: string, error: { message: string; stack?: string }): Promise<void> {
    await this.db
      .update(backtestRuns)
      .set({ status: 'failed', error, completedAt: new Date() })
      .where(eq(backtestRuns.id, runId));
  }

  async getBacktestRun(runId: string) {
    const [row] = await this.db
      .select()
      .from(backtestRuns)
      .where(eq(backtestRuns.id, runId))
      .limit(1);
    return row ?? null;
  }

  async getBacktestRunForUser(runId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(backtestRuns)
      .where(and(eq(backtestRuns.id, runId), eq(backtestRuns.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async listBacktestRuns(limit = 50, offset = 0) {
    return this.db
      .select()
      .from(backtestRuns)
      .orderBy(desc(backtestRuns.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async listBacktestRunsForUser(userId: string, limit = 50, offset = 0) {
    return this.db
      .select()
      .from(backtestRuns)
      .where(eq(backtestRuns.userId, userId))
      .orderBy(desc(backtestRuns.createdAt))
      .limit(limit)
      .offset(offset);
  }

  // --- LLM Decision Artifacts ---

  async insertLlmArtifact(artifact: {
    decisionId: string;
    contextHash: string;
    context: Record<string, unknown>;
    promptPayload: string;
    promptVersion: string;
    rawResponse: string | null;
    parsedDecision: Record<string, unknown> | null;
    parseStatus: string;
    parseError?: string;
    provider: string;
    model: string;
    tokensUsed: number;
    latencyMs: number;
    cached: boolean;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(llmDecisionArtifacts).values({
      id,
      decisionId: artifact.decisionId,
      contextHash: artifact.contextHash,
      context: artifact.context,
      promptPayload: artifact.promptPayload,
      promptVersion: artifact.promptVersion,
      rawResponse: artifact.rawResponse,
      parsedDecision: artifact.parsedDecision,
      parseStatus: artifact.parseStatus,
      parseError: artifact.parseError ?? null,
      provider: artifact.provider,
      model: artifact.model,
      tokensUsed: artifact.tokensUsed,
      latencyMs: artifact.latencyMs,
      cached: artifact.cached,
    });
    return id;
  }

  async getLlmArtifactByDecisionId(decisionId: string) {
    const [row] = await this.db
      .select()
      .from(llmDecisionArtifacts)
      .where(eq(llmDecisionArtifacts.decisionId, decisionId))
      .limit(1);
    return row ?? null;
  }
}
