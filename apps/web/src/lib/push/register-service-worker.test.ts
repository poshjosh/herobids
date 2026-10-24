import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker, SERVICE_WORKER_SCOPE, SERVICE_WORKER_URL } from './register-service-worker.js';

describe('registerServiceWorker', () => {
  it('is a no-op when the browser has no service worker support', async () => {
    await expect(registerServiceWorker(undefined)).resolves.toBe('unsupported');
  });

  it('registers /sw.js at the root scope without requesting permission', async () => {
    const register = vi.fn(async () => ({ scope: SERVICE_WORKER_SCOPE }));

    await expect(registerServiceWorker({ register })).resolves.toBe('registered');

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: '/' });
  });

  it('reports failure without throwing when registration is rejected', async () => {
    const register = vi.fn(async () => {
      throw new Error('insecure origin');
    });

    await expect(registerServiceWorker({ register })).resolves.toBe('failed');
  });
});
