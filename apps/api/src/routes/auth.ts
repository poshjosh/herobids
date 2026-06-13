import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { AuthConfig, PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { users, oauthIdentities, localIdentities, sessions, userPlans } from '@herobids/db';
import { eq, and } from 'drizzle-orm';
import { createSessionToken } from '../plugins/auth.js';
import { errorPayload } from '../error-payload.js';
import { resolvePlanEntitlements } from '../plan-guards.js';

const scrypt = promisify<crypto.BinaryLike, crypto.BinaryLike, number, Buffer>(crypto.scrypt);
// Supported locales mirror apps/web/src/app/i18n/resolveLocale.ts — keep in sync.
const SUPPORTED_LOCALES = new Set(['en', 'ar', 'hi']);

type SupportedLocale = 'en' | 'ar' | 'hi';

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALES.has(value);
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const colonIdx = stored.indexOf(':');
  if (colonIdx < 0) return false;
  const salt = stored.slice(0, colonIdx);
  const storedHash = stored.slice(colonIdx + 1);
  const derived = await scrypt(password, salt, 64);
  const storedBuf = Buffer.from(storedHash, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

// ---------------------------------------------------------------------------
// CSRF helpers — stateless HMAC-signed state token stored in a httpOnly cookie
// ---------------------------------------------------------------------------

function generateOAuthState(secret: string): string {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(nonce).digest('base64url');
  return `${nonce}.${sig}`;
}

function verifyOAuthState(state: string, cookieState: string, secret: string): boolean {
  if (!state || !cookieState || state !== cookieState) return false;
  const dotIdx = state.lastIndexOf('.');
  if (dotIdx < 0) return false;
  const nonce = state.slice(0, dotIdx);
  const sig = state.slice(dotIdx + 1);
  const expected = crypto.createHmac('sha256', secret).update(nonce).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx).trim()] = decodeURIComponent(pair.slice(eqIdx + 1).trim());
    }
  }
  return result;
}

interface GoogleTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name: string;
  picture?: string;
}

