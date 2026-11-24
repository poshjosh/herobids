import { describe, expect, it, vi } from 'vitest';
import type { OutboundDeliveryStatus } from '@herobids/domain';
import { ok } from '@herobids/domain';
import type { OutboundAttachmentResolver } from './outbound-attachment-resolver.js';
import { OutboundAttachmentService, type OutboundAttachmentAuditStore } from './outbound-attachment-service.js';

type MarkCall = { id: string; status: OutboundDeliveryStatus; detail?: { deliveryRef?: string; deliveryError?: string } };

describe('OutboundAttachmentService.prepareForHuman', () => {
  it('returns an error and settles every inserted audit row failed when marking an unreadable row throws', async () => {
    const resolver = {
      resolveForHuman: vi.fn(async () => ok({
        readable: [{ documentId: 'doc-1', filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1, body: Buffer.from('x') }],
        unreadable: [{ documentId: 'doc-2', code: 'outbound_attachment.read_failed' }],
      })),
    } as unknown as OutboundAttachmentResolver;
    const calls: MarkCall[] = [];
    const audit: OutboundAttachmentAuditStore = {
      recordPending: vi.fn(async () => ['audit-1', 'audit-2']),
      markDelivery: vi.fn(async (id: string, status: OutboundDeliveryStatus, detail?: MarkCall['detail']) => {
        calls.push({ id, status, detail });
        if (detail?.deliveryError === 'outbound_attachment.read_failed') throw new Error('db_down');
      }),
    };
    const service = new OutboundAttachmentService(resolver, audit);

    const result = await service.prepareForHuman({
      outboundMessageId: 'msg-1',
      senderAgentId: 'agent-1',
      recipientKind: 'telegram',
      documentIds: ['doc-1', 'doc-2'],
    });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'outbound_attachment.audit_failed' }) });
    const lastCallFor = (id: string) => calls.filter((call) => call.id === id).at(-1);
    expect(lastCallFor('audit-1')).toEqual({ id: 'audit-1', status: 'failed', detail: { deliveryError: 'audit_failed' } });
    expect(lastCallFor('audit-2')).toEqual({ id: 'audit-2', status: 'failed', detail: { deliveryError: 'audit_failed' } });
  });
});
