import { Elysia, t } from 'elysia';
import { timingSafeEqual } from 'node:crypto';
import { MeliNotificationSchema, validateSpokeMapping, verifyInternalBody } from '@omnihub/marketplace-adapters';
import { products, spokeMappings, type Database } from '@omnihub/database';
import { eq, sql } from 'drizzle-orm';
import type { PipelineRuntime } from '../config/runtime';
import { HubError } from '../errors';
import { InventoryService } from '../services/inventory.service';
import { OperationsService } from '../services/operations.service';

const pagination = t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })), offset: t.Optional(t.Integer({ minimum: 0, maximum: 2147483647 })) });
const nullableString = t.Nullable(t.String());
const listSchema = (item: ReturnType<typeof t.Object>) => t.Object({ data: t.Array(item), limit: t.Number(), offset: t.Number() });
const jobSchema = t.Object({ id: t.String(), orderId: nullableString, source: t.String(), transportMode: t.String(), externalOrderId: t.String(), state: t.String(), outcome: nullableString, errorCode: nullableString, receiptCount: t.Number(), createdAt: t.String(), finishedAt: nullableString });
const mappingBody = t.Object({ productId: t.String({ format: 'uuid' }), marketplace: t.Literal('MERCADO_LIVRE'), externalItemId: t.String({ minLength: 1, maxLength: 150 }), externalVariantId: t.Optional(t.String({ maxLength: 100 })), syncEnabled: t.Union([t.Literal('Y'),t.Literal('N')]) });
const stockMovementBody = t.Object({movementId:t.String({format:'uuid'}),sku:t.String({minLength:1,maxLength:100}),quantity:t.Integer({minimum:1,maximum:2147483647})});
export function requireAdmin(request: Request, token: string) {
  if (token.length < 32) throw new HubError(503, 'LOCAL_ADMIN_NOT_CONFIGURED', 'Configure HUB_ADMIN_TOKEN para as operações locais.');
  const expected = Buffer.from(`Bearer ${token}`), received = Buffer.from(request.headers.get('authorization') ?? '');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new HubError(401, 'UNAUTHORIZED', 'Credencial administrativa local exigida.');
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
export function pipelineRoutes(db: Database, runtime: PipelineRuntime) {
  const ops = new OperationsService(db); const inventory = new InventoryService(db);
  const checks = new Map<string, { status: string; checkedAt: string; latencyMs: number | null }>();
  const admin = (request: Request) => requireAdmin(request, runtime.adminToken);
  const connections = () => ({ data: ['DATABASE','MOCK_ERP','MERCADO_LIVRE','AMAZON','SHOPEE'].map(name => ({ name, ...(checks.get(name) ?? { status: ['AMAZON','SHOPEE'].includes(name) ? 'NOT_IMPLEMENTED' : 'UNKNOWN', checkedAt: null, latencyMs: null }) })) });
  return new Elysia().model({MeliNotification:MeliNotificationSchema,ErpStockMovement:stockMovementBody})
    .post('/api/oauth/meli/start', ({ request }) => { admin(request); if (!runtime.oauth) throw new HubError(503, 'MELI_NOT_CONFIGURED', 'Configure OAuth Mercado Livre.'); return runtime.oauth.start(); }, {
      response: { 200: t.Object({ authorizationUrl: t.String(), expiresAt: t.String() }) }, detail: { tags: ['OAuth'], security: [{ bearerAuth: [] }] },
    })
    .get('/api/oauth/meli/callback', async ({ request, set }) => {
      set.headers['Cache-Control'] = 'no-store'; set.headers['Referrer-Policy'] = 'no-referrer';
      if (!runtime.oauth) throw new HubError(503, 'MELI_NOT_CONFIGURED', 'Configure OAuth Mercado Livre.');
      return runtime.oauth.callback(request.url);
    }, { response: { 200: t.Object({ authorized: t.Boolean() }) }, detail: { tags: ['OAuth'] } })
    .post('/api/oauth/meli/smoke', ({request,body})=>{
      admin(request);if(!runtime.smoke)throw new HubError(503,'MELI_NOT_CONFIGURED','Configure vendedor de teste.');return runtime.smoke(body?.externalOrderId);
    },{body:t.Optional(t.Object({externalOrderId:t.Optional(t.String({pattern:'^[1-9][0-9]{0,99}$'}))})),response:{200:t.Object({ok:t.Boolean(),marketplace:t.String(),mode:t.String(),checkedAt:t.String(),identityMatches:t.Boolean(),testUserVerified:t.Boolean(),operations:t.Array(t.String()),orderRead:t.Boolean(),canonicalParsingVerified:t.Boolean()})},detail:{tags:['OAuth'],security:[{bearerAuth:[]}]}})
    .post('/api/webhooks/meli', async ({ request }) => {
      if (!runtime.pipeline) throw new HubError(503, 'MELI_PIPELINE_NOT_CONFIGURED', 'Configure vendedor de teste e serviços locais.');
      const result = await runtime.pipeline.enqueue(parseJson(await rawBody(request)));
      return result; // 200 após persistir; worker executa fora do request.
    }, { parse: 'none', response: { 200: t.Object({ accepted: t.Boolean(), processingId: t.String() }) }, detail: { tags: ['Webhooks'], description: 'orders_v2: aviso validado, recurso obtido posteriormente via OAuth. Ack após fila durável.',requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/MeliNotification'}}}} } })
    .post('/api/webhooks/erp-stock', async ({ request }) => {
      const raw = await rawBody(request);
      if (!verifyInternalBody(raw, runtime.webhookSecret, request.headers.get('x-erp-signature'))) throw new HubError(403, 'INVALID_ERP_SIGNATURE', 'Assinatura ERP inválida.');
      const value = parseJson(raw);
      if (!value || typeof value !== 'object' || !('sku' in value) || typeof value.sku !== 'string' || !('quantity' in value) || !Number.isInteger(value.quantity) || typeof value.quantity !== 'number' || !('movementId' in value) || typeof value.movementId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.movementId)) throw new HubError(422, 'INVALID_ERP_MOVEMENT', 'Movimentação ERP inválida.');
      const [product] = await db.select().from(products).where(eq(products.sku, value.sku));
      if (!product) throw new HubError(404, 'CANONICAL_PRODUCT_NOT_FOUND', 'Produto não encontrado.');
      await inventory.restock(product.id, value.quantity, value.movementId);
      // Reentrega com mesmo movimento permite retentar sincronização sem nova reposição.
      await runtime.pipeline?.syncStock([product.sku]);
      return { accepted: true, movementId: value.movementId };
    }, { parse: 'none', response: { 200: t.Object({ accepted: t.Boolean(), movementId: t.String() }) }, detail: { tags: ['Webhooks'], description: 'HMAC-SHA256 em x-erp-signature sobre os bytes UTF-8 exatos antes de interpretar JSON.',requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/ErpStockMovement'}}}} } })
    .get('/api/v1/dashboard/orders', async ({ request, query }) => { admin(request); return ops.orders(query.limit ?? 50, query.offset ?? 0); }, {
      query: pagination, response: { 200: listSchema(t.Object({ id: t.String(), source: t.String(), externalOrderId: t.String(), status: t.String(), totalAmountCents: t.Number(), createdAt: t.String(), reservationState: t.String(), dispatchState: t.String(), attempts: t.Number() })) }, detail: { tags: ['Dashboard'], security: [{ bearerAuth: [] }] },
    })
    .get('/api/v1/dashboard/processings', ({ request, query }) => { admin(request); return ops.jobs(query.limit ?? 50, query.offset ?? 0); }, { query: pagination, response: { 200: listSchema(jobSchema) }, detail: { tags: ['Dashboard'], security: [{ bearerAuth: [] }] } })
    .post('/api/v1/dashboard/processings/:id/retry', ({ request,params }) => { admin(request); return ops.retry(params.id); }, { params:t.Object({id:t.String({format:'uuid'})}),response:{200:t.Object({processingId:t.String(),retryOf:t.String()})},detail:{tags:['Dashboard'],security:[{bearerAuth:[]}]} })
    .get('/api/v1/dashboard/processings/:id', ({ request, params }) => { admin(request); return ops.trace(params.id); }, {
      params: t.Object({ id: t.String({ format: 'uuid' }) }), response: { 200: t.Object({ processingId: t.String(), orderId: nullableString, source: t.String(), transportMode: t.String(), state: t.String(), outcome: nullableString, errorCode: nullableString, createdAt: t.String(), finishedAt: nullableString,
        snapshots: t.Object({ raw: t.Unknown(), canonical: t.Unknown(), erp: t.Unknown() }), timingsMs: t.Nullable(t.Record(t.String(), t.Number())), dispatchState: t.String(), redacted: t.Boolean(), timingScope: t.String(),
        attempts: t.Array(t.Object({ ordinal: t.Number(), httpStatus: t.Nullable(t.Number()), outcome: t.String(), durationMs: t.Nullable(t.Number()), startedAt: t.String(), finishedAt: nullableString })) }) }, detail: { tags: ['Dashboard'], security: [{ bearerAuth: [] }] },
    })
    .get('/api/v1/dashboard/mappings', ({ request, query }) => { admin(request); return ops.mappings(query.limit ?? 50, query.offset ?? 0); }, { query: pagination, response: { 200: listSchema(t.Object({ id: t.String(), productId: t.String(), marketplace: t.String(), externalItemId: t.String(), externalVariantId: t.String(), externalSku: nullableString, syncEnabled: t.String(), lastSyncedAt: nullableString, lastSyncError: nullableString, lastSyncQuantity: t.Nullable(t.Number()), sku: t.String(), implementation: t.String() })) }, detail: { tags: ['Dashboard'], security: [{ bearerAuth: [] }] } })
    .post('/api/v1/dashboard/mappings', async ({ request, body, status }) => {
      admin(request);
      const [product] = await db.select().from(products).where(eq(products.id, body.productId));
      if (!product) throw new HubError(404, 'CANONICAL_PRODUCT_NOT_FOUND', 'Produto não encontrado.');
      validateSpokeMapping(body.marketplace,{...body,externalVariantId:body.externalVariantId ?? '',sku:product.sku});
      const [mapping] = await db.insert(spokeMappings).values({ ...body, externalVariantId: body.externalVariantId ?? '' }).onConflictDoNothing().returning();
      if (!mapping) throw new HubError(409, 'SPOKE_MAPPING_CONFLICT', 'Anúncio/variação já mapeado.');
      return status(201, { id: mapping.id });
    }, { body: mappingBody, response: { 201: t.Object({ id: t.String() }) }, detail: { tags: ['Dashboard'], security: [{ bearerAuth: [] }] } })
    .get('/api/v1/dashboard/metrics', ({ request, query }) => { admin(request); const to = query.to ? new Date(query.to) : new Date(); return ops.metrics(query.from ? new Date(query.from) : new Date(to.getTime()-86400000), to); }, {
      query: t.Object({ from: t.Optional(t.String({ format: 'date-time' })), to: t.Optional(t.String({ format: 'date-time' })) }),
      response: { 200: t.Object({ from: t.String(), to: t.String(), collectedAt: t.String(), windowBasis: t.String(), acceptedOrders: t.Number(), receivedNotifications: t.Number(), duplicateReceipts: t.Number(), duplicateOrders: t.Number(), stockRejections: t.Number(), failedProcessings: t.Number(), rejectedProcessings: t.Number(), technicalFailures: t.Number(),
        delivery: t.Object({ confirmed: t.Number(), eligibleOrders: t.Number(), pendingOrFailed: t.Number(), rate: t.Nullable(t.Number()) }), durations: t.Array(t.Object({ stage: t.String(), samples: t.Number(), averageMs: t.Nullable(t.Number()) })), transportModes: t.Object({ officialProcessings: t.Number(), localFixtureProcessings: t.Number() }), units: t.Object({ counts: t.String(), duration: t.String(), rate: t.String() }) }) }, detail: { tags: ['Dashboard'], security: [{ bearerAuth: [] }] },
    })
    .get('/api/v1/dashboard/connections', ({ request }) => { admin(request); return connections(); }, { response: { 200: t.Object({ data: t.Array(t.Object({ name: t.String(), status: t.String(), checkedAt: nullableString, latencyMs: t.Nullable(t.Number()) })) }) }, detail: { tags: ['Dashboard'], security: [{ bearerAuth: [] }] } })
    .post('/api/v1/dashboard/connections/check', async ({ request }) => {
      admin(request);
      const probe = async (name: string, run: () => Promise<void>) => { const begin = performance.now(); try { await run(); checks.set(name, { status: 'AVAILABLE', checkedAt: new Date().toISOString(), latencyMs: performance.now()-begin }); } catch { checks.set(name, { status: 'UNAVAILABLE', checkedAt: new Date().toISOString(), latencyMs: performance.now()-begin }); } };
      await Promise.all([
        probe('DATABASE', async () => { await db.execute(sql`SELECT 1`); }),
        probe('MOCK_ERP', async () => { const response = await fetch(`${runtime.erpUrl}/health`, { redirect: 'error', signal: AbortSignal.timeout(3000) }); await response.body?.cancel(); if (!response.ok) throw new Error(); }),
        ...(runtime.pipeline ? [probe('MERCADO_LIVRE', async () => { if (!(await runtime.pipeline!.gateway.checkConnection()).testUser) throw new Error(); })] : []),
      ]);
      if (!runtime.pipeline) checks.set('MERCADO_LIVRE', { status: 'NOT_CONFIGURED', checkedAt: new Date().toISOString(), latencyMs: null });
      return connections();
    }, { response: { 200: t.Object({ data: t.Array(t.Object({ name: t.String(), status: t.String(), checkedAt: nullableString, latencyMs: t.Nullable(t.Number()) })) }) }, detail: { tags: ['Dashboard'], security: [{ bearerAuth: [] }] } });
}
