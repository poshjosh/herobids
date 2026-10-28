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
  /** Start the child after it is created. The tool defaults this to true. */
  start: boolean;
}

/** Why a child was created but not started. Only a namespaced code and a fixed message leave the platform. */
export interface ChildStartError {
  code: string;
  message: string;
}

/** Why a child's last launch was refused (billing). Only a namespaced code and a fixed message leave the platform. */
export interface ChildStartRefusal {
  code: string;
  message: string;
  at: string;
}

export interface ChildAgentCreated {
  id: string;
  depth: number;
  status: string;
  /** True when a same-name child was created within the duplicate window; that child is returned and not started again. */
  duplicate: boolean;
  started: boolean;
  startError: ChildStartError | null;
}

export interface ChildAgentStatus {
  id: string;
  name: string;
  status: string;
  depth: number;
  runtimeStatus: string | null;
  childAgentLimit: number;
  lastStartRefusal: ChildStartRefusal | null;
}

/** One direct child of the calling agent, as the platform lists it. */
export interface ChildAgentSummary {
  id: string;
  name: string;
  status: string;
  depth: number;
  childCount: number;
  lastStartRefusal: ChildStartRefusal | null;
}

/** One page of a document's text that the user sent in chat, read through the platform. */
export interface AgentDocumentTextPage {
  documentId: string;
  filename: string;
  text: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
}

/** Platform API operations an agent container may perform as itself (see 001-plan §6-§8). */
export interface AgentPlatformPort {
  getOwnAllowance(): Promise<Result<AgentAllowance, AgentPlatformError>>;
  readAgentDocument(documentId: string, offset: number): Promise<Result<AgentDocumentTextPage, AgentPlatformError>>;
  createChildAgent(input: CreateChildAgentInput): Promise<Result<ChildAgentCreated, AgentPlatformError>>;
  listChildAgents(): Promise<Result<ChildAgentSummary[], AgentPlatformError>>;
  getChildStatus(agentId: string): Promise<Result<ChildAgentStatus, AgentPlatformError>>;
  pauseChildAgent(agentId: string, reason?: string): Promise<Result<{ status: string }, AgentPlatformError>>;
  stopChildAgent(agentId: string): Promise<Result<{ status: string }, AgentPlatformError>>;
  messageChildAgent(agentId: string, message: string): Promise<Result<{ delivered: boolean }, AgentPlatformError>>;
  deleteChildAgent(agentId: string, stopFirst: boolean): Promise<Result<{ deleted: true; stopped: boolean }, AgentPlatformError>>;
}

/** The owner's peer-messaging stop switch (DEC-43, DEC-56), as the receiving agent reads it before it accepts a peer message. */
export interface PeerMessagingState {
  paused: boolean;
}

export interface PeerMessagingStatePort {
  getPeerMessagingState(): Promise<Result<PeerMessagingState, AgentPlatformError>>;
}
