import crypto from 'node:crypto';
import type { AppConfig, CustomModeDefinition, ProviderCatalogResponse, ProviderDefinition, WalletGenerationCapability } from '@herobids/domain';
import type { ProviderCatalogDefinition, RegistryEntry } from './types.js';

const PROVIDER_REGISTRY: RegistryEntry[] = [
  {
    id: 'hyperliquid',
    displayName: 'Hyperliquid',
    status: 'supported',
    categories: ['trading'],
    logoUrl: '/assets/providers/hyperliquid.svg',
    credentials: {
      description: 'API wallet credentials for Hyperliquid trading',
      fields: [
        {
          key: 'apiKey',
          label: 'API Key / Wallet Address',
          secret: false,
          required: true,
          inputKind: 'text',
          placeholder: '0x...',
          aliases: ['api-key', 'apikey', 'api_key'],
          validation: { minLength: 1 },
          normalization: ['trim'],
          errors: {
            required: {
              code: 'credential.validation_error.required',
              message: 'apiKey is required for Hyperliquid credentials',
            },
          },
        },
        {
          key: 'secret',
          label: 'Secret',
          secret: true,
          required: true,
          inputKind: 'password',
          aliases: ['secret', 'secret-key', 'secret_key', 'secretkey'],
          validation: { minLength: 1 },
          normalization: ['trim'],
          errors: {
            required: {
              code: 'credential.validation_error.required',
              message: 'secret is required for Hyperliquid credentials',
            },
          },
        },
        {
          key: 'walletAddress',
          label: 'Main Wallet Address',
          secret: false,
          required: true,
          inputKind: 'text',
          placeholder: '0x...',
          aliases: ['wallet-address', 'walletaddress', 'account-address', 'accountaddress'],
          validation: { pattern: '^0x[0-9a-fA-F]{40}$' },
          normalization: ['trim', 'lowercase'],
          errors: {
            required: {
              code: 'credential.validation_error.required',
              message: 'walletAddress is required for Hyperliquid credentials',
            },
            pattern: {
              code: 'credential.validation_error.invalid_wallet_address',
              message: 'walletAddress must be a valid EVM address (0x + 40 hex chars)',
            },
          },
        },
      ],
    },
    connections: {
      description: 'Reusable Hyperliquid trading connection',
      requiresCredential: false,
      allowsCredential: true,
      credentialProviderIds: ['hyperliquid'],
      autoCreatesTradingConnection: true,
    },
  },
  {
    id: 'bybit',
    displayName: 'Bybit',
    status: 'supported',
    categories: ['trading'],
    logoUrl: '/assets/providers/bybit.svg',
    credentials: {
      description: 'Bybit API credentials',
      fields: [
        {
          key: 'apiKey',
          label: 'API Key',
          secret: true,
          required: true,
          inputKind: 'password',
          aliases: ['api-key', 'apikey', 'api_key'],
          validation: { minLength: 1 },
          normalization: ['trim'],
          errors: {
            required: {
              code: 'credential.validation_error.required',
              message: 'apiKey is required for Bybit credentials',
            },
          },
        },
        {
          key: 'secret',
          label: 'Secret',
          secret: true,
          required: true,
          inputKind: 'password',
          aliases: ['secret', 'secret-key', 'secret_key', 'secretkey', 'apisecret'],
          validation: { minLength: 1 },
          normalization: ['trim'],
          errors: {
            required: {
              code: 'credential.validation_error.required',
              message: 'secret is required for Bybit credentials',
            },
          },
        },
      ],
    },
    connections: {
      description: 'Reusable Bybit trading connection',
      requiresCredential: false,
      allowsCredential: true,
      credentialProviderIds: ['bybit'],
      autoCreatesTradingConnection: true,
    },
  },
  {
    id: '1inch',
    displayName: '1inch',
    status: 'supported',
    categories: ['trading', 'swap'],
    logoUrl: '/assets/providers/1inch.svg',
    credentials: {
      description: 'Signing key for an existing 1inch wallet',
      fields: [
        {
          key: 'privateKey',
          label: 'Private Key',
          secret: true,
          required: true,
          inputKind: 'password',
          aliases: ['private-key', 'privatekey', 'private_key'],
          validation: { pattern: '^(0x)?[0-9a-fA-F]{64}$' },
          normalization: ['trim'],
          errors: {
            required: {
              code: 'credential.validation_error.required',
              message: 'privateKey is required for 1inch credentials',
            },
            pattern: {
              code: 'credential.validation_error.invalid_private_key',
              message: 'privateKey must be 64 hex chars (optionally 0x-prefixed)',
            },
          },
        },
      ],
    },
    connections: {
      description: 'Reusable 1inch trading connection',
      requiresCredential: false,
      allowsCredential: true,
      credentialProviderIds: ['1inch'],
      autoCreatesTradingConnection: true,
    },
  },
  {
    id: 'jupiter',
    displayName: 'Jupiter',
    status: 'supported',
    categories: ['trading', 'swap'],
    logoUrl: '/assets/providers/jupiter.svg',
    credentials: {
      description: 'Signing key for an existing Jupiter wallet',
      fields: [
        {
          key: 'privateKey',
          label: 'Private Key',
          secret: true,
          required: true,
          inputKind: 'password',
          aliases: ['private-key', 'privatekey', 'private_key'],
          validation: { minLength: 1 },
          normalization: ['trim'],
          errors: {
            required: {
              code: 'credential.validation_error.required',
              message: 'privateKey is required for Jupiter credentials',
            },
          },
        },
      ],
    },
    connections: {
      description: 'Reusable Jupiter swap connection',
      requiresCredential: false,
      allowsCredential: true,
      credentialProviderIds: ['jupiter'],
      autoCreatesTradingConnection: true,
    },
  },
];

