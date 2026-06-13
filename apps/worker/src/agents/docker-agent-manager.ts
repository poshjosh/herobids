import pino from 'pino';
import type { RuntimeDescriptor } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { PlatformAlertService } from '../alerting/platform-alert-service.js';
import { PLATFORM_ALERT_EVENTS } from '../alerting/platform-alert-service.js';

const logger = pino({ name: 'docker-agent-manager' });

export interface DockerAgentManagerConfig {
  /** Docker API URL via docker-socket-proxy. Default: tcp://docker-proxy:2375 */
  dockerHost: string;
  /** Docker network the agent container joins. Default: herobids_default */
  dockerNetwork: string;
  /** Docker image used for agent containers. Default: herobids-agent:latest */
  agentImage: string;
  /** Redis URL injected into agent container env */
  redisUrl: string;
  /** LLM provider name injected into agent container env (e.g. 'openrouter', 'anthropic') */
  llmProvider?: string;
  /** LLM base URL injected into agent container env */
  llmBaseUrl?: string;
  /** LLM model injected into agent container env */
  llmModel?: string;
  /** Max tokens per LLM call injected into agent container env */
  llmMaxTokens?: number;
  /** LLM call timeout in ms injected into agent container env */
  llmTimeoutMs?: number;
  /** Agent reasoning loop interval in ms injected into agent container env */
  llmTickIntervalMs?: number;
  /** Agent heartbeat cadence in ms injected into agent container env */
  llmHeartbeatIntervalMs?: number;
  /** Operator-configured server cost per hour injected into the agent container env */
  llmServerCostUsdPerHour?: number;
  /** Optional trading hours gate configuration for the agent runtime */
  llmTradingHoursJson?: string;
  /** Full operator-validated market-data config forwarded to the agent runtime */
  marketDataConfigJson?: string;
  /** Full operator agentRuntime config (policy, budgets, thresholds) forwarded to the agent runtime */
  agentRuntimeConfigJson: string;
  /** Market data: DexScreener base URL */
  marketDataDexscreenerBaseUrl?: string;
  /** Market data: DexScreener requests per minute */
  marketDataDexscreenerRpm?: number;
  /** Market data: Binance base URL */
  marketDataBinanceBaseUrl?: string;
  /** Market data: Binance requests per minute */
  marketDataBinanceRpm?: number;
  /** Market data: request timeout ms */
  marketDataTimeoutMs?: number;
  /** Memory limit per agent container in MB. Default: 512 */
  memoryLimitMb?: number;
  /** CPU shares per agent container. Default: 512 */
  cpuShares?: number;
  /** Tmpfs size limit for /tmp in MB. Default: 100 */
  tempStorageMb?: number;
  /** Max number of processes (PIDs) inside the container. Default: 10 */
  maxProcesses?: number;
}

export interface DockerContainerSpec {
  agentId: string;
  sessionId: string;
  agentConfig: Record<string, unknown>;
  runtimeDescriptor?: RuntimeDescriptor;
  toolPolicy: Record<string, unknown>;
}

/**
 * DockerAgentManager — launches, stops, and reconciles agent containers.
 *
 * Communicates with Docker via a socket-proxy (restricted API surface).
 * Each agent runs in an isolated container named `herobids-agent-{agentId}`.
 *
 * In production this is the `docker` runtime mode. The stub mode in
 * AgentRuntimeLauncher remains for local dev without Docker available.
 */
export class DockerAgentManager {
  private readonly dockerApiBase: string;
  private readonly network: string;
  private readonly image: string;
  private readonly redisUrl: string;
  private readonly llmProvider: string | undefined;
  private readonly llmBaseUrl: string | undefined;
  private readonly llmModel: string | undefined;
  private readonly llmMaxTokens: number | undefined;
  private readonly llmTimeoutMs: number | undefined;
  private readonly llmTickIntervalMs: number | undefined;
  private readonly llmHeartbeatIntervalMs: number | undefined;
  private readonly llmServerCostUsdPerHour: number | undefined;
  private readonly llmTradingHoursJson: string | undefined;
  private readonly marketDataConfigJson: string | undefined;
  private readonly agentRuntimeConfigJson: string;
  private readonly marketDataDexscreenerBaseUrl: string | undefined;
  private readonly marketDataDexscreenerRpm: number | undefined;
  private readonly marketDataBinanceBaseUrl: string | undefined;
  private readonly marketDataBinanceRpm: number | undefined;
  private readonly marketDataTimeoutMs: number | undefined;
  private readonly memoryBytes: number;
  private readonly cpuShares: number;
  private readonly tempStorageMb: number;
  private readonly maxProcesses: number;

