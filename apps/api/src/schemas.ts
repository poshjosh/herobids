import { z } from 'zod';

export const CreateInstanceSchema = z.object({
  connectionId: z.string().min(1),
  venue: z.string().min(1),
  symbol: z.string().min(1),
  /** Reference an existing blueprint as the config source. */
  blueprintId: z.string().min(1).optional(),
  /** Field-level overrides applied on top of the blueprint's configData. */
  configOverrides: z.record(z.unknown()).optional(),
  /** Inline config — deprecated; use blueprintId instead. */
  config: z.record(z.unknown()).optional(),
}).strict().superRefine((d, ctx) => {
  if (d.blueprintId === undefined && d.config === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Either blueprintId or config is required',
      path: ['blueprintId'],
    });
  }

  if (d.configOverrides !== undefined && d.blueprintId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'configOverrides requires blueprintId',
      path: ['configOverrides'],
    });
  }

  if (d.blueprintId !== undefined && d.config !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'blueprintId and config are mutually exclusive; use blueprintId with optional configOverrides',
      path: ['config'],
    });
  }
});

export const UpdateInstanceConfigSchema = z.object({
  config: z.record(z.unknown()),
});

export const CreateVenueAccountSchema = z.object({
  venue: z.string().min(1),
  label: z.string().min(1),
  venueAccountRef: z.string().optional(),
  credentialId: z.string().optional(),
});

export const CreatePortfolioSchema = z.object({
  name: z.string().min(1),
});

export const JournalQuerySchema = z.object({
  actorId: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ReconciliationEventQuerySchema = z.object({
  since: z.string().datetime().optional(),
  result: z.enum(['match', 'drift_detected', 'repaired']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const LiveStatusQuerySchema = z.object({
  /** Only return events since this ISO timestamp */
  since: z.string().datetime().optional(),
  /** Max number of recent events to return per category */
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const DashboardActivityQuerySchema = z.object({
  /** Return events created before this ISO timestamp (cursor-based pagination) */
  before: z.string().datetime().optional(),
  /** Tie-breaker ID for the before cursor — ensures correct pagination when multiple
   * events share the same createdAt timestamp */
  beforeId: z.string().optional(),
  /** Max events to return */
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type CreateInstanceInput = z.infer<typeof CreateInstanceSchema>;
export type UpdateInstanceConfigInput = z.infer<typeof UpdateInstanceConfigSchema>;
export type CreateVenueAccountInput = z.infer<typeof CreateVenueAccountSchema>;
export type CreatePortfolioInput = z.infer<typeof CreatePortfolioSchema>;
export type JournalQueryInput = z.infer<typeof JournalQuerySchema>;
export type ReconciliationEventQueryInput = z.infer<typeof ReconciliationEventQuerySchema>;
export type LiveStatusQueryInput = z.infer<typeof LiveStatusQuerySchema>;
export type DashboardActivityQueryInput = z.infer<typeof DashboardActivityQuerySchema>;

// ---------------------------------------------------------------------------
// Platform primitives — connections and grants (capability model)
// ---------------------------------------------------------------------------

export const CreateConnectionSchema = z.object({
  /** Provider identifier: "hyperliquid", "bybit", "telegram", "twitter", etc. */
  provider: z.string().min(1),
  /** Human-readable label for this connection */
  label: z.string().min(1),
  /** Optional reference to an existing credential (for secret-based providers) */
  credentialId: z.string().optional(),
});

export const SetupProviderLinkSchema = z.object({
  /** Provider identifier: "hyperliquid", "bybit", "1inch", etc. */
  provider: z.string().min(1),
  /** Base label used for the credential, connection, and binding */
  label: z.string().min(1),
  /** Manual credentials remain the default for existing callers. */
  credentialMode: z.enum(['manual', 'generated']).default('manual'),
  /** Secrets to encrypt (API key, secret, passphrase, etc.). Generated mode prohibits this field. */
  secrets: z.record(z.string()).optional(),
  /** Optional capability to provision alongside the connection. Currently only "trading" is supported. */
  capability: z.enum(['trading']).optional(),
}).superRefine((value, ctx) => {
  if (value.credentialMode === 'manual' && !value.secrets) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secrets'], message: 'secrets are required for manual credentials' });
  }
  if (value.credentialMode === 'generated') {
    if (value.secrets !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secrets'], message: 'secrets must not be supplied when creating a wallet' });
    }
    if (value.capability !== 'trading') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capability'], message: 'generated wallets require trading capability' });
    }
  }
});

export type CreateConnectionInput = z.infer<typeof CreateConnectionSchema>;
