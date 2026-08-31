import { createLogger } from '../logger.js';
import type { RuntimeDescriptor, RuntimeReconcileResult, PermissionLevel } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { PlatformAlertService } from '../alerting/platform-alert-service.js';
import { PLATFORM_ALERT_EVENTS } from '../alerting/platform-alert-service.js';

/** Listener invoked when a container termination is detected. */
export type DockerTerminationListener = (
  agentId: string,
  sessionId: string | undefined,
  reason: string,
) => void;

const logger = createLogger('docker-agent-manager');

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
  /** OpenRouter provider controls (JSON) forwarded to the agent runtime for privacy enforcement */
  openRouterProviderControlsJson?: string;
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
  /** Database URL forwarded to the agent container for direct DB access (list_bots, etc.). */
  databaseUrl?: string;
  /** Memory limit per agent container in MB. Default: 512 */
  memoryLimitMb?: number;
  /** CPU shares per agent container. Default: 512 */
  cpuShares?: number;
  /** Tmpfs size limit for /tmp in MB. Default: 100 */
  tempStorageMb?: number;
  /** Max number of processes (PIDs) inside the container. Default: 10 */
  maxProcesses?: number;
  /** Called after a container crash is confirmed and the DB is updated. */
  onAgentCrashed?: (agentId: string, sessionId?: string) => Promise<void>;
  /** Serialised external skills config (JSON) forwarded to agent containers. */
  externalSkillsConfigJson?: string;
  /** Browser pool URL forwarded to agent containers when browser pool is enabled. */
  browserPoolUrl?: string;
  /** Browserless API key forwarded to agent containers when browser pool is enabled. */
  browserPoolApiKey?: string;
  /**
   * Pre-resolved IP address for the browser pool hostname.
   * Docker service names cannot resolve inside the sandbox network namespace.
   */
  browserPoolResolvedHost?: string;
}

export interface DockerContainerSpec {
  agentId: string;
  sessionId: string;
  agentConfig: Record<string, unknown>;
  runtimeDescriptor?: RuntimeDescriptor;
  toolPolicy: Record<string, unknown>;
  /** Agent permission level — also present inside agentConfig, surfaced here for documentation clarity. */
  permissionLevel?: PermissionLevel;
}

/**
 * Overrides for individual launch-time values.
 * When provided, these take precedence over construction-time config.
 * Used by {@link DockerRuntimeAdapter} to pass through port-level config.
 */
