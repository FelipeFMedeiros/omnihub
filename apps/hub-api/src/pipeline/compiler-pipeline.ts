import { requireWorker, type WorkerContext } from '../services/context';
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
  constructor(readonly db: Database, readonly gateway: SpokeGateway, readonly dispatch: ErpDispatchService, readonly context: WorkerContext) {
    if (context.source !== gateway.source || context.workspaceId !== dispatch.context.workspaceId || context.erpDestinationId !== dispatch.context.erpDestinationId) throw new Error('Worker context mismatch');
  }
  get transportMode() { return this.context.transportMode; }
  publishStock?: (skus: readonly string[]) => Promise<void>;
  private scope() { return and(eq(pipelineJobs.workspaceId, this.context.workspaceId), eq(pipelineJobs.connectionId, this.context.connectionId), eq(pipelineJobs.erpDestinationId, this.context.erpDestinationId)); }
  private async validate() {
    const connection = await requireWorker(this.db, this.context);
    if (connection.externalAccountId !== this.gateway.externalAccountId) throw new HubError(409, 'CONNECTION_IDENTITY_MISMATCH', 'Identidade do gateway incompatível.');
  }
  async enqueue(raw: unknown) {
    await this.validate();
    const reference = this.gateway.identifyNotification(raw);
    if (reference.source !== this.context.source) throw new HubError(422, 'CONNECTION_SOURCE_MISMATCH', 'Origem incompatível.');
    const fingerprint = createHash('sha256').update(`${this.transportMode}:${JSON.stringify(raw)}`).digest('hex');
    const job = await inTransaction(this.db, async tx => {
      await requireWorker(tx, this.context);
      const [row] = await tx.insert(pipelineJobs).values({ ...this.context, ...reference, fingerprint }).onConflictDoUpdate({ target: [pipelineJobs.workspaceId, pipelineJobs.connectionId, pipelineJobs.transportMode, pipelineJobs.fingerprint], set: { receiptCount: sql`${pipelineJobs.receiptCount} + 1` } }).returning();
      return row;
    });
    return { accepted: true, processingId: job!.id };
  }
  start() { if (!this.timer) this.timer = setInterval(() => { void this.runOnce().catch(() => console.error(JSON.stringify({ event: 'pipeline_worker_failed' }))); }, 500); }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; while (this.busy) await Bun.sleep(20); }
  async runOnce(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await this.validate();
      const job = await inTransaction(this.db, async tx => {
        await requireWorker(tx, this.context);
        const [candidate] = await tx.select().from(pipelineJobs).where(and(this.scope(), eq(pipelineJobs.source,this.gateway.source),eq(pipelineJobs.transportMode,this.transportMode),or(eq(pipelineJobs.state, 'QUEUED'), and(eq(pipelineJobs.state, 'PROCESSING'), lt(pipelineJobs.leaseUntil, new Date()))))).orderBy(asc(pipelineJobs.createdAt), asc(pipelineJobs.id)).limit(1).for('update', { skipLocked: true });
        if (!candidate) return undefined;
        const [claimed] = await tx.update(pipelineJobs).set({ state: 'PROCESSING', leaseUntil: new Date(Date.now() + 120000), leaseToken: Bun.randomUUIDv7() }).where(eq(pipelineJobs.id, candidate.id)).returning();
        return claimed;
      });
      if (!job) return false;
      const ownedJob = and(this.scope(), eq(pipelineJobs.id, job.id), eq(pipelineJobs.leaseToken, job.leaseToken!));
      const heartbeat = setInterval(() => { void this.db.update(pipelineJobs).set({ leaseUntil: new Date(Date.now() + 120000) }).where(ownedJob).catch(() => {}); }, 30000);
      const times: Record<string, number> = {}; const begin = performance.now();
      let outcome: 'CREATED' | 'DUPLICATE' | 'CANCELLED' | 'REJECTED' = 'REJECTED';
      try {
        let start = performance.now(); const input = await this.gateway.loadOrder(job.externalOrderId); times.fetchMs = performance.now() - start;
        await this.db.update(pipelineJobs).set({ rawSnapshot: jsonValue(input.raw) }).where(ownedJob);
        const ingestion = new OrderIngestionService(this.db, this.context);
        let result: IngestionResult;
        if (input.cancelled) {
          // Recurso autenticado cancela pelo identificador; não inventa cliente para fabricar IR.
          start=performance.now();result=await ingestion.cancel(job.source,job.externalOrderId);times.reserveMs=performance.now()-start;
        } else {
          const mappings = await this.db.select({ externalItemId: spokeMappings.externalItemId, externalVariantId: spokeMappings.externalVariantId, sku: products.sku }).from(spokeMappings).innerJoin(products, eq(products.id, spokeMappings.productId)).where(and(eq(spokeMappings.workspaceId, this.context.workspaceId), eq(spokeMappings.connectionId, this.context.connectionId), eq(spokeMappings.marketplace, job.source), eq(spokeMappings.syncEnabled, 'Y')));
          start = performance.now(); const parsed = input.parse({ canonicalOrderId: Bun.randomUUIDv7(), mappings }); times.parseMs = performance.now() - start;
          if (parsed.status !== 'PAID') throw new HubError(422,'ORDER_NOT_READY','O primeiro pipeline aceita vendas com pagamento confirmado.');
          start = performance.now(); if (!isCanonicalOrder(parsed)) throw new HubError(422, 'IR_SEMANTIC_VALIDATION_ERROR', 'IR inválida.'); times.validationMs = performance.now() - start;
          start=performance.now();result=await ingestion.ingest(parsed,jsonValue(input.raw));times.reserveMs=performance.now()-start;
        }
        const canonical = result.order;
        // Reentrega usa UUID e conteúdo canônico original, não o UUID novo do parser.
        outcome = input.cancelled ? 'CANCELLED' : result.duplicate && job.outcome !== 'CREATED' ? 'DUPLICATE' : 'CREATED';
        await this.db.update(pipelineJobs).set({ orderId: canonical.id, outcome, canonicalSnapshot: jsonValue(canonical) }).where(ownedJob);
        // Divulgar saldo reservado mesmo se a entrega ERP esgotar tentativas.
        start = performance.now(); let syncFailed = false;
        try { await (this.publishStock ?? (skus => this.syncStock(skus)))(canonical.items.map(i => i.sku)); } catch { syncFailed = true; }
        times.syncMs = performance.now() - start;
        if (canonical.status !== 'CANCELLED') {
          start = performance.now(); const emitted = emitCanonicalOrderToLegacyErp(canonical, `oh:${this.context.workspaceId}:${this.context.connectionId}:${canonical.externalOrderId}`); times.emitMs = performance.now() - start;
          await this.db.insert(erpDispatches).values({ workspaceId: this.context.workspaceId, erpDestinationId: this.context.erpDestinationId, externalIdempotencyKey: emitted.codigo_pedido, orderId: canonical.id, payload: jsonValue(emitted) }).onConflictDoNothing();
          const [stored] = await this.db.select().from(erpDispatches).where(eq(erpDispatches.orderId, canonical.id));
          await this.db.update(pipelineJobs).set({ erpSnapshot: stored!.payload }).where(ownedJob);
          start = performance.now(); try { await this.dispatch.dispatch(canonical.id); } finally { times.erpMs = performance.now() - start; }
        }
        if (syncFailed) throw new HubError(503, 'SPOKE_SYNC_FAILED', 'Entrega concluída; sincronização de saldo pendente.');
        times.totalMs = performance.now() - begin;
        await this.db.update(pipelineJobs).set({ state: 'SUCCEEDED', outcome, timings: times, finishedAt: new Date(), leaseUntil: null, errorCode: null }).where(ownedJob);
      } catch (error) {
        times.totalMs = performance.now() - begin;
        await this.db.update(pipelineJobs).set({ state: 'FAILED', outcome, errorCode: safeCode(error), timings: times, finishedAt: new Date(), leaseUntil: null }).where(ownedJob);
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
    await this.validate();
    const mappings = await this.db.select({ mapping: spokeMappings, product: products }).from(spokeMappings).innerJoin(products, eq(products.id, spokeMappings.productId))
      .where(and(eq(spokeMappings.workspaceId, this.context.workspaceId), eq(spokeMappings.connectionId, this.context.connectionId), eq(spokeMappings.marketplace, this.gateway.source), eq(spokeMappings.syncEnabled, 'Y'), inArray(products.sku, [...new Set(skus)])));
    let failed = false;
    for (const { mapping, product } of mappings) {
      try {
        await this.validate();
        await this.gateway.updateStock({ ...mapping, sku: product.sku }, Math.max(0, product.currentStock - product.reservedStock - product.safetyStock));
        await this.db.update(spokeMappings).set({ lastSyncedAt: new Date(), lastSyncError: null, lastSyncQuantity: Math.max(0, product.currentStock - product.reservedStock - product.safetyStock) }).where(eq(spokeMappings.id, mapping.id));
      } catch (error) { failed = true; await this.db.update(spokeMappings).set({ lastSyncError: safeCode(error) }).where(eq(spokeMappings.id, mapping.id)); }
    }
    if (failed) throw new HubError(503, 'SPOKE_SYNC_FAILED', 'Saldo local preservado; sincronização pendente.');
  }
}
