import { describe, expect, test } from 'bun:test';
import { authSessions, canonicalOrders, connections, erpAttempts, erpDestinations, erpDispatches, inventoryLedger, legacyClaims, pipelineJobs, products, spokeMappings, users, workspaces } from '@omnihub/database';
import { AdapterError, signInternalBody, type SpokeGateway } from '@omnihub/marketplace-adapters';
import { and, eq, inArray } from 'drizzle-orm';
import { createMockErp } from '../../mock-erp/src/app';
import { createApp } from '../src/app';
import { loadSecurityEnv } from '../src/config/security';
import { createRuntime, validateTargetBindings, type ErpTargetBinding } from '../src/config/runtime';
import { CompilerPipeline } from '../src/pipeline/compiler-pipeline';
import { AuthService } from '../src/plugins/auth';
import { InventoryService } from '../src/services/inventory.service';
import { OrderIngestionService } from '../src/services/order-ingestion.service';
import { OperationsService } from '../src/services/operations.service';
import { ErpDispatchService } from '../src/services/erp-dispatch.service';
import { claimLegacy } from '../src/services/legacy-claim.service';
import type { WorkerContext } from '../src/services/context';
import { databaseFixture, testDatabaseUrl } from './helpers';

const operator = 'task013-local-operator-'.repeat(3), origin = 'http://localhost:5173';
const security = loadSecurityEnv({ NODE_ENV: 'test', PUBLIC_HUB_URL: 'http://localhost', CORS_ORIGINS: origin, JWT_SECRET: 'task013-jwt-fixture-'.repeat(3), CLOUDFLARE_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' });
const approved = async () => Response.json({ success: true, hostname: 'example.com' });

describe.skipIf(!testDatabaseUrl)('TASK-013 — dois negócios, várias lojas e fronteiras relacionais', () => {
  const a = databaseFixture(), b = databaseFixture();
  const inventory = (f: typeof a) => new InventoryService(f.db, f.context);
  const ingestion = (f: typeof a) => new OrderIngestionService(f.db, f.context);
  const balances = async (f: typeof a) => (await inventory(f).listInventory(100)).data;

  test('15 reservas simultâneas em CADA negócio com o mesmo SKU e IDs externos: 5 sucessos e 10 conflitos por negócio', async () => {
    await a.product(5, 0, 'SHARED-SKU'); await b.product(5, 0, 'SHARED-SKU');
    const batches = [a,b].map(f => Promise.allSettled(Array.from({ length: 15 }, (_, n) => ingestion(f).ingest(f.order([{ sku: 'SHARED-SKU' }], { externalOrderId: `same-order-${n}` }), { synthetic: true }))));
    const results = await Promise.all(batches);
    for (const [i, f] of [a,b].entries()) {
      const result = results[i]!;
      expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(5);
      const rejected = result.filter(r => r.status === 'rejected'); expect(rejected).toHaveLength(10);
      for (const r of rejected) expect(r.reason).toMatchObject({ status: 409, code: 'INSUFFICIENT_CANONICAL_STOCK' });
      expect(await balances(f)).toMatchObject([{ sku: 'SHARED-SKU', currentStock: 5, reservedStock: 5, availableStock: 0 }]);
      expect((await inventory(f).getLedger('SHARED-SKU')).data).toHaveLength(5);
    }
  });

  test('rollback multi-item, duplicatas MANUAL/NULL, cancelamento e reposição preservam a fronteira', async () => {
    for (const f of [a,b]) {
      const first = await f.product(5, 0, 'SAME-FIRST'), last = await f.product(0, 0, 'SAME-LAST');
      const service = ingestion(f), order = f.order([{ sku: first.sku }, { sku: last.sku }], { externalOrderId: 'same-multi' });
      await expect(service.ingest(order, {})).rejects.toMatchObject({ code: 'INSUFFICIENT_CANONICAL_STOCK' });
      expect((await balances(f)).find(p => p.id === first.id)?.reservedStock).toBe(0);
      const single = f.order([{ sku: first.sku }], { externalOrderId: 'same-manual' });
      expect((await service.ingest(single, { original: true })).status).toBe(201);
      expect((await service.ingest(f.order([{ sku: first.sku }], { externalOrderId: 'same-manual' }), { changed: true })).duplicate).toBe(true);
      await service.cancel('MANUAL', 'same-manual'); await service.cancel('MANUAL', 'same-manual');
      const move = Bun.randomUUIDv7();
      const movement = await inventory(f).restock(first.id, 2, move); await inventory(f).restock(first.id, 2, move);
      expect(movement).not.toHaveProperty('workspaceId'); expect(movement).not.toHaveProperty('erpDestinationId');
      expect((await balances(f)).find(p => p.id === first.id)).toMatchObject({ currentStock: 7, reservedStock: 0 });
    }
    const foreign = (await balances(b))[0]!;
    await expect(inventory(a).restock(foreign.id, 1, Bun.randomUUIDv7())).rejects.toMatchObject({ status: 404 });
    await expect(ingestion(a).cancel('MANUAL', 'does-not-exist')).rejects.toMatchObject({ status: 404 });
  });

  async function setupPipelines(exhaustA = false) {
    const pa = await a.product(5, 0, 'PIPELINE-SAME'), pb = await b.product(5, 0, 'PIPELINE-SAME');
    const secondId = Bun.randomUUIDv7();
    await a.db.insert(connections).values({ id: secondId, workspaceId: a.context.workspaceId, platform: 'MERCADO_LIVRE', transportMode: 'LOCAL_FIXTURE', state: 'ACTIVE', name: 'Second same-channel store', externalAccountId: `fixture-${secondId}` });
    await a.db.update(erpDestinations).set({ endpointOrigin: 'http://127.0.0.1:33920' }).where(eq(erpDestinations.id,a.workerContext.erpDestinationId));
    await b.db.update(erpDestinations).set({ endpointOrigin: 'http://127.0.0.1:33921' }).where(eq(erpDestinations.id,b.workerContext.erpDestinationId));
    const contexts: WorkerContext[] = [a.workerContext, { ...a.workerContext, connectionId: secondId }, b.workerContext];
    const updates = new Map<string, number[]>(), sends = new Map<string, number>();
    const targets: ErpTargetBinding[] = [a,b].map((f, n) => {
      const erp = createMockErp({ adminToken: operator, webhookSecret: `task013-hmac-${n}-`.repeat(4), hubWebhookUrl: `http://localhost/api/webhooks/erp-stock/${f.workerContext.erpDestinationId}`, warehouse: new Map([['PIPELINE-SAME',5]]), chaos: { minMs: 0, maxMs: 0, failureRate: 0, sequence: n === 0 && exhaustA ? [503,503,503,200] : [] }, sleep: async () => {} });
      return { workspaceId: f.context.workspaceId, erpDestinationId: f.workerContext.erpDestinationId, configKey: f.configKey, url: `http://127.0.0.1:${33920+n}`, adminToken: operator, webhookSecret: `task013-hmac-${n}-`.repeat(4), sleep: async () => {}, transport: async request => {
        if (request.method === 'POST') sends.set(f.context.workspaceId, (sends.get(f.context.workspaceId) ?? 0) + 1);
        return erp.handle(request);
      } };
    });
    const pipelines: CompilerPipeline[] = [];
    for (const context of contexts) {
      const f = context.workspaceId === a.context.workspaceId ? a : b;
      const gateway: SpokeGateway = {
        source: 'MERCADO_LIVRE', externalAccountId: `fixture-${context.connectionId}`,
        identifyNotification(raw) {
          if (!raw || typeof raw !== 'object' || !('account' in raw) || raw.account !== this.externalAccountId || !('orderId' in raw) || typeof raw.orderId !== 'string') throw new AdapterError('ADAPTER_RESOURCE_MISMATCH','Synthetic transport identity mismatch',403);
          return { source: this.source, externalOrderId: raw.orderId };
        },
        async loadOrder(id) { return { raw: { synthetic: true, id }, parse: () => f.order([{ sku: 'PIPELINE-SAME' }], { source: 'MERCADO_LIVRE', externalOrderId: id }) }; },
        async updateStock(_mapping, quantity) { const list = updates.get(context.connectionId) ?? []; list.push(quantity); updates.set(context.connectionId,list); },
        async checkConnection() { return { testUser: true }; },
      };
      await a.db.insert(spokeMappings).values({ workspaceId: context.workspaceId, connectionId: context.connectionId, productId: f === a ? pa.id : pb.id, marketplace: 'MERCADO_LIVRE', externalItemId: 'MLB123456', syncEnabled: 'Y' });
      const target = targets.find(t => t.workspaceId === context.workspaceId)!;
      pipelines.push(new CompilerPipeline(f.db, gateway, new ErpDispatchService(f.db, context, target), context));
    }
    const runtime = { adminToken: operator, webhookSecret: '', erpUrl: '', mockAdminToken: '', pipelines, erpTargets: targets };
    const app = createApp({ db: a.db, runtime, security, siteverifyFetch: approved });
    const cli = (f: typeof a, path: string, method = 'GET', body?: unknown) => app.handle(new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${operator}`, 'x-workspace-id': f.context.workspaceId, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const enqueue = async (index: number, extras: Record<string, unknown> = {}) => {
      const pipeline = pipelines[index]!;
      const response = await app.handle(new Request('http://localhost/api/webhooks/meli', { method: 'POST', body: JSON.stringify({ account: pipeline.gateway.externalAccountId, orderId: 'same-external-order', ...extras }) }));
      expect(response.status).toBe(200); const result = await response.json() as { processingId: string };
      (index === 2 ? b : a).trackProcessing(result.processingId); return result.processingId;
    };
    return { app, cli, enqueue, pipelines, contexts, targets, pa, pb, updates, sends };
  }

  test('duas lojas do mesmo canal e outro negócio aceitam IDs iguais; saldo, snapshots, métricas, caches e chaves ERP independentes', async () => {
    const h = await setupPipelines();
    const first = await h.enqueue(0, { workspaceId: b.context.workspaceId });
    expect(await h.enqueue(0, { workspaceId: b.context.workspaceId })).toBe(first);
    const second = await h.enqueue(1), third = await h.enqueue(2);
    expect(new Set([first,second,third]).size).toBe(3);
    // A worker cannot claim a different connection or workspace, even on the same channel/mode.
    await h.pipelines[1]!.runOnce(); expect((await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id, first)))[0]?.state).toBe('QUEUED');
    await h.pipelines[0]!.runOnce(); await h.pipelines[2]!.runOnce();
    expect(await balances(a)).toMatchObject([{ currentStock: 3, reservedStock: 0 }]);
    expect(await balances(b)).toMatchObject([{ currentStock: 4, reservedStock: 0 }]);
    const ordersA = await new OperationsService(a.db,a.context).orders(100,0), ordersB = await new OperationsService(b.db,b.context).orders(100,0);
    expect(ordersA.data).toHaveLength(2); expect(ordersB.data).toHaveLength(1);
    const dispatches = await a.db.select().from(erpDispatches).where(inArray(erpDispatches.orderId, [...ordersA.data,...ordersB.data].map(o => o.id)));
    expect(new Set(dispatches.map(d => d.externalIdempotencyKey)).size).toBe(3);
    for (const row of dispatches) expect(row.erpDestinationId).toBe(row.workspaceId === a.context.workspaceId ? a.workerContext.erpDestinationId : b.workerContext.erpDestinationId);
    const metricsA = await (await h.cli(a,'/api/v1/dashboard/metrics')).json() as { acceptedOrders: number; receivedNotifications: number };
    const metricsB = await (await h.cli(b,'/api/v1/dashboard/metrics')).json() as { acceptedOrders: number; receivedNotifications: number };
    expect(metricsA).toMatchObject({ acceptedOrders: 2, receivedNotifications: 3 }); expect(metricsB).toMatchObject({ acceptedOrders: 1, receivedNotifications: 1 });
    expect((await h.cli(b,`/api/v1/dashboard/processings/${first}`)).status).toBe(404);
    expect((await h.cli(b,`/api/v1/dashboard/processings/${first}/retry`,'POST')).status).toBe(404);
    const trace = await (await h.cli(a,`/api/v1/dashboard/processings/${first}`)).json() as { connectionId: string; attempts: unknown[] };
    expect(trace.connectionId).toBe(a.workerContext.connectionId); expect(trace.attempts).toHaveLength(1);
    await h.cli(a,'/api/v1/dashboard/connections/check','POST');
    const ca = await (await h.cli(a,'/api/v1/dashboard/connections')).json() as { data: { status: string }[] };
    const cb = await (await h.cli(b,'/api/v1/dashboard/connections')).json() as { data: { status: string }[] };
    expect(ca.data.some(c => c.status === 'AVAILABLE')).toBe(true); expect(cb.data.some(c => c.status === 'AVAILABLE')).toBe(false);
    expect(h.updates.get(h.contexts[0]!.connectionId)).toContain(3); expect(h.updates.get(h.contexts[1]!.connectionId)).toContain(3); expect(h.updates.get(h.contexts[2]!.connectionId)).toEqual([4]);
  });

  test('callback ERP autenticado fixa destino; evento A não pode ser desviado para B', async () => {
    const h = await setupPipelines(), ta = h.targets[0]!, tb = h.targets[1]!;
    const raw = JSON.stringify({ movementId: Bun.randomUUIDv7(), sku: 'PIPELINE-SAME', quantity: 2 });
    const send = (target: ErpTargetBinding, body: string, secret = target.webhookSecret) => h.app.handle(new Request(`http://localhost/api/webhooks/erp-stock/${target.erpDestinationId}`, { method: 'POST', headers: { 'x-erp-signature': signInternalBody(body,secret) }, body }));
    expect((await send(tb,raw,ta.webhookSecret)).status).toBe(403);
    expect((await send(ta,'{invalid','bad')).status).toBe(403);
    expect((await send(ta,raw)).status).toBe(200); expect((await send(ta,raw)).status).toBe(200);
    const forged = JSON.stringify({ ...JSON.parse(raw), workspaceId: b.context.workspaceId });
    expect((await send(ta,forged)).status).toBe(422);
    expect(await balances(a)).toMatchObject([{ currentStock: 7 }]); expect(await balances(b)).toMatchObject([{ currentStock: 5 }]);
    expect(() => validateTargetBindings([ta,{ ...tb, url: ta.url }])).toThrow();
    expect(() => validateTargetBindings([ta,{ ...tb, webhookSecret: ta.webhookSecret }])).toThrow();
  });

  test('cancelamento com o mesmo ID externo libera somente a loja e o negócio de origem', async () => {
    const h = await setupPipelines();
    const orders: ReturnType<typeof a.order>[] = [];
    for (const context of h.contexts) {
      const f = context.workspaceId === a.context.workspaceId ? a : b;
      const order = f.order([{ sku: 'PIPELINE-SAME' }],{ source: 'MERCADO_LIVRE', externalOrderId: 'same-cancellation' });
      await new OrderIngestionService(f.db,context).ingest(order,{}); orders.push(order);
    }
    const service = new OrderIngestionService(a.db,h.contexts[0]!);
    expect((await service.cancel('MERCADO_LIVRE','same-cancellation')).duplicate).toBe(false);
    expect((await service.cancel('MERCADO_LIVRE','same-cancellation')).duplicate).toBe(true);
    expect(await balances(a)).toMatchObject([{ currentStock: 5, reservedStock: 1 }]); expect(await balances(b)).toMatchObject([{ currentStock: 5, reservedStock: 1 }]);
    const stored = await a.db.select().from(canonicalOrders).where(inArray(canonicalOrders.id,orders.map(o => o.id)));
    expect(stored.find(o => o.id === orders[0]!.id)?.status).toBe('CANCELLED');
    expect(stored.filter(o => o.status === 'PAID')).toHaveLength(2);
  });

  test('retomada após terceira tentativa ambígua mantém reserva e não envia uma quarta chamada em nenhum negócio', async () => {
    for (const f of [a,b]) {
      await f.db.update(erpDestinations).set({ endpointOrigin: f.erpUrl }).where(eq(erpDestinations.id,f.workerContext.erpDestinationId));
      const product = await f.product(5,0,'SAME-AMBIGUOUS'), order = f.order([{ sku: product.sku }],{ externalOrderId: 'same-last-attempt' });
      await ingestion(f).ingest(order,{});
      await f.db.insert(erpDispatches).values({ ...f.dispatchValues(order), attempts: 3, state: 'PROCESSING', leaseUntil: new Date(0) });
      await f.db.insert(erpAttempts).values([1,2,3].map(ordinal => ({ workspaceId: f.context.workspaceId, erpDestinationId: f.workerContext.erpDestinationId, orderId: order.id, ordinal, outcome: ordinal === 3 ? 'STARTED' : 'TEMPORARY_FAILURE' })));
      let calls = 0;
      const dispatch = new ErpDispatchService(f.db,f.workerContext,{ configKey: f.configKey, url: f.erpUrl, adminToken: operator, transport: async () => { calls++; return Response.json({ status: 'SUCESSO', protocoloErp: 'FAT-must-not-send' }); } });
      await expect(dispatch.dispatch(order.id)).rejects.toMatchObject({ code: 'ERP_RETRIES_EXHAUSTED' });
      expect(calls).toBe(0); expect(await balances(f)).toMatchObject([{ currentStock: 5, reservedStock: 1 }]);
      await expect(f.client`UPDATE erp_destinations SET endpoint_origin='http://127.0.0.1:39999' WHERE id=${f.workerContext.erpDestinationId}`.execute()).rejects.toMatchObject({ code: '23514' });
      const mismatched = new ErpDispatchService(f.db,f.workerContext,{ configKey: f.configKey, url: 'http://127.0.0.1:39999', adminToken: operator, transport: async () => { calls++; return Response.json({}); } });
      await expect(mismatched.dispatch(order.id)).rejects.toMatchObject({ code: 'ERP_DESTINATION_CONFIG_MISMATCH' }); expect(calls).toBe(0);
    }
  });

  test('esgotamento e leases retomados mantêm três envios totais; retry e destino não reiniciam orçamento', async () => {
    const h = await setupPipelines(true), id = await h.enqueue(0);
    await a.db.update(pipelineJobs).set({ state: 'PROCESSING', leaseUntil: new Date(0) }).where(eq(pipelineJobs.id,id));
    expect(await h.pipelines[2]!.runOnce()).toBe(false);
    await h.pipelines[0]!.runOnce();
    const [job] = await a.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,id)); expect(job?.errorCode).toBe('ERP_RETRIES_EXHAUSTED');
    const target = h.targets[0]!, restarted = new ErpDispatchService(a.db,a.workerContext,target);
    await expect(restarted.dispatch(job!.orderId!)).rejects.toMatchObject({ code: 'ERP_RETRIES_EXHAUSTED' });
    expect(h.sends.get(a.context.workspaceId)).toBe(3); expect(h.sends.get(b.context.workspaceId)).toBeUndefined();
    expect((await h.cli(a,`/api/v1/dashboard/processings/${id}/retry`,'POST')).status).toBe(409);
    await expect(a.client`UPDATE erp_dispatches SET attempts=0 WHERE order_id=${job!.orderId!}`.execute()).rejects.toMatchObject({ code: '23514' });
    await expect(a.client`UPDATE erp_dispatches SET external_idempotency_key='changed',payload=jsonb_set(payload,'{codigo_pedido}','"changed"') WHERE order_id=${job!.orderId!}`.execute()).rejects.toMatchObject({ code: '23514' });
    expect((await a.db.select().from(erpAttempts).where(eq(erpAttempts.orderId,job!.orderId!)))).toHaveLength(3);
    expect(await balances(a)).toMatchObject([{ currentStock: 5, reservedStock: 1 }]); expect(await balances(b)).toMatchObject([{ currentStock: 5, reservedStock: 0 }]);
  });

  test('SQL direto rejeita vínculos cruzados, origens/NULL incoerentes e conta externa duplicada', async () => {
    const pa = await a.product(), pb = await b.product();
    const oa = a.order([{ sku: pa.sku }]), ob = b.order([{ sku: pb.sku }]);
    await ingestion(a).ingest(oa,{}); await ingestion(b).ingest(ob,{});
    const uid = () => Bun.randomUUIDv7();
    await expect(a.client`INSERT INTO spoke_mappings(id,workspace_id,connection_id,product_id,marketplace,external_item_id) VALUES (${uid()},${b.context.workspaceId},${b.workerContext.connectionId},${pa.id},'MERCADO_LIVRE','same-item')`.execute()).rejects.toMatchObject({ code: '23503' });
    await expect(a.client`INSERT INTO inventory_ledger(id,workspace_id,product_id,order_id,delta,reason,available_after) VALUES (${uid()},${a.context.workspaceId},${pa.id},${ob.id},-1,'SALE',1)`.execute()).rejects.toMatchObject({ code: '23503' });
    await expect(a.client`INSERT INTO inventory_ledger(id,workspace_id,product_id,delta,reason,available_after) VALUES (${uid()},${a.context.workspaceId},${pb.id},1,'ERP_SYNC',1)`.execute()).rejects.toMatchObject({ code: '23503' });
    await expect(a.client`INSERT INTO pipeline_jobs(id,workspace_id,connection_id,erp_destination_id,source,external_order_id,fingerprint) VALUES (${uid()},${a.context.workspaceId},${b.workerContext.connectionId},${a.workerContext.erpDestinationId},'MERCADO_LIVRE','same','fingerprint')`.execute()).rejects.toMatchObject({ code: '23503' });
    const values = a.dispatchValues(oa);
    await expect(a.client`INSERT INTO erp_dispatches(order_id,workspace_id,erp_destination_id,external_idempotency_key,payload) VALUES (${oa.id},${a.context.workspaceId},${b.workerContext.erpDestinationId},${values.externalIdempotencyKey},${JSON.stringify(values.payload)})`.execute()).rejects.toMatchObject({ code: '23503' });
    await a.db.insert(erpDispatches).values(values);
    await expect(a.client`INSERT INTO canonical_orders(id,workspace_id,source,external_order_id,status,total_amount_cents,customer_payload,shipping_payload,items_payload,raw_payload) SELECT ${uid()},workspace_id,source,external_order_id,status,total_amount_cents,customer_payload,shipping_payload,items_payload,raw_payload FROM canonical_orders WHERE id=${oa.id}`.execute()).rejects.toMatchObject({ code: '23505' });
    await expect(a.client`INSERT INTO erp_attempts(id,workspace_id,erp_destination_id,order_id,ordinal) VALUES (${uid()},${b.context.workspaceId},${b.workerContext.erpDestinationId},${oa.id},1)`.execute()).rejects.toMatchObject({ code: '23503' });
    await expect(a.client`UPDATE canonical_orders SET source='MERCADO_LIVRE',connection_id=NULL WHERE id=${oa.id}`.execute()).rejects.toMatchObject({ code: '23514' });
    await expect(a.client`UPDATE canonical_orders SET connection_id=${a.workerContext.connectionId} WHERE id=${oa.id}`.execute()).rejects.toMatchObject({ code: '23514' });
    await expect(a.client`UPDATE canonical_orders SET source='SHOPEE',connection_id=${a.workerContext.connectionId} WHERE id=${oa.id}`.execute()).rejects.toMatchObject({ code: '23503' });
    await expect(a.client`UPDATE connections SET external_account_id=${`fixture-${a.workerContext.connectionId}`} WHERE id=${b.workerContext.connectionId}`.execute()).rejects.toMatchObject({ code: '23505' });
    await expect(a.client`INSERT INTO connections(id,workspace_id,platform,transport_mode,name,state) VALUES (${uid()},${a.context.workspaceId},'MERCADO_LIVRE','LOCAL_FIXTURE','No identity','ACTIVE')`.execute()).rejects.toMatchObject({ code: '23514' });
    // Two disabled unidentified rows are deliberate; they are never runnable connections.
    for (let n = 0; n < 2; n++) await a.db.insert(connections).values({ workspaceId: a.context.workspaceId, platform: 'MERCADO_LIVRE', transportMode: 'LOCAL_FIXTURE', name: 'Unidentified', state: 'DISABLED' });
  });

  test('sessões reais ignoram workspace alegado; IDOR, CSRF, Origin, Turnstile e operador sem alvo falham fechados', async () => {
    const h = await setupPipelines(), first = await h.enqueue(0); await h.pipelines[0]!.runOnce();
    const auth = new AuthService(a.db,security), password = 'task013-synthetic-password';
    const hash = await Bun.password.hash(password,{ algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
    await a.db.update(users).set({ passwordHash: hash }).where(inArray(users.id,[a.ownerId,b.ownerId]));
    const sa = await auth.login({ email: `${a.ownerId}@example.invalid`, password }), sb = await auth.login({ email: `${b.ownerId}@example.invalid`, password });
    const browser = (token: string, path: string, method = 'GET', headers: Record<string,string> = {}, body?: unknown) => h.app.handle(new Request(`http://localhost${path}`, { method, headers: { cookie: `omnihub_session=${token}`, origin, 'x-workspace-id': a.context.workspaceId, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const own = await browser(sb.token,`/api/v1/inventory?workspaceId=${a.context.workspaceId}`); expect(own.status).toBe(200); expect(await own.json()).toMatchObject({ data: [{ id: h.pb.id, currentStock: 5 }] });
    expect((await browser(sb.token,`/api/v1/dashboard/processings/${first}`)).status).toBe(404);
    expect((await browser(sb.token,`/api/v1/dashboard/processings/${first}/retry`,'POST',{ 'x-csrf-token': sb.account.csrfToken, 'x-turnstile-token': 'dummy' })).status).toBe(404);
    expect((await browser(sa.token,'/api/v1/dashboard/connections/check','POST')).status).toBe(403);
    expect((await browser(sa.token,'/api/v1/dashboard/connections/check','POST',{ 'x-csrf-token': sa.account.csrfToken })).status).toBe(403);
    expect((await browser(sa.token,'/api/v1/dashboard/connections/check','POST',{ 'x-csrf-token': sa.account.csrfToken, 'x-turnstile-token': 'dummy', origin: 'https://foreign.invalid' })).status).toBe(403);
    const mapping = { connectionId: a.workerContext.connectionId, marketplace: 'MERCADO_LIVRE', productId: h.pa.id, externalItemId: 'MLB555555', syncEnabled: 'Y' };
    expect((await browser(sb.token,'/api/v1/dashboard/mappings','POST',{ 'x-csrf-token': sb.account.csrfToken, 'x-turnstile-token': 'dummy' },mapping)).status).toBe(404);
    expect((await browser(sa.token,'/api/v1/dashboard/connections/check','POST',{ 'x-csrf-token': sa.account.csrfToken, 'x-turnstile-token': 'dummy' })).status).toBe(200);
    expect((await h.app.handle(new Request('http://localhost/api/v1/inventory',{ headers: { authorization: `Bearer ${operator}` } }))).status).toBe(422);
    expect((await browser(sa.token,'/api/v1/inventory','GET',{ authorization: `Bearer ${operator}` })).status).toBe(403);
    const session = await auth.authenticate(new Request('http://localhost',{ headers: { cookie: `omnihub_session=${sa.token}` } })); await auth.logout(session);
    expect((await browser(sa.token,'/api/v1/inventory')).status).toBe(401);
  });

  test('cadastro nunca herda legado; reivindicação exige destino vazio/proprietário verificado e mantém UUIDs', async () => {
    const rollback = new Error('rollback synthetic legacy claim');
    try {
      await a.db.transaction(async tx => {
        const ownerId = Bun.randomUUIDv7(), emptyId = Bun.randomUUIDv7(), legacyId = Bun.randomUUIDv7(), productId = Bun.randomUUIDv7();
        await tx.insert(users).values({ id: ownerId, name: 'Verified by fixture operator', email: `${ownerId}@example.invalid`, passwordHash: 'not-a-login-hash' });
        await tx.insert(workspaces).values([{ id: emptyId, ownerId },{ id: legacyId, ownerId: null, kind: 'LEGACY_CLOSED' }]);
        await tx.insert(products).values({ id: productId, workspaceId: legacyId, sku: 'LEGACY-ONLY', title: 'Preserved legacy', basePriceCents: 100, currentStock: 9, reservedStock: 2 });
        expect(await tx.select().from(products).where(eq(products.workspaceId,emptyId))).toHaveLength(0);
        await expect(claimLegacy(tx,{ legacyWorkspaceId: legacyId, emptyWorkspaceId: emptyId, verifiedOwnerId: b.ownerId, verificationReference: 'operator-fixture-proof' })).rejects.toMatchObject({ code: 'LEGACY_CLAIM_CONFLICT' });
        await expect(claimLegacy(tx,{ legacyWorkspaceId: legacyId, emptyWorkspaceId: a.context.workspaceId, verifiedOwnerId: a.ownerId, verificationReference: 'operator-fixture-proof' })).rejects.toMatchObject({ code: 'LEGACY_TARGET_NOT_EMPTY' });
        const result = await claimLegacy(tx,{ legacyWorkspaceId: legacyId, emptyWorkspaceId: emptyId, verifiedOwnerId: ownerId, verificationReference: 'operator-fixture-proof' });
        expect(result.workspaceId).toBe(legacyId); expect(result.replacedEmptyWorkspaceId).toBe(emptyId);
        expect((await tx.select().from(products).where(eq(products.id,productId)))[0]).toMatchObject({ workspaceId: legacyId, currentStock: 9, reservedStock: 2 });
        expect(await tx.select().from(workspaces).where(eq(workspaces.id,emptyId))).toHaveLength(0);
        expect(await tx.select().from(legacyClaims).where(eq(legacyClaims.workspaceId,legacyId))).toHaveLength(1);
        await expect(claimLegacy(tx,{ legacyWorkspaceId: legacyId, emptyWorkspaceId: emptyId, verifiedOwnerId: ownerId, verificationReference: 'operator-fixture-proof' })).rejects.toMatchObject({ code: 'LEGACY_CLAIM_CONFLICT' });
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    const runtime = await createRuntime(a.db,{ HUB_ADMIN_TOKEN: operator, MELI_APP_ID: 'must-not-import', MELI_CLIENT_SECRET: 'must-not-import', MELI_REDIRECT_URI: 'https://ignored.invalid/api/oauth/meli/callback' });
    expect(runtime.pipelines).toEqual([]); expect(runtime.oauth).toBeUndefined();
  });
});
