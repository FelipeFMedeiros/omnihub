import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import type { Database } from '@omnihub/database';
import { sql } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { HubError } from './errors';
import { inventoryRoutes } from './routes/inventory.routes';
import { InventoryService } from './services/inventory.service';

interface AppOptions {
  readonly db: Database;
  readonly corsOrigins?: readonly string[];
}

export function createApp({ db, corsOrigins = ['http://localhost:5173'] }: AppOptions) {
  const inventory = new InventoryService(db);
  return new Elysia()
    .onError(({ error, code, status }) => {
      if (error instanceof HubError) return status(error.status, { error: { code: error.code, message: error.message } });
      if (code === 'VALIDATION') return status(422, { error: { code: 'VALIDATION_ERROR', message: 'Parâmetros incompatíveis com o contrato da API.' } });
      if (code === 'NOT_FOUND') return status(404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
      if (code === 'PARSE') return status(400, { error: { code: 'INVALID_REQUEST_BODY', message: 'Corpo da requisição inválido.' } });
      // Não registra mensagens do driver: elas podem conter SQL, payloads ou credenciais.
      console.error(JSON.stringify({ event: 'request_failed', code: 'INTERNAL_SERVER_ERROR' }));
      return status(500, { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Falha interna ao processar a requisição.' } });
    })
    .use(cors({ origin: [...corsOrigins], credentials: true, methods: ['GET', 'OPTIONS'] }))
    .use(openapi({ path: '/docs', documentation: {
      info: { title: 'Omnihub API', version: '0.1.0', description: 'Estoque canônico e histórico de movimentações.' },
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
    .use(inventoryRoutes(inventory));
}
