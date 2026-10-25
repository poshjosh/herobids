import { err, ok, type DomainError, type Result } from '../result.js';
import type { ConversationService } from './conversation-service.js';
import { canPeerSend, type AgentOwnerLookup } from './peer-send.js';

/** Peer messaging error codes (A2A MVP). Dot-strings, returned to the sending agent and stored as the reason of a refused row. */
export const PEER_ERROR_CODES = {
  invalidMessage: 'peer.invalid_message',
  messageTooLong: 'peer.message_too_long',
  selfSend: 'peer.self_send',
  notAllowed: 'peer.not_allowed',
  paused: 'peer.paused',
  recipientNotRunning: 'peer.recipient_not_running',
  rateLimited: 'peer.rate_limited',
  unavailable: 'peer.unavailable',
  deliveryFailed: 'peer.delivery_failed',
} as const;

/** Agent statuses that cannot receive a message: the same states `POST /agents/:id/message` refuses. */
const NOT_RUNNING_STATUSES: readonly string[] = ['stopped', 'crashed'];

export interface PeerAgentRecord {
  userId: string;
  name: string;
  status: string;
}

export interface PeerAgentSummary {
  id: string;
  name: string;
  status: string;
}

/** Agent reads the send path needs. `AgentRepository` satisfies `getAgent`; `listAgentSummaries` is one narrow query. */
export interface PeerAgentDirectory extends AgentOwnerLookup {
  getAgent(agentId: string): Promise<PeerAgentRecord | null>;
  /** All agents of one user, in one query. */
  listAgentSummaries(userId: string): Promise<PeerAgentSummary[]>;
}

/** The owner's stop switch (DEC-43). Rejects when it cannot be read. A user that cannot be found reads as paused (fail closed). */
export interface PeerMessagingSettings {
  isPeerMessagingPaused(userId: string): Promise<boolean>;
}

/** Per-user rate limit (DEC-42). Takes one slot of the rolling one-minute window; false when the window is full. Rejects when it cannot decide. */
export interface PeerRateLimiter {
  tryConsume(userId: string): Promise<boolean>;
}

export interface PeerWake {
  messageId: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  body: string;
}

/** Puts the message on the recipient's outbound stream so it wakes. Rejects when it could not be published. */
export interface PeerWakePublisher {
  publish(wake: PeerWake): Promise<void>;
}

export interface PeerMessagingLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PeerMessagingConfig {
  /** Longest message body, in characters (`agentRuntime.peer.messageMaxChars`). */
  messageMaxChars: number;
}

export interface PeerMessagingDeps {
  agents: PeerAgentDirectory;
  settings: PeerMessagingSettings;
  limiter: PeerRateLimiter;
  conversations: Pick<ConversationService, 'recordPeerMessage' | 'markDelivery'>;
  wake: PeerWakePublisher;
  config: PeerMessagingConfig;
  log: PeerMessagingLog;
}

export interface PeerSendInput {
  fromAgentId: string;
  /** The recipient's id or exact name (case-insensitive). */
  recipient: string;
  body: string;
  /** Becomes the id of the thread row and of the envelope. A repeat of the same id sends nothing. */
  messageId: string;
}

export interface PeerSent {
  messageId: string;
  recipientAgentId: string;
  recipientName: string;
}

export type PeerSendError = DomainError & { context?: { peers?: PeerAgentSummary[]; maxChars?: number } };

function failure(code: string, message: string, context?: PeerSendError['context']): Result<never, PeerSendError> {
  return err(context ? { code, message, context } : { code, message });
}

/**
 * The agent id a recipient reference names: an exact id, else the one agent whose name matches. Null when the
 * reference names nothing, or a name that more than one agent carries.
 */
