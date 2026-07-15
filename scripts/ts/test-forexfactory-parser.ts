/**
 * Test the ForexFactoryCalendarAdapter parser against real HTML.
 *
 * Usage:
 *   npx tsx scripts/ts/test-forexfactory-parser.ts file.html        # regex parser
 *   npx tsx scripts/ts/test-forexfactory-parser.ts file.html --llm  # LLM parser
 *   npx tsx scripts/ts/test-forexfactory-parser.ts --scrapfly       # live fetch via Scrapfly (requires SCRAPFLY_API_KEY)
 *   (--llm requires: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL env vars)
 */

import fs from 'node:fs';
import https from 'node:https';
import { ForexFactoryCalendarAdapter } from '../../packages/market-data/src/economic-calendar.js';
import { createScrapflyFetch } from '../../packages/market-data/src/scrapfly.js';
import type { EconomicEvent } from '../../packages/domain/src/ports/economic-calendar.js';
import type { RequestGate } from '../../packages/market-data/src/types.js';
import { HttpError } from '../../packages/market-data/src/http.js';

// ── Fetch real FF HTML via HTTP/1.1 ─────────────────────────────────────

function fetchFF(agent: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://www.forexfactory.com/calendar',
      {
        method: 'GET',
        headers: {
          'User-Agent': agent,
          Accept: 'text/html',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new HttpError(`HTTP ${res.statusCode}`, res.statusCode ?? 0));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── No-op rate limiter ──────────────────────────────────────────────────

const noopLimiter: RequestGate = {
  acquire: async () => {},
};

// ── Access the parser ───────────────────────────────────────────────────
//
// parseCalendar() is a private method. We create an adapter instance and
// access it via a cast to inspect the raw events that get returned.

interface ParsedResult {
  event: string;
  currency: string;
  time: string;
  impact: string;
  forecast: string | null;
  previous: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const useLlm = args.includes('--llm');
  const useScrapfly = args.includes('--scrapfly');
  const filePath = args.find(a => !a.startsWith('--'));
  let html: string;

  if (useScrapfly && filePath) {
    console.error('❌ --scrapfly cannot be combined with a file path — Scrapfly fetches live HTML.');
    process.exit(1);
  }

  if (useScrapfly) {
    const apiKey = process.env['SCRAPFLY_API_KEY'];
    if (!apiKey) {
      console.error('❌ --scrapfly requires SCRAPFLY_API_KEY env var');
      process.exit(1);
    }
    console.log('🛡️  Scrapfly mode (Cloudflare bypass via proxy)');
    const scrapflyFetch = createScrapflyFetch({
      apiKey,
      baseUrl: 'https://api.scrapfly.io/scrape',
      asp: true,
      requestTimeoutMs: 60_000,
    });

    process.stdout.write('Fetching Forex Factory /calendar via Scrapfly... ');
    const response = await scrapflyFetch('https://www.forexfactory.com/calendar');
    if (!response.ok) {
      console.error(`❌ Scrapfly returned HTTP ${response.status}`);
      process.exit(1);
    }
    html = await response.text();
    console.log(`${(html.length / 1024).toFixed(0)} KB`);
  } else if (filePath) {
    console.log(`Reading ${filePath}...`);
    html = fs.readFileSync(filePath, 'utf-8');
    console.log(`${(html.length / 1024).toFixed(0)} KB`);
  } else {
    process.stdout.write('Fetching Forex Factory /calendar... ');
    html = await fetchFF(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );
    console.log(`${(html.length / 1024).toFixed(0)} KB`);
  }

  const mockFetch = filePath
    ? (async () => ({ ok: true, status: 200, text: async () => html, json: async () => { throw new Error('Not JSON'); } })) as unknown as typeof fetch
    : undefined;

  // Build adapter config
  const adapterConfig: Record<string, unknown> = {
    baseUrl: 'https://www.forexfactory.com',
    requestTimeoutMs: 15_000,
    requestsPerMinute: 60,
    userAgent: 'Mozilla/5.0',
    rateLimiter: noopLimiter,
    ...(mockFetch ? { fetchFn: mockFetch } : {}),
  };

  if (useLlm) {
    const apiKey = process.env['LLM_API_KEY'];
    const baseUrl = process.env['LLM_BASE_URL'] ?? 'https://api.openai.com/v1';
    const model = process.env['LLM_MODEL'] ?? 'gpt-4o-mini';
    if (!apiKey) { console.error('❌ --llm requires LLM_API_KEY env var'); process.exit(1); }
    console.log(`🧠 LLM mode: ${model} @ ${baseUrl}`);

    // LLM parser function
    adapterConfig['parseHtmlFn'] = async (rawHtml: string): Promise<EconomicEvent[]> => {
      const tableMatch = rawHtml.match(/<table[^>]*class\s*=\s*["'][^"']*calendar[^"']*["'][^>]*>([\s\S]*?)<\/\s*table\s*>/i);
      const tableHtml = tableMatch?.[1] ?? rawHtml.slice(0, 50_000);
      const apiUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/chat/completions`;

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Extract economic calendar events from HTML. Return JSON: [{time:"ISO-8601 UTC",currency:"3-char",event:"title",impact:"high|medium|low",forecast:string|null,previous:string|null}]. Omit day-breaker/header rows. Only return JSON.' },
            { role: 'user', content: tableHtml },
          ],
          temperature: 0, max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`LLM API ${res.status}`);
      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content;
      if (!text) throw new Error('Empty response');
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('No JSON array found');
      return JSON.parse(match[0]) as EconomicEvent[];
    };
  } else {
    console.log('🔧 Regex mode');
  }

  const adapter = new ForexFactoryCalendarAdapter(adapterConfig as unknown as Parameters<typeof ForexFactoryCalendarAdapter>[0]);

  const result = await adapter.getUpcomingEvents({
    daysForward: 14,
    minImpact: 'low',
    currencies: [],
  });

  if (!result.ok) {
    console.error(`\n❌ ERROR: ${result.error.code} — ${result.error.message}`);
    process.exit(1);
  }

  const events = result.data.events;
  console.log(`\n📊 Parsed ${events.length} events from ${result.data.sources.join(', ')}`);

  // Count row-tag occurrences in raw HTML for comparison
  const rowCount = (html.match(/<tr[^>]*calendar__row/gi) || []).length;
  console.log(`   Raw <tr class="calendar__row"> found: ${rowCount}`);

  if (events.length === 0) {
    console.log('\n⚠️  PARSER RETURNED 0 EVENTS — likely HTML structure mismatch.');
    console.log('   Dumping the calendar table section for inspection...\n');

    // Find the calendar table
    const tableMatch = html.match(
      /<table[^>]*class\s*=\s*["'][^"']*calendar[^"']*["'][^>]*>([\s\S]*?)<\/\s*table\s*>/i,
    );
    if (tableMatch) {
      // Show first 3 rows
      const rows = tableMatch[1].match(/<tr[^>]*calendar__row[^>]*>/gi) || [];
      console.log(`   Table contains ${rows.length} tr.calendar__row elements\n`);
      console.log('   First 3 row tags:');
      rows.slice(0, 3).forEach((r) => console.log(`     ${r}`));

      // Show first 3 NON-day-breaker rows with td structure
      const allRows = tableMatch[1].match(/<tr[^>]*calendar__row[^>]*>[\s\S]*?<\/tr>/gi) || [];
      const eventRows = allRows.filter(r => !/calendar__row--day-breaker/i.test(r));
      console.log(`   Event rows (non-day-breaker): ${eventRows.length}`);
      
      for (let i = 0; i < Math.min(3, eventRows.length); i++) {
        const row = eventRows[i]!;
        console.log(`\n   === Event row ${i + 1} ===`);
        const tds = row.match(/<td[^>]*>[\s\S]*?<\/\s*td\s*>/gi) || [];
        console.log(`   ${tds.length} <td> elements:`);
        tds.forEach((td, j) => {
          const classMatch = td.match(/class\s*=\s*["']([^"']*)["']/i);
          const text = td.replace(/<[^>]*>/g, '').trim().slice(0, 50);
          console.log(`     [${j}] class="${classMatch?.[1] ?? 'none'}" → "${text}"`);
        });
      }
    }
  } else {
    // Show sample events
    console.log('\n📋 Sample events:');
    const sample = events.slice(0, 10);
    for (const e of sample) {
      const parts: string[] = [];
      parts.push(e.time.replace('T', ' ').substring(0, 16));
      parts.push(e.currency.padEnd(4));
      parts.push(e.impact.padEnd(7));
      parts.push(e.event);
      if (e.forecast) parts.push(`f/c:${e.forecast}`);
      if (e.previous) parts.push(`prev:${e.previous}`);
      console.log(`   ${parts.join('  ')}`);
    }

    // Summary stats
    const byCurrency = new Map<string, number>();
    const byImpact = new Map<string, number>();
    for (const e of events) {
      byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + 1);
      byImpact.set(e.impact, (byImpact.get(e.impact) ?? 0) + 1);
    }
    console.log('\n📊 By currency:');
    [...byCurrency.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([c, n]) => console.log(`   ${c}: ${n}`));
    console.log('📊 By impact:');
    [...byImpact.entries()]
      .sort((a, b) => (b[0] === 'high' ? 1 : b[0] === 'medium' ? 0 : -1) - (a[0] === 'high' ? 1 : a[0] === 'medium' ? 0 : -1))
      .forEach(([i, n]) => console.log(`   ${i}: ${n}`));
  }

  // Check if result matches expectations
  if (events.length === 0) {
    console.log('\n❌ FAIL: 0 events parsed. Parser needs updating for new HTML structure.');
    process.exit(1);
  } else if (events.length > rowCount * 0.3) {
    console.log(`\n✅ PASS: ${events.length} events parsed from ~${rowCount} raw rows.`);
  } else {
    console.log(`\n⚠️  WARN: Only ${events.length}/${rowCount} rows parsed — some rows may be skipped.`);
  }
}

main().catch((err) => {
  console.error(`\n❌ Script error: ${err.message}`);
  process.exit(1);
});
