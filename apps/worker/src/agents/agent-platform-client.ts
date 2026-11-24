import { z } from 'zod';
import { ok, err } from '@herobids/domain';
import type {
  AgentAllowance,
  AgentDocumentSummary,
  AgentDocumentTextPage,
  AgentPlatformError,
  AgentPlatformPort,
  ChildAgentCreated,
  ChildAgentStatus,
  ChildAgentSummary,
  CreateChildAgentInput,
  OwnerConnectionSummary,
  PeerMessagingState,
  PeerMessagingStatePort,
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
  // Absent from an older API: the setting then reads as off, which is the safe default.
  grantAnySkillToChildren: z.boolean().default(false),
  grantAnyConnectionToChildren: z.boolean().default(false),
});

const OwnerConnectionsResponseSchema = z.object({
  connections: z.array(z.object({
    id: z.string().min(1),
    provider: z.string(),
    status: z.string(),
    label: z.string(),
  })),
});

const StartRefusalSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().max(500),
  at: z.string(),
});

const CreatedResponseSchema = z.object({
  id: z.string().min(1),
  depth: z.number().int().min(0),
  status: z.string(),
  duplicate: z.boolean(),
  started: z.boolean(),
  startError: z.object({ code: z.string().min(1).max(100), message: z.string().max(500) }).nullable(),
});

const ChildStatusResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: z.string(),
  depth: z.number().int().min(0),
  runtimeStatus: z.string().nullable(),
  childAgentLimit: z.number().int().min(0),
  lastStartRefusal: StartRefusalSchema.nullable(),
});

const ChildrenResponseSchema = z.object({
  children: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    status: z.string(),
    depth: z.number().int().min(0),
    childCount: z.number().int().min(0),
    lastStartRefusal: StartRefusalSchema.nullable(),
  })),
});
const DeletedResponseSchema = z.object({ deleted: z.literal(true), stopped: z.boolean() });
const PeerMessagingStateResponseSchema = z.object({ paused: z.boolean() });
const StatusResponseSchema = z.object({ status: z.string() });
const DeliveredResponseSchema = z.object({ delivered: z.boolean() });
const DocumentTextResponseSchema = z.object({
  documentId: z.string().min(1),
  filename: z.string(),
  text: z.string(),
  offset: z.number().int().min(0),
  nextOffset: z.number().int().min(0).nullable(),
  totalChars: z.number().int().min(0),
});
const DocumentListResponseSchema = z.object({
  documents: z.array(z.object({
    documentId: z.string().min(1),
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().min(0),
    lifecycleState: z.string(),
    sourceDocumentId: z.string().nullable(),
    source: z.string(),
    extractionStatus: z.string(),
  })),
});

/**
 * The refusal body the API sends on a 4xx: `error` (a namespaced code, or a plain one such as
 * `validation_error`), `message`, and optional `params` (e.g. kind, missing) or `details` (Zod issues).
 * Only these fields are read; anything else in the body is dropped.
 */
const ApiErrorBodySchema = z.object({
  error: z.string().max(100),
  // Each optional field is tolerant: a malformed one is dropped, never the namespaced `error` code.
  message: z.string().optional().catch(undefined),
  params: z.record(z.string(), z.unknown()).optional().catch(undefined),
  details: z.array(z.unknown()).optional().catch(undefined),
});
type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
const NAMESPACED_CODE = /^agent\.[a-z_.]+$/;
const MAX_REFUSAL_MESSAGE_CHARS = 500;
const MAX_REFUSAL_DETAILS = 10;
const MAX_REFUSAL_CONTEXT_CHARS = 2_000;
const MAX_REFUSAL_PARAM_ITEMS = 20;

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

function mapStatusError(status: number, body: ApiErrorBody | null): AgentPlatformError {
  const retryable = status === 429 || status >= 500;
  const isRefusal = status >= 400 && status < 500;
  const apiCode = body && NAMESPACED_CODE.test(body.error) ? body.error : null;
  const match = STATUS_ERROR_CODES.find((entry) => status >= entry.min && status <= entry.max);
  if (isRefusal) {
    // A namespaced code from the API is passed through; it is one of a fixed set the server emits.
    const code = apiCode ?? match?.code ?? 'agent.platform.rejected';
    const detail = body?.message?.trim().slice(0, MAX_REFUSAL_MESSAGE_CHARS);
    const message = `The platform refused the request (HTTP ${status})${detail ? `: ${detail}` : '.'}`;
    const context = body ? refusalContext(status, body) : undefined;
    return { ...platformError(code, message, retryable), ...(context ? { context } : {}) };
  }
  return platformError(match?.code ?? 'agent.platform.rejected', `The platform returned HTTP ${status}.`, match?.retryable ?? false);
}

