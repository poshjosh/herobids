import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { AuthConfig, PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { users, oauthIdentities, localIdentities, sessions, userPlans } from '@herobids/db';
import { eq, and } from 'drizzle-orm';
import { createSessionToken } from '../plugins/auth.js';
import { errorPayload } from '../error-payload.js';
import { resolvePlanEntitlements } from '../plan-guards.js';
import { resolveNotificationPreferences } from './user-config-helpers.js';
import type { AuthMailer } from '../auth-mailer.js';
import {
  consumeSetupLinkToken as consumeSetupLinkTokenImpl,
  deleteSetupLinkToken as deleteSetupLinkTokenImpl,
} from '../services/setup-link-token-service.js';

const scrypt = promisify<crypto.BinaryLike, crypto.BinaryLike, number, Buffer>(crypto.scrypt);
// Supported locales mirror apps/web/src/app/i18n/resolveLocale.ts — keep in sync.
const SUPPORTED_LOCALES = new Set(['en', 'ar', 'hi']);

type SupportedLocale = 'en' | 'ar' | 'hi';

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALES.has(value);
}

const NotificationPreferencesInputSchema = z.object({
  sendMessage: z.object({
    email: z.object({ enabled: z.boolean() }).optional(),
  }).optional(),
});

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

// ── Username helpers ──────────────────────────────────────────────────────

const USERNAME_REGEX = /^[a-z0-9_]{3,30}$/;

function normalizeUsername(raw: string): string {
  return raw.toLowerCase().trim();
}

function validateUsername(raw: string): { valid: true } | { valid: false; reason: string } {
  const normalized = normalizeUsername(raw);
  if (normalized.length < 3) {
    return { valid: false, reason: 'Username must be at least 3 characters' };
  }
  if (normalized.length > 30) {
    return { valid: false, reason: 'Username must be at most 30 characters' };
  }
  if (!USERNAME_REGEX.test(normalized)) {
    return { valid: false, reason: 'Username can only contain lowercase letters, digits, and underscores' };
  }
  return { valid: true };
}

