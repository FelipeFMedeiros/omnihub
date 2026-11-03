import { afterAll, afterEach, beforeAll } from 'bun:test';
import type { CanonicalOrder } from '@omnihub/canonical-ir';
import { canonicalOrders, createDatabase, inventoryLedger, products } from '@omnihub/database';
import { requireTestDatabaseUrl } from '@omnihub/database/testing';
import { inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Conexões independentes e commits reais; cleanup restrito aos UUIDs criados pelo teste. */
export function databaseFixture() {
  let connection: ReturnType<typeof createDatabase>;
  const productIds = new Set<string>();
  const orderIds = new Set<string>();

  beforeAll(async () => {
    if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL ausente');
    connection = createDatabase(requireTestDatabaseUrl(testDatabaseUrl, process.env.DATABASE_URL), 20);
    await migrate(connection.db, { migrationsFolder: fileURLToPath(new URL('../../../packages/database/drizzle', import.meta.url)) });
  });
  afterEach(async () => {
    if (!connection) return;
    await connection.db.transaction(async (tx) => {
      if (productIds.size) await tx.delete(inventoryLedger).where(inArray(inventoryLedger.productId, [...productIds]));
      if (orderIds.size) await tx.delete(canonicalOrders).where(inArray(canonicalOrders.id, [...orderIds]));
      if (productIds.size) await tx.delete(products).where(inArray(products.id, [...productIds]));
    });
    productIds.clear(); orderIds.clear();
  });
  afterAll(async () => { await connection?.client.end(); });

  function order(
    items: readonly { sku: string; quantity?: number; unitPriceCents?: number }[],
    overrides: Partial<CanonicalOrder> = {},
  ): CanonicalOrder {
    const canonicalItems = items.map((item) => ({
      sku: item.sku, quantity: item.quantity ?? 1, unitPriceCents: item.unitPriceCents ?? 100,
      title: 'Produto teste', externalItemId: `item-${item.sku}`, currency: 'BRL',
    }));
    const result: CanonicalOrder = {
      id: Bun.randomUUIDv7(), source: 'MANUAL', externalOrderId: Bun.randomUUIDv7(),
      createdAt: new Date('2026-10-28T12:00:00.000Z'), status: 'PAID',
      totalAmountCents: canonicalItems.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0),
      customer: { externalCustomerId: 'test-customer', documentNumber: '12345678901', name: 'Cliente Teste', email: 'test@example.com' },
      shippingAddress: { street: 'Rua Teste', number: '10', neighborhood: 'Centro', city: 'Mossoró', state: 'RN', postalCode: '59600000' },
      items: canonicalItems,
      ...overrides,
    };
    orderIds.add(result.id);
    return result;
  }

  return {
    get db() { return connection.db; },
    order,
    async product(currentStock = 5, safetyStock = 0) {
      const id = Bun.randomUUIDv7();
      productIds.add(id);
      const [product] = await connection.db.insert(products).values({
        id, sku: `TEST-${id}`, title: 'Produto teste', basePriceCents: 100, currentStock, safetyStock,
      }).returning();
      if (!product) throw new Error('Produto não inserido');
      return product;
    },
    async storedOrder(sku: string) {
      const result = order([{ sku }]);
      await connection.db.insert(canonicalOrders).values({
        id: result.id, source: result.source, externalOrderId: result.externalOrderId,
        status: result.status, totalAmountCents: result.totalAmountCents, createdAt: result.createdAt,
        customerPayload: result.customer, shippingPayload: result.shippingAddress,
        itemsPayload: result.items, rawPayload: { fixture: true },
      });
      return result;
    },
  };
}
