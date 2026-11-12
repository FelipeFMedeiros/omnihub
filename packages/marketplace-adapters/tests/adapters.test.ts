import { describe, expect, test } from 'bun:test';
import { isCanonicalOrder } from '@omnihub/canonical-ir';
import legacy from './fixtures/meli-order-legacy.json';
import enriched from './fixtures/meli-order-enriched.json';
import { AdapterError, externalId, parseMeliOrderNotification, parseMeliOrderToCanonical, type AdapterErrorCode, type MeliParseContext } from '../src';

const context: MeliParseContext = {
  canonicalOrderId: '11111111-1111-4111-8111-111111111111', expectedSellerId: '900000001',
  skuMappings: [{ itemId: 'MLB1234567890', sku: 'SKU-CANONICO' }, { itemId: 'MLB1234567890', variationId: '12345', sku: 'SKU-VARIACAO' }],
};
function rejects(run: () => unknown, code: AdapterErrorCode) {
  try { run(); throw new Error('Era esperada uma rejeição.'); }
  catch (error) { expect(error).toBeInstanceOf(AdapterError); expect((error as AdapterError).code).toBe(code); }
}
describe('parser Mercado Livre puro', () => {
  test('normaliza centavos, identidade e endereço sem alterar o payload', () => {
    const before = JSON.stringify(legacy);
    const result = parseMeliOrderToCanonical({ order: legacy }, context);
    expect(result).toEqual({
      id: context.canonicalOrderId, source: 'MERCADO_LIVRE', externalOrderId: '2000000000000001',
      createdAt: new Date('2026-11-01T13:30:00Z'), status: 'PAID', totalAmountCents: 3998,
      customer: { externalCustomerId: '900000002', name: 'Comprador Sintetico', email: 'comprador@example.invalid', documentNumber: '12345678901', phone: '11900000000' },
      shippingAddress: { street: 'Rua de Teste', number: '100', postalCode: '01001000', city: 'São Paulo', state: 'SP', neighborhood: 'Centro', complement: 'Sala de teste' },
      items: [{ sku: 'SKU-CANONICO', externalItemId: 'MLB1234567890', title: 'Produto sintético', unitPriceCents: 1999, quantity: 2, currency: 'BRL' }],
    });
    expect(isCanonicalOrder(result)).toBe(true);
    expect(parseMeliOrderToCanonical({ order: legacy }, context)).toEqual(result);
    expect(JSON.stringify(legacy)).toBe(before);
  });
  test('enriquece recursos modernos e resolve a variação explicitamente', () => {
    const result = parseMeliOrderToCanonical(enriched, context);
    expect(isCanonicalOrder(result)).toBe(true);
    expect(result.customer.documentNumber).toBe('12345678901');
    expect(result.items[0]?.sku).toBe('SKU-VARIACAO');
    expect(result.shippingAddress.number).toBe('100');
  });
  test('normaliza CNPJ e arredonda valores na borda', () => {
    const order = structuredClone(legacy);
    order.buyer.billing_info = { doc_type: 'CNPJ', doc_number: '12.345.678/0001-90' };
    order.order_items[0]!.unit_price = 1.234;
    order.total_amount = 2.46;
    const result = parseMeliOrderToCanonical({ order }, context);
    expect(result.customer.documentNumber).toBe('12345678000190');
    expect(result.items[0]?.unitPriceCents).toBe(123);
  });
  test.each([['paid', 'PAID'], ['confirmed', 'PENDING'], ['payment_required', 'PENDING'], ['payment_in_process', 'PENDING'], ['partially_paid', 'PENDING'], ['cancelled', 'CANCELLED']] as const)('status %s => %s', (status, expected) => {
    expect(parseMeliOrderToCanonical({ order: { ...legacy, status } }, context).status).toBe(expected);
  });
  test.each(['refunded', 'unknown', '__proto__'])('rejeita status não representado: %s', status => {
    rejects(() => parseMeliOrderToCanonical({ order: { ...legacy, status } }, context), 'ADAPTER_UNSUPPORTED_ORDER');
  });
  test.each([null, {}, { ...legacy, order_items: [] }, { ...legacy, total_amount: -1 }, { ...legacy, total_amount: NaN }, { ...legacy, total_amount: Infinity }])('rejeita entrada inválida', order => {
    rejects(() => parseMeliOrderToCanonical({ order }, context), 'ADAPTER_INVALID_PAYLOAD');
  });
  test.each(['2026-02-30T10:30:00Z', '2026-11-01', '2026-11-01T24:00:00Z', '2026-11-01T13:00:00', 'invalid'])('rejeita data inválida %s', date_created => {
    rejects(() => parseMeliOrderToCanonical({ order: { ...legacy, date_created } }, context), 'ADAPTER_INVALID_PAYLOAD');
  });
  test('rejeita moeda, documento incompatível e frete/desconto não representável', () => {
    rejects(() => parseMeliOrderToCanonical({ order: { ...legacy, currency_id: 'USD' } }, context), 'ADAPTER_UNSUPPORTED_ORDER');
    rejects(() => parseMeliOrderToCanonical({ order: { ...legacy, total_amount: 49.98 } }, context), 'IR_SEMANTIC_VALIDATION_ERROR');
    const order = structuredClone(legacy); order.buyer.billing_info.doc_type = 'CNPJ';
    rejects(() => parseMeliOrderToCanonical({ order }, context), 'IR_SEMANTIC_VALIDATION_ERROR');
  });
  test('rejeita overflow monetário e quantidade que excede soma segura', () => {
    rejects(() => parseMeliOrderToCanonical({ order: { ...legacy, total_amount: Number.MAX_SAFE_INTEGER } }, context), 'IR_SEMANTIC_VALIDATION_ERROR');
    const order = structuredClone(legacy); order.order_items[0]!.quantity = Number.MAX_SAFE_INTEGER;
    rejects(() => parseMeliOrderToCanonical({ order }, context), 'IR_SEMANTIC_VALIDATION_ERROR');
  });
  test('exige mapeamento canônico, sem inferir SKU a partir de seller_sku', () => {
    rejects(() => parseMeliOrderToCanonical({ order: legacy }, { ...context, skuMappings: [] }), 'UNMAPPED_SPOKE_SKU');
    rejects(() => parseMeliOrderToCanonical(enriched, { ...context, skuMappings: [context.skuMappings[0]!] }), 'UNMAPPED_SPOKE_SKU');
    rejects(() => parseMeliOrderToCanonical({ order: legacy }, { ...context, skuMappings: [context.skuMappings[0]!, context.skuMappings[0]!] }), 'ADAPTER_INVALID_CONTEXT');
  });
  test('não preenche dados pessoais ausentes ou mascarados', () => {
    const { buyerProfile: _profile, ...withoutEmail } = enriched;
    rejects(() => parseMeliOrderToCanonical(withoutEmail, context), 'ADAPTER_ENRICHMENT_REQUIRED');
    rejects(() => parseMeliOrderToCanonical({ order: { ...legacy, buyer: { ...legacy.buyer, email: '***' } } }, context), 'ADAPTER_ENRICHMENT_REQUIRED');
    rejects(() => parseMeliOrderToCanonical({ order: { ...legacy, shipping: null } }, context), 'ADAPTER_ENRICHMENT_REQUIRED');
    rejects(() => parseMeliOrderToCanonical({ order: { ...legacy, buyer: { ...legacy.buyer, billing_info: null } } }, context), 'ADAPTER_ENRICHMENT_REQUIRED');
  });
  test('rejeita recursos de outro vendedor, comprador, entrega ou faturamento', () => {
    rejects(() => parseMeliOrderToCanonical({ order: legacy }, { ...context, expectedSellerId: '900000003' }), 'ADAPTER_RESOURCE_MISMATCH');
    rejects(() => parseMeliOrderToCanonical({ ...enriched, buyerProfile: { ...enriched.buyerProfile, id: 900000003 } }, context), 'ADAPTER_RESOURCE_MISMATCH');
    const delivery = structuredClone(enriched); delivery.shipment.destination.receiver_id = 900000003;
    rejects(() => parseMeliOrderToCanonical(delivery, context), 'ADAPTER_RESOURCE_MISMATCH');
    const shipment = structuredClone(enriched); shipment.shipment.id = 800000002;
    rejects(() => parseMeliOrderToCanonical(shipment, context), 'ADAPTER_RESOURCE_MISMATCH');
    const billing = structuredClone(enriched); billing.billingInfo.seller.cust_id = 900000003;
    rejects(() => parseMeliOrderToCanonical(billing, context), 'ADAPTER_RESOURCE_MISMATCH');
  });
  test('preserva IDs grandes em string e rejeita números sem precisão', () => {
    expect(externalId('9223372036854775807')).toBe('9223372036854775807');
    rejects(() => externalId(Number.MAX_SAFE_INTEGER + 1), 'ADAPTER_INVALID_PAYLOAD');
    expect(parseMeliOrderToCanonical({ order: { ...legacy, id: '9223372036854775807' } }, context).externalOrderId).toBe('9223372036854775807');
  });
});

describe('aviso de notificação, sem autenticação presumida', () => {
  const expected = { applicationId: '123456', sellerId: context.expectedSellerId };
  const notification = { topic: 'orders_v2', resource: '/orders/2000000000000001', application_id: 123456, user_id: 900000001 };
  test('extrai somente ID após validar app e vendedor', () => {
    expect(parseMeliOrderNotification(notification, expected)).toEqual({ orderId: '2000000000000001' });
    rejects(() => parseMeliOrderNotification({ ...notification, user_id: 900000003 }, expected), 'ADAPTER_RESOURCE_MISMATCH');
    rejects(() => parseMeliOrderNotification({ ...notification, application_id: 654321 }, expected), 'ADAPTER_RESOURCE_MISMATCH');
  });
  test.each(['https://example.invalid/orders/1', '//example.invalid', '/orders/1?x=y', '/orders/1#x', '/orders/%31', '/orders/../users/me'])('rejeita recurso arbitrário %s', resource => {
    rejects(() => parseMeliOrderNotification({ ...notification, resource }, expected), 'ADAPTER_INVALID_PAYLOAD');
  });
});
