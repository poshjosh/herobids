import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { AppConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { connectionsOauthRoutes } from './connections-oauth.js';
import { OAUTH_CONNECTION_STATE_COOKIE } from './connections-oauth-state.js';

function makeAppConfig(): AppConfig {
  return {
    auth: {
      publicBaseUrl: 'http://localhost:3000',
      frontendOrigin: 'http://localhost:8080',
      jwtSecret: 'test-secret-at-least-32-characters-long!!',
      jwtTtlSecs: 86_400,
      exchangeCodeTtlSecs: 60,
      googleClientId: 'google-client-id',
      googleClientSecret: 'google-client-secret',
      secureCookie: false,
      loginLinkTtlSecs: 600,
      loginLinkResendCooldownSecs: 60,
      loginLinkMaxSendsPerWindow: 5,
      loginLinkWindowSecs: 3600,
      loginLinkMaxSendsPerIpWindow: 10,
    },
    api: {
      publicBaseUrl: 'http://api:3000',
    },
    integrations: {
      gmail: {
        clientId: 'gmail-client-id',
        clientSecret: 'gmail-client-secret',
        redirectUri: '',
        dailySendLimit: 50,
      },
    },
  } as unknown as AppConfig;
}

function decorateWithAuth(app: ReturnType<typeof Fastify>) {
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  app.decorateRequest('isAdmin', false);
  app.addHook('onRequest', async (request) => {
    request.userId = 'user-1';
    request.userPlanId = 'free';
    request.isAdmin = false;
  });
}

describe('connectionsOauthRoutes', () => {
  it('POST /connections/oauth/gmail/authorize returns a Google authorize URL and state cookie', async () => {
    const app = Fastify({ logger: false });
    decorateWithAuth(app);
    await connectionsOauthRoutes(app, {} as Database, makeAppConfig());
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/connections/oauth/gmail/authorize' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { authorizeUrl: string };
    const authorizeUrl = new URL(body.authorizeUrl);
    expect(authorizeUrl.origin).toBe('https://accounts.google.com');
    expect(authorizeUrl.pathname).toBe('/o/oauth2/v2/auth');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('gmail-client-id');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3000/connections/oauth/gmail/callback');
    expect(authorizeUrl.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email',
    );
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');

    const setCookie = Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie'][0]
      : res.headers['set-cookie'];
    expect(setCookie).toContain(`${OAUTH_CONNECTION_STATE_COOKIE}=`);
    expect(setCookie).toContain('Path=/connections/oauth/gmail/callback');

    await app.close();
  });

  it('prefers auth.publicBaseUrl over internal api.publicBaseUrl for the Gmail callback redirect', async () => {
    const app = Fastify({ logger: false });
    decorateWithAuth(app);
    await connectionsOauthRoutes(app, {} as Database, makeAppConfig());
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/connections/oauth/gmail/authorize' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { authorizeUrl: string };
    const authorizeUrl = new URL(body.authorizeUrl);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3000/connections/oauth/gmail/callback');
    expect(authorizeUrl.searchParams.get('redirect_uri')).not.toContain('http://api:3000');
    expect(authorizeUrl.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/userinfo.email');

    await app.close();
  });
});
