import { describe, expect, spyOn, test } from 'bun:test';
import { createDatabase, type Database } from '@omnihub/database';
import { createApp } from '../../src/app';
import { loadEnv } from '../../src/config/env';
import { HubError } from '../../src/errors';
import { inTransaction, sqlState } from '../../src/services/transaction';

const validEnvironment = { DATABASE_URL: 'postgresql://localhost/omnihub_test_db' };

test('ambiente aplica porta 3000 e permite configuração de CORS e pool', () => {
  expect(loadEnv(validEnvironment)).toMatchObject({ port: 3000, host: '0.0.0.0', databasePoolSize: 20 });
  expect(loadEnv({ ...validEnvironment, HUB_PORT: '4000', DATABASE_POOL_SIZE: '5', CORS_ORIGINS: 'http://localhost:5173,https://example.com' }))
    .toMatchObject({ port: 4000, databasePoolSize: 5, corsOrigins: ['http://localhost:5173', 'https://example.com'] });
});

const invalidEnvironments: NodeJS.ProcessEnv[] = [
  {}, { ...validEnvironment, HUB_PORT: '1.5' }, { ...validEnvironment, HUB_PORT: '0' },
  { ...validEnvironment, DATABASE_POOL_SIZE: '-1' }, { DATABASE_URL: 'https://localhost/db' },
  { ...validEnvironment, CORS_ORIGINS: 'https://user:password@example.com/path' },
];
test.each(invalidEnvironments)('ambiente rejeita configuração inválida sem exibir segredos', (env) => {
  expect(() => loadEnv(env)).toThrow();
});

test('SQLSTATE é extraído também de erros encapsulados pelo Drizzle', () => {
  expect(sqlState(new Error('query failed', { cause: { code: '40001' } }))).toBe('40001');
  expect(sqlState(null)).toBeUndefined();
  expect(sqlState(new Error('business error'))).toBeUndefined();
});

test('transações repetem contenção até 2 vezes e respondem indisponibilidade', async () => {
  let attempts = 0;
  const db: Pick<Database, 'transaction'> = { transaction: async () => { attempts++; throw { code: '40001' }; } };
  await expect(inTransaction(db, async () => undefined)).rejects.toMatchObject({ status: 503, code: 'DB_TRANSACTION_SERIALIZATION' });
  expect(attempts).toBe(3);
});

test('erros de negócio não são repetidos', async () => {
  let attempts = 0;
  const error = new HubError(409, 'INSUFFICIENT_CANONICAL_STOCK', 'Saldo insuficiente.');
  const db: Pick<Database, 'transaction'> = { transaction: async () => { attempts++; throw error; } };
  await expect(inTransaction(db, async () => undefined)).rejects.toBe(error);
  expect(attempts).toBe(1);
});

describe('erros HTTP sem conexão com banco', () => {
  test('health retorna 503 sem expor a mensagem sensível do driver', async () => {
    const { db, client } = createDatabase(validEnvironment.DATABASE_URL);
    const failure = spyOn(db, 'execute').mockRejectedValue(new Error('secret database credentials'));
    try {
      const response = await createApp({ db }).handle(new Request('http://localhost/health'));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Banco de dados indisponível.' } });
    } finally { failure.mockRestore(); await client.end(); }
  });

  test('handler central traduz erros de domínio e oculta falhas inesperadas', async () => {
    const { db, client } = createDatabase(validEnvironment.DATABASE_URL);
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createApp({ db })
        .get('/test-domain', () => { throw new HubError(409, 'INSUFFICIENT_CANONICAL_STOCK', 'Saldo insuficiente.'); })
        .get('/test-internal', () => { throw new Error('sensitive SQL'); });
      const conflict = await app.handle(new Request('http://localhost/test-domain'));
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: { code: 'INSUFFICIENT_CANONICAL_STOCK', message: 'Saldo insuficiente.' } });
      const internal = await app.handle(new Request('http://localhost/test-internal'));
      expect(internal.status).toBe(500);
      expect(await internal.text()).not.toContain('sensitive SQL');
      expect(logged).toHaveBeenCalledWith(JSON.stringify({ event: 'request_failed', code: 'INTERNAL_SERVER_ERROR' }));
    } finally { logged.mockRestore(); await client.end(); }
  });
});
