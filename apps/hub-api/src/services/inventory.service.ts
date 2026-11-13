import { requireDestination, requireWorkspace, type WorkspaceContext } from './context';
import type { CanonicalProduct, CanonicalStockMovement } from '@omnihub/canonical-ir';
import { canonicalOrders, inventoryLedger, products, type Database } from '@omnihub/database';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { HubError } from '../errors';
import { inTransaction, sqlState, type Transaction } from './transaction';

const MAX_INTEGER = 2_147_483_647;
export interface StockRequest { readonly productId: string; readonly quantity: number }
export interface StockReservation extends StockRequest {
  readonly availableAfter: number;
  readonly remainingAvailable: number;
}
export type InventoryProduct = CanonicalProduct & { readonly availableStock: number };
function canonicalMovement(row: typeof inventoryLedger.$inferSelect, sku: string): CanonicalStockMovement {
  return { id: row.id, productId: row.productId, sku, orderId: row.orderId ?? undefined, delta: row.delta, reason: row.reason, availableAfter: row.availableAfter, timestamp: row.timestamp };
}

function pagination(limit: number, offset: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > MAX_INTEGER) {
    throw new HubError(422, 'INVALID_PAGINATION', 'Use limit entre 1 e 100 e offset inteiro não negativo.');
  }
}

export class InventoryService {
  constructor(private readonly db: Database, readonly context: WorkspaceContext & { readonly erpDestinationId?: string }) {}

  async reserveStock(productId: string, quantity: number, orderId: string, enforceSafetyStock = true): Promise<StockReservation> {
    const result = await inTransaction(this.db, (tx) =>
      this.reserveItems(tx, [{ productId, quantity }], orderId, enforceSafetyStock));
    const reservation = result[0];
    if (!reservation) throw new Error('Reserva não retornada.');
    return reservation;
  }

  /** Usa a transação do pedido: pedido, reservas e ledger compartilham o mesmo commit. */
  async reserveItems(
    tx: Transaction, requests: readonly StockRequest[], orderId: string, enforceSafetyStock = true,
  ): Promise<StockReservation[]> {
    await requireWorkspace(tx, this.context);
    const grouped = new Map<string, number>();
    if (requests.length === 0) throw new HubError(422, 'INVALID_STOCK_QUANTITY', 'Informe ao menos um produto.');
    for (const request of requests) {
      const quantity = (grouped.get(request.productId) ?? 0) + request.quantity;
      if (!Number.isInteger(request.quantity) || request.quantity < 1 || quantity > MAX_INTEGER) {
        throw new HubError(422, 'INVALID_STOCK_QUANTITY', 'A quantidade deve ser um inteiro positivo suportado pelo banco.');
      }
      grouped.set(request.productId, quantity);
    }
    // Serializa reentradas do mesmo pedido, inclusive chamadas diretas a reserveStock.
    const [order] = await tx.select({ id: canonicalOrders.id, status: canonicalOrders.status }).from(canonicalOrders)
      .where(and(eq(canonicalOrders.workspaceId, this.context.workspaceId), eq(canonicalOrders.id, orderId))).for('update');
    if (!order) throw new HubError(404, 'CANONICAL_ORDER_NOT_FOUND', 'Pedido canônico não encontrado.');
    if (!['PENDING', 'PAID'].includes(order.status)) throw new HubError(409, 'ORDER_STATUS_NOT_RESERVABLE', 'O estado do pedido não permite reservas.');

    const existing = await tx.select({
      productId: inventoryLedger.productId, delta: inventoryLedger.delta,
      availableAfter: inventoryLedger.availableAfter, safetyStock: products.safetyStock,
    }).from(inventoryLedger).innerJoin(products, eq(products.id, inventoryLedger.productId))
      .where(and(eq(inventoryLedger.workspaceId, this.context.workspaceId), eq(inventoryLedger.orderId, orderId), eq(inventoryLedger.reason, 'SALE')));
    const reservations: StockReservation[] = [];
    // Comparação lexical explícita evita dependência de locale e deadlocks entre SKUs.
    for (const productId of [...grouped.keys()].sort()) {
      const quantity = grouped.get(productId)!;
      const previous = existing.find((entry) => entry.productId === productId);
      if (previous) {
        if (previous.delta !== -quantity) throw new HubError(409, 'RESERVATION_CONFLICT', 'O pedido já possui uma reserva com outra quantidade.');
        reservations.push({
          productId, quantity, availableAfter: previous.availableAfter,
          remainingAvailable: Math.max(0, previous.availableAfter - (enforceSafetyStock ? previous.safetyStock : 0)),
        });
        continue;
      }
      const safety = enforceSafetyStock ? sql`${products.safetyStock}` : sql`0`;
      const [updated] = await tx.update(products).set({
        reservedStock: sql`${products.reservedStock} + ${quantity}`,
        updatedAt: sql`now()`,
      }).where(and(eq(products.workspaceId, this.context.workspaceId), eq(products.id, productId),
        sql`(${products.currentStock} - ${products.reservedStock} - ${safety}) >= ${quantity}`,
      )).returning();
      if (!updated) throw new HubError(409, 'INSUFFICIENT_CANONICAL_STOCK', 'Estoque canônico insuficiente para concluir o pedido.');
      const availableAfter = updated.currentStock - updated.reservedStock;
      await tx.insert(inventoryLedger).values({ workspaceId: this.context.workspaceId, productId, orderId, delta: -quantity, reason: 'SALE', availableAfter });
      reservations.push({
        productId, quantity, availableAfter,
        remainingAvailable: Math.max(0, availableAfter - (enforceSafetyStock ? updated.safetyStock : 0)),
      });
    }
    return reservations;
  }

