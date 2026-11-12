import { describe, expect, test } from 'bun:test';
import { canonicalOrders, erpAttempts, erpDispatches, inventoryLedger, pipelineJobs, products, spokeMappings } from '@omnihub/database';
import { MeliClient, MeliGateway, signInternalBody, type SpokeGateway } from '@omnihub/marketplace-adapters';
import { and, eq } from 'drizzle-orm';
import legacy from '../../../packages/marketplace-adapters/tests/fixtures/meli-order-legacy.json';
import { createMockErp } from '../../mock-erp/src/app';
import { createApp } from '../src/app';
import { CompilerPipeline } from '../src/pipeline/compiler-pipeline';
import { ErpDispatchService } from '../src/services/erp-dispatch.service';
import { OrderIngestionService } from '../src/services/order-ingestion.service';
import { emitCanonicalOrderToLegacyErp } from '@omnihub/marketplace-adapters';
import type { OperationsService } from '../src/services/operations.service';
import { databaseFixture, testDatabaseUrl } from './helpers';

const token = 'local-admin-test-'.repeat(3), secret = 'local-webhook-test-'.repeat(3);
describe.skipIf(!testDatabaseUrl)('pipeline integrado com PostgreSQL isolado e transporte Mercado Livre simulado', () => {
  const fixture = databaseFixture();
  async function setup(sequence: (200|503)[] = [], stock = 5) {
    const product = await fixture.product(stock, 0);
    const order = structuredClone(legacy); order.id = 2000000000000000 + Math.floor(Math.random()*1000000000);
    await fixture.db.insert(spokeMappings).values({ productId: product.id, marketplace: 'MERCADO_LIVRE', externalItemId: order.order_items[0]!.item.id });
    const stockUpdates: number[] = [], waits: number[] = []; let reads = 0, sends = 0;
    let loadedOverride: unknown;
    const client = new MeliClient({ clientId: '123456', clientSecret: 'test-only-secret', expectedSellerId: '900000001', initialTokens: { accessToken: 'fake-access', refreshToken: 'fake-refresh', userId: '900000001', expiresAt: Date.now()+3600000 },
      transport: async request => {
        if (request.url.endsWith('/users/me')) return Response.json({ id: 900000001, site_id: 'MLB', tags: ['test_user'] });
        if (request.url.includes('/orders/')) { reads++; return Response.json(loadedOverride ?? order); }
        if (request.method === 'PUT') { const body = await request.json() as { available_quantity: number }; stockUpdates.push(body.available_quantity); return Response.json({}); }
        return Response.json({ seller_id: 900000001 });
      },
    });
    const meli = new MeliGateway(client, '123456', '900000001');
    const gateway: SpokeGateway = { source: meli.source, identifyNotification: raw => meli.identifyNotification(raw), checkConnection: () => meli.checkConnection(), updateStock: (m,q) => meli.updateStock(m,q), loadOrder: async id => {
      const loaded = await meli.loadOrder(id); return { raw: loaded.raw, cancelled:loaded.cancelled, parse: context => { const result = loaded.parse(context); fixture.trackOrder(result.id); return result; } };
    } };
    const erp = createMockErp({ adminToken: token, webhookSecret: secret, hubWebhookUrl: 'http://localhost/api/webhooks/erp-stock', warehouse: new Map([[product.sku, stock]]), chaos: { minMs: 0, maxMs: 0, failureRate: 0, sequence }, sleep: async () => {} });
    const dispatch = new ErpDispatchService(fixture.db, { url: 'http://127.0.0.1:3002', adminToken: token, random: () => 0, sleep: async ms => { waits.push(ms); }, transport: async request => {
      sends++; const [stored] = await fixture.db.select().from(canonicalOrders).where(and(eq(canonicalOrders.source, 'MERCADO_LIVRE'), eq(canonicalOrders.externalOrderId, String(order.id))));
      expect(stored).toBeDefined(); const [p] = await fixture.db.select().from(products).where(eq(products.id, product.id));
      expect(p!.reservedStock).toBe(2); // outra conexão vê o commit antes do HTTP
      return erp.handle(request);
    } });
    const pipeline = new CompilerPipeline(fixture.db, gateway, dispatch, 'LOCAL_FIXTURE');
    const app = createApp({ db: fixture.db, runtime: { pipeline, adminToken: token, webhookSecret: secret, erpUrl: 'http://127.0.0.1:3002', mockAdminToken: token } });
    const notification = { topic: 'orders_v2', resource: `/orders/${order.id}`, user_id: 900000001, application_id: 123456, sent: new Date().toISOString() };
    async function enqueue(body: unknown = notification) {
      const response = await app.handle(new Request('http://localhost/api/webhooks/meli', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      const result = await response.json() as { processingId?: string; error?: unknown };
      if (result.processingId) fixture.trackProcessing(result.processingId);
      return { response, id: result.processingId! };
    }
    const get = (path: string, credential = token) => app.handle(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${credential}` } }));
    return { product, order, erp, app, pipeline, dispatch, enqueue, notification, get, stockUpdates, waits,
      reads: () => reads, sends: () => sends, override: (input: unknown) => { loadedOverride = input; } };
  }
  test('ack durável precede consulta; 503 recupera com três snapshots mascarados e baixa única', async () => {
    const h = await setup([503,200]); const accepted = await h.enqueue();
    expect(accepted.response.status).toBe(200); expect(h.reads()).toBe(0);
    expect((await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id, accepted.id)))[0]?.state).toBe('QUEUED');
    await h.pipeline.runOnce();
    const [job] = await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id, accepted.id));
    expect(job!.state).toBe('SUCCEEDED'); expect(job!.outcome).toBe('CREATED'); expect(h.waits).toEqual([300]); expect(h.sends()).toBe(2);
    const [p] = await fixture.db.select().from(products).where(eq(products.id, h.product.id)); expect(p!.currentStock).toBe(3); expect(p!.reservedStock).toBe(0); expect(h.stockUpdates).toEqual([3]);
    const ledger = await fixture.db.select().from(inventoryLedger).where(eq(inventoryLedger.productId, p!.id));
    expect(ledger.filter(l=>l.reason==='SALE')).toHaveLength(1); expect(ledger.find(l=>l.reason==='FULFILLMENT')?.delta).toBe(0);
    const trace = await h.get(`/api/v1/dashboard/processings/${accepted.id}`); expect(trace.status).toBe(200);
    const text = await trace.text(); for (const value of ['12345678901','123.456.789-01','comprador@example.invalid','Rua de Teste','fake-access',token]) expect(text).not.toContain(value);
    const body = JSON.parse(text); expect(body.attempts).toHaveLength(2); expect(body.snapshots.erp.valor_total).toBe(39.98);
    const metrics = await (await h.get('/api/v1/dashboard/metrics')).json() as Awaited<ReturnType<OperationsService['metrics']>>; expect(metrics.acceptedOrders).toBe(1); expect(metrics.delivery.rate).toBe(1);
  });
  test('reentregas exatas e avisos diferentes não repetem reserva, faturamento ou baixas', async () => {
    const h = await setup(); const first = await h.enqueue(); await h.pipeline.runOnce();
    const exact = await h.enqueue(); expect(exact.id).toBe(first.id); expect(await h.pipeline.runOnce()).toBe(false);
    await h.enqueue({ ...h.notification, sent: '2026-11-12T10:00:00Z' }); await h.pipeline.runOnce();
    expect(h.sends()).toBe(1); expect((await fixture.db.select().from(inventoryLedger).where(eq(inventoryLedger.productId, h.product.id))).filter(l=>l.reason==='SALE')).toHaveLength(1);
    expect((await (await h.get('/api/v1/dashboard/metrics')).json() as { duplicateOrders:number }).duplicateOrders).toBe(1);
  });
  test('esgotamento persiste três tentativas, preserva reserva e reinício não gera quarta chamada', async () => {
    const h = await setup([503,503,503,200]); const { id } = await h.enqueue(); await h.pipeline.runOnce();
    const [job] = await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,id));
    expect(job!.errorCode).toBe('ERP_RETRIES_EXHAUSTED'); expect(job!.outcome).toBe('CREATED'); expect(h.waits).toEqual([300,600]); expect(h.sends()).toBe(3);
    const [p] = await fixture.db.select().from(products).where(eq(products.id,h.product.id)); expect(p!.currentStock).toBe(5); expect(p!.reservedStock).toBe(2);
    await expect(h.dispatch.dispatch(job!.orderId!)).rejects.toMatchObject({ code: 'ERP_RETRIES_EXHAUSTED' }); expect(h.sends()).toBe(3);
    const retry=await h.app.handle(new Request(`http://localhost/api/v1/dashboard/processings/${id}/retry`,{method:'POST',headers:{authorization:`Bearer ${token}`}}));expect(retry.status).toBe(409);expect(h.sends()).toBe(3);
    expect((await fixture.db.select().from(erpAttempts).where(eq(erpAttempts.orderId,job!.orderId!)))).toHaveLength(3);
  });
  test('estoque insuficiente e dados faltantes são rejeitados sem HTTP ERP', async () => {
    const h = await setup([],1); const { id } = await h.enqueue(); await h.pipeline.runOnce();
    expect((await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,id)))[0]!.errorCode).toBe('INSUFFICIENT_CANONICAL_STOCK'); expect(h.sends()).toBe(0);
    h.override({ ...h.order, buyer: { ...h.order.buyer, email: null } });
    const second = await h.enqueue({ ...h.notification, sent: '2026-11-12T11:00:00Z' }); await h.pipeline.runOnce();
    expect((await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,second.id)))[0]!.errorCode).toBe('ADAPTER_ENRICHMENT_REQUIRED'); expect(h.sends()).toBe(0);
  });
  test('lease expirada é retomada e callback ERP valida HMAC antes de interpretar JSON', async () => {
    const h = await setup(); const { id } = await h.enqueue();
    await fixture.db.update(pipelineJobs).set({ state:'PROCESSING', leaseUntil:new Date(0) }).where(eq(pipelineJobs.id,id)); await h.pipeline.runOnce();
    expect((await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,id)))[0]!.state).toBe('SUCCEEDED');
    const raw = JSON.stringify({ movementId: crypto.randomUUID(), sku: h.product.sku, quantity: 2 });
    const send = (body: string, sig: string) => h.app.handle(new Request('http://localhost/api/webhooks/erp-stock', { method:'POST',headers:{'content-type':'application/json','x-erp-signature':sig},body }));
    expect((await send('{invalid','bad')).status).toBe(403);
    expect((await send(raw,signInternalBody(raw,secret))).status).toBe(200); expect((await send(raw,signInternalBody(raw,secret))).status).toBe(200);
    const [p] = await fixture.db.select().from(products).where(eq(products.id,h.product.id)); expect(p!.currentStock).toBe(5);
    expect((await send(raw+' ',signInternalBody(raw,secret))).status).toBe(403);
  });
  test('leituras administrativas exigem token e OpenAPI publica as rotas novas', async () => {
    const h = await setup(); expect((await h.get('/api/v1/dashboard/orders','bad')).status).toBe(401);
    const metrics = await (await h.get('/api/v1/dashboard/metrics?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z')).json() as Awaited<ReturnType<OperationsService['metrics']>>; expect(metrics.delivery.rate).toBeNull(); expect(metrics.durations[0]!.averageMs).toBeNull();
    expect((await h.get('/api/v1/dashboard/mappings?limit=0')).status).toBe(422);
    const connections = await (await h.get('/api/v1/dashboard/connections')).json() as { data: {name:string;status:string}[] }; expect(connections.data.find(c=>c.name==='AMAZON')!.status).toBe('NOT_IMPLEMENTED');
    const docs = await (await h.app.handle(new Request('http://localhost/docs/json'))).json() as { paths:Record<string,unknown> }; expect(docs.paths['/api/webhooks/meli']).toBeDefined(); expect(docs.paths['/api/v1/dashboard/metrics']).toBeDefined();
  });
  test('timeout ERP tem orçamento persistente e não pode ser reiniciado pelo retry administrativo', async () => {
    const product = await fixture.product(5,0), order = fixture.order([{sku:product.sku,quantity:2}]);
    await new OrderIngestionService(fixture.db).ingest(order,{fixture:true});
    await fixture.db.insert(erpDispatches).values({orderId:order.id,payload:emitCanonicalOrderToLegacyErp(order)});
    let calls=0; const waits:number[]=[];
    const dispatch = new ErpDispatchService(fixture.db,{url:'http://127.0.0.1:3002',adminToken:token,timeoutMs:5,random:()=>0,sleep:async ms=>{waits.push(ms);},transport:async request=>new Promise<Response>((_resolve,reject)=>{calls++;request.signal.addEventListener('abort',()=>reject(new Error('private-cause')),{once:true});})});
    await expect(dispatch.dispatch(order.id)).rejects.toMatchObject({code:'ERP_RETRIES_EXHAUSTED'}); expect(calls).toBe(3); expect(waits).toEqual([300,600]);
    await expect(dispatch.dispatch(order.id)).rejects.toMatchObject({code:'ERP_RETRIES_EXHAUSTED'}); expect(calls).toBe(3);
  });
  test('confirmação persistida é finalizada sem novo HTTP; repetição não reduz o físico outra vez', async () => {
    const product=await fixture.product(5,0),order=fixture.order([{sku:product.sku,quantity:2}]);
    await new OrderIngestionService(fixture.db).ingest(order,{fixture:true});
    await fixture.db.insert(erpDispatches).values({orderId:order.id,payload:emitCanonicalOrderToLegacyErp(order),state:'CONFIRMED',attempts:1,protocol:'FAT-persisted'});
    let calls=0; const dispatch=new ErpDispatchService(fixture.db,{url:'http://127.0.0.1:3002',adminToken:token,transport:async()=>{calls++;return Response.json({});}});
    await dispatch.dispatch(order.id); await dispatch.dispatch(order.id); expect(calls).toBe(0);
    const [p]=await fixture.db.select().from(products).where(eq(products.id,product.id));expect(p!.currentStock).toBe(3);expect(p!.reservedStock).toBe(0);
  });
  test('baixa física multi-item reverte integralmente se uma reserva estiver inconsistente', async () => {
    const p1=await fixture.product(5,0),p2=await fixture.product(5,0),order=fixture.order([{sku:p1.sku,quantity:2},{sku:p2.sku,quantity:2}]);
    await new OrderIngestionService(fixture.db).ingest(order,{fixture:true});
    await fixture.db.insert(erpDispatches).values({orderId:order.id,payload:emitCanonicalOrderToLegacyErp(order),state:'CONFIRMED',protocol:'FAT-test'});
    const last=[p1,p2].sort((a,b)=>a.id.localeCompare(b.id))[1]!;
    await fixture.db.update(products).set({reservedStock:0}).where(eq(products.id,last.id));
    const dispatch=new ErpDispatchService(fixture.db,{url:'http://127.0.0.1:3002',adminToken:token});
    await expect(dispatch.finalize(order.id)).rejects.toMatchObject({code:'RESERVATION_STATE_CONFLICT'});
    for(const p of [p1,p2])expect((await fixture.db.select().from(products).where(eq(products.id,p.id)))[0]!.currentStock).toBe(5);
    expect((await fixture.db.select().from(inventoryLedger).where(and(eq(inventoryLedger.orderId,order.id),eq(inventoryLedger.reason,'FULFILLMENT'))))).toHaveLength(0);
  });
  test.each([400,200])('ERP recusa erro permanente ou 2xx sem recibo valido sem repetir HTTP: %s', async code => {
    const product=await fixture.product(5,0),order=fixture.order([{sku:product.sku,quantity:2}]);
    await new OrderIngestionService(fixture.db).ingest(order,{fixture:true});
    await fixture.db.insert(erpDispatches).values({orderId:order.id,payload:emitCanonicalOrderToLegacyErp(order)});
    let calls=0;const dispatch=new ErpDispatchService(fixture.db,{url:'http://127.0.0.1:3002',adminToken:token,transport:async()=>{calls++;return new Response('invalid-private-body',{status:code});}});
    await expect(dispatch.dispatch(order.id)).rejects.toMatchObject({code:'ERP_PERMANENT_FAILURE'});expect(calls).toBe(1);
    expect((await fixture.db.select().from(products).where(eq(products.id,product.id)))[0]!.reservedStock).toBe(2);
  });
  test('retry administrativo cria outro trace e preserva o processamento anterior', async () => {
    const h=await setup();h.override({...h.order,buyer:{...h.order.buyer,email:null}});
    const first=await h.enqueue();await h.pipeline.runOnce();h.override(h.order);
    const retry=await h.app.handle(new Request(`http://localhost/api/v1/dashboard/processings/${first.id}/retry`,{method:'POST',headers:{authorization:`Bearer ${token}`}}));
    expect(retry.status).toBe(200);const next=await retry.json() as {processingId:string};fixture.trackProcessing(next.processingId);
    expect(next.processingId).not.toBe(first.id);await h.pipeline.runOnce();
    expect((await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,first.id)))[0]!.state).toBe('FAILED');
    expect((await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,next.processingId)))[0]!.state).toBe('SUCCEEDED');
  });
  test('worker oficial não consome fila de fixtures locais', async () => {
    const h=await setup();await h.enqueue();
    const official=new CompilerPipeline(fixture.db,h.pipeline.gateway,h.dispatch,'OFFICIAL_TEST_USER');
    expect(await official.runOnce()).toBe(false);expect(h.reads()).toBe(0);
    expect(await h.pipeline.runOnce()).toBe(true);
  });
  test('cancelamento autenticado libera reserva existente sem exigir PII mascarada novamente',async()=>{
    const h=await setup();const order=fixture.order([{sku:h.product.sku,quantity:2}],{source:'MERCADO_LIVRE',externalOrderId:String(h.order.id)});
    await new OrderIngestionService(fixture.db).ingest(order,{fixture:true});
    h.override({...h.order,status:'cancelled',buyer:{id:900000002}});
    const {id}=await h.enqueue();await h.pipeline.runOnce();
    expect((await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,id)))[0]!.outcome).toBe('CANCELLED');expect(h.sends()).toBe(0);
    const [p]=await fixture.db.select().from(products).where(eq(products.id,h.product.id));expect(p!.reservedStock).toBe(0);expect(p!.currentStock).toBe(5);
  });
  test('pedido sem pagamento confirmado não reserva nem fatura; novo aviso pago é processado',async()=>{
    const h=await setup();h.override({...h.order,status:'payment_required'});
    const first=await h.enqueue();await h.pipeline.runOnce();
    expect((await fixture.db.select().from(pipelineJobs).where(eq(pipelineJobs.id,first.id)))[0]!.errorCode).toBe('ORDER_NOT_READY');
    expect(h.sends()).toBe(0);expect((await fixture.db.select().from(products).where(eq(products.id,h.product.id)))[0]!.reservedStock).toBe(0);
    h.override(h.order);await h.enqueue({...h.notification,sent:'2026-11-12T12:00:00Z'});await h.pipeline.runOnce();expect(h.sends()).toBe(1);
  });
});
