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

  /**
   * List all client nodes (`GET /v1/nodes`).
   *
   * Returns the raw stub entries Nomad reports in the node list. Fail-soft: an
   * unreachable API, a non-ok response, or a body that is not a JSON array returns
   * `null` (distinct from `[]`, which is a real empty cluster) so callers can keep a
   * prior reading rather than treat an error as "no nodes".
   */
  async listNodes(): Promise<NomadNodeListEntry[] | null> {
    try {
      const response = await this.request('/v1/nodes', { method: 'GET' });
      if (!response.ok) {
        logger.warn({ status: response.status }, 'Nomad node list failed');
        return null;
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        logger.warn('Nomad node list is not an array');
        return null;
      }
      return body as NomadNodeListEntry[];
    } catch (error: unknown) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Nomad node list error');
      return null;
    }
  }

  /**
   * Fetch a single node's detail (`GET /v1/node/{id}`), including its class, pool,
   * status, and `NodeResources`. Fail-soft: returns `null` on any error or non-object
   * body, so a flaky single-node read never blanks a whole snapshot.
   */
  async getNode(nodeId: string): Promise<NomadNodeDetail | null> {
    try {
      const response = await this.request(`/v1/node/${encodeURIComponent(nodeId)}`, { method: 'GET' });
      if (!response.ok) {
        logger.warn({ nodeId, status: response.status }, 'Nomad node detail failed');
        return null;
      }
      const body: unknown = await response.json();
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        logger.warn({ nodeId }, 'Nomad node detail is not an object');
        return null;
      }
      return body as NomadNodeDetail;
    } catch (error: unknown) {
      logger.warn({ nodeId, error: error instanceof Error ? error.message : String(error) }, 'Nomad node detail error');
      return null;
    }
  }

  /**
   * Fetch a node's allocations (`GET /v1/node/{id}/allocations`). Fail-soft: returns
   * `null` on any error or non-array body (distinct from `[]`, a node with no
   * allocations), so a failed read is never counted as zero containers.
   */
  async getNodeAllocations(nodeId: string): Promise<NomadNodeAllocation[] | null> {
    try {
      const response = await this.request(`/v1/node/${encodeURIComponent(nodeId)}/allocations`, { method: 'GET' });
      if (!response.ok) {
        logger.warn({ nodeId, status: response.status }, 'Nomad node allocations failed');
        return null;
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        logger.warn({ nodeId }, 'Nomad node allocations is not an array');
        return null;
      }
      return body as NomadNodeAllocation[];
    } catch (error: unknown) {
      logger.warn({ nodeId, error: error instanceof Error ? error.message : String(error) }, 'Nomad node allocations error');
      return null;
    }
  }

  /**
   * Resolve ALL healthy instances of a Nomad-registered service.
   *
   * Same endpoint as {@link resolveService} but returns every entry instead of
   * just the first. Needed when the caller must iterate over all instances
   * (e.g. polling each browser-pool container for health metrics).
   */
  async resolveAllServices(serviceName: string): Promise<{ address: string; port: number }[]> {
    try {
      const response = await this.request(
        `/v1/service/${encodeURIComponent(serviceName)}`,
        { method: 'GET' },
      );

      if (!response.ok) {
        logger.warn({ serviceName, status: response.status }, 'Nomad service lookup failed (all)');
        return [];
      }

      const entries = (await response.json()) as NomadServiceEntry[];
      if (entries.length === 0) {
        logger.debug({ serviceName }, 'Nomad service has no registered instances (all)');
        return [];
      }

      logger.debug({ serviceName, count: entries.length }, 'Nomad service resolved (all instances)');
      return entries.map(e => ({ address: e.Address, port: e.Port }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ serviceName, error: message }, 'Nomad service resolution error (all)');
      return [];
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

/** A node stub as returned by `GET /v1/nodes` (the fields we rely on). */
export interface NomadNodeListEntry {
  ID: string;
  Name?: string;
  Status?: string;
  SchedulingEligibility?: string;
  NodeClass?: string;
}

/** A node detail as returned by `GET /v1/node/{id}` (the fields we rely on). */
export interface NomadNodeDetail {
  ID: string;
  Name?: string;
  Status?: string;
  SchedulingEligibility?: string;
  NodeClass?: string;
  Meta?: Record<string, unknown> | null;
  /** Total allocatable resources on the node. */
  NodeResources?: {
    Memory?: { MemoryMB?: number };
    Cpu?: { CpuShares?: number };
  } | null;
  /** Resources Nomad holds back for the host/system (not available to allocations). */
  ReservedResources?: {
    Memory?: { MemoryMB?: number };
    Cpu?: { CpuShares?: number };
  } | null;
}

/** A node allocation as returned by `GET /v1/node/{id}/allocations` (the fields we rely on). */
export interface NomadNodeAllocation {
  ID: string;
  ClientStatus?: string;
  DesiredStatus?: string;
  /** Per-task allocated resources; memory and CPU are summed across tasks. */
  AllocatedResources?: {
    Tasks?: Record<string, { Memory?: { MemoryMB?: number }; Cpu?: { CpuShares?: number } }> | null;
  } | null;
}

/** Nomad node class that identifies an agent node. Matches check-nomad-capacity.sh. */
export const AGENT_NODE_CLASS = 'agent';

/** A ready agent node paired with its current allocations (one Nomad snapshot). */
export interface AgentNodeSnapshot {
  detail: NomadNodeDetail;
  allocations: NomadNodeAllocation[];
}

/**
 * True when a node list stub is a ready, eligible member of the given node class.
 * Mirrors the agent-node filter in infra/hetzner/scripts/check-nomad-capacity.sh
 * (`Status == "ready" && SchedulingEligibility == "eligible" && NodeClass == <class>`).
 */
export function isReadyNodeOfClass(node: NomadNodeListEntry, nodeClass: string): boolean {
  return node.Status === 'ready'
    && node.SchedulingEligibility === 'eligible'
    && node.NodeClass === nodeClass;
}

/**
 * Whether a node's `Meta.node_pool` matches the configured pool. An empty pool means
 * "do not filter" (single-pool clusters). Mirrors check-nomad-capacity.sh's
 * `Meta.node_pool == $pool` check, which runs on the node detail (list stubs lack Meta).
 */
export function nodeMatchesPool(detail: NomadNodeDetail, nodePool: string): boolean {
  if (nodePool === '') return true;
  return detail.Meta?.['node_pool'] === nodePool;
}

/**
 * The single definition of an allocation that currently occupies its node: pending,
 * running, or unknown (an unknown status is counted, not guessed away). Used for both the
 * per-node container count and the capacity math, so the two always agree.
 */
export function allocationOccupiesNode(alloc: NomadNodeAllocation): boolean {
  const status = alloc.ClientStatus;
  return status === 'pending' || status === 'running' || status === 'unknown';
}

/** Count of allocations currently occupying the node. */
export function countActiveAllocations(allocations: NomadNodeAllocation[]): number {
  return allocations.filter(allocationOccupiesNode).length;
}

/**
 * Read every ready agent node and its allocations in one pass: list nodes, keep the ready
 * `AGENT_NODE_CLASS` stubs, then fetch each node's detail and allocations and keep only
 * those whose `Meta.node_pool` matches `nodePool`. Shared by both the agent-server health
 * and cluster-capacity publishers so the node filter lives in exactly one place.
 *
 * Fail-soft: returns `null` if the node list or ANY per-node read fails, so a caller can
 * skip the cycle rather than act on a partial fleet. Returns `[]` for a genuinely empty
 * agent fleet.
 */
export async function readAgentNodes(client: NomadClient, nodePool: string): Promise<AgentNodeSnapshot[] | null> {
  const nodes = await client.listNodes();
  if (nodes === null) return null;

  const stubs = nodes.filter((node) => isReadyNodeOfClass(node, AGENT_NODE_CLASS));
  const snapshots: AgentNodeSnapshot[] = [];

  for (const stub of stubs) {
    const [detail, allocations] = await Promise.all([
      client.getNode(stub.ID),
      client.getNodeAllocations(stub.ID),
    ]);
    if (detail === null || allocations === null) return null;
    if (!nodeMatchesPool(detail, nodePool)) continue;
    snapshots.push({ detail, allocations });
  }

  return snapshots;
}
