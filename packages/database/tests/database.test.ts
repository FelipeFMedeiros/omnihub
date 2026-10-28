import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import {
  canonicalOrders, createDatabase, inventoryLedger, products, spokeMappings, type Database,
} from '../src';
import { seedDatabase } from '../src/seed';
import { requireTestDatabaseUrl } from './test-database';

const testUrl = process.env.TEST_DATABASE_URL;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

describe.skipIf(!testUrl)('PostgreSQL isolado (TEST_DATABASE_URL)', () => {
  let connection: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    if (!testUrl) throw new Error('TEST_DATABASE_URL ausente');
    connection = createDatabase(requireTestDatabaseUrl(testUrl, process.env.DATABASE_URL));
    await migrate(connection.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  });

  afterAll(async () => { await connection?.client.end(); });

  async function withRollback(run: (tx: Transaction) => Promise<void>) {
    const rollback = new Error('ROLLBACK_TEST_FIXTURES');
    try {
      await connection.db.transaction(async (tx) => {
        await run(tx);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function insertProduct(tx: Transaction) {
    const [product] = await tx.insert(products).values({
      sku: `TEST-${Bun.randomUUIDv7()}`, title: 'Produto teste', basePriceCents: 100,
    }).returning();
    if (!product) throw new Error('Produto não inserido');
    return product;
  }

  const order = () => ({
    source: 'MANUAL' as const, externalOrderId: Bun.randomUUIDv7(), status: 'PAID' as const,
    totalAmountCents: 100,
    customerPayload: { externalCustomerId: 'test', documentNumber: '12345678901', name: 'Teste', email: 'test@example.com' },
    shippingPayload: { street: 'Rua Teste', number: '1', neighborhood: 'Centro', city: 'Mossoró', state: 'RN', postalCode: '59600000' },
    itemsPayload: [{ sku: 'SKU-TEST', externalItemId: 'test-item', title: 'Teste', unitPriceCents: 100, quantity: 1, currency: 'BRL' }],
    rawPayload: { original: { preserved: true }, amount: '1.00' },
  });

  test('migration reaplicável, UUID v7 e defaults de estoque', async () => {
    await migrate(connection.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    await withRollback(async (tx) => {
      const product = await insertProduct(tx);
      expect(product.id[14]).toBe('7');
      expect(product.currentStock).toBe(0);
      expect(product.reservedStock).toBe(0);
      expect(product.safetyStock).toBe(2);
      expect(product.updatedAt).toBeInstanceOf(Date);
    });
  });

  test('SKU único', async () => {
    await withRollback(async (tx) => {
      const product = await insertProduct(tx);
      await expect(tx.insert(products).values({ sku: product.sku, title: 'Duplicado', basePriceCents: 1 }).execute())
        .rejects.toThrow();
    });
  });

  test.each(['basePriceCents', 'currentStock', 'reservedStock', 'safetyStock'] as const)('rejeita %s negativo no banco', async (field) => {
    await withRollback(async (tx) => {
      await expect(tx.insert(products).values({
        sku: Bun.randomUUIDv7(), title: 'Inválido', basePriceCents: 100, [field]: -1,
      }).execute()).rejects.toThrow();
    });
  });

  test('mapeamento único por canal e vínculo obrigatório com produto', async () => {
    await withRollback(async (tx) => {
      const product = await insertProduct(tx);
      const mapping = { productId: product.id, marketplace: 'SHOPEE' as const, externalItemId: Bun.randomUUIDv7() };
      await tx.insert(spokeMappings).values(mapping);
      await tx.insert(spokeMappings).values({ ...mapping, marketplace: 'AMAZON' });
      await expect(tx.insert(spokeMappings).values(mapping).execute()).rejects.toThrow();
    });
    await withRollback(async (tx) => {
      await expect(tx.insert(spokeMappings).values({
        productId: Bun.randomUUIDv7(), marketplace: 'AMAZON', externalItemId: Bun.randomUUIDv7(),
      }).execute()).rejects.toThrow();
    });
  });

  test('preserva JSON bruto, itens canônicos e chave de idempotência por origem', async () => {
    await withRollback(async (tx) => {
      const payload = order();
      const [stored] = await tx.insert(canonicalOrders).values(payload).returning();
      expect(stored?.rawPayload).toEqual(payload.rawPayload);
      expect(stored?.itemsPayload).toEqual(payload.itemsPayload);
      await tx.insert(canonicalOrders).values({ ...payload, source: 'SHOPEE' });
      await expect(tx.insert(canonicalOrders).values(payload).execute()).rejects.toThrow();
    });
  });

  test('pedido exige itens e dinheiro não negativo', async () => {
    await withRollback(async (tx) => {
      await expect(tx.insert(canonicalOrders).values({ ...order(), itemsPayload: [] }).execute()).rejects.toThrow();
    });
    await withRollback(async (tx) => {
      await expect(tx.insert(canonicalOrders).values({ ...order(), totalAmountCents: -1 }).execute()).rejects.toThrow();
    });
  });

  test('ledger registra saldo e mantém referências de produto e pedido', async () => {
    await withRollback(async (tx) => {
      const product = await insertProduct(tx);
      const [storedOrder] = await tx.insert(canonicalOrders).values(order()).returning();
      if (!storedOrder) throw new Error('Pedido não inserido');
      const [movement] = await tx.insert(inventoryLedger).values({
        productId: product.id, orderId: storedOrder.id, delta: -1, reason: 'SALE', availableAfter: 0,
      }).returning();
      expect(movement?.delta).toBe(-1);
      expect(movement?.availableAfter).toBe(0);
      expect(movement?.timestamp).toBeInstanceOf(Date);
      await expect(tx.delete(products).where(eq(products.id, product.id)).execute()).rejects.toThrow();
    });
  });

  test('seed cria 3 SKUs/9 mapeamentos e reexecução preserva saldo alterado', async () => {
    await withRollback(async (tx) => {
      await seedDatabase(tx);
      await tx.update(products).set({ currentStock: 7 }).where(eq(products.sku, 'SKU-FONTE-600W'));
      const [before] = await tx.select({ count: count() }).from(spokeMappings);
      await seedDatabase(tx);
      const [after] = await tx.select({ count: count() }).from(spokeMappings);
      expect(after?.count).toBe(before?.count);
      const seeded = await tx.select().from(products);
      for (const sku of ['SKU-FONTE-600W', 'SKU-SSD-NVME-1TB', 'SKU-MEM-DDR5-16GB']) {
        const product = seeded.find((entry) => entry.sku === sku);
        expect(product).toBeDefined();
        const mappings = await tx.select().from(spokeMappings).where(eq(spokeMappings.productId, product!.id));
        expect(mappings.map((mapping) => mapping.marketplace).sort()).toEqual(['AMAZON', 'MERCADO_LIVRE', 'SHOPEE']);
      }
      expect(seeded.find((entry) => entry.sku === 'SKU-FONTE-600W')?.currentStock).toBe(7);
    });
  });
});
