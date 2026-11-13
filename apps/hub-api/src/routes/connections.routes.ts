import { Elysia, t } from 'elysia';
import type { Database } from '@omnihub/database';
import type { PipelineRuntime } from '../config/runtime';
import { HubError } from '../errors';
import type { AuthenticatedSession } from '../plugins/auth';
import { ConnectionsService } from '../services/connections.service';
import type { WorkspaceContext } from '../services/context';

const uuid = t.String({ format: 'uuid' }), nullable = t.Nullable(t.String());
const item = t.Object({ id: uuid, name: t.String(), platform: t.String(), transportMode: t.String(), state: t.String(), status: t.String(), createdAt: t.String(), checkedAt: nullable, checkStatus: nullable, latencyMs: t.Nullable(t.Number()) });
const params = t.Object({ id: uuid });
const mutation = { tags: ['Connections'], security: [{ sessionCookie: [], csrfHeader: [], turnstileHeader: [] }] };
const read = { tags: ['Connections'], security: [{ sessionCookie: [] }] };
const erpList = t.Object({ data: t.Array(t.Object({ id: uuid, name: t.String(), state: t.String(), contract: t.String() })) });
const createBody = t.Object({ name: t.String({ minLength: 1, maxLength: 120 }), platform: t.Union([t.Literal('MERCADO_LIVRE'), t.Literal('AMAZON'), t.Literal('SHOPEE')]), transportMode: t.Union([t.Literal('LOCAL_FIXTURE'), t.Literal('OFFICIAL_TEST_USER')]) }, { additionalProperties: false });
const confirmBody = t.Object({ attemptId: uuid }, { additionalProperties: false });
const simulationBody = t.Object({ scenario: t.Union([t.Literal('PAID'), t.Literal('INVALID_TOTAL')]) }, { additionalProperties: false });
const selectBody = t.Object({ destinationId: uuid }, { additionalProperties: false });
export function connectionRoutes(db: Database, runtime: PipelineRuntime, scope: (request: Request) => WorkspaceContext, session: (request: Request) => AuthenticatedSession) {
  const service = runtime.connectionRuntime?.service ?? new ConnectionsService(db);
  const manager = () => { if (!runtime.connectionRuntime) throw new HubError(503, 'CONNECTION_RUNTIME_UNAVAILABLE', 'Runtime de conexões indisponível.'); return runtime.connectionRuntime; };
  return new Elysia()
    .onTransform(({ request, body }) => {
      // Elysia normally cleans additional properties; these mutation contracts reject
      // them before normalization, retaining the existing TASK-005/013 behavior elsewhere.
      if (request.method !== 'POST' || !body || typeof body !== 'object' || Array.isArray(body)) return;
      const path = new URL(request.url).pathname.replace(/\/+$/, '');
      const schema = path === '/api/v1/connections' ? createBody : path.endsWith('/oauth/confirm') ? confirmBody : path.endsWith('/simulate') ? simulationBody : path === '/api/v1/erp-destinations/select' ? selectBody : t.Object({});
      if (Object.keys(body).some(key => !Object.hasOwn(schema.properties, key))) throw new HubError(422, 'VALIDATION_ERROR', 'Parâmetros incompatíveis com o contrato da API.');
    })
    .get('/api/v1/connections', ({ request }) => service.list(scope(request)), { response: { 200: t.Object({ data: t.Array(item) }) }, detail: read })
    .post('/api/v1/connections', async ({ request, body, status }) => { const result = await service.create(scope(request), body); await runtime.connectionRuntime?.reconcile(); return status(201, result); }, {
      body: createBody, response: { 201: item }, detail: mutation,
    })
    .post('/api/v1/connections/:id/oauth/start', ({ request, params }) => service.start(session(request), params.id), { params, response: { 200: t.Object({ attemptId: uuid, authorizationUrl: t.String(), expiresAt: t.String() }) }, detail: mutation })
    .post('/api/v1/connections/:id/reconnect', ({ request, params }) => service.start(session(request), params.id), { params, response: { 200: t.Object({ attemptId: uuid, authorizationUrl: t.String(), expiresAt: t.String() }) }, detail: mutation })
    .get('/api/v1/connections/:id/oauth', ({ request, params }) => service.poll(session(request), params.id), { params, response: { 200: t.Object({ attempt: t.Nullable(t.Object({ attemptId: uuid, status: t.String(), expiresAt: t.String() })) }) }, detail: read })
    .post('/api/v1/connections/:id/oauth/confirm', async ({ request, params, body }) => { const result = await service.confirm(session(request), params.id, body.attemptId); await runtime.connectionRuntime?.reconcile(); return result; }, { params, body: confirmBody, response: { 200: item }, detail: mutation })
    .post('/api/v1/connections/:id/disable', ({ request, params }) => service.disable(scope(request), params.id), { params, response: { 200: item }, detail: mutation })
    .post('/api/v1/connections/:id/check', ({ request, params }) => service.check(scope(request), params.id, () => {
      const gateway = runtime.pipelines?.find(p => p.context.workspaceId === scope(request).workspaceId && p.context.connectionId === params.id)?.gateway;
      if (!gateway) throw new HubError(503, 'CONNECTION_RUNTIME_UNAVAILABLE', 'Transporte local indisponível.'); return gateway.checkConnection();
    }), { params, response: { 200: item }, detail: mutation })
    .post('/api/v1/connections/:id/simulate', ({ request, params, body }) => manager().simulate(scope(request), params.id, body.scenario), { params, body: simulationBody, response: { 200: t.Object({ accepted: t.Boolean(), processingId: uuid, origin: t.String(), scenario: t.String() }) }, detail: { ...mutation, description: 'Fixture sintética versionada; parser e pipeline reais. Nenhum payload livre nem chamada oficial.' } })
    .get('/api/v1/erp-destinations', ({ request }) => manager().erpList(scope(request)), { response: { 200: erpList }, detail: read })
    .post('/api/v1/erp-destinations/select', ({ request, body }) => manager().selectErp(scope(request), body.destinationId), { body: selectBody, response: { 200: erpList }, detail: mutation });
}
