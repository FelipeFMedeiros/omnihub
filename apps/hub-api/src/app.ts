import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import type { Database } from '@omnihub/database';
import { sql } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { HubError } from './errors';
import { inventoryRoutes } from './routes/inventory.routes';
import { InventoryService } from './services/inventory.service';
import { AdapterError } from '@omnihub/marketplace-adapters';
import type { PipelineRuntime } from './config/runtime';
import { pipelineRoutes } from './routes/pipeline.routes';
import type { SecurityConfig } from './config/security';
import { AuthService, requireAuthTransport, requireOperator, requireOrigin, requireSensitiveAction, sessionCookie } from './plugins/auth';
import { requireWorkspace, type WorkspaceContext } from './services/context';
import { validateTargetBindings } from './config/runtime';
import { clientIp, EdgeRateLimiter } from './plugins/rate-limit';
import { createTurnstileVerifier, type SiteverifyFetch } from './plugins/turnstile';
import { authRoutes } from './routes/auth.routes';

interface AppOptions {
  readonly db: Database;
  readonly corsOrigins?: readonly string[];
  readonly runtime?: PipelineRuntime;
  readonly security?: SecurityConfig;
  readonly siteverifyFetch?: SiteverifyFetch;
}

export function createApp({ db, corsOrigins = ['http://localhost:5173'], runtime, security, siteverifyFetch }: AppOptions) {
  const limiter = new EdgeRateLimiter();
  const auth = security ? new AuthService(db, security) : undefined;
  const verifier = security ? createTurnstileVerifier(security, siteverifyFetch) : undefined;
  const contexts = new WeakMap<Request, WorkspaceContext>();
  const context = (request: Request) => {
    const value = contexts.get(request);
    if (!value) throw new HubError(401, 'UNAUTHENTICATED', 'Sessão exigida.');
    return value;
  };
  validateTargetBindings(runtime?.erpTargets ?? []);
  for (const pipeline of runtime?.pipelines ?? []) pipeline.publishStock = async skus => {
    await Promise.all((runtime?.pipelines ?? []).filter(p => p.context.workspaceId === pipeline.context.workspaceId && p.transportMode === pipeline.transportMode).map(p => p.syncStock(skus)));
  };
  return new Elysia()
    .onError(({ error, code, status, set, request }) => {
      if (security && error instanceof HubError && error.status === 401 && new URL(request.url).pathname.startsWith('/api/auth/')) set.headers['Set-Cookie'] = sessionCookie(security, '', true);
      if (error instanceof HubError) return status(error.status, { error: { code: error.code, message: error.message } });
      if (error instanceof AdapterError) { set.status = error.status; return { error: { code: error.code, message: error.message } }; }
      if (code === 'VALIDATION') return status(422, { error: { code: 'VALIDATION_ERROR', message: 'Parâmetros incompatíveis com o contrato da API.' } });
      if (code === 'NOT_FOUND') return status(404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
      if (code === 'PARSE') return status(400, { error: { code: 'INVALID_REQUEST_BODY', message: 'Corpo da requisição inválido.' } });
      // Não registra mensagens do driver: elas podem conter SQL, payloads ou credenciais.
      console.error(JSON.stringify({ event: 'request_failed', code: 'INTERNAL_SERVER_ERROR' }));
      return status(500, { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Falha interna ao processar a requisição.' } });
    })
    .use(cors({ origin: [...corsOrigins], credentials: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Turnstile-Token'] }))
    .onRequest(async ({ request, set, server }) => {
      // Elysia aceita a barra final: a política deve usar a mesma rota canônica.
      const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
      if (path.startsWith('/api/')) { set.headers['Cache-Control'] = 'no-store'; set.headers['Referrer-Policy'] = 'no-referrer'; }
      if (request.method === 'OPTIONS') return;
      const authenticating = request.method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(path);
      const ingesting = request.method === 'POST' && path.startsWith('/api/webhooks/');
      if (authenticating || ingesting) {
        const result = limiter.consume(authenticating ? 'auth' : 'ingestion', clientIp(request, server?.requestIP(request)?.address, security));
        if (!result.allowed) { set.headers['Retry-After'] = String(result.retryAfter); throw new HubError(429, 'RATE_LIMITED', 'Limite de requisições atingido. Aguarde antes de tentar novamente.'); }
      }
      if (path.startsWith('/api/auth/')) {
        if (!security) throw new HubError(503, 'AUTH_NOT_CONFIGURED', 'Autenticação não configurada.');
        requireAuthTransport(request, security);
        if (!['GET', 'HEAD'].includes(request.method)) requireOrigin(request, corsOrigins);
        if (authenticating && request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HubError(415, 'JSON_REQUIRED', 'Use application/json.');
      }
      if (/^\/api\/v1(?:\/|$)/.test(path)) {
        let scope: WorkspaceContext;
        if (request.headers.has('authorization')) {
          requireOperator(request, runtime?.adminToken ?? '');
          const workspaceId = request.headers.get('x-workspace-id') ?? '';
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) throw new HubError(422, 'OPERATOR_WORKSPACE_REQUIRED', 'Informe alvo explícito de manutenção.');
          scope = { workspaceId };
        } else {
          if (!auth || !security || !verifier) throw new HubError(401, 'UNAUTHENTICATED', 'Sessão exigida.');
          requireAuthTransport(request, security);
          const session = ['GET', 'HEAD'].includes(request.method) ? await auth.authenticate(request) : await requireSensitiveAction(request, auth, corsOrigins, verifier, {
            token: request.headers.get('x-turnstile-token') ?? undefined, ip: clientIp(request, server?.requestIP(request)?.address, security), action: 'domain_mutation',
          });
          scope = { workspaceId: session.account.workspace.id };
        }
        await requireWorkspace(db, scope);
        contexts.set(request, Object.freeze(scope));
      }
      if (path.startsWith('/api/oauth/') && path !== '/api/oauth/meli/callback') requireOperator(request, runtime?.adminToken ?? '');
    })
    .use(openapi({ path: '/docs', documentation: {
      info: { title: 'Omnihub API', version: '0.2.0', description: 'Domínio isolado pelo workspace da sessão; conexão identifica a loja. Mutações exigem Origin, CSRF e X-Turnstile-Token (action domain_mutation, cdata csrfToken). CLI exige alvo explícito X-Workspace-Id.' },
      components: { securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Somente CLI do operador local. Navegadores são recusados; nunca inserir este segredo na UI.' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'omnihub_session', description: 'Sessão HttpOnly; workspace resolvido pelo vínculo no servidor.' },
        csrfHeader: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'CSRF da sessão autenticada em mutações de navegador.' },
        turnstileHeader: { type: 'apiKey', in: 'header', name: 'X-Turnstile-Token', description: 'Desafio novo: action domain_mutation e cdata igual ao csrfToken da sessão.' },
        workspaceTarget: { type: 'apiKey', in: 'header', name: 'X-Workspace-Id', description: 'Alvo explícito somente com bearer do operador pela CLI; não concede autorização por si só.' },
      } },
    } }))
    .get('/health', async ({ status }) => {
      try {
        await db.execute(sql`SELECT 1`);
        return { status: 'ok' as const, database: 'connected' as const };
      } catch {
        return status(503, { error: { code: 'DATABASE_UNAVAILABLE', message: 'Banco de dados indisponível.' } });
      }
    }, {
      response: {
        200: t.Object({ status: t.Literal('ok'), database: t.Literal('connected') }),
        503: t.Object({ error: t.Object({ code: t.Literal('DATABASE_UNAVAILABLE'), message: t.String() }) }),
      }, detail: { tags: ['Health'], summary: 'Verificar conectividade com PostgreSQL' },
    })
    .use(inventoryRoutes(request => new InventoryService(db, context(request))))
    .use(auth && verifier ? authRoutes(auth, verifier) : new Elysia())
    .use(pipelineRoutes(db, runtime ?? { adminToken: '', webhookSecret: '', erpUrl: '', mockAdminToken: '' }, context));
}
