import type { Result, DomainError } from '../result.js';

export type OutboundHumanRecipientKind = 'telegram' | 'email';
export type OutboundDeliveryStatus = 'sent' | 'failed' | 'skipped';

/** A sender's document, read for a human recipient. The bytes are held only for the duration of the send. */
export interface OutboundFile {
  auditId: string;
  documentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  body: Buffer;
}

/** A copy of a sender's document in the recipient agent's store. */
export interface OutboundCopy {
  auditId: string;
  sourceDocumentId: string;
  copiedDocumentId: string;
  filename: string;
}

export interface StagedOutboundCopies {
  copies: OutboundCopy[];
  /** One document notice per copy, so the recipient can read each copy with read_agent_document. Appended to the message. */
  notice: string;
  /** Deletes the copies and marks their audit rows failed. Used when the message is not recorded or not published. */
  rollback(): Promise<void>;
}

export interface PrepareOutboundForHumanInput {
  /** The message's identity in the audit trail (agent_messages.message_id, or a generated id for email). */
  outboundMessageId: string;
  senderAgentId: string;
  recipientKind: OutboundHumanRecipientKind;
  documentIds: string[];
}

export interface StageOutboundForAgentInput {
  outboundMessageId: string;
  senderAgentId: string;
  recipientAgentId: string;
  documentIds: string[];
}

/**
 * Resolves documents a send attaches. Every result is a Result: a failure leaves no copy and no pending audit row
 * behind, so the caller can fail the send without cleanup of its own.
 */
export interface OutboundAttachmentPort {
  prepareForHuman(input: PrepareOutboundForHumanInput): Promise<Result<OutboundFile[], DomainError>>;
  stageForAgent(input: StageOutboundForAgentInput): Promise<Result<StagedOutboundCopies, DomainError>>;
  markDelivery(auditId: string, status: OutboundDeliveryStatus, detail?: { deliveryRef?: string; deliveryError?: string }): Promise<Result<void, DomainError>>;
}
