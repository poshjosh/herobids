import type {
  ConnectionSchema,
  CredentialSchema,
  CustomModeDefinition,
  FieldDefinition,
  ProviderCatalogResponse,
  ProviderDefinition,
} from '@herobids/domain';

export type NormalizationRule = 'trim' | 'lowercase' | 'uppercase';

export interface ValidationErrorDefinition {
  code: string;
  message: string;
}

export interface RegistryFieldDefinition extends FieldDefinition {
  normalization?: NormalizationRule[];
  errors?: {
    required?: ValidationErrorDefinition;
    pattern?: ValidationErrorDefinition;
    minLength?: ValidationErrorDefinition;
    maxLength?: ValidationErrorDefinition;
  };
}

export interface RegistryCredentialSchema extends Omit<CredentialSchema, 'fields'> {
  fields: RegistryFieldDefinition[];
}

export interface RegistryEntry extends Omit<ProviderDefinition, 'credentials'> {
  credentials?: RegistryCredentialSchema;
}

export interface ProviderCatalogDefinition {
  response: ProviderCatalogResponse;
  etagHeader: string;
  customMode: CustomModeDefinition;
}

export type PublicProviderDefinition = ProviderDefinition;
export type PublicConnectionSchema = ConnectionSchema;