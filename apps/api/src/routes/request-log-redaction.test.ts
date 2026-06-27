import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'node:stream';

/**
 * Build a logger config matching the production setup in index.ts:
 * - standard request serializer with token redaction
 * - Authorization header redacted via Pino redact
 * - output captured to an in-memory writable stream
 */
function makeRedactingLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  function redactQueryToken(query: unknown): unknown {
    if (query == null || typeof query !== 'object') return query;
    const q = query as Record<string, unknown>;
    if (!('token' in q)) return query;
    const redacted = { ...q };
    redacted['token'] = '[redacted]';
    return redacted;
  }

  function redactReqSerializer(req: Record<string, unknown>) {
    const connection: Record<string, unknown> | undefined =
      (req['socket'] as Record<string, unknown> | undefined) ??
      (req['info'] as Record<string, unknown> | undefined);
    return {
      id: typeof req['id'] === 'function' ? (req['id'] as () => string)() : (req['id'] ?? req['raw']?.['id']),
      method: req['method'],
      url:
        typeof req['url'] === 'string'
          ? (req['url'] as string)
              .replace(/([?&])token=[^&]*/g, '$1token=[redacted]')
              .replace(/[?&]$/, '')
          : req['url'],
      query: redactQueryToken(req['query']),
      params: req['params'],
      headers: req['headers'],
      remoteAddress: req['ip'] ?? connection?.['remoteAddress'] ?? '',
      remotePort: connection?.['remotePort'] ?? '',
    };
  }

  const config = {
    level: 'info' as const,
    stream,
    redact: ['req.headers.authorization'] as string[],
    serializers: { req: redactReqSerializer },
  };

  return { config, chunks };
}

describe('request log redaction', () => {
  it('redacts ?token= from logged URL', async () => {
    const { config, chunks } = makeRedactingLogger();
    const app = Fastify({ logger: config });

    // Register a dummy route so the request isn't a 404
    app.get('/events', async (_req, reply) => {
      return reply.status(200).send('ok');
    });
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/events?token=secret.jwt.here&other=keep',
      headers: { host: 'localhost' },
    });

    await app.close();

    const logText = chunks.join('');
    // Must not leak the raw token anywhere (URL, query object, etc.)
    expect(logText).not.toContain('secret.jwt.here');
    // Must contain the redacted marker in the URL
    expect(logText).toContain('token=[redacted]');
    // Non-sensitive query params must survive in the URL
    expect(logText).toContain('other=keep');
    // URL structure must be intact (no mangled ?& artifacts)
    expect(logText).toMatch(/\?token=\[redacted\]&other=keep/);
  });

  it('redacts a lone ?token= query param without leaving trailing ? or &', async () => {
    const { config, chunks } = makeRedactingLogger();
    const app = Fastify({ logger: config });

    app.get('/events', async (_req, reply) => {
      return reply.status(200).send('ok');
    });
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/events?token=another.secret',
      headers: { host: 'localhost' },
    });

    await app.close();

    const logText = chunks.join('');
    expect(logText).not.toContain('another.secret');
    expect(logText).toContain('token=[redacted]');
    // The URL path should not end with a bare ? or &
    expect(logText).toMatch(/"url":\s*"\/events\?token=\[redacted\]"/);
  });

  it('redacts Authorization header via Pino redact', async () => {
    const { config, chunks } = makeRedactingLogger();
    const app = Fastify({ logger: config });

    app.get('/protected', async (_req, reply) => {
      return reply.status(200).send('ok');
    });
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        host: 'localhost',
        authorization: 'Bearer super-secret-jwt',
      },
    });

    await app.close();

    const logText = chunks.join('');
    // Raw token must not appear
    expect(logText).not.toContain('super-secret-jwt');
    // Pino redact replaces the value with "[Redacted]"
    expect(logText).toContain('[Redacted]');
  });

  it('preserves standard request fields in log output', async () => {
    const { config, chunks } = makeRedactingLogger();
    const app = Fastify({ logger: config });

    app.get('/test', async (_req, reply) => {
      return reply.status(200).send('ok');
    });
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/test?foo=bar',
      headers: { host: 'api.example.com' },
    });

    await app.close();

    const logText = chunks.join('');
    // Standard fields that must be present
    expect(logText).toContain('"method"');
    expect(logText).toContain('"url"');
    expect(logText).toContain('"remoteAddress"');
    expect(logText).toContain('"headers"');
    expect(logText).toContain('"id"');
    // Must contain the actual values
    expect(logText).toContain('"POST"');
    expect(logText).toContain('"api.example.com"');
  });

  it('does not redact non-sensitive URL query params', async () => {
    const { config, chunks } = makeRedactingLogger();
    const app = Fastify({ logger: config });

    app.get('/search', async (_req, reply) => {
      return reply.status(200).send('ok');
    });
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/search?q=hello&page=2&sort=desc',
      headers: { host: 'localhost' },
    });

    await app.close();

    const logText = chunks.join('');
    expect(logText).toContain('q=hello');
    expect(logText).toContain('page=2');
    expect(logText).toContain('sort=desc');
    expect(logText).not.toContain('[redacted]');
  });
});
