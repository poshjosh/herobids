import type { Result, DomainError } from '../result.js';

export const CHAT_PROVIDERS = ['telegram', 'whatsapp', 'sms'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];
export type ChatAddressValue = string & { readonly __chatAddress: unique symbol };

export interface ChatAddress {
  provider: ChatProvider;
  address: ChatAddressValue;
}

export interface ChatOutboundBody {
  agentName?: string;
  subject?: string;
  body: string;
  messageClass?: string;
  replyRequested?: boolean;
}

export interface InboundChatMessage {
  provider: ChatProvider;
  from: ChatAddress;
  /** Provider chat kind, for example "private", "group" or "supergroup". Absent when the provider does not send it. */
  chatType?: string;
  text?: string;
  caption?: string;
  document?: { id: string; filename?: string; mimeType?: string; size?: number };
  inReplyToProviderMessageId?: string;
  providerMessageId?: string;
  receivedAt: Date;
}

export interface ChatSendResult {
  providerMessageId: string;
}

/**
 * A document to send to a chat. The body is held only for the send. A caption carries the message text
 * when the text fits the provider's caption limit; a caption that is too long fails with chat.caption_too_long.
 */
export interface ChatOutboundDocument {
  filename: string;
  mimeType: string;
  body: Buffer;
  caption?: ChatOutboundBody;
}

export interface ChatChannel {
  readonly provider: ChatProvider;
  readonly capabilities: {
    richText: boolean;
    maxBodyChars: number;
    nativeReplyThreading: boolean;
  };
  sendText(to: ChatAddress, body: ChatOutboundBody): Promise<Result<ChatSendResult, DomainError>>;
  /** Optional. Sends a file; providers that cannot carry files omit the method. */
  sendDocument?(to: ChatAddress, document: ChatOutboundDocument): Promise<Result<ChatSendResult, DomainError>>;
  /** Optional. Shows the provider's "typing" indicator; providers without it omit the method. */
  sendTyping?(to: ChatAddress): Promise<Result<void, DomainError>>;
}

export interface ChatWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface ChatInboundAdapter {
  readonly provider: ChatProvider;
  verify(request: ChatWebhookRequest): Result<void, DomainError>;
  parse(request: ChatWebhookRequest): Result<InboundChatMessage[], DomainError>;
}

export interface ChatChannelRegistry {
  get(provider: ChatProvider): ChatChannel | undefined;
}