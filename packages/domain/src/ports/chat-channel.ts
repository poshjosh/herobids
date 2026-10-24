import type { Result, DomainError } from '../result.js';

export type ChatProvider = 'telegram' | 'whatsapp' | 'sms';
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

export interface ChatChannel {
  readonly provider: ChatProvider;
  readonly capabilities: {
    richText: boolean;
    maxBodyChars: number;
    nativeReplyThreading: boolean;
  };
  sendText(to: ChatAddress, body: ChatOutboundBody): Promise<Result<ChatSendResult, DomainError>>;
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