export async function authRoutes(
  app: FastifyInstance,
  config: AuthConfig,
  db: Database,
  redis: Redis,
  defaultPlanId = 'free',
  plansConfig?: PlansConfig,
) {
  function profilePlanEntitlements(planId: string, isAdmin: boolean) {
    if (!plansConfig) {
      return null;
    }
    return resolvePlanEntitlements(plansConfig, { planId, isAdmin }).entitlements;
  }

  /**
   * POST /auth/register — Create a new local (email + password) account.
   * Returns a JWT directly (no exchange code needed — direct POST, not a redirect).
   */
  app.post('/auth/register', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = typeof body?.['email'] === 'string' ? body['email'].toLowerCase().trim() : undefined;
    const password = typeof body?.['password'] === 'string' ? body['password'] : undefined;
    const displayName = typeof body?.['displayName'] === 'string' ? body['displayName'].trim() : undefined;

    if (!email || !password || !displayName) {
      return reply.status(400).send(
        errorPayload('auth.register.required_fields', 'Email, password, and display name are required'),
      );
    }
    if (password.length < 8) {
      return reply.status(400).send(
        errorPayload('auth.register.password_too_short', 'Password must be at least 8 characters', { minLength: 8 }),
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.status(400).send(errorPayload('auth.register.invalid_email', 'Enter a valid email address'));
    }

    // Check for existing account
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      return reply.status(409).send(
        errorPayload('auth.register.email_taken', 'An account with this email already exists'),
      );
    }

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        displayName,
        email,
        avatarUrl: null,
        planId: defaultPlanId,
        preferredLocale: null,
        telegramChatId: null,
        aiModelConfig: null,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(localIdentities).values({
        id: crypto.randomUUID(),
        userId,
        passwordHash,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(userPlans).values({
        id: crypto.randomUUID(),
        userId,
        planId: defaultPlanId,
      });
    });

    const token = await issueSession(config, db, userId);
    return reply.status(201).send({ token });
  });

  /**
   * POST /auth/login — Authenticate with email + password.
   * Returns a JWT directly.
   */
  app.post('/auth/login', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = typeof body?.['email'] === 'string' ? body['email'].toLowerCase().trim() : undefined;
    const password = typeof body?.['password'] === 'string' ? body['password'] : undefined;

    if (!email || !password) {
      return reply.status(400).send(
        errorPayload('auth.login.required_fields', 'Email and password are required'),
      );
    }

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      // Constant-time response to avoid user enumeration
      await hashPassword('dummy-constant-time-work');
      return reply.status(401).send(
        errorPayload('auth.login.invalid_credentials', 'Invalid email or password'),
      );
    }

    const [identity] = await db.select().from(localIdentities).where(eq(localIdentities.userId, user.id)).limit(1);
    if (!identity) {
      await hashPassword('dummy-constant-time-work');
      return reply.status(401).send(
        errorPayload('auth.login.invalid_credentials', 'Invalid email or password'),
      );
    }

    const valid = await verifyPassword(password, identity.passwordHash);
    if (!valid) {
      return reply.status(401).send(
        errorPayload('auth.login.invalid_credentials', 'Invalid email or password'),
      );
    }

    const token = await issueSession(config, db, user.id);
    return reply.send({ token });
  });

  /**
   * GET /auth/google — Redirects to Google OAuth consent screen.
   */
  app.get('/auth/google', async (_request, reply) => {
    const redirectUri = `${config.publicBaseUrl}/auth/google/callback`;
    const state = generateOAuthState(config.jwtSecret);
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    // Store state in httpOnly cookie so the callback can verify it (CSRF protection)
    const securePart = config.secureCookie ? '; Secure' : '';
    reply.header('Set-Cookie', `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/google/callback; Max-Age=600${securePart}`);
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  /**
   * GET /auth/google/callback — Exchanges code for tokens, creates/finds user, issues JWT.
   */
  app.get('/auth/google/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    // Validate CSRF state — must match the cookie set during /auth/google
    const cookies = parseCookies(request.headers['cookie']);
    if (!state || !verifyOAuthState(state, cookies['oauth_state'] ?? '', config.jwtSecret)) {
      return reply.status(400).send(
        errorPayload('auth.google.invalid_state', 'Invalid or missing OAuth state parameter'),
      );
    }

    if (!code) {
      return reply.status(400).send(errorPayload('auth.google.missing_code', 'Missing authorization code'));
    }

    // Exchange code for tokens
    const redirectUri = `${config.publicBaseUrl}/auth/google/callback`;
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
    } catch (fetchErr) {
      app.log.error({ err: fetchErr }, 'Google OAuth token exchange network error');
      return reply.status(502).send(
        errorPayload('auth.google.token_exchange_failed', 'OAuth token exchange failed'),
      );
    }

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      app.log.error({ status: tokenResponse.status, body: errBody }, 'Google token exchange failed');
      return reply.status(502).send(
        errorPayload('auth.google.token_exchange_failed', 'OAuth token exchange failed'),
      );
    }

    const tokens = await tokenResponse.json() as GoogleTokenResponse;

    // Fetch user info
    let userInfoResponse: Response;
    try {
      userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
    } catch (fetchErr) {
      app.log.error({ err: fetchErr }, 'Google OAuth userinfo network error');
      return reply.status(502).send(
        errorPayload('auth.google.userinfo_failed', 'Failed to fetch user info from Google'),
      );
    }

    if (!userInfoResponse.ok) {
      return reply.status(502).send(
        errorPayload('auth.google.userinfo_failed', 'Failed to fetch user info from Google'),
      );
    }

    const googleUser = await userInfoResponse.json() as GoogleUserInfo;

    // Reject unverified email addresses — Google can return unverified emails for some account
    // types. An unverified email flowing into the email-based user lookup creates an
    // account-takeover path for any existing local user with that address.
    if (googleUser.email_verified !== true) {
      app.log.warn({ sub: googleUser.sub }, 'OAuth login rejected: email not verified by Google');
      return reply.status(401).send(
        errorPayload('auth.google.email_not_verified', 'Email address not verified by Google'),
      );
    }

    // Find or create user
    const userId = await findOrCreateUser(db, googleUser, defaultPlanId);

    // Issue JWT and store behind a short-lived one-time exchange code so the
    // browser redirect never carries the token in a URL fragment or history entry.
    const token = await issueSession(config, db, userId);
    const exchangeCode = crypto.randomUUID();
    await redis.set(`auth:code:${exchangeCode}`, token, 'EX', config.exchangeCodeTtlSecs);

    const callbackUrl = new URL('/auth/callback', config.frontendOrigin);
    callbackUrl.searchParams.set('code', exchangeCode);
    return reply.redirect(callbackUrl.toString());
  });

  /**
   * POST /auth/exchange — Exchanges a short-lived one-time code for a JWT.
   * The code is issued by the OAuth callback redirect and valid for exchangeCodeTtlSecs.
   * It is deleted on use (one-time).
   */
  app.post('/auth/exchange', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const code = typeof body?.['code'] === 'string' ? body['code'] : undefined;
    if (!code) {
      return reply.status(400).send(errorPayload('auth.exchange.missing_code', 'Missing exchange code'));
    }
    // Atomic get-and-delete — one-time use
    const token = await redis.getdel(`auth:code:${code}`);
    if (!token) {
      return reply.status(400).send(
        errorPayload('auth.exchange.invalid_code', 'Invalid or expired exchange code'),
      );
    }
    return reply.send({ token });
  });

  /**
   * GET /auth/me — Returns the authenticated user's profile.
   */
  app.get('/auth/me', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.status(401).send(errorPayload('auth.unauthenticated', 'Not authenticated'));
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return reply.status(404).send(errorPayload('auth.user_not_found', 'User not found'));
    }

    return reply.send({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      planId: user.planId,
      isAdmin: user.isAdmin,
      planEntitlements: profilePlanEntitlements(user.planId, user.isAdmin),
      preferredLocale: user.preferredLocale ?? null,
      telegramChatId: user.telegramChatId ?? null,
      createdAt: user.createdAt.toISOString(),
    });
  });

  /**
   * PATCH /auth/me — Update mutable user profile fields.
   * Currently supports: preferredLocale and telegramChatId.
   */
  app.patch('/auth/me', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.status(401).send(errorPayload('auth.unauthenticated', 'Not authenticated'));
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const updates: { preferredLocale?: SupportedLocale | null; telegramChatId?: string | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };

    if ('preferredLocale' in body) {
      const val = body['preferredLocale'];
      if (val !== null && !isSupportedLocale(val)) {
        return reply.status(400).send(
          errorPayload(
            'auth.profile.invalid_preferred_locale',
            'preferredLocale must be one of: en, ar, hi, or null',
            { supportedLocales: 'en, ar, hi' },
          ),
        );
      }
      updates.preferredLocale = (val as SupportedLocale | null) ?? null;
    }

    if ('telegramChatId' in body) {
      const val = body['telegramChatId'];
      if (val !== null && typeof val !== 'string') {
        return reply.status(400).send(
          errorPayload('auth.profile.invalid_telegram_chat_id', 'telegramChatId must be a string or null'),
        );
      }
      updates.telegramChatId = (val as string | null) ?? null;
    }

    await db.update(users).set(updates).where(eq(users.id, userId));

    const [updated] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!updated) return reply.status(404).send(errorPayload('auth.user_not_found', 'User not found'));

    return reply.send({
      id: updated.id,
      displayName: updated.displayName,
      email: updated.email,
      avatarUrl: updated.avatarUrl,
      planId: updated.planId,
      planEntitlements: profilePlanEntitlements(updated.planId, updated.isAdmin),
      preferredLocale: updated.preferredLocale ?? null,
      telegramChatId: updated.telegramChatId ?? null,
      createdAt: updated.createdAt.toISOString(),
    });
  });

  /**
   * POST /auth/logout — Revokes the current session.
   */
  app.post('/auth/logout', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.status(401).send(errorPayload('auth.unauthenticated', 'Not authenticated'));
    }

    // Extract session ID from token
    const authHeader = request.headers['authorization'];
    if (!authHeader) {
      return reply.status(401).send(
        errorPayload('auth.logout.missing_authorization', 'Missing authorization'),
      );
    }

    // Parse JWT to get jti (session ID) — verification already done by plugin
    const token = authHeader.slice(7);
    const parts = token.split('.');
    if (parts.length !== 3) {
      return reply.status(400).send(errorPayload('auth.logout.malformed_token', 'Malformed token'));
    }
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { jti?: string };
    if (!payload.jti) {
      return reply.status(400).send(
        errorPayload('auth.logout.missing_session_id', 'Token missing session ID'),
      );
    }

    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, payload.jti), eq(sessions.userId, userId)));

    return reply.send({ ok: true });
  });
}