  /** Entrada física de ERP, deduplicada pelo UUID canônico da movimentação. */
  async restock(productId: string, quantity: number, movementId: string): Promise<CanonicalStockMovement> {
    if (!this.context.erpDestinationId) throw new HubError(422, 'ERP_DESTINATION_REQUIRED', 'Reposição exige destino ERP explícito.');
    await requireDestination(this.db, this.context, this.context.erpDestinationId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_INTEGER) {
      throw new HubError(422, 'INVALID_STOCK_QUANTITY', 'A reposição deve ser um inteiro positivo suportado pelo banco.');
    }
    try {
      return await inTransaction(this.db, async (tx) => {
        await requireWorkspace(tx, this.context);
        const [product] = await tx.select().from(products).where(and(eq(products.workspaceId, this.context.workspaceId), eq(products.id, productId))).for('update');
        if (!product) throw new HubError(404, 'CANONICAL_PRODUCT_NOT_FOUND', 'Produto canônico não encontrado.');
        const [previous] = await tx.select().from(inventoryLedger).where(and(eq(inventoryLedger.workspaceId, this.context.workspaceId), eq(inventoryLedger.id, movementId)));
        if (previous) {
          if (previous.productId !== productId || previous.delta !== quantity || previous.reason !== 'ERP_SYNC') {
            throw new HubError(409, 'STOCK_MOVEMENT_ID_CONFLICT', 'A movimentação já está associada a outra operação.');
          }
          if (previous.erpDestinationId !== this.context.erpDestinationId) throw new HubError(409, 'STOCK_MOVEMENT_ID_CONFLICT', 'Movimentação pertence a outro destino.');
          return canonicalMovement(previous, product.sku);
        }
        if (product.currentStock + quantity > MAX_INTEGER) throw new HubError(422, 'STOCK_LIMIT_EXCEEDED', 'A reposição excede o limite do banco.');
        const [updated] = await tx.update(products).set({
          currentStock: sql`${products.currentStock} + ${quantity}`, updatedAt: sql`now()`,
        }).where(and(eq(products.workspaceId, this.context.workspaceId), eq(products.id, productId))).returning();
        if (!updated) throw new Error('Produto não retornado após reposição.');
        const [movement] = await tx.insert(inventoryLedger).values({
          workspaceId: this.context.workspaceId, erpDestinationId: this.context.erpDestinationId, id: movementId, productId, delta: quantity, reason: 'ERP_SYNC',
          availableAfter: updated.currentStock - updated.reservedStock,
        }).returning();
        if (!movement) throw new Error('Movimentação não retornada após reposição.');
        return canonicalMovement(movement, product.sku);
      });
    } catch (error) {
      if (error instanceof HubError) throw error;
      // O mesmo UUID em produtos diferentes é resolvido pela PK; a operação perdedora faz rollback.
      if (sqlState(error) === '23505') throw new HubError(409, 'STOCK_MOVEMENT_ID_CONFLICT', 'Identificador de movimentação já utilizado.');
      throw error;
    }
  }

  async listInventory(limit = 50, offset = 0): Promise<{ data: InventoryProduct[]; limit: number; offset: number }> {
    await requireWorkspace(this.db, this.context);
    pagination(limit, offset);
    const data = await this.db.select({
      id: products.id, sku: products.sku, title: products.title, basePriceCents: products.basePriceCents,
      currentStock: products.currentStock, reservedStock: products.reservedStock, safetyStock: products.safetyStock,
      updatedAt: products.updatedAt,
      availableStock: sql<number>`greatest(0, ${products.currentStock} - ${products.reservedStock} - ${products.safetyStock})`,
    }).from(products).where(eq(products.workspaceId, this.context.workspaceId)).orderBy(asc(products.sku), asc(products.id)).limit(limit).offset(offset);
    return { data, limit, offset };
  }

  async getLedger(sku: string, limit = 50, offset = 0): Promise<{ data: CanonicalStockMovement[]; limit: number; offset: number }> {
    await requireWorkspace(this.db, this.context);
    pagination(limit, offset);
    const [product] = await this.db.select({ id: products.id }).from(products).where(and(eq(products.workspaceId, this.context.workspaceId), eq(products.sku, sku)));
    if (!product) throw new HubError(404, 'CANONICAL_PRODUCT_NOT_FOUND', 'SKU canônico não encontrado.');
    const rows = await this.db.select().from(inventoryLedger).where(and(eq(inventoryLedger.workspaceId, this.context.workspaceId), eq(inventoryLedger.productId, product.id)))
      .orderBy(desc(inventoryLedger.timestamp), desc(inventoryLedger.id)).limit(limit).offset(offset);
    return { data: rows.map((row) => canonicalMovement(row, sku)), limit, offset };
  }

  async resolveProducts(tx: Transaction, skus: readonly string[]) {
    const rows = await tx.select({ id: products.id, sku: products.sku }).from(products).where(and(eq(products.workspaceId, this.context.workspaceId), inArray(products.sku, [...new Set(skus)])));
    const productBySku = new Map(rows.map((row) => [row.sku, row.id]));
    if (skus.some((sku) => !productBySku.has(sku))) {
      throw new HubError(422, 'CANONICAL_PRODUCT_NOT_FOUND', 'Um ou mais SKUs não pertencem ao catálogo canônico.');
    }
    return productBySku;
  }
}