/** The structured part of a refusal, bounded so a large body cannot flood the agent's context. */
function refusalContext(status: number, body: ApiErrorBody): Record<string, unknown> | undefined {
  const context: Record<string, unknown> = { status, apiError: body.error };
  if (body.params) context['params'] = body.params;
  if (body.details) context['details'] = body.details.slice(0, MAX_REFUSAL_DETAILS);
  if (JSON.stringify(context).length <= MAX_REFUSAL_CONTEXT_CHARS) return context;
  const capped: Record<string, unknown> = { status, apiError: body.error, truncated: true };
  if (body.params) capped['params'] = capParams(body.params);
  if (JSON.stringify(capped).length <= MAX_REFUSAL_CONTEXT_CHARS) return capped;
  return { status, apiError: body.error, truncated: true };
}

/** Keeps scalar params (e.g. kind) and the first N items of each array, with the full count alongside. */
function capParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value) && value.length > MAX_REFUSAL_PARAM_ITEMS) {
      result[key] = value.slice(0, MAX_REFUSAL_PARAM_ITEMS);
      result[`${key}Count`] = value.length;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Everything the container may ask of the platform as itself. */
export type AgentPlatformClient = AgentPlatformPort & PeerMessagingStatePort;

export function createAgentPlatformClient(options: AgentPlatformClientOptions): AgentPlatformClient {
  const { baseUrl, apiKey, agentId, timeoutMs, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const agentPath = `/agents/${encodeURIComponent(agentId)}`;

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
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
      const failure = mapStatusError(response.status, extractApiErrorBody(text));
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

    async listOwnerConnections(): Promise<Result<OwnerConnectionSummary[], AgentPlatformError>> {
      const listed = await request('GET', `${agentPath}/owner-connections`, OwnerConnectionsResponseSchema);
      if (!listed.ok) return listed;
      return ok(listed.data.connections);
    },

    async readAgentDocument(documentId: string, offset: number): Promise<Result<AgentDocumentTextPage, AgentPlatformError>> {
      return request('GET', `${agentPath}/documents/${encodeURIComponent(documentId)}/text?offset=${offset}`, DocumentTextResponseSchema);
    },

    async listAgentDocuments(): Promise<Result<AgentDocumentSummary[], AgentPlatformError>> {
      const listed = await request('GET', `${agentPath}/documents/available`, DocumentListResponseSchema);
      if (!listed.ok) return listed;
      return ok(listed.data.documents);
    },

    async getPeerMessagingState(): Promise<Result<PeerMessagingState, AgentPlatformError>> {
      return request('GET', `${agentPath}/peer-messaging`, PeerMessagingStateResponseSchema);
    },

    async createChildAgent(input: CreateChildAgentInput): Promise<Result<ChildAgentCreated, AgentPlatformError>> {
      // Only the allowed fields are forwarded; the API refuses anything else.
      const body: Record<string, unknown> = { name: input.name, prompt: input.prompt, start: input.start };
      if (input.skillIds) body['skillIds'] = input.skillIds;
      if (input.connectionIds) body['connectionIds'] = input.connectionIds;
      if (input.executionDefaults) body['executionDefaults'] = input.executionDefaults;
      return request('POST', '/agents', CreatedResponseSchema, body);
    },

    async listChildAgents(): Promise<Result<ChildAgentSummary[], AgentPlatformError>> {
      const listed = await request('GET', `${agentPath}/children`, ChildrenResponseSchema);
      if (!listed.ok) return listed;
      return ok(listed.data.children);
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

    async messageChildAgent(childId: string, message: string, documentIds?: string[]): Promise<Result<{ delivered: boolean }, AgentPlatformError>> {
      return request('POST', `/agents/${encodeURIComponent(childId)}/message`, DeliveredResponseSchema, {
        message,
        ...(documentIds?.length ? { documentIds } : {}),
      });
    },

    async deleteChildAgent(childId: string, stopFirst: boolean): Promise<Result<{ deleted: true; stopped: boolean }, AgentPlatformError>> {
      // Sent explicitly so the platform never has to guess the caller's intent.
      return request('DELETE', `${agentPath}/children/${encodeURIComponent(childId)}?stopFirst=${stopFirst ? 'true' : 'false'}`, DeletedResponseSchema);
    },
  };
}

function extractApiErrorBody(text: string): ApiErrorBody | null {
  if (!text) return null;
  try {
    const parsed = ApiErrorBodySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
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
): AgentPlatformClient | undefined {
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
