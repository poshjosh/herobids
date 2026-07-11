import { pino } from 'pino';
import type { Logger, SerializerFn } from 'pino';
import { createRequire } from 'node:module';

// ── Pretty-print detection ──────────────────────────────────────────────────
const isPrettyLog = process.env['LOG_FORMAT'] === 'pretty' || process.env['NODE_ENV'] === 'development';

// ── Lazy-loaded pretty stream ───────────────────────────────────────────────
// pino v9's transport.target resolver can't find pino-pretty inside
// pnpm deploy --prod containers, so we import it directly via createRequire
// and pass the stream to pino() — bypassing the broken transport resolution.
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
 * NODE_ENV=development) the output is human-readable; otherwise structured
 * JSON.
 */
export function createLogger(name: string): Logger {
  if (!isPrettyLog) {
    return pino({ name });
  }
  prettyStream ??= getPrettyStream();
  return pino({ name }, prettyStream);
}

/**
 * Create a pino logger suitable for passing to Fastify's `logger` option.
 * Includes HTTP request serializers and header redaction.
 * Returns a plain object that can be spread with additional options.
 */
export function createFastifyLogger(
  extra?: { serializers?: { [key: string]: SerializerFn } },
): Logger {
  const base = { name: 'herobids-api', redact: ['req.headers.authorization'] };
  if (!isPrettyLog) {
    return pino({ ...base, ...extra });
  }
  prettyStream ??= getPrettyStream();
  return pino({ ...base, ...extra }, prettyStream);
}
