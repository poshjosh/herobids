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