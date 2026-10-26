import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as jose from 'jose';
import type { AuthConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { sessions, users, agents, agentRuntimeSessions, hashAgentApiKey, isAgentApiKey } from '@herobids/db';
import { eq, and, isNull, gt, inArray, notInArray } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userPlanId: string;
    isAdmin: boolean;
    /** Set when the request was authenticated with an agent API key; null for user JWTs. */
    actingAgentId: string | null;
  }
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Opts a route in to agent-key callers. Routes without it refuse agent keys (default-deny).
     * 'self' means the route may be called by an agent key only for its own agent (see requireSelfAgentOrUser).
     * 'child-create' means an agent key may create a child agent; the route derives the lineage from the key.
     * 'creator' means an agent key may act on its direct children only (see requireDirectChildOfActingAgent).
     */
    agentAccess?: AgentAccessLevel;
  }
}

export type AgentAccessLevel = 'self' | 'child-create' | 'creator';

/** Runtime statuses whose API keys are revoked. */
const INACTIVE_RUNTIME_STATUSES = ['stopped', 'crashed'];

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
  app.decorateRequest('actingAgentId', null);

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

    // Agent keys are opaque and never parsed as JWTs.
    if (isAgentApiKey(token)) {
      const agentCaller = await resolveAgentApiKeyCaller(db, token);
      if (!agentCaller) {
        return reply.status(401).send({ error: 'Invalid or expired agent key' });
      }
      request.userId = agentCaller.userId;
      request.userPlanId = agentCaller.planId;
      request.isAdmin = false; // agent keys never carry admin rights
      request.actingAgentId = agentCaller.agentId;
      if (!getRouteAgentAccess(request)) {
        return reply.status(403).send({ error: 'Agent keys cannot access this route' });
      }
      return;
    }

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

/**
 * Resolve an agent API key to the agent and its owner. Returns null when the key is unknown,
 * its runtime session is stopped or crashed, the agent is paused, or the owner user row is missing
 * (the inner join to users enforces the last one).
 */
async function resolveAgentApiKeyCaller(db: Database, rawKey: string) {
  const [caller] = await db
    .select({
      agentId: agents.id,
      userId: agents.userId,
      planId: users.planId,
      isAdmin: users.isAdmin,
    })
    .from(agentRuntimeSessions)
    .innerJoin(agents, eq(agents.id, agentRuntimeSessions.agentId))
    .innerJoin(users, eq(users.id, agents.userId))
    .where(and(
      eq(agentRuntimeSessions.apiKeyHash, hashAgentApiKey(rawKey)),
      notInArray(agentRuntimeSessions.status, INACTIVE_RUNTIME_STATUSES),
      inArray(agents.status, AGENT_KEY_ALLOWED_AGENT_STATUSES),
    ))
    .limit(1);
  return caller ?? null;
}

/** Agent statuses in which the agent's own key may be used. Stopped, crashed and paused agents are refused. */
const AGENT_KEY_ALLOWED_AGENT_STATUSES = ['starting', 'active'] as const;

/** The agent access level a route declared in its config, or undefined when agent keys are refused. */
export function getRouteAgentAccess(request: FastifyRequest): AgentAccessLevel | undefined {
  return request.routeOptions.config.agentAccess;
}

/** Route preHandler: rejects agent-key callers. Attach to routes only a user may call. */
export async function requireUserCaller(request: FastifyRequest, reply: FastifyReply) {
  if (request.actingAgentId) {
    return reply.status(403).send({ error: 'This action requires a user session' });
  }
}

/**
 * Route preHandler for routes opened to agent keys with agentAccess 'self': an agent key may only
 * address its own agent (params.id must equal the acting agent). User callers pass through.
 */
export async function requireSelfAgentOrUser(request: FastifyRequest, reply: FastifyReply) {
  if (!request.actingAgentId) return;
  const params = request.params as { id?: unknown } | undefined;
  if (params?.id !== request.actingAgentId) {
    return reply.status(403).send({ error: 'Agent keys may only act on their own agent' });
  }
}

/** Route preHandler: rejects user callers. Attach to routes only an agent key may call. */
export async function requireAgentKeyCaller(request: FastifyRequest, reply: FastifyReply) {
  if (!request.actingAgentId) {
    return reply.status(403).send({ error: 'This action requires an agent key' });
  }
}

/**
 * Route preHandler for routes opened to agent keys with agentAccess 'creator': an agent key may only
 * address an agent whose parent is the acting agent. Any other target, including a grandchild or an
 * unrelated agent, gets 403. User callers pass through. `paramName` names the route param that
 * holds the child's id (default `id`).
 */
export function requireDirectChildOfActingAgent(db: Database, paramName = 'id') {
  return async function requireDirectChild(request: FastifyRequest, reply: FastifyReply) {
    const actingAgentId = request.actingAgentId;
    if (!actingAgentId) return;
    const params = request.params as Record<string, unknown> | undefined;
    const childId = params?.[paramName];
    if (typeof childId !== 'string') {
      return reply.status(403).send({ error: 'Agent keys may only act on their direct children' });
    }
    const [target] = await db
      .select({ parentAgentId: agents.parentAgentId })
      .from(agents)
      .where(eq(agents.id, childId))
      .limit(1);
    if (target?.parentAgentId !== actingAgentId) {
      return reply.status(403).send({ error: 'Agent keys may only act on their direct children' });
    }
  };
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
  // Login-link (magic link) endpoints — public
  if (path === '/auth/send-login-link') return true;
  if (path === '/auth/login-link/callback') return true;

  // Setup-link (connection form auto-login) — public
  if (path === '/auth/setup-link/callback') return true;

  // Connection-request link — public; the route checks its own single-use bearer token
  if (path === '/auth/connection-request/callback') return true;

  // Gmail OAuth callback — Google redirects here without JWT
  if (path === '/connections/oauth/gmail/callback') return true;

  // /auth/me and /auth/logout require a valid session

  // Billing webhooks — signature-verified by providers, not by JWT
  if (path === '/billing/webhook') return true;
  if (path === '/billing/webhook/stripe') return true;
  if (path === '/billing/webhook/creem') return true;

  // Telegram webhook — verified by secret-token header inside the handler, not by JWT
  if (path === '/telegram/webhook') return true;
  // Neutral chat webhook (POST and GET verify) — provider adapter verifies, not JWT
  if (/^\/messaging\/chat\/[a-z0-9-]+\/webhook$/.test(path)) return true;

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