function humanizeDisplayName(username: string): string {
  return username
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function deriveBaseUsername(email: string): string {
  return email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function generateUniqueSuffix(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Returns true when a DB error is a unique-constraint violation on the username column.
 * Handles both inline UNIQUE naming (users_username_key) and named-constraint style
 * (users_username_unique) since the migration uses inline UNIQUE syntax.
 */
function isUsernameUniqueConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e['code'] !== '23505') return false;
  const constraint = (e['constraint_name'] ?? e['constraint']) as string | undefined;
  if (typeof constraint === 'string') {
    return constraint === 'users_username_key' || constraint === 'users_username_unique';
  }
  // Fallback: Postgres detail always contains the column name in "Key (col)=..." format
  return /\(username\)/.test((e['detail'] as string | undefined) ?? '');
}

export async function authRoutes(
  app: FastifyInstance,
  config: AuthConfig,
  db: Database,
  redis: Redis,
  defaultPlanId = 'free',
  plansConfig?: PlansConfig,
  authMailer?: AuthMailer,
) {
  function profilePlanEntitlements(planId: string, isAdmin: boolean) {
    if (!plansConfig) {
      return null;
    }
    return resolvePlanEntitlements(plansConfig, { planId, isAdmin }).entitlements;
  }

  // ── Login-link helpers ──────────────────────────────────────────────────

  function normalizeEmail(raw: string): string {
    return raw.toLowerCase().trim();
  }



  function hashKey(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  function makeLoginLinkUrl(token: string): string {
    const url = new URL('/auth/login-link/callback', config.publicBaseUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }

  /**
   * Sanitize a frontend-relative `next` path for redirect-after-auth flows.
   * Same-origin only; rejects protocol-relative (`//`) and absolute URLs.
   * Falls back to `/agents` when the input is absent, invalid, or cross-origin.
   */
  function sanitizeNextParam(value: string | undefined): string {
    if (!value || !value.startsWith('/') || value.startsWith('//')) {
      return '/agents';
    }
    try {
      const url = new URL(value, config.frontendOrigin);
      if (url.origin !== config.frontendOrigin) {
        return '/agents';
      }
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return '/agents';
    }
  }

  async function createAndStoreLoginLinkToken(email: string, username?: string, next?: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    const payload: { email: string; username?: string; next?: string } = { email };
    if (username) {
      payload.username = username;
    }
    if (next) {
      payload.next = next;
    }
    await redis.set(`auth:login-link:token:${token}`, JSON.stringify(payload), 'EX', config.loginLinkTtlSecs);
    return token;
  }

  async function consumeLoginLinkToken(token: string): Promise<{ email: string; username?: string; next?: string } | null> {
    const raw = await redis.getdel(`auth:login-link:token:${token}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { email: string; username?: string };
    } catch {
      return null;
    }
  }

  async function reserveUsername(username: string, token: string): Promise<boolean> {
    const key = `auth:login-link:username-reservation:${username}`;
    const result = await redis.set(key, token, 'EX', config.loginLinkTtlSecs, 'NX');
    return result === 'OK';
  }

  async function checkLoginLinkRateLimit(email: string, ip: string): Promise<{ allowed: boolean; reason?: string; cooldownRemainingSecs?: number }> {
    const emailHash = hashKey(email);

    // Check resend cooldown — prevent sending before the cooldown expires
    const cooldownKey = `auth:login-link:cooldown:${emailHash}`;
    const cooldownTtl = await redis.ttl(cooldownKey);
    if (cooldownTtl > 0) {
      return { allowed: false, reason: 'Please wait before requesting another login link.', cooldownRemainingSecs: cooldownTtl };
    }

    const emailWindowKey = `auth:login-link:email-window:${emailHash}`;
    const ipWindowKey = `auth:login-link:ip-window:${ip}`;
    const windowSecs = config.loginLinkWindowSecs;

    // Check email rate limit
    const emailCount = await redis.incr(emailWindowKey);
    if (emailCount === 1) {
      await redis.expire(emailWindowKey, windowSecs);
    }
    if (emailCount > config.loginLinkMaxSendsPerWindow) {
      return { allowed: false, reason: 'Too many login link requests for this email. Please try again later.' };
    }

    // Check IP rate limit
    const ipCount = await redis.incr(ipWindowKey);
    if (ipCount === 1) {
      await redis.expire(ipWindowKey, windowSecs);
    }
    if (ipCount > config.loginLinkMaxSendsPerIpWindow) {
      return { allowed: false, reason: 'Too many login link requests from this device. Please try again later.' };
    }

    return { allowed: true };
  }

  async function resolveOrCreateUserByEmail(email: string, username?: string): Promise<string> {
    // Try existing user first
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) return existing.id;

    const userId = crypto.randomUUID();
    const now = new Date();

    if (username) {
      // Explicit username provided — reservation guarantees availability; insert directly.
      const displayName = humanizeDisplayName(username);
      await db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: userId,
          username,
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
        await tx.insert(userPlans).values({
          id: crypto.randomUUID(),
          userId,
          planId: defaultPlanId,
        });
      });
      return userId;
    }

    // Auto-generate: try the derived base candidate, retry with fresh entropy on actual
    // unique-constraint conflicts — the pre-insert SELECT is not sufficient alone (TOCTOU).
    const base = deriveBaseUsername(email);
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const stem = attempt === 0 ? base : `${base.slice(0, 26)}_${generateUniqueSuffix()}`;
      const candidate = stem.length > 30 ? stem.slice(0, 30) : stem;
      const displayName = humanizeDisplayName(candidate);
      try {
        await db.transaction(async (tx) => {
          await tx.insert(users).values({
            id: userId,
            username: candidate,
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
          await tx.insert(userPlans).values({
            id: crypto.randomUUID(),
            userId,
            planId: defaultPlanId,
          });
        });
        return userId;
      } catch (err) {
        if (!isUsernameUniqueConflict(err)) throw err;
        // Username collision on insert — retry with fresh entropy
      }
    }
    throw new Error(`user creation failed: username conflict after ${MAX_RETRIES} attempts`);
  }

  /**
   * POST /auth/send-login-link — Send a one-time login link to the given email.
   * Validates email syntax, applies rate limiting, stores a short-lived token in Redis,
   * and sends the email. Returns a generic success response regardless of outcome.
   */
  app.post('/auth/send-login-link', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = typeof body?.['email'] === 'string' ? normalizeEmail(body['email']) : undefined;
    const rawUsername = typeof body?.['username'] === 'string' ? body['username'] : undefined;
    const rawNext = typeof body?.['next'] === 'string' ? body['next'] : undefined;
    const sanitizedNext = sanitizeNextParam(rawNext);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.status(400).send(
        errorPayload('auth.send_login_link.invalid_email', 'Enter a valid email address'),
      );
    }

    // Validate username if provided
    let normalizedUsername: string | undefined;
    if (rawUsername && rawUsername.trim().length > 0) {
      const validation = validateUsername(rawUsername);
      if (!validation.valid) {
        return reply.status(400).send(
          errorPayload('auth.send_login_link.invalid_username', validation.reason),
        );
      }
      normalizedUsername = normalizeUsername(rawUsername);

      // Check availability against existing users
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, normalizedUsername))
        .limit(1);
      if (existing) {
        return reply.status(409).send(
          errorPayload('auth.send_login_link.username_taken', 'This username is already taken.'),
        );
      }
    }

    // Apply rate limiting
    const ip = request.ip;
    const rateCheck = await checkLoginLinkRateLimit(email, ip);
    if (!rateCheck.allowed) {
      return reply.status(429).send(
        errorPayload('auth.send_login_link.rate_limited', rateCheck.reason ?? 'Too many requests'),
      );
    }

    // Create token with optional username and next path
    const token = await createAndStoreLoginLinkToken(email, normalizedUsername, sanitizedNext);

    // Reserve username in Redis if provided
    if (normalizedUsername) {
      const reserved = await reserveUsername(normalizedUsername, token);
      if (!reserved) {
        // Race condition — another request reserved it between our check and reserve
        return reply.status(409).send(
          errorPayload('auth.send_login_link.username_taken', 'This username is already taken.'),
        );
      }
    }

    // Create token and send email (or log link for dev when email is disabled)
    const link = makeLoginLinkUrl(token);

    // Look up user's preferred locale for email localization (defaults to 'en' for new users)
    let userLocale = 'en';
    const [existingUser] = await db
      .select({ preferredLocale: users.preferredLocale })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existingUser?.preferredLocale) {
      userLocale = existingUser.preferredLocale;
    }

    let sendOk = false;
    if (authMailer) {
      const sendError = await authMailer.sendLoginLink(email, link, config.loginLinkTtlSecs, userLocale);
      if (sendError) {
        app.log.error({ err: sendError, email }, 'Failed to send login link email');
      } else {
        sendOk = true;
      }
    } else {
      // No email provider configured (e.g. local dev) — log the link so the
      // developer can paste it into a browser to complete the sign-in flow.
      app.log.info({ loginLink: link }, 'Login link (email delivery disabled — copy this URL to sign in)');
      sendOk = true;
    }

    // Apply resend cooldown when delivery succeeded or was simulated (dev mode)
    if (sendOk) {
      const cooldownKey = `auth:login-link:cooldown:${hashKey(email)}`;
      await redis.set(cooldownKey, '1', 'EX', config.loginLinkResendCooldownSecs);
    }

    // Always return generic success to avoid email enumeration
    return reply.send({ ok: true });
  });

  /**
   * GET /auth/login-link/callback — Consumes a one-time login-link token,
   * resolves or creates the user, issues a session, stores an exchange code,
   * and redirects to the frontend callback route.
   */
  app.get('/auth/login-link/callback', async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.status(400).send(
        errorPayload('auth.login_link_callback.missing_token', 'Missing login token'),
      );
    }

    const payload = await consumeLoginLinkToken(token);
    if (!payload) {
      return reply.status(400).send(
        errorPayload('auth.login_link_callback.invalid_token', 'Invalid or expired login link'),
      );
    }

    const { email, username: tokenUsername, next: nextPath } = payload;

    // Trust the username only if the reservation key still maps to this exact token.
    // This guards against stale payloads from failed prior flows and satisfies the plan's
    // "trust only the username reserved for that token" requirement.
    let verifiedUsername: string | undefined;
    if (tokenUsername) {
      const reservationHolder = await redis.get(
        `auth:login-link:username-reservation:${tokenUsername}`,
      );
      verifiedUsername = reservationHolder === token ? tokenUsername : undefined;
    }

    // Resolve or create the user
    const userId = await resolveOrCreateUserByEmail(email, verifiedUsername);

    // Issue session and store behind a one-time exchange code
    const sessionToken = await issueSession(config, db, userId);
    const exchangeCode = crypto.randomUUID();
    await redis.set(`auth:code:${exchangeCode}`, sessionToken, 'EX', config.exchangeCodeTtlSecs);

    const callbackUrl = new URL('/auth/callback', config.frontendOrigin);
    callbackUrl.searchParams.set('code', exchangeCode);
    const resolvedNext = sanitizeNextParam(nextPath);
    callbackUrl.searchParams.set('next', resolvedNext);
    return reply.redirect(callbackUrl.toString());
  });

  function consumeSetupLinkToken(token: string): Promise<string | null> {
    return consumeSetupLinkTokenImpl(redis, token);
  }

  function deleteSetupLinkToken(token: string): Promise<void> {
    return deleteSetupLinkTokenImpl(redis, token);
  }

  /**
   * GET /auth/setup-link/callback — Consumes a one-time setup-link token,
   * issues a session for the user, stores an exchange code, and redirects
   * to the frontend setup form.
   */
  app.get('/auth/setup-link/callback', async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) {
      return reply.status(400).send(
        errorPayload('auth.setup_link_callback.missing_token', 'Missing setup token'),
      );
    }

    const userId = await consumeSetupLinkToken(token);
    if (!userId) {
      return reply.status(400).send(
        errorPayload(
          'auth.setup_link_callback.invalid_token',
          'This link has expired. Use /connect in Telegram to get a new one.',
        ),
      );
    }

    // Issue session and store behind a one-time exchange code
    const sessionToken = await issueSession(config, db, userId);
    const exchangeCode = crypto.randomUUID();
    await redis.set(`auth:code:${exchangeCode}`, sessionToken, 'EX', config.exchangeCodeTtlSecs);

    // Delete the token only after the session is successfully issued.
    // This keeps the token alive through link previews and accidental GETs
    // so the real user click still works.
    await deleteSetupLinkToken(token);

    const callbackUrl = new URL('/setup/provider-link', config.frontendOrigin);
    callbackUrl.searchParams.set('code', exchangeCode);
    return reply.redirect(callbackUrl.toString());
  });

  /**
   * POST /auth/register — Create a new local (email + password) account.
   * Returns a JWT directly (no exchange code needed — direct POST, not a redirect).
   */
  app.post('/auth/register', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = typeof body?.['email'] === 'string' ? body['email'].toLowerCase().trim() : undefined;
    const password = typeof body?.['password'] === 'string' ? body['password'] : undefined;

    if (!email || !password) {
      return reply.status(400).send(
        errorPayload('auth.register.required_fields', 'Email and password are required'),
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

    // Auto-generate username with bounded retry on actual DB unique-constraint conflicts.
    const base = deriveBaseUsername(email);
    const MAX_REGISTER_RETRIES = 5;
    let registrationToken: string | undefined;
    for (let attempt = 0; attempt < MAX_REGISTER_RETRIES; attempt++) {
      const stem = attempt === 0 ? base : `${base.slice(0, 26)}_${generateUniqueSuffix()}`;
      const candidate = stem.length > 30 ? stem.slice(0, 30) : stem;
      const displayName = humanizeDisplayName(candidate);
      try {
        await db.transaction(async (tx) => {
          await tx.insert(users).values({
            id: userId,
            username: candidate,
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
        registrationToken = await issueSession(config, db, userId);
        break;
      } catch (err) {
        if (!isUsernameUniqueConflict(err)) throw err;
        // Username collision — retry with fresh entropy
      }
    }
    if (!registrationToken) {
      app.log.error({ email }, 'Registration failed: username conflict after retries');
      return reply.status(500).send(
        errorPayload('auth.register.failed', 'Account creation failed. Please try again.'),
      );
    }
    return reply.status(201).send({ token: registrationToken });
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
      // Dedicated error: the user exists but has no local password identity
      return reply.status(401).send(
        errorPayload('auth.login.password_not_available', 'This account uses email-link or Google sign-in. Use those methods to sign in.'),
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
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      planId: user.planId,
      isAdmin: user.isAdmin,
      planEntitlements: profilePlanEntitlements(user.planId, user.isAdmin),
      preferredLocale: user.preferredLocale ?? null,
      telegramChatId: user.telegramChatId ?? null,
      notificationPreferences: user.notificationPreferences ?? null,
      createdAt: user.createdAt.toISOString(),
    });
  });

  /**
   * PATCH /auth/me — Update mutable user profile fields.
   * Currently supports: preferredLocale, telegramChatId, and notificationPreferences.
   */
  app.patch('/auth/me', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.status(401).send(errorPayload('auth.unauthenticated', 'Not authenticated'));
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const updates: {
      preferredLocale?: SupportedLocale | null;
      telegramChatId?: string | null;
      notificationPreferences?: {
        sendMessage?: {
          email?: { enabled: boolean; source: 'explicit_update'; enabledAt?: string };
        };
      } | null;
      updatedAt: Date;
    } = {
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
      // Normalise whitespace and blank strings to null so a stray space
      // cannot produce a broken Telegram delivery destination.
      updates.telegramChatId = typeof val === 'string' ? (val.trim() || null) : null;
    }

    if ('notificationPreferences' in body) {
      const val = body['notificationPreferences'];
      if (val === null) {
        updates.notificationPreferences = null;
      } else {
        const parsed = NotificationPreferencesInputSchema.safeParse(val);
        if (!parsed.success) {
          return reply.status(400).send(
            errorPayload('auth.profile.invalid_notification_preferences', 'Invalid notificationPreferences value'),
          );
        }
        const [currentUser] = await db.select({ notificationPreferences: users.notificationPreferences }).from(users).where(eq(users.id, userId)).limit(1);
        const current = currentUser?.notificationPreferences ?? null;
        updates.notificationPreferences = resolveNotificationPreferences(parsed.data, current);
      }
    }

    await db.update(users).set(updates).where(eq(users.id, userId));

    const [updated] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!updated) return reply.status(404).send(errorPayload('auth.user_not_found', 'User not found'));

    return reply.send({
      id: updated.id,
      username: updated.username,
      displayName: updated.displayName,
      email: updated.email,
      avatarUrl: updated.avatarUrl,
      planId: updated.planId,
      planEntitlements: profilePlanEntitlements(updated.planId, updated.isAdmin),
      preferredLocale: updated.preferredLocale ?? null,
      telegramChatId: updated.telegramChatId ?? null,
      notificationPreferences: updated.notificationPreferences ?? null,
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
 * Runs inside a transaction per attempt. Uses targeted onConflictDoNothing so concurrent
 * first-logins for the same Google account are handled gracefully, while username conflicts
 * propagate and trigger a retry with fresh entropy.
 */
async function findOrCreateUser(db: Database, googleUser: GoogleUserInfo, defaultPlanId: string): Promise<string> {
  const baseUsername = deriveBaseUsername(googleUser.email);
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const stem = attempt === 0
      ? baseUsername
      : `${baseUsername.slice(0, 26)}_${generateUniqueSuffix()}`;
    const candidate = stem.length > 30 ? stem.slice(0, 30) : stem;

    try {
      return await db.transaction(async (tx) => {
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

        // Try to create the user — onConflictDoNothing targets only the email column so that
        // concurrent first-logins (email conflict) are silently handled while username
        // conflicts propagate and trigger the outer retry loop.
        const newUserId = crypto.randomUUID();
        const now = new Date();
        const displayName = humanizeDisplayName(candidate);

        await tx.insert(users).values({
          id: newUserId,
          username: candidate,
          displayName,
          email: googleUser.email,
          avatarUrl: googleUser.picture ?? null,
          planId: defaultPlanId,
          preferredLocale: null,
          telegramChatId: null,
          aiModelConfig: null,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing({ target: users.email });

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
    } catch (err) {
      if (isUsernameUniqueConflict(err)) continue; // retry with fresh entropy
      throw err;
    }
  }

  throw new Error(`OAuth user creation failed: username conflict after ${MAX_RETRIES} attempts`);
}

/** Create a new session and return a signed JWT. Shared by OAuth and local auth flows. */
async function issueSession(config: AuthConfig, db: Database, userId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.jwtTtlSecs * 1000);
  await db.insert(sessions).values({ id: sessionId, userId, expiresAt, createdAt: new Date() });
  return createSessionToken(config, userId, sessionId);
}
