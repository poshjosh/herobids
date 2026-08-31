import { createLogger } from '../logger.js';

const logger = createLogger('nomad-client');

/**
 * Lightweight HTTP client for the Nomad API.
 *
 * Encapsulates base URL, ACL token, and request timeout so that multiple
 * consumers (runtime adapter, service discovery) share the same connection
 * parameters without duplicating HTTP plumbing.
 */
export class NomadClient {
  private readonly addr: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: NomadClientConfig) {
    this.addr = config.addr.replace(/\/+$/, '');
    this.token = config.token ?? undefined;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /** The resolved Nomad API base URL (trailing slashes stripped). */
  get baseUrl(): string {
    return this.addr;
  }

  /**
   * Send an HTTP request to the Nomad API.
   *
   * Attaches the ACL token header when configured and enforces a per-request
   * timeout via AbortController.
   */
  async request(
    path: string,
    options: { method: string; body?: string },
  ): Promise<Response> {
    const url = `${this.addr}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.token) {
      headers['X-Nomad-Token'] = this.token;
    }

    try {
      return await fetch(url, {
        method: options.method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Resolve a Nomad-registered service to an address and port.
   *
   * Queries `GET /v1/service/<name>` (Nomad native service discovery, available
   * since Nomad 1.3). Returns the first healthy entry, or `null` if the service
   * is not registered or has no healthy instances.
   */
  async resolveService(serviceName: string): Promise<{ address: string; port: number } | null> {
    try {
      const response = await this.request(
        `/v1/service/${encodeURIComponent(serviceName)}`,
        { method: 'GET' },
      );

      if (!response.ok) {
        logger.warn({ serviceName, status: response.status }, 'Nomad service lookup failed');
        return null;
      }

      const entries = (await response.json()) as NomadServiceEntry[];
      if (entries.length === 0) {
        logger.debug({ serviceName }, 'Nomad service has no registered instances');
        return null;
      }

      const entry = entries[0]!;
      logger.debug({ serviceName, address: entry.Address, port: entry.Port }, 'Nomad service resolved');
      return { address: entry.Address, port: entry.Port };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ serviceName, error: message }, 'Nomad service resolution error');
      return null;
    }
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface NomadClientConfig {
  /** Nomad API base URL (e.g. 'http://10.0.0.1:4646'). */
  addr: string;
  /** Nomad ACL token for authenticated API access. */
  token?: string | null;
  /** HTTP request timeout in ms. Default: 10_000. */
  timeoutMs?: number;
}

/** Shape of a single entry returned by `GET /v1/service/<name>`. */
interface NomadServiceEntry {
  Address: string;
  Port: number;
  ServiceName: string;
  Namespace: string;
  ID: string;
  Tags?: string[];
}
