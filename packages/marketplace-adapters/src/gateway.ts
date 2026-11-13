import type { CanonicalOrder, MarketplaceSource } from '@omnihub/canonical-ir';
import { AdapterError } from './errors';
import { externalId } from './mercadolivre/schemas';
export interface SpokeReference { source: Exclude<MarketplaceSource, 'MANUAL'>; externalOrderId: string }
export interface SpokeMapping { externalItemId: string; externalVariantId: string; sku: string }
export function validateSpokeMapping(source: MarketplaceSource, mapping: SpokeMapping): void {
  if (source !== 'MERCADO_LIVRE' || !/^MLB[0-9]+$/.test(mapping.externalItemId)) throw new AdapterError('ADAPTER_INVALID_CONTEXT','Mapeamento não corresponde a um canal/anúncio implementado.');
  if (mapping.externalVariantId) externalId(mapping.externalVariantId);
}
export interface LoadedSpokeOrder {
  raw: unknown;
  cancelled?: boolean;
  parse(context: { canonicalOrderId: string; mappings: readonly SpokeMapping[] }): CanonicalOrder;
}
export interface SpokeGateway {
  readonly source: SpokeReference['source'];
  readonly externalAccountId: string;
  identifyNotification(raw: unknown): SpokeReference;
  loadOrder(externalOrderId: string): Promise<LoadedSpokeOrder>;
  updateStock(mapping: SpokeMapping, availableQuantity: number): Promise<void>;
  checkConnection(): Promise<{ testUser: boolean }>;
}
