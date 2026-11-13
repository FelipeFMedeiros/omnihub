import { requireConnection, requireDestination, requireWorkspace, type WorkspaceContext } from './context';
import { canonicalOrders, erpAttempts, erpDispatches, pipelineJobs, products, spokeMappings, type Database } from '@omnihub/database';
import { inspectCanonicalSnapshot, inspectErpSnapshot, inspectRawSnapshot } from '@omnihub/marketplace-adapters';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { HubError } from '../errors';

export class OperationsService {
  constructor(private readonly db: Database, readonly context: WorkspaceContext) {}
  async orders(limit: number, offset: number) {
    await requireWorkspace(this.db, this.context);
    const rows = await this.db.select({ order: canonicalOrders, dispatch: erpDispatches }).from(canonicalOrders).leftJoin(erpDispatches, eq(erpDispatches.orderId, canonicalOrders.id)).where(eq(canonicalOrders.workspaceId, this.context.workspaceId)).orderBy(desc(canonicalOrders.createdAt), desc(canonicalOrders.id)).limit(limit).offset(offset);
    return { data: rows.map(({ order, dispatch }) => ({ id: order.id, connectionId: order.connectionId, source: order.source, externalOrderId: order.externalOrderId, status: order.status,
      totalAmountCents: order.totalAmountCents, createdAt: order.createdAt.toISOString(), reservationState: order.status === 'CANCELLED' ? 'RELEASED' : ['INVOICED', 'SHIPPED', 'DELIVERED'].includes(order.status) ? 'CONSUMED' : 'ACTIVE',
      dispatchState: dispatch?.state ?? 'NOT_STARTED', attempts: dispatch?.attempts ?? 0 })), limit, offset };
  }
  async jobs(limit: number, offset: number) {
    await requireWorkspace(this.db, this.context);
    const rows = await this.db.select().from(pipelineJobs).where(eq(pipelineJobs.workspaceId, this.context.workspaceId)).orderBy(desc(pipelineJobs.createdAt), desc(pipelineJobs.id)).limit(limit).offset(offset);
    return { data: rows.map(j => ({ id: j.id, connectionId: j.connectionId, orderId: j.orderId, source: j.source, transportMode: j.transportMode, externalOrderId: j.externalOrderId, state: j.state, outcome: j.outcome, errorCode: j.errorCode, receiptCount: j.receiptCount, createdAt: j.createdAt.toISOString(), finishedAt: j.finishedAt?.toISOString() ?? null })), limit, offset };
  }
  async trace(id: string) {
    await requireWorkspace(this.db, this.context);
    const [job] = await this.db.select().from(pipelineJobs).where(and(eq(pipelineJobs.workspaceId, this.context.workspaceId), eq(pipelineJobs.id, id)));
    if (!job) throw new HubError(404, 'PROCESSING_NOT_FOUND', 'Processamento não encontrado.');
    const attempts = job.orderId ? await this.db.select().from(erpAttempts).where(and(eq(erpAttempts.workspaceId, this.context.workspaceId), eq(erpAttempts.orderId, job.orderId))).orderBy(asc(erpAttempts.ordinal)) : [];
    const [dispatch] = job.orderId ? await this.db.select().from(erpDispatches).where(and(eq(erpDispatches.workspaceId, this.context.workspaceId), eq(erpDispatches.orderId, job.orderId))) : [];
    return { processingId: job.id, connectionId: job.connectionId, orderId: job.orderId, source: job.source, transportMode: job.transportMode, state: job.state, outcome: job.outcome, errorCode: job.errorCode,
      createdAt: job.createdAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null,
      snapshots: { raw: inspectRawSnapshot(job.source, job.rawSnapshot), canonical: inspectCanonicalSnapshot(job.canonicalSnapshot), erp: inspectErpSnapshot(job.erpSnapshot) },
      timingsMs: job.timings, dispatchState: dispatch?.state ?? 'NOT_STARTED',
      attempts: attempts.map(a => ({ ordinal: a.ordinal, httpStatus: a.httpStatus, outcome: a.outcome, durationMs: a.durationMs, startedAt: a.startedAt.toISOString(), finishedAt: a.finishedAt?.toISOString() ?? null })),
      redacted: true, timingScope: 'parseMs includes adapter output validation; validationMs is the independent IR gate; erpMs includes HTTP/backoff/local confirmation',
    };
  }
  async mappings(limit: number, offset: number) {
    await requireWorkspace(this.db, this.context);
    const rows = await this.db.select({ mapping: spokeMappings, sku: products.sku }).from(spokeMappings).innerJoin(products, eq(products.id, spokeMappings.productId)).where(eq(spokeMappings.workspaceId, this.context.workspaceId)).orderBy(asc(products.sku), asc(spokeMappings.id)).limit(limit).offset(offset);
    return { data: rows.map(({ mapping, sku }) => ({ ...mapping, sku, lastSyncedAt: mapping.lastSyncedAt?.toISOString() ?? null, implementation: mapping.marketplace === 'MERCADO_LIVRE' ? 'IMPLEMENTED' : 'NOT_IMPLEMENTED' })), limit, offset };
  }
  async retry(id: string) {
    return this.db.transaction(async tx => {
      await requireWorkspace(tx, this.context);
      const [job] = await tx.select().from(pipelineJobs).where(and(eq(pipelineJobs.workspaceId, this.context.workspaceId), eq(pipelineJobs.id,id)));
      if (!job) throw new HubError(404,'PROCESSING_NOT_FOUND','Processamento não encontrado.');
      if (job.state !== 'FAILED') throw new HubError(409,'PROCESSING_NOT_RETRYABLE','Somente processamento falho pode ser reenfileirado.');
      await requireConnection(tx, { ...this.context, connectionId: job.connectionId }, job.source);
      await requireDestination(tx, this.context, job.erpDestinationId);
      const [dispatch] = job.orderId ? await tx.select().from(erpDispatches).where(and(eq(erpDispatches.workspaceId, this.context.workspaceId), eq(erpDispatches.orderId,job.orderId))) : [];
      if (dispatch && !dispatch.protocol && ['EXHAUSTED','FAILED'].includes(dispatch.state)) throw new HubError(409,'ERP_RECONCILIATION_REQUIRED','Concilie o ERP; o orçamento não pode ser reiniciado.');
      const [created] = await tx.insert(pipelineJobs).values({ workspaceId: this.context.workspaceId, connectionId: job.connectionId, erpDestinationId: job.erpDestinationId, source:job.source,externalOrderId:job.externalOrderId,transportMode:job.transportMode,fingerprint:createHash('sha256').update(`${job.fingerprint}:${Bun.randomUUIDv7()}`).digest('hex') }).returning();
      return { processingId:created!.id,retryOf:id };
    });
  }
  async metrics(from: Date, to: Date) {
    await requireWorkspace(this.db, this.context);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > 31 * 86400000) throw new HubError(422, 'INVALID_METRIC_WINDOW', 'Use janela positiva de até 31 dias.');
    const jobs = await this.db.select().from(pipelineJobs).where(and(eq(pipelineJobs.workspaceId, this.context.workspaceId), gte(pipelineJobs.createdAt, from), lte(pipelineJobs.createdAt, to)));
    const acceptedIds = [...new Set(jobs.filter(j => j.outcome === 'CREATED' && j.orderId).map(j => j.orderId!))];
    const orders = acceptedIds.length ? await this.db.select({ order: canonicalOrders, dispatch: erpDispatches }).from(canonicalOrders).leftJoin(erpDispatches, eq(erpDispatches.orderId, canonicalOrders.id)).where(and(eq(canonicalOrders.workspaceId, this.context.workspaceId), inArray(canonicalOrders.id, acceptedIds))) : [];
    const delivered = orders.filter(r => r.dispatch?.state === 'CONFIRMED' && ['INVOICED', 'SHIPPED', 'DELIVERED'].includes(r.order.status)).length;
    const rejectionCodes = new Set(['ORDER_NOT_READY','INSUFFICIENT_CANONICAL_STOCK','ADAPTER_INVALID_PAYLOAD','ADAPTER_INVALID_CONTEXT','ADAPTER_ENRICHMENT_REQUIRED','ADAPTER_RESOURCE_MISMATCH','ADAPTER_UNSUPPORTED_ORDER','UNMAPPED_SPOKE_SKU','IR_SEMANTIC_VALIDATION_ERROR','CANONICAL_PRODUCT_NOT_FOUND','ORDER_NOT_CANCELLABLE','ORDER_STATUS_NOT_RESERVABLE']);
    const eligible = orders.filter(r => r.order.status !== 'CANCELLED').length;
    const durations = ['fetchMs', 'parseMs', 'validationMs', 'reserveMs', 'emitMs', 'erpMs', 'syncMs', 'totalMs'].map(stage => {
      const values = jobs.flatMap(j => typeof j.timings?.[stage] === 'number' ? [j.timings[stage]!] : []);
      return { stage, samples: values.length, averageMs: values.length ? values.reduce((a,b) => a+b,0) / values.length : null };
    });
    return { from: from.toISOString(), to: to.toISOString(), collectedAt: new Date().toISOString(), windowBasis: 'processing.createdAt; acceptedOrders are unique orders created by processings in this window',
      acceptedOrders: orders.length, receivedNotifications: jobs.reduce((sum,j) => sum+j.receiptCount,0), duplicateReceipts: jobs.reduce((sum,j)=>sum+j.receiptCount-1,0), duplicateOrders: jobs.filter(j=>j.outcome==='DUPLICATE').length,
      stockRejections: jobs.filter(j=>j.errorCode==='INSUFFICIENT_CANONICAL_STOCK').length, failedProcessings: jobs.filter(j=>j.state==='FAILED').length,
      rejectedProcessings: jobs.filter(j=>j.state==='FAILED' && rejectionCodes.has(j.errorCode ?? '')).length,
      technicalFailures: jobs.filter(j=>j.state==='FAILED' && !rejectionCodes.has(j.errorCode ?? '')).length,
      delivery: { confirmed: delivered, eligibleOrders: eligible, pendingOrFailed: eligible-delivered, rate: eligible ? delivered/eligible : null }, durations,
      transportModes: { officialProcessings: jobs.filter(j=>j.transportMode==='OFFICIAL_TEST_USER').length, localFixtureProcessings: jobs.filter(j=>j.transportMode==='LOCAL_FIXTURE').length },
      units: { counts: 'events_or_unique_orders_as_named', duration: 'milliseconds', rate: '0_to_1' },
    };
  }
}