  private eventStreamAbort: AbortController | null = null;

  constructor(
    _config: DockerAgentManagerConfig,
    private readonly agentRepo: AgentRepository,
    private readonly platformAlerts?: PlatformAlertService,
  ) {
    const rawHost = _config.dockerHost;
    this.dockerApiBase = rawHost.startsWith('http')
      ? rawHost
      : rawHost.startsWith('tcp://')
        ? rawHost.replace(/^tcp:\/\//, 'http://')
        : `http://${rawHost}`;
    this.network = _config.dockerNetwork;
    this.image = _config.agentImage;
    this.redisUrl = _config.redisUrl;
    this.llmProvider = _config.llmProvider;
    this.llmBaseUrl = _config.llmBaseUrl;
    this.llmModel = _config.llmModel;
    this.llmMaxTokens = _config.llmMaxTokens;
    this.llmTimeoutMs = _config.llmTimeoutMs;
    this.llmTickIntervalMs = _config.llmTickIntervalMs;
    this.llmHeartbeatIntervalMs = _config.llmHeartbeatIntervalMs;
    this.llmServerCostUsdPerHour = _config.llmServerCostUsdPerHour;
    this.llmTradingHoursJson = _config.llmTradingHoursJson;
    this.marketDataConfigJson = _config.marketDataConfigJson;
    this.agentRuntimeConfigJson = _config.agentRuntimeConfigJson;
    this.marketDataDexscreenerBaseUrl = _config.marketDataDexscreenerBaseUrl;
    this.marketDataDexscreenerRpm = _config.marketDataDexscreenerRpm;
    this.marketDataBinanceBaseUrl = _config.marketDataBinanceBaseUrl;
    this.marketDataBinanceRpm = _config.marketDataBinanceRpm;
    this.marketDataTimeoutMs = _config.marketDataTimeoutMs;
    this.memoryBytes = (_config.memoryLimitMb ?? 512) * 1024 * 1024;
    this.cpuShares = _config.cpuShares ?? 512;
    this.tempStorageMb = _config.tempStorageMb ?? 100;
    this.maxProcesses = _config.maxProcesses ?? 10;
  }

  /**
   * Start an agent container. If a container with the same name already
   * exists and is running, returns without creating a duplicate.
   */
  async start(spec: DockerContainerSpec): Promise<{ containerId: string }> {
    const name = `herobids-agent-${spec.agentId}`;

    // Remove any stopped container with the same name to allow restart
    await this.removeStoppedContainer(name);

    const agentConfigJson = JSON.stringify({
      ...spec.agentConfig,
      ...(spec.runtimeDescriptor ? { runtimeDescriptor: spec.runtimeDescriptor } : {}),
    });
    const toolPolicyJson = JSON.stringify(spec.toolPolicy);

    const env: string[] = [
      `REDIS_URL=${this.redisUrl}`,
      `AGENT_ID=${spec.agentId}`,
      `SESSION_ID=${spec.sessionId}`,
      `AGENT_CONFIG=${agentConfigJson}`,
      `TOOL_POLICY=${toolPolicyJson}`,
      ...(this.llmProvider ? [`LLM_PROVIDER=${this.llmProvider}`] : []),
      ...(this.llmBaseUrl ? [`LLM_BASE_URL=${this.llmBaseUrl}`] : []),
      ...(this.llmModel ? [`LLM_MODEL=${this.llmModel}`] : []),
      ...(this.llmMaxTokens != null ? [`LLM_MAX_TOKENS=${this.llmMaxTokens}`] : []),
      ...(this.llmTimeoutMs != null ? [`LLM_TIMEOUT_MS=${this.llmTimeoutMs}`] : []),
      ...(this.llmTickIntervalMs != null ? [`TICK_INTERVAL_MS=${this.llmTickIntervalMs}`] : []),
      ...(this.llmHeartbeatIntervalMs != null ? [`HEARTBEAT_INTERVAL_MS=${this.llmHeartbeatIntervalMs}`] : []),
      ...(this.llmServerCostUsdPerHour != null ? [`LLM_SERVER_COST_USD_PER_HOUR=${this.llmServerCostUsdPerHour}`] : []),
      ...(this.llmTradingHoursJson ? [`TRADING_HOURS_JSON=${this.llmTradingHoursJson}`] : []),
      ...(this.marketDataConfigJson ? [`MARKET_DATA_CONFIG_JSON=${this.marketDataConfigJson}`] : []),
      `AGENT_RUNTIME_CONFIG_JSON=${this.agentRuntimeConfigJson}`,
      // Workspace root — tools use this to agree on the per-agent workspace path
      'AGENT_WORKSPACE_ROOT=/workspace',
      // Market data config forwarded so agent tools use operator-controlled values
      // Both providers must be present — check_regime needs Binance, search_tokens needs DexScreener.
      ...(this.marketDataDexscreenerBaseUrl && this.marketDataBinanceBaseUrl ? [`MARKET_DATA_CONFIGURED=1`] : []),
      ...(this.marketDataDexscreenerBaseUrl ? [`DEXSCREENER_BASE_URL=${this.marketDataDexscreenerBaseUrl}`] : []),
      ...(this.marketDataDexscreenerRpm != null ? [`DEXSCREENER_RPM=${this.marketDataDexscreenerRpm}`] : []),
      ...(this.marketDataBinanceBaseUrl ? [`BINANCE_BASE_URL=${this.marketDataBinanceBaseUrl}`] : []),
      ...(this.marketDataBinanceRpm != null ? [`BINANCE_RPM=${this.marketDataBinanceRpm}`] : []),
      ...(this.marketDataTimeoutMs != null ? [`MARKET_DATA_TIMEOUT_MS=${this.marketDataTimeoutMs}`] : []),
      // Database URL forwarded so the agent container can make direct DB calls
      ...(process.env['DATABASE_URL'] ? [`DATABASE_URL=${process.env['DATABASE_URL']}`] : []),
      // LLM API keys must be in the worker's environment and forwarded explicitly
      ...(process.env['LLM_API_KEY'] ? [`LLM_API_KEY=${process.env['LLM_API_KEY']}`] : []),
      ...(process.env['LLM_API_KEY_OPENROUTER'] ? [`LLM_API_KEY_OPENROUTER=${process.env['LLM_API_KEY_OPENROUTER']}`] : []),
      ...(process.env['LLM_API_KEY_ANTHROPIC'] ? [`LLM_API_KEY_ANTHROPIC=${process.env['LLM_API_KEY_ANTHROPIC']}`] : []),
      ...(process.env['LLM_API_KEY_OPENAI'] ? [`LLM_API_KEY_OPENAI=${process.env['LLM_API_KEY_OPENAI']}`] : []),
      // Tavily API key for search_web tool — optional; tool handles missing key gracefully
      ...(process.env['TAVILY_API_KEY'] ? [`TAVILY_API_KEY=${process.env['TAVILY_API_KEY']}`] : []),
      // Usage billing — forwarded to agent containers so they can record LLM events
      ...(process.env['USAGE_BILLING_ENABLED'] ? [`USAGE_BILLING_ENABLED=${process.env['USAGE_BILLING_ENABLED']}`] : []),
      ...(process.env['USAGE_BILLING_RATE_CARD'] ? [`USAGE_BILLING_RATE_CARD=${process.env['USAGE_BILLING_RATE_CARD']}`] : []),
      ...(process.env['USAGE_BILLING_RUNTIME_WINDOW_MS'] ? [`USAGE_BILLING_RUNTIME_WINDOW_MS=${process.env['USAGE_BILLING_RUNTIME_WINDOW_MS']}`] : []),
    ];

    const body = {
      Image: this.image,
      name,
      Env: env,
      HostConfig: {
        NetworkMode: this.network,
        Memory: this.memoryBytes,
        CpuShares: this.cpuShares,
        // Tmpfs mount enforces tempStorageMb — writes beyond this fail with ENOSPC.
        Tmpfs: { '/tmp': `size=${this.tempStorageMb}m,noexec` },
        // PidsLimit enforces maxProcesses inside the container.
        PidsLimit: this.maxProcesses,
        // CAP_NET_ADMIN required for sandbox-exec.sh network namespace creation
        CapAdd: ['NET_ADMIN'],
        RestartPolicy: { Name: 'no' },
      },
      Labels: {
        'herobids.role': 'agent',
        'herobids.agentId': spec.agentId,
        'herobids.sessionId': spec.sessionId,
      },
    };

    const createRes = await this.dockerRequest('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      throw new Error(`Docker container create failed: ${createRes.status} ${text.slice(0, 300)}`);
    }

    const created = await createRes.json() as { Id: string };

    const startRes = await this.dockerRequest('POST', `/containers/${created.Id}/start`, {});
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => '');
      throw new Error(`Docker container start failed: ${startRes.status} ${text.slice(0, 300)}`);
    }

