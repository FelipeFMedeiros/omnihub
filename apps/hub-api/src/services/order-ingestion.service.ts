import { requireConnection, type OrderContext } from './context';
import { isCanonicalOrder, type CanonicalOrder, type MarketplaceSource } from '@omnihub/canonical-ir';
import { canonicalOrders, erpDispatches, inventoryLedger, products, type Database, type JsonValue } from '@omnihub/database';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { HubError } from '../errors';
import { InventoryService } from './inventory.service';
import { inTransaction, sqlState } from './transaction';

export interface IngestionResult {
  readonly status: 200 | 201;
  readonly duplicate: boolean;
  readonly order: CanonicalOrder;
}

function canonical(row: typeof canonicalOrders.$inferSelect): CanonicalOrder {
  return {
    id: row.id, source: row.source, externalOrderId: row.externalOrderId,
    createdAt: row.createdAt, status: row.status, totalAmountCents: row.totalAmountCents,
    customer: row.customerPayload, shippingAddress: row.shippingPayload, items: row.itemsPayload,
  };
}

export class OrderIngestionService {
  private readonly inventory: InventoryService;
  constructor(private readonly db: Database, readonly context: OrderContext) { this.inventory = new InventoryService(db, context); }

  private scope() { return and(eq(canonicalOrders.workspaceId, this.context.workspaceId), this.context.connectionId ? eq(canonicalOrders.connectionId, this.context.connectionId) : isNull(canonicalOrders.connectionId)); }

  /** Somente IR já normalizada. HTTP e despacho aos destinos pertencem às bordas. */
  async ingest(order: CanonicalOrder, rawPayload: JsonValue, enforceSafetyStock = true): Promise<IngestionResult> {
    if (!isCanonicalOrder(order) || order.totalAmountCents > 2_147_483_647 ||
      order.items.some((item) => item.unitPriceCents > 2_147_483_647 || item.quantity > 2_147_483_647)) {
      throw new HubError(422, 'IR_SEMANTIC_VALIDATION_ERROR', 'Pedido incompatível com os contratos canônicos ou limites do banco.');
    }
    try {
      return await inTransaction(this.db, async (tx): Promise<IngestionResult> => {
        await requireConnection(tx, this.context, order.source);
        const [inserted] = await tx.insert(canonicalOrders).values({
          workspaceId: this.context.workspaceId, connectionId: this.context.connectionId, id: order.id, source: order.source, externalOrderId: order.externalOrderId,
          createdAt: order.createdAt, status: order.status, totalAmountCents: order.totalAmountCents,
          customerPayload: order.customer, shippingPayload: order.shippingAddress,
          itemsPayload: order.items, rawPayload,
        }).onConflictDoNothing(this.context.connectionId ? {
          target: [canonicalOrders.workspaceId, canonicalOrders.connectionId, canonicalOrders.externalOrderId],
          where: sql`${canonicalOrders.connectionId} IS NOT NULL`,
        } : {
          target: [canonicalOrders.workspaceId, canonicalOrders.externalOrderId],
          where: sql`${canonicalOrders.source} = 'MANUAL' AND ${canonicalOrders.connectionId} IS NULL`,
        }).returning();
        if (!inserted) {
          // No Read Committed esta consulta vê o pedido cujo conflito aguardou o commit.
          const [previous] = await tx.select().from(canonicalOrders).where(and(
            this.scope(), eq(canonicalOrders.source, order.source), eq(canonicalOrders.externalOrderId, order.externalOrderId),
          ));
          if (!previous) throw new HubError(503, 'DB_TRANSACTION_SERIALIZATION', 'Pedido concorrente indisponível. Tente novamente.');
          return { status: 200, duplicate: true, order: canonical(previous) };
        }
        if (!['PENDING', 'PAID'].includes(order.status)) {
          throw new HubError(422, 'ORDER_STATUS_NOT_RESERVABLE', 'Somente pedidos pendentes ou pagos iniciam uma reserva.');
        }
        const productBySku = await this.inventory.resolveProducts(tx, order.items.map((item) => item.sku));
        await this.inventory.reserveItems(tx, order.items.map((item) => ({
          productId: productBySku.get(item.sku)!, quantity: item.quantity,
        })), inserted.id, enforceSafetyStock);
        return { status: 201, duplicate: false, order: canonical(inserted) };
      });
    } catch (error) {
      if (sqlState(error) === '23505') throw new HubError(409, 'CANONICAL_ORDER_ID_CONFLICT', 'O identificador canônico já pertence a outro pedido.');
      throw error;
    }
  }

  /** Cancela todas as reservas do pedido atomicamente, sem alterar estoque físico. */
  async cancel(source: MarketplaceSource, externalOrderId: string): Promise<IngestionResult> {
    return inTransaction(this.db, async (tx): Promise<IngestionResult> => {
      await requireConnection(tx, this.context, source);
      const [order] = await tx.select().from(canonicalOrders).where(and(
        this.scope(), eq(canonicalOrders.source, source), eq(canonicalOrders.externalOrderId, externalOrderId),
      )).for('update');
      if (!order) throw new HubError(404, 'CANONICAL_ORDER_NOT_FOUND', 'Pedido canônico não encontrado.');
      if (order.status === 'CANCELLED') return { status: 200, duplicate: true, order: canonical(order) };
      if (!['PENDING', 'PAID'].includes(order.status)) throw new HubError(409, 'ORDER_NOT_CANCELLABLE', 'O estado do pedido não permite liberar a reserva.');
      const [dispatch] = await tx.select().from(erpDispatches).where(eq(erpDispatches.orderId, order.id));
      if (dispatch && (dispatch.attempts > 0 || dispatch.state === 'PROCESSING')) throw new HubError(409, 'ORDER_DISPATCH_RECONCILIATION_REQUIRED', 'Pedido enviado ao ERP exige conciliação antes do cancelamento.');
      const sales = await tx.select().from(inventoryLedger).where(and(
        eq(inventoryLedger.workspaceId, this.context.workspaceId), eq(inventoryLedger.orderId, order.id), eq(inventoryLedger.reason, 'SALE'),
      )).orderBy(asc(inventoryLedger.productId));
      for (const sale of sales) {
        const quantity = -sale.delta;
        if (quantity < 1) throw new HubError(409, 'RESERVATION_STATE_CONFLICT', 'Reserva incompatível com o ledger.');
        const [product] = await tx.update(products).set({
          reservedStock: sql`${products.reservedStock} - ${quantity}`, updatedAt: sql`now()`,
        }).where(and(eq(products.workspaceId, this.context.workspaceId), eq(products.id, sale.productId), sql`${products.reservedStock} >= ${quantity}`)).returning();
        if (!product) throw new HubError(409, 'RESERVATION_STATE_CONFLICT', 'Saldo reservado incompatível com o pedido.');
        await tx.insert(inventoryLedger).values({
          workspaceId: this.context.workspaceId, productId: product.id, orderId: order.id, delta: quantity, reason: 'CANCELLATION',
          availableAfter: product.currentStock - product.reservedStock,
        });
      }
      const [cancelled] = await tx.update(canonicalOrders).set({ status: 'CANCELLED' }).where(eq(canonicalOrders.id, order.id)).returning();
      if (!cancelled) throw new Error('Pedido não retornado após cancelamento.');
      return { status: 200, duplicate: false, order: canonical(cancelled) };
    });
  }
}
