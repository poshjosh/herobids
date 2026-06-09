import type { AppConfig } from '@herobids/domain';
import type { StreamPoolHandle } from '@herobids/engine';
import { BybitPublicStream, HyperliquidPublicStream } from '@herobids/venues';
import type { VenueStreamConnector } from '@herobids/venues';

export function publicStreamVenueKey(venue: string, testnet: boolean): string {
  return `${venue}:${testnet ? 'testnet' : 'mainnet'}`;
}

export function buildPublicStreamConnectors(venues: AppConfig['venues']): Map<string, () => VenueStreamConnector> {
  const streamConnectors = new Map<string, () => VenueStreamConnector>();
  const hyperliquidVenueConfig = venues['hyperliquid'];
  const bybitVenueConfig = venues['bybit'];

  if (hyperliquidVenueConfig?.wsUrl) {
    streamConnectors.set(publicStreamVenueKey('hyperliquid', false), () => new HyperliquidPublicStream({
      wsUrl: hyperliquidVenueConfig.wsUrl,
    }));
  }
  if (hyperliquidVenueConfig?.testnetWsUrl) {
    streamConnectors.set(publicStreamVenueKey('hyperliquid', true), () => new HyperliquidPublicStream({
      wsUrl: hyperliquidVenueConfig.testnetWsUrl,
    }));
  }
  if (bybitVenueConfig?.wsPublicUrl) {
    streamConnectors.set(publicStreamVenueKey('bybit', false), () => new BybitPublicStream({
      wsUrl: bybitVenueConfig.wsPublicUrl,
    }));
  }
  if (bybitVenueConfig?.wsTestnetPublicUrl) {
    streamConnectors.set(publicStreamVenueKey('bybit', true), () => new BybitPublicStream({
      wsUrl: bybitVenueConfig.wsTestnetPublicUrl,
    }));
  }

  return streamConnectors;
}

export function createScopedStreamPoolHandle(
  pool: StreamPoolHandle | undefined,
  venue: string,
  testnet: boolean,
): StreamPoolHandle | undefined {
  if (!pool) {
    return undefined;
  }

  const scopedVenueKey = publicStreamVenueKey(venue, testnet);
  return {
    subscribe(_venue: string, symbols: string[], handlers) {
      return pool.subscribe(scopedVenueKey, symbols, handlers);
    },
  };
}