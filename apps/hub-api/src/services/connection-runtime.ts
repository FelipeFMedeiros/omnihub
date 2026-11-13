import { canonicalOrders, connections, erpDestinations, erpDispatches, pipelineJobs, workspaces, type Database } from '@omnihub/database';
import { localMeliGateway } from '@omnihub/marketplace-adapters';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { ErpTargetBinding } from '../config/runtime';
import { CompilerPipeline } from '../pipeline/compiler-pipeline';
import { HubError } from '../errors';
import { ErpDispatchService } from './erp-dispatch.service';
import { ConnectionsService } from './connections.service';
import type { WorkspaceContext } from './context';
import { approvedErpOrigin } from '../config/erp-target';

export class ConnectionRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private tick?: Promise<void>;
  private stopped = false;
  constructor(readonly db: Database, readonly service: ConnectionsService, readonly pipelines: CompilerPipeline[], readonly targets: readonly ErpTargetBinding[]) {}
  async reconcile() {
    const rows = await this.db.select({ connection: connections, destination: erpDestinations }).from(connections).innerJoin(erpDestinations, and(eq(erpDestinations.workspaceId, connections.workspaceId), eq(erpDestinations.state, 'ACTIVE'))).innerJoin(workspaces, and(eq(workspaces.id, connections.workspaceId), eq(workspaces.kind, 'ACCOUNT'))).where(and(eq(connections.state, 'ACTIVE'), eq(connections.credentialState, 'CONNECTED'), eq(connections.platform, 'MERCADO_LIVRE')));
    for (const { connection, destination } of rows) {
      const target = this.targets.find(t => t.workspaceId === connection.workspaceId && t.erpDestinationId === destination.id);
      if (!target || this.pipelines.some(p => p.context.connectionId === connection.id && p.context.erpDestinationId === destination.id)) continue;
      const context = { workspaceId: connection.workspaceId, connectionId: connection.id, source: connection.platform, transportMode: connection.transportMode, erpDestinationId: destination.id };
      const gateway = connection.transportMode === 'LOCAL_FIXTURE' ? localMeliGateway(connection.id) : this.service.store?.gateway(context, connection.id, connection.externalAccountId!);
      if (!gateway) continue;
      const pipeline = new CompilerPipeline(this.db, gateway, new ErpDispatchService(this.db, context, target), context);
      pipeline.publishStock = async skus => {
        const active = await this.db.select({ id: connections.id }).from(connections).where(and(eq(connections.workspaceId, context.workspaceId), eq(connections.state, 'ACTIVE'), eq(connections.credentialState, 'CONNECTED')));
        await Promise.all(this.pipelines.filter(p => p.context.workspaceId === context.workspaceId && p.context.erpDestinationId === context.erpDestinationId && p.transportMode === context.transportMode && active.some(c => c.id === p.context.connectionId)).map(p => p.syncStock(skus)));
      };
      this.pipelines.push(pipeline);
    }
  }
  start() {
    this.stopped = false;
    if (!this.timer) this.timer = setInterval(() => {
      if (this.tick || this.stopped) return;
      this.tick = (async () => { await this.reconcile(); for (const pipeline of this.pipelines) { try { await pipeline.runOnce(); } catch { /* Inactive bindings remain for history, never execute. */ } } })()
        .catch(() => console.error(JSON.stringify({ event: 'connection_runtime_failed' }))).finally(() => { this.tick = undefined; });
    }, 500);
  }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.tick; await Promise.all(this.pipelines.map(p => p.stop())); }
  async simulate(context: WorkspaceContext, id: string, scenario: 'PAID' | 'INVALID_TOTAL') {
    const row = await this.service.get(context, id);
    if (row.transportMode !== 'LOCAL_FIXTURE' || row.platform !== 'MERCADO_LIVRE') throw new HubError(409, 'SIMULATION_LOCAL_ONLY', 'Selecione uma conexão local implementada.');
    await this.reconcile();
    const [active] = await this.db.select().from(erpDestinations).where(and(eq(erpDestinations.workspaceId, context.workspaceId), eq(erpDestinations.state, 'ACTIVE')));
    const pipeline = this.pipelines.find(p => p.context.workspaceId === context.workspaceId && p.context.connectionId === id && p.context.erpDestinationId === active?.id);
    if (!pipeline) throw new HubError(409, 'SIMULATION_NOT_CONFIGURED', 'Selecione um destino ERP local permitido.');
    const orderId = `${BigInt(`0x${Bun.randomUUIDv7().replaceAll('-', '')}`)}${scenario === 'PAID' ? '1' : '2'}`;
    return { ...await pipeline.enqueue({ origin: 'LOCAL_FIXTURE_TASK014_V1', connectionId: id, orderId }), origin: 'LOCAL_FIXTURE_TASK014_V1', scenario };
  }
  async erpList(context: WorkspaceContext) {
    const allowed = this.targets.filter(t => t.workspaceId === context.workspaceId);
    const rows = await this.db.select().from(erpDestinations).where(eq(erpDestinations.workspaceId, context.workspaceId));
    return { data: rows.filter(row => allowed.some(t => t.erpDestinationId === row.id && t.configKey === row.configKey)).map(row => ({ id: row.id, name: row.configKey, state: row.state, contract: 'MOCK_ERP_V1' })) };
  }
  async selectErp(context: WorkspaceContext, id: string) {
    const target = this.targets.find(t => t.workspaceId === context.workspaceId && t.erpDestinationId === id);
    if (!target) throw new HubError(404, 'ERP_DESTINATION_NOT_FOUND', 'Destino ERP não permitido.');
    await this.db.transaction(async tx => {
      await tx.select().from(workspaces).where(eq(workspaces.id, context.workspaceId)).for('update');
      const [row] = await tx.select().from(erpDestinations).where(and(eq(erpDestinations.workspaceId, context.workspaceId), eq(erpDestinations.id, id), eq(erpDestinations.configKey, target.configKey), eq(erpDestinations.endpointOrigin, approvedErpOrigin(target.url)))).for('update');
      if (!row) throw new HubError(404, 'ERP_DESTINATION_NOT_FOUND', 'Destino ERP não permitido.');
      if (row.state === 'ACTIVE') return;
      const [pendingJob] = await tx.select({ id: pipelineJobs.id }).from(pipelineJobs).where(and(eq(pipelineJobs.workspaceId, context.workspaceId), inArray(pipelineJobs.state, ['QUEUED', 'PROCESSING', 'FAILED']))).limit(1);
      const [pendingDispatch] = await tx.select({ id: erpDispatches.orderId }).from(erpDispatches).innerJoin(canonicalOrders, eq(canonicalOrders.id, erpDispatches.orderId)).where(and(eq(erpDispatches.workspaceId, context.workspaceId), or(isNull(erpDispatches.protocol), eq(erpDispatches.state, 'PROCESSING'), eq(canonicalOrders.status, 'PAID')))).limit(1);
      if (pendingJob || pendingDispatch) throw new HubError(409, 'ERP_WORK_IN_PROGRESS', 'Concilie os trabalhos pendentes antes de trocar o ERP.');
      await tx.update(erpDestinations).set({ state: 'DISABLED' }).where(and(eq(erpDestinations.workspaceId, context.workspaceId), eq(erpDestinations.state, 'ACTIVE')));
      await tx.update(erpDestinations).set({ state: 'ACTIVE' }).where(eq(erpDestinations.id, id));
    });
    await this.reconcile(); return this.erpList(context);
  }
}
