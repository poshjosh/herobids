import type { FastifyInstance } from 'fastify';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { eq, and, gte, lte, inArray, asc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  bots,
  agents,
  agentSkills,
  fills,
  journalEvents,
  positions,
  loadAgentFills,
  loadAgentJournalEvents,
  loadAgentRuntimeSessions,
  loadAgentPositions,
} from '@herobids/db';

// --- Rate limiter (5 req / 60 s per user) ---

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Sliding-window request timestamps per user. */
const rateLimitStore = new Map<string, number[]>();

/** Clear the rate limit store. Exposed for use in tests only. */
export function clearRateLimitStore(): void {
  rateLimitStore.clear();
}

function checkRateLimit(userId: string): { allowed: boolean; retryAfterSecs: number } {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (rateLimitStore.get(userId) ?? []).filter((t) => t > windowStart);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    const oldest = timestamps[0]!;
    const retryAfterSecs = Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSecs };
  }

  timestamps.push(now);
  rateLimitStore.set(userId, timestamps);
  return { allowed: true, retryAfterSecs: 0 };
}

// --- Query schemas ---

const TradesQuerySchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // tz: date display timezone — all dates are stored and returned as UTC ISO-8601.
  // Client-side timezone conversion is the caller's responsibility.
});

const JournalQuerySchema = z.object({
  format: z.enum(['md', 'json', 'csv']).default('csv'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const ConfigQuerySchema = z.object({
  format: z.enum(['yaml', 'json']).default('json'),
});

const ReportQuerySchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
});

// --- Helpers ---

const TRADES_CSV_HEADERS = 'date,side,symbol,quantity,price,pnl,fee,sessionId';

type FillRow = typeof fills.$inferSelect;

async function listSkillIdsForAgent(db: Database, agentId: string): Promise<string[]> {
  const rows = await db.select({ skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(agentSkills.orderIndex), asc(agentSkills.skillId));
  return rows.map((row) => row.skillId);
}

function fillsToCsv(rows: FillRow[]): string {
  const lines = [TRADES_CSV_HEADERS];
  for (const row of rows) {
    const date = row.filledAt.toISOString();
    const side = row.side;
    const symbol = row.symbol;
    const quantity = row.quantity;
    const price = row.price;
    const pnl = ''; // PnL per-fill requires cost-basis matching; not stored in fills
    const fee = row.fee ?? '';
    const sessionId = ''; // fills are not directly session-scoped in the schema
    lines.push(`${date},${side},${symbol},${quantity},${price},${pnl},${fee},${sessionId}`);
  }
  return lines.join('\n');
}

function fillsToJsonArray(rows: FillRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    date: row.filledAt.toISOString(),
    side: row.side,
    symbol: row.symbol,
    quantity: row.quantity,
    price: row.price,
    pnl: null,
    fee: row.fee ?? null,
    feeCurrency: row.feeCurrency ?? null,
    sessionId: null,
    venueRefId: row.venueRefId ?? null,
  }));
}

type JournalRow = typeof journalEvents.$inferSelect;

function eventsToMarkdown(rows: JournalRow[]): string {
  const lines: string[] = ['# Journal Export', ''];
  for (const row of rows) {
    const ts = row.createdAt.toISOString();
    lines.push(`## ${row.type} — ${ts}`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(row.payload, null, 2));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

/** Strip any sensitive keys from a config object (deep, non-mutating). */
function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = new Set([
    'apiKey', 'api_key', 'privateKey', 'private_key', 'secret', 'secretKey', 'secret_key',
    'mnemonic', 'seed', 'password', 'token', 'accessToken', 'access_token',
    'refreshToken', 'refresh_token', 'credential', 'credentials',
  ]);

  function sanitize(val: unknown): unknown {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(sanitize);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '[redacted]' : sanitize(v);
    }
    return out;
  }

  return sanitize(config) as Record<string, unknown>;
}

type PositionRow = typeof positions.$inferSelect;