/** Find existing user by OAuth identity or create a new one.
 *
 * Runs inside a transaction. Uses upsert-style inserts so concurrent logins
 * for the same Google account never produce duplicate rows.
 */
async function findOrCreateUser(db: Database, googleUser: GoogleUserInfo, defaultPlanId: string): Promise<string> {
  return db.transaction(async (tx) => {
    // Fast path: identity already exists
    const [existing] = await tx
      .select({ userId: oauthIdentities.userId })
      .from(oauthIdentities)
      .where(
        and(
          eq(oauthIdentities.provider, 'google'),
          eq(oauthIdentities.providerUserId, googleUser.sub),
        ),
      )
      .limit(1);

    if (existing) {
      return existing.userId;
    }

    // Try to create the user — silently ignore email conflicts (concurrent first-login)
    const newUserId = crypto.randomUUID();
    const now = new Date();
    await tx.insert(users).values({
      id: newUserId,
      displayName: googleUser.name,
      email: googleUser.email,
      avatarUrl: googleUser.picture ?? null,
      planId: defaultPlanId,
      preferredLocale: null,
      telegramChatId: null,
      aiModelConfig: null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();

    // Get the definitive user ID (ours or the pre-existing one linked to this email)
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, googleUser.email))
      .limit(1);

    if (!user) throw new Error('Failed to resolve user for OAuth login');

    // Seed the canonical plan history row for newly-created users.
    // Existing users already have a user_plans row from their own first-login;
    // concurrent first-logins that lost the user-insert race also skip this because
    // user.id !== newUserId (we detect that we didn't create the row).
    if (user.id === newUserId) {
      await tx.insert(userPlans).values({
        id: crypto.randomUUID(),
        userId: user.id,
        planId: defaultPlanId,
      });
    }

    // Link identity — ignore if a concurrent request already linked it
    await tx.insert(oauthIdentities).values({
      id: crypto.randomUUID(),
      userId: user.id,
      provider: 'google',
      providerUserId: googleUser.sub,
      email: googleUser.email,
      createdAt: now,
    }).onConflictDoNothing();

    // Re-read identity to get the definitive userId (may differ from user.id if lost the race)
    const [identity] = await tx
      .select({ userId: oauthIdentities.userId })
      .from(oauthIdentities)
      .where(
        and(
          eq(oauthIdentities.provider, 'google'),
          eq(oauthIdentities.providerUserId, googleUser.sub),
        ),
      )
      .limit(1);

    if (!identity) throw new Error('Failed to establish OAuth identity');
    return identity.userId;
  });
}

/** Create a new session and return a signed JWT. Shared by OAuth and local auth flows. */
async function issueSession(config: AuthConfig, db: Database, userId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.jwtTtlSecs * 1000);
  await db.insert(sessions).values({ id: sessionId, userId, expiresAt, createdAt: new Date() });
  return createSessionToken(config, userId, sessionId);
}
