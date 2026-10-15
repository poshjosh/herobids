import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { AuthConfig } from '@herobids/domain';
import { authPlugin } from './auth.js';

const config: AuthConfig = {
  publicBaseUrl: 'http://localhost:3000',
  frontendOrigin: 'http://localhost:5173',
  jwtSecret: 'test-secret-for-public-route-tests-32ch!!',
  jwtTtlSecs: 3600,
  exchangeCodeTtlSecs: 60,
  googleClientId: 'test-client-id',
  googleClientSecret: 'test-client-secret',
  secureCookie: false,
  loginLinkTtlSecs: 600,
  loginLinkResendCooldownSecs: 60,
  loginLinkMaxSendsPerWindow: 5,
  loginLinkWindowSecs: 3600,
  loginLinkMaxSendsPerIpWindow: 10,
};

// The public-route check runs before any database access, so a stub db is enough.
const unusedDb = {} as never;

async function buildApp() {
  const app = Fastify({ logger: false });
  await authPlugin(app, { config, db: unusedDb });
  app.get('/auth/connection-request/callback', async () => ({ reached: 'handler' }));
  app.get('/agents', async () => ({ reached: 'handler' }));
  await app.ready();
  return app;
}

describe('authPlugin public routes', () => {
  it('lets a connection-request link reach its handler without a session token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/connection-request/callback?token=abc' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reached: 'handler' });
    await app.close();
  });

  it('still rejects a protected route without a token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/agents' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
