import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { messagingTools } from './messaging.js';

const sendMessageTool = messagingTools.find((t) => t.name === 'send_message')!;
const publishArtifactTool = messagingTools.find((t) => t.name === 'publish_artifact')!;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('send_message', () => {
  // ── Schema shape ───────────────────────────────────────────────────────

  it('has the correct parameters schema keys (subject, body, messageClass, contextRef)', () => {
    const schema = sendMessageTool.parametersSchema;
    // Access shape from ZodObject
    const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
    const keys = Object.keys(shape);
    expect(keys).toContain('body');
    expect(keys).toContain('subject');
    expect(keys).toContain('messageClass');
    expect(keys).toContain('contextRef');
    expect(keys).toHaveLength(4);
  });

  it('does NOT include emailDelivery in the schema definition', () => {
    const schema = sendMessageTool.parametersSchema;
    const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
    const keys = Object.keys(shape);
    expect(keys).not.toContain('emailDelivery');
  });

  it('accepts valid params (body only, the only required field)', async () => {
    const ctx = makeCtx();

    const result = await sendMessageTool.execute({ body: 'Hello user!' }, ctx);

    expect(result.success).toBe(true);
    expect(ctx.publishToInbound).toHaveBeenCalledTimes(1);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });

  it('accepts valid params with all optional fields', async () => {
    const ctx = makeCtx();

    const result = await sendMessageTool.execute(
      {
        body: 'Important update',
        subject: 'Status report',
        messageClass: 'alert',
        contextRef: 'ctx-123',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(ctx.publishToInbound).toHaveBeenCalledTimes(1);
  });

  it('rejects empty body', async () => {
    const ctx = makeCtx();

    const result = await sendMessageTool.execute({ body: '' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid send_message parameters');
  });

  it('rejects body exceeding 2000 characters', async () => {
    const ctx = makeCtx();

    const result = await sendMessageTool.execute(
      { body: 'x'.repeat(2001) },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid send_message parameters');
  });

  it('rejects invalid messageClass value', async () => {
    const ctx = makeCtx();

    const result = await sendMessageTool.execute(
      { body: 'Hello', messageClass: 'urgent' }, // not in enum
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid send_message parameters');
  });

  // ── Silently strips unknown keys (Zod default behavior) ────────────────

  it('silently strips unknown keys like emailDelivery (Zod strips, does not reject)', async () => {
    const ctx = makeCtx();

    // Zod .object() silently strips unknown keys, so emailDelivery is ignored
    // and the call succeeds with just body.
    const result = await sendMessageTool.execute(
      { body: 'Hello', emailDelivery: 'if_allowed' } as Record<string, unknown>,
      ctx,
    );

    // The call succeeds because emailDelivery is stripped by Zod, and body is valid
    expect(result.success).toBe(true);
    expect(ctx.publishToInbound).toHaveBeenCalledTimes(1);
  });

  it('description clearly states send_email is for external email (not send_message)', () => {
    expect(sendMessageTool.description).toContain('send_email');
    expect(sendMessageTool.description).toContain('external recipients');
    expect(sendMessageTool.description).not.toContain('emailDelivery');
  });
});

describe('publish_artifact', () => {
  it('publishes an artifact and returns an artifactId', async () => {
    const ctx = makeCtx();

    const result = await publishArtifactTool.execute(
      { artifactType: 'chart', contentType: 'image/png', summary: 'BTC chart' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.artifactId).toBeDefined();
    expect(typeof data.artifactId).toBe('string');
    expect(ctx.publishToInbound).toHaveBeenCalledTimes(1);
  });
});
