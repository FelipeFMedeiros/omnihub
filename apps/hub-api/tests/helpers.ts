import { emitCanonicalOrderToLegacyErp } from '@omnihub/marketplace-adapters';
import type { WorkerContext } from '../src/services/context';
import { afterAll, afterEach, beforeAll } from 'bun:test';
import type { CanonicalOrder } from '@omnihub/canonical-ir';
import { canonicalOrders, connections, createDatabase, erpDestinations, inventoryLedger, pipelineJobs, products, users, workspaces } from '@omnihub/database';
import { requireTestDatabaseUrl } from '@omnihub/database/testing';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Conexões independentes e commits reais; cleanup restrito aos UUIDs criados pelo teste. */
let nextErpPort = 34000;
export function databaseFixture() {
  let connection: ReturnType<typeof createDatabase>;
  const ownerId = Bun.randomUUIDv7(), workspaceId = Bun.randomUUIDv7(), connectionId = Bun.randomUUIDv7(), erpDestinationId = Bun.randomUUIDv7();
  const officialId = Bun.randomUUIDv7();
  const context = { workspaceId, connectionId: null, erpDestinationId };
  const workerContext: WorkerContext = { workspaceId, connectionId, erpDestinationId, source: 'MERCADO_LIVRE', transportMode: 'LOCAL_FIXTURE' };
  const officialContext: WorkerContext = { ...workerContext, connectionId: officialId, transportMode: 'OFFICIAL_TEST_USER' };
  const configKey = `fixture-${erpDestinationId}`, erpUrl = `http://127.0.0.1:${nextErpPort++}`;
  const productIds = new Set<string>();
  const orderIds = new Set<string>();
  const jobIds = new Set<string>();

  beforeAll(async () => {
    if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL ausente');
    connection = createDatabase(requireTestDatabaseUrl(testDatabaseUrl, process.env.DATABASE_URL), 20);
    await migrate(connection.db, { migrationsFolder: fileURLToPath(new URL('../../../packages/database/drizzle', import.meta.url)) });
    await connection.db.insert(users).values({ id: ownerId, name: 'Fixture owner', email: `${ownerId}@example.invalid`, passwordHash: 'not-a-login-hash' });
    await connection.db.insert(workspaces).values({ id: workspaceId, ownerId });
    await connection.db.insert(connections).values([
      { id: connectionId, workspaceId, platform: 'MERCADO_LIVRE', transportMode: 'LOCAL_FIXTURE', state: 'ACTIVE', name: 'Fixture local', externalAccountId: `fixture-${connectionId}` },
      { id: officialId, workspaceId, platform: 'MERCADO_LIVRE', transportMode: 'OFFICIAL_TEST_USER', state: 'ACTIVE', name: 'Fixture official', externalAccountId: `fixture-${officialId}` },
    ]);
    await connection.db.insert(erpDestinations).values({ id: erpDestinationId, workspaceId, configKey, endpointOrigin: erpUrl, state: 'ACTIVE' });
  });
  afterEach(async () => {
    if (!connection) return;
    await connection.db.transaction(async (tx) => {
      if (jobIds.size) await tx.delete(pipelineJobs).where(inArray(pipelineJobs.id, [...jobIds]));
      if (productIds.size) await tx.delete(inventoryLedger).where(inArray(inventoryLedger.productId, [...productIds]));
      if (orderIds.size) await tx.delete(canonicalOrders).where(inArray(canonicalOrders.id, [...orderIds]));
      if (productIds.size) await tx.delete(products).where(inArray(products.id, [...productIds]));
    });
    productIds.clear(); orderIds.clear(); jobIds.clear();
  });
  afterAll(async () => {
    if (connection) {
      await connection.db.delete(connections).where(eq(connections.workspaceId, workspaceId));
      await connection.db.delete(erpDestinations).where(eq(erpDestinations.workspaceId, workspaceId));
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      await connection.db.delete(users).where(eq(users.id, ownerId));
      await connection.client.end();
    }
  });

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
    context, workerContext, officialContext, configKey, erpUrl, ownerId,
    dispatchValues(order: CanonicalOrder) {
      const payload = emitCanonicalOrderToLegacyErp(order, `oh:${workspaceId}:${order.source === 'MANUAL' ? 'manual' : connectionId}:${order.externalOrderId}`);
      return { workspaceId, erpDestinationId, orderId: order.id, externalIdempotencyKey: payload.codigo_pedido, payload };
    },
    trackOrder(id: string) { orderIds.add(id); },
    trackProduct(id: string) { productIds.add(id); },
    trackProcessing(id: string) { jobIds.add(id); },
    get db() { return connection.db; },
    get client() { return connection.client; },
    order,
    async product(currentStock = 5, safetyStock = 0, sku?: string) {
      const id = Bun.randomUUIDv7();
      productIds.add(id);
      const [product] = await connection.db.insert(products).values({
        workspaceId, id, sku: sku ?? `TEST-${id}`, title: 'Produto teste', basePriceCents: 100, currentStock, safetyStock,
      }).returning();
      if (!product) throw new Error('Produto não inserido');
      return product;
    },
    async storedOrder(sku: string) {
      const result = order([{ sku }]);
      await connection.db.insert(canonicalOrders).values({
        workspaceId, id: result.id, source: result.source, externalOrderId: result.externalOrderId,
        status: result.status, totalAmountCents: result.totalAmountCents, createdAt: result.createdAt,
        customerPayload: result.customer, shippingPayload: result.shippingAddress,
        itemsPayload: result.items, rawPayload: { fixture: true },
      });
      return result;
    },
  };
}
