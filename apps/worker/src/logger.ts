import { pino } from 'pino';
import type { Logger } from 'pino';
import { createRequire } from 'node:module';

// ── Pretty-print detection ──────────────────────────────────────────────────
// Uses the same heuristic as the original top-level loggers: LOG_FORMAT=pretty
// or NODE_ENV=development.
const isPrettyLog = process.env['LOG_FORMAT'] === 'pretty' || process.env['NODE_ENV'] === 'development';

// ── Lazy-loaded pretty stream ───────────────────────────────────────────────
// pino v9's transport.target resolver can't find pino-pretty inside
// pnpm deploy --prod containers (different resolution path), so we bypass it
// entirely: import pino-pretty via createRequire and pass its stream directly
// to pino().
function getPrettyStream() {
  const _require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = _require('pino-pretty');
  const fn = typeof mod === 'function' ? mod : (mod.default ?? mod);
  return fn({ colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' });
}

let prettyStream: ReturnType<typeof getPrettyStream> | undefined;

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a pino logger with the given name. When LOG_FORMAT=pretty (or
 * NODE_ENV=development) the output is human-readable; otherwise it is
 * structured JSON.
 *
 * Replace all standalone `pino({ name: '...' })` calls with this factory.
 */
export function createLogger(name: string): Logger {
  if (!isPrettyLog) {
    return pino({ name });
  }
  prettyStream ??= getPrettyStream();
  return pino({ name }, prettyStream);
}
