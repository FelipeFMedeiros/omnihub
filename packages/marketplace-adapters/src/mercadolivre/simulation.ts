import fixture from '../../tests/fixtures/meli-order-legacy.json';
import type { SpokeGateway } from '../gateway';
import { AdapterError } from '../errors';
import { parseMeliOrderToCanonical } from './parser';

/** Explicit local transport: no network, no official credential, same parser. */
export function localMeliGateway(connectionId: string): SpokeGateway {
  const published = new Map<string, number>();
  return {
    source: 'MERCADO_LIVRE', externalAccountId: `local:${connectionId}`,
    identifyNotification(raw) {
      if (!raw || typeof raw !== 'object' || !('origin' in raw) || raw.origin !== 'LOCAL_FIXTURE_TASK014_V1' || !('connectionId' in raw) || raw.connectionId !== connectionId || !('orderId' in raw) || typeof raw.orderId !== 'string' || !/^[1-9][0-9]{1,99}[12]$/.test(raw.orderId)) throw new AdapterError('ADAPTER_INVALID_PAYLOAD', 'Referência local inválida.');
      return { source: 'MERCADO_LIVRE', externalOrderId: raw.orderId };
    },
    async loadOrder(orderId) {
      if (!/^[1-9][0-9]{1,99}[12]$/.test(orderId)) throw new AdapterError('ADAPTER_INVALID_PAYLOAD', 'Referência local inválida.');
      const order = { ...structuredClone(fixture), id: orderId, ...(orderId.endsWith('2') ? { total_amount: 1 } : {}) };
      const raw = { order, simulation: { origin: 'LOCAL_FIXTURE_TASK014_V1', scenario: orderId.endsWith('2') ? 'INVALID_TOTAL' : 'PAID' } };
      return { raw, parse: context => parseMeliOrderToCanonical(raw, { canonicalOrderId: context.canonicalOrderId, expectedSellerId: String(fixture.seller.id), skuMappings: context.mappings.map(m => ({ itemId: m.externalItemId, ...(m.externalVariantId ? { variationId: m.externalVariantId } : {}), sku: m.sku })) }) };
    },
    async checkConnection() { return { testUser: true }; },
    async updateStock(mapping, quantity) {
      if (!Number.isSafeInteger(quantity) || quantity < 0) throw new AdapterError('ADAPTER_INVALID_PAYLOAD', 'Saldo local inválido.');
      published.set(`${mapping.externalItemId}:${mapping.externalVariantId}`, quantity);
    },
  };
}
