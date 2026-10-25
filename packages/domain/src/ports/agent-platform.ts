import type { Result, DomainError } from '../result.js';

/**
 * A failed platform API call from inside an agent container. `code` is a namespaced
 * dot-string (e.g. `agent.platform.timeout`) and never carries response bodies.
 */
export interface AgentPlatformError extends DomainError {
  retryable: boolean;
}

/** The calling agent's own child allowance, as the platform reports it. */
export interface AgentAllowance {
  id: string;
  childAgentLimit: number;
  childCount: number;
  remainingChildAllowance: number;
}

export interface CreateChildAgentInput {
  name: string;
  prompt: string;
  skillIds?: string[];
  connectionIds?: string[];
}

export interface ChildAgentCreated {
  id: string;
  depth: number;
}

export interface ChildAgentStatus {
  id: string;
  name: string;
  status: string;
  depth: number;
  runtimeStatus: string | null;
  childAgentLimit: number;
}

/** Platform API operations an agent container may perform as itself (see 001-plan §6-§8). */
export interface AgentPlatformPort {
  getOwnAllowance(): Promise<Result<AgentAllowance, AgentPlatformError>>;
  createChildAgent(input: CreateChildAgentInput): Promise<Result<ChildAgentCreated, AgentPlatformError>>;
  getChildStatus(agentId: string): Promise<Result<ChildAgentStatus, AgentPlatformError>>;
  pauseChildAgent(agentId: string, reason?: string): Promise<Result<{ status: string }, AgentPlatformError>>;
  stopChildAgent(agentId: string): Promise<Result<{ status: string }, AgentPlatformError>>;
  messageChildAgent(agentId: string, message: string): Promise<Result<{ delivered: boolean }, AgentPlatformError>>;
}
