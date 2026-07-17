import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- send_message ---

const SendMessageParamsSchema = z.object({
  body: z.string().min(1).max(2000),
  subject: z.string().max(200).optional(),
  messageClass: z.enum(['routine', 'alert', 'reminder']).optional(),
  contextRef: z.string().max(200).optional(),
});

const sendMessageTool: AgentTool = {
  name: 'send_message',
  description: 'Send a message to the user via the platform messaging system. Use for communicating with the user — important updates, alerts, reminders, or status reports. Body is limited to 2000 characters. For sending email to external recipients, use send_email instead.',
  parametersSchema: SendMessageParamsSchema,
  parameters: convertZodToJsonSchema(SendMessageParamsSchema),
  category: 'write-messaging',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = SendMessageParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: `Invalid send_message parameters: ${parsed.error.message}`, fault: false };
    }
    const { body, subject, messageClass, contextRef } = parsed.data;
    await ctx.publishToInbound(AGENT_MESSAGE_TYPES.SEND_MESSAGE, {
      body,
      subject,
      ...(messageClass ? { messageClass } : {}),
      ...(contextRef ? { contextRef } : {}),
    });

    return { success: true, data: { ok: true, note: 'message queued for delivery' } };
  },
};

// --- publish_artifact ---

const PublishArtifactParamsSchema = z.object({
  artifactType: z.string().default('text'),
  contentType: z.string().default('text/plain'),
  summary: z.string().min(1).default('Artifact published'),
  body: z.string().optional(),
  location: z.object({}).passthrough().optional(),
  metadata: z.object({}).passthrough().optional(),
});

const publishArtifactTool: AgentTool = {
  name: 'publish_artifact',
  description: 'Publish an artifact (analysis result, chart, report) for user review. Artifacts are stored and referenced by ID.',
  parametersSchema: PublishArtifactParamsSchema,
  parameters: convertZodToJsonSchema(PublishArtifactParamsSchema),
  category: 'write-messaging',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as z.infer<typeof PublishArtifactParamsSchema>;
    const crypto = await import('node:crypto');
    const artifactId = crypto.randomUUID();

    await ctx.publishToInbound(AGENT_MESSAGE_TYPES.PUBLISH_ARTIFACT, {
      artifactId,
      artifactType: p.artifactType,
      contentType: p.contentType,
      summary: p.summary,
      body: p.body,
      location: p.location,
      metadata: p.metadata,
    });

    return { success: true, data: { ok: true, artifactId } };
  },
};

export const messagingTools: AgentTool[] = [
  sendMessageTool,
  publishArtifactTool,
];
