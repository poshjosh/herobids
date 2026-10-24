import Fastify from 'fastify';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthConfig, ConnectionRequestRecord } from '@herobids/domain';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import { authRoutes } from './auth.js';
import {
  readConnectionRequestByToken,
  isConnectionRequestRedeemed,
  markConnectionRequestRedeemed,
} from '../services/connection-request-service.js';

vi.mock('../services/connection-request-service.js', () => ({
  readConnectionRequestByToken: vi.fn(),
  isConnectionRequestRedeemed: vi.fn(),
  markConnectionRequestRedeemed: vi.fn(),
}));

const config: AuthConfig = {
  publicBaseUrl: 'http://localhost:3000',
  frontendOrigin: 'http://localhost:5173',
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
};

const pendingRecord: ConnectionRequestRecord = {
  requestId: 'req-1',
  token: 'tok-1',
  agentId: 'agent-42',
  userId: 'user-1',
  provider: 'telegram',
  status: 'pending',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

function makeDb() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ name: 'tom' }]),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

async function callbackLocation(): Promise<URL> {
  const app = Fastify();
  const redis = { set: vi.fn().mockResolvedValue('OK') };
  await authRoutes(app, config, makeDb() as unknown as Database, redis as unknown as Redis);
  const res = await app.inject({ method: 'GET', url: '/auth/connection-request/callback?token=tok-1' });
  expect(res.statusCode).toBe(302);
  return new URL(String(res.headers.location));
}

describe('GET /auth/connection-request/callback', () => {
  beforeEach(() => {
    vi.mocked(readConnectionRequestByToken).mockResolvedValue(pendingRecord);
    vi.mocked(isConnectionRequestRedeemed).mockResolvedValue(false);
    vi.mocked(markConnectionRequestRedeemed).mockResolvedValue(undefined);
  });

  it('redirects to the setup form with the requesting agent id', async () => {
    const location = await callbackLocation();

    expect(location.pathname).toBe('/setup/provider-link');
    expect(location.searchParams.get('agentId')).toBe('agent-42');
    expect(location.searchParams.get('requestId')).toBe('req-1');
    expect(location.searchParams.get('provider')).toBe('telegram');
    expect(location.searchParams.get('agentName')).toBe('tom');
    expect(location.searchParams.get('code')).toBeTruthy();
  });
});
