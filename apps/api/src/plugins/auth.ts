import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as jose from 'jose';
import type { AuthConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { sessions, users } from '@herobids/db';
import { eq, and, isNull, gt } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userPlanId: string;
    isAdmin: boolean;
  }
}

/**
 * Auth plugin — verifies Bearer JWT on every request (except public routes).
 * Decorates request with userId on success.
 */

// The value below is the well-known default that ships in config/default.yaml.
// Using it outside a local-dev / test context means any attacker who has read
// this repo can forge valid JWTs.  Fail fast so this misconfiguration is loud.
const INSECURE_DEFAULT_JWT_SECRET = 'change-me-in-production-this-is-32-chars!!';

export async function authPlugin(app: FastifyInstance, opts: { config: AuthConfig; db: Database }) {
  const { config, db } = opts;

  if (
    config.jwtSecret === INSECURE_DEFAULT_JWT_SECRET &&
    process.env['NODE_ENV'] !== 'test' &&
    process.env['NODE_ENV'] !== 'development'
  ) {
    throw new Error(
      'auth.jwtSecret is the default placeholder — set AUTH_JWT_SECRET to a unique secret before running the server',
    );
  }

  const secret = new TextEncoder().encode(config.jwtSecret);

  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.decorateRequest('isAdmin', false);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for public routes
    if (isPublicRoute(request.url, request.method)) {
      return;
    }

    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    let payload: jose.JWTPayload;
    try {
      const result = await jose.jwtVerify(token, secret, { algorithms: ['HS256'] });
      payload = result.payload;
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    const sessionId = payload.jti;
    const userId = payload.sub;

    if (!sessionId || !userId) {
      return reply.status(401).send({ error: 'Invalid token claims' });
    }

    // Verify session is still active (not revoked, not expired)
    const [session] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!session) {
      return reply.status(401).send({ error: 'Session expired or revoked' });
    }

    // Look up the user's active plan and admin status (denormalised on users)
    const [user] = await db
      .select({ planId: users.planId, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return reply.status(401).send({ error: 'User not found' });
    }

    request.userId = userId;
    request.userPlanId = user.planId;
    request.isAdmin = user.isAdmin;
  });
}

/** Routes that do not require authentication */
function isPublicRoute(url: string, method: string): boolean {
  // Browser CORS preflights carry no credentials — skip auth entirely.
  // Actual CORS response headers are the responsibility of a CORS plugin; this
  // only ensures the 401 hook does not short-circuit the preflight response.
  if (method === 'OPTIONS') return true;

  const path = url.split('?')[0]!;

  // Health check
  if (path === '/health') return true;

  // OAuth initiation and callback — these must be public (no token yet)
  if (path === '/auth/google') return true;
  if (path === '/auth/google/callback') return true;
  // Exchange endpoint: browser POSTs a one-time code obtained from the OAuth redirect
  if (path === '/auth/exchange') return true;
  if (path === '/auth/register') return true;
  if (path === '/auth/login') return true;

  // /auth/me and /auth/logout require a valid session

  // Billing webhooks — signature-verified by providers, not by JWT
  if (path === '/billing/webhook') return true;
  if (path === '/billing/webhook/stripe') return true;
  if (path === '/billing/webhook/creem') return true;

  // Telegram webhook — verified by secret-token header inside the handler, not by JWT
  if (path === '/api/telegram/webhook') return true;

  // WebSocket event stream — browsers cannot send Authorization headers on WS upgrade
  // requests; the handler validates the JWT via ?token= query param internally.
  if (path === '/events') return true;

  return false;
}

/** Create a signed JWT for a user session */
export async function createSessionToken(
  config: AuthConfig,
  userId: string,
  sessionId: string,
): Promise<string> {
  const secret = new TextEncoder().encode(config.jwtSecret);

  return new jose.SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(sessionId)
    .setIssuedAt()
    .setExpirationTime(`${config.jwtTtlSecs}s`)
    .sign(secret);
}
