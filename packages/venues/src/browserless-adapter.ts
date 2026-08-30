import type { BrowserPoolPort, BrowserSession, BrowserPoolError, Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

export interface BrowserlessAdapterConfig {
  /** Base URL for the Browserless service (e.g. http://browser-pool:3000) */
  url: string;
  /** Max time to wait for session acquisition (ms) */
  acquireTimeoutMs?: number;
}

export class BrowserlessAdapter implements BrowserPoolPort {
  private readonly url: string;
  private readonly acquireTimeoutMs: number;

  constructor(config: BrowserlessAdapterConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.acquireTimeoutMs = config.acquireTimeoutMs ?? 10_000;
  }

  async acquireSession(): Promise<Result<BrowserSession, BrowserPoolError>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.acquireTimeoutMs);
    try {
      const response = await fetch(`${this.url}/json/new`, {
        method: 'PUT',
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (response.status === 429) {
          return err({ code: 'browser_pool.queue_full' as const, message: `Browser pool queue full: ${body.slice(0, 200)}` });
        }
        return err({ code: 'browser_pool.unavailable' as const, message: `Browserless error ${response.status}: ${body.slice(0, 200)}` });
      }

      const json = await response.json() as { webSocketDebuggerUrl?: string; id?: string };
      const cdpEndpoint = json.webSocketDebuggerUrl;
      const sessionId = json.id;

      if (!cdpEndpoint || !sessionId) {
        return err({ code: 'browser_pool.unavailable' as const, message: 'Browserless returned incomplete session data' });
      }

      return ok({ cdpEndpoint, sessionId });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return err({ code: 'browser_pool.timeout' as const, message: `Session acquisition timed out after ${this.acquireTimeoutMs}ms` });
      }
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: 'browser_pool.unavailable' as const, message: `Failed to connect to browser pool: ${message}` });
    } finally {
      clearTimeout(timeout);
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    try {
      await fetch(`${this.url}/json/close/${sessionId}`, { method: 'PUT' });
    } catch {
      // Best-effort cleanup — Browserless auto-cleans on disconnect
    }
  }
}
