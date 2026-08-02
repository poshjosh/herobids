import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Registers a global error handler that sanitises internal details (SQL, stack
 * traces) from client responses. Every unhandled route error passes through
 * here, so raw Postgres FK violations, Drizzle query text, and stack traces
 * never leak to the client. Full error details are logged server-side with a
 * correlation ID.
 *
 * Error handling rules:
 * 1. Fastify validation errors (400) — pass through with safe message.
 * 2. Routes that already sent a reply — no-op (reply was already sent).
 * 3. Errors with explicit 4xx statusCode (Fastify-generated or app-thrown) —
 *    preserve the status code for correct HTTP semantics, but return a
 *    sanitised generic body (no echoed error.message, no stack traces).
 * 4. All other unhandled errors — return generic 500 with correlationId;
 *    log full error server-side.
 */
export function registerGlobalErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: Error & { validation?: unknown; statusCode?: number }, request: FastifyRequest, reply: FastifyReply) => {
      // 1. Fastify validation errors (400) are safe to pass through.
      if (error.validation) {
        return reply.status(400).send({
          error: 'validation_error',
          message: error.message,
        });
      }

      // 2. If the route already sent a reply, nothing more to do.
      if (reply.sent) {
        return;
      }

      // 3. Errors with explicit 4xx statusCode — preserve status, sanitise body.
      //    Covers Fastify-generated 4xx (malformed JSON, unsupported media type,
      //    payload too large, etc.) and app-thrown 4xx. Status is kept for
      //    correct HTTP semantics; the message is never echoed to the client.
      if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
        const correlationId = crypto.randomUUID();
        request.log.error({ err: error, correlationId }, 'Unhandled client error');
        return reply.status(error.statusCode).send({
          error: 'client_error',
          statusCode: error.statusCode,
          correlationId,
        });
      }

      // 4. All other unhandled errors: log full details, return sanitised 500.
      const correlationId = crypto.randomUUID();
      request.log.error({ err: error, correlationId }, 'Unhandled request error');

      return reply.status(500).send({
        error: 'internal_error',
        correlationId,
      });
    },
  );
}