export function resolvePeerReference(agents: PeerAgentSummary[], reference: string): string | null {
  const wanted = reference.trim();
  if (wanted === '') return null;
  if (agents.some((agent) => agent.id === wanted)) return wanted;
  const byName = agents.filter((agent) => agent.name.trim().toLowerCase() === wanted.toLowerCase());
  return byName.length === 1 ? byName[0]!.id : null;
}

/**
 * Agent-to-agent messages between agents of one user (A2A MVP, DEC-40 to DEC-43).
 *
 * Checks run in a fixed order: input, recipient (self, then `canPeerSend`), stop switch, recipient running, rate limit,
 * then the row is recorded as sent by the agent and published to the recipient. Every failed check refuses the send,
 * including a failed read of the stop switch, the rate limiter or an agent (fail closed, I4). Once both agents are known
 * to be the user's, a refusal is also recorded in the thread as `refused` with its code, so the owner can see it.
 *
 * The message text is data. It is stored and forwarded unchanged and never interpreted here: a peer message
 * cannot submit, cancel or change an order or a limit (I5).
 */
export class PeerMessagingService {
  constructor(private readonly deps: PeerMessagingDeps) {}

  async send(input: PeerSendInput): Promise<Result<PeerSent, PeerSendError>> {
    const { agents, settings, limiter, conversations, wake, config } = this.deps;

    if (input.body.trim() === '') return failure(PEER_ERROR_CODES.invalidMessage, 'The message is empty.');
    if (input.body.length > config.messageMaxChars) {
      return failure(PEER_ERROR_CODES.messageTooLong, `The message is longer than ${config.messageMaxChars} characters.`, { maxChars: config.messageMaxChars });
    }

    const lookup = memoizeAgentLookup(agents);
    let sender: PeerAgentRecord | null;
    let peers: PeerAgentSummary[];
    try {
      sender = await lookup.getAgent(input.fromAgentId);
      peers = sender ? await agents.listAgentSummaries(sender.userId) : [];
    } catch (error) {
      return this.unavailable('agent_lookup', error);
    }
    if (!sender) return failure(PEER_ERROR_CODES.notAllowed, 'The sending agent is unknown.');
    const others = peers.filter((peer) => peer.id !== input.fromAgentId);

    // A reference that names none of the user's agents is still checked as an id, so another user's agent is refused by canPeerSend.
    const recipientId = resolvePeerReference(peers, input.recipient) ?? input.recipient.trim();
    if (recipientId === input.fromAgentId) {
      return failure(PEER_ERROR_CODES.selfSend, 'An agent cannot send a peer message to itself.', { peers: others });
    }

    let allowed: boolean;
    try {
      allowed = await canPeerSend(lookup, input.fromAgentId, recipientId);
    } catch (error) {
      return this.unavailable('can_peer_send', error);
    }
    if (!allowed) {
      return failure(PEER_ERROR_CODES.notAllowed, 'The recipient is not one of your agents. Use the id or exact name of one of them.', { peers: others });
    }
    // canPeerSend true for another agent means both were read, so the recipient is known and the user is the same.
    const recipient = await lookup.getAgent(recipientId);
    if (!recipient) return failure(PEER_ERROR_CODES.notAllowed, 'The recipient is unknown.', { peers: others });

    const userId = sender.userId;
    const refuse = (code: string, message: string) => this.refuse(input, userId, recipientId, code, message);

    try {
      if (await settings.isPeerMessagingPaused(userId)) {
        return refuse(PEER_ERROR_CODES.paused, 'The owner has paused agent-to-agent messaging.');
      }
    } catch (error) {
      this.deps.log.warn({ cause: causeName(error) }, 'Peer messaging pause switch could not be read; refusing the send');
      return refuse(PEER_ERROR_CODES.unavailable, 'Peer messaging is temporarily unavailable.');
    }

    // Checked before the rate limit so a message that cannot be delivered does not spend a slot.
    if (NOT_RUNNING_STATUSES.includes(recipient.status)) {
      return refuse(PEER_ERROR_CODES.recipientNotRunning, `${recipient.name} is not running, so it cannot receive messages.`);
    }

    try {
      if (!(await limiter.tryConsume(userId))) {
        return refuse(PEER_ERROR_CODES.rateLimited, 'Too many peer messages in the last minute. Wait before sending more.');
      }
    } catch (error) {
      this.deps.log.warn({ cause: causeName(error) }, 'Peer rate limiter failed; refusing the send');
      return refuse(PEER_ERROR_CODES.unavailable, 'Peer messaging is temporarily unavailable.');
    }

    const recorded = await conversations.recordPeerMessage({
      id: input.messageId,
      ownerUserId: userId,
      fromAgentId: input.fromAgentId,
      toAgentId: recipientId,
      body: input.body,
    });
    if (!recorded.ok) {
      this.deps.log.warn({ code: recorded.error.code }, 'Peer message could not be recorded; not publishing');
      return failure(PEER_ERROR_CODES.unavailable, 'Peer messaging is temporarily unavailable.');
    }
    const sent: PeerSent = { messageId: input.messageId, recipientAgentId: recipientId, recipientName: recipient.name };
    // A repeat of an id already recorded is a retry: it has been (or is being) published, so nothing more is sent.
    if (!recorded.data.created) return ok(sent);

    try {
      await wake.publish({
        messageId: input.messageId,
        fromAgentId: input.fromAgentId,
        fromAgentName: sender.name,
        toAgentId: recipientId,
        body: input.body,
      });
    } catch (error) {
      this.deps.log.warn({ cause: causeName(error) }, 'Peer message could not be published to the recipient');
      await this.mark(input.messageId, 'failed', 'publish_failed');
      return failure(PEER_ERROR_CODES.deliveryFailed, 'The message could not be delivered. Try again shortly.');
    }
    await this.mark(input.messageId, 'sent');
    return ok(sent);
  }

