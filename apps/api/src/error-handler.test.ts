import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerGlobalErrorHandler } from './error-handler.js';

/**
 * Tests for the global error handler (apps/api/src/error-handler.ts).
 *
 * The error handler must:
 * 1. Pass through Fastify validation errors (400) with safe message
 * 2. Pass through routes that already sent a reply (reply.sent check)
 * 3. Preserve 4xx status codes for Fastify-generated and app-thrown errors,
 *    but return a sanitised generic body (no echoed error.message)
 * 4. Sanitise 5xx/unhandled errors — return generic 500 with correlationId,
 *    strip internal details (SQL, stack traces, file paths)
 *
 * Bug 002 (2026-08-02): Raw Postgres FK violation error messages (including
 * SQL query text and parameter values) were exposed to the client because no
 * error handler was registered. Fastify's default serialisation dumped the
 * full Error.message into the 500 response body.
 *
 * Note: We deliberately do NOT echo thrown error messages even for 4xx
 * statusCode, because dependencies may throw errors whose .message
 * contains internal details (SQL, file paths, etc.). Status codes are
 * preserved for correct HTTP semantics; the body is always sanitised.
 */

function buildApp() {
  const app = Fastify({ logger: false });
  registerGlobalErrorHandler(app);
  return app;
}

describe('global error handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validation errors (400)', () => {
    it('passes through Fastify validation errors with safe message', async () => {
      const app = buildApp();
      // Fastify schema validation triggers error.validation
      app.post('/test', {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      }, async () => ({ ok: true }));

      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: { notName: 123 },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: string; message: string }>();
      expect(body.error).toBe('validation_error');
      expect(body.message).toBeDefined();
    });
  });

  describe('route-set 4xx errors (reply.sent path)', () => {
    it('passes through route-set 404 status — reply already sent before throw', async () => {
      const app = buildApp();
      app.get('/test-404', async (_request, reply) => {
        return reply.status(404).send({ error: 'not_found', custom: true });
      });

      const res = await app.inject({ method: 'GET', url: '/test-404' });

      expect(res.statusCode).toBe(404);
      const body = res.json<{ error: string; custom: boolean }>();
      expect(body.error).toBe('not_found');
      expect(body.custom).toBe(true);
    });
  });

  describe('thrown error sanitisation', () => {
    it('sanitises thrown errors with explicit 4xx statusCode — status preserved, message not echoed', async () => {
      // Even if a dependency throws an error with statusCode=403 and an
      // internal-sensitive message, the handler must preserve the status
      // but NOT echo the message.
      const app = buildApp();
      app.get('/test-throw-4xx', async () => {
        const err = new Error(
          'Failed query: select * from "secrets" where "secrets"."id" = $1',
        ) as Error & { statusCode: number };
        err.statusCode = 403;
        throw err;
      });

      const res = await app.inject({ method: 'GET', url: '/test-throw-4xx' });

      // Status code preserved for correct HTTP semantics.
      expect(res.statusCode).toBe(403);
      const body = res.json<{ error: string; statusCode: number; correlationId: string }>();
      expect(body.error).toBe('client_error');
      expect(body.statusCode).toBe(403);
      expect(body.correlationId).toBeDefined();
      const responseText = JSON.stringify(body);
      expect(responseText).not.toContain('Failed query');
      expect(responseText).not.toContain('secrets');
      expect(responseText).not.toContain('select *');
    });

    it('sanitises Fastify-generated 4xx errors — malformed JSON returns 400 with sanitised body', async () => {
      // Fastify raises its own 4xx for malformed requests. The handler must
      // preserve the 400 status but not leak internal details.
      const app = buildApp();
      app.post('/test-malformed', {
        schema: {
          body: { type: 'object', properties: { x: { type: 'number' } } },
        },
      }, async (request) => ({ received: request.body }));

      const res = await app.inject({
        method: 'POST',
        url: '/test-malformed',
        headers: { 'content-type': 'application/json' },
        payload: '{not valid json',
      });

      // Fastify returns 400 for malformed JSON — status must be preserved.
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: string; statusCode: number; correlationId: string; message?: string }>();
      // Must be sanitised: no raw parser error details.
      expect(body.error).toBe('client_error');
      expect(body.statusCode).toBe(400);
      expect(body.correlationId).toBeDefined();
      expect(body.message).toBeUndefined();
    });
    it('sanitises generic errors — returns correlationId, no internal details', async () => {
      const app = buildApp();
      app.get('/test-500', async () => {
        throw new Error('Internal database connection pool exhausted');
      });

      const res = await app.inject({ method: 'GET', url: '/test-500' });

      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: string; correlationId: string }>();
      expect(body.error).toBe('internal_error');
      expect(body.correlationId).toBeDefined();
      expect(typeof body.correlationId).toBe('string');
      expect(body.correlationId!.length).toBeGreaterThan(0);
      // Must NOT leak the original error message
      expect(JSON.stringify(body)).not.toContain('database connection pool exhausted');
      expect(JSON.stringify(body)).not.toContain('Internal');
    });

    it('sanitises Postgres FK violation errors — no raw SQL exposed', async () => {
      const app = buildApp();
      app.get('/test-fk', async () => {
        const fkErr = new Error(
          'update or delete on table "agents" violates foreign key constraint ' +
          '"market_assessment_requests_agent_id_agents_id_fk" on table "market_assessment_requests"',
        );
        throw fkErr;
      });

      const res = await app.inject({ method: 'GET', url: '/test-fk' });

      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: string; correlationId: string }>();
      expect(body.error).toBe('internal_error');
      expect(body.correlationId).toBeDefined();
      // Raw SQL / table names must NOT appear in the response
      const responseText = JSON.stringify(body);
      expect(responseText).not.toContain('violates foreign key constraint');
      expect(responseText).not.toContain('market_assessment_requests');
      expect(responseText).not.toContain('"agents"');
    });

    it('sanitises Drizzle query errors — no SQL query text exposed', async () => {
      const app = buildApp();
      app.get('/test-drizzle', async () => {
        const drizzleErr = new Error(
          'Failed query: delete from "agents" where "agents"."id" = $1\n' +
          'params: 89feb728-b43c-4c9a-a53e-aefaf923f4f1',
        );
        throw drizzleErr;
      });

      const res = await app.inject({ method: 'GET', url: '/test-drizzle' });

      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: string; correlationId: string }>();
      expect(body.error).toBe('internal_error');
      expect(body.correlationId).toBeDefined();
      // Raw SQL query text must NOT appear in the response
      const responseText = JSON.stringify(body);
      expect(responseText).not.toContain('Failed query');
      expect(responseText).not.toContain('delete from');
      expect(responseText).not.toContain('89feb728');
    });

    it('sanitises errors with stack traces — no stack frames exposed', async () => {
      const app = buildApp();
      app.get('/test-stack', async () => {
        const err = new Error('Something went wrong');
        err.stack = 'Error: Something went wrong\n    at Object.<anonymous> (/app/src/db.ts:42:15)';
        throw err;
      });

      const res = await app.inject({ method: 'GET', url: '/test-stack' });

      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: string; correlationId: string }>();
      expect(body.error).toBe('internal_error');
      expect(body.correlationId).toBeDefined();
      const responseText = JSON.stringify(body);
      expect(responseText).not.toContain('/app/src/db.ts');
      expect(responseText).not.toContain('at Object');
    });

    it('returns a unique correlationId per request', async () => {
      const app = buildApp();
      app.get('/test-unique', async () => {
        throw new Error('boom');
      });

      const res1 = await app.inject({ method: 'GET', url: '/test-unique' });
      const res2 = await app.inject({ method: 'GET', url: '/test-unique' });

      const id1 = res1.json<{ correlationId: string }>().correlationId;
      const id2 = res2.json<{ correlationId: string }>().correlationId;
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
    });
  });

  describe('edge cases', () => {
    it('handles errors with no message property gracefully', async () => {
      const app = buildApp();
      app.get('/test-no-message', async () => {
        // Simulate a non-Error throw (e.g. `throw "raw string"`)
        // eslint-disable-next-line no-throw-literal
        throw 'raw string error';
      });

      const res = await app.inject({ method: 'GET', url: '/test-no-message' });

      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: string; correlationId: string }>();
      expect(body.error).toBe('internal_error');
      expect(body.correlationId).toBeDefined();
      // Raw string must not appear in response
      expect(JSON.stringify(body)).not.toContain('raw string error');
    });

    it('handles undefined throws gracefully — Fastify wraps non-Error throws as generic 500', async () => {
      const app = buildApp();
      app.get('/test-undefined', async () => {
        // eslint-disable-next-line no-throw-literal
        throw undefined;
      });

      const res = await app.inject({ method: 'GET', url: '/test-undefined' });

      // Fastify v5 wraps non-Error throws before the error handler receives them.
      // The response is a safe, generic 500 — no internal details leak.
      expect(res.statusCode).toBe(500);
      const responseText = res.body;
      // Must not leak stack traces, file paths, or SQL
      expect(responseText).not.toContain('at Object');
      expect(responseText).not.toContain('.ts:');
      expect(responseText).not.toContain('delete from');
    });
  });
});
