import { createHash } from 'node:crypto';
import { AdapterError, emitCanonicalOrderToLegacyErp, type SpokeGateway } from '@omnihub/marketplace-adapters';
import { isCanonicalOrder } from '@omnihub/canonical-ir';
import { canonicalOrders, erpDispatches, pipelineJobs, products, spokeMappings, type Database, type JsonValue } from '@omnihub/database';
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { HubError } from '../errors';
import { OrderIngestionService, type IngestionResult } from '../services/order-ingestion.service';
import { ErpDispatchService } from '../services/erp-dispatch.service';
import { inTransaction } from '../services/transaction';

export function jsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
export function safeCode(error: unknown): string { return error instanceof HubError || error instanceof AdapterError ? error.code : 'PIPELINE_INTERNAL_ERROR'; }
export class CompilerPipeline {
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private syncTail: Promise<void> = Promise.resolve();
  constructor(readonly db: Database, readonly gateway: SpokeGateway, readonly dispatch: ErpDispatchService, readonly transportMode: 'OFFICIAL_TEST_USER' | 'LOCAL_FIXTURE' = 'OFFICIAL_TEST_USER') {}
  async enqueue(raw: unknown) {
    const reference = this.gateway.identifyNotification(raw);
    const fingerprint = createHash('sha256').update(`${this.transportMode}:${JSON.stringify(raw)}`).digest('hex');
    const [job] = await this.db.insert(pipelineJobs).values({ ...reference, fingerprint, transportMode: this.transportMode }).onConflictDoUpdate({ target: pipelineJobs.fingerprint, set: { receiptCount: sql`${pipelineJobs.receiptCount} + 1` } }).returning();
    return { accepted: true, processingId: job!.id };
  }
  start() { if (!this.timer) this.timer = setInterval(() => { void this.runOnce().catch(() => console.error(JSON.stringify({ event: 'pipeline_worker_failed' }))); }, 500); }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; while (this.busy) await Bun.sleep(20); }
  async runOnce(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const job = await inTransaction(this.db, async tx => {
        const [candidate] = await tx.select().from(pipelineJobs).where(and(eq(pipelineJobs.source,this.gateway.source),eq(pipelineJobs.transportMode,this.transportMode),or(eq(pipelineJobs.state, 'QUEUED'), and(eq(pipelineJobs.state, 'PROCESSING'), lt(pipelineJobs.leaseUntil, new Date()))))).orderBy(asc(pipelineJobs.createdAt), asc(pipelineJobs.id)).limit(1).for('update', { skipLocked: true });
        if (!candidate) return undefined;
        const [claimed] = await tx.update(pipelineJobs).set({ state: 'PROCESSING', leaseUntil: new Date(Date.now() + 120000), leaseToken: Bun.randomUUIDv7() }).where(eq(pipelineJobs.id, candidate.id)).returning();
        return claimed;
      });
      if (!job) return false;
      const heartbeat = setInterval(() => { void this.db.update(pipelineJobs).set({ leaseUntil: new Date(Date.now() + 120000) }).where(and(eq(pipelineJobs.id, job.id), eq(pipelineJobs.leaseToken, job.leaseToken!))).catch(() => {}); }, 30000);
      const times: Record<string, number> = {}; const begin = performance.now();
      let outcome: 'CREATED' | 'DUPLICATE' | 'CANCELLED' | 'REJECTED' = 'REJECTED';
      try {
        let start = performance.now(); const input = await this.gateway.loadOrder(job.externalOrderId); times.fetchMs = performance.now() - start;
        await this.db.update(pipelineJobs).set({ rawSnapshot: jsonValue(input.raw) }).where(eq(pipelineJobs.id, job.id));
        const ingestion = new OrderIngestionService(this.db);
        let result: IngestionResult;
        if (input.cancelled) {
          // Recurso autenticado cancela pelo identificador; não inventa cliente para fabricar IR.
          start=performance.now();result=await ingestion.cancel(job.source,job.externalOrderId);times.reserveMs=performance.now()-start;
        } else {
          const mappings = await this.db.select({ externalItemId: spokeMappings.externalItemId, externalVariantId: spokeMappings.externalVariantId, sku: products.sku }).from(spokeMappings).innerJoin(products, eq(products.id, spokeMappings.productId)).where(and(eq(spokeMappings.marketplace, job.source), eq(spokeMappings.syncEnabled, 'Y')));
          start = performance.now(); const parsed = input.parse({ canonicalOrderId: Bun.randomUUIDv7(), mappings }); times.parseMs = performance.now() - start;
          if (parsed.status !== 'PAID') throw new HubError(422,'ORDER_NOT_READY','O primeiro pipeline aceita vendas com pagamento confirmado.');
          start = performance.now(); if (!isCanonicalOrder(parsed)) throw new HubError(422, 'IR_SEMANTIC_VALIDATION_ERROR', 'IR inválida.'); times.validationMs = performance.now() - start;
          start=performance.now();result=await ingestion.ingest(parsed,jsonValue(input.raw));times.reserveMs=performance.now()-start;
        }
        const canonical = result.order;
        // Reentrega usa UUID e conteúdo canônico original, não o UUID novo do parser.
        outcome = input.cancelled ? 'CANCELLED' : result.duplicate && job.outcome !== 'CREATED' ? 'DUPLICATE' : 'CREATED';
        await this.db.update(pipelineJobs).set({ orderId: canonical.id, outcome, canonicalSnapshot: jsonValue(canonical) }).where(eq(pipelineJobs.id, job.id));
        // Divulgar saldo reservado mesmo se a entrega ERP esgotar tentativas.
        start = performance.now(); let syncFailed = false;
        try { await this.syncStock(canonical.items.map(i => i.sku)); } catch { syncFailed = true; }
        times.syncMs = performance.now() - start;
        if (canonical.status !== 'CANCELLED') {
          start = performance.now(); const emitted = emitCanonicalOrderToLegacyErp(canonical); times.emitMs = performance.now() - start;
          await this.db.insert(erpDispatches).values({ orderId: canonical.id, payload: jsonValue(emitted) }).onConflictDoNothing();
          const [stored] = await this.db.select().from(erpDispatches).where(eq(erpDispatches.orderId, canonical.id));
          await this.db.update(pipelineJobs).set({ erpSnapshot: stored!.payload }).where(eq(pipelineJobs.id, job.id));
          start = performance.now(); try { await this.dispatch.dispatch(canonical.id); } finally { times.erpMs = performance.now() - start; }
        }
        if (syncFailed) throw new HubError(503, 'SPOKE_SYNC_FAILED', 'Entrega concluída; sincronização de saldo pendente.');
        times.totalMs = performance.now() - begin;
        await this.db.update(pipelineJobs).set({ state: 'SUCCEEDED', outcome, timings: times, finishedAt: new Date(), leaseUntil: null, errorCode: null }).where(eq(pipelineJobs.id, job.id));
      } catch (error) {
        times.totalMs = performance.now() - begin;
        await this.db.update(pipelineJobs).set({ state: 'FAILED', outcome, errorCode: safeCode(error), timings: times, finishedAt: new Date(), leaseUntil: null }).where(eq(pipelineJobs.id, job.id));
      } finally { clearInterval(heartbeat); }
      return true;
    } finally { this.busy = false; }
  }
  async syncStock(skus: readonly string[]) {
    const previous = this.syncTail; let release: () => void = () => {};
    this.syncTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { await this.syncStockNow(skus); } finally { release(); }
  }
  private async syncStockNow(skus: readonly string[]) {
    const mappings = await this.db.select({ mapping: spokeMappings, product: products }).from(spokeMappings).innerJoin(products, eq(products.id, spokeMappings.productId))
      .where(and(eq(spokeMappings.marketplace, this.gateway.source), eq(spokeMappings.syncEnabled, 'Y'), inArray(products.sku, [...new Set(skus)])));
    let failed = false;
    for (const { mapping, product } of mappings) {
      try {
        await this.gateway.updateStock({ ...mapping, sku: product.sku }, Math.max(0, product.currentStock - product.reservedStock - product.safetyStock));
        await this.db.update(spokeMappings).set({ lastSyncedAt: new Date(), lastSyncError: null, lastSyncQuantity: Math.max(0, product.currentStock - product.reservedStock - product.safetyStock) }).where(eq(spokeMappings.id, mapping.id));
      } catch (error) { failed = true; await this.db.update(spokeMappings).set({ lastSyncError: safeCode(error) }).where(eq(spokeMappings.id, mapping.id)); }
    }
    if (failed) throw new HubError(503, 'SPOKE_SYNC_FAILED', 'Saldo local preservado; sincronização pendente.');
  }
}