    logger.info({ containerId: created.Id, agentId: spec.agentId, sessionId: spec.sessionId }, 'Agent container started');
    return { containerId: created.Id };
  }

  /**
   * Stop an agent container by agentId.
   *
   * We mark the agent `stopped` in the DB *before* issuing the Docker stop so
   * that the Docker die event (which can fire before the HTTP call returns)
   * is not reclassified as a crash in onContainerDie. If the Docker stop
   * itself fails unexpectedly we revert the status to `crashed` so that crash
   * detection remains active — otherwise the container could keep running while
   * the DB reports `stopped` and any subsequent die event is silently ignored.
   */
  async stop(agentId: string): Promise<void> {
    const name = `herobids-agent-${agentId}`;
    await this.agentRepo.updateAgent(agentId, { status: 'stopped' });

    const res = await this.dockerRequest('POST', `/containers/${name}/stop`, undefined, '?t=10');
    if (!res.ok && res.status !== 404 && res.status !== 304) {
      // Docker stop failed — the container may still be running. Revert status so
      // onContainerDie can fire a crash alert if the container dies on its own later.
      // We also throw so the caller (session-manager) does not proceed to mark the agent
      // stopped, which would overwrite the reverted 'crashed' status.
      logger.warn({ agentId, status: res.status }, 'Agent container stop failed — reverting status to crashed');
      await this.agentRepo.updateAgent(agentId, { status: 'crashed' }).catch((err: unknown) => {
        logger.error({ err, agentId }, 'Failed to revert agent status after stop failure');
      });
      throw new Error(`Docker container stop failed for agent ${agentId}: HTTP ${res.status}`);
    }
    logger.info({ agentId }, 'Agent container stopped');
  }

  /**
   * Stop an agent container by agentId only (no userId check).
   * Used during worker shutdown or reconciliation.
   */
  async stopById(agentId: string): Promise<void> {
    return this.stop(agentId);
  }

  /**
   * Reconcile: compare running containers against DB agents with status='active'.
   * - Containers running but agent not active → stop orphan
   * - Agents with status='active' but no container → restart
   */
  async reconcile(): Promise<void> {
    try {
      const containersRes = await this.dockerRequest('GET', '/containers/json?filters=%7B%22label%22%3A%5B%22herobids.role%3Dagent%22%5D%7D');
      if (!containersRes.ok) {
        logger.warn({ status: containersRes.status }, 'Failed to list agent containers during reconciliation');
        return;
      }

      const containers = await containersRes.json() as Array<{ Names: string[]; State: string; Labels: Record<string, string> }>;
      const runningAgentIds = new Set<string>();

      for (const c of containers) {
        const agentId = c.Labels['herobids.agentId'];
        if (!agentId) continue;
        if (c.State === 'running') {
          runningAgentIds.add(agentId);
        } else {
          // Stopped/exited container for an agent — clean up
          const firstName = c.Names[0];
          if (firstName) {
            const cname = firstName.replace(/^\//, '');
            await this.dockerRequest('DELETE', `/containers/${cname}?force=true`);
          }
        }
      }

      // Find agents that should be running but have no container
      const activeAgents = await this.agentRepo.listActiveAgents();
      for (const agent of activeAgents) {
        if (!runningAgentIds.has(agent.id)) {
          logger.warn({ agentId: agent.id }, 'Reconcile: agent active in DB but no running container — marking crashed');
          await this.onContainerDie(agent.id, 'reconcile_no_container');
        }
      }

      logger.info({ runningCount: runningAgentIds.size }, 'Agent container reconciliation complete');
    } catch (err) {
      logger.error({ err }, 'Agent container reconciliation failed');
    }
  }

  /**
   * Called when a container die/kill event is received from Docker event stream.
   * Updates agent status to crashed, closes the active session, fires safety alert.
   */
  async onContainerDie(agentId: string, reason = 'container_exit'): Promise<void> {
    // If the agent was already marked stopped, the container exited after a voluntary
    // stop() call — do not reclassify as crashed or fire a spurious safety alert.
    const currentAgent = await this.agentRepo.getAgent(agentId);
    if (currentAgent?.status === 'stopped') {
      logger.info({ agentId, reason }, 'Agent container exited after voluntary stop — skipping crash handling');
      return;
    }

    logger.warn({ agentId, reason }, 'Agent container died unexpectedly — updating status and firing safety alert');

    try {
      await this.agentRepo.updateAgent(agentId, { status: 'crashed' });

      await this.agentRepo.retireActiveSessions(agentId);

      await this.platformAlerts?.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, {
        agentId,
        message: `Agent runtime stopped unexpectedly`,
        detail: reason,
      });
    } catch (err) {
      logger.error({ err, agentId }, 'Error handling container die event');
    }
  }

  /**
   * Subscribe to Docker event stream for container die events.
   * Calls onContainerDie for any herobids agent container that stops.
   */
  async startEventStream(): Promise<void> {
    this.eventStreamAbort = new AbortController();
    const signal = this.eventStreamAbort.signal;

    const reconnectLoop = async (): Promise<void> => {
      while (!signal.aborted) {
        try {
          await this.readEventStream(signal);
        } catch (err) {
          if (signal.aborted) break;
          logger.error({ err }, 'Docker event stream error — reconnecting in 5s');
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5000);
            signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
        }
      }
    };

    void reconnectLoop();
    logger.info('Docker event stream subscription started');
  }

  private async readEventStream(signal: AbortSignal): Promise<void> {
    // Filter: type=container, event=die, label=herobids.role=agent
    const filters = encodeURIComponent(JSON.stringify({
      type: ['container'],
      event: ['die', 'kill'],
      label: ['herobids.role=agent'],
    }));

    const res = await fetch(`${this.dockerApiBase}/events?filters=${filters}`, { signal });
    if (!res.ok) {
      throw new Error(`Docker events endpoint returned ${res.status}`);
    }

    if (!res.body) throw new Error('Docker events response has no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as {
            Actor?: { Attributes?: Record<string, string> };
          };
          const agentId = event.Actor?.Attributes?.['herobids.agentId'];
          if (agentId) {
            void this.onContainerDie(agentId, 'docker_event');
          }
        } catch {
          // Non-JSON line — ignore
        }
      }
    }
  }

  /** Stop the event stream subscription. */
  stopEventStream(): void {
    this.eventStreamAbort?.abort();
    this.eventStreamAbort = null;
  }

  private async removeStoppedContainer(name: string): Promise<void> {
    const res = await this.dockerRequest('GET', `/containers/${name}/json`);
    if (res.status === 404) return;
    if (!res.ok) return;

    const info = await res.json() as { State?: { Running?: boolean } };
    if (!info.State?.Running) {
      await this.dockerRequest('DELETE', `/containers/${name}?force=true`);
    }
  }

  private dockerRequest(method: string, path: string, body?: unknown, suffix = ''): Promise<Response> {
    const url = `${this.dockerApiBase}${path}${suffix}`;
    const init: RequestInit = {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    return fetch(url, init);
  }
}
