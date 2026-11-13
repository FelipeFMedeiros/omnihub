import { describe, expect, test } from 'bun:test';
import { canonicalOrders, inventoryLedger, products } from '@omnihub/database';
import { and, eq } from 'drizzle-orm';
import { HubError } from '../../src/errors';
import { InventoryService } from '../../src/services/inventory.service';
import { OrderIngestionService } from '../../src/services/order-ingestion.service';
import { databaseFixture, testDatabaseUrl } from '../helpers';

describe.skipIf(!testDatabaseUrl)('Motor de estoque com PostgreSQL isolado', () => {
  const fixture = databaseFixture();
  const balances = (productId: string) => fixture.db.select().from(products).where(eq(products.id, productId));
  const ledger = (productId: string) => fixture.db.select().from(inventoryLedger).where(eq(inventoryLedger.productId, productId));

  test('15 reservas concorrentes sobre 5 unidades: 5 sucessos, 10 conflitos e disponível zero', async () => {
    const product = await fixture.product(5);
    const orders = await Promise.all(Array.from({ length: 15 }, () => fixture.storedOrder(product.sku)));
    const inventory = new InventoryService(fixture.db, fixture.context);
    const results = await Promise.allSettled(orders.map((order) => inventory.reserveStock(product.id, 1, order.id)));
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(5);
    expect(failures).toHaveLength(10);
    for (const failure of failures) {
      expect(failure.reason).toBeInstanceOf(HubError);
      expect(failure.reason).toMatchObject({ status: 409, code: 'INSUFFICIENT_CANONICAL_STOCK' });
    }
    const [stored] = await balances(product.id);
    expect(stored).toMatchObject({ currentStock: 5, reservedStock: 5 });
    expect(stored!.currentStock - stored!.reservedStock).toBe(0);
    const movements = await ledger(product.id);
    expect(movements).toHaveLength(5);
    expect(movements.map((entry) => entry.availableAfter).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(movements.every((entry) => entry.delta === -1 && entry.reason === 'SALE')).toBe(true);
  });

  test('15 pedidos concorrentes persistem exatamente 5 pedidos e 5 movimentos', async () => {
    const product = await fixture.product(5);
    const ingestion = new OrderIngestionService(fixture.db, fixture.context);
    const orders = Array.from({ length: 15 }, () => fixture.order([{ sku: product.sku }]));
    const results = await Promise.allSettled(orders.map((order) => ingestion.ingest(order, { externalId: order.externalOrderId })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(10);
    for (const failure of failures) expect(failure.reason).toMatchObject({ status: 409, code: 'INSUFFICIENT_CANONICAL_STOCK' });
    const rows = await fixture.db.select().from(canonicalOrders);
    expect(rows.filter((row) => orders.some((order) => order.id === row.id))).toHaveLength(5);
    expect(await ledger(product.id)).toHaveLength(5);
  });

  test('duplicatas simultâneas retornam 1 criação e 14 recibos sem nova reserva', async () => {
    const product = await fixture.product(1);
    const ingestion = new OrderIngestionService(fixture.db, fixture.context);
    const externalOrderId = Bun.randomUUIDv7();
    const orders = Array.from({ length: 15 }, () => fixture.order([{ sku: product.sku }], { externalOrderId }));
    const results = await Promise.all(orders.map((order) => ingestion.ingest(order, { winningId: order.id })));
    expect(results.filter((result) => result.status === 201 && !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.status === 200 && result.duplicate)).toHaveLength(14);
    expect(new Set(results.map((result) => result.order.id)).size).toBe(1);
    const winner = results.find((result) => !result.duplicate)!;
    const [stored] = await fixture.db.select().from(canonicalOrders).where(eq(canonicalOrders.id, winner.order.id));
    expect(stored?.rawPayload).toEqual({ winningId: winner.order.id });
    expect(stored?.createdAt.toISOString()).toBe(orders[0]!.createdAt.toISOString());
    expect(stored?.itemsPayload).toEqual(winner.order.items);
    expect(await ledger(product.id)).toHaveLength(1);
    expect((await balances(product.id))[0]?.reservedStock).toBe(1);
  });

  test('falta no último produto reverte pedido, primeiro produto e ledger integralmente', async () => {
    const candidates = [await fixture.product(5), await fixture.product(5)];
    candidates.sort((left, right) => left.id < right.id ? -1 : 1);
    const first = candidates[0]!;
    const second = candidates[1]!;
    await fixture.db.update(products).set({ currentStock: 0 }).where(eq(products.id, second.id));
    const order = fixture.order([{ sku: second.sku }, { sku: first.sku, quantity: 2 }]);
    await expect(new OrderIngestionService(fixture.db, fixture.context).ingest(order, { original: 'preserved only on success' }))
      .rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_CANONICAL_STOCK' });
    expect((await balances(first.id))[0]?.reservedStock).toBe(0);
    expect(await ledger(first.id)).toHaveLength(0);
    expect(await ledger(second.id)).toHaveLength(0);
    expect(await fixture.db.select().from(canonicalOrders).where(eq(canonicalOrders.id, order.id))).toHaveLength(0);
  });

  test('pedidos multi-item em ordem oposta concluem sem deadlock', async () => {
    const first = await fixture.product(2);
    const second = await fixture.product(2);
    const orders = [fixture.order([{ sku: first.sku }, { sku: second.sku }]), fixture.order([{ sku: second.sku }, { sku: first.sku }])];
    const ingestion = new OrderIngestionService(fixture.db, fixture.context);
    const results = await Promise.all(orders.map((order) => ingestion.ingest(order, { original: true })));
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    expect((await balances(first.id))[0]?.reservedStock).toBe(2);
    expect((await balances(second.id))[0]?.reservedStock).toBe(2);
  });

  test('agrega itens repetidos do mesmo SKU antes da reserva', async () => {
    const product = await fixture.product(3);
    await new OrderIngestionService(fixture.db, fixture.context).ingest(fixture.order([
      { sku: product.sku }, { sku: product.sku, quantity: 2 },
    ]), { original: true });
    expect((await balances(product.id))[0]?.reservedStock).toBe(3);
    expect(await ledger(product.id)).toMatchObject([{ delta: -3, availableAfter: 0 }]);
  });

  test('preserva margem de segurança por padrão e permite parametrização explícita', async () => {
    const product = await fixture.product(5, 2);
    const ingestion = new OrderIngestionService(fixture.db, fixture.context);
    await ingestion.ingest(fixture.order([{ sku: product.sku, quantity: 3 }]), { original: true });
    await expect(ingestion.ingest(fixture.order([{ sku: product.sku }]), { original: true }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_CANONICAL_STOCK' });
    await ingestion.ingest(fixture.order([{ sku: product.sku, quantity: 2 }]), { original: true }, false);
    expect((await balances(product.id))[0]?.reservedStock).toBe(5);
  });

  test('reentrada direta da mesma reserva é idempotente e quantidade diferente conflita', async () => {
    const product = await fixture.product(2);
    const order = await fixture.storedOrder(product.sku);
    const inventory = new InventoryService(fixture.db, fixture.context);
    await Promise.all(Array.from({ length: 5 }, () => inventory.reserveStock(product.id, 1, order.id)));
    expect((await balances(product.id))[0]?.reservedStock).toBe(1);
    expect(await ledger(product.id)).toHaveLength(1);
    await expect(inventory.reserveStock(product.id, 2, order.id)).rejects.toMatchObject({ code: 'RESERVATION_CONFLICT' });
  });

  test('chave de idempotência distingue origens e protege colisão de UUID', async () => {
    const product = await fixture.product(3);
    const ingestion = new OrderIngestionService(fixture.db, fixture.context);
    const original = fixture.order([{ sku: product.sku }]);
    await ingestion.ingest(original, { original: true });
    const other = fixture.order([{ sku: product.sku }], { source: 'MERCADO_LIVRE', externalOrderId: original.externalOrderId });
    expect((await new OrderIngestionService(fixture.db, fixture.workerContext).ingest(other, { original: true })).status).toBe(201);
    const conflicting = fixture.order([{ sku: product.sku }], { id: original.id });
    await expect(ingestion.ingest(conflicting, { original: false })).rejects.toMatchObject({ code: 'CANONICAL_ORDER_ID_CONFLICT' });
    expect((await balances(product.id))[0]?.reservedStock).toBe(2);
  });

  test('rejeita SKU desconhecido, IR inválida e estado sem reserva sem persistir pedido', async () => {
    const ingestion = new OrderIngestionService(fixture.db, fixture.context);
    const unknown = fixture.order([{ sku: 'UNKNOWN' }]);
    await expect(ingestion.ingest(unknown, {})).rejects.toMatchObject({ status: 422, code: 'CANONICAL_PRODUCT_NOT_FOUND' });
    const invalid = fixture.order([{ sku: 'UNKNOWN' }], { totalAmountCents: 0.5 });
    await expect(ingestion.ingest(invalid, {})).rejects.toMatchObject({ code: 'IR_SEMANTIC_VALIDATION_ERROR' });
    const cancelled = fixture.order([{ sku: 'UNKNOWN' }], { status: 'CANCELLED' });
    await expect(ingestion.ingest(cancelled, {})).rejects.toMatchObject({ code: 'ORDER_STATUS_NOT_RESERVABLE' });
    for (const order of [unknown, invalid, cancelled]) {
      expect(await fixture.db.select().from(canonicalOrders).where(eq(canonicalOrders.id, order.id))).toHaveLength(0);
    }
  });

  test.each([0, -1, 1.5, 2_147_483_648])('rejeita quantidade inválida %d sem movimentar estoque', async (quantity) => {
    const product = await fixture.product();
    const order = await fixture.storedOrder(product.sku);
    await expect(new InventoryService(fixture.db, fixture.context).reserveStock(product.id, quantity, order.id))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_STOCK_QUANTITY' });
    expect(await ledger(product.id)).toHaveLength(0);
  });

  test('cancelamentos simultâneos liberam reserva uma única vez e auditam delta positivo', async () => {
    const product = await fixture.product(3);
    const ingestion = new OrderIngestionService(fixture.db, fixture.context);
    const order = fixture.order([{ sku: product.sku, quantity: 2 }]);
    await ingestion.ingest(order, { original: true });
    const results = await Promise.all(Array.from({ length: 8 }, () => ingestion.cancel(order.source, order.externalOrderId)));
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.every((result) => result.order.status === 'CANCELLED')).toBe(true);
    expect((await balances(product.id))[0]).toMatchObject({ currentStock: 3, reservedStock: 0 });
    const movements = await ledger(product.id);
    expect(movements).toHaveLength(2);
    expect(movements.find((entry) => entry.reason === 'CANCELLATION')).toMatchObject({ delta: 2, availableAfter: 3 });
    expect((await ingestion.ingest({ ...order, id: Bun.randomUUIDv7() }, {})).status).toBe(200);
    expect((await balances(product.id))[0]?.reservedStock).toBe(0);
  });

  test('cancelamento multi-item reverte tudo se o saldo reservado estiver inconsistente', async () => {
    const candidates = [await fixture.product(2), await fixture.product(2)];
    candidates.sort((left, right) => left.id < right.id ? -1 : 1);
    const first = candidates[0]!;
    const second = candidates[1]!;
    const ingestion = new OrderIngestionService(fixture.db, fixture.context);
    const order = fixture.order([{ sku: first.sku }, { sku: second.sku }]);
    await ingestion.ingest(order, {});
    await fixture.db.update(products).set({ reservedStock: 0 }).where(eq(products.id, second.id));
    await expect(ingestion.cancel(order.source, order.externalOrderId)).rejects.toMatchObject({ code: 'RESERVATION_STATE_CONFLICT' });
    expect((await balances(first.id))[0]?.reservedStock).toBe(1);
    const cancellations = await fixture.db.select().from(inventoryLedger).where(and(
      eq(inventoryLedger.orderId, order.id), eq(inventoryLedger.reason, 'CANCELLATION'),
    ));
    expect(cancellations).toHaveLength(0);
    expect((await fixture.db.select().from(canonicalOrders).where(eq(canonicalOrders.id, order.id)))[0]?.status).toBe('PAID');
  });

  test('reposição ERP simultânea é idempotente pelo UUID da movimentação', async () => {
    const product = await fixture.product(1);
    const inventory = new InventoryService(fixture.db, fixture.context);
    const movementId = Bun.randomUUIDv7();
    const results = await Promise.all(Array.from({ length: 8 }, () => inventory.restock(product.id, 10, movementId)));
    expect(new Set(results.map((movement) => movement.id)).size).toBe(1);
    expect((await balances(product.id))[0]?.currentStock).toBe(11);
    expect(await ledger(product.id)).toMatchObject([{ reason: 'ERP_SYNC', delta: 10, availableAfter: 11 }]);
    await expect(inventory.restock(product.id, 5, movementId)).rejects.toMatchObject({ code: 'STOCK_MOVEMENT_ID_CONFLICT' });
    expect((await balances(product.id))[0]?.currentStock).toBe(11);
  });

  test('colisão de UUID em reposições de produtos diferentes reverte a operação perdedora', async () => {
    const first = await fixture.product(1);
    const second = await fixture.product(1);
    const inventory = new InventoryService(fixture.db, fixture.context);
    const movementId = Bun.randomUUIDv7();
    const results = await Promise.allSettled([inventory.restock(first.id, 10, movementId), inventory.restock(second.id, 10, movementId)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'STOCK_MOVEMENT_ID_CONFLICT' });
    expect((await balances(first.id))[0]!.currentStock + (await balances(second.id))[0]!.currentStock).toBe(12);
  });
});