  /** Records the refusal in the thread (best effort: a refusal stands even when it cannot be recorded) and returns it. */
  private async refuse(
    input: PeerSendInput,
    userId: string,
    recipientId: string,
    code: string,
    message: string,
  ): Promise<Result<never, PeerSendError>> {
    const recorded = await this.deps.conversations.recordPeerMessage({
      id: input.messageId,
      ownerUserId: userId,
      fromAgentId: input.fromAgentId,
      toAgentId: recipientId,
      body: input.body,
      deliveryStatus: 'refused',
      deliveryDetail: code,
    });
    if (!recorded.ok) {
      this.deps.log.warn({ code: recorded.error.code, refusal: code }, 'Peer refusal could not be recorded in the thread');
    }
    return failure(code, message);
  }

  private async mark(messageId: string, status: 'sent' | 'failed', detail?: string): Promise<void> {
    const marked = await this.deps.conversations.markDelivery({ messageId, status, ...(detail ? { detail } : {}) });
    if (!marked.ok) {
      this.deps.log.warn({ code: marked.error.code, status }, 'Peer message delivery status could not be recorded');
    }
  }

  private unavailable(step: string, error: unknown): Result<never, PeerSendError> {
    this.deps.log.warn({ step, cause: causeName(error) }, 'Peer send refused: a lookup failed');
    return failure(PEER_ERROR_CODES.unavailable, 'Peer messaging is temporarily unavailable.');
  }
}

function causeName(error: unknown): string {
  return error instanceof Error ? error.name : 'NonError';
}

/** Reads each agent at most once during one send. */
function memoizeAgentLookup(agents: PeerAgentDirectory): PeerAgentDirectory {
  const cache = new Map<string, PeerAgentRecord | null>();
  return {
    listAgentSummaries: (userId) => agents.listAgentSummaries(userId),
    async getAgent(agentId) {
      if (cache.has(agentId)) return cache.get(agentId) ?? null;
      const record = await agents.getAgent(agentId);
      cache.set(agentId, record);
      return record;
    },
  };
}
