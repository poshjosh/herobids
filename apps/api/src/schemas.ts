import { z } from 'zod';

export const CreateInstanceSchema = z.object({
  userId: z.string().min(1),
  portfolioId: z.string().min(1),
  venueAccountId: z.string().min(1),
  strategyId: z.string().min(1),
  venue: z.string().min(1),
  symbol: z.string().min(1),
  config: z.record(z.unknown()),
});

export const UpdateInstanceConfigSchema = z.object({
  config: z.record(z.unknown()),
});

export const CreateVenueAccountSchema = z.object({
  userId: z.string().min(1),
  venue: z.string().min(1),
  label: z.string().min(1),
  venueAccountRef: z.string().optional(),
  credentialId: z.string().optional(),
});

export const CreatePortfolioSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
});

export const CreateCredentialSchema = z.object({
  userId: z.string().min(1),
  venue: z.string().min(1),
  label: z.string().min(1),
  /** The actual secrets to encrypt (API key, secret, passphrase, etc.) */
  secrets: z.record(z.string()),
});

export const RotateCredentialSchema = z.object({
  /** New secrets to replace the existing ones */
  secrets: z.record(z.string()),
});

export const JournalQuerySchema = z.object({
  tradingInstanceId: z.string().optional(),
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

export type CreateInstanceInput = z.infer<typeof CreateInstanceSchema>;
export type UpdateInstanceConfigInput = z.infer<typeof UpdateInstanceConfigSchema>;
export type CreateVenueAccountInput = z.infer<typeof CreateVenueAccountSchema>;
export type CreatePortfolioInput = z.infer<typeof CreatePortfolioSchema>;
export type JournalQueryInput = z.infer<typeof JournalQuerySchema>;
export type ReconciliationEventQueryInput = z.infer<typeof ReconciliationEventQuerySchema>;