const CUSTOM_MODE: CustomModeDefinition = {
  credentials: { allowFreeformKeys: true },
  connections: { allowFreeformProvider: true, autoCreatesTradingConnection: false },
};

function deriveVenueType(categories: string[]): 'orderbook' | 'swap' | null {
  if (categories.includes('swap')) return 'swap';
  if (categories.includes('trading')) return 'orderbook';
  return null;
}

function oneInchNetworkLabel(venue: AppConfig['venues'][string] | undefined): string {
  if (venue?.tokenSafetyNetwork) {
    return venue.tokenSafetyNetwork.charAt(0).toUpperCase() + venue.tokenSafetyNetwork.slice(1);
  }

  return venue?.chainId === 8453 ? 'Base' : `EVM chain ${String(venue?.chainId ?? 'configured')}`;
}

export function getProviderWalletGenerationCapability(providerId: string, venues: AppConfig['venues'] | undefined): WalletGenerationCapability | undefined {
  const enabled = venues?.[providerId]?.walletGeneration.enabled ?? false;
  if (providerId === 'hyperliquid') {
    return {
      available: enabled,
      credentialModes: enabled ? ['manual', 'generated'] : ['manual'],
      network: 'Hyperliquid',
      fundingInstructionId: 'hyperliquid-mainnet',
    };
  }
  if (providerId === 'jupiter') {
    return {
      available: enabled,
      credentialModes: enabled ? ['manual', 'generated'] : ['manual'],
      network: 'Solana',
      fundingInstructionId: 'solana-mainnet',
    };
  }
  if (providerId === '1inch') {
    const venue = venues?.['1inch'];
    return {
      available: enabled,
      credentialModes: enabled ? ['manual', 'generated'] : ['manual'],
      network: oneInchNetworkLabel(venue),
      fundingInstructionId: `1inch-${String(venue?.chainId ?? 'configured')}`,
    };
  }
  return undefined;
}

function toPublicProvider(entry: RegistryEntry, venues?: AppConfig['venues']): ProviderDefinition {
  return {
    id: entry.id,
    displayName: entry.displayName,
    status: entry.status,
    categories: entry.categories,
    venueType: deriveVenueType(entry.categories),
    logoUrl: entry.logoUrl,
    credentials: entry.credentials
      ? {
          description: entry.credentials.description,
          fields: entry.credentials.fields.map((field) => ({
            key: field.key,
            label: field.label,
            description: field.description,
            placeholder: field.placeholder,
            secret: field.secret,
            required: field.required,
            inputKind: field.inputKind,
            aliases: field.aliases,
            validation: field.validation,
          })),
        }
      : undefined,
    connections: entry.connections,
    walletGeneration: getProviderWalletGenerationCapability(entry.id, venues),
  };
}

function buildCatalogResponse(venues?: AppConfig['venues']): ProviderCatalogDefinition {
  const baseResponse: Omit<ProviderCatalogResponse, 'etag'> = {
    schemaVersion: 'v1',
    providers: PROVIDER_REGISTRY.map((entry) => toPublicProvider(entry, venues)),
    customMode: CUSTOM_MODE,
  };

  const etag = crypto.createHash('sha256').update(JSON.stringify(baseResponse)).digest('hex');
  return {
    response: {
      ...baseResponse,
      etag,
    },
    etagHeader: `"${etag}"`,
    customMode: CUSTOM_MODE,
  };
}

export function listProviderRegistry(): readonly RegistryEntry[] {
  return PROVIDER_REGISTRY;
}

export function findProviderRegistryEntry(providerId: string): RegistryEntry | undefined {
  return PROVIDER_REGISTRY.find((entry) => entry.id === providerId);
}

export function getProviderCatalog(venues?: AppConfig['venues']): ProviderCatalogDefinition {
  return buildCatalogResponse(venues);
}

export function providerSupportsConnections(providerId: string): boolean {
  return findProviderRegistryEntry(providerId)?.connections !== undefined;
}

export function providerRequiresCredential(providerId: string): boolean {
  return findProviderRegistryEntry(providerId)?.connections?.requiresCredential ?? false;
}

export function providerAllowsCredential(providerId: string): boolean {
  return findProviderRegistryEntry(providerId)?.connections?.allowsCredential ?? true;
}

export function providerAllowsTradingSetup(providerId: string): boolean {
  return findProviderRegistryEntry(providerId)?.connections?.autoCreatesTradingConnection ?? false;
}

export function providerAllowsWalletGeneration(providerId: string, venues: AppConfig['venues']): boolean {
  return getProviderWalletGenerationCapability(providerId, venues)?.available ?? false;
}

export function credentialMatchesConnectionProvider(providerId: string, credentialVenue: string): boolean {
  const entry = findProviderRegistryEntry(providerId);
  if (!entry?.connections) {
    return credentialVenue === providerId;
  }

  return entry.connections.credentialProviderIds.includes(credentialVenue);
}

export function getCustomMode(): CustomModeDefinition {
  return CUSTOM_MODE;
}