type ReportData = {
  tradeCount: number;
  winRate: number | null;
  totalPnl: number | null;
  sharpeRatio: number | null;
};

/**
 * Compute trading report metrics from closed positions.
 *
 * - totalPnl: sum of realizedPnl across all closed positions.
 * - winRate: fraction of closed positions with realizedPnl > 0 (null if < 2 closed positions).
 * - sharpeRatio: mean daily PnL / std-dev daily PnL (null if < 2 trading days of data).
 *   Uses a simplified daily bucketing with no risk-free rate deduction.
 */
function computeReport(fillRows: FillRow[], closedPositions: PositionRow[]): ReportData {
  const tradeCount = fillRows.length;

  const closed = closedPositions.filter((p) => p.closedAt !== null);

  // totalPnl — sum of realizedPnl across closed positions
  const totalPnl = closed.length > 0
    ? closed.reduce((sum, p) => sum + parseFloat(p.realizedPnl), 0)
    : null;

  // winRate — fraction of closed positions with positive PnL (null if insufficient data)
  const winRate = closed.length >= 2
    ? closed.filter((p) => parseFloat(p.realizedPnl) > 0).length / closed.length
    : null;

  // sharpeRatio — mean/stddev of daily PnL buckets (null if < 2 days)
  let sharpeRatio: number | null = null;
  if (closed.length >= 2) {
    const dailyPnl: Record<string, number> = {};
    for (const p of closed) {
      const day = p.closedAt!.toISOString().slice(0, 10);
      dailyPnl[day] = (dailyPnl[day] ?? 0) + parseFloat(p.realizedPnl);
    }
    const days = Object.values(dailyPnl);
    if (days.length >= 2) {
      const mean = days.reduce((a, b) => a + b, 0) / days.length;
      const variance = days.reduce((a, b) => a + (b - mean) ** 2, 0) / days.length;
      const stddev = Math.sqrt(variance);
      sharpeRatio = stddev > 0 ? mean / stddev : null;
    }
  }

  return { tradeCount, winRate, totalPnl, sharpeRatio };
}

function reportToCsv(report: ReportData): string {
  const headers = 'tradeCount,winRate,totalPnl,sharpeRatio';
  const values = [
    report.tradeCount,
    report.winRate ?? '',
    report.totalPnl ?? '',
    report.sharpeRatio ?? '',
  ].join(',');
  return `${headers}\n${values}`;
}

// --- Minimal in-memory ZIP builder (no temp files) ---

function crc32(buf: Buffer): number {
  // CRC-32 table (polynomial 0xEDB88320)
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]!) & 0xFF]! ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(): { time: number; date: number } {
  const now = new Date();
  const time = ((now.getHours() & 0x1F) << 11) | ((now.getMinutes() & 0x3F) << 5) | ((now.getSeconds() >> 1) & 0x1F);
  const date = (((now.getFullYear() - 1980) & 0x7F) << 9) | (((now.getMonth() + 1) & 0x0F) << 5) | (now.getDate() & 0x1F);
  return { time, date };
}

function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const { time, date } = dosDateTime();
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // compression: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    nameBytes.copy(local, 30);

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);           // flags
    central.writeUInt16LE(0, 10);          // compression
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);          // extra field length
    central.writeUInt16LE(0, 32);          // comment length
    central.writeUInt16LE(0, 34);          // disk start
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE(0, 38);          // external attrs
    central.writeUInt32LE(offset, 42);     // offset of local header
    nameBytes.copy(central, 46);

    localHeaders.push(local, data);
    centralHeaders.push(central);
    offset += local.length + data.length;
  }

  const cdOffset = offset;
  const cdSize = centralHeaders.reduce((s, b) => s + b.length, 0);
  const count = files.length;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);              // disk number
  eocd.writeUInt16LE(0, 6);             // start disk
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);            // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

// --- Middleware helper ---

