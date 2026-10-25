import { z } from 'zod';
import { ok, err } from '@herobids/domain';
import type {
  AgentAllowance,
  AgentPlatformError,
  AgentPlatformPort,
  ChildAgentCreated,
  ChildAgentStatus,
  CreateChildAgentInput,
  Result,
} from '@herobids/domain';

/**
 * Typed client the agent container uses to call the platform API as itself (001-plan §6-§8).
 * Public methods never throw. The API key is sent only in the Authorization header and is
 * never logged or copied into an error.
 */

export interface AgentPlatformLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface AgentPlatformClientOptions {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  timeoutMs: number;
  logger?: AgentPlatformLogger;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const AllowanceResponseSchema = z.object({
  id: z.string().min(1),
  childAgentLimit: z.number().int().min(0),
  childCount: z.number().int().min(0),
  remainingChildAllowance: z.number().int().min(0),
});

const CreatedResponseSchema = z.object({
  id: z.string().min(1),
  depth: z.number().int().min(0),
});

const ChildStatusResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: z.string(),
  depth: z.number().int().min(0),
  runtimeStatus: z.string().nullable(),
  childAgentLimit: z.number().int().min(0),
});

const StatusResponseSchema = z.object({ status: z.string() });
const DeliveredResponseSchema = z.object({ delivered: z.boolean() });

/** The API's own namespaced error code, read from the body. Only this field is ever read. */
const ApiErrorBodySchema = z.object({ error: z.string().max(100) });
const NAMESPACED_CODE = /^agent\.[a-z_.]+$/;

const STATUS_ERROR_CODES: ReadonlyArray<{ min: number; max: number; code: string; retryable: boolean }> = [
  { min: 400, max: 400, code: 'agent.platform.invalid_request', retryable: false },
  { min: 401, max: 401, code: 'agent.platform.unauthorized', retryable: false },
  { min: 403, max: 403, code: 'agent.platform.forbidden', retryable: false },
  { min: 404, max: 404, code: 'agent.platform.not_found', retryable: false },
  { min: 409, max: 409, code: 'agent.platform.conflict', retryable: false },
  { min: 429, max: 429, code: 'agent.platform.rate_limited', retryable: true },
  { min: 500, max: 599, code: 'agent.platform.unavailable', retryable: true },
];

function platformError(code: string, message: string, retryable: boolean): AgentPlatformError {
  return { code, message, retryable };
}

function mapStatusError(status: number, apiCode: string | null): AgentPlatformError {
  const retryable = status === 429 || status >= 500;
  // A namespaced code from the API is passed through on 4xx; it is one of a fixed set the server emits.
  if (apiCode && status >= 400 && status < 500) {
    return platformError(apiCode, `The platform refused the request (HTTP ${status}).`, retryable);
  }
  const match = STATUS_ERROR_CODES.find((entry) => status >= entry.min && status <= entry.max);
  const code = match?.code ?? 'agent.platform.rejected';
  return platformError(code, `The platform returned HTTP ${status}.`, match?.retryable ?? false);
}

export function createAgentPlatformClient(options: AgentPlatformClientOptions): AgentPlatformPort {
  const { baseUrl, apiKey, agentId, timeoutMs, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const agentPath = `/agents/${encodeURIComponent(agentId)}`;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: Record<string, unknown>,
  ): Promise<Result<T, AgentPlatformError>> {
    // One deadline covers the request and the body read, so a stalled response cannot hang the tool.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      const failure = controller.signal.aborted
        ? platformError('agent.platform.timeout', `The platform did not answer within ${timeoutMs} ms.`, true)
        : platformError('agent.platform.unreachable', 'The platform could not be reached.', true);
      logger?.warn({ code: failure.code, method, path }, 'Agent platform call failed');
      return err(failure);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const apiCode = extractApiCode(text);
      const failure = mapStatusError(response.status, apiCode);
      logger?.warn({ code: failure.code, status: response.status, method, path }, 'Agent platform call rejected');
      return err(failure);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return err(platformError('agent.platform.invalid_response', 'The platform returned a non-JSON body.', false));
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return err(platformError('agent.platform.invalid_response', 'The platform response did not match the expected shape.', false));
    }
    return ok(parsed.data);
  }

  return {
    async getOwnAllowance(): Promise<Result<AgentAllowance, AgentPlatformError>> {
      return request('GET', `${agentPath}/child-allowance`, AllowanceResponseSchema);
    },

    async createChildAgent(input: CreateChildAgentInput): Promise<Result<ChildAgentCreated, AgentPlatformError>> {
      // Only the four allowed fields are forwarded; the API refuses anything else.
      const body: Record<string, unknown> = { name: input.name, prompt: input.prompt };
      if (input.skillIds) body['skillIds'] = input.skillIds;
      if (input.connectionIds) body['connectionIds'] = input.connectionIds;
      return request('POST', '/agents', CreatedResponseSchema, body);
    },

    async getChildStatus(childId: string): Promise<Result<ChildAgentStatus, AgentPlatformError>> {
      return request('GET', `/agents/${encodeURIComponent(childId)}/status`, ChildStatusResponseSchema);
    },

    async pauseChildAgent(childId: string, reason?: string): Promise<Result<{ status: string }, AgentPlatformError>> {
      const body = reason ? { reason } : {};
      return request('POST', `/agents/${encodeURIComponent(childId)}/pause`, StatusResponseSchema, body);
    },

    async stopChildAgent(childId: string): Promise<Result<{ status: string }, AgentPlatformError>> {
      return request('POST', `/agents/${encodeURIComponent(childId)}/stop`, StatusResponseSchema);
    },

    async messageChildAgent(childId: string, message: string): Promise<Result<{ delivered: boolean }, AgentPlatformError>> {
      return request('POST', `/agents/${encodeURIComponent(childId)}/message`, DeliveredResponseSchema, { message });
    },
  };
}

function extractApiCode(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = ApiErrorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success && NAMESPACED_CODE.test(parsed.data.error)) return parsed.data.error;
    return null;
  } catch {
    return null;
  }
}

const AgentPlatformEnvSchema = z.object({
  API_BASE_URL: z.string().url(),
  AGENT_API_KEY: z.string().min(1),
  AGENT_ID: z.string().min(1),
  AGENT_PLATFORM_TIMEOUT_MS: z.coerce.number().int().min(100),
});

/**
 * Build the client from the container environment. Returns undefined when the platform
 * config is absent or invalid, so the create and creator tools stay hidden. Logs only the
 * names of the missing or invalid variables, never their values.
 */
export function createAgentPlatformClientFromEnv(
  env: Record<string, string | undefined>,
  logger?: AgentPlatformLogger,
): AgentPlatformPort | undefined {
  const parsed = AgentPlatformEnvSchema.safeParse(env);
  if (!parsed.success) {
    logger?.warn(
      { invalid: parsed.error.issues.map((issue) => issue.path.join('.')) },
      'Agent platform tools disabled: platform configuration is missing or invalid',
    );
    return undefined;
  }
  return createAgentPlatformClient({
    baseUrl: parsed.data.API_BASE_URL,
    apiKey: parsed.data.AGENT_API_KEY,
    agentId: parsed.data.AGENT_ID,
    timeoutMs: parsed.data.AGENT_PLATFORM_TIMEOUT_MS,
    logger,
  });
}
