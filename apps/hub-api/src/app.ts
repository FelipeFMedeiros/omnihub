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
import { AuthService, requireAuthTransport, requireOperator, requireOrigin, sessionCookie } from './plugins/auth';
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
  const inventory = new InventoryService(db);
  const limiter = new EdgeRateLimiter();
  const auth = security ? new AuthService(db, security) : undefined;
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
    .use(cors({ origin: [...corsOrigins], credentials: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'] }))
    .onRequest(({ request, set, server }) => {
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
      if (/^\/api\/v1(?:\/|$)/.test(path) || (path.startsWith('/api/oauth/') && path !== '/api/oauth/meli/callback')) requireOperator(request, runtime?.adminToken ?? '');
    })
    .use(openapi({ path: '/docs', documentation: {
      info: { title: 'Omnihub API', version: '0.1.0', description: 'Estoque canônico e histórico de movimentações.' },
      components: { securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Somente CLI do operador local. Navegadores são recusados; nunca inserir este segredo na UI.' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'omnihub_session', description: 'Sessão HttpOnly de conta; não concede acesso ao domínio global.' },
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
    .use(inventoryRoutes(inventory))
    .use(auth && security ? authRoutes(auth, createTurnstileVerifier(security, siteverifyFetch)) : new Elysia())
    .use(runtime ? pipelineRoutes(db, runtime) : new Elysia());
}