function applyRateLimit(app: FastifyInstance): void {
  app.addHook('preHandler', async (request, reply) => {
    // Only apply to export paths
    if (!request.url.includes('/export')) return;
    const { allowed, retryAfterSecs } = checkRateLimit(request.userId);
    if (!allowed) {
      void reply.header('Retry-After', String(retryAfterSecs));
      return reply.status(429).send({ error: 'rate_limit_exceeded', retryAfterSecs });
    }
  });
}

// --- Route module ---

export async function exportRoutes(app: FastifyInstance, db: Database): Promise<void> {
  applyRateLimit(app);

  // ── Bot exports ────────────────────────────────────────────────────────────

  // GET /bots/:id/export/trades
  app.get<{ Params: { id: string }; Querystring: z.infer<typeof TradesQuerySchema> }>(
    '/bots/:id/export/trades',
    async (request, reply) => {
      const { id } = request.params;
      const parsed = TradesQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });

      const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
      if (!bot) return reply.status(404).send({ error: 'not_found' });

      const conditions = [eq(fills.actorType, 'bot'), eq(fills.actorId, id)];
      if (parsed.data.from) conditions.push(gte(fills.filledAt, new Date(parsed.data.from)));
      if (parsed.data.to) conditions.push(lte(fills.filledAt, new Date(parsed.data.to)));

      const rows = await db.select().from(fills).where(and(...conditions));

      if (parsed.data.format === 'csv') {
        void reply.header('Content-Type', 'text/csv');
        void reply.header('Content-Disposition', `attachment; filename="bot-${id}-trades.csv"`);
        return reply.send(fillsToCsv(rows));
      }

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', `attachment; filename="bot-${id}-trades.json"`);
      return reply.send(fillsToJsonArray(rows));
    },
  );

  // GET /bots/:id/export/journal
  app.get<{ Params: { id: string }; Querystring: z.infer<typeof JournalQuerySchema> }>(
    '/bots/:id/export/journal',
    async (request, reply) => {
      const { id } = request.params;
      const parsed = JournalQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });

      const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
      if (!bot) return reply.status(404).send({ error: 'not_found' });

      const conditions = [eq(journalEvents.actorId, id)];
      if (parsed.data.from) conditions.push(gte(journalEvents.createdAt, new Date(parsed.data.from)));
      if (parsed.data.to) conditions.push(lte(journalEvents.createdAt, new Date(parsed.data.to)));

      const rows = await db.select().from(journalEvents).where(and(...conditions));

      if (parsed.data.format === 'md') {
        void reply.header('Content-Type', 'text/markdown');
        void reply.header('Content-Disposition', `attachment; filename="bot-${id}-journal.md"`);
        return reply.send(eventsToMarkdown(rows));
      }

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', `attachment; filename="bot-${id}-journal.json"`);
      return reply.send(rows);
    },
  );

  // GET /bots/:id/export/config
  app.get<{ Params: { id: string }; Querystring: z.infer<typeof ConfigQuerySchema> }>(
    '/bots/:id/export/config',
    async (request, reply) => {
      const { id } = request.params;
      const parsed = ConfigQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });

      const [bot] = await db.select({ id: bots.id, config: bots.config }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
      if (!bot) return reply.status(404).send({ error: 'not_found' });

      const clean = sanitizeConfig(bot.config as Record<string, unknown>);

      if (parsed.data.format === 'yaml') {
        void reply.header('Content-Type', 'application/yaml');
        void reply.header('Content-Disposition', `attachment; filename="bot-${id}-config.yaml"`);
        return reply.send(stringifyYaml(clean));
      }

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', `attachment; filename="bot-${id}-config.json"`);
      return reply.send(clean);
    },
  );

  // GET /bots/:id/export/report
  app.get<{ Params: { id: string }; Querystring: z.infer<typeof ReportQuerySchema> }>(
    '/bots/:id/export/report',
    async (request, reply) => {
      const { id } = request.params;
      const parsed = ReportQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });

      const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
      if (!bot) return reply.status(404).send({ error: 'not_found' });

      const [fillRows, closedPositions] = await Promise.all([
        db.select().from(fills).where(and(eq(fills.actorType, 'bot'), eq(fills.actorId, id))),
        db.select().from(positions).where(and(
          eq(positions.actorType, 'bot'),
          eq(positions.actorId, id),
        )),
      ]);
      const report = computeReport(fillRows, closedPositions);

      if (parsed.data.format === 'csv') {
        void reply.header('Content-Type', 'text/csv');
        void reply.header('Content-Disposition', `attachment; filename="bot-${id}-report.csv"`);
        return reply.send(reportToCsv(report));
      }

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', `attachment; filename="bot-${id}-report.json"`);
      return reply.send(report);
    },
  );

  // GET /bots/:id/export/bundle — ZIP: trades.csv + journal.md + config.yaml + report.json
  app.get<{ Params: { id: string } }>(
    '/bots/:id/export/bundle',
    async (request, reply) => {
      const { id } = request.params;

      const [bot] = await db.select({ id: bots.id, config: bots.config }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
      if (!bot) return reply.status(404).send({ error: 'not_found' });

      const [fillRows, journalRows, closedPositions] = await Promise.all([
        db.select().from(fills).where(and(eq(fills.actorType, 'bot'), eq(fills.actorId, id))),
        db.select().from(journalEvents).where(eq(journalEvents.actorId, id)),
        db.select().from(positions).where(and(
          eq(positions.actorType, 'bot'),
          eq(positions.actorId, id),
        )),
      ]);
      const clean = sanitizeConfig(bot.config as Record<string, unknown>);
      const report = computeReport(fillRows, closedPositions);

      const zip = buildZip([
        { name: 'trades.csv', data: Buffer.from(fillsToCsv(fillRows)) },
        { name: 'journal.md', data: Buffer.from(eventsToMarkdown(journalRows)) },
        { name: 'config.yaml', data: Buffer.from(stringifyYaml(clean)) },
        { name: 'report.json', data: Buffer.from(JSON.stringify(report, null, 2)) },
      ]);

      void reply.header('Content-Type', 'application/zip');
      void reply.header('Content-Disposition', `attachment; filename="bot-${id}-bundle.zip"`);
      return reply.send(zip);
    },
  );

  // ── Account-level exports ──────────────────────────────────────────────────

  // GET /export/trades — all fills for the authenticated user
  app.get<{ Querystring: z.infer<typeof TradesQuerySchema> }>(
    '/export/trades',
    async (request, reply) => {
      const parsed = TradesQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });

      // Fetch all bot IDs owned by this user to scope the fills query
      const userBots = await db.select({ id: bots.id }).from(bots)
        .where(eq(bots.userId, request.userId));
      const botIds = userBots.map((b) => b.id);

      if (botIds.length === 0) {
        if (parsed.data.format === 'csv') {
          void reply.header('Content-Type', 'text/csv');
          void reply.header('Content-Disposition', 'attachment; filename="trades.csv"');
          return reply.send(TRADES_CSV_HEADERS);
        }
        void reply.header('Content-Type', 'application/json');
        void reply.header('Content-Disposition', 'attachment; filename="trades.json"');
        return reply.send([]);
      }

      const conditions = [
        eq(fills.actorType, 'bot'),
        inArray(fills.actorId, botIds),
      ];
      if (parsed.data.from) conditions.push(gte(fills.filledAt, new Date(parsed.data.from)));
      if (parsed.data.to) conditions.push(lte(fills.filledAt, new Date(parsed.data.to)));

      const rows = await db.select().from(fills).where(and(...conditions));

      if (parsed.data.format === 'csv') {
        void reply.header('Content-Type', 'text/csv');
        void reply.header('Content-Disposition', 'attachment; filename="trades.csv"');
        return reply.send(fillsToCsv(rows));
      }

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', 'attachment; filename="trades.json"');
      return reply.send(fillsToJsonArray(rows));
    },
  );

  // GET /export/bundle — ZIP of all user data
  app.get('/export/bundle', async (request, reply) => {
    const userBots = await db.select({ id: bots.id, config: bots.config }).from(bots)
      .where(eq(bots.userId, request.userId));
    const botIds = userBots.map((b) => b.id);

    const [allFills, allJournal, allPositions] = botIds.length > 0
      ? await Promise.all([
          db.select().from(fills).where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds))),
          db.select().from(journalEvents).where(inArray(journalEvents.actorId, botIds)),
          db.select().from(positions).where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds))),
        ])
      : [[], [], []];

    const report = computeReport(allFills, allPositions);

    const zip = buildZip([
      { name: 'trades.csv', data: Buffer.from(fillsToCsv(allFills)) },
      { name: 'journal.md', data: Buffer.from(eventsToMarkdown(allJournal)) },
      { name: 'report.json', data: Buffer.from(JSON.stringify(report, null, 2)) },
    ]);

    void reply.header('Content-Type', 'application/zip');
    void reply.header('Content-Disposition', 'attachment; filename="export-bundle.zip"');
    return reply.send(zip);
  });

  // ── Agent exports ──────────────────────────────────────────────────────────

  // GET /agents/:id/export/trades
  app.get<{ Params: { id: string }; Querystring: z.infer<typeof TradesQuerySchema> }>(
    '/agents/:id/export/trades',
    async (request, reply) => {
      const { id } = request.params;
      const parsed = TradesQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });

      const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const rows = await loadAgentFills(db, id, {
        from: parsed.data.from ? new Date(parsed.data.from) : undefined,
        to: parsed.data.to ? new Date(parsed.data.to) : undefined,
      });

      if (parsed.data.format === 'csv') {
        void reply.header('Content-Type', 'text/csv');
        void reply.header('Content-Disposition', `attachment; filename="agent-${id}-trades.csv"`);
        return reply.send(fillsToCsv(rows));
      }

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', `attachment; filename="agent-${id}-trades.json"`);
      return reply.send(fillsToJsonArray(rows));
    },
  );

  // GET /agents/:id/export/journal
  app.get<{ Params: { id: string }; Querystring: z.infer<typeof JournalQuerySchema> }>(
    '/agents/:id/export/journal',
    async (request, reply) => {
      const { id } = request.params;
      const parsed = JournalQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });

      const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const rows = await loadAgentJournalEvents(db, id, {
        from: parsed.data.from ? new Date(parsed.data.from) : undefined,
        to: parsed.data.to ? new Date(parsed.data.to) : undefined,
      });

      if (parsed.data.format === 'md') {
        void reply.header('Content-Type', 'text/markdown');
        void reply.header('Content-Disposition', `attachment; filename="agent-${id}-journal.md"`);
        return reply.send(eventsToMarkdown(rows));
      }

      if (parsed.data.format === 'csv') {
        const header = 'id,actor_type,actor_id,type,created_at\n';
        const csvRows = rows.map((r) =>
          [r.id, r.actorType ?? '', r.actorId ?? '', r.type, r.createdAt.toISOString()].join(','),
        ).join('\n');
        void reply.header('Content-Type', 'text/csv');
        void reply.header('Content-Disposition', `attachment; filename="agent-${id}-journal.csv"`);
        return reply.send(header + csvRows);
      }

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', `attachment; filename="agent-${id}-journal.json"`);
      return reply.send(rows);
    },
  );

  // GET /agents/:id/export/costs — fee totals by currency for all agent-owned bots
  app.get<{ Params: { id: string } }>(
    '/agents/:id/export/costs',
    async (request, reply) => {
      const { id } = request.params;

      const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const fillRows = await loadAgentFills(db, id);

      if (fillRows.length === 0) {
        void reply.header('Content-Type', 'text/csv');
        void reply.header('Content-Disposition', `attachment; filename="agent-${id}-costs.csv"`);
        return reply.send('currency,total_fees\n');
      }

      const feesByCurrency: Record<string, number> = {};
      for (const row of fillRows) {
        const currency = row.feeCurrency ?? 'unknown';
        feesByCurrency[currency] = (feesByCurrency[currency] ?? 0) + parseFloat(row.fee ?? '0');
      }

      const csvHeader = 'currency,total_fees\n';
      const csvRows = Object.entries(feesByCurrency).map(([c, f]) => `${c},${f}`).join('\n');
      void reply.header('Content-Type', 'text/csv');
      void reply.header('Content-Disposition', `attachment; filename="agent-${id}-costs.csv"`);
      return reply.send(csvHeader + csvRows);
    },
  );

  // GET /agents/:id/export/sessions
  app.get<{ Params: { id: string } }>(
    '/agents/:id/export/sessions',
    async (request, reply) => {
      const { id } = request.params;

      const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const sessions = await loadAgentRuntimeSessions(db, id);

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', `attachment; filename="agent-${id}-sessions.json"`);
      return reply.send(sessions);
    },
  );

  // GET /agents/:id/export/config
  app.get<{ Params: { id: string }; Querystring: z.infer<typeof ConfigQuerySchema> }>(
    '/agents/:id/export/config',
    async (request, reply) => {
      const { id } = request.params;
      const parsed = ConfigQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });

      const [agent] = await db.select().from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });
      const skillIds = await listSkillIdsForAgent(db, id);

      // Strip sensitive fields from agent config (toolPolicy, modelPolicy may contain tokens)
      const agentData = sanitizeConfig({
        id: agent.id,
        name: agent.name,
        prompt: agent.prompt,
        status: agent.status,
        skillIds,
        executionMode: agent.executionMode,
        dailyLossLimit: agent.dailyLossLimit,
        maxBots: agent.maxBots,
        maxSlippageBps: agent.maxSlippageBps,
        createdAt: agent.createdAt instanceof Date ? agent.createdAt.toISOString() : agent.createdAt,
      } as Record<string, unknown>);

      if (parsed.data.format === 'yaml') {
        void reply.header('Content-Type', 'application/yaml');
        void reply.header('Content-Disposition', `attachment; filename="agent-${id}-config.yaml"`);
        return reply.send(stringifyYaml(agentData));
      }

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', `attachment; filename="agent-${id}-config.json"`);
      return reply.send(agentData);
    },
  );

  // GET /agents/:id/export/bundle
  app.get<{ Params: { id: string } }>(
    '/agents/:id/export/bundle',
    async (request, reply) => {
      const { id } = request.params;

      const [agent] = await db.select().from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });
      const skillIds = await listSkillIdsForAgent(db, id);

      // Use shared loaders sequentially (each calls loadAgentBotIds internally;
      // sequential calls keep mock DB select ordering deterministic for tests).
      const allFills = await loadAgentFills(db, id);
      const allPositions = await loadAgentPositions(db, id);
      const journalRows = await loadAgentJournalEvents(db, id);
      const sessions = await loadAgentRuntimeSessions(db, id);

      const agentConfig = sanitizeConfig({
        id: agent.id,
        name: agent.name,
        prompt: agent.prompt,
        status: agent.status,
        skillIds,
        executionMode: agent.executionMode,
        dailyLossLimit: agent.dailyLossLimit,
        maxBots: agent.maxBots,
        maxSlippageBps: agent.maxSlippageBps,
        createdAt: agent.createdAt instanceof Date ? agent.createdAt.toISOString() : agent.createdAt,
      } as Record<string, unknown>);

      const report = computeReport(allFills, allPositions);
      const feesByCurrency: Record<string, number> = {};
      for (const row of allFills) {
        const currency = row.feeCurrency ?? 'unknown';
        feesByCurrency[currency] = (feesByCurrency[currency] ?? 0) + parseFloat(row.fee ?? '0');
      }

      void reply.header('Content-Type', 'application/json');
      void reply.header('Content-Disposition', `attachment; filename="agent-${id}-bundle.json"`);
      return reply.send({
        agent: agentConfig,
        trades: allFills,
        journal: journalRows,
        sessions,
        costs: { agentId: id, feesByCurrency },
        report,
        exportedAt: new Date().toISOString(),
      });
    },
  );
}
