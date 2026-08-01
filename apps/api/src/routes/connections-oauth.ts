import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig, PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { connections, userCredentials, users } from '@herobids/db';
import { eq, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import {
  generateConnectionOAuthState,
  verifyConnectionOAuthState,
  OAUTH_CONNECTION_STATE_COOKIE,
  OAUTH_CONNECTION_RETURN_TO_COOKIE,
} from './connections-oauth-state.js';
import { encryptCredential, getEncryptionKey } from '../crypto.js';
import { checkConnectionLimit, checkCredentialLimit } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';

// ── Google OAuth response types ────────────────────────────────────────────

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface GoogleUserInfo {
  email: string;
  email_verified?: boolean;
}

// ── Scopes for Gmail connection ────────────────────────────────────────────
// Send-only for Gmail actions, plus a lightweight identity scope so the
// callback can resolve the connected account email via Google userinfo.
// gmail.readonly remains deferred until Google scope verification is approved
// and inbox-read is intentionally re-enabled.

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// ── Cookie helpers ─────────────────────────────────────────────────────────

function parseCookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return undefined;
}

// ── Route registration ─────────────────────────────────────────────────────

export async function connectionsOauthRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
  plansConfig?: PlansConfig,
): Promise<void> {
  const gmailConfig = config.integrations.gmail;
  const jwtSecret = config.auth.jwtSecret;
  const secureCookie = config.auth.secureCookie;
  const frontendOrigin = config.auth.frontendOrigin;
  const publicBaseUrl = config.auth.publicBaseUrl;

  function resolveRedirectUri(): string {
    if (gmailConfig.redirectUri) return gmailConfig.redirectUri;
    return `${publicBaseUrl}/connections/oauth/gmail/callback`;
  }

  function buildGmailAuthorizeFlow(userId: string): { state: string; authorizeUrl: string } {
    const state = generateConnectionOAuthState(userId, jwtSecret);
    const redirectUri = resolveRedirectUri();

    const params = new URLSearchParams({
      client_id: gmailConfig.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    return {
      state,
      authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    };
  }

  function setConnectionOAuthStateCookie(reply: FastifyReply, state: string): void {
    const securePart = secureCookie ? '; Secure' : '';
    reply.header(
      'Set-Cookie',
      `${OAUTH_CONNECTION_STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/connections/oauth/gmail/callback; Max-Age=600${securePart}`,
    );
  }

  function sanitizeFrontendReturnTo(value: string | undefined): string {
    if (!value || !value.startsWith('/') || value.startsWith('//')) {
      return '/connections';
    }

    try {
      const url = new URL(value, frontendOrigin);
      if (url.origin !== frontendOrigin) {
        return '/connections';
      }
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return '/connections';
    }
  }

  function setConnectionOAuthReturnToCookie(reply: FastifyReply, returnTo: string): void {
    const securePart = secureCookie ? '; Secure' : '';
    reply.header(
      'Set-Cookie',
      `${OAUTH_CONNECTION_RETURN_TO_COOKIE}=${encodeURIComponent(returnTo)}; HttpOnly; SameSite=Lax; Path=/connections/oauth/gmail/callback; Max-Age=600${securePart}`,
    );
  }

  // ── 2.2 POST /connections/oauth/gmail/authorize ──────────────────────────

  app.post('/connections/oauth/gmail/authorize', async (request, reply) => {
    if (!gmailConfig.clientId) {
      return reply.status(500).send(
        errorPayload('gmail.not_configured', 'Gmail integration is not configured'),
      );
    }

    const body = (request.body ?? {}) as { returnTo?: string };
    const { state, authorizeUrl } = buildGmailAuthorizeFlow(request.userId);
    setConnectionOAuthStateCookie(reply, state);
    setConnectionOAuthReturnToCookie(reply, sanitizeFrontendReturnTo(body.returnTo));

    return { authorizeUrl };
  });

  // ── 2.2 GET /connections/oauth/gmail/authorize ───────────────────────────

  app.get('/connections/oauth/gmail/authorize', async (request, reply) => {
    if (!gmailConfig.clientId) {
      return reply.status(500).send(
        errorPayload('gmail.not_configured', 'Gmail integration is not configured'),
      );
    }

    const query = request.query as { returnTo?: string };
    const { state, authorizeUrl } = buildGmailAuthorizeFlow(request.userId);
    setConnectionOAuthStateCookie(reply, state);
    setConnectionOAuthReturnToCookie(reply, sanitizeFrontendReturnTo(query.returnTo));

    return reply.redirect(authorizeUrl);
  });

  // ── 2.3 GET /connections/oauth/gmail/callback ────────────────────────────

  app.get('/connections/oauth/gmail/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code) {
      return reply.status(400).send(
        errorPayload('gmail.callback.missing_code', 'Missing authorization code'),
      );
    }

    // Verify CSRF state — must match the cookie set during authorize
    const cookieState = parseCookieValue(
      request.headers['cookie'],
      OAUTH_CONNECTION_STATE_COOKIE,
    );
    const cookieReturnTo = parseCookieValue(
      request.headers['cookie'],
      OAUTH_CONNECTION_RETURN_TO_COOKIE,
    );
    const stateUserId = verifyConnectionOAuthState(
      state ?? '',
      cookieState ?? '',
      jwtSecret,
    );
    if (!stateUserId) {
      return reply.status(400).send(
        errorPayload(
          'gmail.callback.invalid_state',
          'Invalid or missing OAuth state',
        ),
      );
    }

    // Look up the user from DB — this route is public (no JWT), so we use
    // stateUserId extracted from the verified HMAC-signed state token.
    const [user] = await db
      .select({ planId: users.planId, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, stateUserId))
      .limit(1);
    if (!user) {
      return reply.status(404).send(
        errorPayload(
          'gmail.callback.user_not_found',
          'User not found',
        ),
      );
    }

    // Exchange authorization code for access + refresh tokens
    const redirectUri = resolveRedirectUri();
    let tokenRes: Response;
    try {
      tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: gmailConfig.clientId,
          client_secret: gmailConfig.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
    } catch (err) {
      app.log.error({ err }, 'Gmail OAuth token exchange network error');
      return reply.status(502).send(
        errorPayload(
          'gmail.callback.token_exchange_failed',
          'OAuth token exchange failed',
        ),
      );
    }

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      app.log.error(
        { status: tokenRes.status, body: errBody },
        'Gmail token exchange failed',
      );
      return reply.status(502).send(
        errorPayload(
          'gmail.callback.token_exchange_failed',
          'OAuth token exchange failed',
        ),
      );
    }

    const tokens = (await tokenRes.json()) as GoogleTokenResponse;

    // Google may omit refresh_token even with prompt=consent. An empty string
    // causes silent failures later — reject early.
    if (!tokens.refresh_token) {
      return reply.status(502).send(
        errorPayload(
          'gmail.callback.no_refresh_token',
          'Google did not return a refresh token. Please revoke the app in your Google account settings and try again.',
          { hint: 'Ensure the Google Cloud project is in "production" mode, not "testing".' },
        ),
      );
    }

    // Fetch user email via userinfo endpoint
    let userInfoRes: Response;
    try {
      userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
    } catch (err) {
      app.log.error({ err }, 'Gmail userinfo network error');
      return reply.status(502).send(
        errorPayload(
          'gmail.callback.userinfo_failed',
          'Failed to fetch user info from Google',
        ),
      );
    }

    if (!userInfoRes.ok) {
      const errBody = await userInfoRes.text();
      app.log.error(
        { status: userInfoRes.status, body: errBody },
        'Gmail userinfo request failed',
      );
      return reply.status(502).send(
        errorPayload(
          'gmail.callback.userinfo_failed',
          'Failed to fetch user info from Google',
        ),
      );
    }

    const userInfo = (await userInfoRes.json()) as GoogleUserInfo;

    if (userInfo.email_verified !== true) {
      return reply.status(400).send(
        errorPayload(
          'gmail.callback.email_not_verified',
          'Google account email is not verified. Cannot create Gmail connection.',
        ),
      );
    }

    const email = userInfo.email;

    // ── Build token blob for encrypted storage ───────────────────────────

    const tokenBlob = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? '',
      expiry_date: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
      token_type: tokens.token_type,
      email,
    };

    const encryptionKey = getEncryptionKey();
    const credentialId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const now = new Date();

    // ── 2.4 Single transaction: lock → plan checks → insert credential + connection

    const txResult = await db.transaction(async (tx) => {
      if (plansConfig) {
        // Serialise per-user credential+connection creation to avoid
        // over-limit races. Uses the same lock key namespace (arg1=14) as
        // setup.ts so a concurrent /setup/provider-link call competes
        // for the same lock.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(14, hashtext(${stateUserId}))`,
        );

        // NOTE: tx must be cast to Database for plan guard queries.
        // This pattern is inherited from setup.ts. If the Drizzle tx type drifts
        // from the Database interface used by plan guards, plan-limit checks could
        // silently fail at runtime. Consider extracting a proper tx-safe Database type.
        const credentialCheck = await checkCredentialLimit(
          tx as unknown as Database,
          plansConfig,
          stateUserId,
          user.planId || 'free',
          user.isAdmin,
        );
        if (!credentialCheck.ok) {
          return { kind: 'limit' as const, error: credentialCheck.error };
        }

        const connectionCheck = await checkConnectionLimit(
          tx as unknown as Database,
          plansConfig,
          stateUserId,
          user.planId || 'free',
          user.isAdmin,
        );
        if (!connectionCheck.ok) {
          return { kind: 'limit' as const, error: connectionCheck.error };
        }
      }

      const { encryptedData, encryptionMeta } = encryptCredential(
        JSON.stringify(tokenBlob),
        encryptionKey,
      );

      await tx.insert(userCredentials).values({
        id: credentialId,
        userId: stateUserId,
        provider: 'gmail',
        label: email,
        encryptedData,
        encryptionMeta,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(connections).values({
        id: connectionId,
        userId: stateUserId,
        credentialId,
        provider: 'gmail',
        label: email,
        status: 'active',
        profile: { email },
        meta: null,
        createdAt: now,
        updatedAt: now,
      });

      return { kind: 'ok' as const };
    });

    if (txResult.kind === 'limit') {
      return reply.status(403).send(
        errorPayload(
          txResult.error.code,
          txResult.error.message,
          txResult.error.params,
        ),
      );
    }

    // Redirect to frontend success page
    const callbackUrl = new URL(sanitizeFrontendReturnTo(cookieReturnTo), frontendOrigin);
    callbackUrl.searchParams.set('setup', 'gmail');
    callbackUrl.searchParams.set('status', 'ok');
    callbackUrl.searchParams.set('connectionId', connectionId);
    return reply.redirect(callbackUrl.toString());
  });
}
