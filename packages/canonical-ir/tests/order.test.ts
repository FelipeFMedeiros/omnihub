import { describe, expect, test } from 'bun:test';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import {
  CanonicalOrderSchema, CanonicalProductSchema, CanonicalStockMovementSchema,
  isCanonicalOrder, type CanonicalOrder,
} from '../src';

const check = TypeCompiler.Compile(CanonicalOrderSchema);

function order(): CanonicalOrder {
  return {
    id: Bun.randomUUIDv7(),
    source: 'MERCADO_LIVRE',
    externalOrderId: 'sandbox-order-1',
    createdAt: new Date('2026-10-28T12:00:00.000Z'),
    status: 'PAID',
    totalAmountCents: 69980,
    customer: {
      externalCustomerId: 'sandbox-customer-1', documentNumber: '12345678901',
      name: 'Cliente Teste', email: 'cliente@example.com',
    },
    shippingAddress: {
      street: 'Rua Exemplo', number: '10', neighborhood: 'Centro',
      city: 'Mossoró', state: 'RN', postalCode: '59600000',
    },
    items: [{
      sku: 'SKU-FONTE-600W', externalItemId: 'sandbox-item-1', title: 'Fonte ATX 600W',
      unitPriceCents: 34990, quantity: 2, currency: 'BRL',
    }],
  };
}

describe('CanonicalOrder', () => {
  test('aceita pedido canônico com Date e CPF normalizado', () => {
    expect(check.Check(order())).toBe(true);
    expect(isCanonicalOrder(order())).toBe(true);
  });

  test('aceita CNPJ de 14 dígitos e campos opcionais', () => {
    const valid = order();
    expect(check.Check({
      ...valid,
      customer: { ...valid.customer, documentNumber: '12345678000199', phone: '84999999999' },
      shippingAddress: { ...valid.shippingAddress, complement: 'Sala 2' },
    })).toBe(true);
  });

  test.each([1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejeita total inválido: %s', (totalAmountCents) => {
    expect(check.Check({ ...order(), totalAmountCents })).toBe(false);
  });

  test.each([10.99, -1])('rejeita preço unitário inválido: %s', (unitPriceCents) => {
    const valid = order();
    expect(check.Check({ ...valid, items: valid.items.map((item) => ({ ...item, unitPriceCents })) })).toBe(false);
  });

  test.each(['59600-000', '5960000', 'abcdefgh', '59600000\n'])('rejeita CEP malformado: %s', (postalCode) => {
    const valid = order();
    expect(check.Check({ ...valid, shippingAddress: { ...valid.shippingAddress, postalCode } })).toBe(false);
  });

  test.each(['123.456.789-01', '1234567890', '123456789012', '12345678901\n'])('rejeita documento não canônico: %s', (documentNumber) => {
    const valid = order();
    expect(check.Check({ ...valid, customer: { ...valid.customer, documentNumber } })).toBe(false);
  });

  test.each(['BR-RN', 'rn', 'R', 'RN\n'])('rejeita UF não normalizada: %s', (state) => {
    const valid = order();
    expect(check.Check({ ...valid, shippingAddress: { ...valid.shippingAddress, state } })).toBe(false);
  });

  test('rejeita lista de itens vazia', () => {
    expect(check.Check({ ...order(), items: [] })).toBe(false);
  });

  test.each([0, -1, 1.5])('rejeita quantidade inválida: %s', (quantity) => {
    const valid = order();
    expect(check.Check({ ...valid, items: valid.items.map((item) => ({ ...item, quantity })) })).toBe(false);
  });

  test('rejeita origem desconhecida, UUID, email e data inválidos', () => {
    const valid = order();
    for (const invalid of [
      { ...valid, source: 'UNKNOWN' },
      { ...valid, id: 'invalid-id' },
      { ...valid, createdAt: new Date('invalid') },
      { ...valid, createdAt: '2026-10-28T12:00:00.000Z' },
      { ...valid, customer: { ...valid.customer, email: 'invalid-email' } },
    ]) expect(check.Check(invalid)).toBe(false);
  });

  test('rejeita campos extras e não higieniza entradas silenciosamente', () => {
    const invalid = { ...order(), extra: 'external dialect' };
    expect(check.Check(invalid)).toBe(false);
    expect(invalid.extra).toBe('external dialect');
  });

  test('valida soma e multiplicação monetária sem perda de precisão', () => {
    const valid = order();
    expect(isCanonicalOrder({ ...valid, totalAmountCents: 1 })).toBe(false);
    expect(isCanonicalOrder({
      ...valid,
      totalAmountCents: Number.MAX_SAFE_INTEGER,
      items: valid.items.map((item) => ({ ...item, unitPriceCents: Number.MAX_SAFE_INTEGER, quantity: 2 })),
    })).toBe(false);
    expect(isCanonicalOrder({
      ...valid, totalAmountCents: 0,
      items: valid.items.map((item) => ({ ...item, unitPriceCents: 0 })),
    })).toBe(true);
  });
});

test('valida contratos de produto e movimentação de estoque', () => {
  const id = Bun.randomUUIDv7();
  const product = {
    id, sku: 'SKU-TEST', title: 'Produto teste', basePriceCents: 100,
    currentStock: 5, reservedStock: 0, safetyStock: 2, updatedAt: new Date(),
  };
  const productValidator = TypeCompiler.Compile(CanonicalProductSchema);
  expect(productValidator.Check(product)).toBe(true);
  expect(productValidator.Check({ ...product, basePriceCents: 1.5 })).toBe(false);
  expect(productValidator.Check({ ...product, currentStock: -1 })).toBe(false);

  const movement = {
    id: Bun.randomUUIDv7(), productId: id, sku: product.sku,
    delta: -1, reason: 'SALE', availableAfter: 4, timestamp: new Date(),
  };
  const movementValidator = TypeCompiler.Compile(CanonicalStockMovementSchema);
  expect(movementValidator.Check(movement)).toBe(true);
  expect(movementValidator.Check({ ...movement, reason: 'UNKNOWN' })).toBe(false);
  expect(movementValidator.Check({ ...movement, availableAfter: -1 })).toBe(false);
});
