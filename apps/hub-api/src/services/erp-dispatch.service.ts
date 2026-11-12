import { canonicalOrders, erpAttempts, erpDispatches, inventoryLedger, products, type Database, type JsonValue } from '@omnihub/database';
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { decodeLegacyErpOrder } from '@omnihub/marketplace-adapters';
import { HubError } from '../errors';
import { inTransaction } from './transaction';

export interface DispatchOptions {
  url: string; adminToken: string; timeoutMs?: number;
  transport?: (request: Request) => Promise<Response>; sleep?: (ms: number) => Promise<void>; random?: () => number;
}
export class ErpDispatchService {
  constructor(private readonly db: Database, private readonly options: DispatchOptions) {}
  async dispatch(orderId: string): Promise<void> {
    const claimed = await inTransaction(this.db, async tx => {
      const [order] = await tx.select().from(canonicalOrders).where(eq(canonicalOrders.id, orderId)).for('update');
      if (!order || !['PAID', 'INVOICED'].includes(order.status)) throw new HubError(409, 'ERP_ORDER_STATE_CONFLICT', 'Pedido indisponível para despacho.');
      const [record] = await tx.update(erpDispatches).set({ state: 'PROCESSING', leaseUntil: new Date(Date.now() + 120000) })
        .where(and(eq(erpDispatches.orderId, orderId), or(eq(erpDispatches.state, 'PENDING'), and(eq(erpDispatches.state, 'PROCESSING'), lt(erpDispatches.leaseUntil, new Date()))))).returning();
      return record;
    });
    if (!claimed) {
      const [record] = await this.db.select().from(erpDispatches).where(eq(erpDispatches.orderId, orderId));
      if (record?.protocol) return this.finalize(orderId);
      throw new HubError(503, record?.state === 'EXHAUSTED' ? 'ERP_RETRIES_EXHAUSTED' : record?.state === 'FAILED' ? 'ERP_PERMANENT_FAILURE' : 'ERP_DISPATCH_BUSY', 'Entrega ERP indisponível; reserva preservada.');
    }
    const payload = decodeLegacyErpOrder(claimed.payload);
    for (let ordinal = claimed.attempts + 1; ordinal <= 3; ordinal++) {
      if (ordinal > 1) await (this.options.sleep ?? Bun.sleep)(300 * 2 ** (ordinal - 2) + Math.floor((this.options.random ?? Math.random)() * 100));
      // O orçamento é reservado e auditado ANTES do HTTP; reinício não reinicia contagem.
      const attempt = await inTransaction(this.db, async tx => {
        const [updated] = await tx.update(erpDispatches).set({ attempts: ordinal, leaseUntil: new Date(Date.now() + 120000) })
          .where(and(eq(erpDispatches.orderId, orderId), eq(erpDispatches.state, 'PROCESSING'), eq(erpDispatches.attempts, ordinal - 1))).returning();
        if (!updated) throw new HubError(409, 'ERP_DISPATCH_CONFLICT', 'Despacho concorrente.');
        const [created] = await tx.insert(erpAttempts).values({ orderId, ordinal }).returning();
        return created!;
      });
      const started = performance.now(); let httpStatus: number | null = null, protocol: string | undefined;
      let outcome = 'NETWORK_ERROR', retryable = true;
      try {
        const response = await (this.options.transport ?? (r => fetch(r)))(new Request(`${this.options.url}/api/legacy/orders`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.adminToken}` }, body: JSON.stringify(payload),
        }));
        httpStatus = response.status; retryable = response.status === 429 || response.status >= 500;
        if (response.ok) {
          const text = await response.text();
          let body: unknown = null;
          try { if (text.length <= 65536) body = JSON.parse(text) as unknown; } catch { /* 2xx sem recibo válido não confirma faturamento. */ }
          if (body && typeof body === 'object' && 'status' in body && body.status === 'SUCESSO' && 'protocoloErp' in body && typeof body.protocoloErp === 'string' && /^FAT-[A-Za-z0-9-]{1,200}$/.test(body.protocoloErp)) protocol = body.protocoloErp;
          outcome = protocol ? 'CONFIRMED' : 'INVALID_RESPONSE'; retryable = false;
        } else { outcome = retryable ? 'TEMPORARY_FAILURE' : 'PERMANENT_FAILURE'; await response.body?.cancel(); }
      } catch { outcome = 'NETWORK_ERROR'; }
      await this.db.update(erpAttempts).set({ outcome, httpStatus, durationMs: Math.ceil(performance.now() - started), finishedAt: new Date() }).where(eq(erpAttempts.id, attempt.id));
      if (protocol) {
        await this.db.update(erpDispatches).set({ state: 'CONFIRMED', protocol, confirmedAt: new Date(), leaseUntil: null, errorCode: null }).where(eq(erpDispatches.orderId, orderId));
        return this.finalize(orderId);
      }
      if (!retryable || ordinal === 3) {
        await this.db.update(erpDispatches).set({ state: retryable ? 'EXHAUSTED' : 'FAILED', leaseUntil: null, errorCode: retryable ? 'ERP_RETRIES_EXHAUSTED' : 'ERP_PERMANENT_FAILURE' }).where(eq(erpDispatches.orderId, orderId));
        throw new HubError(503, retryable ? 'ERP_RETRIES_EXHAUSTED' : 'ERP_PERMANENT_FAILURE', 'Entrega não confirmada; reserva preservada.');
      }
    }
    await this.db.update(erpDispatches).set({ state: 'EXHAUSTED', errorCode: 'ERP_RETRIES_EXHAUSTED', leaseUntil: null }).where(eq(erpDispatches.orderId, orderId));
    throw new HubError(503, 'ERP_RETRIES_EXHAUSTED', 'Orçamento ERP esgotado; conciliação necessária.');
  }
  /** Somente SQL. Confirmação HTTP já foi persistida e não será reenviada. */
  async finalize(orderId: string) {
    await inTransaction(this.db, async tx => {
      const [order] = await tx.select().from(canonicalOrders).where(eq(canonicalOrders.id, orderId)).for('update');
      const [receipt] = await tx.select().from(erpDispatches).where(eq(erpDispatches.orderId, orderId));
      if (!order || !receipt?.protocol) throw new HubError(409, 'ERP_CONFIRMATION_MISSING', 'Confirmação ERP ausente.');
      if (order.status === 'INVOICED') return;
      if (order.status !== 'PAID') throw new HubError(409, 'ERP_ORDER_STATE_CONFLICT', 'Estado incompatível com faturamento.');
      const sales = await tx.select().from(inventoryLedger).where(and(eq(inventoryLedger.orderId, orderId), eq(inventoryLedger.reason, 'SALE'))).orderBy(asc(inventoryLedger.productId));
      for (const sale of sales) {
        const quantity = -sale.delta;
        if (!Number.isInteger(quantity) || quantity < 1) throw new HubError(409,'RESERVATION_STATE_CONFLICT','Quantidade reservada inválida.');
        const [product] = await tx.update(products).set({ currentStock: sql`${products.currentStock} - ${quantity}`, reservedStock: sql`${products.reservedStock} - ${quantity}`, updatedAt: sql`now()` })
          .where(and(eq(products.id, sale.productId), sql`${products.currentStock} >= ${quantity}`, sql`${products.reservedStock} >= ${quantity}`)).returning();
        if (!product) throw new HubError(409, 'RESERVATION_STATE_CONFLICT', 'Reserva incompatível com faturamento.');
        await tx.insert(inventoryLedger).values({ productId: product.id, orderId, delta: 0, reason: 'FULFILLMENT', availableAfter: product.currentStock - product.reservedStock });
      }
      await tx.update(canonicalOrders).set({ status: 'INVOICED' }).where(eq(canonicalOrders.id, orderId));
    });
  }
}
