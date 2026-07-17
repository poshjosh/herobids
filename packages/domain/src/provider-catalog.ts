export type ProviderCatalogSchemaVersion = 'v1';

export interface ProviderCatalogResponse {
  schemaVersion: ProviderCatalogSchemaVersion;
  etag: string;
  providers: ProviderDefinition[];
  customMode: CustomModeDefinition;
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  status: 'supported' | 'deprecated';
  categories: string[];
  /** Derived venue type for trading providers: 'orderbook' | 'swap' | null for non-trading */
  venueType?: 'orderbook' | 'swap' | null;
  logoUrl?: string;
  credentials?: CredentialSchema;
  connections?: ConnectionSchema;
  walletGeneration?: WalletGenerationCapability;
}

export interface WalletGenerationCapability {
  available: boolean;
  credentialModes: Array<'manual' | 'generated'>;
  network: string;
  fundingInstructionId: string;
}

export interface CredentialSchema {
  description?: string;
  fields: FieldDefinition[];
}

export interface ConnectionSchema {
  description?: string;
  requiresCredential: boolean;
  allowsCredential: boolean;
  credentialProviderIds: string[];
  autoCreatesTradingConnection: boolean;
}

export interface FieldDefinition {
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  secret: boolean;
  required: boolean;
  inputKind: 'text' | 'password' | 'textarea' | 'number';
  aliases: string[];
  validation?: FieldValidation;
}

export interface FieldValidation {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface CustomModeDefinition {
  credentials: { allowFreeformKeys: boolean };
  connections: { allowFreeformProvider: boolean; autoCreatesTradingConnection: boolean };
}

/**
 * Runtime binding family a connection can satisfy at agent-runtime resolution time.
 * Derived from provider categories — never stored separately.
 */
export type RuntimeBindingFamily = 'trading' | 'email';

/**
 * Single source of truth for provider -> catalog category mapping.
 * The API provider registry and DB runtime descriptor both derive from this map
 * instead of each owning a disconnected copy of provider categories.
 */
export const PROVIDER_CATEGORIES: Record<string, string[]> = {
  hyperliquid: ['trading'],
  bybit: ['trading'],
  '1inch': ['trading', 'swap'],
  jupiter: ['trading', 'swap'],
  gmail: ['messaging'],
};

/** Categories for a provider id, or an empty array if the provider is unknown. */
export function getProviderCategories(providerId: string): string[] {
  return PROVIDER_CATEGORIES[providerId] ?? [];
}

/** Derives runtime binding families (e.g. "trading", "email") from provider categories. */
export function deriveRuntimeFamiliesFromCategories(categories: string[]): RuntimeBindingFamily[] {
  const families = new Set<RuntimeBindingFamily>();
  if (categories.includes('trading') || categories.includes('swap')) {
    families.add('trading');
  }
  if (categories.includes('messaging')) {
    families.add('email');
  }
  return [...families];
}

/** Runtime binding families a connection to this provider id can satisfy. */
export function getRuntimeFamiliesForProvider(providerId: string): RuntimeBindingFamily[] {
  return deriveRuntimeFamiliesFromCategories(getProviderCategories(providerId));
}

/** Provider ids whose categories derive the given runtime binding family. */
export function getProviderIdsForRuntimeFamily(family: RuntimeBindingFamily): string[] {
  return Object.keys(PROVIDER_CATEGORIES).filter((providerId) => getRuntimeFamiliesForProvider(providerId).includes(family));
}