export interface DockerStartOverrides {
  /** Pre-built env strings in Docker format (`KEY=VALUE`). */
  envVars?: string[];
  /** Pre-built metadata labels. */
  labels?: Record<string, string>;
  /** Resource overrides. */
  resources?: {
    memoryLimitMb?: number;
    cpuShares?: number;
    tempStorageMb?: number;
    maxProcesses?: number;
  };
  /** Container image override. */
  image?: string;
  /** Docker network override. */
  network?: string;
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
  private readonly openRouterProviderControlsJson: string | undefined;
  private readonly marketDataDexscreenerBaseUrl: string | undefined;
  private readonly marketDataDexscreenerRpm: number | undefined;
  private readonly marketDataBinanceBaseUrl: string | undefined;
  private readonly marketDataBinanceRpm: number | undefined;
  private readonly marketDataTimeoutMs: number | undefined;
  private readonly databaseUrl: string | undefined;
  private readonly externalSkillsConfigJson: string | undefined;
  private readonly browserPoolUrl: string | undefined;
  private readonly browserPoolApiKey: string | undefined;
  private readonly browserPoolResolvedHost: string | undefined;
  private readonly memoryBytes: number;
  private readonly cpuShares: number;
  private readonly tempStorageMb: number;
  private readonly maxProcesses: number;
  private readonly onAgentCrashed?: (agentId: string, sessionId?: string) => Promise<void>;
  private readonly terminationListeners: DockerTerminationListener[] = [];

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
    this.openRouterProviderControlsJson = _config.openRouterProviderControlsJson;
    this.marketDataDexscreenerBaseUrl = _config.marketDataDexscreenerBaseUrl;
    this.marketDataDexscreenerRpm = _config.marketDataDexscreenerRpm;
    this.marketDataBinanceBaseUrl = _config.marketDataBinanceBaseUrl;
    this.marketDataBinanceRpm = _config.marketDataBinanceRpm;
    this.marketDataTimeoutMs = _config.marketDataTimeoutMs;
    this.databaseUrl = _config.databaseUrl;
    this.externalSkillsConfigJson = _config.externalSkillsConfigJson;
    this.browserPoolUrl = _config.browserPoolUrl;
    this.browserPoolApiKey = _config.browserPoolApiKey;
    this.browserPoolResolvedHost = _config.browserPoolResolvedHost;
    this.memoryBytes = (_config.memoryLimitMb ?? 512) * 1024 * 1024;
    this.cpuShares = _config.cpuShares ?? 512;
    this.tempStorageMb = _config.tempStorageMb ?? 100;
    this.maxProcesses = _config.maxProcesses ?? 10;
    this.onAgentCrashed = _config.onAgentCrashed;
  }

  /**
   * Start an agent container.
   *
   * If a container with the same name already exists (running or stopped),
   * force-remove it first so Docker name reuse cannot fail with 409.
   *
   * @param spec Agent/session identifiers and config payloads.
   * @param overrides Optional per-launch overrides. When provided, these
   *   take precedence over construction-time config for env, labels,
   *   resources, image, and network.
   */
  async start(
    spec: DockerContainerSpec,
    overrides?: DockerStartOverrides,
  ): Promise<{ containerId: string }> {
    const name = `herobids-agent-${spec.agentId}`;

    // Remove any existing container with the same name to allow restart
    await this.removeExistingContainer(name);

    // Resolve effective image, network, and resources — overrides win.
    const effectiveImage = overrides?.image ?? this.image;
    const effectiveNetwork = overrides?.network ?? this.network;
    const effectiveMemoryMb = overrides?.resources?.memoryLimitMb ?? (this.memoryBytes / (1024 * 1024));
    const effectiveCpuShares = overrides?.resources?.cpuShares ?? this.cpuShares;
    const effectiveTempStorageMb = overrides?.resources?.tempStorageMb ?? this.tempStorageMb;
    const effectiveMaxProcesses = overrides?.resources?.maxProcesses ?? this.maxProcesses;

    // Env: overrides take full precedence; when absent, build internally.
    const env: string[] = overrides?.envVars ?? (() => {
      const agentConfigJson = JSON.stringify({
        ...spec.agentConfig,
        ...(spec.runtimeDescriptor ? { runtimeDescriptor: spec.runtimeDescriptor } : {}),
      });
      const toolPolicyJson = JSON.stringify(spec.toolPolicy);

      return [
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
        ...(this.openRouterProviderControlsJson ? [`OPENROUTER_PROVIDER_CONTROLS=${this.openRouterProviderControlsJson}`] : []),
        'AGENT_WORKSPACE_ROOT=/workspace',
        ...(this.marketDataDexscreenerBaseUrl && this.marketDataBinanceBaseUrl ? [`MARKET_DATA_CONFIGURED=1`] : []),
        ...(this.marketDataDexscreenerBaseUrl ? [`DEXSCREENER_BASE_URL=${this.marketDataDexscreenerBaseUrl}`] : []),
        ...(this.marketDataDexscreenerRpm != null ? [`DEXSCREENER_RPM=${this.marketDataDexscreenerRpm}`] : []),
        ...(this.marketDataBinanceBaseUrl ? [`BINANCE_BASE_URL=${this.marketDataBinanceBaseUrl}`] : []),
        ...(this.marketDataBinanceRpm != null ? [`BINANCE_RPM=${this.marketDataBinanceRpm}`] : []),
        ...(this.marketDataTimeoutMs != null ? [`MARKET_DATA_TIMEOUT_MS=${this.marketDataTimeoutMs}`] : []),
        ...((() => {
          const dbUrl = this.databaseUrl ?? process.env['DATABASE_URL'];
          if (!dbUrl) {
            throw new Error(
              `DATABASE_URL not available — agent container ${spec.agentId} cannot launch. ` +
              'Direct DB access is required for list_bots, get_bot_status, and other agent tools.',
            );
          }
          return [`DATABASE_URL=${dbUrl}`];
        })()),
        ...(process.env['LLM_API_KEY'] ? [`LLM_API_KEY=${process.env['LLM_API_KEY']}`] : []),
        ...(process.env['LLM_API_KEY_DEEPSEEK'] ? [`LLM_API_KEY_DEEPSEEK=${process.env['LLM_API_KEY_DEEPSEEK']}`] : []),
        ...(process.env['LLM_API_KEY_OPENROUTER'] ? [`LLM_API_KEY_OPENROUTER=${process.env['LLM_API_KEY_OPENROUTER']}`] : []),
        ...(process.env['LLM_API_KEY_ANTHROPIC'] ? [`LLM_API_KEY_ANTHROPIC=${process.env['LLM_API_KEY_ANTHROPIC']}`] : []),
        ...(process.env['LLM_API_KEY_OPENAI'] ? [`LLM_API_KEY_OPENAI=${process.env['LLM_API_KEY_OPENAI']}`] : []),
        ...(process.env['TAVILY_API_KEY'] ? [`TAVILY_API_KEY=${process.env['TAVILY_API_KEY']}`] : []),
        ...(process.env['SCRAPFLY_API_KEY'] ? [`SCRAPFLY_API_KEY=${process.env['SCRAPFLY_API_KEY']}`] : []),
        ...(process.env['CREDENTIAL_ENCRYPTION_KEY'] ? [`CREDENTIAL_ENCRYPTION_KEY=${process.env['CREDENTIAL_ENCRYPTION_KEY']}`] : []),
        ...(process.env['GMAIL_CLIENT_ID'] ? [`GMAIL_CLIENT_ID=${process.env['GMAIL_CLIENT_ID']}`] : []),
        ...(process.env['GMAIL_CLIENT_SECRET'] ? [`GMAIL_CLIENT_SECRET=${process.env['GMAIL_CLIENT_SECRET']}`] : []),
        ...(process.env['GMAIL_REDIRECT_URI'] ? [`GMAIL_REDIRECT_URI=${process.env['GMAIL_REDIRECT_URI']}`] : []),
        ...(process.env['GMAIL_DAILY_SEND_LIMIT'] ? [`GMAIL_DAILY_SEND_LIMIT=${process.env['GMAIL_DAILY_SEND_LIMIT']}`] : []),
        ...(process.env['USAGE_BILLING_RATE_CARD'] ? [`USAGE_BILLING_RATE_CARD=${process.env['USAGE_BILLING_RATE_CARD']}`] : []),
        ...(process.env['USAGE_BILLING_RUNTIME_WINDOW_MS'] ? [`USAGE_BILLING_RUNTIME_WINDOW_MS=${process.env['USAGE_BILLING_RUNTIME_WINDOW_MS']}`] : []),
        ...(this.externalSkillsConfigJson ? [`EXTERNAL_SKILLS_CONFIG_JSON=${this.externalSkillsConfigJson}`] : []),
        ...(this.browserPoolUrl ? [
          `BROWSER_POOL_URL=${this.browserPoolUrl}`,
          `AGENT_BROWSER_PROVIDER=browserless`,
          `BROWSERLESS_API_URL=${this.browserPoolUrl}`,
          `SANDBOX_ALLOWED_HOSTS=${this.browserPoolResolvedHost ?? new URL(this.browserPoolUrl).hostname}`,
        ] : []),
        ...(this.browserPoolApiKey ? [`BROWSERLESS_API_KEY=${this.browserPoolApiKey}`] : []),
      ];
    })();

    // Labels: overrides take full precedence; when absent, build default.
    const labels: Record<string, string> = overrides?.labels ?? {
      'herobids.role': 'agent',
      'herobids.agentId': spec.agentId,
      'herobids.sessionId': spec.sessionId,
    };

    const body = {
      Image: effectiveImage,
      name,
      Env: env,
      HostConfig: {
        NetworkMode: effectiveNetwork,
        Memory: effectiveMemoryMb * 1024 * 1024,
        CpuShares: effectiveCpuShares,
        Tmpfs: { '/tmp': `size=${effectiveTempStorageMb}m,noexec` },
        PidsLimit: effectiveMaxProcesses,
        CapAdd: ['NET_ADMIN', 'SYS_ADMIN'],
        RestartPolicy: { Name: 'no' },
      },
      Labels: labels,
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
   *
   * When the agent is already `crashed` we preserve that status — the crash was
   * already recorded and overwriting it with `stopped` would lose diagnostic state.
   *
   * There is an accepted TOCTOU risk: between the getAgent check and the
   * updateAgent write another process could mark the agent crashed, and we would
   * overwrite it with `stopped`. The window is extremely narrow (two consecutive
   * awaits) and a conditional repository update would add surface area
   * disproportionate to the risk.
   */
  async stop(agentId: string): Promise<void> {
    const name = `herobids-agent-${agentId}`;
    const currentAgent = await this.agentRepo.getAgent(agentId).catch(() => null);
    const preserveCrashed = currentAgent?.status === 'crashed';

    if (!preserveCrashed) {
      // Best-effort: the agent may have been deleted (e.g. Redis-triggered
      // cleanup after API DELETE). Proceed with Docker stop regardless.
      await this.agentRepo.updateAgent(agentId, { status: 'stopped' }).catch((err: unknown) => {
        logger.warn({ err, agentId }, 'Failed to update agent status before container stop — agent may have been deleted');
      });
    }

    try {
      // Docker stop timeout (?t=10): gives the agent runtime 10 seconds to drain
      // in-flight work and exit cleanly via SIGTERM before Docker sends SIGKILL.
      // The agent-side drain budget (SHUTDOWN_DRAIN_TIMEOUT_MS = 8 s) is set below
      // this ceiling so the process can exit on its own before the hard kill fires.
      const res = await this.dockerRequest('POST', `/containers/${name}/stop`, undefined, '?t=10');
      if (!res.ok && res.status !== 404 && res.status !== 304) {
        throw new Error(`Docker container stop failed for agent ${agentId}: HTTP ${res.status}`);
      }
      logger.info({ agentId }, 'Agent container stopped');
    } catch (error) {
      // Docker stop failed — the container may still be running. Revert status so
      // onContainerDie can fire a crash alert if the container dies on its own later.
      // We also throw so the caller (session-manager) does not proceed to mark the agent
      // stopped, which would overwrite the reverted 'crashed' status.
      logger.warn({ agentId, error }, 'Agent container stop failed — reverting status to crashed');
      await this.agentRepo.updateAgent(agentId, { status: 'crashed' }).catch((err: unknown) => {
        logger.error({ err, agentId }, 'Failed to revert agent status after stop failure');
      });
      throw error;
    }
  }

  /**
   * Stop an agent container by agentId only (no userId check).
   * Used during worker shutdown or reconciliation.
   */
  async stopById(agentId: string): Promise<void> {
    return this.stop(agentId);
  }

  /**
   * Gracefully stop a container by its raw Docker container ID.
   *
   * Unlike {@link stop}, this uses the container ID directly without the
   * `herobids-agent-{agentId}` naming convention. Used by the runtime
   * adapter when the caller has a Docker container ID from a prior launch.
   */
  async stopByContainerId(containerId: string): Promise<void> {
    const res = await this.dockerRequest('POST', `/containers/${containerId}/stop`, undefined, '?t=10');
    if (!res.ok && res.status !== 404 && res.status !== 304) {
      throw new Error(`Docker container stop failed for ${containerId}: HTTP ${res.status}`);
    }
    logger.info({ containerId }, 'Agent container stopped by container ID');
  }

  /**
   * Forcefully kill a container (SIGKILL, no grace period).
   *
   * Uses the Docker kill API (`POST /containers/{id}/kill`). This sends
   * SIGKILL immediately unlike {@link stopByContainerId} which sends
   * SIGTERM and waits for a graceful shutdown.
   */
  async killContainer(containerId: string): Promise<void> {
    const res = await this.dockerRequest('POST', `/containers/${containerId}/kill`);
    if (!res.ok && res.status !== 404) {
      throw new Error(`Docker container kill failed for ${containerId}: HTTP ${res.status}`);
    }
    logger.info({ containerId }, 'Agent container killed');
  }

  /**
   * Register a termination listener invoked on every container die detection.
   * Used by {@link DockerRuntimeAdapter} to bridge Docker events into the
   * port-level {@link RuntimePort.onTermination} contract.
   */
  addTerminationListener(fn: DockerTerminationListener): void {
    this.terminationListeners.push(fn);
  }

  /**
   * Reconcile: compare running containers against DB agents with status='active'.
   * - Containers running but agent not active → stop orphan
   * - Agents with status='active' but no container → restart
   *
   * @returns Structured reconciliation result with orphan/missing/running counts.
   */
  async reconcile(): Promise<RuntimeReconcileResult> {
    try {
      const containersRes = await this.dockerRequest('GET', '/containers/json?filters=%7B%22label%22%3A%5B%22herobids.role%3Dagent%22%5D%7D');
      if (!containersRes.ok) {
        logger.warn({ status: containersRes.status }, 'Failed to list agent containers during reconciliation');
        return { orphans: [], missing: [], runningCount: 0 };
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

      // A running container is also legitimate while its session is still starting/
      // launching, before the first heartbeat promotes the agent row to active.
      // Paused agents keep their runtime session alive as well, so session state is
      // part of the ownership signal for the orphan-stop path.
      const liveSessions = await this.agentRepo.getSessionsByStatuses(['starting', 'launching', 'running', 'unhealthy']);

      // Find containers running with no active DB row — they are orphans.
      // This happens when the agents table is truncated while containers keep running,
      // or when a container is launched outside the normal API provisioning flow.
      const activeAgentIds = new Set(activeAgents.map((a) => a.id));
      const liveSessionAgentIds = new Set(liveSessions.map((session) => session.agentId));
      const orphans: string[] = [];
      for (const agentId of runningAgentIds) {
        if (!activeAgentIds.has(agentId) && !liveSessionAgentIds.has(agentId)) {
          orphans.push(agentId);
          logger.warn({ agentId }, 'Reconcile: container running but no active agent in DB — stopping orphan');
          await this.stop(agentId).catch((err: unknown) => {
            logger.error({ err, agentId }, 'Reconcile: failed to stop orphan container');
          });
        }
      }

      // Agents with status='active' but no running container are missing.
      const missing = activeAgents
        .filter((a) => !runningAgentIds.has(a.id))
        .map((a) => a.id);

      logger.info({ runningCount: runningAgentIds.size, orphanCount: orphans.length, missingCount: missing.length }, 'Agent container reconciliation complete');
      return { orphans, missing, runningCount: runningAgentIds.size };
    } catch (err) {
      logger.error({ err }, 'Agent container reconciliation failed');
      return { orphans: [], missing: [], runningCount: 0 };
    }
  }

  /**
   * Called when a container die/kill event is received from Docker event stream.
    * Fallback detector for terminal exits. Updates agent/session status to crashed,
    * and skips duplicate handling when a prior session-ended path already recorded it.
   *
   * Crash taxonomy:
   *   - voluntary_stop: agent was already stopped before the die event
   *   - startup_failure: session never reached 'running' or 'unhealthy' state
   *   - runtime_crash: session had reached steady state (running/unhealthy) before dying
   */
  async onContainerDie(agentId: string, reason = 'container_exit', sessionId?: string): Promise<void> {
    // If the agent was already marked stopped, the container exited after a voluntary
    // stop() call — do not reclassify as crashed or fire a spurious safety alert.
    const currentAgent = await this.agentRepo.getAgent(agentId);
    if (currentAgent?.status === 'stopped') {
      logger.info({ agentId, sessionId, reason }, 'Agent container exited after voluntary stop — skipping crash handling');
      return;
    }

    const currentSession = await this.agentRepo.getCurrentSession(agentId);
    if (currentAgent?.status === 'crashed' && !currentSession) {
      logger.info({ agentId, sessionId, reason }, 'Agent crash already recorded — skipping duplicate crash handling');
      return;
    }
    if (sessionId && currentSession?.id !== sessionId) {
      logger.info(
        { agentId, sessionId, currentSessionId: currentSession?.id, reason },
        'Ignoring stale container exit — agent is owned by a different session',
      );
      return;
    }

    // Classify the crash type based on session state
    const sessionStatus = currentSession?.status;
    const isStartupFailure = sessionStatus === 'starting' || sessionStatus === 'launching';
    const crashType = isStartupFailure ? 'startup_failure' : 'runtime_crash';
    const alertMessage = isStartupFailure
      ? 'Agent failed during startup — container exited before reaching ready state'
      : 'Agent runtime stopped unexpectedly';

    logger.warn({ agentId, sessionId, reason, crashType }, `Agent container died — ${crashType}`);

    try {
      await this.agentRepo.retireActiveSessionsWithStatus(agentId, 'crashed', new Date());

      await this.agentRepo.updateAgent(agentId, { status: 'crashed' });

      await this.platformAlerts?.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, {
        agentId,
        message: alertMessage,
        detail: reason,
        crashType,
      });

      try {
        await this.onAgentCrashed?.(agentId, sessionId);
      } catch (err) {
        logger.error({ err, agentId }, 'onAgentCrashed callback failed');
      }

      // Notify port-level termination listeners (e.g. DockerRuntimeAdapter).
      for (const listener of this.terminationListeners) {
        try {
          listener(agentId, sessionId, reason);
        } catch (err) {
          logger.error({ err, agentId }, 'Termination listener failed');
        }
      }
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
          const isIdleTimeout =
            err instanceof Error && /body timeout/i.test(err.message);
          (isIdleTimeout ? logger.debug : logger.error).call(
            logger,
            { err },
            `Docker event stream ${isIdleTimeout ? 'idle timeout' : 'error'} — reconnecting in 5s`,
          );
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
          const sessionId = event.Actor?.Attributes?.['herobids.sessionId'];
          if (agentId) {
            void this.onContainerDie(agentId, 'docker_event', sessionId);
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

  /**
   * Inspect a single agent container by its Docker container ID.
   * Returns status information for the RuntimePort contract.
   */
  async inspectContainer(containerId: string): Promise<{
    agentId: string;
    status: 'running' | 'stopped' | 'crashed' | 'unknown';
    exitCode?: number;
    startedAt?: string;
    finishedAt?: string;
  }> {
    try {
      const res = await this.dockerRequest('GET', `/containers/${containerId}/json`);
      if (!res.ok) {
        return { agentId: containerId, status: 'unknown' };
      }
      const data = await res.json() as {
        State?: { Status?: string; ExitCode?: number; StartedAt?: string; FinishedAt?: string };
        Config?: { Labels?: Record<string, string> };
      };
      const state = data.State;
      const dockerStatus = state?.Status ?? '';
      let status: 'running' | 'stopped' | 'crashed' | 'unknown' = 'unknown';
      if (dockerStatus === 'running') status = 'running';
      else if (dockerStatus === 'exited' || dockerStatus === 'dead') {
        status = (state?.ExitCode ?? 0) !== 0 ? 'crashed' : 'stopped';
      }
      return {
        agentId: data.Config?.Labels?.['herobids.agentId'] ?? containerId,
        status,
        exitCode: state?.ExitCode,
        startedAt: state?.StartedAt,
        finishedAt: state?.FinishedAt,
      };
    } catch {
      return { agentId: containerId, status: 'unknown' };
    }
  }

  /**
   * List all agent containers managed by Docker.
   * Returns minimal status info for reconciliation.
   */
  async listAgentContainers(): Promise<Array<{
    containerId: string;
    agentId: string;
    status: 'running' | 'stopped' | 'crashed' | 'unknown';
    exitCode?: number;
    startedAt?: string;
    finishedAt?: string;
  }>> {
    try {
      const filters = encodeURIComponent(JSON.stringify({
        label: ['herobids.role=agent'],
      }));
      const res = await this.dockerRequest('GET', `/containers/json?all=true&filters=${filters}`);
      if (!res.ok) return [];
      const containers = await res.json() as Array<{
        Id: string;
        State: string;
        Status: string;
        Labels?: Record<string, string>;
      }>;
      return containers.map((c) => {
        const dockerState = c.State;
        let status: 'running' | 'stopped' | 'crashed' | 'unknown' = 'unknown';
        if (dockerState === 'running') status = 'running';
        else if (dockerState === 'exited' || dockerState === 'dead') {
          // Without ExitCode in the list endpoint, assume non-running = stopped
          // (crash classification is done by the event stream, not list)
          status = 'stopped';
        }
        return {
          containerId: c.Id,
          agentId: c.Labels?.['herobids.agentId'] ?? c.Id,
          status,
        };
      });
    } catch {
      return [];
    }
  }

  private async removeExistingContainer(name: string): Promise<void> {
    const res = await this.dockerRequest('GET', `/containers/${name}/json`);
    if (res.status === 404) return;
    if (!res.ok) return;

    const stopRes = await this.dockerRequest('POST', `/containers/${name}/stop`, undefined, '?t=20');
    if (stopRes.status === 404) return;
    if (!stopRes.ok && stopRes.status !== 304) {
      const text = await stopRes.text().catch(() => '');
      throw new Error(`Docker container stop failed before recreate for ${name}: ${stopRes.status} ${text.slice(0, 300)}`);
    }

    await this.dockerRequest('DELETE', `/containers/${name}`);
  }

  /**
   * Upload a tar archive to a path inside an agent container.
   *
   * Uses Docker's `PUT /containers/{name}/archive?path={containerPath}` API.
   * The body must be a raw tar archive (`application/x-tar`), not JSON.
   *
   * @param agentId - Agent identifier (container name derived from it).
   * @param containerPath - Absolute path inside the container to extract into.
   * @param tarBuffer - Raw tar archive bytes.
   */
  async putArchive(
    agentId: string,
    containerPath: string,
    tarBuffer: Buffer,
  ): Promise<void> {
    const name = `herobids-agent-${agentId}`;
    const url = new URL(`/containers/${encodeURIComponent(name)}/archive`, this.dockerApiBase);
    url.searchParams.set('path', containerPath);

    try {
      const res = await fetch(url.toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-tar' },
        body: new Uint8Array(tarBuffer),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const message = `Docker putArchive failed for ${name}: HTTP ${res.status} ${text.slice(0, 300)}`;
        logger.error({ agentId, containerPath, status: res.status, body: text.slice(0, 200) }, 'putArchive failed');
        throw new Error(message);
      }

      // Consume the response body to release the connection back to the pool
      await res.body?.cancel();

      logger.debug({ agentId, containerPath, tarSize: tarBuffer.length }, 'putArchive succeeded');
    } catch (cause) {
      // Re-throw HTTP errors we already threw above
      if (cause instanceof Error && cause.message.startsWith('Docker putArchive failed')) {
        throw cause;
      }

      // AbortSignal.timeout() produces a DOMException with name 'TimeoutError';
      // also check 'AbortError' for environments where the spec differs.
      if (cause instanceof DOMException && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) {
        const message = `Docker putArchive timed out for ${name} after 30s`;
        logger.error({ err: cause, agentId, containerPath }, 'putArchive timed out');
        throw new DockerPutArchiveTimeoutError(message);
      }

      const message = cause instanceof Error ? cause.message : String(cause);
      logger.error({ err: cause, agentId, containerPath }, 'putArchive network error');
      throw new Error(`Docker putArchive network error for ${name}: ${message}`);
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

/**
 * Thrown when a Docker putArchive operation times out (30s).
 * Used by callers to distinguish timeouts from other putArchive failures
 * without fragile string matching on error messages.
 */
export class DockerPutArchiveTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerPutArchiveTimeoutError';
  }
}
