import { requireConnection, requireDestination, type WorkspaceContext } from '../services/context';
import { approvedErpOrigin } from '../config/erp-target';
import { Elysia, t } from 'elysia';
import { MeliNotificationSchema, validateSpokeMapping, verifyInternalBody } from '@omnihub/marketplace-adapters';
import { connections as connectionTable, erpDestinations, products, spokeMappings, type Database } from '@omnihub/database';
import { and, eq } from 'drizzle-orm';
import type { PipelineRuntime } from '../config/runtime';
import { HubError } from '../errors';
import { InventoryService } from '../services/inventory.service';
import { OperationsService } from '../services/operations.service';
import { requireOperator } from '../plugins/auth';

const pagination = t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })), offset: t.Optional(t.Integer({ minimum: 0, maximum: 2147483647 })) });
const nullableString = t.Nullable(t.String());
const listSchema = (item: ReturnType<typeof t.Object>) => t.Object({ data: t.Array(item), limit: t.Number(), offset: t.Number() });
const jobSchema = t.Object({ connectionId: t.String(), id: t.String(), orderId: nullableString, source: t.String(), transportMode: t.String(), externalOrderId: t.String(), state: t.String(), outcome: nullableString, errorCode: nullableString, receiptCount: t.Number(), createdAt: t.String(), finishedAt: nullableString });
const mappingBody = t.Object({ connectionId: t.String({ format: 'uuid' }), productId: t.String({ format: 'uuid' }), marketplace: t.Literal('MERCADO_LIVRE'), externalItemId: t.String({ minLength: 1, maxLength: 150 }), externalVariantId: t.Optional(t.String({ maxLength: 100 })), syncEnabled: t.Union([t.Literal('Y'),t.Literal('N')]) });
const stockMovementBody = t.Object({movementId:t.String({format:'uuid'}),sku:t.String({minLength:1,maxLength:100}),quantity:t.Integer({minimum:1,maximum:2147483647})});
export function requireAdmin(request: Request, token: string) {
  requireOperator(request, token);
}
async function rawBody(request: Request): Promise<string> {
  if (!request.body) throw new HubError(400, 'INVALID_REQUEST_BODY', 'Corpo obrigatório.');
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > 65536) { await reader.cancel(); throw new HubError(422, 'PAYLOAD_TOO_LARGE', 'Corpo excede 64 KiB.'); } parts.push(item.value); }
    const all = new Uint8Array(length); let offset = 0; for (const part of parts) { all.set(part, offset); offset += part.length; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(all); } catch { throw new HubError(400, 'INVALID_REQUEST_BODY', 'UTF-8 inválido.'); }
  } finally { reader.releaseLock(); }
}
function parseJson(text: string): unknown { try { return JSON.parse(text) as unknown; } catch { throw new HubError(400, 'INVALID_REQUEST_BODY', 'JSON inválido.'); } }
export function pipelineRoutes(db: Database, runtime: PipelineRuntime, scope: (request: Request) => WorkspaceContext) {
  const ops = (request: Request) => new OperationsService(db, scope(request));
  const checks = new Map<string, { status: string; checkedAt: string; latencyMs: number | null }>();
  const admin = (request: Request) => requireAdmin(request, runtime.adminToken);
  const connections = async (request: Request) => {
    const context = scope(request);
    const rows = await db.select().from(connectionTable).where(eq(connectionTable.workspaceId, context.workspaceId));
    const destinations = await db.select().from(erpDestinations).where(eq(erpDestinations.workspaceId, context.workspaceId));
    const data = rows.map(row => ({ id: row.id, name: row.platform, transportMode: row.transportMode, state: row.state,
      ...(row.platform !== 'MERCADO_LIVRE' ? { status: 'NOT_IMPLEMENTED', checkedAt: null, latencyMs: null } : row.state === 'DISABLED' ? { status: 'DISABLED', checkedAt: null, latencyMs: null } : runtime.connectionRuntime ? { status: row.credentialState !== 'CONNECTED' ? row.credentialState : row.checkStatus ?? 'NOT_MEASURED', checkedAt: row.checkedAt?.toISOString() ?? null, latencyMs: row.checkLatencyMs } : checks.get(`${context.workspaceId}:${row.id}`) ?? { status: 'NOT_CONFIGURED', checkedAt: null, latencyMs: null }) }));
    return { data: [...data, ...destinations.map(row => ({ id: row.id, name: 'MOCK_ERP', state: row.state, transportMode: 'LOCAL_FIXTURE',
      ...(row.state === 'DISABLED' ? { status: 'DISABLED', checkedAt: null, latencyMs: null } : checks.get(`${context.workspaceId}:${row.id}`) ?? { status: 'NOT_CONFIGURED', checkedAt: null, latencyMs: null }) }))] };
  };
  const connectionResponse = t.Object({ data: t.Array(t.Object({ id: t.String(), name: t.String(), transportMode: t.String(), state: t.String(), status: t.String(), checkedAt: nullableString, latencyMs: t.Nullable(t.Number()) })) });
  const restock = async (request: Request, destinationId?: string) => {
    const target = runtime.erpTargets?.find(t => t.erpDestinationId === destinationId);
    const raw = await rawBody(request);
    // Authenticate raw bytes before parsing, including on the retired unscoped endpoint.
    if (!target || !verifyInternalBody(raw, target.webhookSecret, request.headers.get('x-erp-signature'))) throw new HubError(403, 'INVALID_ERP_SIGNATURE', 'Assinatura ERP inválida.');
    const destination = await requireDestination(db, target, target.erpDestinationId);
    if (destination.configKey !== target.configKey || destination.endpointOrigin !== approvedErpOrigin(target.url)) throw new HubError(409, 'ERP_DESTINATION_CONFIG_MISMATCH', 'Destino ERP incompatível com o registro permitido.');
    const value = parseJson(raw);
    if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['movementId','sku','quantity'].includes(k)) || !('sku' in value) || typeof value.sku !== 'string' || !('quantity' in value) || typeof value.quantity !== 'number' || !Number.isInteger(value.quantity) || !('movementId' in value) || typeof value.movementId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.movementId)) throw new HubError(422, 'INVALID_ERP_MOVEMENT', 'Movimentação ERP inválida.');
    const [product] = await db.select().from(products).where(and(eq(products.workspaceId, target.workspaceId), eq(products.sku, value.sku)));
    if (!product) throw new HubError(404, 'CANONICAL_PRODUCT_NOT_FOUND', 'Produto não encontrado.');
    await new InventoryService(db, target).restock(product.id, value.quantity, value.movementId);
    const active = runtime.connectionRuntime ? await db.select({ id: connectionTable.id }).from(connectionTable).where(and(eq(connectionTable.workspaceId, target.workspaceId), eq(connectionTable.state, 'ACTIVE'), eq(connectionTable.credentialState, 'CONNECTED'))) : undefined;
    await Promise.all((runtime.pipelines ?? []).filter(p => p.context.workspaceId === target.workspaceId && p.context.erpDestinationId === target.erpDestinationId && (!active || active.some(c => c.id === p.context.connectionId))).map(p => p.syncStock([product.sku])));
    return { accepted: true, movementId: value.movementId };
  };
  return new Elysia().model({MeliNotification:MeliNotificationSchema,ErpStockMovement:stockMovementBody})
    .post('/api/oauth/meli/start', ({ request }) => { admin(request); if (!runtime.oauth) throw new HubError(503, 'MELI_NOT_CONFIGURED', 'Configure OAuth Mercado Livre.'); return runtime.oauth.start(); }, {
      response: { 200: t.Object({ authorizationUrl: t.String(), expiresAt: t.String() }) }, detail: { tags: ['OAuth'], security: [{ bearerAuth: [] }] },
    })
    .get('/api/oauth/meli/callback', async ({ request, set }) => {
      set.headers['Cache-Control'] = 'no-store'; set.headers['Referrer-Policy'] = 'no-referrer';
      if (runtime.connectionRuntime) {
        await runtime.connectionRuntime.service.callback(request.url);
        // Static server-configured return destination; no code/state/token in the UI URL.
        return new Response(null, { status: 303, headers: { Location: runtime.connectionRuntime.service.store!.settings.returnUrl, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      if (!runtime.oauth) throw new HubError(503, 'MELI_NOT_CONFIGURED', 'Configure OAuth Mercado Livre.');
      return Response.json(await runtime.oauth.callback(request.url));
    }, { response: { 200: t.Object({ authorized: t.Boolean() }), 303: t.Null() }, detail: { tags: ['OAuth'], description: 'Callback público sem cookie: grava autorização pendente privada e volta para URL fixa sem código/state. A sessão iniciadora confirma em /api/v1/connections/:id/oauth/confirm.' } })
    .post('/api/oauth/meli/smoke', ({request,body})=>{
      admin(request);if(!runtime.smoke)throw new HubError(503,'MELI_NOT_CONFIGURED','Configure vendedor de teste.');return runtime.smoke(body?.externalOrderId);
    },{body:t.Optional(t.Object({externalOrderId:t.Optional(t.String({pattern:'^[1-9][0-9]{0,99}$'}))})),response:{200:t.Object({ok:t.Boolean(),marketplace:t.String(),mode:t.String(),checkedAt:t.String(),identityMatches:t.Boolean(),testUserVerified:t.Boolean(),operations:t.Array(t.String()),orderRead:t.Boolean(),canonicalParsingVerified:t.Boolean()})},detail:{tags:['OAuth'],security:[{sessionCookie:[],csrfHeader:[],turnstileHeader:[]},{bearerAuth:[],workspaceTarget:[]}]}})
    .post('/api/webhooks/meli', async ({ request }) => {
      const raw = parseJson(await rawBody(request));
      const activeBindings = runtime.connectionRuntime ? await db.select({ connectionId: connectionTable.id, erpDestinationId: erpDestinations.id }).from(connectionTable).innerJoin(erpDestinations, and(eq(erpDestinations.workspaceId, connectionTable.workspaceId), eq(erpDestinations.state, 'ACTIVE'))).where(and(eq(connectionTable.state, 'ACTIVE'), eq(connectionTable.credentialState, 'CONNECTED'))) : undefined;
      const matches = (runtime.pipelines ?? []).filter(pipeline => {
        if (runtime.connectionRuntime && pipeline.transportMode !== 'OFFICIAL_TEST_USER') return false;
        if (activeBindings && !activeBindings.some(b => b.connectionId === pipeline.context.connectionId && b.erpDestinationId === pipeline.context.erpDestinationId)) return false;
        if (pipeline.gateway.source !== 'MERCADO_LIVRE') return false;
        try { pipeline.gateway.identifyNotification(raw); return true; } catch { return false; }
      });
      if (matches.length !== 1) throw new HubError(403, 'SPOKE_CONNECTION_UNRESOLVED', 'Aviso sem conexão inequívoca configurada.');
      return matches[0]!.enqueue(raw);
    }, { parse: 'none', response: { 200: t.Object({ accepted: t.Boolean(), processingId: t.String() }) }, detail: { tags: ['Webhooks'], description: 'Adaptador valida app/conta/recurso; conexão é resolvida no servidor e o recurso é consultado com transporte autorizado.', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MeliNotification' } } } } } })
    .post('/api/webhooks/erp-stock', ({ request }) => restock(request), { parse: 'none', detail: { tags: ['Webhooks'], deprecated: true, description: 'Sem destino inequívoco: fechado. Use /erp-stock/:destinationId com segredo exclusivo.' } })
    .post('/api/webhooks/erp-stock/:destinationId', ({ request, params }) => restock(request, params.destinationId), { parse: 'none', params: t.Object({ destinationId: t.String({ format: 'uuid' }) }), response: { 200: t.Object({ accepted: t.Boolean(), movementId: t.String() }) }, detail: { tags: ['Webhooks'], description: 'HMAC-SHA256 bruto em x-erp-signature; destino e workspace vêm do registro privado permitido pelo operador.', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErpStockMovement' } } } } } })
    .get('/api/v1/dashboard/orders', async ({ request, query }) => { return ops(request).orders(query.limit ?? 50, query.offset ?? 0); }, {
      query: pagination, response: { 200: listSchema(t.Object({ id: t.String(), connectionId: t.Nullable(t.String()), source: t.String(), externalOrderId: t.String(), status: t.String(), totalAmountCents: t.Number(), createdAt: t.String(), reservationState: t.String(), dispatchState: t.String(), attempts: t.Number() })) }, detail: { tags: ['Dashboard'], security: [{ sessionCookie: [] }, { bearerAuth: [], workspaceTarget: [] }] },
    })
    .get('/api/v1/dashboard/processings', ({ request, query }) => { return ops(request).jobs(query.limit ?? 50, query.offset ?? 0); }, { query: pagination, response: { 200: listSchema(jobSchema) }, detail: { tags: ['Dashboard'], security: [{ sessionCookie: [] }, { bearerAuth: [], workspaceTarget: [] }] } })
    .post('/api/v1/dashboard/processings/:id/retry', ({ request,params }) => { return ops(request).retry(params.id); }, { params:t.Object({id:t.String({format:'uuid'})}),response:{200:t.Object({processingId:t.String(),retryOf:t.String()})},detail:{tags:['Dashboard'],security:[{sessionCookie:[],csrfHeader:[],turnstileHeader:[]},{bearerAuth:[],workspaceTarget:[]}]} })
    .get('/api/v1/dashboard/processings/:id', ({ request, params }) => { return ops(request).trace(params.id); }, {
      params: t.Object({ id: t.String({ format: 'uuid' }) }), response: { 200: t.Object({ processingId: t.String(), connectionId: t.String(), orderId: nullableString, source: t.String(), transportMode: t.String(), state: t.String(), outcome: nullableString, errorCode: nullableString, createdAt: t.String(), finishedAt: nullableString,
        snapshots: t.Object({ raw: t.Unknown(), canonical: t.Unknown(), erp: t.Unknown() }), timingsMs: t.Nullable(t.Record(t.String(), t.Number())), dispatchState: t.String(), redacted: t.Boolean(), timingScope: t.String(),
        attempts: t.Array(t.Object({ ordinal: t.Number(), httpStatus: t.Nullable(t.Number()), outcome: t.String(), durationMs: t.Nullable(t.Number()), startedAt: t.String(), finishedAt: nullableString })) }) }, detail: { tags: ['Dashboard'], security: [{ sessionCookie: [] }, { bearerAuth: [], workspaceTarget: [] }] },
    })
    .get('/api/v1/dashboard/mappings', ({ request, query }) => { return ops(request).mappings(query.limit ?? 50, query.offset ?? 0); }, { query: pagination, response: { 200: listSchema(t.Object({ id: t.String(), workspaceId: t.String(), connectionId: t.String(), productId: t.String(), marketplace: t.String(), externalItemId: t.String(), externalVariantId: t.String(), externalSku: nullableString, syncEnabled: t.String(), lastSyncedAt: nullableString, lastSyncError: nullableString, lastSyncQuantity: t.Nullable(t.Number()), sku: t.String(), implementation: t.String() })) }, detail: { tags: ['Dashboard'], security: [{ sessionCookie: [] }, { bearerAuth: [], workspaceTarget: [] }] } })
    .post('/api/v1/dashboard/mappings', async ({ request, body, status }) => {
      const context = scope(request);
      await requireConnection(db, { ...context, connectionId: body.connectionId }, body.marketplace);
      const [product] = await db.select().from(products).where(and(eq(products.workspaceId, context.workspaceId), eq(products.id, body.productId)));
      if (!product) throw new HubError(404, 'CANONICAL_PRODUCT_NOT_FOUND', 'Produto não encontrado.');
      validateSpokeMapping(body.marketplace,{...body,externalVariantId:body.externalVariantId ?? '',sku:product.sku});
      const [mapping] = await db.insert(spokeMappings).values({ ...body, workspaceId: context.workspaceId, externalVariantId: body.externalVariantId ?? '' }).onConflictDoNothing().returning();
      if (!mapping) throw new HubError(409, 'SPOKE_MAPPING_CONFLICT', 'Anúncio/variação já mapeado.');
      return status(201, { id: mapping.id });
    }, { body: mappingBody, response: { 201: t.Object({ id: t.String() }) }, detail: { tags: ['Dashboard'], security: [{ sessionCookie: [], csrfHeader: [], turnstileHeader: [] }, { bearerAuth: [], workspaceTarget: [] }] } })
    .get('/api/v1/dashboard/metrics', ({ request, query }) => { const to = query.to ? new Date(query.to) : new Date(); return ops(request).metrics(query.from ? new Date(query.from) : new Date(to.getTime()-86400000), to); }, {
      query: t.Object({ from: t.Optional(t.String({ format: 'date-time' })), to: t.Optional(t.String({ format: 'date-time' })) }),
      response: { 200: t.Object({ from: t.String(), to: t.String(), collectedAt: t.String(), windowBasis: t.String(), acceptedOrders: t.Number(), receivedNotifications: t.Number(), duplicateReceipts: t.Number(), duplicateOrders: t.Number(), stockRejections: t.Number(), failedProcessings: t.Number(), rejectedProcessings: t.Number(), technicalFailures: t.Number(),
        delivery: t.Object({ confirmed: t.Number(), eligibleOrders: t.Number(), pendingOrFailed: t.Number(), rate: t.Nullable(t.Number()) }), durations: t.Array(t.Object({ stage: t.String(), samples: t.Number(), averageMs: t.Nullable(t.Number()) })), transportModes: t.Object({ officialProcessings: t.Number(), localFixtureProcessings: t.Number() }), units: t.Object({ counts: t.String(), duration: t.String(), rate: t.String() }) }) }, detail: { tags: ['Dashboard'], security: [{ sessionCookie: [] }, { bearerAuth: [], workspaceTarget: [] }] },
    })
    .get('/api/v1/dashboard/connections', ({ request }) => connections(request), { response: { 200: connectionResponse }, detail: { tags: ['Dashboard'], security: [{ sessionCookie: [] }] } })
    .post('/api/v1/dashboard/connections/check', async ({ request }) => {
      const context = scope(request);
      const probe = async (id: string, run: () => Promise<void>) => {
        const begin = performance.now();
        try { await run(); checks.set(`${context.workspaceId}:${id}`, { status: 'AVAILABLE', checkedAt: new Date().toISOString(), latencyMs: performance.now() - begin }); }
        catch { checks.set(`${context.workspaceId}:${id}`, { status: 'UNAVAILABLE', checkedAt: new Date().toISOString(), latencyMs: performance.now() - begin }); }
      };
      await Promise.all([
        ...(runtime.erpTargets ?? []).filter(t => t.workspaceId === context.workspaceId).map(target => probe(target.erpDestinationId, async () => {
          await requireDestination(db, context, target.erpDestinationId);
          const response = await (target.transport ?? fetch)(new Request(`${target.url}/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) }));
          await response.body?.cancel(); if (!response.ok) throw new Error('Unavailable');
        })),
        ...(runtime.pipelines ?? []).filter(p => p.context.workspaceId === context.workspaceId).map(p => runtime.connectionRuntime ? runtime.connectionRuntime.service.check(context, p.context.connectionId, () => p.gateway.checkConnection()) : probe(p.context.connectionId, async () => {
          await requireConnection(db, p.context, p.context.source);
          if (!(await p.gateway.checkConnection()).testUser) throw new Error('Unavailable');
        })),
      ]);
      return connections(request);
    }, { response: { 200: connectionResponse }, detail: { tags: ['Dashboard'], security: [{ sessionCookie: [], csrfHeader: [], turnstileHeader: [] }, { bearerAuth: [], workspaceTarget: [] }] } });
}
