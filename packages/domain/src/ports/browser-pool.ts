import type { Result, DomainError } from '../result.js';

export interface BrowserSession {
  cdpEndpoint: string;
  sessionId: string;
}

export interface BrowserPoolError extends DomainError {
  code: 'browser_pool.unavailable' | 'browser_pool.timeout' | 'browser_pool.queue_full' | 'browser_pool.session_limit';
}

export interface BrowserPoolPort {
  acquireSession(): Promise<Result<BrowserSession, BrowserPoolError>>;
  releaseSession(sessionId: string): Promise<void>;
}
